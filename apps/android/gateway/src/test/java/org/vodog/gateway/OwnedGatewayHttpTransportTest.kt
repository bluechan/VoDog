package org.vodog.gateway

import org.vodog.gateway.media.MEDIA_CONNECT_TIMEOUT_MS
import org.vodog.gateway.media.gatewayMediaPostRequest
import okhttp3.Connection
import okhttp3.ConnectionPool
import okhttp3.Interceptor
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class OwnedGatewayHttpTransportTest {
    @Test fun `active network call is cancelled without waiting for its request timeout`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        server.start()
        val transport = OwnedGatewayHttpTransport()
        val executor = Executors.newSingleThreadExecutor()
        try {
            val result = executor.submit<GatewayHttpResponse> {
                transport.execute(GatewayHttpRequest(server.url("/blocked").toString(), "GET", timeoutMs = 10_000))
            }
            assertTrue(server.takeRequest(2, TimeUnit.SECONDS) != null)

            transport.close()

            val failure = assertThrows(java.util.concurrent.ExecutionException::class.java) {
                result.get(2, TimeUnit.SECONDS)
            }
            assertTrue(failure.cause is IOException)
            assertTrue(transport.isClosed())
        } finally {
            transport.close()
            executor.shutdownNow()
            server.shutdown()
        }
    }

    @Test fun `closed HTTP2 owner evicts a connection released after the initial eviction`() {
        val server = MockWebServer()
        server.protocols = listOf(Protocol.H2_PRIOR_KNOWLEDGE)
        server.enqueue(MockResponse().setBody("response"))
        server.start()
        val pool = ConnectionPool(5, 5, TimeUnit.MINUTES)
        val headersRead = CountDownLatch(1)
        val releaseResponse = CountDownLatch(1)
        val transport = OwnedGatewayHttpTransport(
            pool = pool,
            protocols = listOf(Protocol.H2_PRIOR_KNOWLEDGE),
            interceptor = Interceptor { chain ->
                val response = chain.proceed(chain.request())
                headersRead.countDown()
                check(releaseResponse.await(5, TimeUnit.SECONDS))
                response
            },
        )
        val executor = Executors.newSingleThreadExecutor()
        try {
            val result = executor.submit<GatewayHttpResponse> {
                transport.execute(GatewayHttpRequest(server.url("/late-release").toString(), "GET"))
            }
            assertTrue(headersRead.await(2, TimeUnit.SECONDS))
            transport.close()
            assertEquals(1, pool.connectionCount())
            releaseResponse.countDown()
            runCatching { result.get(2, TimeUnit.SECONDS) }
            assertTrue(result.isDone)
            assertEquals(0, pool.connectionCount())
        } finally {
            releaseResponse.countDown()
            transport.close()
            pool.evictAll()
            executor.shutdownNow()
            server.shutdown()
        }
    }

    @Test fun `closed HTTP2 owner closes its socket at the late connection release event`() {
        val server = MockWebServer()
        server.protocols = listOf(Protocol.H2_PRIOR_KNOWLEDGE)
        server.enqueue(MockResponse().setBody("response"))
        server.start()
        val pool = ConnectionPool(5, 5, TimeUnit.MINUTES)
        val headersRead = CountDownLatch(1)
        val releaseResponse = CountDownLatch(1)
        val connectionReleased = CountDownLatch(1)
        val inspectReleasedConnection = CountDownLatch(1)
        var releasedConnection: Connection? = null
        val transport = OwnedGatewayHttpTransport(
            pool = pool,
            protocols = listOf(Protocol.H2_PRIOR_KNOWLEDGE),
            interceptor = Interceptor { chain ->
                val response = chain.proceed(chain.request())
                headersRead.countDown()
                check(releaseResponse.await(5, TimeUnit.SECONDS))
                response
            },
            onClosedConnectionReleased = { connection ->
                releasedConnection = connection
                connectionReleased.countDown()
                check(inspectReleasedConnection.await(5, TimeUnit.SECONDS))
            },
        )
        val executor = Executors.newSingleThreadExecutor()
        try {
            val result = executor.submit<GatewayHttpResponse> {
                transport.execute(GatewayHttpRequest(server.url("/late-event").toString(), "GET"))
            }
            assertTrue(headersRead.await(2, TimeUnit.SECONDS))
            transport.close()
            releaseResponse.countDown()
            assertTrue(connectionReleased.await(2, TimeUnit.SECONDS))

            // The execute finally block cannot run while the event callback is held here.
            // The event itself must close this private owner's socket and remove it from the pool.
            assertTrue(requireNotNull(releasedConnection).socket().isClosed)
            assertEquals(0, pool.connectionCount())
            inspectReleasedConnection.countDown()
            runCatching { result.get(2, TimeUnit.SECONDS) }
            assertTrue(result.isDone)
        } finally {
            releaseResponse.countDown()
            inspectReleasedConnection.countDown()
            transport.close()
            pool.evictAll()
            executor.shutdownNow()
            server.shutdown()
        }
    }

    @Test fun `redirect is returned to caller and is never followed`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "/followed"))
        server.enqueue(MockResponse().setResponseCode(200).setBody("followed"))
        server.start()
        val transport = OwnedGatewayHttpTransport()
        try {
            assertEquals(302, transport.execute(GatewayHttpRequest(server.url("/start").toString(), "GET")).status)
            assertEquals(1, server.requestCount)
        } finally {
            transport.close()
            server.shutdown()
        }
    }

    @Test fun `empty probe post has authorization but no json content type`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("{}"))
        server.start()
        val transport = OwnedGatewayHttpTransport()
        try {
            transport.execute(GatewayHttpRequest(
                server.url("/probe").toString(), "POST", authorization = "Bearer grant", jsonBody = null,
            ))
            val request = requireNotNull(server.takeRequest(1, TimeUnit.SECONDS))
            assertEquals("Bearer grant", request.getHeader("Authorization"))
            assertNull(request.getHeader("Content-Type"))
            assertEquals(0L, request.bodySize)
        } finally {
            transport.close()
            server.shutdown()
        }
    }

    @Test fun `timing tells a new connection from a reused one`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"first":true}"""))
        server.enqueue(MockResponse().setBody("""{"second":true}"""))
        server.start()
        val transport = OwnedGatewayHttpTransport()
        try {
            val body = """{"k":"v"}""".toByteArray()
            val first = requireNotNull(transport.execute(
                GatewayHttpRequest(server.url("/a").toString(), "POST", jsonBody = body),
            ).timing)
            val second = requireNotNull(transport.execute(GatewayHttpRequest(server.url("/b").toString(), "GET")).timing)

            assertFalse(first.reused)
            assertTrue(requireNotNull(first.tcpMs) >= 0L)
            assertNull(first.tlsMs) // plain HTTP: no handshake to time
            assertEquals("http/1.1", first.protocol)
            assertEquals(body.size.toLong(), first.reqBytes)
            assertEquals("""{"first":true}""".length.toLong(), first.respBytes)
            assertTrue(second.reused)
            assertNull(second.tcpMs)
            assertNull(second.dnsMs)
            assertEquals(0L, second.reqBytes)
            assertTrue(second.totalMs >= 0L && requireNotNull(second.ttfbMs) <= second.totalMs)
        } finally {
            transport.close()
            server.shutdown()
        }
    }

    @Test fun `ttfb stops at the response headers while total includes a throttled body`() {
        val server = MockWebServer()
        server.enqueue(MockResponse()
            .setHeadersDelay(200, TimeUnit.MILLISECONDS)
            .setBody("x".repeat(4_096))
            .throttleBody(1_024, 100, TimeUnit.MILLISECONDS))
        server.start()
        val transport = OwnedGatewayHttpTransport()
        try {
            val timing = requireNotNull(transport.execute(GatewayHttpRequest(server.url("/slow").toString(), "GET")).timing)
            val ttfb = requireNotNull(timing.ttfbMs)
            assertTrue("ttfb $ttfb", ttfb >= 150L)
            // Four 1 KiB periods of 100 ms each arrive after the headers.
            assertTrue("total ${timing.totalMs} ttfb $ttfb", timing.totalMs >= ttfb + 250L)
            assertEquals(4_096L, timing.respBytes)
        } finally {
            transport.close()
            server.shutdown()
        }
    }

    @Test fun `media options retries on the alternate endpoint while media offer never does`() {
        val direct = BuildConfig.API_BASE_URL
        val relay = BuildConfig.RELAY_API_BASE_URL
        val body = JSONObject().put("transport", "tls")
        val cases = listOf(
            GatewayApiRoutes.mediaOptions("11111111-1111-4111-8111-111111111111") to 2,
            GatewayApiRoutes.mediaOffer("11111111-1111-4111-8111-111111111111") to 1,
        )
        cases.forEach { (path, expectedRequests) ->
            val seen = Collections.synchronizedList(mutableListOf<String>())
            val connectBounds = Collections.synchronizedList(mutableListOf<Int>())
            val transport = OwnedGatewayHttpTransport(interceptor = Interceptor { chain ->
                seen += chain.request().url.toString()
                connectBounds += chain.connectTimeoutMillis()
                if (chain.request().url.toString().startsWith(direct)) throw IOException("unreachable")
                Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("ok")
                    .body("{}".toResponseBody()).build()
            })
            transport.use {
                val request = gatewayMediaPostRequest(direct, path, "device-token", body)
                if (expectedRequests == 2) assertEquals(200, it.execute(request).status)
                else assertThrows(IOException::class.java) { it.execute(request) }
            }
            assertEquals(path, expectedRequests, seen.size)
            if (expectedRequests == 2) assertEquals(listOf(direct + path, relay + path), seen.toList())
            // Both media POSTs give up a black-holed endpoint after 4 s, not the owner's 10 s.
            assertTrue(connectBounds.all { it == MEDIA_CONNECT_TIMEOUT_MS.toInt() })
        }
        // Everything else keeps the owner's connect bound.
        val bounds = Collections.synchronizedList(mutableListOf<Int>())
        OwnedGatewayHttpTransport(interceptor = Interceptor { chain ->
            bounds += chain.connectTimeoutMillis()
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("ok")
                .body("{}".toResponseBody()).build()
        }).use { it.execute(GatewayHttpRequest("$direct/gateway/heartbeat", "POST")) }
        assertEquals(listOf(10_000), bounds.toList())
    }

    @Test fun `response body over configured limit fails closed`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("123456789"))
        server.start()
        val transport = OwnedGatewayHttpTransport()
        try {
            assertThrows(IOException::class.java) {
                transport.execute(GatewayHttpRequest(server.url("/large").toString(), "GET", responseLimitBytes = 8))
            }
        } finally {
            transport.close()
            server.shutdown()
        }
    }
}
