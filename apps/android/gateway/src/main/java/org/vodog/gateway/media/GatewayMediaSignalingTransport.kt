package org.vodog.gateway.media

import org.vodog.gateway.GatewayDiag
import org.vodog.gateway.GatewayHttpRequest
import org.vodog.gateway.GatewayHttpTransport
import org.vodog.gateway.OwnedGatewayHttpTransport
import okhttp3.HttpUrl.Companion.toHttpUrl

/**
 * S123 决策 9: one process-level pool for media signaling, so `media/options` reuses the TLS connection
 * the incoming-call warm-up opened. Separate from the heartbeat `controlTransport`; never closed (process
 * exit only). Pools are per origin, so a direct/relay flip simply stops reusing the old connection.
 */
object GatewayMediaSignalingTransport {
    val shared: OwnedGatewayHttpTransport by lazy { OwnedGatewayHttpTransport() }

    /** One signaling instance's view: its close (OFF, or connect done) cancels only its own in-flight calls. */
    fun forSignaling(transport: OwnedGatewayHttpTransport = shared): GatewayHttpTransport = object : GatewayHttpTransport {
        override fun execute(request: GatewayHttpRequest) = transport.execute(request.copy(owner = this))
        override fun cancelAndEvict() = transport.cancelInFlight(this)
    }
}

/**
 * S123 决策 9: one GET on the [baseUrl] origin so the next `media/options` skips DNS+TCP+TLS. Only the
 * origin matters to the pool, so it hits `/healthz` (no token needed, control-node nginx logs it off). One attempt,
 * no alternate-endpoint retry, failure ignored; the caller runs it off the heartbeat thread.
 */
internal fun warmMediaSignaling(transport: GatewayHttpTransport, baseUrl: String, callId: String?) {
    val response = runCatching {
        transport.execute(GatewayHttpRequest(
            url = baseUrl.toHttpUrl().newBuilder().encodedPath("/healthz").build().toString(),
            method = "GET",
            timeoutMs = WARMUP_TIMEOUT_MS,
            alternateRetry = false,
            connectTimeoutMs = MEDIA_CONNECT_TIMEOUT_MS,
        ))
    }.getOrNull()
    runCatching {
        GatewayDiag.log("media.warmup", mapOf(
            "reused" to response?.timing?.reused, "tlsMs" to response?.timing?.tlsMs, "ok" to (response != null),
        ), callId = callId)
    }
}

private const val WARMUP_TIMEOUT_MS = 5_000L
