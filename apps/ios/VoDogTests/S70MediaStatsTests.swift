import XCTest
@testable import VoDog

/// S70: `media.summary` rx/tx counters from the audio inbound-rtp / outbound-rtp stats.
final class S70MediaStatsTests: XCTestCase {
    func testMapsAudioInboundAndOutboundAndIgnoresVideo() {
        let fields = MediaRtpStats.fields([
            (type: "inbound-rtp", values: [
                "kind": "video" as NSString, "packetsReceived": NSNumber(value: 999)
            ]),
            (type: "inbound-rtp", values: [
                "kind": "audio" as NSString, "packetsReceived": NSNumber(value: 1500), "packetsLost": NSNumber(value: 12),
                "jitter": NSNumber(value: 0.01234), "concealedSamples": NSNumber(value: 4800),
                "silentConcealedSamples": NSNumber(value: 4000),
                "totalSamplesReceived": NSNumber(value: 1_440_000), "concealmentEvents": NSNumber(value: 7),
                "jitterBufferDelay": NSNumber(value: 90_000.0), "jitterBufferEmittedCount": NSNumber(value: 1_440_000),
                "jitterBufferTargetDelay": NSNumber(value: 57_600.0),
                "insertedSamplesForDeceleration": NSNumber(value: 320), "removedSamplesForAcceleration": NSNumber(value: 160)
            ]),
            (type: "outbound-rtp", values: [
                "mediaType": "audio" as NSString, "packetsSent": NSNumber(value: 1490), "bytesSent": NSNumber(value: 123_456)
            ]),
            (type: "candidate-pair", values: ["bytesSent": NSNumber(value: 5)])
        ])
        let rx = fields["rx"] as? [String: Any]
        XCTAssertEqual(rx?["packetsReceived"] as? Int, 1500)
        XCTAssertEqual(rx?["packetsLost"] as? Int, 12)
        XCTAssertEqual(rx?["jitterMs"] as? Double, 12.3)
        XCTAssertEqual(rx?["jitterBufferMs"] as? Double, 62.5)
        XCTAssertEqual(rx?["jitterBufferTargetMs"] as? Double, 40)
        XCTAssertEqual(rx?["concealedSamples"] as? Int, 4800)
        XCTAssertEqual(rx?["silentConcealedSamples"] as? Int, 4000)
        XCTAssertEqual(rx?["totalSamplesReceived"] as? Int, 1_440_000)
        XCTAssertEqual(rx?["concealmentEvents"] as? Int, 7)
        XCTAssertEqual(rx?["insertedSamplesForDeceleration"] as? Int, 320)
        XCTAssertEqual(rx?["removedSamplesForAcceleration"] as? Int, 160)
        XCTAssertEqual(rx?.count, 11)
        let tx = fields["tx"] as? [String: Any]
        XCTAssertEqual(tx?["packetsSent"] as? Int, 1490)
        XCTAssertEqual(tx?["bytesSent"] as? Int, 123_456)
        XCTAssertEqual(tx?.count, 2)
        // The Diag encoder carries both as objects.
        let encoded = Diag.encode(fields, limit: 200)
        XCTAssertEqual(encoded["tx"], .object(["packetsSent": .int(1490), "bytesSent": .int(123_456)]))
    }

    func testOmitsJitterBufferWithoutEmittedSamplesAndEmptyReport() {
        let fields = MediaRtpStats.fields([
            (type: "inbound-rtp", values: [
                "kind": "audio" as NSString, "jitterBufferDelay": NSNumber(value: 0), "jitterBufferEmittedCount": NSNumber(value: 0)
            ])
        ])
        XCTAssertNil(fields["rx"])
        XCTAssertNil(fields["tx"])
        XCTAssertTrue(MediaRtpStats.fields([]).isEmpty)
    }

    func testWindowDeltasSincePreviousRowOfSamePeerAndResetOnNewPeer() {
        func report(_ delay: Double, _ target: Double, _ emitted: Double, _ events: Int, _ removed: Int, _ packets: Int)
            -> [(type: String, values: [String: Any])] {
            [(type: "inbound-rtp", values: [
                "kind": "audio" as NSString, "jitterBufferDelay": NSNumber(value: delay),
                "jitterBufferTargetDelay": NSNumber(value: target), "jitterBufferEmittedCount": NSNumber(value: emitted),
                "concealmentEvents": NSNumber(value: events), "removedSamplesForAcceleration": NSNumber(value: removed),
                "packetsReceived": NSNumber(value: packets)
            ])]
        }
        let window = MediaRtpWindow()
        let peerA = NSObject(), peerB = NSObject()
        XCTAssertTrue(window.fields(report(90_000, 57_600, 1_440_000, 7, 160, 1500), peerID: ObjectIdentifier(peerA)).isEmpty)
        // +48 000 samples emitted (1 s) with 4 800 sample-seconds of delay = 100 ms; target 2 400 = 50 ms.
        let second = window.fields(report(94_800, 60_000, 1_488_000, 9, 1_120, 1550), peerID: ObjectIdentifier(peerA))
        XCTAssertEqual(second["jitterBufferWinMs"] as? Double, 100)
        XCTAssertEqual(second["jitterBufferTargetWinMs"] as? Double, 50)
        XCTAssertEqual(second["concealmentEventsWin"] as? Int, 2)
        XCTAssertEqual(second["removedSamplesForAccelerationWin"] as? Int, 960)
        XCTAssertEqual(second["packetsReceivedWin"] as? Int, 50)
        XCTAssertEqual(second.count, 5)
        // A new PC (rejoin) restarts its counters; the first row of it has no window.
        XCTAssertTrue(window.fields(report(100, 50, 4_800, 0, 0, 50), peerID: ObjectIdentifier(peerB)).isEmpty)
        let rejoined = window.fields(report(1_060, 530, 52_800, 1, 10, 100), peerID: ObjectIdentifier(peerB))
        XCTAssertEqual(rejoined["jitterBufferWinMs"] as? Double, 20)
        XCTAssertEqual(rejoined["packetsReceivedWin"] as? Int, 50)
        // No emitted samples in the interval: counts only, no buffer averages.
        let idle = window.fields(report(1_060, 530, 52_800, 1, 10, 100), peerID: ObjectIdentifier(peerB))
        XCTAssertNil(idle["jitterBufferWinMs"])
        XCTAssertEqual(idle["packetsReceivedWin"] as? Int, 0)
        withExtendedLifetime((peerA, peerB)) {}
    }

    func testCallPeerUsesFastAccelerate() {
        XCTAssertTrue(MediaReceivePolicy.audioJitterBufferFastAccelerate)
    }

    /// Cellular bursts after 1–2 s stalls left the buffer ~1 s deep for the rest of the call; cap at ~500 ms.
    func testCallPeerCapsJitterBufferAt25Packets() {
        XCTAssertEqual(MediaReceivePolicy.audioJitterBufferMaxPackets, 25)
    }

    /// S99 §5: RTT and candidate types from the selected pair, and the bridge's view of our audio.
    func testCarriesRttRemoteInboundAndCandidateTypesWithoutAddresses() {
        let fields = MediaRtpStats.fields([
            (type: "transport", values: ["id": "T1" as NSString, "selectedCandidatePairId": "CP2" as NSString]),
            (type: "candidate-pair", values: [
                "id": "CP1" as NSString, "nominated": NSNumber(value: true), "currentRoundTripTime": NSNumber(value: 0.9),
                "localCandidateId": "L1" as NSString, "remoteCandidateId": "R1" as NSString
            ]),
            (type: "candidate-pair", values: [
                "id": "CP2" as NSString, "currentRoundTripTime": NSNumber(value: 0.2534),
                "localCandidateId": "L2" as NSString, "remoteCandidateId": "R2" as NSString
            ]),
            (type: "local-candidate", values: [
                "id": "L2" as NSString, "candidateType": "relay" as NSString, "address": "10.0.0.1" as NSString
            ]),
            (type: "remote-candidate", values: ["id": "R2" as NSString, "candidateType": "host" as NSString]),
            (type: "remote-inbound-rtp", values: [
                "kind": "audio" as NSString, "fractionLost": NSNumber(value: 0.0625),
                "roundTripTime": NSNumber(value: 0.2611), "jitter": NSNumber(value: 0.00412)
            ])
        ])
        XCTAssertEqual(fields["rttMs"] as? Double, 253.4)
        XCTAssertEqual(fields["localCandidateType"] as? String, "relay")
        XCTAssertEqual(fields["remoteCandidateType"] as? String, "host")
        let remote = fields["txRemote"] as? [String: Any]
        XCTAssertEqual(remote?["fractionLost"] as? Double, 0.0625)
        XCTAssertEqual(remote?["roundTripTimeMs"] as? Double, 261.1)
        XCTAssertEqual(remote?["jitterMs"] as? Double, 4.1)
        XCTAssertEqual(remote?.count, 3)
        XCTAssertNil(fields["rx"])
        XCTAssertFalse(String(describing: fields).contains("10.0.0.1"))
        XCTAssertEqual(Diag.encode(fields, limit: 200)["rttMs"], .double(253.4))
    }

    func testFallsBackToNominatedPairAndDropsUnknownCandidateTypes() {
        let fields = MediaRtpStats.fields([
            (type: "candidate-pair", values: [
                "id": "CP1" as NSString, "nominated": NSNumber(value: true), "currentRoundTripTime": NSNumber(value: 0.05),
                "localCandidateId": "L1" as NSString
            ]),
            (type: "local-candidate", values: ["id": "L1" as NSString, "candidateType": "weird" as NSString])
        ])
        XCTAssertEqual(fields["rttMs"] as? Double, 50)
        XCTAssertNil(fields["localCandidateType"])
        XCTAssertNil(fields["txRemote"])
    }
}
