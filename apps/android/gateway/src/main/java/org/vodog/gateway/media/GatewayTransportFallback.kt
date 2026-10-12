package org.vodog.gateway.media

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.coroutineContext

/**
 * S24 decision 1. Cellular carriers (observed on China Telecom 5G, 2026-09-12) silently drop the
 * TURN UDP allocation to the media node: the AI leg activates in seconds while the gateway's data
 * channel never opens inside the whole negotiation budget. The same call over TURN TLS (tcp/16802)
 * is unaffected, so one bounded retry on the other transport is worth far more than a longer wait.
 */
internal const val MEDIA_NEGOTIATION_TIMEOUT_MS = 20_000L

/** Budget for an attempt that still has a fallback behind it; the last attempt keeps the full one. */
internal const val MEDIA_FALLBACK_ATTEMPT_TIMEOUT_MS = 8_000L

/**
 * Options' own guard when it runs ahead of an attempt's clock. Options may legitimately spend most of
 * [retryMediaNodePending]'s 12 s polling Control (S97: CAPTURE_NOT_* until the gateway's own snapshot
 * lands; MEDIA_NODE_PENDING until the winner pins a node).
 */
internal const val MEDIA_OPTIONS_TIMEOUT_MS = 12_000L

/** A relay allocation that has produced nothing by here will not produce anything useful later. */
internal const val MEDIA_RELAY_CANDIDATE_DEADLINE_MS = 3_000L

/**
 * S25 decision 9. A relay-only offer is already complete once one relay candidate sits in the local
 * description, but ICE gathering only ends after every TURN allocation on *every* interface has
 * finished or failed. On a Pixel holding Wi-Fi and 5G at once (observed 2026-09-12) the cellular
 * allocation takes 0.9-3.5 s to fail (`ice_candidate_error` 600 / 701) while the relay candidate
 * that actually carries the call arrives in 0.1-0.5 s, so waiting for COMPLETE delayed the offer -
 * and the caller's first AI audio - by whole seconds. This is the short grace window that still lets
 * a second interface's relay candidate join the same offer, not a wait for the whole gathering.
 */
internal const val MEDIA_RELAY_SETTLE_MS = 500L

/**
 * S97 §3: an AI leg on TURN TLS takes the first relay almost at once. Its one-way AI speech gains
 * nothing from a second interface's candidate worth 400 ms of silence after ACTIVE; UDP and human
 * legs keep [MEDIA_RELAY_SETTLE_MS].
 */
internal const val MEDIA_RELAY_SETTLE_AI_TLS_MS = 100L

internal fun mediaRelaySettleMs(answeredByAi: Boolean, transport: IceTransport): Long =
    if (answeredByAi && transport == IceTransport.TLS) MEDIA_RELAY_SETTLE_AI_TLS_MS else MEDIA_RELAY_SETTLE_MS

/** Where one negotiation attempt was when its budget ran out. Bounded, content-free telemetry. */
internal enum class MediaTransportStage { OPTIONS, GATHERING, RELAY_CANDIDATE, OFFER, DATA_CHANNEL }

internal fun MediaTransportStage.timeoutReason(): String =
    if (this == MediaTransportStage.RELAY_CANDIDATE) "no_relay_candidate" else "${name.lowercase()}_timeout"

/**
 * One attempt of the plan. [relayCandidateDeadlineMs] is null on the final attempt: a slow but
 * working relay must never be cut short when there is nothing left to fall back to.
 */
internal data class MediaTransportAttempt(
    val transport: IceTransport,
    val ordinal: Int,
    val budgetMs: Long,
    val relayCandidateDeadlineMs: Long?,
) {
    init {
        require(ordinal >= 1 && budgetMs > 0)
        require(relayCandidateDeadlineMs == null || relayCandidateDeadlineMs in 1 until budgetMs)
    }
}

/** Deliberately not a CancellationException: an exhausted attempt is a retryable fact, not a cancel. */
internal class MediaTransportTimeoutException(
    val transport: IceTransport,
    val stage: MediaTransportStage,
    cause: Throwable? = null,
) : IllegalStateException(
    "media transport ${transport.wireValue} attempt exhausted at ${stage.name.lowercase()}",
    cause,
)

internal fun mediaTransportFallback(transport: IceTransport): IceTransport =
    if (transport == IceTransport.UDP) IceTransport.TLS else IceTransport.UDP

internal fun mediaTransportPlan(
    preferred: IceTransport,
    fallbackEnabled: Boolean,
    attemptBudgetMs: Long = MEDIA_FALLBACK_ATTEMPT_TIMEOUT_MS,
    finalBudgetMs: Long = MEDIA_NEGOTIATION_TIMEOUT_MS,
    relayCandidateDeadlineMs: Long = MEDIA_RELAY_CANDIDATE_DEADLINE_MS,
): List<MediaTransportAttempt> = if (!fallbackEnabled) {
    listOf(MediaTransportAttempt(preferred, 1, finalBudgetMs, null))
} else {
    listOf(
        MediaTransportAttempt(preferred, 1, attemptBudgetMs, relayCandidateDeadlineMs),
        MediaTransportAttempt(mediaTransportFallback(preferred), 2, finalBudgetMs, null),
    )
}

/**
 * S25 decision 9. The instant the offer may be sent, or null while no relay candidate has arrived:
 * a relay-only session has nothing worth offering without one, and the caller of this function is
 * expected to keep waiting (or to report [RelayIceUnavailableException] once gathering has ended
 * without producing a relay). Gathering completing inside the settle window wins over the timer -
 * nothing further can arrive after COMPLETE - and the settle window wins when gathering drags on.
 * Pure and clock-free on purpose: every timestamp is a caller-supplied monotonic reading.
 */
internal fun mediaOfferReadyAtMs(
    firstRelayAtMs: Long?,
    gatheringCompleteAtMs: Long?,
    settleMs: Long = MEDIA_RELAY_SETTLE_MS,
): Long? {
    require(settleMs >= 0) { "a settle window cannot be negative" }
    val relayAt = firstRelayAtMs ?: return null
    val settledAt = relayAt + settleMs
    val completedAt = gatheringCompleteAtMs ?: return settledAt
    // A COMPLETE that predates the relay candidate still cannot release the offer before it exists.
    return minOf(settledAt, maxOf(completedAt, relayAt))
}

/** [mediaOfferReadyAtMs] as the predicate the negotiation reads: may the offer go out at [nowMs]? */
internal fun mediaOfferReady(
    firstRelayAtMs: Long?,
    gatheringCompleteAtMs: Long?,
    nowMs: Long,
    settleMs: Long = MEDIA_RELAY_SETTLE_MS,
): Boolean = mediaOfferReadyAtMs(firstRelayAtMs, gatheringCompleteAtMs, settleMs)?.let { it <= nowMs } == true

/**
 * Only a transport-shaped failure earns the second attempt. An HTTP refusal, a capture-binding
 * conflict or a revoked authorization would fail the same way on the other transport, and Control
 * re-runs `authorizeGatewayMedia`/`ensureCaptureBinding` on every options request. An options timeout
 * is HTTP-shaped too now that options runs ahead of the attempt's clock ([runMediaAttemptClocks]):
 * switching an AI leg from TLS to the lossy UDP path would not make Control answer faster.
 */
internal fun mediaTransportFallbackReason(error: Throwable): String? = when {
    error is MediaTransportTimeoutException && error.stage != MediaTransportStage.OPTIONS -> error.stage.timeoutReason()
    error is RelayIceUnavailableException -> "relay_unavailable"
    else -> null
}

/**
 * One attempt's clocks. With [optionsTimeoutMs] set (an attempt of the S24 fallback plan), options
 * runs first under that guard and [budgetMs] - gathering, offer and data channel - only starts once
 * it returns, so a slow but successful options can no longer spend the ICE budget and trigger a
 * spurious fallback. Without it (a single-transport rejoin or retry, whose budget is a hard window)
 * options stays inside [budgetMs]. A timeout surfaces as [kotlinx.coroutines.TimeoutCancellationException]
 * for the caller to turn into [MediaTransportTimeoutException] at its current stage.
 */
internal suspend fun <O, T> runMediaAttemptClocks(
    budgetMs: Long,
    optionsTimeoutMs: Long?,
    options: suspend () -> O,
    negotiate: suspend (O) -> T,
): T {
    if (optionsTimeoutMs == null) return withTimeout(budgetMs) { negotiate(options()) }
    val granted = withTimeout(optionsTimeoutMs) { options() }
    return withTimeout(budgetMs) { negotiate(granted) }
}

internal suspend fun <T> withMediaTransportFallback(
    plan: List<MediaTransportAttempt>,
    onFallback: (from: IceTransport, to: IceTransport, reason: String) -> Unit,
    attempt: suspend (MediaTransportAttempt) -> T,
): T {
    require(plan.isNotEmpty()) { "at least one transport attempt is required" }
    plan.forEachIndexed { index, current ->
        val next = plan.getOrNull(index + 1)
        try {
            return attempt(current)
        } catch (cancelled: CancellationException) {
            // A hangup, an ON-generation close or a network change owns this coroutine's death.
            throw cancelled
        } catch (error: Throwable) {
            val reason = (next?.let { mediaTransportFallbackReason(error) }) ?: throw error
            // Observability must never decide whether the fallback runs.
            runCatching { onFallback(current.transport, next.transport, reason) }
            coroutineContext.ensureActive()
        }
    }
    error("transport fallback plan produced no outcome")
}

/**
 * Remembers, per network generation, the transport that last opened a data channel. Process scoped
 * on purpose: a generation is minted fresh by [AndroidGatewayProbeGeneration] on every link change,
 * so a restart has nothing worth restoring and a stale preference can only cost one fallback.
 */
internal class MediaTransportMemory(private val capacity: Int = 8) {
    init { require(capacity in 1..64) }

    private val entries = object : LinkedHashMap<String, IceTransport>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, IceTransport>?) = size > capacity
    }

    @Synchronized
    fun preferred(networkGeneration: String?): IceTransport =
        networkGeneration?.let { entries[it] } ?: IceTransport.UDP

    @Synchronized
    fun remember(networkGeneration: String?, transport: IceTransport) {
        if (networkGeneration.isNullOrBlank()) return
        entries[networkGeneration] = transport
    }

    @Synchronized
    fun size(): Int = entries.size

    companion object { val INSTANCE = MediaTransportMemory() }
}

/** S73 D3: leg rejoin bounds. */
internal const val MEDIA_REJOIN_MAX_ATTEMPTS = 3
internal const val MEDIA_REJOIN_WINDOW_MS = 60_000L
/** Bridge still holds the old leg Connected (409, relayed by Control as 503 MEDIA_BRIDGE_UNAVAILABLE). */
internal const val MEDIA_REJOIN_CONFLICT_BACKOFF_MS = 2_000L
/** A fast failure (network still down) waits until this long after its attempt started. */
internal const val MEDIA_REJOIN_ATTEMPT_SPACING_MS = 15_000L
/** ICE DISCONNECTED on an established leg this long = transport lost (pion would wait 25 s). */
internal const val MEDIA_ICE_DISCONNECTED_GRACE_MS = 5_000L

/** S73 D3: attempt 1 retries the failed leg's transport, later attempts switch; relay mode is TLS only. */
internal fun mediaRejoinTransport(attempt: Int, original: IceTransport, relay: Boolean): IceTransport = when {
    relay -> IceTransport.TLS
    attempt >= 2 -> mediaTransportFallback(original)
    else -> original
}

internal enum class MediaRejoinFailure { CONFLICT, RETRY, FATAL, REVOKED }

/** S125 决策 1: Control ended the call (409 MEDIA_REVOKED); decided by the code alone. */
internal fun mediaRevoked(error: Throwable): Boolean = error is GatewayMediaHttpException && error.code == "MEDIA_REVOKED"

/**
 * 409 / 503 MEDIA_BRIDGE_UNAVAILABLE = old leg still up; other 4xx = call gone, stop rejoining.
 * S125 决策 1: MEDIA_REVOKED is REVOKED, which stops like FATAL (the caller's fatal path still hangs up).
 */
internal fun classifyMediaRejoinFailure(error: Throwable): MediaRejoinFailure = when {
    error !is GatewayMediaHttpException -> MediaRejoinFailure.RETRY
    mediaRevoked(error) -> MediaRejoinFailure.REVOKED
    error.status == 409 || (error.status == 503 && error.code == "MEDIA_BRIDGE_UNAVAILABLE") -> MediaRejoinFailure.CONFLICT
    error.status in 400..499 -> MediaRejoinFailure.FATAL
    else -> MediaRejoinFailure.RETRY
}

/**
 * S73b: a failure while the device has no usable network is not the leg's fault. No default network
 * with INTERNET, or DNS/connect refused on an unvalidated one. VALIDATED alone is not required:
 * a working network may never validate (Google's probe is unreachable from China).
 */
internal fun isOfflineRejoinFailure(error: Throwable, hasNetwork: Boolean, validated: Boolean): Boolean =
    !hasNetwork || (!validated && generateSequence(error) { it.cause }.take(8)
        .any { it is java.net.UnknownHostException || it is java.net.ConnectException })

/**
 * S73 D3 loop: up to [MEDIA_REJOIN_MAX_ATTEMPTS] single-transport negotiations inside
 * [MEDIA_REJOIN_WINDOW_MS]. Returns null when the budget is spent or Control refused for good.
 * [onAttempt] gets (attempt, transport, ok, error, this attempt's ms). S73b: an [offline] failure spends no attempt;
 * [awaitNetwork] (budget ms, false = window over) blocks until a network is back, then the same attempt reruns.
 */
internal suspend fun <T> rejoinMediaLeg(
    original: IceTransport,
    relay: Boolean,
    nowMs: () -> Long,
    sleep: suspend (Long) -> Unit,
    onAttempt: (Int, IceTransport, Boolean, Throwable?, Long) -> Unit,
    offline: (Throwable) -> Boolean = { false },
    awaitNetwork: suspend (Long) -> Boolean = { true },
    connect: suspend (IceTransport, Long) -> T,
): T? {
    val startMs = nowMs()
    var attempt = 1
    while (attempt <= MEDIA_REJOIN_MAX_ATTEMPTS) {
        val remaining = MEDIA_REJOIN_WINDOW_MS - (nowMs() - startMs)
        if (remaining <= 0) return null
        val transport = mediaRejoinTransport(attempt, original, relay)
        val attemptStartMs = nowMs()
        try {
            return connect(transport, minOf(remaining, MEDIA_NEGOTIATION_TIMEOUT_MS)).also {
                runCatching { onAttempt(attempt, transport, true, null, nowMs() - attemptStartMs) }
            }
        } catch (error: Throwable) {
            // Only our own cancellation (hangup / teardown) ends the loop; an inner timeout is a failure.
            coroutineContext.ensureActive()
            runCatching { onAttempt(attempt, transport, false, error, nowMs() - attemptStartMs) }
            val kind = classifyMediaRejoinFailure(error)
            if (kind == MediaRejoinFailure.FATAL || kind == MediaRejoinFailure.REVOKED) return null
            val windowLeft = MEDIA_REJOIN_WINDOW_MS - (nowMs() - startMs)
            if (offline(error)) {
                if (windowLeft <= 0 || !awaitNetwork(windowLeft)) return null
                continue
            }
            if (attempt == MEDIA_REJOIN_MAX_ATTEMPTS) return null
            val waitMs = if (kind == MediaRejoinFailure.CONFLICT) MEDIA_REJOIN_CONFLICT_BACKOFF_MS
            else attemptStartMs + MEDIA_REJOIN_ATTEMPT_SPACING_MS - nowMs()
            if (waitMs >= windowLeft) return null
            if (waitMs > 0) sleep(waitMs)
            attempt++
        }
    }
    return null
}

/** Initial-leg retry: the waits before extra attempt 1 and 2 (S73 classification, not its 15 s spacing). */
internal val MEDIA_INITIAL_RETRY_DELAYS_MS = longArrayOf(300L, 800L)
/** Everything after the first failure - waits, offline waits and extra attempts - fits in this. */
internal const val MEDIA_INITIAL_RETRY_BUDGET_MS = 8_000L
/** An extra attempt with less budget than this left is not started. */
internal const val MEDIA_INITIAL_RETRY_MIN_ATTEMPT_MS = 2_000L

/**
 * The initial leg's bounded retry, before a live cellular call is hung up for want of media. The first
 * [connect] (budget null) is the planned negotiation with its own transport fallback. A failure that
 * S73's [classifyMediaRejoinFailure] calls RETRY or CONFLICT then gets at most
 * [MEDIA_INITIAL_RETRY_DELAYS_MS].size single-transport attempts, each given the budget left of
 * [MEDIA_INITIAL_RETRY_BUDGET_MS]; FATAL (4xx other than 409), REVOKED (S125), our own cancellation or [shouldContinue]
 * turning false end it. An [offline] failure waits for the network inside the same budget and spends
 * no attempt. Every extra attempt is a whole new options + offer on a fresh PeerConnection - the bridge
 * replaces a gateway leg that is not Connected and 409s one that is - so an offer whose response was
 * lost is never re-sent as such. The last failure is rethrown unchanged.
 */
internal suspend fun <T> connectInitialMediaLeg(
    nowMs: () -> Long,
    sleep: suspend (Long) -> Unit,
    onRetry: (retry: Int, error: Throwable, offline: Boolean) -> Unit = { _, _, _ -> },
    offline: (Throwable) -> Boolean = { false },
    awaitNetwork: suspend (Long) -> Boolean = { true },
    shouldContinue: () -> Boolean = { true },
    connect: suspend (budgetMs: Long?) -> T,
): T {
    var failure: Throwable = try {
        return connect(null)
    } catch (error: Throwable) {
        // Only our own cancellation (hangup / teardown) ends it here; an inner timeout is a failure.
        coroutineContext.ensureActive()
        error
    }
    val failedAtMs = nowMs()
    var retries = 0
    while (true) {
        if (classifyMediaRejoinFailure(failure).let { it == MediaRejoinFailure.FATAL || it == MediaRejoinFailure.REVOKED } ||
            !shouldContinue()) throw failure
        val leftMs = MEDIA_INITIAL_RETRY_BUDGET_MS - (nowMs() - failedAtMs)
        if (offline(failure)) {
            runCatching { onRetry(retries, failure, true) }
            if (leftMs <= 0 || !awaitNetwork(leftMs)) throw failure
        } else {
            if (retries == MEDIA_INITIAL_RETRY_DELAYS_MS.size) throw failure
            val waitMs = MEDIA_INITIAL_RETRY_DELAYS_MS[retries]
            if (leftMs - waitMs < MEDIA_INITIAL_RETRY_MIN_ATTEMPT_MS) throw failure
            retries++
            runCatching { onRetry(retries, failure, false) }
            sleep(waitMs)
        }
        val budgetMs = MEDIA_INITIAL_RETRY_BUDGET_MS - (nowMs() - failedAtMs)
        if (budgetMs < MEDIA_INITIAL_RETRY_MIN_ATTEMPT_MS || !shouldContinue()) throw failure
        failure = try {
            return connect(budgetMs)
        } catch (error: Throwable) {
            coroutineContext.ensureActive()
            error
        }
    }
}
