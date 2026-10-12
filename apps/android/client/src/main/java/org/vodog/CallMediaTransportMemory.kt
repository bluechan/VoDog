package org.vodog

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.security.MessageDigest

/**
 * P2 (as Web `learnedTransport`): an automatic UDP→TLS fallback that connected is remembered for this
 * Wi-Fi / Ethernet network ([mediaNetworkSignature]) for [TTL_MS], so the next call there starts on TLS
 * without the UDP relay-gather wait. A UDP start that connects, or a learned TLS start that fails on the
 * relay path, forgets it. A learned TLS start that works does not renew it, so UDP is tried again at least
 * once a day. Explicit TLS requests are untouched.
 */
internal class CallMediaTransportMemory(
    private val store: Store,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    /** Network signature → when TLS was learned (wall clock, survives restarts). Best effort: failures are ignored. */
    interface Store {
        fun read(): Map<String, Long>
        fun write(signature: String, learnedAtMs: Long?)
    }

    fun startTransport(signature: String?, requested: CallMediaTransport): CallMediaTransport =
        if (requested == CallMediaTransport.UDP && learnedTls(signature)) CallMediaTransport.TLS else requested

    fun learnedTls(signature: String?): Boolean {
        val at = signature?.let { runCatching { store.read()[it] }.getOrNull() } ?: return false
        return nowMs() - at in 0 until TTL_MS
    }

    fun rememberTls(signature: String?) {
        signature ?: return
        val now = nowMs()
        runCatching {
            store.read().filterValues { now - it !in 0 until TTL_MS }.keys.forEach { store.write(it, null) }
            store.write(signature, now)
        }
    }

    fun forget(signature: String?) {
        signature ?: return
        runCatching { if (signature in store.read()) store.write(signature, null) }
    }

    companion object {
        const val TTL_MS = 24 * 3_600_000L
    }
}

internal class SharedPreferencesTransportStore(context: Context) : CallMediaTransportMemory.Store {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    override fun read(): Map<String, Long> = prefs.all.mapNotNull { (key, value) -> (value as? Long)?.let { key to it } }.toMap()

    override fun write(signature: String, learnedAtMs: Long?) {
        prefs.edit().apply { if (learnedAtMs == null) remove(signature) else putLong(signature, learnedAtMs) }.apply()
    }

    private companion object {
        const val PREFS = "vodog_media_transport"
    }
}

/**
 * "This network" across reconnects (a `Network` handle changes on every attach): Wi-Fi / Ethernet told apart
 * by DNS servers, default gateways and search domains. Only a digest is kept, never an address. Null = no
 * memory for this call: nothing stable to key on, or cellular. Cellular stays UDP-first on purpose (S73b:
 * China 4G TLS to the relay node is unstable); a carrier-wide key would let one transient UDP miss pin the whole
 * carrier to TLS for a day, while a blocked-UDP policy is a property of a particular Wi-Fi.
 */
internal fun mediaNetworkSignature(
    transport: String,
    dnsServers: List<String>,
    gateways: List<String>,
    domains: String?,
): String? {
    if (transport.substringBefore('+') !in setOf("wifi", "ethernet")) return null
    if (dnsServers.isEmpty() && gateways.isEmpty()) return null
    val identity = "$transport|${dnsServers.sorted()}|${gateways.sorted()}|${domains.orEmpty()}"
    val digest = MessageDigest.getInstance("SHA-256").digest(identity.toByteArray())
    return "$transport:" + digest.take(8).joinToString("") { "%02x".format(it) }
}

/** [mediaNetworkSignature] of the current default network; null on any failure. */
internal fun currentMediaNetworkSignature(context: Context): String? = runCatching {
    val connectivity = context.getSystemService(ConnectivityManager::class.java)
    val network = connectivity.activeNetwork ?: return null
    val caps = connectivity.getNetworkCapabilities(network) ?: return null
    val links = connectivity.getLinkProperties(network)
    val base = when {
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
        else -> return null
    }
    val transport = if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) "$base+vpn" else base
    mediaNetworkSignature(
        transport,
        links?.dnsServers.orEmpty().mapNotNull { it.hostAddress },
        links?.routes.orEmpty().filter { it.isDefaultRoute }.mapNotNull { it.gateway?.hostAddress },
        links?.domains,
    )
}.getOrNull()
