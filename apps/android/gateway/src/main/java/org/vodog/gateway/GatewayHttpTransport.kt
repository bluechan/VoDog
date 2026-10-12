package org.vodog.gateway

import okhttp3.Call
import okhttp3.Connection
import okhttp3.ConnectionPool
import okhttp3.Dispatcher
import okhttp3.EventListener
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.Buffer
import java.io.Closeable
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

data class GatewayHttpRequest(
    val url: String,
    val method: String,
    val authorization: String? = null,
    val jsonBody: ByteArray? = null,
    val timeoutMs: Long = 15_000,
    val responseLimitBytes: Int = 1024 * 1024,
    /** S36b D2: extra request headers (only `X-Diag-Install` so far). */
    val headers: Map<String, String> = emptyMap(),
    /**
     * S71: safe to send twice. GET and any request carrying an `Idempotency-Key` header are; callers
     * mark the POST routes Control deduplicates themselves (eventId, commandId, state reports).
     */
    val idempotent: Boolean = method == "GET" || headers.keys.any { it.equals("Idempotency-Key", ignoreCase = true) },
    /** S71: false opts a request out of the alternate-endpoint retry (the S21 standby long-poll). */
    val alternateRetry: Boolean = true,
    /** Per-request TCP+TLS connect bound; null keeps the owner's 10 s (media signaling uses 4 s). */
    val connectTimeoutMs: Long? = null,
    /** S123 决策 9: the view that sent this on a shared transport; [OwnedGatewayHttpTransport.cancelInFlight] keys on it. */
    val owner: Any? = null,
)

/**
 * One HTTP exchange's network phases, in ms (null = the phase did not happen on this call, e.g. no
 * DNS/TCP/TLS on a [reused] connection). [ttfbMs] runs from the last request byte to the response
 * headers (server time plus one round trip); [totalMs] from call start to the last body byte read.
 * Byte counts are bodies only. Content-free: no URL, header or body ever lands here.
 */
data class GatewayHttpTiming(
    val dnsMs: Long?,
    val tcpMs: Long?,
    val tlsMs: Long?,
    val reused: Boolean,
    val protocol: String?,
    val ttfbMs: Long?,
    val totalMs: Long,
    val reqBytes: Long,
    val respBytes: Long,
) {
    fun diagFields(): Map<String, Any?> = mapOf(
        "dnsMs" to dnsMs, "tcpMs" to tcpMs, "tlsMs" to tlsMs, "reused" to reused, "protocol" to protocol,
        "ttfbMs" to ttfbMs, "totalMs" to totalMs, "reqBytes" to reqBytes, "respBytes" to respBytes,
    )
}

data class GatewayHttpResponse(val status: Int, val body: String, val timing: GatewayHttpTiming? = null)

/** Fed by [OwnedGatewayHttpTransport]'s event listener; travels with its request as an OkHttp tag. */
internal class GatewayHttpTimingRecorder(private val nanoTime: () -> Long = System::nanoTime) {
    private val createdNs = nanoTime()
    @Volatile private var callStartNs = 0L
    @Volatile private var dnsStartNs = 0L
    @Volatile private var dnsEndNs = 0L
    @Volatile private var connectStartNs = 0L
    @Volatile private var secureStartNs = 0L
    @Volatile private var secureEndNs = 0L
    @Volatile private var connectEndNs = 0L
    @Volatile private var requestEndNs = 0L
    @Volatile private var responseHeadersNs = 0L
    @Volatile private var protocol: String? = null
    @Volatile private var reqBytes = 0L
    @Volatile private var respBytes = -1L

    fun callStart() { if (callStartNs == 0L) callStartNs = nanoTime() }
    fun dnsStart() { if (dnsStartNs == 0L) dnsStartNs = nanoTime() }
    fun dnsEnd() { dnsEndNs = nanoTime() }
    fun connectStart() { if (connectStartNs == 0L) connectStartNs = nanoTime() }
    fun secureConnectStart() { if (secureStartNs == 0L) secureStartNs = nanoTime() }
    fun secureConnectEnd() { secureEndNs = nanoTime() }
    fun connectEnd() { connectEndNs = nanoTime() }
    fun connectionAcquired(value: String) { protocol = value }
    fun requestEnd(bodyBytes: Long?) { requestEndNs = nanoTime(); bodyBytes?.let { reqBytes = it } }
    fun responseHeadersStart() { if (responseHeadersNs == 0L) responseHeadersNs = nanoTime() }
    fun responseBodyEnd(bytes: Long) { respBytes = bytes }

    /** Called once the body has been read; [bodyBytes] backs up a body-end event that never fired. */
    fun snapshot(bodyBytes: Long): GatewayHttpTiming {
        val end = nanoTime()
        fun span(from: Long, to: Long): Long? = if (from > 0L && to >= from) (to - from) / 1_000_000 else null
        return GatewayHttpTiming(
            dnsMs = span(dnsStartNs, dnsEndNs),
            tcpMs = span(connectStartNs, secureStartNs.takeIf { it > 0L } ?: connectEndNs),
            tlsMs = span(secureStartNs, secureEndNs),
            reused = connectStartNs == 0L,
            protocol = protocol,
            ttfbMs = span(requestEndNs, responseHeadersNs),
            totalMs = ((end - (callStartNs.takeIf { it > 0L } ?: createdNs)) / 1_000_000).coerceAtLeast(0L),
            reqBytes = reqBytes,
            respBytes = respBytes.takeIf { it >= 0L } ?: bodyBytes,
        )
    }
}

fun interface GatewayHttpTransport : Closeable {
    fun execute(request: GatewayHttpRequest): GatewayHttpResponse
    fun cancelAndEvict() = Unit
    override fun close() = cancelAndEvict()
}

/** A private pool/dispatcher whose lifetime is exactly one gateway owner. */
class OwnedGatewayHttpTransport internal constructor(
    private val pool: ConnectionPool = ConnectionPool(5, 5, TimeUnit.MINUTES),
    private val dispatcher: Dispatcher = Dispatcher(),
    private val socketFactory: OwnedGatewaySocketFactory = OwnedGatewaySocketFactory(),
    interceptor: Interceptor? = null,
    private val onCallRegistered: ((Call) -> Unit)? = null,
    private val onClosedConnectionReleased: ((Connection) -> Unit)? = null,
    protocols: List<Protocol>? = null,
    /**
     * Per-read socket timeout. The default covers every owner that only makes short requests and the
     * 8 s command doorbell; the S21 standby beacon holds for 20 s and raises it to 35 s. It is a
     * separate knob from [GatewayHttpRequest.timeoutMs], which is the whole-call deadline.
     */
    readTimeoutSeconds: Long = DEFAULT_READ_TIMEOUT_SECONDS,
) : GatewayHttpTransport {
    private val lock = Any()
    private val active = mutableMapOf<Call, Any?>()
    private val cancelledOwners = java.util.Collections.newSetFromMap(java.util.WeakHashMap<Any, Boolean>())
    private var closed = false
    private val client = OkHttpClient.Builder()
        .connectionPool(pool)
        .dispatcher(dispatcher)
        .socketFactory(socketFactory)
        // S118: process-global last-known-good / built-in fallback when system DNS fails.
        .dns(GatewayDns)
        .eventListenerFactory { created ->
            val timing = created.request().tag(GatewayHttpTimingRecorder::class.java)
            object : EventListener() {
                override fun callStart(call: Call) { timing?.callStart() }
                override fun dnsStart(call: Call, domainName: String) { timing?.dnsStart() }
                override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<java.net.InetAddress>) { timing?.dnsEnd() }
                override fun connectStart(call: Call, inetSocketAddress: java.net.InetSocketAddress, proxy: java.net.Proxy) {
                    timing?.connectStart()
                }
                override fun secureConnectStart(call: Call) { timing?.secureConnectStart() }
                override fun secureConnectEnd(call: Call, handshake: okhttp3.Handshake?) { timing?.secureConnectEnd() }
                override fun connectEnd(
                    call: Call, inetSocketAddress: java.net.InetSocketAddress, proxy: java.net.Proxy, protocol: Protocol?,
                ) { timing?.connectEnd() }
                override fun requestHeadersEnd(call: Call, request: Request) { timing?.requestEnd(null) }
                override fun requestBodyEnd(call: Call, byteCount: Long) { timing?.requestEnd(byteCount) }
                override fun responseHeadersStart(call: Call) { timing?.responseHeadersStart() }
                override fun responseBodyEnd(call: Call, byteCount: Long) { timing?.responseBodyEnd(byteCount) }

                override fun connectionAcquired(call: Call, connection: Connection) {
                    timing?.connectionAcquired(connection.protocol().toString())
                    if (isClosed()) {
                        call.cancel()
                        closeOwnedConnection(connection)
                    }
                }

                override fun connectionReleased(call: Call, connection: Connection) {
                    if (isClosed()) {
                        closeOwnedConnection(connection)
                        onClosedConnectionReleased?.invoke(connection)
                    }
                }
            }
        }
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(readTimeoutSeconds.coerceAtLeast(1L), TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .apply { interceptor?.let(::addInterceptor); protocols?.let(::protocols) }
        .build()
    /**
     * Same pool, dispatcher, socket factory and event listener as [client] (so OFF still reaches
     * every socket), only a shorter connect bound. One per distinct [GatewayHttpRequest.connectTimeoutMs].
     */
    private val connectBoundClients = java.util.concurrent.ConcurrentHashMap<Long, OkHttpClient>()

    private fun clientFor(request: GatewayHttpRequest): OkHttpClient =
        request.connectTimeoutMs?.takeIf { it > 0L }?.let { bound ->
            connectBoundClients.getOrPut(bound) { client.newBuilder().connectTimeout(bound, TimeUnit.MILLISECONDS).build() }
        } ?: client

    override fun execute(request: GatewayHttpRequest): GatewayHttpResponse {
        require(request.responseLimitBytes > 0)
        try {
            return executeOnce(request, request.url)
        } catch (failure: IOException) {
            // S71: a network-layer failure (no HTTP status) tries the other Control endpoint once.
            val alternate = GatewayEndpoint.alternateUrl(request.url)
            if (failure is ResponseTooLargeException || isClosed() || isCancelled(request.owner) || alternate == null ||
                !request.idempotent || !request.alternateRetry) throw failure
            runCatching { GatewayDiag.log("api.alternate_retry", mapOf(
                "relay" to !GatewayEndpoint.relay, "errorType" to failure.javaClass.simpleName,
            ), level = "warn") }
            try {
                return executeOnce(request, alternate)
            } catch (second: Exception) {
                second.addSuppressed(failure)
                throw second
            }
        }
    }

    private fun executeOnce(request: GatewayHttpRequest, url: String): GatewayHttpResponse {
        val timing = GatewayHttpTimingRecorder()
        val builder = Request.Builder().url(url)
            .header("Accept", "application/json")
            .tag(GatewayHttpTimingRecorder::class.java, timing)
        request.authorization?.let { builder.header("Authorization", it) }
        request.headers.forEach { (name, value) -> builder.header(name, value) }
        val body = when {
            request.jsonBody != null -> request.jsonBody.toRequestBody(JSON_MEDIA_TYPE)
            request.method in METHODS_REQUIRING_BODY -> ByteArray(0).toRequestBody(null)
            else -> null
        }
        builder.method(request.method, body)
        val call = clientFor(request).newCall(builder.build()).also {
            it.timeout().timeout(request.timeoutMs, TimeUnit.MILLISECONDS)
        }
        synchronized(lock) {
            check(!closed && (request.owner == null || request.owner !in cancelledOwners)) { "gateway network owner closed" }
            active[call] = request.owner
        }
        try {
            onCallRegistered?.invoke(call)
            call.execute().use { response ->
                val source = response.body?.source()
                val bytes = source?.let { input ->
                    val buffer = Buffer()
                    while (true) {
                        val remaining = request.responseLimitBytes.toLong() + 1 - buffer.size
                        if (remaining <= 0) throw ResponseTooLargeException()
                        val count = input.read(buffer, minOf(8_192L, remaining))
                        if (count < 0) break
                    }
                    if (buffer.size > request.responseLimitBytes) throw ResponseTooLargeException()
                    buffer.readByteArray()
                } ?: ByteArray(0)
                return GatewayHttpResponse(response.code, bytes.toString(Charsets.UTF_8), timing.snapshot(bytes.size.toLong()))
            }
        } finally {
            val ownerClosed = synchronized(lock) { active.remove(call); closed }
            // evictAll only closes idle connections. An HTTP/2 stream cancelled during
            // close() may release its connection after that first eviction. The response
            // is closed above, so evict again here instead of retaining it for five minutes.
            if (ownerClosed) runCatching(pool::evictAll)
        }
    }

    override fun cancelAndEvict() {
        val calls = synchronized(lock) {
            if (closed) return
            closed = true
            active.keys.toList().also { active.clear() }
        }
        socketFactory.close()
        calls.forEach { runCatching(it::cancel) }
        runCatching(dispatcher::cancelAll)
        runCatching(pool::evictAll)
        runCatching { dispatcher.executorService.shutdownNow() }
    }

    /**
     * S123 决策 9: OFF for one view of a shared transport. Cancels [owner]'s in-flight calls and refuses
     * its later ones; the pool, dispatcher, socket factory and every other owner's calls stay up, so the
     * warm connection survives. No eviction: OkHttp health-checks a pooled connection before reuse.
     */
    internal fun cancelInFlight(owner: Any) {
        val calls = synchronized(lock) {
            cancelledOwners += owner
            active.filterValues { it === owner }.keys.toList()
        }
        calls.forEach { runCatching(it::cancel) }
    }

    private fun isCancelled(owner: Any?): Boolean = owner != null && synchronized(lock) { owner in cancelledOwners }

    internal fun isClosed(): Boolean = synchronized(lock) { closed }

    private fun closeOwnedConnection(connection: Connection) {
        // This transport never shares its pool, so closing a released/acquired connection cannot
        // interrupt another owner. Event callbacks cover the window after close()'s first eviction.
        runCatching { connection.socket().close() }
        runCatching(pool::evictAll)
    }

    private class ResponseTooLargeException : IOException("gateway response too large")

    private companion object {
        const val DEFAULT_READ_TIMEOUT_SECONDS = 20L
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val METHODS_REQUIRING_BODY = setOf("POST", "PUT", "PATCH")
    }
}

/** Test seam for existing deterministic HttpURLConnection fakes. Production never uses it. */
internal class UrlConnectionGatewayHttpTransport(
    private val factory: (URL) -> HttpURLConnection,
) : GatewayHttpTransport {
    private val owner = GatewayHttpConnectionOwner()

    override fun execute(request: GatewayHttpRequest): GatewayHttpResponse {
        val connection = factory(URL(request.url))
        check(owner.register(connection)) { "gateway network owner closed" }
        try {
            GatewayHttpConnectionPolicy.apply(connection)
            connection.instanceFollowRedirects = false
            connection.requestMethod = request.method
            connection.connectTimeout = minOf(request.connectTimeoutMs ?: 10_000L, request.timeoutMs).toInt()
            connection.readTimeout = request.timeoutMs.toInt()
            connection.setRequestProperty("Accept", "application/json")
            request.authorization?.let { connection.setRequestProperty("Authorization", it) }
            request.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            request.jsonBody?.let {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { output -> output.write(it) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val bytes = stream?.use { input ->
                val result = ByteArrayOutputStream()
                val chunk = ByteArray(8 * 1024)
                while (true) {
                    val count = input.read(chunk)
                    if (count < 0) break
                    if (result.size() + count > request.responseLimitBytes) throw IOException("gateway response too large")
                    result.write(chunk, 0, count)
                }
                result.toByteArray()
            } ?: ByteArray(0)
            return GatewayHttpResponse(status, bytes.toString(Charsets.UTF_8))
        } finally {
            connection.disconnect()
            owner.unregister(connection)
        }
    }

    override fun cancelAndEvict() = owner.close()
}
