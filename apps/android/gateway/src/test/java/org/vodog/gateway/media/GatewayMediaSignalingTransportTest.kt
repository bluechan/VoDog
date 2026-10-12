package org.vodog.gateway.media

import org.vodog.gateway.GatewayHttpRequest
import org.vodog.gateway.GatewayHttpResponse
import org.vodog.gateway.GatewayHttpTransport
import org.vodog.gateway.GatewayMediaSetupOwner
import org.vodog.gateway.OwnedGatewayHttpTransport
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class GatewayMediaSignalingTransportTest {
    @Test fun `signaling close keeps the shared pool and the next signaling reuses the connection`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(MockResponse().setBody("{}"))
        server.start()
        val shared = OwnedGatewayHttpTransport()
        try {
            val first = GatewayMediaSignalingTransport.forSignaling(shared)
            assertFalse(requireNotNull(first.execute(GatewayHttpRequest(server.url("/a").toString(), "GET")).timing).reused)
            first.close()

            assertFalse(shared.isClosed())
            assertThrows(IllegalStateException::class.java) {
                first.execute(GatewayHttpRequest(server.url("/late").toString(), "GET"))
            }
            val second = GatewayMediaSignalingTransport.forSignaling(shared)
            assertTrue(requireNotNull(second.execute(GatewayHttpRequest(server.url("/b").toString(), "GET")).timing).reused)
        } finally {
            shared.close(); server.shutdown()
        }
    }

    @Test fun `off cancels the pending signaling call but not another signaling on the shared pool`() {
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/blocked" -> MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)
                else -> MockResponse().setHeadersDelay(500, TimeUnit.MILLISECONDS).setBody("{}")
            }
        }
        server.start()
        val shared = OwnedGatewayHttpTransport()
        val pending = GatewayMediaSignalingTransport.forSignaling(shared)
        val other = GatewayMediaSignalingTransport.forSignaling(shared)
        val owner = GatewayMediaSetupOwner {}
        assertTrue(owner.register(pending))
        val executor = Executors.newFixedThreadPool(2)
        try {
            val blocked = executor.submit<GatewayHttpResponse> {
                pending.execute(GatewayHttpRequest(server.url("/blocked").toString(), "POST", jsonBody = "{}".toByteArray(), timeoutMs = 10_000))
            }
            assertTrue(server.takeRequest(2, TimeUnit.SECONDS) != null)
            val survivor = executor.submit<GatewayHttpResponse> {
                other.execute(GatewayHttpRequest(server.url("/other").toString(), "GET", timeoutMs = 10_000))
            }
            assertTrue(server.takeRequest(2, TimeUnit.SECONDS) != null)

            owner.close()

            val error = runCatching { blocked.get(2, TimeUnit.SECONDS) }.exceptionOrNull()
            assertTrue(error is ExecutionException && error.cause is IOException)
            assertEquals(200, survivor.get(5, TimeUnit.SECONDS).status)
            assertFalse(shared.isClosed())
        } finally {
            executor.shutdownNow(); shared.close(); server.shutdown()
        }
    }

    @Test fun `warm-up is one healthz GET with no alternate retry and swallows failure`() {
        val sent = mutableListOf<GatewayHttpRequest>()
        val failing = GatewayHttpTransport { request -> sent += request; throw IOException("offline") }

        warmMediaSignaling(failing, "https://control.example.com/api/v1", "call-1")

        assertEquals(1, sent.size)
        assertEquals("https://control.example.com/healthz", sent.single().url)
        assertEquals("GET", sent.single().method)
        assertFalse(sent.single().alternateRetry)
        assertEquals(MEDIA_CONNECT_TIMEOUT_MS, sent.single().connectTimeoutMs)
    }

    @Test fun `warm-up opens the connection the media options request then reuses`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(404))
        server.enqueue(MockResponse().setBody("{}"))
        server.start()
        val shared = OwnedGatewayHttpTransport()
        try {
            warmMediaSignaling(shared, server.url("/api/v1").toString(), null)
            assertEquals("/healthz", server.takeRequest(1, TimeUnit.SECONDS)?.path)

            val options = GatewayMediaSignalingTransport.forSignaling(shared).execute(
                GatewayHttpRequest(server.url("/api/v1/gateway/calls/c/media/options").toString(), "POST", jsonBody = "{}".toByteArray()),
            )
            assertTrue(requireNotNull(options.timing).reused)
        } finally {
            shared.close(); server.shutdown()
        }
    }
}
