package org.vodog

import kotlinx.coroutines.CancellationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CallMediaRetryPolicyTest {
    private fun media(kind: CallMediaFailureKind, transport: CallMediaTransport = CallMediaTransport.UDP) =
        CallMediaSessionException(kind, transport)

    @Test fun relayPathFailuresAreRetriedOverTls() {
        listOf(
            CallMediaFailureKind.ICE_GATHERING_TIMED_OUT,
            CallMediaFailureKind.NO_RELAY_CANDIDATE,
            CallMediaFailureKind.ICE_CONNECT_TIMED_OUT,
            CallMediaFailureKind.ICE_CONNECTION_FAILED,
            CallMediaFailureKind.PEER_CREATION_FAILED,
            CallMediaFailureKind.MISSING_LOCAL_DESCRIPTION,
        ).forEach { kind ->
            assertTrue(kind.name, CallMediaRetryPolicy.shouldRetryTls(media(kind)))
        }
    }

    @Test fun contractAndDeviceFailuresAreNotRetried() {
        listOf(
            CallMediaFailureKind.INVALID_RELAY_OPTIONS,
            CallMediaFailureKind.INVALID_ANSWER,
            CallMediaFailureKind.MICROPHONE_PERMISSION_DENIED,
            CallMediaFailureKind.AUDIO_SESSION_CONFIGURATION_FAILED,
        ).forEach { kind ->
            assertFalse(kind.name, CallMediaRetryPolicy.shouldRetryTls(media(kind)))
        }
    }

    @Test fun serverErrorsAreNeverRetried() {
        assertFalse(CallMediaRetryPolicy.shouldRetryTls(ApiError(409, "MEDIA_REVOKED", "")))
        assertFalse(CallMediaRetryPolicy.shouldRetryTls(ApiError(503, "GATEWAY_OFFLINE", "")))
        assertFalse(CallMediaRetryPolicy.shouldRetryTls(ApiError(401, "UNAUTHORIZED", "expired")))
        assertFalse(CallMediaRetryPolicy.shouldRetryTls(ApiError(500, "HTTP_500", "")))
    }

    @Test fun probeSessionAndCancellationAreNeverRetried() {
        assertFalse(CallMediaRetryPolicy.shouldRetryTls(CallMediaProbeException(IllegalStateException("network changed"))))
        assertFalse(CallMediaRetryPolicy.shouldRetryTls(SessionChangedException()))
        assertFalse(CallMediaRetryPolicy.shouldRetryTls(CallMediaStaleAttempt("音频连接已取消")))
        assertFalse(CallMediaRetryPolicy.shouldRetryTls(CancellationException("cancelled")))
    }

    @Test fun webRtcErrorsAreRetried() {
        assertTrue(CallMediaRetryPolicy.shouldRetryTls(IllegalStateException("CreateOffer failed")))
        assertTrue(CallMediaRetryPolicy.shouldRetryTls(java.net.SocketTimeoutException("音频协商请求超时，请重试音频")))
    }

    private class MapStore : CallMediaTransportMemory.Store {
        val values = mutableMapOf<String, Long>()
        override fun read(): Map<String, Long> = values.toMap()
        override fun write(signature: String, learnedAtMs: Long?) {
            if (learnedAtMs == null) values -= signature else values[signature] = learnedAtMs
        }
    }

    @Test fun aTlsFallbackThatWorkedStartsTheNextCallOnTlsForADay() {
        var now = 1_000_000L
        val store = MapStore()
        val memory = CallMediaTransportMemory(store) { now }
        val udp = CallMediaTransport.UDP
        val tls = CallMediaTransport.TLS
        assertEquals(udp, memory.startTransport("wifi:office", udp))
        memory.rememberTls("wifi:office")
        assertEquals(tls, memory.startTransport("wifi:office", udp))
        // Per network: home Wi-Fi still starts on UDP; no signature (cellular, unknown) never learns.
        assertEquals(udp, memory.startTransport("wifi:home", udp))
        memory.rememberTls(null)
        assertEquals(udp, memory.startTransport(null, udp))
        // A UDP start that connected elsewhere does not forget this network.
        memory.forget("wifi:home")
        assertEquals(tls, memory.startTransport("wifi:office", udp))
        // An explicit request is never rewritten.
        assertEquals(tls, memory.startTransport("wifi:home", tls))
        // 24 h from the fallback, UDP is tried again (a learned TLS success does not renew it).
        now += CallMediaTransportMemory.TTL_MS - 1
        assertEquals(tls, memory.startTransport("wifi:office", udp))
        now += 1
        assertEquals(udp, memory.startTransport("wifi:office", udp))
        // Expired entries are pruned on the next write.
        memory.rememberTls("wifi:hotel")
        assertEquals(setOf("wifi:hotel"), store.values.keys)
        memory.forget("wifi:hotel")
        assertEquals(udp, memory.startTransport("wifi:hotel", udp))
        assertEquals(24 * 3_600_000L, CallMediaTransportMemory.TTL_MS)
    }

    @Test fun aBrokenStoreOnlyCostsTheOptimisation() {
        val memory = CallMediaTransportMemory(object : CallMediaTransportMemory.Store {
            override fun read(): Map<String, Long> = error("disk")
            override fun write(signature: String, learnedAtMs: Long?) = error("disk")
        })
        memory.rememberTls("wifi:x")
        memory.forget("wifi:x")
        assertEquals(CallMediaTransport.UDP, memory.startTransport("wifi:x", CallMediaTransport.UDP))
    }

    @Test fun networkSignatureIsAStableDigestOfWiFiOrEthernetOnly() {
        val home = mediaNetworkSignature("wifi", listOf("192.168.1.1"), listOf("192.168.1.1"), "lan")
        assertEquals(home, mediaNetworkSignature("wifi", listOf("192.168.1.1"), listOf("192.168.1.1"), "lan"))
        assertTrue(home!!.startsWith("wifi:"))
        assertFalse("no address is kept", home.contains("192.168"))
        // Order does not matter; another DNS, gateway or a VPN on top is another network.
        assertEquals(
            mediaNetworkSignature("wifi", listOf("8.8.8.8", "1.1.1.1"), emptyList(), null),
            mediaNetworkSignature("wifi", listOf("1.1.1.1", "8.8.8.8"), emptyList(), null),
        )
        assertNotEquals(home, mediaNetworkSignature("wifi", listOf("10.0.0.1"), listOf("192.168.1.1"), "lan"))
        assertNotEquals(home, mediaNetworkSignature("wifi+vpn", listOf("192.168.1.1"), listOf("192.168.1.1"), "lan"))
        assertTrue(mediaNetworkSignature("ethernet", emptyList(), listOf("10.0.0.1"), null)!!.startsWith("ethernet:"))
        // Cellular stays UDP-first (S73b); nothing to key on means no memory.
        assertNull(mediaNetworkSignature("cellular", listOf("10.0.0.1"), listOf("10.0.0.1"), null))
        assertNull(mediaNetworkSignature("wifi", emptyList(), emptyList(), "lan"))
        assertNull(mediaNetworkSignature("other", listOf("10.0.0.1"), emptyList(), null))
    }
}
