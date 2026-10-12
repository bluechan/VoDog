package org.vodog

import android.telecom.DisconnectCause
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** S72b: Core-Telecom 断开码、蜂窝中转端点与换端点重试、中转 TURN hostname。 */
class S72bClientFixesTest {
    @Before fun configureRelay() { ClientEndpoint.relayBaseUrl = "https://relay.example.com:16800/api/v1" }

    @After fun resetRelay() = ClientEndpoint.resetForTest()

    @Test fun emptyRelayBaseDisablesRelayAndAlternateRetry() {
        ClientEndpoint.relayBaseUrl = ""
        ClientEndpoint.onDefaultNetwork("cellular", "net-cn") { true }
        assertFalse(ClientEndpoint.relay)
        assertEquals(BuildConfig.API_BASE_URL, ClientEndpoint.baseUrl())
        assertNull(ClientEndpoint.alternateUrl("${BuildConfig.API_BASE_URL}/calls"))
        val urls = mutableListOf<URL>()
        val transport = UrlConnectionClientTransport(connectionFactory = { urls += it; throw IOException("down") })
        assertThrows(IOException::class.java) { transport.execute(ClientRequest("GET", "/calls", null, null, null)) }
        assertEquals(1, urls.size)
    }

    @Test fun transactionalDisconnectOnlyEmitsCodesCoreTelecomAccepts() {
        for (code in listOf(DisconnectCause.LOCAL, DisconnectCause.REMOTE, DisconnectCause.MISSED, DisconnectCause.REJECTED)) {
            assertEquals(code to null, transactionalDisconnectCode(code))
        }
        assertEquals(DisconnectCause.REMOTE to "已在其他设备接听", transactionalDisconnectCode(DisconnectCause.ANSWERED_ELSEWHERE))
        assertEquals(DisconnectCause.MISSED to null, transactionalDisconnectCode(DisconnectCause.CANCELED))
        assertEquals(DisconnectCause.LOCAL to null, transactionalDisconnectCode(DisconnectCause.ERROR))
        // 共享 helper 的所有出口都落在四个合法码内。
        val allowed = setOf(DisconnectCause.LOCAL, DisconnectCause.REMOTE, DisconnectCause.MISSED, DisconnectCause.REJECTED)
        for (detail in listOf(null, JSONObject().put("state", "active"), JSONObject().put("state", "ended"))) {
            assertTrue(transactionalDisconnectCode(ringingEndedDisconnectCause(detail)).first in allowed)
        }
    }

    @Test fun alternateUrlSwapsBetweenDirectAndRelay() {
        val direct = "https://control.example.com/api/v1"
        val relay = "https://relay.example.com:16800/api/v1"
        assertEquals("$relay/calls/x", ClientEndpoint.alternateUrl("$direct/calls/x", direct, relay))
        assertEquals("$direct/calls/x", ClientEndpoint.alternateUrl("$relay/calls/x", direct, relay))
        assertNull(ClientEndpoint.alternateUrl("https://other.example/api/v1/x", direct, relay))
        assertNull(ClientEndpoint.alternateUrl("$direct/x", direct, direct))
        ClientEndpoint.setRelayForTest(true)
        assertEquals(ClientEndpoint.relayBaseUrl, ClientEndpoint.baseUrl())
    }

    @Test fun networkFailureRetriesIdempotentRequestOnceOnTheOtherEndpoint() {
        val urls = mutableListOf<URL>()
        val transport = UrlConnectionClientTransport(connectionFactory = { urls += it; throw IOException("connect timed out") })
        assertThrows(IOException::class.java) { transport.execute(ClientRequest("GET", "/calls/x", null, null, null)) }
        val expectedUrls = listOf("${BuildConfig.API_BASE_URL}/calls/x",
            "${ClientEndpoint.relayBaseUrl}/calls/x").distinct()
        assertEquals(expectedUrls, urls.map(URL::toString))

        urls.clear()
        assertThrows(IOException::class.java) {
            transport.execute(ClientRequest("POST", "/calls/x/claim", JSONObject(), null, null))
        }
        assertEquals(1, urls.size) // 非幂等 POST 不重发

        urls.clear()
        assertThrows(IOException::class.java) {
            transport.execute(ClientRequest("POST", "/calls/outbound", JSONObject(), "key-1", null))
        }
        assertEquals(expectedUrls.size, urls.size) // Retry only when a distinct alternate exists.
    }

    @Test fun relayTurnWithIpUrlAndHostnameParses() {
        val json = JSONObject().put("iceTransportPolicy", "relay").put(
            "iceServers",
            JSONArray().put(
                JSONObject().put("urls", JSONArray().put("turns:203.0.113.29:16803?transport=tcp"))
                    .put("username", "u").put("credential", "c").put("hostname", "control.example.com"),
            ),
        )
        assertEquals("control.example.com", CallMediaOptions.parse(json, CallMediaTransport.TLS).iceServer.hostname)
        json.getJSONArray("iceServers").getJSONObject(0).put("hostname", "203.0.113.29")
        assertThrows(IllegalArgumentException::class.java) { CallMediaOptions.parse(json, CallMediaTransport.TLS) }
    }

    @Test fun relayOnlyForChinaCellular() {
        // (transport, data-SIM operator, registered network operator, time zone) -> relay
        val table = listOf(
            Triple("cellular", "46001" to "46001", "Europe/Berlin") to true,      // China Unicom at home
            Triple("cellular", "26202" to "26202", "Asia/Shanghai") to false,     // German SIM in Germany
            Triple("cellular", null to null, "Asia/Shanghai") to true,            // MCC unreadable: time zone
            Triple("cellular", "" to "", "Europe/Berlin") to false,
            Triple("cellular", null to "46000", "Europe/Berlin") to true,         // SIM unreadable: network MCC
            Triple("cellular", "46001" to "45006", "Asia/Hong_Kong") to true,     // China SIM roaming: home-routed via China
            Triple("cellular", "26202" to "46000", "Asia/Shanghai") to false,     // foreign SIM roaming in China: exits abroad
            Triple("wifi", "46001" to "46001", "Asia/Shanghai") to false,         // Wi-Fi is always direct (unless learned)
            Triple("ethernet", "46001" to "46001", "Asia/Shanghai") to false,
        )
        for ((input, expected) in table) {
            val (transport, operators, zone) = input
            val china = ClientRelayPolicy.chinaCellular(operators.first, operators.second, zone)
            assertEquals(input.toString(), expected, ClientRelayPolicy.relay(transport, china, learned = null))
        }
        assertEquals("460", ClientRelayPolicy.mcc("460011"))
        assertNull(ClientRelayPolicy.mcc("4600"))
        assertNull(ClientRelayPolicy.mcc("46a01"))
        // A measured failover overrides the rule both ways.
        assertTrue(ClientRelayPolicy.relay("wifi", chinaCellular = false, learned = true))
        assertFalse(ClientRelayPolicy.relay("cellular", chinaCellular = true, learned = false))
    }

    @Test fun endpointFollowsTheDefaultNetworkAndForgetsLearnedFailoverAfterTenMinutes() {
        ClientEndpoint.onDefaultNetwork("cellular", "net-cn") { true }
        assertTrue(ClientEndpoint.relay)
        assertEquals(ClientEndpoint.relayBaseUrl, ClientEndpoint.baseUrl())
        ClientEndpoint.onDefaultNetwork("cellular", "net-de") { false }
        assertFalse(ClientEndpoint.relay)
        assertEquals(BuildConfig.API_BASE_URL, ClientEndpoint.baseUrl())
        // The MCC is read once per network, not on every capabilities callback.
        ClientEndpoint.onDefaultNetwork("cellular", "net-de") { error("re-read") }
        assertFalse(ClientEndpoint.relay)

        ClientEndpoint.learn(workingRelay = true)
        assertTrue(ClientEndpoint.relay)
        // Learned per network: another network starts from the rule again, and coming back still remembers.
        ClientEndpoint.onDefaultNetwork("wifi", "net-wifi")
        assertFalse(ClientEndpoint.relay)
        ClientEndpoint.onDefaultNetwork("cellular", "net-de") { false }
        assertTrue(ClientEndpoint.relay)
        // Learned more than ClientRelayPolicy.LEARNED_TTL_MS ago: expired.
        ClientEndpoint.learn(workingRelay = true, nowMs = System.nanoTime() / 1_000_000 - ClientRelayPolicy.LEARNED_TTL_MS - 1_000)
        assertFalse(ClientEndpoint.relay)
        assertEquals(600_000L, ClientRelayPolicy.LEARNED_TTL_MS)
    }

    @Test fun directNetworkFailureThatTheRelayAnswersIsRemembered() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        server.start()
        try {
            ClientEndpoint.onDefaultNetwork("wifi", "net-hotel")
            val urls = mutableListOf<String>()
            val transport = UrlConnectionClientTransport(connectionFactory = { url ->
                urls += url.toString()
                if (url.toString().startsWith(BuildConfig.API_BASE_URL)) throw IOException("connect timed out")
                server.url(url.path).toUrl().openConnection() as HttpURLConnection
            })
            transport.execute(ClientRequest("GET", "/calls", null, null, null))
            assertEquals(listOf("${BuildConfig.API_BASE_URL}/calls", "${ClientEndpoint.relayBaseUrl}/calls"), urls)
            assertTrue(ClientEndpoint.relay)
            // The next request goes to the remembered relay first, with no failed direct attempt.
            urls.clear()
            transport.execute(ClientRequest("GET", "/sims", null, null, null))
            assertEquals(listOf("${ClientEndpoint.relayBaseUrl}/sims"), urls)
        } finally {
            server.shutdown()
        }
    }
}
