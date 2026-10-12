package org.vodog.gateway

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.util.Collections

class GatewayDiagTest {
    // The ring's own worker also flushes once 50 events pile up, so every recorder is shared.
    private fun recorder() = Collections.synchronizedList(mutableListOf<GatewayHttpRequest>())

    private fun attach(posts: MutableList<GatewayHttpRequest>) {
        GatewayDiag.attach("token", GatewayHttpTransport { request ->
            posts.add(request)
            GatewayHttpResponse(200, """{"accepted":1}""")
        })
        drain(posts)
        posts.clear()
    }

    /** Flush until the worker has nothing left, so an earlier test's burst cannot bleed in. */
    private fun drain(posts: MutableList<GatewayHttpRequest>) {
        val deadline = System.currentTimeMillis() + 2_000
        var quiet = 0
        while (System.currentTimeMillis() < deadline && quiet < 3) {
            val before = posts.size
            GatewayDiag.flushNow()
            quiet = if (posts.size == before) quiet + 1 else 0
        }
    }

    @Test fun aFlushPostsOneOrderedArrayAndLeavesTheRingEmpty() {
        val posts = recorder()
        attach(posts)
        GatewayDiag.log("heartbeat.rtt", mapOf("ms" to 1800L, "gapMs" to null), level = "warn")
        GatewayDiag.log("command.executed", mapOf("kind" to "dtmf"), callId = "call-1")
        GatewayDiag.flushNow()

        val request = posts.single()
        assertTrue(request.url.endsWith(GatewayApiRoutes.DIAG_EVENTS))
        assertEquals("Bearer token", request.authorization)
        val events = JSONArray(String(requireNotNull(request.jsonBody)))
        assertEquals(2, events.length())
        assertEquals("heartbeat.rtt", events.getJSONObject(0).getString("event"))
        assertEquals("warn", events.getJSONObject(0).getString("level"))
        // S69: top-level appVersion, stamped at record time.
        assertEquals("${BuildConfig.VERSION_NAME}(${BuildConfig.VERSION_CODE})", events.getJSONObject(0).getString("appVersion"))
        // A null field is dropped; `seq` is always present and monotonic.
        assertEquals(false, events.getJSONObject(0).getJSONObject("fields").has("gapMs"))
        assertEquals(1800L, events.getJSONObject(0).getJSONObject("fields").getLong("ms"))
        assertEquals("call-1", events.getJSONObject(1).getString("callId"))
        assertTrue(events.getJSONObject(1).getJSONObject("fields").getLong("seq") >
            events.getJSONObject(0).getJSONObject("fields").getLong("seq"))

        posts.clear()
        GatewayDiag.flushNow()
        assertEquals(0, posts.size)
    }

    /** The events among [posts] named [name], oldest first. */
    private fun rows(posts: MutableList<GatewayHttpRequest>, name: String): List<org.json.JSONObject> =
        synchronized(posts) { posts.toList() }.flatMap { request ->
            val array = JSONArray(String(requireNotNull(request.jsonBody)))
            (0 until array.length()).map { array.getJSONObject(it) }
        }.filter { it.getString("event") == name }

    @Test fun mediaSetupRowsNestHttpTimingAndCarryTheOutcome() {
        val posts = recorder()
        attach(posts)
        val http = GatewayHttpTiming(dnsMs = null, tcpMs = 40, tlsMs = 90, reused = false, protocol = "h2",
            ttfbMs = 120, totalMs = 300, reqBytes = 210, respBytes = 900)
        val stages = mapOf("optionsMs" to 350L, "optionsAttempts" to 2, "optionsHttp" to httpTimingDiagJson(http),
            "transport" to "tls", "relay" to true, "attempt" to 1, "totalMs" to 2_100L)
        GatewayDiag.log("media.setup", mediaSetupDiagFields(stages, mapOf("prebufferMs" to 900L, "firstTxFrameMs" to null), null),
            callId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        GatewayDiag.log("media.setup", mediaSetupDiagFields(stages, emptyMap(), "data_channel_connect_failed"), level = "warn")
        GatewayDiag.flushNow()

        val (ok, failed) = rows(posts, "media.setup").map { it.getJSONObject("fields") }
        assertEquals(true, ok.getBoolean("ok"))
        assertEquals(false, ok.has("code"))
        assertEquals(900L, ok.getLong("prebufferMs"))
        // A stage that never happened is absent, not null.
        assertEquals(false, ok.has("firstTxFrameMs"))
        val nested = ok.getJSONObject("optionsHttp")
        assertEquals(120L, nested.getLong("ttfbMs"))
        assertEquals("h2", nested.getString("protocol"))
        assertEquals(false, nested.getBoolean("reused"))
        assertEquals(false, nested.has("dnsMs"))
        assertEquals("tls", ok.getString("transport"))
        assertEquals(false, failed.getBoolean("ok"))
        assertEquals("data_channel_connect_failed", failed.getString("code"))
        // Control drops a row whose fields serialize past 4 KiB.
        assertTrue(ok.toString().length < 4_096)
    }

    @Test fun setupCancelledAndEarlyArmedRowsCarryTheirS124Fields() {
        val posts = recorder()
        attach(posts)
        GatewayDiag.log("media.setup_cancelled", org.vodog.gateway.media.mediaSetupCancelledFields("OPTIONS", true))
        GatewayDiag.log("media.setup_cancelled", org.vodog.gateway.media.mediaSetupCancelledFields("GATHERING", false))
        GatewayDiag.log("media.early_armed", earlyArmedFields(420L, "active_callback"))
        GatewayDiag.flushNow()
        val (ended, cancelled) = rows(posts, "media.setup_cancelled")
        assertEquals("info", ended.getString("level"))
        assertEquals("OPTIONS", ended.getJSONObject("fields").getString("stage"))
        assertEquals("call_ended", ended.getJSONObject("fields").getString("reason"))
        assertEquals("cancelled", cancelled.getJSONObject("fields").getString("reason"))
        val armed = rows(posts, "media.early_armed").single().getJSONObject("fields")
        assertEquals("active_callback", armed.getString("via"))
        assertEquals(420L, armed.getLong("earlyMs"))
    }

    @Test fun mediaRevokedRowIsInfoWithStageAndCode() {
        val posts = recorder()
        attach(posts)
        GatewayDiag.log("media.revoked", org.vodog.gateway.media.mediaRevokedFields("OPTIONS"))
        GatewayDiag.flushNow()
        val row = rows(posts, "media.revoked").single()
        assertEquals("info", row.getString("level"))
        assertEquals("OPTIONS", row.getJSONObject("fields").getString("stage"))
        assertEquals("MEDIA_REVOKED", row.getJSONObject("fields").getString("code"))
    }

    @Test fun onlySlowAckAndSnapshotPostsBecomeApiTimingRows() {
        val posts = recorder()
        attach(posts)
        var totalMs = 0L
        val api = GatewayApi("token", { true }, GatewayHttpTransport { request ->
            val body = if (request.url.endsWith(GatewayApiRoutes.TELECOM_SNAPSHOT)) {
                """{"accepted":true,"busyState":"idle"}"""
            } else "{}"
            GatewayHttpResponse(200, body, GatewayHttpTiming(1, 2, 3, false, "http/1.1", 4, totalMs, 10, 20))
        })
        totalMs = 801L
        api.ackCommand(GatewayCommand("command-1", generation = 1, sequence = 1), "succeeded", org.json.JSONObject())
        api.reportTelecomSnapshot(org.json.JSONObject())
        api.ackCallLogPurges(listOf(CallLogPurgeAck("p-1", "deleted", 1)))
        totalMs = API_TIMING_LOG_THRESHOLD_MS
        api.ackCommand(GatewayCommand("command-2", generation = 1, sequence = 2), "succeeded", org.json.JSONObject())
        GatewayDiag.flushNow()

        val timings = rows(posts, "api.timing").map { it.getJSONObject("fields") }
        assertEquals(listOf("command_ack", "telecom_snapshot"), timings.map { it.getString("route") })
        timings.forEach {
            assertEquals(801L, it.getLong("totalMs"))
            assertEquals(200, it.getInt("status"))
            assertEquals(4L, it.getLong("ttfbMs"))
            assertEquals(false, it.toString().contains("command-1"))
        }
    }

    @Test fun aBurstIsCappedByTheRingAndSplitIntoServerSizedBatches() {
        val drained = recorder()
        attach(drained)
        detachAndWait(drained)
        // With no transport attached nothing can drain mid-burst, so the ring ends holding its cap.
        repeat(700) { GatewayDiag.log("burst", mapOf("i" to it)) }

        val posts = recorder()
        GatewayDiag.attach("token", GatewayHttpTransport { request ->
            posts.add(request)
            GatewayHttpResponse(200, """{"accepted":1}""")
        })
        drain(posts)
        // Whoever flushes first empties the whole ring, so the split is the same either way.
        // S36b D2: the 201st event is `diag.dropped` - the 200 the ring ate, reported with the batch.
        val lengths = synchronized(posts) { posts.toList() }
            .map { JSONArray(String(requireNotNull(it.jsonBody))).length() }
        assertEquals(listOf(200, 200, 101), lengths)
        val tail = JSONArray(String(requireNotNull(synchronized(posts) { posts.toList() }.last().jsonBody)))
        val dropped = tail.getJSONObject(tail.length() - 1)
        assertEquals("diag.dropped", dropped.getString("event"))
        // At least the 200 this burst lost; an earlier test's leftover probe can add to it.
        assertTrue(dropped.getJSONObject("fields").getLong("count") >= 200L)
    }

    /** A deleted spool is an empty spool: `readLines` on a missing file throws. */
    private fun spoolLines(file: File): List<String> = if (file.exists()) file.readLines() else emptyList()

    /** Every event name a recorder has seen, whatever the server answered. */
    private fun names(posts: MutableList<GatewayHttpRequest>): Set<String> =
        synchronized(posts) { posts.toList() }.flatMap { request ->
            val array = JSONArray(String(requireNotNull(request.jsonBody)))
            (0 until array.length()).map { array.getJSONObject(it).getString("event") }
        }.toSet()

    /** S36b D2: a dead link costs nothing but a restart - the batch waits on disk and goes out first. */
    @Test fun aFailedFlushSpoolsToDiskAndTheNextStartUploadsItWithTheInstallHeader() {
        val spool = File.createTempFile("diag-spool", ".jsonl").also { it.delete() }
        try {
            GatewayDiag.attach("token", GatewayHttpTransport { throw IOException("offline") }, spool, "install-42")
            repeat(450) { GatewayDiag.log("spooled.$it", mapOf("i" to it)) }
            GatewayDiag.flushNow()
            // The ring's own worker is spilling its failed flushes too; wait for the burst to land.
            val settled = System.currentTimeMillis() + 5_000
            while (System.currentTimeMillis() < settled && spoolLines(spool).size < 450) Thread.sleep(10)
            assertTrue(spoolLines(spool).size >= 450)

            // The link dies again mid-upload: 450 events are three server-sized batches, and the one
            // after the failing batch must go back to disk too - the file is already deleted by then.
            val partial = recorder()
            GatewayDiag.attach("token", GatewayHttpTransport { request ->
                partial.add(request)
                if (String(requireNotNull(request.jsonBody)).contains("\"spooled.225\"")) throw IOException("offline")
                GatewayHttpResponse(200, """{"accepted":1}""")
            }, spool, "install-42")
            GatewayDiag.flushNow()

            val replayStartedAt = System.currentTimeMillis()
            val posts = recorder()
            GatewayDiag.attach("token", GatewayHttpTransport { request ->
                posts.add(request)
                GatewayHttpResponse(200, """{"accepted":1}""")
            }, spool, "install-42")
            // An upload from the previous transport can still be in flight; flush until it settles.
            val deadline = System.currentTimeMillis() + 10_000
            var arrived = emptySet<String>()
            while (System.currentTimeMillis() < deadline) {
                GatewayDiag.flushNow()
                arrived = names(partial) + names(posts)
                if ((0 until 450).all { "spooled.$it" in arrived } && spoolLines(spool).isEmpty()) break
            }

            assertTrue((0 until 450).all { "spooled.$it" in arrived })
            assertEquals("install-42", synchronized(posts) { posts.toList() }.first().headers["X-Diag-Install"])
            // S75: a spool replay is stamped with its real send time, not the time the rows were recorded.
            assertTrue(requireNotNull(synchronized(posts) { posts.toList() }.first().headers["X-Diag-Sent-At"]).toLong() >= replayStartedAt)
            // Uploaded means gone: a restart must not send the same batch twice.
            assertTrue(spoolLines(spool).isEmpty())
        } finally {
            spool.delete()
            GatewayDiag.attach("token", GatewayHttpTransport { GatewayHttpResponse(200, """{"accepted":0}""") })
        }
    }

    private fun events(posts: MutableList<GatewayHttpRequest>) = synchronized(posts) { posts.toList() }
        .flatMap { request -> JSONArray(String(requireNotNull(request.jsonBody))).let { a -> List(a.length(), a::getJSONObject) } }

    @Test fun debugRowsStayLocalAndWarnRowsAreStillSent() {
        val posts = recorder()
        attach(posts)
        GatewayDiag.log("heartbeat.rtt", mapOf("ms" to 90L), level = "debug")
        GatewayDiag.log("heartbeat.rtt", mapOf("ms" to 9000L), level = "warn")
        GatewayDiag.flushNow()
        val rtt = events(posts).filter { it.getString("event") == "heartbeat.rtt" }
        assertEquals(listOf("warn"), rtt.map { it.getString("level") })
    }

    @Test fun telephonyBoundJoinsTheDeviceCallToTheServerCall() {
        val posts = recorder()
        attach(posts)
        logTelephonyBound("device-1", "call-9")
        logTelephonyBound("device-2", null)
        GatewayDiag.flushNow()
        val bound = events(posts).single { it.getString("event") == "telephony.bound" }
        assertEquals("call-9", bound.getString("callId"))
        assertEquals("device-1", bound.getJSONObject("fields").getString("deviceCallId"))
    }

    /** Detach is asynchronous: a probe that flushes to nothing proves the transport is gone. */
    private fun detachAndWait(posts: MutableList<GatewayHttpRequest>) {
        GatewayDiag.detach()
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            posts.clear()
            GatewayDiag.log("probe", emptyMap())
            GatewayDiag.flushNow()
            if (posts.isEmpty()) return
        }
        throw AssertionError("diag transport still attached after detach()")
    }

    @Test fun anUncleanRecentExitIsReportedAsKilledOnceAndACleanOrStaleOneIsNot() {
        val now = 1_000_000_000L
        assertEquals(90L, killedAgoSeconds(cleanShutdown = false, lastAliveMs = now - 90_000L, nowMs = now))
        assertEquals(null, killedAgoSeconds(cleanShutdown = true, lastAliveMs = now - 90_000L, nowMs = now))
        assertEquals(null, killedAgoSeconds(cleanShutdown = false, lastAliveMs = null, nowMs = now))
        assertEquals(null, killedAgoSeconds(cleanShutdown = false, lastAliveMs = now - KILLED_REPORT_WINDOW_MS, nowMs = now))
        assertEquals(null, killedAgoSeconds(cleanShutdown = false, lastAliveMs = now + 5_000L, nowMs = now))
    }
}
