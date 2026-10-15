import Foundation
import Observation
import WatchConnectivity
import WatchKit

/// A ringing call the watch can show on page 3 — from a `call.incoming` push before `/calls` has it, or from the list.
struct IncomingInfo: Equatable, Sendable {
    var callId: String
    var remoteNumber: String?
    var contactName: String?
    var simLabel: String?
    var remoteLocation: String?
    var aiHandling = false
    var receivedAt = Date()
}

/// First-load state of a list page: spinner until the first fetch lands, retry if it failed with nothing to show.
enum ListKind: Hashable { case calls, sms, contacts, sims }
enum LoadState { case loading, failed, loaded }

/// S105: who carries the audio of the current call. The watch only knows its own leg; `.phone` = any other active call.
enum AudioHolder: Sendable { case phone, watch, none }

enum WatchRoute: Hashable {
    case dial(String?)
    case contacts
    case contact(String)
    case recents
    case call(String)
    case sms
    case conversation(simId: String, number: String)
    case lines
    case mode(String)
    case active
    case keypad
}

/// S104 watch state. The iPhone is the hub: the session arrives by applicationContext, the watch never refreshes or
/// logs in, and a 401 only flips the screen to「iPhone 未连接」while the last snapshot stays.
@MainActor @Observable
final class WatchSessionStore {
    static let shared = WatchSessionStore()

    private(set) var context: WatchContext?
    private(set) var restSims: [SIMChannel]?
    private(set) var badges = WatchBadges()
    private(set) var calls: [CallRecord] = []
    private(set) var sms: [SMSMessage] = []
    private(set) var contacts: [Contact] = []
    private(set) var snapshotAt: Date?
    private(set) var phoneReachable = false
    private(set) var unauthorized = false
    var incoming: IncomingInfo?
    var path: [WatchRoute] = []
    /// Text shown once by the root (notification action results, copied code).
    var notice: String?
    private(set) var preview = false
    /// Debug preview only (`-S105WatchHolder` or page 14): render page 4 as if the watch held the audio.
    private(set) var previewWatchHolder = false
    private(set) var loadStates: [ListKind: LoadState] = [:]
    /// S105: the call the watch answered / dialled itself, kept current by `trackWatchCall` (the iPhone's
    /// applicationContext may be stale or unreachable while the watch holds the audio).
    var watchCall: WatchContext.ActiveCall?

    @ObservationIgnored private let link = WatchLink()
    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored private var apnsToken: String?
    @ObservationIgnored private var voipToken: String?
    @ObservationIgnored private var watchPoll: Task<Void, Never>?
    @ObservationIgnored private var registeredPushKey: String?
    @ObservationIgnored private var dialRequests: [String: String] = [:]
    @ObservationIgnored let installationId: String
    /// S105i: `activeCall.holder` from the latest applicationContext (`WatchContext.ActiveCall` does not decode it).
    @ObservationIgnored private var contextHolder: (callId: String, holder: String)?
    /// S105k: calls ended from page 4 while the iPhone context may still list them; cleared when a new call id appears.
    private var endedCallIds: Set<String> = []

    private static let snapshotKey = "s104-watch-snapshot-v1"
    /// The token last written to `WatchTokenKeychain`, so `persist()` touches the Keychain only on change.
    @ObservationIgnored private var persistedToken: String?

    private init() {
        if let id = defaults.string(forKey: "s104-watch-installation-id") {
            installationId = id
        } else {
            installationId = UUID().uuidString.lowercased()
            defaults.set(installationId, forKey: "s104-watch-installation-id")
        }
        var migratedLegacyToken = false
        if let data = defaults.data(forKey: Self.snapshotKey), let saved = try? JSONDecoder().decode(Snapshot.self, from: data) {
            var restored = saved.context
            // Snapshots written before the token moved to the Keychain still carry it in plaintext.
            if let legacy = restored?.session?.accessToken, !legacy.isEmpty {
                WatchTokenKeychain.save(legacy); migratedLegacyToken = true
            }
            if restored?.session != nil {
                if let token = WatchTokenKeychain.load(), !token.isEmpty {
                    restored?.session?.accessToken = token; persistedToken = token
                } else {
                    restored?.session = nil // no stored token: wait for the iPhone's next context
                }
            }
            context = restored; restSims = saved.sims; badges = saved.badges ?? WatchBadges()
            calls = saved.calls ?? []; sms = saved.sms ?? []; contacts = saved.contacts ?? []
            snapshotAt = saved.snapshotAt
            // A non-empty persisted snapshot shows at once, no spinner.
            if !calls.isEmpty { loadStates[.calls] = .loaded }
            if !sms.isEmpty { loadStates[.sms] = .loaded }
            if !contacts.isEmpty { loadStates[.contacts] = .loaded }
        }
        if migratedLegacyToken { persist() } // rewrite the snapshot without the plaintext token
    }

    // MARK: Derived state

    var isLoggedIn: Bool { context?.session != nil }
    /// iPhone reachable and the access token it handed over still accepted.
    var connected: Bool { preview || (phoneReachable && !unauthorized && isLoggedIn) }
    var sims: [SIMChannel] { restSims ?? (context?.sims ?? []).map(\.channel) }
    var activeCall: WatchContext.ActiveCall? {
        if let watchCall, !endedCallIds.contains(watchCall.callId.lowercased()) { return watchCall }
        guard let call = context?.activeCall, !endedCallIds.contains(call.callId.lowercased()),
              !["ended", "failed", "ending"].contains(call.state ?? "") else { return nil }
        return call
    }
    var holder: AudioHolder {
        if WatchCallKit.shared.current?.answered == true || previewWatchHolder { return .watch }
        return activeCall != nil ? .phone : .none
    }
    var userId: String? { context?.session?.userId }
    func loadState(_ kind: ListKind) -> LoadState { loadStates[kind] ?? .loading }

    var connectionText: String {
        if connected { return "iPhone 已连接 · 刚刚更新" }
        guard let snapshotAt else { return "iPhone 未连接" }
        return "iPhone 未连接 · \(snapshotAt.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))) 的快照"
    }

    // MARK: Lifecycle

    func start() {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-S104Preview") { loadPreview(); return }
        #endif
        link.activate(store: self)
    }

    func didActivate(context dictionary: Data?, reachable: Bool) {
        phoneReachable = reachable
        if let dictionary { apply(contextData: dictionary) }
        if reachable { Task { _ = await send(["kind": "ping"]) } }
    }

    func reachabilityChanged(_ reachable: Bool) {
        phoneReachable = reachable
        if reachable { Task { _ = await send(["kind": "ping"]); await flushPendingEnds() } } // S111
    }

    func apply(contextData: Data) {
        guard let next = try? JSONDecoder().decode(WatchContext.self, from: contextData) else { return }
        struct HolderProbe: Decodable { struct Call: Decodable { let callId: String; let holder: String? }; let activeCall: Call? }
        contextHolder = (try? JSONDecoder().decode(HolderProbe.self, from: contextData))?.activeCall
            .map { ($0.callId.lowercased(), $0.holder ?? "") }
        // S105j: a holder=phone context arriving mid-call releases at once, not only at socket loss.
        if let contextHolder, contextHolder.holder == "phone" { _ = WatchCallKit.shared.releaseIfPhoneHolds(contextHolder.callId) }
        let tokenChanged = next.session?.accessToken != context?.session?.accessToken
        if let id = next.activeCall?.callId.lowercased(), !endedCallIds.contains(id) { endedCallIds = [] }
        context = next
        if tokenChanged, let token = next.session?.accessToken { WatchCallKit.shared.audioLeg.rotateToken(token) }
        if let nextBadges = next.badges { badges = nextBadges }
        if next.session == nil {
            // Logged out on the iPhone: nothing of the old account may stay on the wrist.
            restSims = nil; calls = []; sms = []; contacts = []; badges = WatchBadges(); path = []; incoming = nil
            loadStates = [:]
        }
        if tokenChanged { unauthorized = false }
        if tokenChanged, next.session != nil { Task { await refreshContactsOnce() } } // S115: login while already active
        snapshotAt = .now
        persist()
        Task { await registerPushIfNeeded() }
        WatchComplicationReloader.reload()
    }

    // MARK: Foreground polling (spec: /badges + /sims every 15 s, /calls every 3 s while a call is moving)

    func foregroundLoop() async {
        var tick = 0
        Task { await refreshContactsOnce() } // S115: the dial-page hint needs contacts before 通讯录 is ever opened
        await flushPendingEnds() // S111
        while !Task.isCancelled {
            if tick % 5 == 0 { await refreshOverview() }
            if incoming != nil || activeCall != nil { await refreshCalls() }
            tick += 1
            try? await Task.sleep(for: .seconds(3))
        }
    }

    /// Before a fetch: a failed list goes back to the spinner (重试). After: loaded, or failed only if nothing was loaded.
    private func beginLoad(_ kind: ListKind) {
        if loadStates[kind] == .failed { loadStates[kind] = .loading }
    }

    private func endLoad(_ kind: ListKind, ok: Bool) {
        if ok { loadStates[kind] = .loaded } else if loadStates[kind] != .loaded { loadStates[kind] = .failed }
    }

    func refreshOverview() async {
        beginLoad(.sims)
        async let b: WatchBadges? = try? api("badges")
        async let s: ItemEnvelope<SIMChannel>? = try? api("sims")
        let (newBadges, newSims) = await (b, s)
        if let newBadges { badges = newBadges }
        if let newSims { restSims = newSims.items }
        endLoad(.sims, ok: newSims != nil || !sims.isEmpty)
        if newBadges != nil || newSims != nil { snapshotAt = .now; persist(); WatchComplicationReloader.reload() }
    }

    func refreshCalls() async {
        beginLoad(.calls)
        guard let envelope: ItemEnvelope<CallRecord> = try? await api("calls", query: [URLQueryItem(name: "limit", value: "50")])
        else { endLoad(.calls, ok: false); return }
        endLoad(.calls, ok: true)
        calls = envelope.items
        syncIncomingWithList()
        snapshotAt = .now
        persist()
    }

    func refreshSMS() async {
        beginLoad(.sms)
        guard let page: SMSPageEnvelope<SMSMessage> = try? await api("sms", query: [URLQueryItem(name: "limit", value: "200")])
        else { endLoad(.sms, ok: false); return }
        endLoad(.sms, ok: true)
        sms = page.items
        persist()
    }

    @discardableResult func refreshContacts() async -> Bool {
        beginLoad(.contacts)
        // C.UTF-8 order puts Latin names first; one page hides most CJK names, so walk every page.
        var all: [Contact] = []
        for _ in 0..<ContactLookupPolicy.maxBrowsePages {
            guard let page: ItemEnvelope<Contact> = try? await api("contacts", query: SMSContactPagePolicy.query(query: "", offset: all.count))
            else { endLoad(.contacts, ok: false); return false }
            all += page.items
            if !ContactLookupPolicy.hasMorePages(page.items.count) { break }
        }
        endLoad(.contacts, ok: true)
        contacts = all
        persist()
        return true
    }

    @ObservationIgnored private var contactsInFlight = false
    @ObservationIgnored private var contactsFetchedFor: String?

    /// S115: fetch contacts once per launch and account without waiting for the 通讯录 page — the persisted
    /// snapshot may be empty or a stale TF118 200-row list. Keyed on userId, so the 15-min access-token rotation
    /// does not refetch; a failed fetch is retried by the next trigger only.
    func refreshContactsOnce() async {
        guard !preview, let session = context?.session, !contactsInFlight else { return }
        let account = session.userId ?? session.accessToken
        guard account != contactsFetchedFor else { return }
        contactsInFlight = true
        defer { contactsInFlight = false }
        if await refreshContacts() { contactsFetchedFor = account }
    }

    private func syncIncomingWithList() {
        if let ringing = calls.first(where: {
            $0.state == "incoming_ringing" && $0.direction == "incoming" && !$0.isInternal
        }) {
            incoming = IncomingInfo(callId: ringing.id, remoteNumber: ringing.remoteNumber, contactName: ringing.contactName,
                                    simLabel: ringing.simLabel, remoteLocation: ringing.remoteLocation,
                                    aiHandling: ringing.suppressesRinging)
        } else if let current = incoming, calls.contains(where: { $0.id.lowercased() == current.callId.lowercased() })
                    || Date().timeIntervalSince(current.receivedAt) > 45 {
            incoming = nil
        }
    }

    // MARK: REST

    func api<R: Decodable & Sendable>(
        _ path: String, method: String = "GET", body: (any Encodable & Sendable)? = nil,
        idempotencyKey: String? = nil, query: [URLQueryItem] = [], headers: [String: String] = [:]
    ) async throws -> R {
        guard !preview else { throw APIError.server(0, "预览模式不联网", nil) }
        guard let token = context?.session?.accessToken else { throw APIError.unauthorized }
        do {
            let value: R = try await WatchAPIClient(token: token)
                .request(path, method: method, body: body, idempotencyKey: idempotencyKey, query: query, headers: headers)
            unauthorized = false
            return value
        } catch APIError.unauthorized {
            unauthorized = true
            if phoneReachable { _ = await send(["kind": "ping"]) }
            throw APIError.unauthorized
        }
    }

    /// 拒接 (page 3 / notification). A call ringing in the watch's CallKit is declined through CallKit, whose end
    /// action comes back to `declineOnServer`.
    func decline(callId: String) async -> String? {
        if WatchCallKit.shared.isRinging(callId) { return await WatchCallKit.shared.requestEnd() }
        return await declineOnServer(callId: callId)
    }

    /// Guarded so it can never hang up a call someone already answered.
    func declineOnServer(callId: String) async -> String? {
        do {
            let _: EmptyResponse = try await api("calls/\(callId)/end", method: "POST", body: WatchCallEndBody(onlyIfRinging: true))
            incoming = nil
            return nil
        } catch { return error.localizedDescription }
    }

    /// 结束 (page 4). A watch-held call ends through CallKit (system UI in sync), whose end action calls `endOnServer`.
    func end(callId: String) async -> String? {
        if WatchCallKit.shared.holds(callId) { return await WatchCallKit.shared.requestEnd() }
        return await endOnServer(callId: callId)
    }

    /// One request, no retry; the final state comes from the authoritative list / context.
    // MARK: S111 pending ends — a call the watch closed locally while it had no path (BT-tethered to an offline
    // iPhone, S110) stays active on Control until someone says otherwise; retried here until Control accepts or
    // says the call is gone. Persisted so a relaunch does not forget it.
    private static let pendingEndsKey = "s111-pending-ends"
    private var pendingEnds: [String: Double] {
        get { defaults.dictionary(forKey: Self.pendingEndsKey) as? [String: Double] ?? [:] }
        set { defaults.set(newValue, forKey: Self.pendingEndsKey) }
    }
    func rememberPendingEnd(_ callId: String) {
        var p = pendingEnds
        p[callId.lowercased()] = Date().timeIntervalSince1970
        pendingEnds = p
        WatchDiag.log("watch.end_retry", level: "warn", callId: callId, ["phase": .string("queued")])
    }
    private var flushingEnds = false
    func flushPendingEnds() async {
        guard !flushingEnds, !preview, isLoggedIn, !pendingEnds.isEmpty else { return }
        flushingEnds = true
        defer { flushingEnds = false }
        let now = Date().timeIntervalSince1970
        for (id, at) in pendingEnds {
            var via = "server", done = false
            if now - at > 86_400 { via = "expired"; done = true }
            else {
                do { let _: EmptyResponse = try await api("calls/\(id)/end", method: "POST", body: WatchCallEndBody()); done = true }
                catch APIError.server(let status, _, _) where status == 404 || status == 409 { via = "already_over"; done = true }
                catch {
                    if phoneReachable, await send(["kind": "endCall", "callId": id]).ok { via = "iphone"; done = true }
                }
            }
            WatchDiag.log("watch.end_retry", level: done ? "info" : "warn", callId: id,
                          ["phase": .string("retry"), "via": .string(via), "result": .string(done ? "ok" : "failed")])
            if done { var p = pendingEnds; p.removeValue(forKey: id); pendingEnds = p }
        }
        Task { await WatchDiag.flush() }
    }

    func endOnServer(callId: String) async -> String? {
        do {
            let _: EmptyResponse = try await api("calls/\(callId)/end", method: "POST", body: WatchCallEndBody())
            // Not awaited: CallKit's end action waits on this result (S105h, bounded to 4 s), not on the iPhone ping.
            if phoneReachable { Task { _ = await send(["kind": "ping"]) } }
            return nil
        } catch { return error.localizedDescription }
    }

    /// S105k: page 4 ended a phone-held call: hide it now, even while the iPhone's context still lists it.
    func markEnded(_ callId: String) {
        let id = callId.lowercased()
        endedCallIds.insert(id)
        if watchCall?.callId.lowercased() == id { watchCall = nil }
    }

    func markSeen(_ call: CallRecord) async {
        guard call.unseen == true else { return }
        let _: EmptyResponse? = try? await api("calls/\(call.id)/seen", method: "POST")
        await refreshOverview()
    }

    func markRead(_ ids: [String]) async {
        guard !ids.isEmpty else { return }
        let _: EmptyResponse? = try? await api("sms/read", method: "POST", body: WatchSMSReadBody(ids: ids))
        await refreshOverview()
    }

    func block(number: String, sourceCallId: String?) async -> String? {
        do {
            let _: EmptyResponse = try await api("blocklist", method: "POST",
                                                 body: WatchBlockBody(remoteNumber: number, sourceCallId: sourceCallId, scope: "call"))
            return nil
        } catch { return error.localizedDescription }
    }

    /// `POST /sms/outbound` with the persistent key of `SMSIdempotencyStore` (same digest as iOS).
    func sendSMS(simId: String, to number: String, body: String) async -> String? {
        guard let account = userId else { return "请先在 iPhone 上登录 VoDog" }
        let payload = SMSOutboundPayload(simId: simId, remoteNumber: number, body: body)
        do {
            let key = try SMSIdempotencyStore.shared.key(accountID: account, payload: payload)
            let response: WatchSMSEnvelope = try await api("sms/outbound", method: "POST", body: payload, idempotencyKey: key)
            SMSIdempotencyStore.shared.markSucceeded(accountID: account, payload: payload, idempotencyKey: key)
            sms.insert(response.sms, at: 0)
            persist()
            return nil
        } catch { return error.localizedDescription }
    }

    enum SettingsResult { case saved, conflict, failed(String) }

    func saveMode(sim: SIMChannel, mode: ReceptionMode) async -> SettingsResult {
        guard let settings = sim.settings else { return .failed("该线路暂无设置") }
        do {
            let _: WatchSettingsEnvelope = try await api(
                "sims/\(sim.id)/settings", method: "PUT",
                body: WatchSettingsBody(mode: mode.rawValue, timeoutSeconds: settings.timeoutSeconds, expectedVersion: settings.version)
            )
            await refreshOverview()
            return .saved
        } catch APIError.server(409, _, _) {
            await refreshOverview()
            return .conflict
        } catch { return .failed(error.localizedDescription) }
    }

    // MARK: Calls on the watch (S105) and iPhone fallbacks (sendMessage)

    /// A call ringing in the watch's CallKit is answered there (audio on the watch); otherwise — no VoIP token, alert
    /// path — the iPhone answers as in S104.
    func answer(callId: String) async -> WatchReply {
        if WatchCallKit.shared.isRinging(callId) {
            if let failure = await WatchCallKit.shared.requestAnswer() { return WatchReply(ok: false, message: failure) }
            return WatchReply(ok: true, callId: callId)
        }
        return await send(["kind": "answer", "callId": callId])
    }

    func mute(callId: String, muted: Bool) async -> WatchReply {
        if WatchCallKit.shared.holds(callId) {
            if let failure = await WatchCallKit.shared.requestMute(muted) { return WatchReply(ok: false, message: failure) }
            return WatchReply(ok: true, callId: callId)
        }
        return await send(["kind": "mute", "callId": callId, "muted": muted])
    }

    func claim(callId: String, deviceName: String) async throws -> CallRecord {
        let envelope: WatchCallEnvelope = try await api("calls/\(callId)/claim", method: "POST",
                                                        body: WatchClaimBody(platform: "watchos", deviceName: deviceName))
        return envelope.call
    }

    /// S105: the watch dials itself (`POST /calls/outbound`) and carries the audio. S104 idempotency: one key per
    /// (account, SIM, number) until the server answers definitively, so a resend after a lost reply is deduplicated.
    /// ponytail: keys are in memory only (iOS persists them); persist if relaunch-mid-dial duplicates show up.
    /// S105e: `postDial` (`,1,3`) is never sent to Control; WatchCallKit keys it in once the call is active.
    func dial(simId: String, number: String, postDial: String = "") async -> WatchReply {
        if preview { return WatchReply(ok: true, callId: "preview-call") }
        guard let account = userId else { return WatchReply(ok: false, code: "NOT_LOGGED_IN") }
        guard WatchCallKit.shared.current == nil else { return WatchReply(ok: false, message: "手表正在通话中") }
        // S105b: no prewarm here — watchOS blocks sockets outside a CallKit call; it runs in the CXStartCallAction handler.
        let normalized = PhoneNumberText.normalized(number)
        let slot = "\(account)|\(simId)|\(normalized)"
        let key = dialRequests[slot] ?? UUID().uuidString.lowercased()
        dialRequests[slot] = key
        let call: CallRecord
        let started = ContinuousClock.now
        do {
            let envelope: WatchCallEnvelope = try await api("calls/outbound", method: "POST",
                                                            body: WatchOutboundBody(simId: simId, remoteNumber: normalized),
                                                            idempotencyKey: key)
            call = envelope.call
            dialRequests[slot] = nil
        } catch {
            WatchDiag.log("watch.callkit.start", level: "warn",
                          WatchDiag.error(error, ["outboundMs": .int(started.msSince), "result": "outbound_failed"]))
            if case APIError.server = error { dialRequests[slot] = nil }
            if case APIError.unauthorized = error { return WatchReply(ok: false, code: "NOT_LOGGED_IN") }
            return WatchReply(ok: false, message: error.localizedDescription)
        }
        watchCall = WatchContext.ActiveCall(callId: call.id, remoteNumber: call.remoteNumber ?? normalized,
                                            contactName: call.contactName, simLabel: call.simLabel, state: call.state,
                                            answeredAt: call.answeredAt, muted: false)
        let outboundMs = started.msSince
        if let failure = await WatchCallKit.shared.startOutgoing(callId: call.id, number: normalized, postDial: postDial) {
            WatchDiag.log("watch.callkit.start", level: "warn", callId: call.id,
                          ["outboundMs": .int(outboundMs), "result": "callkit_refused", "error": .string(failure)])
            return WatchReply(ok: false, message: failure)
        }
        WatchDiag.log("watch.callkit.start", callId: call.id, ["outboundMs": .int(outboundMs), "result": "ok"])
        return WatchReply(ok: true, callId: call.id)
    }

    /// `GET /calls/:id` every 3 s while the watch's CallKit has the call (ringing or held): refreshes page 4 and lets
    /// `WatchCallKit` end the system call on terminal / answered-elsewhere and report the outgoing connect.
    func trackWatchCall(_ callId: String) {
        if !endedCallIds.contains(callId.lowercased()) { endedCallIds = [] }
        watchPoll?.cancel()
        watchPoll = Task {
            while !Task.isCancelled, WatchCallKit.shared.current?.callId == callId.lowercased() {
                await requestTokenRefreshIfExpiringSoon(callId: callId)
                if let envelope: WatchCallEnvelope = try? await api("calls/\(callId)") {
                    let record = envelope.call
                    if watchCall?.callId.lowercased() == callId.lowercased() {
                        watchCall?.state = record.state
                        watchCall?.answeredAt = record.answeredAt
                        if let name = record.contactName { watchCall?.contactName = name }
                    }
                    WatchCallKit.shared.apply(record)
                }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    /// S105b in-call keypad: one `POST /calls/:id/dtmf` per tap (no idempotency key — a lost reply is not resent).
    func dtmf(callId: String, digit: String) async -> String? {
        if preview { return nil }
        let failure: String?
        do {
            let _: EmptyResponse = try await api("calls/\(callId)/dtmf", method: "POST", body: WatchDTMFBody(digits: digit))
            failure = nil
        } catch APIError.server(501, _, _) {
            failure = "网关未开启键盘"
        } catch {
            failure = error.localizedDescription
        }
        // Never the digit itself (Control's own call.dtmf rule): it can be a PIN or a card number.
        WatchDiag.log("watch.dtmf", level: failure == nil ? "info" : "warn", callId: callId,
                      ["status": .string(failure == nil ? "ok" : failure == "网关未开启键盘" ? "501" : "error")])
        return failure
    }

    /// S105i: the iPhone's context says it took this call's audio (its 「转到 iPhone」).
    func phoneHolds(_ callId: String) -> Bool {
        contextHolder?.callId == callId.lowercased() && contextHolder?.holder == "phone"
    }

    func watchCallEnded(_ callId: String) {
        if watchCall?.callId.lowercased() == callId.lowercased() { watchCall = nil }
        if incoming?.callId.lowercased() == callId.lowercased() { incoming = nil }
        watchPoll?.cancel()
        watchPoll = nil
        if phoneReachable { Task { _ = await send(["kind": "ping"]) } }
    }

    /// S105l: the iPhone's own refresh loop sleeps when the phone is locked, so the watch asks for one itself while
    /// it holds a call (≤3 min before expiry, at most once a minute). A message wakes the phone app; if the phone is
    /// not reachable the request is queued as userInfo, which also launches it in the background.
    private var lastRefreshRequest: Date = .distantPast
    private func requestTokenRefreshIfExpiringSoon(callId: String) async {
        guard let expiry = GatewayTimeDisplay.parseISO(context?.session?.expiresAt ?? ""),
              expiry.timeIntervalSinceNow < 180, Date().timeIntervalSince(lastRefreshRequest) > 60 else { return }
        // S111: not before the leg is up — a rotation during the first hello invalidated the token in flight (4401,
        // 2 s reconnect at dial time, §28). Reconnecting is fine: the next connect reads the fresh token.
        switch WatchCallKit.shared.audioLeg.stats.state { case .connected, .reconnecting: break; default: return }
        lastRefreshRequest = Date()
        let reply = await send(["kind": "refresh"])
        var via = "message"
        if !reply.ok, reply.code == "UNREACHABLE" {
            via = "userInfo"
            WCSession.default.transferUserInfo(["kind": "refresh", "at": Date().timeIntervalSince1970 * 1000])
        }
        WatchDiag.log("watch.token_refresh_request", level: reply.ok ? "info" : "warn", callId: callId,
                      ["via": .string(via), "ok": .bool(reply.ok), "code": .string(reply.code ?? "")])
    }

    func send(_ message: [String: Any]) async -> WatchReply {
        if preview { return WatchReply(ok: true, callId: "preview-call") }
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return WatchReply(ok: false, code: "UNREACHABLE") }
        // S104b: WatchConnectivity calls these on its own queue. Inside a @MainActor type a plain closure is inferred
        // main-actor-isolated and the Swift 6 runtime traps on entry (dispatch_assert_queue) — the 1 s launch crash on a
        // real watch. `@Sendable` makes them nonisolated; they only resume the (Sendable) continuation.
        return await withCheckedContinuation { continuation in
            session.sendMessage(message, replyHandler: { @Sendable reply in
                continuation.resume(returning: WatchReply(WatchContext.jsonData(reply) ?? Data()))
            }, errorHandler: { @Sendable _ in
                continuation.resume(returning: WatchReply(ok: false, code: "UNREACHABLE"))
            })
        }
    }

    // MARK: Push (`PUT /push/registrations/:installationId`, platform watchos, iPhone's access token)

    func updateAPNsToken(_ data: Data) {
        apnsToken = data.map { String(format: "%02x", $0) }.joined()
        Task { await registerPushIfNeeded() }
    }

    func updateVoIPToken(_ data: Data?) {
        voipToken = data.map { $0.map { String(format: "%02x", $0) }.joined() }
        Task { await registerPushIfNeeded() }
    }

    func registerPushIfNeeded() async {
        guard let apnsToken, let session = context?.session, !preview else { return }
        let key = "\(apnsToken)|\(voipToken ?? "")|\(session.userId ?? "")"
        guard registeredPushKey != key else { return }
        #if DEBUG
        let environment = "development"
        #else
        let environment = "production"
        #endif
        let body = WatchPushRegistrationBody(environment: environment, deviceName: WKInterfaceDevice.current().name,
                                             apnsToken: apnsToken, voipToken: voipToken)
        struct Envelope: Decodable, Sendable {}
        do {
            let _: Envelope = try await api("push/registrations/\(installationId)", method: "PUT", body: body)
            registeredPushKey = key
        } catch {
            // Retried on the next context update; a Control without the watchos kind answers 400 until deployed.
        }
    }

    // MARK: Persistence

    private struct Snapshot: Codable {
        var context: WatchContext?
        var sims: [SIMChannel]?
        var badges: WatchBadges?
        var calls: [CallRecord]?
        var sms: [SMSMessage]?
        var contacts: [Contact]?
        var snapshotAt: Date?
    }

    private func persist() {
        guard !preview else { return }
        // The access token goes to the Keychain; the defaults snapshot keeps the session without it.
        var stored = context
        if let token = stored?.session?.accessToken {
            if token != persistedToken, WatchTokenKeychain.save(token) { persistedToken = token }
            stored?.session?.accessToken = ""
        } else if persistedToken != nil {
            WatchTokenKeychain.delete(); persistedToken = nil
        }
        let snapshot = Snapshot(context: stored, sims: restSims, badges: badges, calls: Array(calls.prefix(100)),
                                sms: Array(sms.prefix(300)), contacts: contacts, snapshotAt: snapshotAt)
        if let data = try? JSONEncoder().encode(snapshot) { defaults.set(data, forKey: Self.snapshotKey) }
    }

    #if DEBUG
    /// `-S104Preview` (Debug only): the spec's fictional examples so every page renders without a phone.
    /// `-S104Page N` opens page N directly for screenshots.
    private func loadPreview() {
        preview = true
        let p = WatchPreviewData.self
        context = p.context
        restSims = p.sims
        badges = WatchBadges(calls: 2, sms: 3)
        calls = p.calls
        sms = p.sms
        contacts = p.contacts
        snapshotAt = .now
        loadStates = [.calls: .loaded, .sms: .loaded, .contacts: .loaded, .sims: .loaded]
        let page = UserDefaults.standard.integer(forKey: "S104Page")
        if !ProcessInfo.processInfo.arguments.contains("-S104ActiveCall") && ![2, 4, 14].contains(page) { context?.activeCall = nil }
        previewWatchHolder = page == 14 || ProcessInfo.processInfo.arguments.contains("-S105WatchHolder")
        switch page {
        case 1: context?.session = nil
        case 3: incoming = IncomingInfo(callId: "c-in", remoteNumber: "138 0013 8000", contactName: "张伟", simLabel: "工作号",
                                        remoteLocation: "上海")
        case 4: path = [.active]
        case 5: path = [.dial(UserDefaults.standard.string(forKey: "S105DialPrefill") ?? "2025550101")]
        case 6: path = [.contacts]
        case 7: path = [.contacts, .contact("ct-zw")]
        case 8: path = [.recents]
        case 9: path = [.recents, .call("c-missed")]
        case 10: path = [.sms]
        case 11: path = [.sms, .conversation(simId: "sim-work", number: "2025550102")]
        case 12: path = [.lines]
        case 13: path = [.lines, .mode("sim-personal")]
        case 14: path = [.active, .keypad]
        default: break
        }
    }
    #endif
}

/// S104 `WatchPushBody` plus S105 `voipToken` (omitted while unknown).
struct WatchPushRegistrationBody: Encodable, Sendable {
    var platform = "watchos"
    var bundleId = "org.vodog.watchkitapp"
    let environment: String
    let deviceName: String
    let apnsToken: String
    let voipToken: String?
}

struct WatchClaimBody: Encodable, Sendable { let platform: String; let deviceName: String }
/// S105b: `platform: "watchos"` makes Control store `originating_platform = watchos`.
struct WatchOutboundBody: Encodable, Sendable { let simId: String; let remoteNumber: String; var platform = "watchos" }
struct WatchDTMFBody: Encodable, Sendable { let digits: String }
struct WatchCallEnvelope: Decodable, Sendable { let call: CallRecord }

/// WCSession delegate. Callbacks arrive off the main actor with non-Sendable dictionaries, so they are turned into
/// JSON `Data` first and handed to the store on the main actor.
final class WatchLink: NSObject, WCSessionDelegate, @unchecked Sendable {
    func activate(store: WatchSessionStore) {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: (any Error)?) {
        let context = session.receivedApplicationContext
        let data = context.isEmpty ? nil : WatchContext.jsonData(context)
        let reachable = session.isReachable
        Task { @MainActor in WatchSessionStore.shared.didActivate(context: data, reachable: reachable) }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let data = WatchContext.jsonData(applicationContext) else { return }
        Task { @MainActor in WatchSessionStore.shared.apply(contextData: data) }
    }

    /// S105i: iPhone → watch commands. Only `release {callId}` (the iPhone pulls the call); every message gets a reply
    /// so the sender never waits for its timeout.
    func session(_ session: WCSession, didReceiveMessage message: [String: Any],
                 replyHandler: @escaping ([String: Any]) -> Void) {
        let kind = message["kind"] as? String
        let callId = message["callId"] as? String
        let reply = ReplyBox(send: replyHandler)
        Task { @MainActor in
            guard kind == "release", let callId else {
                reply.send(["ok": false, "error": ["code": "UNSUPPORTED"]])
                return
            }
            let ok = await WatchCallKit.shared.release(callId: callId, via: "message")
            reply.send(ok ? ["ok": true] : ["ok": false, "error": ["code": "NO_SUCH_CALL"]])
        }
    }

    /// S105j: queued iPhone → watch `release` (delivered even while the watch app sits behind the call screen).
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard userInfo["kind"] as? String == "release", let callId = userInfo["callId"] as? String else { return }
        let at = (userInfo["at"] as? NSNumber)?.doubleValue ?? 0
        let ageMs = Date().timeIntervalSince1970 * 1000 - at
        Task { @MainActor in
            guard ageMs <= 120_000 else {
                WatchDiag.log("watch.release", level: "warn", callId: callId, ["via": "userInfo", "result": "stale"])
                return
            }
            _ = await WatchCallKit.shared.release(callId: callId, via: "userInfo")
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        let reachable = session.isReachable
        Task { @MainActor in WatchSessionStore.shared.reachabilityChanged(reachable) }
    }
}

/// WC reply handlers are thread-safe; boxed so the main-actor hop can carry one.
private struct ReplyBox: @unchecked Sendable { let send: ([String: Any]) -> Void }

/// TODO(S104): WidgetKit complication (`accessoryCircular` / `accessoryRectangular` / `accessoryInline`, calls + sms)
/// needs a separate widget-extension target plus an App Group to share the counts; not in this change. Once it exists,
/// call `WidgetCenter.shared.reloadAllTimelines()` here.
enum WatchComplicationReloader {
    static func reload() {}
}

// MARK: - S105b diagnostics (`POST /diag/events`, source watchos)

/// A diag field value; literals work directly (`["result": "ok"]`), variables via `.int(x)` / `.string(s)`.
enum DiagValue: Encodable, Sendable, ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral {
    case string(String), int(Int), double(Double), bool(Bool)
    init(stringLiteral value: String) { self = .string(value) }
    init(integerLiteral value: Int) { self = .int(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case let .string(v): try c.encode(v)
        case let .int(v): try c.encode(v)
        case let .double(v): try c.encode(v.isFinite ? (v * 10).rounded() / 10 : 0)
        case let .bool(v): try c.encode(v)
        }
    }
}

struct WatchDiagEvent: Encodable, Sendable {
    let ts: String
    let level: String
    let event: String
    let callId: String?
    let fields: [String: DiagValue]?
    let appVersion: String
}

extension ContinuousClock.Instant {
    var msSince: Int { Int((ContinuousClock.now - self) / .milliseconds(1)) }
}

/// In-memory queue (≤500, oldest dropped), batches of ≤200. Flushed every 30 s while a watch call is live and at once
/// on call end / app background. A batch that fails twice is dropped: diagnostics never retry into the next call.
@MainActor
enum WatchDiag {
    private static var queue: [WatchDiagEvent] = []
    private static var flushing = false
    private static var ticker: Task<Void, Never>?

    static let appVersion: String = {
        let info = Bundle.main.infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "?")(\(info?["CFBundleVersion"] as? String ?? "?"))"
    }()

    static func log(_ event: String, level: String = "info", callId: String? = nil, _ fields: [String: DiagValue] = [:]) {
        let ts = Date.now.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        queue.append(WatchDiagEvent(ts: ts, level: level, event: event, callId: callId?.lowercased(),
                                    fields: fields.isEmpty ? nil : fields, appVersion: appVersion))
        if queue.count > 500 { queue.removeFirst(queue.count - 500) }
    }

    /// `fields` plus the error: description, domain/code, URLError code and POSIX code when present.
    nonisolated static func error(_ error: any Error, _ fields: [String: DiagValue] = [:]) -> [String: DiagValue] {
        var out = fields
        let ns = error as NSError
        out["error"] = .string(String(error.localizedDescription.prefix(160)))
        out["errorDomain"] = .string(ns.domain)
        out["errorCode"] = .int(ns.code)
        if let url = error as? URLError { out["urlErrorCode"] = .int(url.code.rawValue) }
        var underlying: NSError? = ns
        while let e = underlying {
            if e.domain == NSPOSIXErrorDomain { out["posixCode"] = .int(e.code); break }
            underlying = e.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return out
    }

    static func callBegan() {
        ticker?.cancel()
        ticker = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                if !Task.isCancelled { await flush() }
            }
        }
    }

    static func callEnded() {
        ticker?.cancel()
        ticker = nil
        Task { await flush() }
    }

    static func flush() async {
        let store = WatchSessionStore.shared
        guard !flushing, !store.preview, store.isLoggedIn else { return }
        flushing = true
        defer { flushing = false }
        while !queue.isEmpty {
            let batch = Array(queue.prefix(200))
            queue.removeFirst(batch.count)
            var sent = false
            for _ in 0..<2 where !sent {
                // `X-Diag-Sent-At` is epoch ms: Control parses it with Number() for the per-batch clock offset.
                let headers = ["X-Diag-Source": "watchos", "X-Diag-Install": store.installationId,
                               "X-Diag-Sent-At": String(Int64(Date.now.timeIntervalSince1970 * 1000))]
                sent = (try? await store.api("diag/events", method: "POST", body: batch, headers: headers) as EmptyResponse) != nil
            }
            // S109: a batch that could not be sent (watch off the network mid-call) waits for the next flush — the
            // whole 108 walk-away call 2 was lost this way; the cap in `log` still bounds memory.
            if !sent { queue.insert(contentsOf: batch, at: 0); return }
        }
    }
}
