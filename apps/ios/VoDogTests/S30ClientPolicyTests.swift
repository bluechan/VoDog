import XCTest
@testable import VoDog

/// S30 三端删除. Everything the delete surfaces decide — may this row go, what the confirmation says, what the
/// lists look like afterwards, which ids the request carries — is a pure function, and this is
/// where it is pinned.
final class S30ClientPolicyTests: XCTestCase {

    // MARK: - RecordDeletePolicy

    func testRecordDeleteOnlyOffersTerminalCallsAndFallsBackToEndedAt() throws {
        XCTAssertTrue(RecordDeletePolicy.canDelete(state: "ended", endedAt: "2026-09-13T00:00:00Z"))
        XCTAssertTrue(RecordDeletePolicy.canDelete(state: "failed", endedAt: nil))
        // A live call is Control's 409, so the row does not even offer the button.
        for live in ["incoming_ringing", "outgoing_pending", "connecting", "active", "ending"] {
            XCTAssertFalse(
                RecordDeletePolicy.canDelete(state: live, endedAt: nil),
                "\(live) is still running and must not be deletable"
            )
        }
        // Even an `ended_at` cannot make a state the client knows to be live deletable.
        XCTAssertFalse(RecordDeletePolicy.canDelete(state: "active", endedAt: "2026-09-13T00:00:00Z"))
        // A vocabulary this build has never seen is judged by `ended_at` alone, and fails closed without one.
        XCTAssertTrue(RecordDeletePolicy.canDelete(state: "reconcile_unknown", endedAt: "2026-09-13T00:00:00Z"))
        XCTAssertFalse(RecordDeletePolicy.canDelete(state: "reconcile_unknown", endedAt: nil))
        XCTAssertFalse(RecordDeletePolicy.canDelete(state: nil, endedAt: "   "))
        XCTAssertTrue(RecordDeletePolicy.canDelete(state: nil, endedAt: "2026-09-13T00:00:00Z"))
        XCTAssertTrue(RecordDeletePolicy.canDelete(state: "ENDED", endedAt: nil))

        let ended = try decodeCall(#"{"id":"c1","state":"ended","endedAt":"2026-09-13T00:00:00Z"}"#)
        let ringing = try decodeCall(#"{"id":"c2","state":"incoming_ringing"}"#)
        XCTAssertTrue(RecordDeletePolicy.canDelete(ended))
        XCTAssertFalse(RecordDeletePolicy.canDelete(ringing))
    }

    func testRecordDeleteCopyIsTheFrozenS30Wording() {
        XCTAssertEqual(RecordDeletePolicy.actionTitle, "删除")
        XCTAssertEqual(RecordDeletePolicy.confirmTitle, "删除这条通话记录？")
        // S39 §G: the Pixel's own dialer log is deleted too, and the confirmation now says so.
        XCTAssertEqual(RecordDeletePolicy.confirmMessage, "录音、转写、报告条目和网关设备上的通话记录会一起删除，无法恢复。")
        XCTAssertEqual(RecordDeletePolicy.confirmButton, "删除")
        XCTAssertEqual(RecordDeletePolicy.cancelButton, "取消")
        XCTAssertEqual(RecordDeletePolicy.inUseMessage, "通话仍在进行或处理中，稍后再删")
        XCTAssertEqual(RecordDeletePolicy.accessibilityIdentifier, "records.delete")
    }

    func testRecordDelete409IsTheOnlyStatusWithItsOwnWording() {
        XCTAssertEqual(
            RecordDeletePolicy.errorMessage(APIError.server(409, "call is in use", "CALL_IN_USE")),
            RecordDeletePolicy.inUseMessage
        )
        // 404 means someone else already deleted it; the transport's own message stands.
        XCTAssertEqual(
            RecordDeletePolicy.errorMessage(APIError.server(404, "not found", nil)),
            APIError.server(404, "not found", nil).localizedDescription
        )
        XCTAssertEqual(
            RecordDeletePolicy.errorMessage(APIError.unauthorized),
            APIError.unauthorized.localizedDescription
        )
        XCTAssertNotEqual(
            RecordDeletePolicy.errorMessage(APIError.server(500, "", nil)),
            RecordDeletePolicy.inUseMessage
        )
    }

    func testRecordDeleteRemovesTheRowAndItsReportEntryTogether() throws {
        let calls = try [
            decodeCall(#"{"id":"c1","state":"ended"}"#),
            decodeCall(#"{"id":"c2","state":"ended"}"#),
        ]
        XCTAssertEqual(RecordDeletePolicy.callsAfterDelete(calls, id: "c1").map(\.id), ["c2"])
        XCTAssertEqual(RecordDeletePolicy.callsAfterDelete(calls, id: "nope").map(\.id), ["c1", "c2"])

        let items = try decodeReportItems(#"""
        {"items":[
          {"callId":"c1","startedAt":"2026-09-13T00:00:00Z","sim":{"id":"sim-a"}},
          {"callId":"c2","startedAt":"2026-09-13T00:01:00Z","sim":{"id":"sim-a"}}
        ]}
        """#)
        XCTAssertEqual(RecordDeletePolicy.reportItemsAfterDelete(items, callID: "c1").map(\.callId), ["c2"])
    }

    /// S133: 全部通话 no longer has a total or a page to rewind — a delete takes the row and nothing else.
    func testRecordDeleteOnlyRemovesTheRowAndTheNextChunkStartsAfterTheNewLastRow() throws {
        let calls = try (1...51).map {
            try decodeCall(#"{"id":"c\#($0)","startedAt":"2026-09-13T00:00:\#(String(format: "%02d", 60 - $0)).000Z"}"#)
        }
        // A row in the middle: order and the cursor are untouched.
        let middle = RecordDeletePolicy.callsAfterDelete(calls, id: "c7")
        XCTAssertEqual(middle.map(\.id), calls.map(\.id).filter { $0 != "c7" })
        XCTAssertEqual(CallsScrollPolicy.cursor(after: middle), CallsScrollPolicy.cursor(after: calls))

        // The last loaded row: the next chunk is asked for from the row that is now last.
        let last = RecordDeletePolicy.callsAfterDelete(calls, id: "c51")
        XCTAssertEqual(
            CallsScrollPolicy.cursor(after: last),
            SMSPageCursor(before: "2026-09-13T00:00:10.000Z", beforeId: "c50")
        )

        // The only row: an empty list has no cursor, so nothing more is asked for.
        XCTAssertNil(CallsScrollPolicy.cursor(after: RecordDeletePolicy.callsAfterDelete([calls[0]], id: "c1")))
    }

    /// S133: the poll's head merge must not bring a deleted row back, in the head window or behind it.
    func testRecordDeleteSurvivesTheNextHeadMerge() throws {
        let calls = try (1...59).map {
            try decodeCall(#"{"id":"c\#($0)","startedAt":"2026-09-13T00:00:\#(String(format: "%02d", 60 - $0)).000Z"}"#)
        }
        // Deleted behind the head: the server's head is unchanged and the local tail no longer has the row.
        let tail = CallsScrollPolicy.afterHead(
            Array(calls.prefix(50)), loaded: RecordDeletePolicy.callsAfterDelete(calls, id: "c55"), reachedEnd: true
        )
        XCTAssertEqual(tail.calls.map(\.id), calls.map(\.id).filter { $0 != "c55" })
        XCTAssertTrue(tail.reachedEnd, "A delete does not reopen a list that already reached its end")

        // Deleted inside the head: the server's head slides up by one and the merge keeps the rest.
        let head = CallsScrollPolicy.afterHead(
            calls.prefix(51).filter { $0.id != "c7" },
            loaded: RecordDeletePolicy.callsAfterDelete(calls, id: "c7"), reachedEnd: true
        )
        XCTAssertEqual(head.calls.map(\.id), calls.map(\.id).filter { $0 != "c7" })
    }

    /// S133: 报告 scrolls by offset. After a local delete the next request is computed from the cards left, so
    /// it overlaps the loaded range instead of skipping the card that slid up, and the head merge that follows
    /// the delete neither restores the card nor throws the appended ones away.
    func testReportDeleteKeepsTheScrollAndTheNextPageOverlapsInsteadOfSkipping() throws {
        let body = (1...101).map {
            #"{"callId":"c\#($0)","startedAt":"2026-09-13T00:00:00Z","sim":{"id":"sim-a"}}"#
        }.joined(separator: ",")
        let server = try decodeReportItems("{\"items\":[\(body)]}")
        let loaded = RecordDeletePolicy.reportItemsAfterDelete(Array(server.prefix(100)), callID: "c7")
        XCTAssertEqual(loaded.count, 99)
        XCTAssertEqual(RecordsScrollPolicy.nextPage(loadedCount: loaded.count), 2, "不是第 3 页：第 2 页与已加载的重叠")

        // The reload after the delete: the server's page 1 is now c1…c6, c8…c51.
        let remaining = server.filter { $0.callId != "c7" }
        let merged = RecordsScrollPolicy.afterHead(Array(remaining.prefix(50)), loaded: loaded)
        XCTAssertEqual(merged.map(\.callId), loaded.map(\.callId))

        // Page 2 is now c52…c101: only c101 is new, and nothing was skipped.
        let next = RecordsScrollPolicy.afterChunk(Array(remaining[50..<100]), loaded: merged)
        XCTAssertEqual(next.map(\.callId), remaining.map(\.callId))
        XCTAssertTrue(RecordsScrollPolicy.reachedEnd(loadedCount: next.count, total: 100, answered: 50))
    }

    // MARK: - MessageSelectionPolicy

    func testMessageSelectionTogglesSelectsAllAndClears() {
        var selection = MessageSelectionPolicy.clear()
        XCTAssertTrue(selection.isEmpty)
        selection = MessageSelectionPolicy.toggle("m1", in: selection)
        XCTAssertEqual(selection, ["m1"])
        selection = MessageSelectionPolicy.toggle("m2", in: selection)
        XCTAssertEqual(selection, ["m1", "m2"])
        selection = MessageSelectionPolicy.toggle("m1", in: selection)
        XCTAssertEqual(selection, ["m2"], "A second tap on the same bubble deselects it")
        XCTAssertEqual(MessageSelectionPolicy.selectAll(["m1", "m2", "m3"]), ["m1", "m2", "m3"])
        XCTAssertTrue(MessageSelectionPolicy.clear().isEmpty)
    }

    func testMessageSelectionTitleAndTheFiveHundredIdCeiling() {
        XCTAssertEqual(MessageSelectionPolicy.title(count: 0), "已选 0 条")
        XCTAssertEqual(MessageSelectionPolicy.title(count: 3), "已选 3 条")
        XCTAssertFalse(MessageSelectionPolicy.canDelete([]))
        XCTAssertTrue(MessageSelectionPolicy.canDelete(["m1"]))
        let atCeiling = Set((0..<MessageSelectionPolicy.maximumBatch).map { "m\($0)" })
        XCTAssertEqual(atCeiling.count, 500)
        XCTAssertTrue(MessageSelectionPolicy.canDelete(atCeiling))
        XCTAssertFalse(MessageSelectionPolicy.isOverLimit(atCeiling))
        let overCeiling = atCeiling.union(["one-too-many"])
        XCTAssertFalse(MessageSelectionPolicy.canDelete(overCeiling), "POST /sms/delete takes 1–500 ids")
        XCTAssertTrue(MessageSelectionPolicy.isOverLimit(overCeiling))
        XCTAssertEqual(MessageSelectionPolicy.deleteSelectedTitle, "删除所选")
        XCTAssertEqual(MessageSelectionPolicy.selectAllTitle, "全选")
        XCTAssertEqual(MessageSelectionPolicy.cancelTitle, "取消")
        XCTAssertEqual(MessageSelectionPolicy.deleteSelectedAccessibilityIdentifier, "conversation.deleteSelected")
        XCTAssertEqual(MessageSelectionPolicy.selectModeAccessibilityIdentifier, "conversation.selectMode")
    }

    func testMessageSelectionRequestKeepsThreadOrderAndFiltersLocally() throws {
        let messages = try decodeMessages(#"""
        {"items":[
          {"id":"m1","simId":"sim-a","remoteNumber":"2025550102","direction":"incoming","body":"1","createdAt":"2026-09-13T00:00:00Z"},
          {"id":"m2","simId":"sim-a","remoteNumber":"2025550102","direction":"outgoing","body":"2","createdAt":"2026-09-13T00:01:00Z"},
          {"id":"m3","simId":"sim-a","remoteNumber":"2025550102","direction":"incoming","body":"3","createdAt":"2026-09-13T00:02:00Z"}
        ]}
        """#)
        // A `Set` has no order; the body must still be the thread's, so two identical taps send one identical request.
        XCTAssertEqual(MessageSelectionPolicy.orderedIDs(["m3", "m1"], in: messages), ["m1", "m3"])
        XCTAssertEqual(MessageSelectionPolicy.orderedIDs(["nope"], in: messages), [])
        XCTAssertEqual(
            MessageSelectionPolicy.remaining(messages, deleting: ["m1", "m3"]).map(\.id), ["m2"]
        )
        XCTAssertEqual(MessageSelectionPolicy.remaining(messages, deleting: []).map(\.id), ["m1", "m2", "m3"])
    }

    func testMessageSelectionHidesOnlyWhatTheServerActuallyDeleted() {
        let requested = ["m1", "m2", "m3"]
        let skipped = [SMSDeleteSkip(id: "m2", reason: "in_flight")]
        XCTAssertEqual(MessageSelectionPolicy.acceptedIDs(requested: requested, skipped: skipped), ["m1", "m3"])
        XCTAssertEqual(MessageSelectionPolicy.acceptedIDs(requested: requested, skipped: []), requested)
        XCTAssertEqual(MessageSelectionPolicy.skippedMessage(skipped), "1 条正在发送中，暂时无法删除。")
        XCTAssertNil(MessageSelectionPolicy.skippedMessage([]))
    }

    // MARK: - ThreadSwipeActionPolicy

    func testS66BlockCopyNamesOnlyTheListItWrites() {
        XCTAssertEqual(ThreadSwipeActionPolicy.deleteAndBlockConfirmMessage,
                       "这段对话会被彻底删除，之后不再接收这个号码的短信（来电不受影响）。")
        XCTAssertEqual(ContactCardActionPolicy.blockConfirmMessage, "屏蔽后，该号码的来电会被直接挂断，短信不受影响。")
        XCTAssertEqual(ContactCardActionPolicy.unblockConfirmMessage, "解除后，该号码的来电会恢复正常接听。")
        XCTAssertEqual(BlocklistScope.sms.unblockConfirmMessage, "解除后，这个号码的短信会恢复正常接收。")
        XCTAssertEqual(BlocklistScope.allCases.map(\.title), ["来电", "短信"])
        XCTAssertEqual(BlocklistSummaryPolicy.summary(call: 0, sms: 0), "暂无")
        XCTAssertEqual(BlocklistSummaryPolicy.summary(call: 429, sms: 1), "来电 429 · 短信 1")
    }

    func testThreadSwipeKeepsDeleteAtTheEdgeAndDropsBlockForEmergencyNumbers() {
        XCTAssertEqual(
            ThreadSwipeActionPolicy.actions(remoteNumber: "2025550102"), [.delete, .deleteAndBlock],
            "Declaration order is edge-first on a trailing swipe, so 删除 must be listed before 删除并屏蔽"
        )
        // 屏蔽 reuses the history row's judgement, which is what excludes 112 / 911 in exactly one place.
        XCTAssertEqual(ThreadSwipeActionPolicy.actions(remoteNumber: "112"), [.delete])
        XCTAssertEqual(ThreadSwipeActionPolicy.actions(remoteNumber: "911"), [.delete])
        XCTAssertEqual(ThreadSwipeActionPolicy.actions(remoteNumber: nil), [.delete])
        XCTAssertEqual(ThreadSwipeActionPolicy.actions(remoteNumber: "  "), [.delete])
        XCTAssertEqual(
            ThreadSwipeActionPolicy.canBlock(remoteNumber: "2025550102"),
            HistoryRowActionPolicy.canBlock(remoteNumber: "2025550102")
        )
        XCTAssertEqual(
            ThreadSwipeActionPolicy.canBlock(remoteNumber: "112"),
            HistoryRowActionPolicy.canBlock(remoteNumber: "112")
        )
    }

    func testThreadSwipeCopyAndIdentifiers() {
        XCTAssertEqual(ThreadSwipeActionPolicy.title(.delete), "删除")
        XCTAssertEqual(ThreadSwipeActionPolicy.title(.deleteAndBlock), "删除并屏蔽")
        XCTAssertEqual(ThreadSwipeActionPolicy.confirmTitle(.delete), "删除这段对话？")
        XCTAssertEqual(ThreadSwipeActionPolicy.confirmTitle(.deleteAndBlock), "删除并屏蔽此号码？")
        XCTAssertFalse(ThreadSwipeActionPolicy.confirmMessage(.delete).isEmpty)
        XCTAssertFalse(ThreadSwipeActionPolicy.confirmMessage(.deleteAndBlock).isEmpty)
        XCTAssertNotEqual(
            ThreadSwipeActionPolicy.confirmMessage(.delete),
            ThreadSwipeActionPolicy.confirmMessage(.deleteAndBlock)
        )
        XCTAssertEqual(ThreadSwipeActionPolicy.accessibilityIdentifier(.delete), "threads.delete")
        XCTAssertEqual(ThreadSwipeActionPolicy.accessibilityIdentifier(.deleteAndBlock), "threads.deleteAndBlock")
        XCTAssertEqual(ThreadSwipeActionPolicy.cancelTitle, "取消")
        XCTAssertEqual(ThreadSwipeActionPolicy.confirmButton, "删除")
    }

    func testThreadBlockRejectionIsTheOnlyStatusWithItsOwnWording() {
        XCTAssertEqual(
            ThreadSwipeActionPolicy.blockErrorMessage(APIError.server(400, "emergency", "EMERGENCY_NUMBER")),
            ThreadSwipeActionPolicy.blockRejectedMessage
        )
        XCTAssertTrue(
            ThreadSwipeActionPolicy.blockRejectedMessage.contains("没有删除"),
            "A refused block must say the thread is still there"
        )
        XCTAssertEqual(
            ThreadSwipeActionPolicy.blockErrorMessage(APIError.server(500, "boom", nil)),
            APIError.server(500, "boom", nil).localizedDescription
        )
    }

    func testThreadDeleteKeepsServerSkippedMessagesRowsAndReportsPartialSuccess() {
        let response = SMSDeleteResponseFixture.partial
        XCTAssertEqual(
            ThreadDeleteResultPolicy.acceptedIDs(requested: ["m1", "m2", "m3"], response: response),
            ["m1", "m3"]
        )
        XCTAssertEqual(ThreadDeleteResultPolicy.feedback(response), "1 条正在发送中，暂时无法删除。")
        XCTAssertEqual(
            ThreadSwipeActionPolicy.blockSucceededDeleteFailedMessage,
            "号码已屏蔽，但对话删除失败，请重试"
        )
    }

    func testThreadKeyIsTheServerAddressWhileTheBlockNumberStaysRaw() throws {
        let messages = try decodeMessages(#"""
        {"items":[
          {"id":"m1","simId":"sim-a","remoteNumber":"2025550102","conversationAddress":"+12025550102","direction":"incoming","body":"1","createdAt":"2026-09-13T00:00:00Z"},
          {"id":"m2","simId":"sim-a","remoteNumber":"+1 202-555-0102","conversationAddress":"+12025550102","direction":"outgoing","body":"2","createdAt":"2026-09-13T00:01:00Z"}
        ]}
        """#)
        let thread = try XCTUnwrap(MessageConversation.grouped(messages, selectedSIMID: "sim-a").first)
        XCTAssertEqual(thread.threadAddress, "+12025550102", "POST /sms/threads/delete is keyed by the server's address")
        XCTAssertEqual(thread.blockNumber, "+1 202-555-0102", "POST /blocklist takes the raw remote_number")
        XCTAssertNotEqual(thread.blockNumber, thread.id.remoteNumber)

        // A pre-S21 server sends no `conversationAddress`; the thread then keys on `remoteNumber` as §1.3 says.
        let legacy = try decodeMessages(#"""
        {"items":[{"id":"m3","simId":"sim-b","remoteNumber":"10086","direction":"incoming","body":"x","createdAt":"2026-09-13T00:00:00Z"}]}
        """#)
        let legacyThread = try XCTUnwrap(MessageConversation.grouped(legacy, selectedSIMID: "sim-b").first)
        XCTAssertEqual(legacyThread.threadAddress, "10086")
        XCTAssertEqual(legacyThread.blockNumber, "10086")
    }

    // MARK: - Helpers

    private func decodeCall(_ json: String) throws -> CallRecord {
        try JSONDecoder().decode(CallRecord.self, from: Data(json.utf8))
    }

    private func decodeMessages(_ json: String) throws -> [SMSMessage] {
        try JSONDecoder().decode(ItemEnvelope<SMSMessage>.self, from: Data(json.utf8)).items
    }

    private func decodeReportItems(_ json: String) throws -> [CallReportItem] {
        struct Envelope: Decodable { let items: [CallReportItem] }
        return try JSONDecoder().decode(Envelope.self, from: Data(json.utf8)).items
    }
}

private enum SMSDeleteResponseFixture {
    static var partial: SMSDeleteResponse {
        try! JSONDecoder().decode(
            SMSDeleteResponse.self,
            from: Data(#"{"deleted":2,"skipped":[{"id":"m2","reason":"in_flight"}]}"#.utf8)
        )
    }
}
