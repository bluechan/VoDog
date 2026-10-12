import XCTest
@testable import VoDog

/// S96：号码归属地。简短 / 完整形态向量与规格一致；新字段缺省兼容；CallKit 来电名新签名。
final class S96PhoneLocationTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testShortAndFullVectors() {
        XCTAssertEqual(ContactDisplay.locationShort("广东 深圳 · 移动"), "广东 深圳")
        XCTAssertEqual(ContactDisplay.locationShort("北京 · 联通"), "北京")
        XCTAssertEqual(ContactDisplay.locationShort("加纳"), "加纳")
        XCTAssertNil(ContactDisplay.locationShort(""))
        XCTAssertNil(ContactDisplay.locationShort("   "))
        XCTAssertNil(ContactDisplay.locationShort(nil))
        XCTAssertEqual(ContactDisplay.locationFull(" 广东 深圳 · 移动 "), "广东 深圳 · 移动")
        XCTAssertEqual(ContactDisplay.locationFull("加纳"), "加纳")
        XCTAssertNil(ContactDisplay.locationFull("  "))
        XCTAssertNil(ContactDisplay.locationFull(nil))
    }

    func testSharedTitlesUnchanged() {
        XCTAssertEqual(ContactDisplay.numberWithName(number: "2025550101", contactName: "张三"), "2025550101 · 张三")
        XCTAssertEqual(ContactDisplay.title(number: "2025550101", contactName: nil), "2025550101")
    }

    func testCallHistorySublinePutsLocationFirst() {
        XCTAssertEqual(CallHistoryRow.subline(location: "广东 深圳", number: "2025550103", kind: "已接", duration: "24 秒", badge: nil),
                       "广东 深圳 · 2025550103 · 已接 · 24 秒")
        XCTAssertEqual(CallHistoryRow.subline(location: "北京", number: nil, kind: "未接", duration: nil, badge: "AI"),
                       "北京 · 未接 · AI")
        XCTAssertEqual(CallHistoryRow.subline(location: nil, number: "2025550103", kind: "已接", duration: "24 秒", badge: nil),
                       "2025550103 · 已接 · 24 秒")
    }

    func testCallRecordDecoding() throws {
        let with = try decode(CallRecord.self, #"{"id":"c1","remoteNumber":"2025550101","remoteLocation":"广东 深圳 · 移动"}"#)
        XCTAssertEqual(with.remoteLocation, "广东 深圳 · 移动")
        XCTAssertNil(try decode(CallRecord.self, #"{"id":"c1"}"#).remoteLocation)
    }

    func testSMSMessageAndConversationDecoding() throws {
        let with = try decode(SMSMessage.self, #"{"id":"m1","remoteLocation":"北京 · 联通"}"#)
        XCTAssertEqual(with.remoteLocation, "北京 · 联通")
        XCTAssertNil(try decode(SMSMessage.self, #"{"id":"m1"}"#).remoteLocation)

        // 会话归属地 = 最新一条消息的值。
        let messages = try decode([SMSMessage].self, #"""
        [{"id":"m1","simId":"s","remoteNumber":"2025550102","direction":"incoming","body":"1","createdAt":"2026-10-01T00:00:00Z","remoteLocation":"旧 · 值"},
         {"id":"m2","simId":"s","remoteNumber":"2025550102","direction":"incoming","body":"2","createdAt":"2026-10-01T00:01:00Z","remoteLocation":"广东 深圳 · 移动"}]
        """#)
        let thread = try XCTUnwrap(MessageConversation.grouped(messages, selectedSIMID: "s").first)
        XCTAssertEqual(thread.location, "广东 深圳 · 移动")
    }

    func testContactPhoneAndLookupDecoding() throws {
        let phone = try decode(ContactPhone.self, #"{"id":"p1","rawNumber":"2025550101","location":"广东 深圳 · 移动"}"#)
        XCTAssertEqual(phone.location, "广东 深圳 · 移动")
        XCTAssertNil(try decode(ContactPhone.self, #"{"id":"p1","rawNumber":"2025550101"}"#).location)
        XCTAssertNil(ContactPhone(id: "p1", rawNumber: "1").location)

        let lookup = try decode(ContactLookupEnvelope.self, #"{"item":null,"location":"广东 深圳 · 移动"}"#)
        XCTAssertNil(lookup.item)
        XCTAssertEqual(lookup.location, "广东 深圳 · 移动")
        XCTAssertNil(try decode(ContactLookupEnvelope.self, #"{"item":null}"#).location)
    }

    func testReportItemAndInterceptionDecoding() throws {
        let base = #""callId":"c1","startedAt":"2026-10-01T00:00:00Z","sim":{"id":"s1","label":"SIM 1"}"#
        let item = try decode(CallReportItem.self, "{\(base),\"remoteLocation\":\"北京 · 联通\"}")
        XCTAssertEqual(item.remoteLocation, "北京 · 联通")
        XCTAssertNil(try decode(CallReportItem.self, "{\(base)}").remoteLocation)
        XCTAssertEqual(
            ReportCardFacts.line(simLabel: "SIM 1", direction: "incoming", duration: nil, answerMethod: .missed,
                                 location: item.remoteLocation),
            "SIM 1 · 北京 · 呼入 · 未接"
        )
        XCTAssertEqual(
            ReportCardFacts.line(simLabel: "SIM 1", direction: "incoming", duration: nil, answerMethod: .missed),
            "SIM 1 · 呼入 · 未接"
        )

        let blocked = try decode(Interception.self, #"{"id":"i1","kind":"call","remoteLocation":"加纳"}"#)
        XCTAssertEqual(blocked.remoteLocation, "加纳")
        XCTAssertNil(try decode(Interception.self, #"{"id":"i1","kind":"call"}"#).remoteLocation)
    }

    func testPushPayloadParsesLocation() throws {
        let id = UUID().uuidString
        let push = try XCTUnwrap(PushCallPayload([
            "version": 1, "event": "call.incoming", "callId": id, "remoteNumber": "2025550101",
            "remoteLocation": " 广东 深圳 · 移动 ", "simLabel": "工作卡",
        ]))
        XCTAssertEqual(push.remoteLocation, "广东 深圳 · 移动")
        XCTAssertEqual(push.callerDisplayName, "2025550101 · 广东 深圳 → 工作卡")

        let blank = try XCTUnwrap(PushCallPayload([
            "version": 1, "event": "call.incoming", "callId": id, "remoteNumber": "2025550101", "remoteLocation": "  ",
        ]))
        XCTAssertNil(blank.remoteLocation)
        XCTAssertNil(blank.callerDisplayName)
    }

    func testIncomingCallerName() {
        func name(contact: String? = nil, number: String? = nil, isInternal: Bool = false, peer: String? = nil,
                  sim: String? = nil, location: String? = nil) -> String? {
            IncomingCallerName.text(contactName: contact, remoteNumber: number, isInternal: isInternal,
                                    peerSimLabel: peer, simLabel: sim, location: location)
        }
        let loc = "广东 深圳 · 移动"
        XCTAssertEqual(name(contact: "张三", number: "2025550101", location: loc), "张三 · 广东 深圳")
        XCTAssertEqual(name(number: "2025550101", location: loc), "2025550101 · 广东 深圳")
        XCTAssertEqual(name(location: loc), "未知号码 · 广东 深圳")
        XCTAssertEqual(name(contact: "张三", number: "2025550101", sim: "工作卡", location: loc), "张三 · 广东 深圳 → 工作卡")
        XCTAssertEqual(name(number: "2025550101", sim: "工作卡", location: "加纳"), "2025550101 · 加纳 → 工作卡")
        // 无归属地 = S81 行为。
        XCTAssertEqual(name(contact: "张三", number: "2025550101", location: "  "), "张三")
        XCTAssertNil(name(number: "2025550101"))
        XCTAssertEqual(name(number: "2025550101", sim: "工作卡"), "2025550101 → 工作卡")
        // 内部来电不带归属地。
        XCTAssertEqual(name(isInternal: true, peer: "联通186", location: loc), "联通186（内部）")
        XCTAssertEqual(name(isInternal: true, peer: "联通186", sim: "工作卡", location: loc), "联通186（内部）→ 工作卡")
    }
}
