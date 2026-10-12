import Foundation
import UserNotifications

/// S104 notification categories. `INCOMING_CALL` / `CALL_ENDED` come from Control's `watchos` push; `SMS` is the
/// iPhone's mirrored notification (no server SMS push this phase).
enum WatchNotifications {
    static let answer = "ANSWER", decline = "DECLINE", sms = "SMS", callback = "CALLBACK", reply = "REPLY", copyCode = "COPY_CODE"
    static let watchCall = "WATCH_CALL", keypad = "KEYPAD", transfer = "TRANSFER"

    @MainActor static func register() {
        let center = UNUserNotificationCenter.current()
        center.delegate = WatchNotificationDelegate.shared
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "INCOMING_CALL", actions: [
                UNNotificationAction(identifier: answer, title: "接听（在 iPhone）", options: [.foreground]),
                UNNotificationAction(identifier: decline, title: "拒接", options: [.destructive]),
                UNNotificationAction(identifier: sms, title: "发短信", options: [.foreground]),
            ], intentIdentifiers: []),
            UNNotificationCategory(identifier: "CALL_ENDED", actions: [
                UNNotificationAction(identifier: callback, title: "回拨", options: [.foreground]),
                UNNotificationAction(identifier: sms, title: "发短信", options: [.foreground]),
            ], intentIdentifiers: []),
            UNNotificationCategory(identifier: "SMS", actions: [
                UNTextInputNotificationAction(identifier: reply, title: "回复", options: [],
                                              textInputButtonTitle: "发送", textInputPlaceholder: "回复…"),
                UNNotificationAction(identifier: copyCode, title: "复制验证码", options: [.foreground]),
            ], intentIdentifiers: []),
            UNNotificationCategory(identifier: watchCall, actions: [
                UNNotificationAction(identifier: keypad, title: "键盘", options: [.foreground]),
                UNNotificationAction(identifier: transfer, title: "转到 iPhone", options: [.foreground]),
            ], intentIdentifiers: []),
        ])
        #if DEBUG
        // Screenshots of the `-S104Preview` pages must not sit behind the system permission prompt.
        if ProcessInfo.processInfo.arguments.contains("-S104Preview") { return }
        #endif
        center.requestAuthorization(options: [.alert, .sound]) { @Sendable _, _ in }
    }

    /// S105d: one silent local notification per held call (`watch.call.<callId>`; re-posting replaces it).
    @MainActor static func postCall(callId: String, title: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = "通话中 · 音频在手表"
        content.categoryIdentifier = watchCall
        // S105e: `.active` was never shown over the system call screen on a real watch; second try time-sensitive.
        content.interruptionLevel = .timeSensitive
        content.userInfo = ["callId": callId]
        let request = UNNotificationRequest(identifier: "watch.call.\(callId)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { @Sendable error in
            let fields: [String: DiagValue] = (error.map { WatchDiag.error($0) } ?? [:]).merging(["level": "timeSensitive"]) { a, _ in a }
            Task { @MainActor in
                WatchDiag.log("watch.keypad.notified", level: fields.isEmpty ? "info" : "warn", callId: callId, fields)
            }
        }
    }

    @MainActor static func removeCall(_ callId: String) {
        let ids = ["watch.call.\(callId)"]
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: ids)
        center.removePendingNotificationRequests(withIdentifiers: ids)
    }
}

/// Push payload fields (`version`, `event`, `callId`, `remoteNumber`, `contactName`, `simLabel`, `remoteLocation`;
/// SMS mirror: `simId`, `remoteNumber`, `body`, `smsId`). Parsed into Sendable values before hopping to the main actor.
struct WatchPushPayload: Sendable {
    var event: String?
    var callId: String?
    var remoteNumber: String?
    var contactName: String?
    var simLabel: String?
    var simId: String?
    var remoteLocation: String?
    var body: String?
    var smsId: String?

    init(_ userInfo: [AnyHashable: Any]) {
        func s(_ key: String) -> String? { (userInfo[key] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        event = s("event"); callId = s("callId"); remoteNumber = s("remoteNumber"); contactName = s("contactName")
        simLabel = s("simLabel"); simId = s("simId"); remoteLocation = s("remoteLocation"); body = s("body"); smsId = s("smsId")
    }

    var incoming: IncomingInfo? {
        guard let callId else { return nil }
        return IncomingInfo(callId: callId, remoteNumber: remoteNumber, contactName: contactName, simLabel: simLabel,
                            remoteLocation: remoteLocation)
    }
}

final class WatchNotificationDelegate: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = WatchNotificationDelegate()

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        let content = notification.request.content
        let payload = WatchPushPayload(content.userInfo)
        let category = content.categoryIdentifier
        if category == WatchNotifications.watchCall { return [.banner, .list] } // silent; foreground banner stays tappable
        await MainActor.run {
            let store = WatchSessionStore.shared
            if category == "INCOMING_CALL", payload.event != "call.answered_elsewhere", let info = payload.incoming {
                store.incoming = info
            } else if category == "CALL_ENDED", store.incoming?.callId == payload.callId {
                store.incoming = nil
            }
        }
        return [.banner, .sound, .list]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let content = response.notification.request.content
        let payload = WatchPushPayload(content.userInfo)
        let category = content.categoryIdentifier
        let action = response.actionIdentifier
        let typed = (response as? UNTextInputNotificationResponse)?.userText
        await MainActor.run { Self.handle(category: category, action: action, payload: payload, typed: typed) }
    }

    @MainActor private static func handle(category: String, action: String, payload: WatchPushPayload, typed: String?) {
        let store = WatchSessionStore.shared
        let sims = store.sims
        let simId = payload.simId ?? sims.first { simTitle($0.id, in: sims) == payload.simLabel }?.id
            ?? SIMSelectionPolicy.preferredID(in: sims, current: nil)
        let number = PhoneNumberText.normalized(payload.remoteNumber ?? "")
        switch (category, action) {
        case (WatchNotifications.watchCall, _):
            // A stale banner after the call ended or moved to the iPhone opens nothing.
            guard let callId = payload.callId, WatchCallKit.shared.holds(callId) else { return }
            WatchDiag.log("watch.keypad.opened", callId: callId, ["action": .string(action)])
            switch action {
            case WatchNotifications.keypad:
                store.path = [.active, .keypad]
            case WatchNotifications.transfer:
                store.path = [.active]
                Task { if let failure = await WatchCallKit.shared.transferToPhone() { store.notice = failure } }
            default:
                store.path = [.active]
            }
        case ("INCOMING_CALL", WatchNotifications.answer):
            guard let info = payload.incoming else { return }
            store.incoming = info
            Task {
                let reply = await store.answer(callId: info.callId)
                if reply.ok { store.incoming = nil; store.path = [.active] } else { store.notice = reply.text }
            }
        case ("INCOMING_CALL", WatchNotifications.decline):
            guard let callId = payload.callId else { return }
            Task { if let failure = await store.decline(callId: callId) { store.notice = failure } }
        case ("INCOMING_CALL", UNNotificationDefaultActionIdentifier):
            if let info = payload.incoming { store.incoming = info }
        case (_, WatchNotifications.sms):
            guard let simId, !number.isEmpty else { return }
            store.incoming = nil
            store.path = [.conversation(simId: simId, number: number)]
        case ("CALL_ENDED", WatchNotifications.callback):
            // Opens the dial pad prefilled: the line and the 拨打 tap stay with the user.
            guard !number.isEmpty else { return }
            store.path = [.dial(number)]
        case ("SMS", WatchNotifications.reply):
            guard let simId, !number.isEmpty, let text = typed?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty
            else { return }
            Task { if let failure = await store.sendSMS(simId: simId, to: number, body: text) { store.notice = failure } }
        case ("SMS", WatchNotifications.copyCode):
            if let code = VerificationCodeText.code(in: payload.body) { store.notice = "验证码 \(code)" }
            if let smsId = payload.smsId { Task { await store.markRead([smsId]) } }
        case ("SMS", UNNotificationDefaultActionIdentifier):
            guard let simId, !number.isEmpty else { return }
            store.path = [.conversation(simId: simId, number: number)]
        case ("CALL_ENDED", UNNotificationDefaultActionIdentifier):
            store.path = [.recents]
        default:
            break
        }
    }
}
