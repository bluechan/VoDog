import AVFAudio
import CallKit
import Foundation
import Observation
import PushKit
import WatchKit

// MARK: - S105 audio leg contract (implemented in WatchAudioLeg.swift)

enum WatchAudioRoute: Sendable, Equatable {
    /// Default. A connected Bluetooth headset takes over automatically (`.bluetooth`).
    case speaker, earpiece, bluetooth
}

@MainActor @Observable
final class WatchAudioStats {
    enum State: Sendable, Equatable {
        case idle, connecting, connected, reconnecting(attempt: Int), failed(String), stopped
    }
    var state: State = .idle
    var rttP50Ms: Double?
    var rttP95Ms: Double?
    var sent = 0
    var received = 0
    var lost = 0
    var underruns = 0
    var tails = 0 // S108 underrun tail fades
    /// Playback re-starts after an underrun (each with a 5 ms fade-in).
    var restarts = 0
    /// Jitter buffer depth (queued + scheduled frames).
    var bufferMs = 0
    var inputLevelDb: Double = -160
    var route: WatchAudioRoute = .speaker

    init() {}
}

@MainActor protocol WatchAudioLegging: AnyObject {
    var stats: WatchAudioStats { get }            // @Observable: state, rttMs p50/p95, sent/received/lost, underruns, inputLevelDb, route
    func prewarm(callId: String, token: String, attempt: Int) async -> Bool // opens the TLS WebSocket only, no hello; idempotent; true = retryable network error
    var onConnected: (@MainActor () -> Void)? { get set }                            // every transition to .connected (incl. reconnect)
    var currentToken: (@MainActor () -> String?)? { get set }                       // S105k: read before every socket open
    func rotateToken(_ token: String)                                      // S105k: re-auth the open socket in place
    func start(callId: String, token: String, frameMs: Int) async throws   // opens WebSocket + hello first, engine on didActivate
    func audioSessionDidActivate(_ session: AVAudioSession)              // forwarded from CXProviderDelegate
    func audioSessionDidDeactivate(_ session: AVAudioSession)
    func stop() async                                                      // closes socket (bridge leg leaves), stops engine
    func setMuted(_ muted: Bool)
    func route(_ route: WatchAudioRoute)                                   // .speaker (default) / .earpiece / .bluetooth(auto when connected)
}

// MARK: - CallKit + PushKit

/// Why the watch's CallKit call ends. `transferred` (S105) has no CallKit counterpart: the call goes on on the iPhone,
/// so it is reported as answered elsewhere and never sends `/end`.
enum WatchCallEnd {
    case remoteEnded, failed, unanswered, answeredElsewhere, transferred

    var reason: CXCallEndedReason {
        switch self {
        case .remoteEnded: .remoteEnded
        case .failed: .failed
        case .unanswered: .unanswered
        case .answeredElsewhere, .transferred: .answeredElsewhere
        }
    }
}

/// S105 watch CallKit: one call at a time, keyed by the Control call id as UUID (same as iOS). The watch holds the
/// audio (`holder == .watch`) from answer / dial until the call ends or is transferred to the iPhone.
@MainActor @Observable
final class WatchCallKit {
    static let shared = WatchCallKit()

    struct Call: Equatable {
        let uuid: UUID
        let callId: String
        let outgoing: Bool
        /// Answered here (incoming) or dialled here (outgoing): the watch holds the audio.
        var answered: Bool
        var connectedReported = false
    }

    private(set) var current: Call?
    /// S105e post-dial DTMF for the outgoing call (`,1,3`): keyed in once the call is active and the leg connected.
    struct PostDial: Equatable {
        enum Status: Equatable { case pending, sending, done, failed }
        let callId: String
        let sequence: String
        var status = Status.pending
        /// Digits masked for display (`,•,•`): they can be a PIN.
        var masked: String { String(sequence.map { $0 == "," ? "," : "•" }) }
    }
    private(set) var postDial: PostDial?
    @ObservationIgnored let audioLeg: any WatchAudioLegging = WatchAudioLeg()
    @ObservationIgnored private let controller = CXCallController()
    @ObservationIgnored private var delegate: WatchCallKitDelegate?
    @ObservationIgnored private var registry: PKPushRegistry?
    /// S105j: call being released; message, userInfo and context can all arrive, only the first one acts.
    @ObservationIgnored private var releasing: String?
    @ObservationIgnored private var watchdog: Task<Void, Never>?

    private init() {}

    /// At launch, before a VoIP push can arrive.
    func start() {
        guard delegate == nil else { return }
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.phoneNumber]
        let delegate = WatchCallKitDelegate(provider: CXProvider(configuration: config))
        delegate.provider.setDelegate(delegate, queue: nil)
        self.delegate = delegate
        audioLeg.onConnected = { [weak self] in self?.notifyActive() }
        audioLeg.currentToken = { WatchSessionStore.shared.context?.session?.accessToken }
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = delegate
        registry.desiredPushTypes = [.voIP]
        self.registry = registry
    }

    private var provider: CXProvider? { delegate?.provider }
    private var store: WatchSessionStore { .shared }

    func isRinging(_ callId: String) -> Bool {
        guard let current else { return false }
        return !current.outgoing && !current.answered && current.callId == callId.lowercased()
    }

    func holds(_ callId: String) -> Bool { current?.answered == true && current?.callId == callId.lowercased() }

    // MARK: Requests (app UI → CallKit, so the system call UI stays in sync)

    func requestAnswer() async -> String? {
        guard let current else { return "这通电话已结束" }
        return await request(CXAnswerCallAction(call: current.uuid))
    }

    func requestEnd() async -> String? {
        guard let current else { return nil }
        return await request(CXEndCallAction(call: current.uuid))
    }

    func requestMute(_ muted: Bool) async -> String? {
        guard let current else { return nil }
        return await request(CXSetMutedCallAction(call: current.uuid, muted: muted))
    }

    /// After `POST /calls/outbound` returned `callId`. A refused CallKit start ends the server call: it is owned the
    /// moment its id came back (S20 decision 6).
    func startOutgoing(callId: String, number: String, postDial: String = "") async -> String? {
        guard current == nil, let uuid = UUID(uuidString: callId) else {
            store.watchCallEnded(callId)
            _ = await store.endOnServer(callId: callId)
            return "手表已有通话"
        }
        current = Call(uuid: uuid, callId: callId.lowercased(), outgoing: true, answered: true)
        self.postDial = postDial.contains(where: { "0123456789*#".contains($0) })
            ? PostDial(callId: callId.lowercased(), sequence: postDial) : nil
        WatchDiag.callBegan()
        if let error = await request(CXStartCallAction(call: uuid, handle: CXHandle(type: .phoneNumber, value: number))) {
            if current?.uuid == uuid { current = nil; self.postDial = nil; store.watchCallEnded(callId); WatchDiag.callEnded() }
            _ = await store.endOnServer(callId: callId)
            return error
        }
        store.trackWatchCall(callId)
        return nil
    }

    /// Opens the bridge socket ahead of time (ring / outgoing start accepted): on Wi-Fi only it took 8 s, longer than
    /// a ring. Only inside a live CallKit call — watchOS blocks sockets outside one — and never after it ended.
    /// S105d: -1009 / connection lost (networking not yet allowed) → retry after 1 s, then 2 s, only while this call is live.
    func prewarm() async {
        guard let call = current else { return }
        for (attempt, delay) in [Duration.zero, .seconds(1), .seconds(2)].enumerated() {
            if attempt > 0 { try? await Task.sleep(for: delay) }
            guard current?.uuid == call.uuid, let token = store.context?.session?.accessToken else { return }
            guard await audioLeg.prewarm(callId: call.callId, token: token, attempt: attempt + 1) else { return }
        }
    }

    /// S105d: the system call screen has only mute, so a local notification is the way back to the app's call page
    /// (「键盘」). Posted when the watch holds the audio, the call is active and the leg is connected;
    /// a reconnect re-posts it under the same identifier (replaces, never stacks).
    private func notifyActive() {
        guard let call = current, call.answered, !call.outgoing || call.connectedReported,
              audioLeg.stats.state == .connected else { return }
        // S105f: the call notification (both .active and .timeSensitive) never surfaced over the modal system call
        // screen on a real watch (build 95/96 diag), so it is no longer posted; the keypad lives on the iPhone call page
        // and in the post-dial preset below.
        if call.outgoing { Task { await runPostDial(callId: call.callId) } }
    }

    /// S105e: each `,` waits 1.5 s, then the group's digits go one by one (200 ms apart) through the keypad route.
    /// Runs once per call (a leg reconnect re-enters `notifyActive` and finds it no longer pending); stops when the
    /// call ends or a digit fails. Logs counts only, never the digits.
    private func runPostDial(callId: String) async {
        guard var pending = postDial, pending.callId == callId, pending.status == .pending else { return }
        pending.status = .sending
        postDial = pending
        for (index, group) in pending.sequence.split(separator: ",", omittingEmptySubsequences: false).enumerated() {
            if index > 0 { try? await Task.sleep(for: .milliseconds(1500)) }
            var status = "ok"
            for (offset, digit) in group.enumerated() {
                if offset > 0 { try? await Task.sleep(for: .milliseconds(200)) }
                guard current?.callId == callId, postDial?.callId == callId else { status = "ended"; break }
                if await store.dtmf(callId: callId, digit: String(digit)) != nil { status = "error"; break }
            }
            if !group.isEmpty || status != "ok" {
                WatchDiag.log("watch.dtmf.auto", level: status == "ok" ? "info" : "warn", callId: callId,
                              ["group": .int(index), "digits": .int(group.count), "status": .string(status)])
            }
            guard status == "ok" else {
                if postDial?.callId == callId { postDial?.status = .failed }
                return
            }
        }
        if postDial?.callId == callId { postDial?.status = .done }
    }

    private func request(_ action: CXAction) async -> String? {
        await withCheckedContinuation { continuation in
            controller.request(CXTransaction(action: action)) { @Sendable error in
                continuation.resume(returning: error?.localizedDescription)
            }
        }
    }

    // MARK: Transfer (S105 v1: watch → iPhone)

    /// Legacy watch-initiated transfer; only the (no longer posted, S105f) call notification's action reaches it.
    /// Stop the leg first (otherwise its S73 reconnect wins the bridge leg back), then WC `handoff` with `force`.
    /// Success ends the watch call as `transferred` (no `/end`); failure brings the watch leg back.
    func transferToPhone() async -> String? {
        guard let call = current, call.answered else { return nil }
        await audioLeg.stop()
        let reply = await store.send(["kind": "handoff", "callId": call.callId, "force": true])
        WatchDiag.log("watch.handoff", level: reply.ok ? "info" : "warn", callId: call.callId,
                      reply.ok ? ["result": "ok"] : ["result": "failed", "error": .string(reply.text)])
        guard current?.uuid == call.uuid else { return nil }
        if reply.ok {
            end(.transferred, stopLeg: false)
            return nil
        }
        await startLeg()
        return "转移失败"
    }

    /// S105i: the iPhone pulled the call (WC `release`, or its context says `holder == "phone"` when the leg was
    /// replaced). Fade the leg out, then end the CallKit call as `transferred`: no `/end`, no iPhone `endCall`, no
    /// `holder none` (the iPhone holds it now). False when the watch does not hold this call.
    func release(callId: String, via: String) async -> Bool {
        guard releasing != callId.lowercased() else {
            WatchDiag.log("watch.release", callId: callId, ["via": .string(via), "result": "duplicate"])
            return true
        }
        guard holds(callId), let call = current else {
            WatchDiag.log("watch.release", level: "warn", callId: callId, ["via": .string(via), "result": "no_such_call"])
            return false
        }
        releasing = call.callId
        defer { releasing = nil }
        await audioLeg.stop()
        if current?.uuid == call.uuid { end(.transferred, stopLeg: false) }
        WatchDiag.log("watch.release", callId: callId, ["via": .string(via), "result": "ok"])
        return true
    }

    /// Leg lost / retrying: if the iPhone's context says it holds this call, release instead of reconnecting (a
    /// reconnect would take the bridge leg back from the iPhone). True = do not reconnect.
    func releaseIfPhoneHolds(_ callId: String) -> Bool {
        guard holds(callId), store.phoneHolds(callId) else { return false }
        Task { _ = await release(callId: callId, via: "context") }
        return true
    }

    /// Start the watch leg; on failure retry after 1 s / 3 s / 5 s while this call is still live. All failed → the
    /// leg stays `.failed` and page 4 shows 「音频中断，可在 iPhone 上转接」; the CallKit call stays up. Stops retrying once the iPhone holds it.
    private func startLeg() async {
        guard let call = current, call.answered else { return }
        for (attempt, delay) in ([Duration.zero] + reconnectDelays).enumerated() {
            if attempt > 0 {
                guard current?.uuid == call.uuid else { return }
                // Keep 「音频中断」 hidden between attempts: it is only for when every retry failed.
                audioLeg.stats.state = .reconnecting(attempt: attempt)
                try? await Task.sleep(for: delay)
            }
            guard current?.uuid == call.uuid, !releaseIfPhoneHolds(call.callId) else { return }
            guard let token = store.context?.session?.accessToken else {
                audioLeg.stats.state = .failed("未登录")
                return
            }
            do {
                try await audioLeg.start(callId: call.callId, token: token, frameMs: 40)
                guard current?.uuid == call.uuid else { return }
                // Tell the iPhone the watch holds the audio, so it refuses a non-forced handoff.
                Task { _ = await store.send(["kind": "holder", "callId": call.callId, "holder": "watch"]) }
                startWatchdog(call)
                return
            } catch {}
        }
    }

    /// S105j: leg `connected` but no downlink for 4 s while the iPhone's context says it holds the call → the bridge
    /// leg went to the iPhone and every release message was missed: release. Holder not phone: leave the leg's own
    /// reconnect logic alone.
    private func startWatchdog(_ call: Call) {
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            var lastReceived = -1
            var lastChange = ContinuousClock.now
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, self.current?.uuid == call.uuid else { return }
                let stats = self.audioLeg.stats
                if stats.received != lastReceived || stats.state != .connected {
                    lastReceived = stats.received
                    lastChange = .now
                    continue
                }
                if ContinuousClock.now - lastChange >= .seconds(4), self.store.phoneHolds(call.callId) {
                    _ = await self.release(callId: call.callId, via: "watchdog")
                    return
                }
            }
        }
    }

    // MARK: Local end

    func end(_ end: WatchCallEnd, stopLeg: Bool = true) {
        guard let call = current else { return }
        current = nil
        provider?.reportCall(with: call.uuid, endedAt: nil, reason: end.reason)
        finish(call, stopLeg: stopLeg, reason: "\(end)")
    }

    /// The call is over (`current` already cleared, so a late leg error can no longer reach page 4 or a notice).
    /// No audio notice is raised for a call (S105b), so there is none to clear here; 接听失败 / 结束失败 stay visible.
    /// `reason` nil: the caller already logged `watch.callkit.end` (S105h, with the server-end outcome).
    private func finish(_ call: Call, stopLeg: Bool, reason: String?) {
        if postDial?.callId == call.callId { postDial = nil }
        store.watchCallEnded(call.callId)
        WatchNotifications.removeCall(call.callId)
        if stopLeg && call.answered {
            Task {
                await audioLeg.stop()
                _ = await store.send(["kind": "holder", "callId": call.callId, "holder": "none"])
            }
        }
        if let reason { WatchDiag.log("watch.callkit.end", callId: call.callId, ["reason": .string(reason)]) }
        WatchDiag.callEnded()
    }

    /// Poll result for the tracked call (`GET /calls/:id`, every 3 s from report time).
    func apply(_ record: CallRecord) {
        guard var call = current, call.callId == record.id.lowercased() else { return }
        let device = WKInterfaceDevice.current().name
        switch record.state {
        case "ended", "failed":
            if call.answered {
                end(record.state == "failed" ? .failed : .remoteEnded)
            } else {
                end((record.answeredAt ?? "").isEmpty ? .unanswered : .answeredElsewhere)
            }
        default:
            if !call.answered && !call.outgoing && record.state != "incoming_ringing" && record.answeredByDevice != device {
                end(.answeredElsewhere)
            } else if call.outgoing && record.state == "active" && !call.connectedReported {
                provider?.reportOutgoingCall(with: call.uuid, connectedAt: nil)
                call.connectedReported = true
                current = call
                notifyActive()
            }
        }
    }

    // MARK: Provider delegate (main actor side)

    fileprivate func didReportIncoming(_ info: IncomingInfo, uuid: UUID) {
        guard current == nil else {
            // Already in a call on the watch: let this one ring on the iPhone only.
            provider?.reportCall(with: uuid, endedAt: nil, reason: .failed)
            return
        }
        current = Call(uuid: uuid, callId: info.callId.lowercased(), outgoing: false, answered: false)
        store.incoming = info
        store.trackWatchCall(info.callId)
        WatchDiag.callBegan()
        WatchDiag.log("watch.callkit.report", callId: info.callId)
        Task { await prewarm() }
    }

    fileprivate func answer(_ action: CXAnswerCallAction) async {
        guard var call = current, call.uuid == action.callUUID, !call.answered else { action.fail(); return }
        let device = WKInterfaceDevice.current().name
        // Page 4 opens as soon as the answer transaction is accepted: give it the ringing call while claiming.
        if let info = store.incoming, info.callId.lowercased() == call.callId {
            store.watchCall = WatchContext.ActiveCall(callId: call.callId, remoteNumber: info.remoteNumber,
                                                      contactName: info.contactName, simLabel: info.simLabel,
                                                      state: "connecting", muted: false)
        }
        let record: CallRecord
        let started = ContinuousClock.now
        do {
            record = try await store.claim(callId: call.callId, deviceName: device)
        } catch APIError.server(409, _, _) {
            WatchDiag.log("watch.callkit.answer", level: "warn", callId: call.callId,
                          ["claimMs": .int(started.msSince), "result": "conflict"])
            action.fail(); end(.answeredElsewhere); return
        } catch {
            WatchDiag.log("watch.callkit.answer", level: "warn", callId: call.callId,
                          WatchDiag.error(error, ["claimMs": .int(started.msSince), "result": "error"]))
            action.fail(); store.notice = "接听失败：\(error.localizedDescription)"; end(.failed); return
        }
        let mine = record.answeredByDevice == device
        WatchDiag.log("watch.callkit.answer", callId: call.callId,
                      ["claimMs": .int(started.msSince), "answeredByDevice": .string(record.answeredByDevice ?? ""),
                       "result": mine ? "ok" : "elsewhere"])
        guard current?.uuid == call.uuid else { action.fail(); return }
        // Same-session replay returns the first claimant: the iPhone may have answered with our shared token.
        guard mine else { action.fail(); end(.answeredElsewhere); return }
        call.answered = true
        current = call
        action.fulfill()
        store.incoming = nil
        store.watchCall = WatchContext.ActiveCall(
            callId: call.callId, remoteNumber: record.remoteNumber, contactName: record.contactName,
            simLabel: record.simLabel, state: record.state, answeredAt: record.answeredAt, muted: false
        )
        store.path = [.active]
        await startLeg()
    }

    fileprivate func start(_ action: CXStartCallAction) async {
        guard let call = current, call.uuid == action.callUUID else { action.fail(); return }
        provider?.reportOutgoingCall(with: call.uuid, startedConnectingAt: nil)
        action.fulfill()
        // S105d: outbound starts the leg directly (it opens its own socket and retries); the prewarm retry
        // loop is for incoming calls, where ringing gives it seconds. Waiting here only delayed first audio.
        await startLeg()
    }

    fileprivate func end(_ action: CXEndCallAction) async {
        guard let call = current, call.uuid == action.callUUID else { action.fulfill(); return }
        current = nil
        // S110: a leg that is not connected at hangup (reconnecting / failed = no usable path, e.g. tethered to an
        // offline iPhone) gets short bounds, so the watch closes in ~2–3 s instead of ~9 s and says so.
        let offline: Bool = { if case .connected = audioLeg.stats.state { return false }; return call.answered }()
        // S105f: fade out and stop the leg BEFORE fulfilling — fulfilling first lets CallKit deactivate the audio
        // session while the engine is still rendering (the hangup pop). The fade is ~30 ms.
        if call.answered { await audioLeg.stop() }
        // S105h: watchOS cuts networking once the CallKit call ends (TN3135); the end POST and the diag flush must
        // land before `fulfill`, or the far end stays connected (real-device S105 call).
        await endRemotely(call, reason: "local", offline: offline)
        action.fulfill()
        finish(call, stopLeg: false, reason: nil)
        if call.answered { _ = await store.send(["kind": "holder", "callId": call.callId, "holder": "none"]) }
    }

    /// Server end (decline while ringing) bounded to 4 s; on failure / timeout the iPhone ends it through its
    /// ReliableCallEndQueue over WatchConnectivity (Bluetooth, not cut by TN3135). Then the diag flush, bounded to 2 s.
    private func endRemotely(_ call: Call, reason: String, offline: Bool = false) async {
        let store = self.store
        let callId = call.callId
        let answered = call.answered
        let outcome = await Self.bounded(seconds: offline ? 1.5 : 4) { @MainActor in
            answered ? await store.endOnServer(callId: callId) : await store.declineOnServer(callId: callId)
        }
        let serverEnd = switch outcome { case .none: "timeout"; case .some(.none): "ok"; case .some(.some): "failed" }
        var fields: [String: DiagValue] = ["reason": .string(reason), "serverEnd": .string(serverEnd), "fallback": "none", "offline": .bool(offline)]
        if serverEnd != "ok" {
            let reply = await Self.bounded(seconds: offline ? 1 : 3) { @MainActor in
                await store.send(answered ? ["kind": "endCall", "callId": callId]
                                          : ["kind": "endCall", "callId": callId, "onlyIfRinging": true])
            }
            let iphoneOk = reply?.ok == true
            fields["fallback"] = "iphone"
            fields["iphoneOk"] = .bool(iphoneOk)
            if !iphoneOk { store.rememberPendingEnd(callId) } // S111: retried on foreground / iPhone reachable
            if !iphoneOk, offline { store.notice = "无网络，已在手表结束；联网后自动补挂" }
            else if !iphoneOk, case let .some(.some(failure)) = outcome { store.notice = failure }
            else if !iphoneOk { store.notice = "结束超时，请在 iPhone 上挂断" }
        }
        WatchDiag.log("watch.callkit.end", callId: callId, fields)
        _ = await Self.bounded(seconds: offline ? 0.5 : 2) { @MainActor in await WatchDiag.flush() } // S109 keeps what fails
    }

    /// `nil` when `seconds` pass first. The operation is not cancelled: a late POST may still land and a late flush
    /// still sends its queue (a cancelled flush would drop it), and a WC send never observes cancellation anyway.
    private static func bounded<T: Sendable>(
        seconds: Double, _ operation: @escaping @MainActor @Sendable () async -> T
    ) async -> T? {
        let once = ResumeOnce()
        return await withCheckedContinuation { (continuation: CheckedContinuation<T?, Never>) in
            Task { @MainActor in
                let value = await operation()
                if once.claim() { continuation.resume(returning: value) }
            }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(seconds))
                if once.claim() { continuation.resume(returning: nil) }
            }
        }
    }

    fileprivate func mute(_ action: CXSetMutedCallAction) {
        guard current?.uuid == action.callUUID else { action.fail(); return }
        WatchDiag.log("watch.callkit.mute", callId: current?.callId, ["muted": .bool(action.isMuted)])
        audioLeg.setMuted(action.isMuted)
        store.watchCall?.muted = action.isMuted
        action.fulfill()
    }

    /// S105c: the system call screen may offer a keypad; CallKit delivers its digits here (same route as the app page).
    fileprivate func playDTMF(_ action: CXPlayDTMFCallAction) async {
        guard let call = current, call.uuid == action.callUUID else { action.fail(); return }
        let digits = action.digits.filter { "0123456789*#".contains($0) }
        guard !digits.isEmpty else { action.fail(); return }
        var failed = false
        for digit in digits where await store.dtmf(callId: call.callId, digit: String(digit)) != nil { failed = true }
        if failed { action.fail() } else { action.fulfill() }
    }

    /// S105h: a reset drops the call without an end action; a live call still gets one bounded server end.
    fileprivate func reset() async {
        guard let call = current else { return }
        current = nil
        await endRemotely(call, reason: "reset")
        finish(call, stopLeg: true, reason: nil)
    }
}

@MainActor private final class ResumeOnce {
    private var done = false
    func claim() -> Bool { defer { done = true }; return !done }
}

/// Values handed from CallKit / PushKit queues to the main actor. Only used for objects the main actor then owns.
private struct Unchecked<Value>: @unchecked Sendable { let value: Value }

/// CallKit and PushKit callbacks arrive off the main actor; each hops explicitly (never `assumeIsolated`). The VoIP
/// report itself happens here, before `completion`, because PushKit kills an app that returns without one.
private final class WatchCallKitDelegate: NSObject, CXProviderDelegate, PKPushRegistryDelegate, @unchecked Sendable {
    let provider: CXProvider

    init(provider: CXProvider) { self.provider = provider }

    func providerDidReset(_ provider: CXProvider) {
        Task { @MainActor in await WatchCallKit.shared.reset() }
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        let box = Unchecked(value: action)
        Task { @MainActor in await WatchCallKit.shared.answer(box.value) }
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        let box = Unchecked(value: action)
        Task { @MainActor in await WatchCallKit.shared.start(box.value) }
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let box = Unchecked(value: action)
        Task { @MainActor in await WatchCallKit.shared.end(box.value) }
    }

    func provider(_ provider: CXProvider, perform action: CXPlayDTMFCallAction) {
        let boxed = Unchecked(value: action)
        Task { @MainActor in await WatchCallKit.shared.playDTMF(boxed.value) }
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        let box = Unchecked(value: action)
        Task { @MainActor in WatchCallKit.shared.mute(box.value) }
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        let box = Unchecked(value: audioSession)
        Task { @MainActor in WatchCallKit.shared.audioLeg.audioSessionDidActivate(box.value) }
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        let box = Unchecked(value: audioSession)
        Task { @MainActor in WatchCallKit.shared.audioLeg.audioSessionDidDeactivate(box.value) }
    }

    // MARK: PushKit

    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let token = pushCredentials.token
        Task { @MainActor in WatchSessionStore.shared.updateVoIPToken(token) }
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        Task { @MainActor in WatchSessionStore.shared.updateVoIPToken(nil) }
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType,
                      completion: @escaping () -> Void) {
        let done = Unchecked(value: completion)
        let parsed = WatchPushPayload(payload.dictionaryPayload)
        let update = CXCallUpdate()
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        guard type == .voIP, parsed.event == "call.incoming", let info = parsed.incoming,
              let uuid = UUID(uuidString: info.callId) else {
            // Same as iOS S99 §3: every VoIP push gets a CallKit report, an unusable one a placeholder ended at once.
            let uuid = UUID()
            update.remoteHandle = CXHandle(type: .generic, value: "VoDog")
            provider.reportNewIncomingCall(with: uuid, update: update) { @Sendable _ in
                self.provider.reportCall(with: uuid, endedAt: nil, reason: .failed)
                Task { @MainActor in done.value() }
            }
            return
        }
        let caller = info.contactName ?? info.remoteNumber ?? ContactDisplay.unknownNumber
        update.remoteHandle = CXHandle(type: .phoneNumber, value: info.remoteNumber ?? ContactDisplay.unknownNumber)
        update.localizedCallerName = info.simLabel.map { "\(caller) → \($0)" } ?? caller
        provider.reportNewIncomingCall(with: uuid, update: update) { @Sendable error in
            Task { @MainActor in
                if error == nil { WatchCallKit.shared.didReportIncoming(info, uuid: uuid) }
                done.value()
            }
        }
    }
}
