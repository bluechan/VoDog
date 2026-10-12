package org.vodog.gateway.media

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayTransportFallbackTest {

    private class RecordedFallback(val from: IceTransport, val to: IceTransport, val reason: String)

    private fun recorder(into: MutableList<RecordedFallback>): (IceTransport, IceTransport, String) -> Unit =
        { from, to, reason -> into += RecordedFallback(from, to, reason) }

    @Test fun `udp plan falls back to tls with a bounded first attempt`() {
        val plan = mediaTransportPlan(IceTransport.UDP, fallbackEnabled = true)
        assertEquals(listOf(IceTransport.UDP, IceTransport.TLS), plan.map { it.transport })
        assertEquals(listOf(1, 2), plan.map { it.ordinal })
        assertEquals(MEDIA_FALLBACK_ATTEMPT_TIMEOUT_MS, plan[0].budgetMs)
        assertEquals(MEDIA_RELAY_CANDIDATE_DEADLINE_MS, plan[0].relayCandidateDeadlineMs)
        // The last attempt keeps the whole historic budget and no early relay deadline.
        assertEquals(MEDIA_NEGOTIATION_TIMEOUT_MS, plan[1].budgetMs)
        assertNull(plan[1].relayCandidateDeadlineMs)
    }

    @Test fun `a remembered tls transport starts on tls and keeps udp as the fallback`() {
        val plan = mediaTransportPlan(IceTransport.TLS, fallbackEnabled = true)
        assertEquals(listOf(IceTransport.TLS, IceTransport.UDP), plan.map { it.transport })
    }

    @Test fun `without relay enforcement there is a single unbounded-relay attempt`() {
        val plan = mediaTransportPlan(IceTransport.UDP, fallbackEnabled = false)
        assertEquals(1, plan.size)
        assertEquals(MEDIA_NEGOTIATION_TIMEOUT_MS, plan.single().budgetMs)
        assertNull(plan.single().relayCandidateDeadlineMs)
    }

    @Test fun `no relay candidate within the deadline falls back to tls`() = runBlocking {
        val fallbacks = mutableListOf<RecordedFallback>()
        val attempted = mutableListOf<IceTransport>()
        val opened = withMediaTransportFallback(
            mediaTransportPlan(IceTransport.UDP, fallbackEnabled = true),
            recorder(fallbacks),
        ) { attempt ->
            attempted += attempt.transport
            if (attempt.transport == IceTransport.UDP) {
                throw MediaTransportTimeoutException(attempt.transport, MediaTransportStage.RELAY_CANDIDATE)
            }
            attempt
        }
        assertEquals(listOf(IceTransport.UDP, IceTransport.TLS), attempted)
        assertEquals(IceTransport.TLS, opened.transport)
        assertEquals(2, opened.ordinal)
        val fallback = fallbacks.single()
        assertEquals(IceTransport.UDP, fallback.from)
        assertEquals(IceTransport.TLS, fallback.to)
        assertEquals("no_relay_candidate", fallback.reason)
    }

    @Test fun `a data channel that never opens inside the budget falls back to tls`() = runBlocking {
        val fallbacks = mutableListOf<RecordedFallback>()
        val opened = withMediaTransportFallback(
            mediaTransportPlan(IceTransport.UDP, fallbackEnabled = true),
            recorder(fallbacks),
        ) { attempt ->
            if (attempt.ordinal == 1) {
                throw MediaTransportTimeoutException(attempt.transport, MediaTransportStage.DATA_CHANNEL)
            }
            attempt
        }
        assertEquals(IceTransport.TLS, opened.transport)
        assertEquals("data_channel_timeout", fallbacks.single().reason)
    }

    @Test fun `an exhausted attempt budget is reported with the stage it stalled in`() = runBlocking {
        val fallbacks = mutableListOf<RecordedFallback>()
        // Real suspension, ms-scale: the attempt outlives its own budget exactly as a stalled
        // negotiation does, and the conversion to a retryable failure happens where production does it.
        val opened = withMediaTransportFallback(
            mediaTransportPlan(IceTransport.UDP, fallbackEnabled = true, attemptBudgetMs = 40, relayCandidateDeadlineMs = 20),
            recorder(fallbacks),
        ) { attempt ->
            try {
                withTimeout(attempt.budgetMs) {
                    if (attempt.ordinal == 1) delay(10_000)
                    attempt
                }
            } catch (timeout: TimeoutCancellationException) {
                throw MediaTransportTimeoutException(attempt.transport, MediaTransportStage.DATA_CHANNEL, timeout)
            }
        }
        assertEquals(IceTransport.TLS, opened.transport)
        assertEquals("data_channel_timeout", fallbacks.single().reason)
    }

    @Test fun `a missing relay after gathering falls back before it is reported`() = runBlocking {
        val fallbacks = mutableListOf<RecordedFallback>()
        val opened = withMediaTransportFallback(
            mediaTransportPlan(IceTransport.UDP, fallbackEnabled = true),
            recorder(fallbacks),
        ) { attempt ->
            if (attempt.ordinal == 1) throw RelayIceUnavailableException(attempt.transport, null)
            attempt
        }
        assertEquals(IceTransport.TLS, opened.transport)
        assertEquals("relay_unavailable", fallbacks.single().reason)
    }

    @Test fun `both transports failing rethrows the last failure`() {
        val fallbacks = mutableListOf<RecordedFallback>()
        val tlsFailure = MediaTransportTimeoutException(IceTransport.TLS, MediaTransportStage.DATA_CHANNEL)
        val thrown = assertThrows(MediaTransportTimeoutException::class.java) {
            runBlocking {
                withMediaTransportFallback(
                    mediaTransportPlan(IceTransport.UDP, fallbackEnabled = true),
                    recorder(fallbacks),
                ) { attempt ->
                    if (attempt.ordinal == 1) {
                        throw MediaTransportTimeoutException(attempt.transport, MediaTransportStage.RELAY_CANDIDATE)
                    }
                    throw tlsFailure
                }
            }
        }
        assertSame(tlsFailure, thrown)
        assertEquals(1, fallbacks.size)
    }

    @Test fun `a refusal that both transports share is never retried`() {
        val fallbacks = mutableListOf<RecordedFallback>()
        var attempts = 0
        assertThrows(GatewayMediaHttpException::class.java) {
            runBlocking {
                withMediaTransportFallback(
                    mediaTransportPlan(IceTransport.UDP, fallbackEnabled = true),
                    recorder(fallbacks),
                ) {
                    attempts += 1
                    throw GatewayMediaHttpException(409, "CAPTURE_BINDING_CONFLICT", "different capture")
                }
            }
        }
        assertEquals(1, attempts)
        assertTrue(fallbacks.isEmpty())
    }

    @Test fun `a hangup during the first attempt is never retried on the other transport`() {
        val fallbacks = mutableListOf<RecordedFallback>()
        var attempts = 0
        assertThrows(CancellationException::class.java) {
            runBlocking {
                withMediaTransportFallback(
                    mediaTransportPlan(IceTransport.UDP, fallbackEnabled = true),
                    recorder(fallbacks),
                ) {
                    attempts += 1
                    throw CancellationException("call ended")
                }
            }
        }
        assertEquals(1, attempts)
        assertTrue(fallbacks.isEmpty())
    }

    @Test fun `a single-attempt plan reports its own failure unchanged`() {
        val failure = RelayIceUnavailableException(IceTransport.UDP, null)
        val thrown = assertThrows(RelayIceUnavailableException::class.java) {
            runBlocking {
                withMediaTransportFallback(
                    mediaTransportPlan(IceTransport.UDP, fallbackEnabled = false),
                    { _, _, _ -> throw AssertionError("no fallback exists") },
                ) { throw failure }
            }
        }
        assertSame(failure, thrown)
    }

    @Test fun `timeout reasons stay bounded and stage-specific`() {
        assertEquals("options_timeout", MediaTransportStage.OPTIONS.timeoutReason())
        assertEquals("gathering_timeout", MediaTransportStage.GATHERING.timeoutReason())
        assertEquals("no_relay_candidate", MediaTransportStage.RELAY_CANDIDATE.timeoutReason())
        assertEquals("offer_timeout", MediaTransportStage.OFFER.timeoutReason())
        assertEquals("data_channel_timeout", MediaTransportStage.DATA_CHANNEL.timeoutReason())
        assertNull(mediaTransportFallbackReason(IllegalStateException("relay ICE is required")))
        assertEquals(IceTransport.TLS, mediaTransportFallback(IceTransport.UDP))
        assertEquals(IceTransport.UDP, mediaTransportFallback(IceTransport.TLS))
    }

    @Test fun `an exhausted attempt never looks like a cancellation to the caller`() {
        val failure = MediaTransportTimeoutException(IceTransport.UDP, MediaTransportStage.DATA_CHANNEL)
        assertTrue(failure !is CancellationException)
        assertTrue("udp" in failure.message.orEmpty() && "data_channel" in failure.message.orEmpty())
    }

    @Test fun `the transport that opened the channel is preferred for the next call on that network`() {
        val memory = MediaTransportMemory()
        assertEquals(IceTransport.UDP, memory.preferred("generation-5g"))
        memory.remember("generation-5g", IceTransport.TLS)
        assertEquals(IceTransport.TLS, memory.preferred("generation-5g"))
        // A different network generation never inherits another one's transport.
        assertEquals(IceTransport.UDP, memory.preferred("generation-wifi"))
        assertEquals(IceTransport.UDP, memory.preferred(null))
        assertEquals(
            listOf(IceTransport.TLS, IceTransport.UDP),
            mediaTransportPlan(memory.preferred("generation-5g"), fallbackEnabled = true).map { it.transport },
        )
    }

    @Test fun `a transport memory without a usable generation key stays empty`() {
        val memory = MediaTransportMemory()
        memory.remember(null, IceTransport.TLS)
        memory.remember("  ", IceTransport.TLS)
        assertEquals(0, memory.size())
    }

    @Test fun `the transport memory is bounded so churning generations cannot grow it`() {
        val memory = MediaTransportMemory(capacity = 2)
        memory.remember("a", IceTransport.TLS)
        memory.remember("b", IceTransport.TLS)
        memory.remember("c", IceTransport.TLS)
        assertEquals(2, memory.size())
        assertEquals(IceTransport.UDP, memory.preferred("a"))
        assertEquals(IceTransport.TLS, memory.preferred("c"))
    }

    @Test fun `a relay deadline must stay inside its own attempt budget`() {
        assertThrows(IllegalArgumentException::class.java) {
            MediaTransportAttempt(IceTransport.UDP, 1, 3_000, 3_000)
        }
        assertThrows(IllegalArgumentException::class.java) {
            MediaTransportAttempt(IceTransport.UDP, 0, 3_000, null)
        }
    }

    // S25 decision 9: when the offer may leave. The real negotiation reads the same two functions,
    // so these cases pin the production rule and not a restatement of it.

    @Test fun `a relay candidate releases the offer once the settle window closes`() {
        // Gathering is still running - the cellular interface is busy failing its TURN allocation.
        assertEquals(600L, mediaOfferReadyAtMs(firstRelayAtMs = 100, gatheringCompleteAtMs = null))
        assertTrue(mediaOfferReady(100, null, nowMs = 600))
        assertTrue(mediaOfferReady(100, null, nowMs = 3_500))
    }

    @Test fun `a relay candidate alone does not release the offer before the window closes`() {
        // The case that proves the 500 ms window exists instead of firing on the first relay.
        assertFalse(mediaOfferReady(100, null, nowMs = 100))
        assertFalse(mediaOfferReady(100, null, nowMs = 599))
        assertFalse(mediaOfferReady(100, null, nowMs = 300, settleMs = MEDIA_RELAY_SETTLE_MS))
    }

    @Test fun `gathering completing inside the window releases the offer at once`() {
        // Nothing can arrive after COMPLETE, so the rest of the window is pure delay.
        assertEquals(300L, mediaOfferReadyAtMs(firstRelayAtMs = 100, gatheringCompleteAtMs = 300))
        assertTrue(mediaOfferReady(100, 300, nowMs = 300))
        assertFalse(mediaOfferReady(100, 300, nowMs = 299))
        // A COMPLETE that somehow predates the relay candidate still cannot release it earlier.
        assertEquals(100L, mediaOfferReadyAtMs(firstRelayAtMs = 100, gatheringCompleteAtMs = 40))
    }

    @Test fun `without a relay candidate the offer is never ready`() {
        // Relay-only: gathering that ended empty is reported as RelayIceUnavailableException by the
        // caller, never sent as an offer, so this rule has no "ready" answer to give.
        assertNull(mediaOfferReadyAtMs(firstRelayAtMs = null, gatheringCompleteAtMs = null))
        assertNull(mediaOfferReadyAtMs(firstRelayAtMs = null, gatheringCompleteAtMs = 3_500))
        assertFalse(mediaOfferReady(null, null, nowMs = 9_999))
        assertFalse(mediaOfferReady(null, 3_500, nowMs = 9_999))
    }

    @Test fun `the settle window stays well inside the relay deadline it follows`() {
        assertEquals(500L, MEDIA_RELAY_SETTLE_MS)
        assertTrue(MEDIA_RELAY_SETTLE_MS < MEDIA_RELAY_CANDIDATE_DEADLINE_MS)
        // A zero window is legal (it degenerates to "send on the first relay"); a negative one is not.
        assertEquals(100L, mediaOfferReadyAtMs(100, null, settleMs = 0))
        assertThrows(IllegalArgumentException::class.java) { mediaOfferReadyAtMs(100, null, settleMs = -1) }
    }

    @Test fun `S97 only an AI leg on TLS takes the short settle window`() {
        assertEquals(100L, mediaRelaySettleMs(answeredByAi = true, transport = IceTransport.TLS))
        assertEquals(MEDIA_RELAY_SETTLE_MS, mediaRelaySettleMs(answeredByAi = true, transport = IceTransport.UDP))
        assertEquals(MEDIA_RELAY_SETTLE_MS, mediaRelaySettleMs(answeredByAi = false, transport = IceTransport.TLS))
        assertEquals(MEDIA_RELAY_SETTLE_MS, mediaRelaySettleMs(answeredByAi = false, transport = IceTransport.UDP))
        assertEquals(200L, mediaOfferReadyAtMs(100, null, settleMs = MEDIA_RELAY_SETTLE_AI_TLS_MS))
    }

    // Options runs ahead of a fallback-plan attempt's clock (S97 follow-up), on real ms-scale suspension.

    @Test fun `slow options does not consume the ICE budget of a fallback-plan attempt`() = runBlocking {
        val fallbacks = mutableListOf<RecordedFallback>()
        val plan = mediaTransportPlan(IceTransport.TLS, fallbackEnabled = true, attemptBudgetMs = 60, relayCandidateDeadlineMs = 20)
        val opened = withMediaTransportFallback(plan, recorder(fallbacks)) { attempt ->
            try {
                runMediaAttemptClocks(attempt.budgetMs, optionsTimeoutMs = 1_000, options = { delay(150); "grant" }) { grant ->
                    delay(30)
                    attempt to grant
                }
            } catch (timeout: TimeoutCancellationException) {
                throw MediaTransportTimeoutException(attempt.transport, MediaTransportStage.GATHERING, timeout)
            }
        }
        // Options alone outlasts the whole 60 ms budget, yet the preferred transport opens the leg.
        assertEquals(IceTransport.TLS, opened.first.transport)
        assertEquals("grant", opened.second)
        assertTrue(fallbacks.isEmpty())
    }

    @Test fun `without an options guard the same slow options still spends the hard budget`() {
        // A rejoin / retry attempt keeps options inside its window: its budget is the whole window left.
        assertThrows(TimeoutCancellationException::class.java) {
            runBlocking {
                runMediaAttemptClocks(60, optionsTimeoutMs = null, options = { delay(150); "grant" }) { it }
            }
        }
        // And the guard bounds options on its own.
        assertThrows(TimeoutCancellationException::class.java) {
            runBlocking {
                runMediaAttemptClocks(10_000, optionsTimeoutMs = 40, options = { delay(1_000); "grant" }) { it }
            }
        }
        assertEquals(12_000L, MEDIA_OPTIONS_TIMEOUT_MS)
    }

    @Test fun `an options timeout is HTTP-shaped and never switches the transport`() {
        val fallbacks = mutableListOf<RecordedFallback>()
        assertNull(mediaTransportFallbackReason(MediaTransportTimeoutException(IceTransport.TLS, MediaTransportStage.OPTIONS)))
        val failure = MediaTransportTimeoutException(IceTransport.TLS, MediaTransportStage.OPTIONS)
        var attempts = 0
        val thrown = assertThrows(MediaTransportTimeoutException::class.java) {
            runBlocking {
                withMediaTransportFallback(mediaTransportPlan(IceTransport.TLS, fallbackEnabled = true), recorder(fallbacks)) {
                    attempts += 1
                    throw failure
                }
            }
        }
        assertSame(failure, thrown)
        assertEquals(1, attempts)
        assertTrue(fallbacks.isEmpty())
        // Every later stage still earns the fallback exactly as before.
        assertEquals("gathering_timeout",
            mediaTransportFallbackReason(MediaTransportTimeoutException(IceTransport.TLS, MediaTransportStage.GATHERING)))
    }

    // Initial-leg bounded retry, on a fake clock: each connect costs 100 ms unless the case says otherwise.
    private class InitialRun(val clock: FakeClock = FakeClock()) {
        val budgets = mutableListOf<Long?>()
        val retries = mutableListOf<Pair<Int, Boolean>>()
        var networkWaits = 0
    }

    private fun initial(
        run: InitialRun,
        offline: (Throwable) -> Boolean = { false },
        shouldContinue: () -> Boolean = { true },
        outcome: (call: Int, budgetMs: Long?) -> String,
    ): String = runBlocking {
        connectInitialMediaLeg(
            nowMs = { run.clock.ms },
            sleep = { run.clock.sleeps += it; run.clock.ms += it },
            onRetry = { retry, _, isOffline -> run.retries += retry to isOffline },
            offline = offline,
            awaitNetwork = { run.networkWaits++; run.clock.ms += 500; true },
            shouldContinue = shouldContinue,
        ) { budgetMs ->
            run.budgets += budgetMs
            run.clock.ms += 100
            outcome(run.budgets.size, budgetMs)
        }
    }

    @Test fun `a lost options or offer response is retried once on a fresh leg`() {
        val run = InitialRun()
        val leg = initial(run) { call, _ -> if (call == 1) throw java.io.IOException("connection reset") else "leg" }
        assertEquals("leg", leg)
        // The first attempt is the planned negotiation (no budget); the retry gets what is left of 8 s.
        assertEquals(listOf(null, MEDIA_INITIAL_RETRY_BUDGET_MS - 300), run.budgets)
        assertEquals(listOf(300L), run.clock.sleeps)
        assertEquals(listOf(1 to false), run.retries)
    }

    @Test fun `a bridge conflict backs off 300 then 800 ms and stops after two extra attempts`() {
        val run = InitialRun()
        val conflict = GatewayMediaHttpException(503, "MEDIA_BRIDGE_UNAVAILABLE", "bridge said 409")
        val thrown = assertThrows(GatewayMediaHttpException::class.java) {
            initial(run) { _, _ -> throw conflict }
        }
        assertSame(conflict, thrown)
        assertEquals(3, run.budgets.size)
        assertEquals(listOf(300L, 800L), run.clock.sleeps)
        val succeeded = InitialRun()
        assertEquals("leg", initial(succeeded) { call, _ -> if (call < 3) throw conflict else "leg" })
        assertEquals(listOf(300L, 800L), succeeded.clock.sleeps)
    }

    @Test fun `a refusal other than 409 ends the setup at once`() {
        val run = InitialRun()
        assertThrows(GatewayMediaHttpException::class.java) {
            initial(run) { _, _ -> throw GatewayMediaHttpException(403, "MEDIA_REVOKED", "revoked") }
        }
        assertEquals(1, run.budgets.size)
        assertTrue(run.clock.sleeps.isEmpty())
        assertTrue(run.retries.isEmpty())
    }

    @Test fun `media revoked ends the initial setup at once`() {
        val run = InitialRun()
        assertThrows(GatewayMediaHttpException::class.java) {
            initial(run) { _, _ -> throw GatewayMediaHttpException(409, "MEDIA_REVOKED", "revoked") }
        }
        assertEquals(1, run.budgets.size)
        assertTrue(run.clock.sleeps.isEmpty())
        assertTrue(run.retries.isEmpty())
    }

    @Test fun `an offline failure waits for the network and spends no attempt`() {
        val run = InitialRun()
        val leg = initial(run, offline = { it is java.net.UnknownHostException }) { call, _ ->
            when (call) {
                1 -> throw java.net.UnknownHostException("no network")
                2, 3 -> throw java.io.IOException("reset")
                else -> "leg"
            }
        }
        // Both extra attempts are still available after the offline wait.
        assertEquals("leg", leg)
        assertEquals(1, run.networkWaits)
        assertEquals(4, run.budgets.size)
        assertEquals(listOf(300L, 800L), run.clock.sleeps)
        assertEquals(listOf(0 to true, 1 to false, 2 to false), run.retries)
    }

    @Test fun `extra attempts never run past the 8 s budget`() {
        val run = InitialRun()
        assertThrows(MediaTransportTimeoutException::class.java) {
            initial(run) { _, budget ->
                if (budget != null) run.clock.ms += budget
                throw MediaTransportTimeoutException(IceTransport.UDP, MediaTransportStage.DATA_CHANNEL)
            }
        }
        // The single retry spent its whole budget; no third attempt starts with less than the minimum.
        assertEquals(2, run.budgets.size)
        val firstFailureAt = 100L
        assertTrue(run.clock.ms - firstFailureAt <= MEDIA_INITIAL_RETRY_BUDGET_MS + 100)
    }

    @Test fun `a setup whose call is gone stops retrying`() {
        val run = InitialRun()
        var live = true
        assertThrows(java.io.IOException::class.java) {
            initial(run, shouldContinue = { live }) { _, _ -> live = false; throw java.io.IOException("reset") }
        }
        assertEquals(1, run.budgets.size)
    }

    @Test fun `our own cancellation ends the initial retry without another attempt`() {
        var attempts = 0
        runBlocking {
            val job = launch {
                connectInitialMediaLeg<String>({ 0L }, { delay(it) }) { attempts++; throw java.io.IOException("reset") }
            }
            delay(100) // inside the 300 ms backoff after the first failure
            job.cancel(); job.join()
            assertTrue(job.isCancelled)
        }
        assertEquals(1, attempts)
    }

    // S73 D3 rejoin policy, on a fake clock.
    private class FakeClock { var ms = 0L; val sleeps = mutableListOf<Long>() }
    private fun rejoin(clock: FakeClock, relay: Boolean = false, original: IceTransport = IceTransport.UDP,
        attempts: MutableList<Pair<Int, IceTransport>> = mutableListOf(),
        connect: suspend (IceTransport, Long) -> String): String? = runBlocking {
        rejoinMediaLeg(original, relay, { clock.ms }, { clock.sleeps += it; clock.ms += it },
            { attempt, used, _, _, _ -> attempts += attempt to used }, connect = connect)
    }

    // S73b: offline failures wait for the network instead of spending attempts.
    private fun rejoinOffline(clock: FakeClock, offlineUntilMs: Long, attempts: MutableList<Pair<Int, IceTransport>>,
        waits: MutableList<Long> = mutableListOf(), connect: suspend (IceTransport, Long) -> String): String? = runBlocking {
        rejoinMediaLeg(IceTransport.UDP, false, { clock.ms }, { clock.sleeps += it; clock.ms += it },
            { attempt, used, _, _, _ -> attempts += attempt to used },
            offline = { clock.ms < offlineUntilMs },
            awaitNetwork = { budget -> waits += clock.ms; val back = offlineUntilMs <= clock.ms + budget
                clock.ms = if (back) maxOf(clock.ms + 500, offlineUntilMs) else clock.ms + budget; back },
            connect = connect)
    }

    @Test fun `offline failures spend no attempt and retry as soon as the network is back`() {
        val clock = FakeClock(); val attempts = mutableListOf<Pair<Int, IceTransport>>()
        val result = rejoinOffline(clock, offlineUntilMs = 40_000, attempts) { used, _ ->
            clock.ms += 50; if (clock.ms < 40_000) throw java.net.UnknownHostException("no network") else "leg-${used.wireValue}"
        }
        assertEquals("leg-udp", result) // still attempt 1: the original transport
        assertEquals(listOf(1 to IceTransport.UDP, 1 to IceTransport.UDP), attempts)
        assertTrue(clock.sleeps.isEmpty())
        assertEquals(40_050L, clock.ms)
    }

    @Test fun `offline for the whole window gives up at 60 s not after 3 attempts`() {
        val clock = FakeClock(); val attempts = mutableListOf<Pair<Int, IceTransport>>()
        assertNull(rejoinOffline(clock, offlineUntilMs = Long.MAX_VALUE, attempts) { _, _ ->
            clock.ms += 50; throw java.net.UnknownHostException("no network")
        })
        assertEquals(1, attempts.size)
        assertTrue(clock.ms <= MEDIA_REJOIN_WINDOW_MS)
    }

    @Test fun `a failure with the network up still counts and keeps the 15 s spacing`() {
        val clock = FakeClock(); val attempts = mutableListOf<Pair<Int, IceTransport>>()
        val result = rejoinOffline(clock, offlineUntilMs = 10_000, attempts) { used, _ ->
            clock.ms += 100
            if (attempts.size < 2) error("down") else "leg-${used.wireValue}"
        }
        // Offline at t=0 (free), network back at 10 s: attempt 1 fails for real, 15 s later attempt 2.
        assertEquals("leg-tls", result)
        assertEquals(listOf(1 to IceTransport.UDP, 1 to IceTransport.UDP, 2 to IceTransport.TLS), attempts)
        assertEquals(listOf(14_900L), clock.sleeps)
    }

    @Test fun `offline classification needs no network or an unvalidated dns or connect failure`() {
        val dns = java.io.IOException("wrapped", java.net.UnknownHostException("x"))
        val refused = java.net.ConnectException("refused")
        val timeout = MediaTransportTimeoutException(IceTransport.UDP, MediaTransportStage.DATA_CHANNEL)
        assertTrue(isOfflineRejoinFailure(timeout, hasNetwork = false, validated = false))
        assertTrue(isOfflineRejoinFailure(dns, hasNetwork = true, validated = false))
        assertTrue(isOfflineRejoinFailure(refused, hasNetwork = true, validated = false))
        assertFalse(isOfflineRejoinFailure(dns, hasNetwork = true, validated = true))
        assertFalse(isOfflineRejoinFailure(timeout, hasNetwork = true, validated = false))
    }

    @Test fun `rejoin switches transport from attempt 2 and relay stays tls`() {
        assertEquals(listOf(IceTransport.UDP, IceTransport.TLS, IceTransport.TLS),
            (1..3).map { mediaRejoinTransport(it, IceTransport.UDP, relay = false) })
        assertEquals(listOf(IceTransport.TLS, IceTransport.UDP, IceTransport.UDP),
            (1..3).map { mediaRejoinTransport(it, IceTransport.TLS, relay = false) })
        assertTrue((1..3).all { mediaRejoinTransport(it, IceTransport.UDP, relay = true) == IceTransport.TLS })
    }

    @Test fun `fast failures are spaced 15 s apart and give up after 3 attempts`() {
        val clock = FakeClock(); val attempts = mutableListOf<Pair<Int, IceTransport>>()
        val result = rejoin(clock, attempts = attempts) { _, _ -> clock.ms += 100; error("network down") }
        assertNull(result)
        assertEquals(listOf(1 to IceTransport.UDP, 2 to IceTransport.TLS, 3 to IceTransport.TLS), attempts)
        assertEquals(listOf(14_900L, 14_900L), clock.sleeps)
    }

    @Test fun `conflict backs off 2 s and counts as an attempt`() {
        val clock = FakeClock(); var calls = 0; val budgets = mutableListOf<Long>()
        val result = rejoin(clock) { used, budget ->
            calls++; budgets += budget; clock.ms += 50
            when (calls) {
                1 -> throw GatewayMediaHttpException(409, "MEDIA_LEG_CONNECTED", "old leg")
                2 -> throw GatewayMediaHttpException(503, "MEDIA_BRIDGE_UNAVAILABLE", "bridge said 409")
                else -> "leg-${used.wireValue}"
            }
        }
        assertEquals("leg-tls", result)
        assertEquals(listOf(2_000L, 2_000L), clock.sleeps)
        assertEquals(MEDIA_NEGOTIATION_TIMEOUT_MS, budgets.first())
    }

    @Test fun `media revoked stops rejoining at once`() {
        // S125 决策 1: the real refusal is 409 MEDIA_REVOKED, which must not back off like a conflict.
        val clock = FakeClock(); var calls = 0
        assertNull(rejoin(clock) { _, _ -> calls++; throw GatewayMediaHttpException(409, "MEDIA_REVOKED", "revoked") })
        assertEquals(1, calls); assertTrue(clock.sleeps.isEmpty())
    }

    @Test fun `rejoin refusals are classified by code`() {
        fun kind(status: Int, code: String) = classifyMediaRejoinFailure(GatewayMediaHttpException(status, code, "x"))
        assertEquals(MediaRejoinFailure.REVOKED, kind(409, "MEDIA_REVOKED"))
        for (code in listOf("MEDIA_LEG_CONNECTED", "MEDIA_NODE_PENDING", "CAPTURE_NOT_ACTIVE", "CAPTURE_NOT_CONFIRMED")) {
            assertEquals(code, MediaRejoinFailure.CONFLICT, kind(409, code))
        }
        assertEquals(MediaRejoinFailure.FATAL, kind(403, "FORBIDDEN"))
        assertEquals(MediaRejoinFailure.CONFLICT, kind(503, "MEDIA_BRIDGE_UNAVAILABLE"))
        assertEquals(MediaRejoinFailure.RETRY, classifyMediaRejoinFailure(java.io.IOException("reset")))
    }

    @Test fun `slow attempts never run past the 60 s window`() {
        val clock = FakeClock(); val budgets = mutableListOf<Long>()
        val result = rejoin(clock) { _, budget -> budgets += budget; clock.ms += budget; throw MediaTransportTimeoutException(IceTransport.UDP, MediaTransportStage.DATA_CHANNEL) }
        assertNull(result)
        assertEquals(listOf(20_000L, 20_000L, 20_000L), budgets)
        assertTrue(clock.ms <= MEDIA_REJOIN_WINDOW_MS)
    }

    @Test fun `an inner timeout is a failed attempt but our own cancellation ends the loop`() {
        val clock = FakeClock(); var calls = 0
        val result = rejoin(clock) { _, _ ->
            calls++
            if (calls == 1) withTimeout(1) { delay(1_000) }
            "ok"
        }
        assertEquals("ok", result); assertEquals(2, calls)
        var attempts = 0
        runBlocking {
            val job = launch {
                rejoinMediaLeg(IceTransport.UDP, false, { 0L }, { delay(it) }, { _, _, _, _, _ -> attempts++ }) { _, _ ->
                    awaitCancellation()
                }
            }
            delay(20); job.cancel(); job.join()
            assertTrue(job.isCancelled)
        }
        assertEquals(0, attempts) // Hangup: no failed attempt is logged and no next attempt starts.
    }
}
