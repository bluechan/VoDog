package org.vodog

import org.vodog.CallMediaRelayGatheringPolicy.Decision
import org.junit.Assert.assertEquals
import org.junit.Test

class CallMediaRelayGatheringPolicyTest {
    private fun decide(
        complete: Boolean = false,
        candidates: Int = 0,
        elapsed: Long,
        sinceFirst: Long? = null,
        cap: Long = CallMediaRelayGatheringPolicy.CAP_MS,
    ) = CallMediaRelayGatheringPolicy.decide(complete, candidates, elapsed, sinceFirst, cap)

    @Test fun windowsAreOneAndTwelveSeconds() {
        assertEquals(1_000L, CallMediaRelayGatheringPolicy.SETTLE_WINDOW_MS)
        assertEquals(12_000L, CallMediaRelayGatheringPolicy.CAP_MS)
        assertEquals(50L, CallMediaRelayGatheringPolicy.POLL_INTERVAL_MS)
    }

    @Test fun completeWithCandidatesProceedsImmediately() {
        assertEquals(Decision.PROCEED, decide(complete = true, candidates = 2, elapsed = 300))
    }

    @Test fun completeWithoutCandidatesFailsImmediately() {
        assertEquals(Decision.NO_RELAY_CANDIDATE, decide(complete = true, candidates = 0, elapsed = 300))
    }

    @Test fun firstRelayCandidatePlusSettleWindowProceedsWithoutCompletion() {
        assertEquals(Decision.WAIT, decide(candidates = 1, elapsed = 600, sinceFirst = 500))
        assertEquals(Decision.PROCEED, decide(candidates = 2, elapsed = 1_100, sinceFirst = 1_000))
        assertEquals(Decision.PROCEED, decide(candidates = 2, elapsed = 2_000, sinceFirst = 1_900))
    }

    @Test fun waitsWhileNothingHasArrivedYet() {
        assertEquals(Decision.WAIT, decide(elapsed = 50))
        // Past the cap only the cap branch decides; a still-gathering peer with no candidate at
        // 11 s keeps waiting for the last second.
        assertEquals(Decision.WAIT, decide(elapsed = 11_000))
    }

    @Test fun capWithoutAnyCandidateIsANoRelayCandidateFailure() {
        assertEquals(Decision.NO_RELAY_CANDIDATE, decide(elapsed = 12_000))
        assertEquals(Decision.NO_RELAY_CANDIDATE, decide(elapsed = 13_000))
    }

    @Test fun capWithALateCandidateProceeds() {
        assertEquals(Decision.PROCEED, decide(candidates = 1, elapsed = 12_000, sinceFirst = 400))
    }

    @Test fun udpStartWithATlsFallbackGathersForFiveSecondsTheRestTwelve() {
        val udp = CallMediaTransport.UDP
        val tls = CallMediaTransport.TLS
        assertEquals(5_000L, CallMediaRelayGatheringPolicy.capMs(udp, fallbackFollows = true))
        // The TLS attempt (fallback or learned start), and a UDP attempt nothing follows, keep 12 s.
        assertEquals(12_000L, CallMediaRelayGatheringPolicy.capMs(tls, fallbackFollows = true))
        assertEquals(12_000L, CallMediaRelayGatheringPolicy.capMs(tls, fallbackFollows = false))
        assertEquals(12_000L, CallMediaRelayGatheringPolicy.capMs(udp, fallbackFollows = false))
    }

    @Test fun shortCapFailsFastWithoutCandidatesAndStillOffersALateOne() {
        val cap = CallMediaRelayGatheringPolicy.UDP_WITH_FALLBACK_CAP_MS
        assertEquals(Decision.WAIT, decide(elapsed = 4_950, cap = cap))
        assertEquals(Decision.NO_RELAY_CANDIDATE, decide(elapsed = 5_000, cap = cap))
        assertEquals(Decision.PROCEED, decide(candidates = 1, elapsed = 5_000, sinceFirst = 300, cap = cap))
        // The settle window is unchanged inside the shorter cap.
        assertEquals(Decision.PROCEED, decide(candidates = 1, elapsed = 1_500, sinceFirst = 1_000, cap = cap))
    }
}
