@preconcurrency import CallKit
import Foundation
import Observation
import UIKit
@preconcurrency import WatchConnectivity

/// S104 iOS contract: the iPhone is the watch's hub. It publishes a latest-only applicationContext and serves the
/// watch's `sendMessage` commands through the app's existing call entry points.
///
/// Encoding: plist dictionaries cannot hold `null`, so a spec `null` (`session`, `activeCall`) is an absent key.
/// The refresh token is never included.
@MainActor
final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()

    private weak var session: SessionStore?
    private var expiresAt: String?
    private var sims: [SIMChannel] = []
    private var calls: [CallRecord] = []
    /// What was last sent, without `phoneReachableAt`, so a steady poll does not resend the same context.
    private var lastPublished: NSDictionary?
    /// ponytail: per-process and unbounded; a watch dials a handful of times per launch.
    private var dialRequests: [String: Task<Reply, Never>] = [:]
    /// Separate from CallCoordinator's: any CXCallController in the app targets the app's one CXProvider.
    private let callController = CXCallController()
    private var fetchedCallID: String?
    /// S105: the watch's latest `holder` report per lowercased call id ("watch" | "none"), or "phone" from an accepted handoff.
    private var watchHolders: [String: String] = [:]
    /// S105k: 30 s token check while the watch holds a live call (the phone never sees that call's 401).
    private var tokenRefreshTask: Task<Void, Never>?

    struct Reply: Sendable {
        var ok: Bool
        var callId: String?
        var code: String?
        var message: String?

        static let success = Reply(ok: true)
        static func failure(_ code: String, _ message: String) -> Reply { Reply(ok: false, code: code, message: message) }
        static let notLoggedIn = failure("NOT_LOGGED_IN", "请先在 iPhone 上登录 VoDog")
        static let noSuchCall = failure("NO_SUCH_CALL", "这通电话已不在 iPhone 上")

        var dictionary: [String: Any] {
            var value: [String: Any] = ["ok": ok]
            if let callId { value["callId"] = callId }
            if let code { value["error"] = ["code": code, "message": message ?? ""] }
            return value
        }
    }

    private enum Command: Sendable {
        case answer(callId: String)
        case dial(simId: String, remoteNumber: String, requestId: String)
        case mute(callId: String, muted: Bool)
        case handoff(callId: String, force: Bool)
        case holder(callId: String, holder: String)
        case endCall(callId: String, onlyIfRinging: Bool)
        case ping
        case refresh
        case invalid
    }

    private struct ReplyHandler: @unchecked Sendable {
        let send: ([String: Any]) -> Void
    }

    // MARK: Inputs

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
        observeSharedState()
    }

    /// SessionStore calls this after login, every credential persist (restore / refresh) and local clear.
    func sessionDidChange(_ session: SessionStore, expiresAt: String?) {
        self.session = session
        self.expiresAt = expiresAt
        if !session.isAuthenticated {
            sims = []; calls = []; dialRequests = [:]; watchHolders = [:]
            tokenRefreshTask?.cancel(); tokenRefreshTask = nil
        }
        publish()
    }

    /// CallsView's list poll: the SIM list and calls the app already holds.
    func didLoad(sims: [SIMChannel], calls: [CallRecord]) {
        self.sims = sims
        self.calls = calls
        // S105k: a call that turned terminal drops its watch-holder report; publish() resends the changed context.
        for call in calls where Self.isTerminal(call) { watchHolders[call.id.lowercased()] = nil }
        publish()
    }

    /// BadgeStore counts and the media session are `@Observable` singletons: re-arm after every change.
    private func observeSharedState() {
        withObservationTracking {
            _ = BadgeStore.shared.counts
            let media = CallMediaSession.shared
            _ = media.callID; _ = media.isMuted; _ = media.state
        } onChange: {
            Task { @MainActor in
                WatchBridge.shared.mediaCallMayHaveChanged()
                WatchBridge.shared.publish()
                WatchBridge.shared.observeSharedState()
            }
        }
    }

    /// A call that got media before the list poll saw it (e.g. answered from the lock screen): one GET fills the
    /// number, name and line for the watch. Not a poller.
    private func mediaCallMayHaveChanged() {
        guard let id = CallMediaSession.shared.callID, fetchedCallID != id,
              !calls.contains(where: { $0.id == id }), let session, let identity = session.sessionIdentity else { return }
        fetchedCallID = id
        Task { @MainActor in
            struct Envelope: Decodable, Sendable { let call: CallRecord }
            guard let detail: Envelope = try? await session.request("calls/\(id)", timeoutInterval: 8, requiredSessionIdentity: identity),
                  session.isCurrentSession(identity) else { return }
            self.merge(detail.call)
        }
    }

    private func merge(_ call: CallRecord) {
        calls.removeAll { $0.id == call.id }
        calls.insert(call, at: 0)
        publish()
    }

    // MARK: applicationContext

    private static func isTerminal(_ call: CallRecord) -> Bool { ["ending", "ended", "failed"].contains(call.state ?? "") }

    private var activeCall: CallRecord? {
        if let mediaID = CallMediaSession.shared.callID {
            return calls.first { $0.id == mediaID && !Self.isTerminal($0) }
        }
        let ringing = Set(CallCoordinator.shared.activeCallIDs)
        return calls.first { $0.state == "incoming_ringing" && ringing.contains($0.id.lowercased()) }
            ?? calls.first { ["connecting", "active"].contains($0.state ?? "") && holder(of: $0) != "none" }
    }

    private var watchHoldsLiveCall: Bool {
        calls.contains { ["connecting", "active"].contains($0.state ?? "") && holder(of: $0) == "watch" }
    }

    /// S105k: while the watch holds a live call, refresh the session within 3 min of expiry; the persist hook
    /// (`sessionDidChange`) republishes the context with the new token.
    private func armTokenRefresh() {
        guard tokenRefreshTask == nil, watchHoldsLiveCall else { return }
        tokenRefreshTask = Task { @MainActor in
            while !Task.isCancelled, watchHoldsLiveCall, let session {
                let result = await session.refreshIfExpiringSoon(within: 180)
                if result != "fresh" { Diag.shared.log("watch.token_refresh", ["result": result]) }
                try? await Task.sleep(for: .seconds(30))
            }
            tokenRefreshTask = nil
        }
    }

    /// S105: who carries this call's audio. The phone's own media wins; then the watch's latest report; then the
    /// server's record of a watch answer.
    private func holder(of call: CallRecord) -> String {
        if Self.isTerminal(call) { return "none" }
        if CallMediaSession.shared.callID?.lowercased() == call.id.lowercased() { return "phone" }
        if let reported = watchHolders[call.id.lowercased()] { return ["watch", "phone"].contains(reported) ? reported : "none" }
        return call.answeredByPlatform == "watchos" || call.originatingPlatform == "watchos" ? "watch" : "none"
    }

    private func context() -> [String: Any] {
        var value: [String: Any] = ["v": 1]
        let counts = BadgeStore.shared.counts
        value["badges"] = ["calls": counts.calls, "sms": counts.sms]
        guard let session, session.isAuthenticated, let token = session.token, let user = session.user else {
            value["sims"] = [Any]()
            return value
        }
        var sessionValue: [String: Any] = ["accessToken": token, "userId": user.id, "deviceName": UIDevice.current.name]
        if let expiresAt { sessionValue["expiresAt"] = expiresAt }
        value["session"] = sessionValue
        value["sims"] = sims.map(Self.simDictionary)
        if let call = activeCall {
            let media = CallMediaSession.shared
            var callValue: [String: Any] = ["callId": call.id, "muted": media.callID == call.id && media.isMuted]
            callValue["remoteNumber"] = call.remoteNumber
            callValue["contactName"] = call.contactName
            callValue["simLabel"] = call.simLabel
            callValue["state"] = call.state
            callValue["answeredAt"] = call.answeredAt
            callValue["holder"] = holder(of: call)
            value["activeCall"] = callValue
        }
        return value
    }

    private static func simDictionary(_ sim: SIMChannel) -> [String: Any] {
        var value: [String: Any] = ["id": sim.id]
        value["label"] = sim.label
        value["phoneLabel"] = sim.phoneLabel
        value["slotIndex"] = sim.slotIndex
        value["online"] = sim.online
        value["telephonyReady"] = sim.telephonyReady
        value["mediaReady"] = sim.mediaReady
        value["smsReady"] = sim.smsReady
        value["gatewayName"] = sim.gatewayName
        value["gatewayKind"] = sim.gatewayKind
        if let settings = sim.settings {
            value["settings"] = ["mode": settings.mode, "timeoutSeconds": settings.timeoutSeconds, "version": settings.version]
        }
        return value
    }

    func publish(force: Bool = false) {
        armTokenRefresh()
        let wc = WCSession.default
        guard WCSession.isSupported(), wc.activationState == .activated, wc.isPaired, wc.isWatchAppInstalled else { return }
        let value = context()
        let comparable = value as NSDictionary
        guard force || lastPublished != comparable else { return }
        var stamped = value
        stamped["phoneReachableAt"] = ISO8601DateFormatter().string(from: Date())
        do {
            try wc.updateApplicationContext(stamped)
            lastPublished = comparable
        } catch {
            Diag.shared.log("watch.context_failed", ["error": "\(error)"])
        }
    }

    // MARK: Commands

    private func handle(_ command: Command) async -> Reply {
        // A message can cold-launch the app ahead of `restore()`; wait as IncomingCallManager.answer does.
        let isPing = if case .ping = command { true } else { false }
        for _ in 0..<ClaimedCallPolicy.sessionWaitAttempts where !isPing && session?.sessionIdentity == nil {
            try? await Task.sleep(for: ClaimedCallPolicy.sessionWaitInterval)
        }
        switch command {
        case .ping:
            publish(force: true)
            return .success
        case .refresh:
            // S105l: the watch asks while it holds a call; this message wakes the app when the phone is locked,
            // where `armTokenRefresh` sleeps. A refreshed session publishes through sessionDidChange; force it anyway.
            guard let session else { return .notLoggedIn }
            let result = await session.refreshIfExpiringSoon(within: 600)
            Diag.shared.log("watch.token_refresh", ["result": result, "via": "watch"])
            publish(force: true)
            return result == "failed" ? .failure("API_ERROR", "续期失败") : .success
        case .invalid:
            return .failure("API_ERROR", "无法识别的手表请求")
        case let .answer(callId):
            return await answer(callId: callId)
        case let .mute(callId, muted):
            guard session?.isAuthenticated == true else { return .notLoggedIn }
            let media = CallMediaSession.shared
            guard media.callID?.lowercased() == callId.lowercased() else { return .noSuchCall }
            CallCoordinator.shared.setMuted(muted, media: media)
            return .success
        case let .handoff(callId, force):
            return await handoff(callId: callId, force: force)
        case let .holder(callId, holder):
            let terminal = calls.contains { $0.id.lowercased() == callId.lowercased() && Self.isTerminal($0) }
            watchHolders[callId.lowercased()] = terminal ? nil : holder
            publish()
            return .success
        case let .endCall(callId, onlyIfRinging):
            return await endCall(callId: callId, onlyIfRinging: onlyIfRinging)
        case let .dial(simId, remoteNumber, requestId):
            if let existing = dialRequests[requestId] { return await existing.value }
            let task = Task { @MainActor in await self.dial(simId: simId, remoteNumber: remoteNumber) }
            dialRequests[requestId] = task
            let reply = await task.value
            // Only a success is replayed from memory; a failed id may dial again, and the persistent idempotency
            // key still stops a second call if the failure was ambiguous.
            if !reply.ok { dialRequests[requestId] = nil }
            return reply
        }
    }

    /// Through CallKit, so the system call UI stays in step: CallCoordinator's CXAnswerCallAction handler runs the
    /// existing claim → media path (IncomingCallManager.answer).
    private func answer(callId: String) async -> Reply {
        guard session?.isAuthenticated == true else { return .notLoggedIn }
        let id = callId.lowercased()
        guard CallCoordinator.shared.activeCallIDs.contains(id), let uuid = UUID(uuidString: id) else { return .noSuchCall }
        if let mediaID = CallMediaSession.shared.callID, mediaID.lowercased() != id {
            return .failure("PHONE_BUSY", "iPhone 正在通话中")
        }
        do {
            try await callController.request(CXTransaction(action: CXAnswerCallAction(call: uuid)))
            return .success
        } catch {
            Diag.shared.log("watch.answer_failed", ["error": "\(error)"], callId: id)
            return .failure("API_ERROR", "接听失败，请在 iPhone 上操作")
        }
    }

    /// S105h: the watch's own `POST /calls/:id/end` failed or timed out (watchOS cuts networking when its CallKit call
    /// ends, TN3135), so the phone ends it through ReliableCallEndQueue. The queue's guarded body (owner / ringing) is
    /// what Control enforces; the cached list here only refuses calls that are visibly not ours or already over. No
    /// network before the reply: the watch holds its CallKit end action open until this answers.
    private func endCall(callId: String, onlyIfRinging: Bool) async -> Reply {
        let id = callId.lowercased()
        guard let session, session.isAuthenticated, let identity = session.sessionIdentity else {
            Diag.shared.log("watch.endCall", ["phase": "rejected", "reason": "NOT_LOGGED_IN"], callId: id)
            return .notLoggedIn
        }
        var verified = "unverified"
        if let call = calls.first(where: { $0.id.lowercased() == id }) {
            let state = call.state ?? ""
            // The cache can lag the watch's answer (still incoming_ringing), so only a live call visibly owned by
            // someone else, or one already over, is refused.
            let othersLive = ["connecting", "active"].contains(state) && call.claimedByCurrentSession != true
                && call.originatingPlatform != "watchos"
            let over = ["ended", "failed"].contains(state) || (onlyIfRinging && state != "incoming_ringing")
            guard !othersLive, !over else {
                Diag.shared.log("watch.endCall", ["phase": "rejected", "state": state, "onlyIfRinging": onlyIfRinging],
                                callId: id)
                return .noSuchCall
            }
            verified = state
        }
        // ponytail: a call missing from the cached list still enqueues; the guarded end body is the real ownership check on Control.
        ReliableCallEndQueue.shared.enqueue(callID: id, session: session, sessionIdentity: identity,
                                            constraint: onlyIfRinging ? .ringingUnclaimed : .currentSessionOwner)
        watchHolders[id] = "none"
        publish()
        Diag.shared.log("watch.endCall", ["phase": "enqueued", "state": verified, "onlyIfRinging": onlyIfRinging],
                        callId: id)
        return .success
    }

    /// S105: the watch has already stopped its leg; the phone takes the audio outside CallKit. CallsView presents
    /// its full-screen call from `media.callID`, so no explicit presentation step is needed.
    private func handoff(callId: String, force: Bool) async -> Reply {
        let reply = await performHandoff(callId: callId, force: force)
        var fields: [String: Any] = ["phase": reply.ok ? "success" : "failure", "force": force,
                                     "holder": watchHolders[callId.lowercased()] ?? "unknown"]
        if let state = calls.first(where: { $0.id.lowercased() == callId.lowercased() })?.state { fields["state"] = state }
        if let code = reply.code { fields["reason"] = code }
        Diag.shared.log("watch.handoff", fields, callId: callId.lowercased())
        return reply
    }

    /// S105i: the iPhone's 「转到 iPhone」. The watch's own button is unreachable behind watchOS's modal call UI, so the
    /// phone announces itself as holder, asks the watch to release its leg (best effort, 3 s), then joins exactly
    /// like an accepted handoff. Returns nil on success, else a user-readable message.
    func pullCall(callId: String) async -> String? {
        let id = callId.lowercased()
        let previous = watchHolders[id]
        watchHolders[id] = "phone"
        publish()
        // S105j: the watch app is usually backgrounded under the system call screen (unreachable), so the message
        // alone never arrives; a queued userInfo is delivered in the background. The watch dedupes all three paths.
        let userInfo = queueRelease(callId: callId)
        let watchReply = await releaseWatch(callId: callId)
        let reply = await performHandoff(callId: callId, force: true)
        if !reply.ok { watchHolders[id] = previous; publish() }
        Diag.shared.log("watch.pull", ["callId": id, "watchReply": watchReply, "userInfo": userInfo,
                                       "result": reply.ok ? "ok" : (reply.code ?? "failure")], callId: id)
        return reply.ok ? nil : (reply.message ?? "转移失败")
    }

    /// S105j: queued WC `release` (survives the watch app being backgrounded). Returns "queued:<n outstanding>" or why not.
    private func queueRelease(callId: String) -> String {
        let wc = WCSession.default
        guard WCSession.isSupported(), wc.activationState == .activated else { return "inactive" }
        guard wc.isPaired, wc.isWatchAppInstalled else { return "no_watch_app" }
        let at = Int64(Date().timeIntervalSince1970 * 1000)
        let transfer = wc.transferUserInfo(["kind": "release", "callId": callId, "at": at])
        return "queued:\(wc.outstandingUserInfoTransfers.count):\(transfer.isTransferring)"
    }

    /// "ok" | "rejected" | "error" | "timeout" | "unreachable"; the caller continues regardless.
    private func releaseWatch(callId: String) async -> String {
        let wc = WCSession.default
        guard WCSession.isSupported(), wc.activationState == .activated, wc.isReachable else { return "unreachable" }
        return await withCheckedContinuation { (continuation: CheckedContinuation<String, Never>) in
            let once = ResumeOnce(continuation)
            wc.sendMessage(["kind": "release", "callId": callId], replyHandler: { reply in
                once.resume((reply["ok"] as? Bool) == true ? "ok" : "rejected")
            }, errorHandler: { _ in once.resume("error") })
            Task { try? await Task.sleep(for: .seconds(3)); once.resume("timeout") }
        }
    }

    private final class ResumeOnce: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<String, Never>?
        init(_ continuation: CheckedContinuation<String, Never>) { self.continuation = continuation }
        func resume(_ value: String) {
            lock.lock(); let pending = continuation; continuation = nil; lock.unlock()
            pending?.resume(returning: value)
        }
    }

    private func performHandoff(callId: String, force: Bool) async -> Reply {
        let holderReport = watchHolders[callId.lowercased()] ?? "unknown"
        Diag.shared.log("watch.handoff", ["phase": "request", "force": force, "holder": holderReport], callId: callId.lowercased())
        // The two legs fight when the phone joins audio the watch still carries; only the explicit user action may.
        if holderReport == "watch", !force {
            return .failure("WATCH_HOLDS_AUDIO", "手表正在通话，请在手表上转到 iPhone")
        }
        guard let session, session.isAuthenticated, let identity = session.sessionIdentity else { return .notLoggedIn }
        let media = CallMediaSession.shared
        if let mediaID = media.callID, mediaID.lowercased() != callId.lowercased() {
            return .failure("PHONE_BUSY", "iPhone 正在通话中")
        }
        struct Envelope: Decodable, Sendable { let call: CallRecord }
        let call: CallRecord
        do {
            let detail: Envelope = try await session.request(
                "calls/\(callId)", timeoutInterval: 8, requiredSessionIdentity: identity
            )
            call = detail.call
        } catch {
            return .failure("API_ERROR", "无法读取通话状态：\(error.localizedDescription)")
        }
        guard session.isCurrentSession(identity) else { return .notLoggedIn }
        guard call.claimedByCurrentSession == true || call.originatingPlatform == "watchos",
              ["connecting", "active"].contains(call.state ?? "") else { return .noSuchCall }
        IncomingCallManager.shared.registerOwnedCall(id: call.id, sessionIdentity: identity)
        // Flip the published holder now, before media connects, so the watch does not keep its leg open.
        watchHolders[call.id.lowercased()] = "phone"
        merge(call)
        await media.start(
            callID: call.id, session: session, transport: .udp,
            managedByCallKit: false, automaticallyRetryTLS: true
        ) { [weak session] failedCallID in
            guard let session, session.isCurrentSession(identity) else { return }
            ReliableCallEndQueue.shared.enqueue(callID: failedCallID, session: session, sessionIdentity: identity)
        }
        if media.callID?.lowercased() == call.id.lowercased(), case let .failed(_, message) = media.state {
            watchHolders[call.id.lowercased()] = nil
            return .failure("API_ERROR", message)
        }
        return .success
    }

    /// Mirrors CallsView.dial: the same idempotency store, POST, owned-call registration and media start.
    private func dial(simId: String, remoteNumber: String) async -> Reply {
        guard let session, session.isAuthenticated, let accountID = session.user?.id,
              let identity = session.sessionIdentity else { return .notLoggedIn }
        guard CallAvailabilityPolicy.canStartOutbound(currentMediaCallID: CallMediaSession.shared.callID) else {
            return .failure("PHONE_BUSY", "iPhone 正在通话中")
        }
        let payload = OutboundCallPayload(simId: simId, remoteNumber: PhoneNumberText.normalized(remoteNumber))
        guard PhoneNumberText.isDialable(payload.remoteNumber) else {
            return .failure("API_ERROR", "号码格式不正确，无法拨打")
        }
        if sims.isEmpty, let fresh: ItemEnvelope<SIMChannel> = try? await session.request(
            "sims", timeoutInterval: CallRefreshCadencePolicy.pollRequestTimeout, requiredSessionIdentity: identity
        ) { sims = fresh.items }
        guard SIMSelectionPolicy.canDial(on: simId, sims: sims) else {
            return .failure("SIM_NOT_READY", "该线路暂不可拨打")
        }
        let key = OutboundCallIdempotencyStore.shared.key(accountID: accountID, payload: payload)
        struct Envelope: Decodable, Sendable { let call: CallRecord }
        do {
            let response: Envelope = try await session.request(
                "calls/outbound", method: "POST", body: payload, idempotencyKey: key,
                requiredSessionIdentity: identity
            )
            Diag.shared.log("dial.request", ["simId": simId, "numberLength": payload.remoteNumber.count,
                                             "transport": "watch", "code": 200], callId: response.call.id)
            IncomingCallManager.shared.registerOwnedCall(id: response.call.id, sessionIdentity: identity)
            guard session.isCurrentSession(identity) else { return .notLoggedIn }
            OutboundCallIdempotencyStore.shared.markSucceeded(accountID: accountID, payload: payload, idempotencyKey: key)
            merge(response.call)
            let callID = response.call.id
            Task { @MainActor [session] in
                await CallMediaSession.shared.start(callID: callID, session: session, automaticallyRetryTLS: true) { [weak session] failedCallID in
                    guard let session, session.isCurrentSession(identity) else { return }
                    ReliableCallEndQueue.shared.enqueue(callID: failedCallID, session: session, sessionIdentity: identity)
                }
            }
            return Reply(ok: true, callId: callID)
        } catch SessionLifecycleError.staleSession {
            return .notLoggedIn
        } catch APIError.unauthorized {
            return .notLoggedIn
        } catch {
            Diag.shared.log("dial.request", ["simId": simId, "transport": "watch",
                                             "code": (error as? APIError)?.diagCode ?? -1])
            return Self.dialFailure(error)
        }
    }

    private static func dialFailure(_ error: Error) -> Reply {
        let message = APIError.dialMessage(for: error)
        switch (error as? APIError)?.serverCode {
        case "GATEWAY_BUSY", "TELECOM_STATE_UNKNOWN": return .failure("PHONE_BUSY", message)
        case "GATEWAY_OFFLINE", "GATEWAY_NOT_READY", "MEDIA_UNAVAILABLE", "NOT_FOUND": return .failure("SIM_NOT_READY", message)
        default: return .failure("API_ERROR", message)
        }
    }

    // MARK: WCSessionDelegate (callbacks arrive off-main)

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        Task { @MainActor in WatchBridge.shared.publish(force: true) }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        // Switching watches: reactivate for the newly paired one.
        WCSession.default.activate()
    }

    nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
        Task { @MainActor in WatchBridge.shared.publish(force: true) }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any],
                             replyHandler: @escaping ([String: Any]) -> Void) {
        let command = Self.command(message)
        let reply = ReplyHandler(send: replyHandler)
        Task { @MainActor in
            let result = await WatchBridge.shared.handle(command)
            reply.send(result.dictionary)
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        let command = Self.command(message)
        Task { @MainActor in _ = await WatchBridge.shared.handle(command) }
    }

    /// S105l: queued fallback for `refresh` when the watch could not reach the phone by message.
    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        let command = Self.command(userInfo)
        Task { @MainActor in _ = await WatchBridge.shared.handle(command) }
    }

    nonisolated private static func command(_ message: [String: Any]) -> Command {
        switch message["kind"] as? String {
        case "ping": return .ping
        case "refresh": return .refresh
        case "answer":
            guard let callId = message["callId"] as? String else { return .invalid }
            return .answer(callId: callId)
        case "mute":
            guard let callId = message["callId"] as? String, let muted = message["muted"] as? Bool else { return .invalid }
            return .mute(callId: callId, muted: muted)
        case "handoff":
            guard let callId = message["callId"] as? String else { return .invalid }
            return .handoff(callId: callId, force: message["force"] as? Bool ?? false)
        case "holder":
            guard let callId = message["callId"] as? String, let holder = message["holder"] as? String else { return .invalid }
            return .holder(callId: callId, holder: holder)
        case "endCall":
            guard let callId = message["callId"] as? String else { return .invalid }
            return .endCall(callId: callId, onlyIfRinging: message["onlyIfRinging"] as? Bool ?? false)
        case "dial":
            guard let simId = message["simId"] as? String, let remoteNumber = message["remoteNumber"] as? String,
                  let requestId = message["requestId"] as? String else { return .invalid }
            return .dial(simId: simId, remoteNumber: remoteNumber, requestId: requestId)
        default: return .invalid
        }
    }
}
