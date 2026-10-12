import XCTest
@testable import VoDog

/// S101: transcript dialog decoding and bubble presentation rules, checked against a copy of the shared Control fixture.
final class S101ClientPolicyTests: XCTestCase {
    private func fixture() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().appendingPathComponent("Fixtures/s101-dialog.json")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func expectedDialog(_ name: String) throws -> TranscriptDialog? {
        let cases = try fixture()
        let expected = try XCTUnwrap((cases[name] as? [String: Any])?["expected"])
        if expected is NSNull { return nil }
        let data = try JSONSerialization.data(withJSONObject: expected)
        return try JSONDecoder().decode(TranscriptDialog.self, from: data)
    }

    private func job(dialogJSON: String?) throws -> TranscriptJob {
        let dialogField = dialogJSON.map { #","dialog":\#($0)"# } ?? ""
        let json = #"{"transcript":{"id":"t1","callId":"c1","status":"succeeded","attempts":1,"nextAttemptAt":null,"error":null,"result":{"text":"remote: 你好","segments":[{"track":"remote_original","speaker":"remote","text":"你好","startMs":0,"endMs":500}],"providers":[],"advertisingClassification":"not_advertising","includeInReports":true,"summary":null,"actionItems":[]},"createdAt":"2026-10-06T00:00:00Z","updatedAt":"2026-10-06T00:00:00Z","completedAt":null\#(dialogField)}}"#
        return try XCTUnwrap(JSONDecoder().decode(TranscriptEnvelope.self, from: Data(json.utf8)).transcript)
    }

    func testHumanCallTurnsAlternateSidesWithTimes() throws {
        let dialog = try XCTUnwrap(expectedDialog("humanCall"))
        XCTAssertEqual(dialog.timebase, "end_aligned")
        XCTAssertEqual(dialog.turns.map(\.role), ["remote", "me", "remote", "me"])
        XCTAssertEqual(dialog.turns.map { TranscriptDialogPolicy.style(role: $0.role).side },
                       [.leading, .trailing, .leading, .trailing])
        XCTAssertEqual(dialog.turns.map { TranscriptDialogPolicy.timestamp(ms: $0.atMs) },
                       ["00:00", "00:02", "00:08", "00:08"])
        XCTAssertEqual(dialog.turns[0].text, "喂，你好是王总吗")
        XCTAssertEqual(dialog.turns[1].endAtMs, 3400)
        XCTAssertEqual(dialog.turns[1].track, "caller_original")
        XCTAssertFalse(TranscriptDialogPolicy.showsEstimateNote(maxSkewMs: dialog.maxSkewMs))
    }

    func testAiRealtimeTurnsDecodeWithoutEndOrTrack() throws {
        let dialog = try XCTUnwrap(expectedDialog("aiCallRealtime"))
        XCTAssertEqual(dialog.timebase, "ai_realtime")
        XCTAssertNil(dialog.turns[0].endAtMs)
        XCTAssertNil(dialog.turns[0].track)
        XCTAssertEqual(dialog.turns.map(\.source), ["ai_realtime", "ai_realtime", "ai_realtime"])
        XCTAssertEqual(dialog.turns.map { TranscriptDialogPolicy.timestamp(ms: $0.atMs) }, ["00:02", "00:12", "00:12"])
        XCTAssertEqual(dialog.turns.map { TranscriptDialogPolicy.style(role: $0.role).side },
                       [.trailing, .leading, .trailing])
    }

    func testAiCallWithoutRealtimeMapsUplinkToAi() throws {
        let dialog = try XCTUnwrap(expectedDialog("aiCallWithoutRealtime"))
        XCTAssertEqual(dialog.turns.map(\.role), ["ai", "remote"])
        XCTAssertEqual(dialog.turns[0].track, "caller_uplink")
    }

    func testNoSegmentsFixtureIsNull() throws {
        XCTAssertNil(try expectedDialog("noSegments"))
    }

    func testRoleStyles() {
        XCTAssertEqual(TranscriptDialogPolicy.style(role: "remote"),
                       .init(side: .leading, backgroundToken: "surface3", foregroundToken: "ink", label: "对方", tag: nil))
        XCTAssertEqual(TranscriptDialogPolicy.style(role: "me"),
                       .init(side: .trailing, backgroundToken: "bubbleOut", foregroundToken: "white", label: "我", tag: nil))
        XCTAssertEqual(TranscriptDialogPolicy.style(role: "ai"),
                       .init(side: .trailing, backgroundToken: "aiSoft", foregroundToken: "ink", label: "AI", tag: "AI"))
        XCTAssertEqual(TranscriptDialogPolicy.style(role: "future_role").side, .leading)
    }

    func testTimestampFormatting() {
        XCTAssertEqual(TranscriptDialogPolicy.timestamp(ms: 2753), "00:02")
        XCTAssertEqual(TranscriptDialogPolicy.timestamp(ms: 12231), "00:12")
        XCTAssertEqual(TranscriptDialogPolicy.timestamp(ms: 83000), "01:23")
        XCTAssertEqual(TranscriptDialogPolicy.timestamp(ms: 3_725_000), "62:05")
        XCTAssertEqual(TranscriptDialogPolicy.timestamp(ms: -10), "00:00")
    }

    func testSpacingAndEstimateNote() {
        XCTAssertEqual(TranscriptDialogPolicy.spacing(previousRole: nil, role: "remote"), 0)
        XCTAssertEqual(TranscriptDialogPolicy.spacing(previousRole: "remote", role: "remote"), 4)
        XCTAssertEqual(TranscriptDialogPolicy.spacing(previousRole: "remote", role: "me"), 12)
        XCTAssertFalse(TranscriptDialogPolicy.showsEstimateNote(maxSkewMs: 1500))
        XCTAssertTrue(TranscriptDialogPolicy.showsEstimateNote(maxSkewMs: 1501))
        XCTAssertEqual(TranscriptDialogPolicy.estimateNote, "时间为估算")
    }

    func testMissingOrNullOrEmptyDialogFallsBackToTrackBlocks() throws {
        XCTAssertNil(TranscriptDialogPolicy.dialog(for: try job(dialogJSON: nil)))
        XCTAssertNil(TranscriptDialogPolicy.dialog(for: try job(dialogJSON: "null")))
        XCTAssertNil(TranscriptDialogPolicy.dialog(for: try job(dialogJSON: #"{"timebase":"end_aligned","maxSkewMs":0,"turns":[]}"#)))
        XCTAssertNil(TranscriptDialogPolicy.dialog(for: nil))
        let withDialog = try job(dialogJSON: #"{"timebase":"end_aligned","maxSkewMs":600.5,"turns":[{"role":"remote","text":"你好","atMs":2500.5,"endAtMs":3000,"source":"asr","track":"remote_original"}]}"#)
        XCTAssertEqual(TranscriptDialogPolicy.dialog(for: withDialog)?.turns.first?.atMs, 2500.5)
        XCTAssertEqual(withDialog.result?.segments.count, 1, "result stays as before")
    }
}
