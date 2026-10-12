package org.vodog

import org.junit.Assert.assertEquals
import org.junit.Test
import java.math.BigInteger

class CallMediaS70Test {
    @Test fun lowCostOnlyWhileWiFiOrEthernetCarriesTheActiveNetwork() {
        assertEquals(MediaCandidateNetworkPolicy.LOW_COST, MediaCandidateNetworkPolicy.choice(true, true, false))
        assertEquals(MediaCandidateNetworkPolicy.LOW_COST, MediaCandidateNetworkPolicy.choice(true, false, true))
        assertEquals(MediaCandidateNetworkPolicy.ALL, MediaCandidateNetworkPolicy.choice(true, false, false))
        assertEquals(MediaCandidateNetworkPolicy.ALL, MediaCandidateNetworkPolicy.choice(false, true, false))
        assertEquals(MediaCandidateNetworkPolicy.ALL, MediaCandidateNetworkPolicy.current(null))
        assertEquals("lowCost", MediaCandidateNetworkPolicy.LOW_COST.label)
        assertEquals("all", MediaCandidateNetworkPolicy.ALL.label)
    }

    @Test fun jitterBufferTargetUsesTheEmittedCountLikeIos() {
        val rx = mediaRxTx(listOf("inbound-rtp" to mapOf(
            "kind" to "audio", "jitterBufferDelay" to 48.0, "jitterBufferTargetDelay" to 16.0,
            "jitterBufferEmittedCount" to BigInteger.valueOf(160),
        )))["rx"]!!
        assertEquals(300.0, rx["jitterBufferMs"])
        assertEquals(100.0, rx["jitterBufferTargetMs"])
    }

    @Test fun receivePolicyMatchesIos() {
        assertEquals(true, CallMediaReceivePolicy.FAST_ACCELERATE)
        assertEquals(25, CallMediaReceivePolicy.MAX_PACKETS)
    }

    @Test fun rxTxMapAudioStatsOnly() {
        val result = mediaRxTx(
            listOf(
                "inbound-rtp" to mapOf(
                    "kind" to "audio", "packetsReceived" to 1000L, "packetsLost" to 5, "jitter" to 0.0154,
                    "concealedSamples" to BigInteger.valueOf(4800), "totalSamplesReceived" to BigInteger.valueOf(960000),
                    "concealmentEvents" to BigInteger.valueOf(3), "jitterBufferDelay" to 57.6,
                    "jitterBufferEmittedCount" to BigInteger.valueOf(960000),
                    "insertedSamplesForDeceleration" to BigInteger.TEN, "removedSamplesForAcceleration" to BigInteger.ZERO,
                    "trackIdentifier" to "private",
                ),
                "outbound-rtp" to mapOf("kind" to "audio", "packetsSent" to 990L, "bytesSent" to BigInteger.valueOf(79200)),
                "outbound-rtp" to mapOf("kind" to "video", "packetsSent" to 9L),
                "candidate-pair" to mapOf("currentRoundTripTime" to 0.1),
            ),
        )
        assertEquals(
            mapOf(
                "packetsReceived" to 1000L, "packetsLost" to 5L, "concealedSamples" to 4800L,
                "totalSamplesReceived" to 960000L, "concealmentEvents" to 3L,
                "insertedSamplesForDeceleration" to 10L, "removedSamplesForAcceleration" to 0L,
                "jitterMs" to 15.4, "jitterBufferMs" to 0.1,
            ),
            result["rx"],
        )
        assertEquals(mapOf("packetsSent" to 990L, "bytesSent" to 79200L), result["tx"])
        assertEquals(mapOf("rx" to emptyMap<String, Number>(), "tx" to emptyMap()), mediaRxTx(emptyList()))
    }

    @Test fun statsWindowDeltasSincePreviousRowOfSamePeerAndResetOnNewPeer() {
        // Same numbers as iOS S70MediaStatsTests; uint64 members arrive as BigInteger.
        fun report(delay: Double, target: Double, emitted: Long, events: Long, removed: Long, packets: Long) =
            rtpWindowSample(listOf("inbound-rtp" to mapOf(
                "kind" to "audio", "jitterBufferDelay" to delay, "jitterBufferTargetDelay" to target,
                "jitterBufferEmittedCount" to BigInteger.valueOf(emitted), "concealmentEvents" to BigInteger.valueOf(events),
                "removedSamplesForAcceleration" to BigInteger.valueOf(removed), "packetsReceived" to packets,
            )))
        val first = report(90_000.0, 57_600.0, 1_440_000, 7, 160, 1500)
        assertEquals(emptyMap<String, Number>(), rtpWindow(null, first))
        // +48 000 samples emitted with 4 800 sample-seconds of delay = 100 ms; target 2 400 = 50 ms.
        assertEquals(
            mapOf(
                "concealmentEventsWin" to 2L, "removedSamplesForAccelerationWin" to 960L, "packetsReceivedWin" to 50L,
                "jitterBufferWinMs" to 100.0, "jitterBufferTargetWinMs" to 50.0,
            ),
            rtpWindow(first, report(94_800.0, 60_000.0, 1_488_000, 9, 1_120, 1550)),
        )
        // A new PC (rejoin) starts with no previous row: its first row has no window.
        val rejoinFirst = report(100.0, 50.0, 4_800, 0, 0, 50)
        assertEquals(emptyMap<String, Number>(), rtpWindow(null, rejoinFirst))
        val rejoined = report(1_060.0, 530.0, 52_800, 1, 10, 100)
        assertEquals(20.0, rtpWindow(rejoinFirst, rejoined)["jitterBufferWinMs"])
        assertEquals(10.0, rtpWindow(rejoinFirst, rejoined)["jitterBufferTargetWinMs"])
        // No emitted samples in the interval: counts only, no buffer averages.
        assertEquals(
            mapOf("concealmentEventsWin" to 0L, "removedSamplesForAccelerationWin" to 0L, "packetsReceivedWin" to 0L),
            rtpWindow(rejoined, rejoined),
        )
        assertEquals(null, rtpWindowSample(listOf("inbound-rtp" to mapOf("kind" to "video"))))
    }

    @Test fun pathStatsReadTheSelectedPairAndTheRemoteReportWithoutAddresses() {
        val stats = mapOf(
            "T01" to ("transport" to mapOf<String, Any?>("selectedCandidatePairId" to "CPa")),
            "CPa" to ("candidate-pair" to mapOf<String, Any?>(
                "localCandidateId" to "La", "remoteCandidateId" to "Ra", "currentRoundTripTime" to 0.0874,
                "nominated" to true, "state" to "succeeded",
            )),
            // A stale nominated pair from the other interface must not win over the transport's selection.
            "CPb" to ("candidate-pair" to mapOf<String, Any?>(
                "localCandidateId" to "Lb", "remoteCandidateId" to "Ra", "currentRoundTripTime" to 0.5,
                "nominated" to true, "state" to "succeeded",
            )),
            "La" to ("local-candidate" to mapOf<String, Any?>("candidateType" to "relay", "address" to "203.0.113.9", "relayProtocol" to "udp")),
            "Lb" to ("local-candidate" to mapOf<String, Any?>("candidateType" to "relay")),
            "Ra" to ("remote-candidate" to mapOf<String, Any?>("candidateType" to "host", "address" to "198.51.100.7")),
            "RI" to ("remote-inbound-rtp" to mapOf<String, Any?>(
                "kind" to "audio", "fractionLost" to 0.0234375, "roundTripTime" to 0.0912, "jitter" to 0.0031,
            )),
            "RV" to ("remote-inbound-rtp" to mapOf<String, Any?>("kind" to "video", "fractionLost" to 0.9)),
        )
        val path = mediaPath(stats)
        assertEquals(87.4, path["rttMs"])
        assertEquals(mapOf("local" to "relay", "remote" to "host"), path["pair"])
        assertEquals(mapOf("fractionLost" to 0.023, "roundTripTimeMs" to 91.2, "jitterMs" to 3.1), path["txRemote"])
        assertEquals(setOf("rttMs", "pair", "txRemote"), path.keys)
        assertEquals(false, path.toString().contains("203.0.113") || path.toString().contains("198.51.100"))
    }

    @Test fun pathStatsFallBackToTheNominatedPairAndOmitWhatIsMissing() {
        val nominated = mediaPath(mapOf(
            "CP" to ("candidate-pair" to mapOf<String, Any?>("localCandidateId" to "L", "nominated" to true, "state" to "succeeded", "currentRoundTripTime" to 0.1)),
            "CPw" to ("candidate-pair" to mapOf<String, Any?>("nominated" to false, "state" to "waiting", "currentRoundTripTime" to 0.9)),
            "L" to ("local-candidate" to mapOf<String, Any?>("candidateType" to "relay")),
        ))
        assertEquals(mapOf("rttMs" to 100.0, "pair" to mapOf("local" to "relay")), nominated)
        assertEquals(emptyMap<String, Any>(), mediaPath(emptyMap()))
        // Before ICE connects there is no selected pair and no remote report yet.
        assertEquals(emptyMap<String, Any>(), mediaPath(mapOf(
            "T" to ("transport" to mapOf<String, Any?>()),
            "CPw" to ("candidate-pair" to mapOf<String, Any?>("state" to "in-progress", "currentRoundTripTime" to 0.2)),
        )))
    }

    @Test fun iceCandidateTypeKeepsOnlyTheType() {
        assertEquals("relay", iceCandidateType("candidate:1 1 udp 41885439 203.0.113.9 16801 typ relay raddr 0.0.0.0 rport 0"))
        assertEquals("host", iceCandidateType("candidate:2 1 udp 2130706431 198.51.100.7 3478 typ host generation 0"))
        assertEquals(null, iceCandidateType("not a candidate"))
    }
}
