package org.vodog.gateway

import org.vodog.gateway.media.turnUrlHost
import okhttp3.Dns
import java.net.Inet6Address
import java.net.InetAddress
import java.io.InterruptedIOException
import java.net.UnknownHostException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * S118: a router DNS outage must not cost a call its media. System DNS first; on failure the last
 * answer this process saw. VoDog ships no built-in IP table (operator hosts vary), so a host is only
 * covered after one successful lookup. The hostname stays attached to the address, so OkHttp still
 * verifies TLS against it.
 *
 * S118b: when a fallback exists, the system lookup gets [systemWaitMs]; past that the fallback is
 * returned while the lookup finishes in the background and refreshes the cache.
 */
object GatewayDns : Dns {
    /** Test seam only. */
    @Volatile internal var system: (String) -> List<InetAddress> = Dns.SYSTEM::lookup
    private val lastKnownGood = ConcurrentHashMap<String, List<InetAddress>>()
    private val lastDiagAtMs = ConcurrentHashMap<String, Long>()

    /** Test seam only. */
    @Volatile internal var systemWaitMs = 1_500L
    private val inFlight = ConcurrentHashMap<String, CompletableFuture<List<InetAddress>>>()
    // ponytail: unbounded cached pool, but at most one lookup per host in flight, so threads <= hosts
    // with a fallback (a handful). A fixed cap would be needed only if that host set grows.
    private val executor = Executors.newCachedThreadPool { Thread(it, "gateway-dns").apply { isDaemon = true } }

    override fun lookup(hostname: String): List<InetAddress> {
        val (source, fallback) = fallbackFor(hostname)
            // No fallback: wait for the system resolver as long as it takes, exactly as before.
            ?: return system(hostname).also { if (it.isNotEmpty()) lastKnownGood[hostname] = it }
        val mine = CompletableFuture<List<InetAddress>>()
        val future = inFlight.putIfAbsent(hostname, mine) ?: mine.also { started ->
            executor.execute {
                try {
                    started.complete(system(hostname).also { if (it.isNotEmpty()) lastKnownGood[hostname] = it })
                } catch (error: Throwable) {
                    started.completeExceptionally(error)
                } finally {
                    inFlight.remove(hostname, started)
                }
            }
        }
        return try {
            future.get(systemWaitMs, TimeUnit.MILLISECONDS)
        } catch (timeout: TimeoutException) {
            noteFallback(hostname, source, "timeout")
            fallback
        } catch (error: ExecutionException) {
            val cause = error.cause ?: error
            if (cause !is UnknownHostException) throw cause
            noteFallback(hostname, source, "unknown_host")
            fallback
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            throw InterruptedIOException("dns lookup interrupted").apply { initCause(error) }
        }
    }

    private fun fallbackFor(hostname: String): Pair<String, List<InetAddress>>? =
        lastKnownGood[hostname]?.let { "cache" to it }

    // GatewayDiag only enqueues; its flush goes through this Dns again, so one line per host per minute.
    private fun noteFallback(hostname: String, source: String, reason: String) {
        val now = System.currentTimeMillis()
        val last = lastDiagAtMs[hostname]
        if (last != null && now - last < 60_000L) return
        lastDiagAtMs[hostname] = now
        runCatching { GatewayDiag.log("net.dns_fallback", mapOf("host" to hostname, "source" to source, "reason" to reason), level = "warn") }
    }

    internal fun resetForTest() {
        lastKnownGood.clear(); lastDiagAtMs.clear(); inFlight.clear(); system = Dns.SYSTEM::lookup; systemWaitMs = 1_500L
    }
}

/**
 * S118: libwebrtc resolves TURN hosts itself, so a DNS-named TURN URL is pinned to the address
 * [resolve] returns and the name moves to the IceServer hostname (TLS SNI / certificate check).
 * Returns the URL unchanged with no hostname for an IP literal or a failed lookup.
 */
internal fun pinTurnUrl(url: String, resolve: (String) -> InetAddress?): Pair<String, String?> {
    val scheme = url.substringBefore(':')
    val host = turnUrlHost(url) ?: return url to null
    // Already an IP literal: v6 in brackets, or a v4 dotted quad (no letters).
    if (host.startsWith('[') || ':' in host || !host.any(Char::isLetter)) return url to null
    val address = runCatching { resolve(host) }.getOrNull() ?: return url to null
    val literal = address.hostAddress ?: return url to null
    val ip = if (address is Inet6Address) "[$literal]" else literal
    return "$scheme:$ip${url.substring(scheme.length + 1 + host.length)}" to host
}

