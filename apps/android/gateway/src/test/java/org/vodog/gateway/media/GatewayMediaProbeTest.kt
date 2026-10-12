package org.vodog.gateway.media

import kotlinx.coroutines.runBlocking
import org.vodog.gateway.GatewayHttpResponse
import org.vodog.gateway.GatewayHttpTransport
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.vodog.gateway.PROBE_STALE_RETENTION_SECONDS

class GatewayMediaProbeTest {
    @Test fun `media options generation fence rejects a network change after response`() = runBlocking {
        var generation = "network-a"
        var operationRan = false
        val provider = object : GatewayProbeReadinessProvider {
            override suspend fun ensureCurrent() = GatewayProbeReadiness(generation, true, Instant.MAX)
            override fun requireCurrent(networkGeneration: String) {
                check(generation == networkGeneration) { "changed" }
            }
        }

        assertThrows(IllegalStateException::class.java) {
            runBlocking {
                withProbeGenerationFence(provider, "network-a") {
                    operationRan = true
                    generation = "network-b"
                    "response"
                }
            }
        }
        assertTrue(operationRan)
    }

    @Test fun `media options generation fence rejects stale evidence before request`() = runBlocking {
        var operationRan = false
        val provider = object : GatewayProbeReadinessProvider {
            override suspend fun ensureCurrent() = GatewayProbeReadiness("network-b", true, Instant.MAX)
            override fun requireCurrent(networkGeneration: String) {
                check(networkGeneration == "network-b") { "stale" }
            }
        }

        assertThrows(IllegalStateException::class.java) {
            runBlocking {
                withProbeGenerationFence(provider, "network-a") {
                    operationRan = true
                }
            }
        }
        assertFalse(operationRan)
    }

    @Test fun `media offer never sends before options authorization or after network change`() = runBlocking {
        var current = "network-b"
        var requests = 0
        val provider = object : GatewayProbeReadinessProvider {
            override suspend fun ensureCurrent() = GatewayProbeReadiness(current, true, Instant.MAX)
            override fun requireCurrent(networkGeneration: String) {
                check(networkGeneration == current) { "stale" }
            }
        }

        assertThrows(IllegalStateException::class.java) {
            runBlocking { withAuthorizedProbeGenerationFence(provider, null) { requests++ } }
        }
        assertThrows(IllegalStateException::class.java) {
            runBlocking { withAuthorizedProbeGenerationFence(provider, "network-a") { requests++ } }
        }
        assertEquals(0, requests)
    }

    @Test fun `media offer rejects response when network changes in flight`() = runBlocking {
        var current = "network-a"
        var requests = 0
        val provider = object : GatewayProbeReadinessProvider {
            override suspend fun ensureCurrent() = GatewayProbeReadiness(current, true, Instant.MAX)
            override fun requireCurrent(networkGeneration: String) {
                check(networkGeneration == current) { "stale" }
            }
        }

        assertThrows(IllegalStateException::class.java) {
            runBlocking {
                withAuthorizedProbeGenerationFence(provider, "network-a") {
                    requests++
                    current = "network-b"
                    "answer"
                }
            }
        }
        assertEquals(1, requests)
    }

    @Test fun `diagnostic retains only bounded statuses counts and accepted readiness`() = runBlocking {
        var snapshot: GatewayProbeDiagnosticSnapshot? = null
        var elapsed = 100L
        val coordinator = GatewayMediaProbeCoordinator(
            object : GatewayProbeControl {
                override suspend fun options(networkGeneration: String) = GatewayProbeOptions(
                    networkGeneration, "2026-09-10T00:02:00Z", listOf(node("server-node")),
                )
                override suspend fun results(networkGeneration: String, samples: List<GatewayProbeSample>) =
                    "2026-09-10T00:02:00Z"
            },
            GatewayProbeGeneration { "network-generation" },
            GatewayProbeRunner { node -> listOf(
                GatewayProbeSample(node.nodeId, "ok", 10.0),
                GatewayProbeSample(node.nodeId, "ok", 11.0),
                GatewayProbeSample(node.nodeId, "network_error"),
            ) },
            diagnostics = GatewayProbeDiagnosticRecorder { snapshot = it },
            elapsedRealtimeMs = { elapsed.also { elapsed += 7 } },
            now = { Instant.parse("2026-09-10T00:00:00Z") },
        )

        assertTrue(coordinator.ensureCurrent().hasReachableNode)
        val recorded = requireNotNull(snapshot)
        assertEquals("accepted", recorded.stage)
        assertEquals("ok", recorded.optionsStatus)
        assertEquals(7L, recorded.optionsDurationMs)
        assertEquals("ok", recorded.resultsStatus)
        assertEquals(7L, recorded.resultsDurationMs)
        assertTrue(recorded.localReady)
        assertEquals(GatewayProbeNodeOutcomes("server-node", 2, 0, 1), recorded.nodeOutcomes.single())
        val encoded = encodeGatewayProbeDiagnostic(recorded)
        assertFalse(encoded.contains("https://"))
        assertFalse(encoded.contains("Bearer"))
        assertFalse(encoded.contains("one"))
    }

    @Test fun `failed options diagnostic stores classified status without raw exception`() = runBlocking {
        var snapshot: GatewayProbeDiagnosticSnapshot? = null
        val coordinator = GatewayMediaProbeCoordinator(
            object : GatewayProbeControl {
                override suspend fun options(networkGeneration: String): GatewayProbeOptions =
                    throw GatewayMediaHttpException(503, "SECRET_BACKEND_CODE", "secret response body")
                override suspend fun results(networkGeneration: String, samples: List<GatewayProbeSample>) = error("unused")
            },
            GatewayProbeGeneration { "network-generation" },
            GatewayProbeRunner { emptyList() },
            diagnostics = GatewayProbeDiagnosticRecorder { snapshot = it },
        )

        assertThrows(GatewayMediaHttpException::class.java) { runBlocking { coordinator.ensureCurrent() } }
        val encoded = encodeGatewayProbeDiagnostic(requireNotNull(snapshot))
        assertTrue(encoded.contains("http_503"))
        assertFalse(encoded.contains("SECRET_BACKEND_CODE"))
        assertFalse(encoded.contains("secret response body"))
    }

    @Test fun `diagnostic storage failure never changes accepted readiness`() = runBlocking {
        val coordinator = GatewayMediaProbeCoordinator(
            object : GatewayProbeControl {
                override suspend fun options(networkGeneration: String) = GatewayProbeOptions(
                    networkGeneration, "2026-09-10T00:02:00Z", listOf(node("server-node")),
                )
                override suspend fun results(networkGeneration: String, samples: List<GatewayProbeSample>) =
                    "2026-09-10T00:02:00Z"
            },
            GatewayProbeGeneration { "network-generation" },
            GatewayProbeRunner { node -> node.grants.map { GatewayProbeSample(node.nodeId, "ok", 8.0) } },
            diagnostics = GatewayProbeDiagnosticRecorder { error("private storage unavailable") },
            now = { Instant.parse("2026-09-10T00:00:00Z") },
        )

        assertTrue(coordinator.ensureCurrent().hasReachableNode)
    }

    @Test fun `probe evidence expires and is never reused across network generations`() = runBlocking {
        var generation = "gateway-network-a"
        var now = Instant.parse("2026-09-10T00:00:00Z")
        val requested = mutableListOf<String>()
        val submitted = mutableListOf<Pair<String, List<GatewayProbeSample>>>()
        val coordinator = GatewayMediaProbeCoordinator(
            object : GatewayProbeControl {
                override suspend fun options(networkGeneration: String): GatewayProbeOptions {
                    requested += networkGeneration
                    return GatewayProbeOptions(
                        networkGeneration,
                        now.plusSeconds(30).toString(),
                        listOf(node("server-node-a"), node("server-node-b")),
                    )
                }

                override suspend fun results(networkGeneration: String, samples: List<GatewayProbeSample>): String {
                    submitted += networkGeneration to samples
                    return now.plusSeconds(20).toString()
                }
            },
            GatewayProbeGeneration { generation },
            GatewayProbeRunner { node -> node.grants.map { GatewayProbeSample(node.nodeId, "ok", 12.0) } },
        ) { now }

        assertEquals(generation, coordinator.ensureCurrent().networkGeneration)
        assertTrue(coordinator.ensureCurrent().hasReachableNode)
        assertEquals(listOf("gateway-network-a"), requested)
        assertEquals(setOf("server-node-a", "server-node-b"), submitted.single().second.map { it.nodeId }.toSet())
        assertEquals(6, submitted.single().second.size)

        generation = "gateway-network-b"
        assertEquals(null, coordinator.peekCurrent())
        assertEquals(generation, coordinator.ensureCurrent().networkGeneration)
        now = now.plusSeconds(21)
        assertEquals(null, coordinator.peekCurrent())
        assertEquals(generation, coordinator.ensureCurrent().networkGeneration)
        assertEquals(listOf("gateway-network-a", "gateway-network-b", "gateway-network-b"), requested)
    }

    @Test fun `failed refresh cannot revive expired successful evidence`() = runBlocking {
        var now = Instant.parse("2026-09-10T00:00:00Z")
        var failRefresh = false
        val coordinator = GatewayMediaProbeCoordinator(
            object : GatewayProbeControl {
                override suspend fun options(networkGeneration: String): GatewayProbeOptions {
                    if (failRefresh) error("control unavailable")
                    return GatewayProbeOptions(networkGeneration, now.plusSeconds(120).toString(), listOf(node("server-node")))
                }
                override suspend fun results(networkGeneration: String, samples: List<GatewayProbeSample>) =
                    now.plusSeconds(120).toString()
            },
            GatewayProbeGeneration { "network" },
            GatewayProbeRunner { node -> node.grants.map { GatewayProbeSample(node.nodeId, "ok", 9.0) } },
            now = { now },
        )

        assertTrue(coordinator.ensureCurrent().hasReachableNode)
        now = now.plusSeconds(31)
        failRefresh = true
        assertThrows(IllegalStateException::class.java) { runBlocking { coordinator.ensureCurrent() } }
        assertEquals(null, coordinator.peekCurrent())
    }

    @Test fun `peek never waits for slow refresh and only returns a fresh same-network snapshot`() = runBlocking {
        var now = Instant.parse("2026-09-10T00:00:00Z")
        var gate: CompletableDeferred<Unit>? = null
        var entered: CompletableDeferred<Unit>? = null
        val coordinator = GatewayMediaProbeCoordinator(
            object : GatewayProbeControl {
                override suspend fun options(networkGeneration: String): GatewayProbeOptions {
                    entered?.complete(Unit)
                    gate?.await()
                    return GatewayProbeOptions(networkGeneration, now.plusSeconds(120).toString(), listOf(node("server-node")))
                }
                override suspend fun results(networkGeneration: String, samples: List<GatewayProbeSample>) =
                    now.plusSeconds(120).toString()
            },
            GatewayProbeGeneration { "network" },
            GatewayProbeRunner { node -> node.grants.map { GatewayProbeSample(node.nodeId, "ok", 8.0) } },
            now = { now },
        )
        coordinator.ensureCurrent()

        gate = CompletableDeferred()
        entered = CompletableDeferred()
        val validRefresh = async { coordinator.ensureCurrent(forceRefresh = true) }
        entered!!.await()
        val started = System.nanoTime()
        assertTrue(requireNotNull(coordinator.peekCurrent()).hasReachableNode)
        assertTrue((System.nanoTime() - started) / 1_000_000 < 50)
        gate!!.complete(Unit)
        validRefresh.await()

        now = now.plusSeconds(31)
        gate = CompletableDeferred()
        entered = CompletableDeferred()
        val expiredRefresh = async { coordinator.ensureCurrent(forceRefresh = true) }
        entered!!.await()
        val expiredStarted = System.nanoTime()
        assertEquals(null, coordinator.peekCurrent())
        assertTrue((System.nanoTime() - expiredStarted) / 1_000_000 < 50)
        gate!!.complete(Unit)
        expiredRefresh.await()
        Unit
    }

    @Test fun `ensureCurrent returns fresh cached evidence while a slow refresh holds the lock`(): Unit = runBlocking {
        var now = Instant.parse("2026-09-10T00:00:00Z")
        var gate: CompletableDeferred<Unit>? = null
        var entered: CompletableDeferred<Unit>? = null
        var optionsCalls = 0
        val coordinator = GatewayMediaProbeCoordinator(
            object : GatewayProbeControl {
                override suspend fun options(networkGeneration: String): GatewayProbeOptions {
                    optionsCalls += 1
                    entered?.complete(Unit)
                    gate?.await()
                    return GatewayProbeOptions(networkGeneration, now.plusSeconds(120).toString(), listOf(node("server-node")))
                }
                override suspend fun results(networkGeneration: String, samples: List<GatewayProbeSample>) =
                    now.plusSeconds(120).toString()
            },
            GatewayProbeGeneration { "network" },
            GatewayProbeRunner { node -> node.grants.map { GatewayProbeSample(node.nodeId, "ok", 8.0) } },
            now = { now },
        )
        val first = coordinator.ensureCurrent()

        // A forced heartbeat refresh holds the mutex; valid evidence must not queue behind it.
        gate = CompletableDeferred()
        entered = CompletableDeferred()
        val heldRefresh = async { coordinator.ensureCurrent(forceRefresh = true) }
        entered!!.await()
        val cached = withTimeout(1_000) { coordinator.ensureCurrent() }
        assertEquals(first.acceptedAt, cached.acceptedAt)
        assertTrue(cached.hasReachableNode)
        gate!!.complete(Unit)
        heldRefresh.await()
        assertEquals(2, optionsCalls)

        // Expired evidence still waits for the refresh in flight and takes its result.
        now = now.plusSeconds(31)
        gate = CompletableDeferred()
        entered = CompletableDeferred()
        val expiredRefresh = async { coordinator.ensureCurrent(forceRefresh = true) }
        entered!!.await()
        val waiter = async { coordinator.ensureCurrent() }
        delay(50)
        assertFalse(waiter.isCompleted)
        gate!!.complete(Unit)
        val refreshed = expiredRefresh.await()
        assertEquals(refreshed.acceptedAt, waiter.await().acceptedAt)
        assertEquals(3, optionsCalls)
    }

    @Test fun `relay mode options take the generation without ever awaiting a probe`(): Unit = runBlocking {
        val provider = object : GatewayProbeReadinessProvider {
            override suspend fun ensureCurrent(): GatewayProbeReadiness = awaitCancellation()
            override fun requireCurrent(networkGeneration: String) = Unit
            override fun currentNetworkGeneration() = "network-now"
        }
        assertEquals("network-now", withTimeout(200) { mediaOptionsNetworkGeneration(provider, relay = true) })
    }

    @Test fun `a provider without a cheap generation keeps the probe path in both modes`(): Unit = runBlocking {
        // Fakes written before currentNetworkGeneration existed still compile and still work.
        val provider = object : GatewayProbeReadinessProvider {
            override suspend fun ensureCurrent() = GatewayProbeReadiness("network-p", false, Instant.MAX)
            override fun requireCurrent(networkGeneration: String) = Unit
        }
        assertEquals(null, provider.currentNetworkGeneration())
        assertEquals("network-p", mediaOptionsNetworkGeneration(provider, relay = true))
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { mediaOptionsNetworkGeneration(provider, relay = false) }
        }
    }

    @Test fun `non-relay options never wait past the bound and fall back to retained evidence`(): Unit = runBlocking {
        val now = Instant.parse("2026-09-10T00:10:00Z")
        var last: GatewayProbeReadiness? = GatewayProbeReadiness("network", true, now.minusSeconds(60), now.minusSeconds(90))
        var refresh: suspend () -> GatewayProbeReadiness = { awaitCancellation() }
        val provider = object : GatewayProbeReadinessProvider {
            override suspend fun ensureCurrent() = refresh()
            override fun requireCurrent(networkGeneration: String) = Unit
            override fun lastAcceptedReadiness() = last
        }
        val started = System.nanoTime()
        assertEquals("network", boundedProbeReadiness(provider, waitMs = 50, now = { now }).networkGeneration)
        assertTrue((System.nanoTime() - started) / 1_000_000 < 1_000)

        // A failed refresh does not fail setup while retained evidence exists ...
        refresh = { throw GatewayMediaHttpException(503, "MEDIA_PROBE_UNAVAILABLE", "down") }
        assertTrue(boundedProbeReadiness(provider, waitMs = 50, now = { now }).hasReachableNode)
        // ... but evidence past the heartbeat's retention window no longer counts, and the failure surfaces.
        last = GatewayProbeReadiness("network", true, now.minusSeconds(600), now.minusSeconds(PROBE_STALE_RETENTION_SECONDS + 1))
        assertThrows(GatewayMediaHttpException::class.java) {
            runBlocking { boundedProbeReadiness(provider, waitMs = 50, now = { now }) }
        }
        last = null
        refresh = { awaitCancellation() }
        assertThrows(IllegalStateException::class.java) {
            runBlocking { boundedProbeReadiness(provider, waitMs = 50, now = { now }) }
        }
        // Fresh evidence answers at once and wins over the retained one.
        refresh = { GatewayProbeReadiness("network-2", true, now.plusSeconds(30), now) }
        assertEquals("network-2", boundedProbeReadiness(provider, waitMs = 50, now = { now }).networkGeneration)
    }

    @Test fun `one cycle reports each grant and qualifies two successes without clearing cached evidence`() = runBlocking {
        var optionsCalls = 0
        var resultCalls = 0
        val coordinator = GatewayMediaProbeCoordinator(
            object : GatewayProbeControl {
                override suspend fun options(networkGeneration: String): GatewayProbeOptions {
                    optionsCalls += 1
                    return GatewayProbeOptions(networkGeneration, "2026-09-10T00:02:00Z", listOf(node("server-node")))
                }

                override suspend fun results(networkGeneration: String, samples: List<GatewayProbeSample>): String {
                    resultCalls += 1
                    assertEquals(listOf("ok", "ok", "network_error"), samples.map { it.outcome })
                    return "2026-09-10T00:02:00Z"
                }
            },
            GatewayProbeGeneration { "network" },
            GatewayProbeRunner { node -> listOf(
                GatewayProbeSample(node.nodeId, "ok", 10.0),
                GatewayProbeSample(node.nodeId, "ok", 12.0),
                GatewayProbeSample(node.nodeId, "network_error"),
            ) },
            now = { Instant.parse("2026-09-10T00:00:00Z") },
        )

        assertTrue(coordinator.ensureCurrent().hasReachableNode)
        assertTrue(coordinator.ensureCurrent().hasReachableNode)
        assertEquals(1, optionsCalls)
        assertEquals(1, resultCalls)
    }

    @Test fun `all failed grants keep media unreachable while still accepting bounded evidence`() = runBlocking {
        val coordinator = GatewayMediaProbeCoordinator(
            object : GatewayProbeControl {
                override suspend fun options(networkGeneration: String) = GatewayProbeOptions(
                    networkGeneration, "2026-09-10T00:02:00Z", listOf(node("server-node")),
                )
                override suspend fun results(networkGeneration: String, samples: List<GatewayProbeSample>): String {
                    assertEquals(3, samples.size)
                    assertTrue(samples.all { it.outcome == "timeout" })
                    return "2026-09-10T00:02:00Z"
                }
            },
            GatewayProbeGeneration { "network" },
            GatewayProbeRunner { node -> node.grants.map { GatewayProbeSample(node.nodeId, "timeout") } },
            now = { Instant.parse("2026-09-10T00:00:00Z") },
        )

        assertFalse(coordinator.ensureCurrent().hasReachableNode)
    }

    @Test fun `local evidence is resubmitted before the longer server ttl`() = runBlocking {
        var now = Instant.parse("2026-09-10T00:00:00Z")
        var submissions = 0
        val coordinator = GatewayMediaProbeCoordinator(
            object : GatewayProbeControl {
                override suspend fun options(networkGeneration: String) = GatewayProbeOptions(
                    networkGeneration, now.plusSeconds(120).toString(), listOf(node("server-node")),
                )
                override suspend fun results(networkGeneration: String, samples: List<GatewayProbeSample>): String {
                    submissions += 1
                    return now.plusSeconds(120).toString()
                }
            },
            GatewayProbeGeneration { "network" },
            GatewayProbeRunner { node -> node.grants.map { GatewayProbeSample(node.nodeId, "ok", 9.0) } },
            now = { now },
        )

        coordinator.ensureCurrent()
        now = now.plusSeconds(29)
        coordinator.ensureCurrent()
        assertEquals(1, submissions)
        now = now.plusSeconds(2)
        coordinator.ensureCurrent()
        assertEquals(2, submissions)
    }

    @Test fun `pending node selection retries only the frozen pending error and then succeeds`(): Unit = runBlocking {
        var attempts = 0
        val value = retryMediaNodePending(timeoutMs = 200, delays = longArrayOf(1)) {
            attempts += 1
            if (attempts < 3) throw GatewayMediaHttpException(409, "MEDIA_NODE_PENDING", "pending")
            "ready"
        }
        assertEquals("ready", value)
        assertEquals(3, attempts)

        assertThrows(GatewayMediaHttpException::class.java) {
            runBlocking {
                retryMediaNodePending(timeoutMs = 200, delays = longArrayOf(1)) {
                    throw GatewayMediaHttpException(409, "MEDIA_NODE_MISMATCH", "wrong node")
                }
            }
        }
    }

    @Test fun `S97 capture 409 retries are capped while node-pending keeps its backoff`(): Unit = runBlocking {
        for (code in listOf("CAPTURE_NOT_ACTIVE", "CAPTURE_NOT_CONFIRMED")) {
            var attempts = 0
            // Two uncapped 2 s waits would blow the 1.5 s budget; two capped ones take ~0.6 s.
            val value = retryMediaNodePending(timeoutMs = 1_500, delays = longArrayOf(2_000), captureRetryCapMs = CAPTURE_RETRY_CAP_MS) {
                attempts += 1
                if (attempts < 3) throw GatewayMediaHttpException(409, code, "not yet")
                "ready"
            }
            assertEquals("ready", value)
        }
        assertThrows(kotlinx.coroutines.TimeoutCancellationException::class.java) {
            runBlocking {
                retryMediaNodePending(timeoutMs = 1_500, delays = longArrayOf(2_000), captureRetryCapMs = CAPTURE_RETRY_CAP_MS) {
                    throw GatewayMediaHttpException(409, "MEDIA_NODE_PENDING", "pending")
                }
            }
        }
        assertEquals(300L, CAPTURE_RETRY_CAP_MS)
    }

    @Test fun `S22 capture binding 409s are retried within the same bounded window`(): Unit = runBlocking {
        for (code in listOf("CAPTURE_NOT_ACTIVE", "CAPTURE_NOT_CONFIRMED")) {
            var attempts = 0
            val value = retryMediaNodePending(timeoutMs = 200, delays = longArrayOf(1)) {
                attempts += 1
                if (attempts < 3) throw GatewayMediaHttpException(409, code, "not yet")
                "ready"
            }
            assertEquals("ready", value)
            assertEquals(3, attempts)
        }
        assertTrue(isTransientMediaSetupError(GatewayMediaHttpException(409, "CAPTURE_NOT_ACTIVE", "x")))
        assertFalse(isTransientMediaSetupError(GatewayMediaHttpException(409, "CAPTURE_BINDING_CONFLICT", "x")))
        assertFalse(isTransientMediaSetupError(GatewayMediaHttpException(503, "MEDIA_NODE_PENDING", "x")))
        assertThrows(GatewayMediaHttpException::class.java) {
            runBlocking {
                retryMediaNodePending(timeoutMs = 200, delays = longArrayOf(1)) {
                    throw GatewayMediaHttpException(409, "CAPTURE_BINDING_CONFLICT", "conflict")
                }
            }
        }
    }

    @Test fun `probe parser accepts only server supplied HTTPS node targets`() {
        val json = JSONObject().put("networkGeneration", "opaque")
            .put("expiresAt", "2026-09-10T01:00:00Z")
            .put("nodes", JSONArray().put(
                JSONObject().put("nodeId", "future-node").put("probeUrl", "https://relay.example/probe")
                    .put("expiresAt", "2026-09-10T01:00:00Z")
                    .put("grants", JSONArray(listOf("a", "b", "c"))),
            ))
        assertEquals("future-node", parseGatewayProbeOptions(json).nodes.single().nodeId)
        assertFalse(gatewaySamplesJson(listOf(GatewayProbeSample("future-node", "timeout")))
            .getJSONObject(0).has("httpsRttMs"))
    }

    @Test fun `gateway runner consumes every one-time grant and never sends a request body`() {
        val opened = mutableListOf<org.vodog.gateway.GatewayHttpRequest>()
        var clock = 0L
        val result = GatewayTransportProbeRunner(
            transport = GatewayHttpTransport { request ->
                opened += request
                GatewayHttpResponse(200, JSONObject().put("ok", true).put("nodeId", "server-node").toString())
            },
            nanoTime = { clock.also { clock += 7_000_000 } },
        ).measure(node("server-node"))

        assertEquals(listOf("ok", "ok", "ok"), result.map { it.outcome })
        assertEquals(3, result.size)
        assertEquals(3, opened.size)
        opened.forEach {
            assertEquals("POST", it.method)
            assertEquals(null, it.jsonBody)
            assertTrue(it.authorization.orEmpty().startsWith("Bearer "))
        }
    }

    @Test fun `probe error responses still close every transport`() {
        var opened = 0
        val result = GatewayTransportProbeRunner(
            transport = GatewayHttpTransport {
                opened += 1
                GatewayHttpResponse(503, "{}")
            },
        ).measure(node("server-node"))

        assertTrue(result.all { it.outcome == "network_error" })
        assertEquals(3, opened)
    }

    @Test fun `probe cancellation stops before consuming another grant`() {
        var opened = 0
        assertThrows(CancellationException::class.java) {
            GatewayTransportProbeRunner(
                transport = GatewayHttpTransport {
                    opened += 1
                    throw CancellationException("owner closed")
                },
            ).measure(node("server-node"))
        }
        assertEquals(1, opened)
    }

    @Test fun `capture binding parser fences exact active Telecom identity`() {
        val callId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        val request = MediaCaptureRequest("device-call", 1234)
        val json = JSONObject().put("id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
            .put("callId", callId).put("deviceCallId", "device-call")
            .put("telecomCreationTimeMillis", 1234).put("captureGeneration", 9)
            .put("mediaNodeId", "control-node").put("mediaEpoch", 1).put("createdAt", "2026-09-10T00:00:00Z")
        assertEquals(9, parseCaptureBinding(json, callId, request).captureGeneration)
        assertThrows(IllegalArgumentException::class.java) {
            parseCaptureBinding(
                JSONObject(json.toString()).put("telecomCreationTimeMillis", 1235), callId, request,
            )
        }
    }

    private fun node(id: String) = GatewayProbeNode(
        id,
        "https://$id.example.test/probe",
        "2026-09-10T01:00:00Z",
        listOf("one", "two", "three"),
    )

}
