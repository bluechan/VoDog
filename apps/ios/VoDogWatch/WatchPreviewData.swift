#if DEBUG
import Foundation

/// `-S104Preview` sample data: the spec's fictional examples (示例数据均为虚构). Debug builds only.
enum WatchPreviewData {
    private static func iso(_ minutesAgo: Double) -> String {
        ISO8601DateFormatter().string(from: Date().addingTimeInterval(-minutesAgo * 60))
    }

    private static func settings(_ mode: String, version: Int) -> SIMSettings {
        SIMSettings(mode: mode, timeoutSeconds: 30, version: version, appliedVersion: version,
                    availableModes: ["normal", "ai", "timeout_ai"], aiUnavailableReason: nil)
    }

    static let sims: [SIMChannel] = [
        SIMChannel(id: "sim-work", gatewayId: "gw-pixel", label: "工作号", phoneLabel: "138 0013 0000", slotIndex: 0,
                   online: true, telephonyReady: true, mediaReady: true, smsReady: true, version: 1, present: true,
                   assignmentPending: false, countryIso: "cn", embedded: false, timeZone: "Asia/Shanghai",
                   settings: settings("normal", version: 7), gatewayKind: "pixel", gatewayName: "Pixel 7 Pro"),
        SIMChannel(id: "sim-personal", gatewayId: "gw-dji", label: "个人号", phoneLabel: "139 0000 0000", slotIndex: 1,
                   online: false, telephonyReady: false, mediaReady: false, smsReady: false, version: 1, present: true,
                   assignmentPending: false, countryIso: "cn", embedded: false, timeZone: "Asia/Shanghai",
                   settings: settings("timeout_ai", version: 12), gatewayKind: "dji4g", gatewayName: "DJI 4G"),
    ]

    static var context: WatchContext {
        WatchContext(
            session: .init(accessToken: "preview", expiresAt: nil, userId: "preview-user", deviceName: "iPhone"),
            sims: [], badges: WatchBadges(calls: 2, sms: 3),
            activeCall: .init(callId: "c-active", remoteNumber: "138 0013 8000", contactName: "张伟", simLabel: "工作号",
                              state: "active", answeredAt: iso(3.2), muted: false),
            phoneReachableAt: iso(0)
        )
    }

    private static func call(_ id: String, sim: String, dir: String, number: String, name: String?, started: Double,
                             talk: Double?, state: String = "ended", platform: String? = "ios", unseen: Bool = false,
                             location: String? = nil) -> CallRecord {
        CallRecord(
            id: id, simId: sim, direction: dir, remoteNumber: number, state: state, startedAt: iso(started),
            answeredAt: talk.map { _ in iso(started - 0.1) }, endedAt: talk.map { iso(started - 0.1 - $0 / 60) },
            answeredByPlatform: talk == nil ? nil : platform, answeredByDevice: nil, originatingPlatform: nil,
            claimedByCurrentSession: false, failureReason: nil, recordingStatus: nil, transcript: nil,
            gatewayTimeZone: "Asia/Shanghai", occupancy: nil, contactId: nil, contactName: name, blocked: false,
            blockedEntryId: nil, unseen: unseen, simLabel: sim == "sim-work" ? "工作号" : "个人号", remoteLocation: location
        )
    }

    static var calls: [CallRecord] {
        let hour = Double(Calendar.current.component(.hour, from: .now)) * 60
        return [
            call("c-out", sim: "sim-work", dir: "outgoing", number: "138 0013 8000", name: "张伟", started: 40, talk: 252),
            call("c-missed", sim: "sim-work", dir: "incoming", number: "021 5555 0101", name: nil, started: 90, talk: nil,
                 unseen: true, location: "上海 · 电信"),
            call("c-ai", sim: "sim-personal", dir: "incoming", number: "021 6000 1234", name: "物业服务中心", started: 150,
                 talk: 75, platform: "ai", unseen: true),
            call("c-yday", sim: "sim-personal", dir: "incoming", number: "139 0013 9000", name: "李娜", started: hour + 200,
                 talk: 723),
        ]
    }

    private static func sms(_ id: String, sim: String, dir: String, number: String, name: String?, body: String,
                            minutes: Double, state: String = "received", unread: Bool = false) -> SMSMessage {
        SMSMessage(id: id, simId: sim, remoteNumber: number, conversationAddress: number, replyNumber: number, canReply: true,
                   direction: dir, body: body, state: state, missingParts: false, createdAt: iso(minutes),
                   receivedAt: dir == "incoming" ? iso(minutes) : nil, sentAt: nil, deliveredAt: nil, failureReason: nil,
                   contactId: nil, contactName: name, blocked: false, blockedEntryId: nil, unread: unread)
    }

    static var sms: [SMSMessage] {
        [
            sms("m1", sim: "sim-work", dir: "incoming", number: "10690000", name: nil,
                body: "【VoDog】验证码 482913，5 分钟内有效。", minutes: 30, unread: true),
            sms("m2", sim: "sim-work", dir: "incoming", number: "2025550102", name: "李娜", body: "明天下午三点可以吗",
                minutes: 55, unread: true),
            sms("m3", sim: "sim-work", dir: "outgoing", number: "2025550102", name: "李娜", body: "可以，到时见",
                minutes: 50, state: "sent"),
            sms("m4", sim: "sim-work", dir: "outgoing", number: "2025550102", name: "李娜", body: "我在路上",
                minutes: 5, state: "queued"),
            sms("m5", sim: "sim-work", dir: "incoming", number: "2025550101", name: "张伟", body: "收到，谢谢",
                minutes: 60 * 26),
        ]
    }

    static let contacts: [Contact] = [
        Contact(id: "ct-cj", displayName: "陈静", phones: [ContactPhone(id: "p1", rawNumber: "137 0013 7000", label: "mobile")]),
        Contact(id: "ct-ln", displayName: "李娜", phones: [ContactPhone(id: "p2", rawNumber: "139 0013 9000", label: "mobile")]),
        Contact(id: "ct-wy", displayName: "物业服务中心", phones: [ContactPhone(id: "p3", rawNumber: "021 6000 1234", label: "work")]),
        Contact(id: "ct-zw", displayName: "张伟", organization: "合作方",
                phones: [ContactPhone(id: "p4", rawNumber: "138 0013 8000", label: "mobile", location: "上海"),
                         ContactPhone(id: "p5", rawNumber: "021 6000 1234", label: "work")]),
    ]
}
#endif
