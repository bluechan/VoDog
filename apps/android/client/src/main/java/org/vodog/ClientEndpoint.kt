package org.vodog

import java.util.concurrent.ConcurrentHashMap

/**
 * S72b（照搬网关 S71 `GatewayEndpoint`）：在中国的蜂窝网络上 Control 走 relay-node 国内中转，其余直连 control-node。
 * 中转只为国内蜂窝建（S71/S72b 实测联通 4G 直连 control-node 间歇失败）；境外蜂窝走中转只是多绕一跳，所以按
 * [ClientRelayPolicy] 判定「像在中国」才开。[alternateUrl] 让一次网络层失败的幂等请求去另一边再试一次，
 * 成功的那一边按网络记住 [ClientRelayPolicy.LEARNED_TTL_MS]（[learn]）。
 * 中转是可选部署：`-PvodogRelayApiBaseUrl` 未配置（默认空）时 [relay] 恒为 false、不换端点重试。
 */
object ClientEndpoint {
    private data class DefaultNetwork(val transport: String, val key: String?, val chinaCellular: Boolean)
    private data class Learned(val relay: Boolean, val untilMs: Long)

    @Volatile private var network = DefaultNetwork("none", null, false)
    private val learned = ConcurrentHashMap<String, Learned>()
    @Volatile private var testRelay: Boolean? = null
    /** Optional relay origin; blank disables the relay entirely. Tests override it. */
    @Volatile internal var relayBaseUrl: String = BuildConfig.RELAY_API_BASE_URL
    /** Last value reported in `api.relay`, so the diag only records flips. */
    @Volatile private var reported = false

    val relay: Boolean
        get() = testRelay ?: (relayBaseUrl.isNotBlank() && network.let { current ->
            ClientRelayPolicy.relay(current.transport, current.chinaCellular, learnedFor(current.key, monotonicMs()))
        })

    fun baseUrl(): String = if (relay) relayBaseUrl else BuildConfig.API_BASE_URL

    /**
     * 默认网络回调里调（`onCapabilitiesChanged` 一秒几次）。[chinaCellular] 只在换网后的蜂窝上读一次。
     * 只在模式翻转时记 `api.relay`。
     */
    fun onDefaultNetwork(transport: String, key: String? = null, chinaCellular: () -> Boolean = { false }) {
        val current = network
        if (current.transport != transport || current.key != key) {
            network = DefaultNetwork(transport, key, transport == "cellular" && runCatching(chinaCellular).getOrDefault(false))
        }
        reportFlip(if (network.chinaCellular) "china_cellular" else "network")
    }

    /**
     * The other base answered after this one failed at the network layer ([UrlConnectionClientTransport]
     * retry): use it first on this network for [ClientRelayPolicy.LEARNED_TTL_MS]. Covers a China network
     * the MCC rule missed (direct failing → relay) and the reverse.
     */
    fun learn(workingRelay: Boolean, nowMs: Long = monotonicMs()) {
        val key = network.key ?: return
        learned.entries.removeIf { it.value.untilMs <= nowMs }
        learned[key] = Learned(workingRelay, nowMs + ClientRelayPolicy.LEARNED_TTL_MS)
        reportFlip("learned")
    }

    private fun learnedFor(key: String?, nowMs: Long): Boolean? =
        key?.let(learned::get)?.takeIf { it.untilMs > nowMs }?.relay

    private fun reportFlip(reason: String) {
        val next = relay
        if (next == reported) return
        reported = next
        runCatching {
            ClientDiag.log("api.relay", mapOf("on" to next, "network" to network.transport, "reason" to reason))
        }
    }

    /** 同一请求换到另一个 Control 基址；不是我们的 URL（或两基址相同，S33）时为 null。 */
    fun alternateUrl(url: String): String? = alternateUrl(url, BuildConfig.API_BASE_URL, relayBaseUrl)

    internal fun alternateUrl(url: String, direct: String, relayBase: String): String? = when {
        relayBase.isBlank() || direct == relayBase -> null
        url.startsWith(direct) -> relayBase + url.removePrefix(direct)
        url.startsWith(relayBase) -> direct + url.removePrefix(relayBase)
        else -> null
    }

    internal fun setRelayForTest(value: Boolean?) { testRelay = value }

    internal fun resetForTest() {
        testRelay = null
        relayBaseUrl = BuildConfig.RELAY_API_BASE_URL
        network = DefaultNetwork("none", null, false)
        learned.clear()
        reported = false
    }

    private fun monotonicMs(): Long = System.nanoTime() / 1_000_000
}

/**
 * When the API (and the media-options `relay` flag) goes through the relay node. It exists for China
 * cellular (S71/S72b); abroad it only adds an unnecessary relay hop, so cellular alone is not enough.
 */
internal object ClientRelayPolicy {
    const val CHINA_MCC = "460"
    /** How long an endpoint that answered after the other failed stays first on that network. */
    const val LEARNED_TTL_MS = 10 * 60_000L
    private val CHINA_TIME_ZONES = setOf(
        "Asia/Shanghai", "Asia/Chongqing", "Asia/Chungking", "Asia/Harbin", "Asia/Urumqi", "Asia/Kashgar", "PRC",
    )

    /** MCC of an operator numeric (`MCC`+`MNC`, 5–6 digits), else null. */
    fun mcc(operatorNumeric: String?): String? =
        operatorNumeric?.trim()?.takeIf { it.length in 5..6 && it.all(Char::isDigit) }?.take(3)

    /**
     * Whether a cellular default network is China-based. The data SIM's MCC decides first: roaming data is
     * home-routed, so a China SIM abroad still leaves through China (relay helps) and a foreign SIM in China
     * leaves abroad (direct is right). Then the registered network's MCC; with neither, the time zone.
     */
    fun chinaCellular(simOperator: String?, networkOperator: String?, timeZoneId: String?): Boolean {
        val mcc = mcc(simOperator) ?: mcc(networkOperator)
        return if (mcc != null) mcc == CHINA_MCC else timeZoneId in CHINA_TIME_ZONES
    }

    /** [learned] (a measured failover on this network) wins; otherwise relay only on China cellular. */
    fun relay(transport: String, chinaCellular: Boolean, learned: Boolean?): Boolean =
        learned ?: (transport == "cellular" && chinaCellular)
}

/** 只有 GET / DELETE 或带 Idempotency-Key 的请求可以换端点重发。 */
internal fun ClientRequest.retriesOnAlternate(): Boolean =
    method == "GET" || method == "DELETE" || idempotencyKey != null
