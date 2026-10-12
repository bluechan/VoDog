import SwiftUI
import UserNotifications
import WatchKit

@main
struct VoDogWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self) private var delegate
    @State private var store = WatchSessionStore.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            WatchRootView()
                .environment(store)
                .tint(Signal.brand)
                .task(id: scenePhase) {
                    guard scenePhase == .active, store.isLoggedIn else { return }
                    await WatchDiag.flush() // S109: events kept from a call the watch could not upload during
                    await store.foregroundLoop()
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .background { Task { await WatchDiag.flush() } }
                }
        }
    }
}

final class WatchAppDelegate: NSObject, WKApplicationDelegate {
    // S104b: WatchKit's delegate callbacks are annotated main-actor, but the APNs token callback arrives shortly
    // after launch and must never be *assumed* on the main actor (an `assumeIsolated` trap was the 1 s launch
    // crash on a real watch; the simulator never gets a token, so it could not reproduce). Hop explicitly.
    func applicationDidFinishLaunching() {
        Task { @MainActor in
            WatchSessionStore.shared.start()
            #if DEBUG
            let preview = ProcessInfo.processInfo.arguments.contains("-S104Preview")
            #else
            let preview = false
            #endif
            // S105: CallKit provider + PushKit VoIP registry must exist before a VoIP push wakes the app.
            // The preview never asks for notification permission: its prompt would cover the screenshot.
            guard !preview else { return }
            WatchCallKit.shared.start()
            WatchNotifications.register()
            WKApplication.shared().registerForRemoteNotifications()
        }
    }

    func didRegisterForRemoteNotifications(withDeviceToken deviceToken: Data) {
        let token = deviceToken
        Task { @MainActor in WatchSessionStore.shared.updateAPNsToken(token) }
    }

    func didFailToRegisterForRemoteNotificationsWithError(_ error: any Error) {}
}

struct WatchRootView: View {
    @Environment(WatchSessionStore.self) private var store

    var body: some View {
        @Bindable var store = store
        Group {
            if store.isLoggedIn {
                NavigationStack(path: $store.path) {
                    HomeView()
                        .navigationDestination(for: WatchRoute.self) { route in
                            switch route {
                            case let .dial(number): DialPadView(initialNumber: number ?? "")
                            case .contacts: ContactsListView()
                            case let .contact(id): ContactDetailView(contactId: id)
                            case .recents: RecentsView()
                            case let .call(id): CallDetailView(callId: id)
                            case .sms: SMSListView()
                            case let .conversation(simId, number): ConversationView(simId: simId, number: number)
                            case .lines: LinesView()
                            case let .mode(simId): AnswerModeView(simId: simId)
                            case .active: ActiveCallView()
                            case .keypad: KeypadView()
                            }
                        }
                }
                .fullScreenCover(item: Binding(get: { store.incoming.map(IncomingCover.init) },
                                               set: { if $0 == nil { store.incoming = nil } })) { cover in
                    IncomingCallView(info: cover.info)
                }
            } else {
                SignedOutView()
            }
        }
        .background(W.bg)
        .alert(store.notice ?? "", isPresented: Binding(get: { store.notice != nil }, set: { if !$0 { store.notice = nil } })) {
            Button("好") { store.notice = nil }
        }
    }
}

private struct IncomingCover: Identifiable {
    let info: IncomingInfo
    var id: String { info.callId }
}

// MARK: - 1 未登录

struct SignedOutView: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "applewatch.slash").font(.system(size: 44)).foregroundStyle(Signal.ink3).accessibilityHidden(true)
            Text("在 iPhone 上登录 VoDog").font(.system(size: 15, weight: .semibold)).multilineTextAlignment(.center)
                .foregroundStyle(Signal.ink)
            Text("登录后手表自动同步").font(.system(size: 12)).foregroundStyle(Signal.ink3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - 2 首页

struct HomeView: View {
    @Environment(WatchSessionStore.self) private var store

    var body: some View {
        let sims = store.sims
        let online = sims.filter { $0.online == true }.count
        List {
            if let call = store.activeCall {
                NavigationLink(value: WatchRoute.active) {
                    HStack(spacing: 6) {
                        StatusShape(kind: .on, text: "通话中").font(.system(size: 12)).foregroundStyle(Signal.call)
                        Text(call.contactName ?? call.remoteNumber ?? "通话").lineLimit(1).font(.system(size: 13, weight: .semibold))
                        Spacer(minLength: 2)
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(WatchTime.timer(since: call.answeredAt, now: context.date)).monospacedDigit()
                                .font(.system(size: 13)).foregroundStyle(Signal.call)
                        }
                    }
                }
                .listRowBackground(RoundedRectangle(cornerRadius: 12).fill(Signal.callSoft))
            }
            row(.dial(nil), symbol: "circle.grid.3x3.fill", title: "拨号")
            row(.recents, symbol: "phone.arrow.down.left", title: "最近通话", badge: store.badges.calls)
            row(.sms, symbol: "message", title: "短信", badge: store.badges.sms)
            row(.contacts, symbol: "person.crop.circle", title: "通讯录")
            NavigationLink(value: WatchRoute.lines) {
                HStack(spacing: 6) {
                    HStack(spacing: 2) { ForEach(sims.prefix(3), id: \.id) { SIMSquare(sim: $0, sims: sims) } }
                    VStack(alignment: .leading, spacing: 1) {
                        Text("线路").font(.system(size: 15, weight: .semibold))
                        Text("\(online) 在线 · \(sims.count - online) 离线").font(.system(size: 11)).foregroundStyle(Signal.ink3)
                    }
                }
            }
            .signalRow()
            Section {
                ConnectionFooter()
            }
            .listRowBackground(Color.clear)
        }
        .navigationTitle("VoDog")
    }

    private func row(_ route: WatchRoute, symbol: String, title: String, badge: Int = 0) -> some View {
        NavigationLink(value: route) {
            HStack(spacing: 8) {
                Image(systemName: symbol).foregroundStyle(Signal.brand).frame(width: 20)
                Text(title).font(.system(size: 15, weight: .semibold))
                Spacer(minLength: 2)
                UnreadBadge(count: badge)
            }
        }
        .signalRow()
    }
}

struct ConnectionFooter: View {
    @Environment(WatchSessionStore.self) private var store
    var body: some View {
        StatusShape(kind: store.connected ? .on : .off, text: store.connectionText)
            .font(.system(size: 11)).foregroundStyle(Signal.ink3)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - 3 来电

struct IncomingCallView: View {
    @Environment(WatchSessionStore.self) private var store
    let info: IncomingInfo
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let sim = store.sims.first { simTitle($0.id, in: store.sims) == info.simLabel }
        let name = info.contactName?.isEmpty == false ? info.contactName! : (info.remoteNumber ?? ContactDisplay.unknownNumber)
        // S105: a call ringing in the watch's CallKit is answered here, without the iPhone.
        let onWatch = WatchCallKit.shared.isRinging(info.callId)
        let canAnswer = onWatch || store.connected
        ScrollView {
            VStack(spacing: 2) {
                SIMChip(sim: sim, sims: store.sims, fallbackLabel: info.simLabel, showsStatus: false)
                Avatar(name: name, size: 32)
                Text(name).font(.system(size: 20, weight: .bold)).lineLimit(1).minimumScaleFactor(0.7)
                if info.contactName?.isEmpty == false, let number = info.remoteNumber {
                    Text(number).font(.system(size: 13)).monospacedDigit().foregroundStyle(Signal.ink2)
                }
                HStack(spacing: 6) {
                    if let location = ContactDisplay.locationShort(info.remoteLocation) { Text(location).foregroundStyle(Signal.ink3) }
                    if !info.aiHandling { StatusShape(kind: .on, text: "来电").foregroundStyle(Signal.call) }
                }
                .font(.system(size: 11))
                if info.aiHandling {
                    Text("✦ AI 接听中").font(.system(size: 13, weight: .semibold)).foregroundStyle(Signal.ai)
                        .padding(.horizontal, 12).frame(height: 28).background(Signal.aiSoft, in: Capsule()).padding(.top, 6)
                    Text("无需操作").font(.system(size: 11)).foregroundStyle(Signal.ink3)
                } else {
                    HStack(alignment: .top, spacing: 22) {
                        RoundAction(symbol: "phone.down.fill", caption: "拒接", fill: Signal.dangerFill) {
                            Task { busy = true; error = await store.decline(callId: info.callId); busy = false }
                        }
                        VStack(spacing: 1) {
                            RoundAction(symbol: "phone.fill", caption: "接听",
                                        fill: canAnswer ? Signal.callFill : Signal.surface3) {
                                Task {
                                    busy = true
                                    let reply = await store.answer(callId: info.callId)
                                    busy = false
                                    if reply.ok { store.incoming = nil; store.path = [.active] } else { error = reply.text }
                                }
                            }
                            .disabled(!canAnswer)
                            Text(onWatch ? "在手表上接听" : store.connected ? "在 iPhone 上接听" : "需要 iPhone 在附近")
                                .font(.system(size: 10)).foregroundStyle(Signal.ink3)
                        }
                    }
                    .disabled(busy)
                    .padding(.top, 2)
                }
                if let error { Text(error).font(.system(size: 11)).foregroundStyle(Signal.danger).multilineTextAlignment(.center) }
            }
            .frame(maxWidth: .infinity)
        }
        .background(W.bg)
    }
}

// MARK: - 4 通话中

struct ActiveCallView: View {
    @Environment(WatchSessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var ending = false
    @State private var error: String?
    @State private var muteBusy = false

    var body: some View {
        if let call = store.activeCall {
            let sim = store.sims.first { simTitle($0.id, in: store.sims) == call.simLabel }
            let onWatch = store.holder == .watch
            let audioReady = call.state == "active" && (onWatch || store.connected)
            ScrollView {
                VStack(spacing: 6) {
                    Text(call.contactName ?? call.remoteNumber ?? ContactDisplay.unknownNumber)
                        .font(.system(size: 17, weight: .semibold)).lineLimit(1)
                    SIMChip(sim: sim, sims: store.sims, fallbackLabel: call.simLabel, showsStatus: false)
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        HStack(spacing: 6) {
                            StatusShape(kind: .on, text: call.state == "active" ? "通话中" : callStateTitle(call.state))
                                .font(.system(size: 12))
                            Text(WatchTime.timer(since: call.answeredAt, now: ending ? .distantPast : context.date))
                                .font(.system(size: 26, weight: .medium)).monospacedDigit()
                        }
                        .foregroundStyle(Signal.call)
                        .padding(.horizontal, 10).padding(.vertical, 2)
                        .background(Signal.callSoft, in: Capsule())
                    }
                    if let auto = WatchCallKit.shared.postDial, auto.callId == call.callId.lowercased() {
                        Text(auto.status == .done ? "已自动按键" : auto.status == .failed ? "自动按键未完成" : "将自动按键 ·\(auto.masked)")
                            .font(.system(size: 11)).foregroundStyle(auto.status == .failed ? Signal.warn : Signal.ink3)
                            .lineLimit(1)
                    }
                    if onWatch {
                        watchAudioChip
                        WideButton(title: "键盘", symbol: "circle.grid.3x3.fill", fill: Signal.brandSoft, ink: Signal.brand) {
                            store.path.append(.keypad)
                        }
                        .disabled(call.state != "active" || ending)
                        .opacity(call.state == "active" ? 1 : 0.5)
                    } else {
                        Label("音频在 iPhone", systemImage: "iphone").font(.system(size: 11)).foregroundStyle(Signal.ink3)
                    }
                    WideButton(title: call.muted == true ? "取消静音" : "静音",
                               symbol: call.muted == true ? "mic.fill" : "mic.slash.fill") {
                        Task {
                            muteBusy = true
                            let reply = await store.mute(callId: call.callId, muted: !(call.muted ?? false))
                            muteBusy = false
                            if !reply.ok { error = reply.text }
                        }
                    }
                    .disabled(!audioReady || muteBusy || ending)
                    .opacity(audioReady ? 1 : 0.5)
                    // 结束 is never hidden, also when the phone is unreachable: it goes straight to Control.
                    RoundAction(symbol: "phone.down.fill", caption: ending ? "正在结束…" : "结束",
                                fill: ending ? Signal.surface3 : Signal.dangerFill, size: 64) {
                        Task {
                            ending = true
                            if onWatch { // CallKit path, unchanged
                                let failure = await store.end(callId: call.callId)
                                WatchDiag.log("watch.app.end", level: failure == nil ? "info" : "warn", callId: call.callId,
                                              ["holder": .string("watch"), "result": .string(failure == nil ? "ok" : "error")])
                                if let failure { error = failure; ending = false }
                                return
                            }
                            // S105k: phone-held → one POST, then hide it locally and go home (the iPhone context can
                            // keep listing an ended call; never re-post /end).
                            let failure = await store.end(callId: call.callId)
                            WatchDiag.log("watch.app.end", level: failure == nil ? "info" : "warn", callId: call.callId,
                                          ["holder": .string("phone"), "result": .string(failure == nil ? "ok" : "error")])
                            store.markEnded(call.callId)
                            store.path = []
                            if let failure { store.notice = "结束失败：\(failure)" }
                        }
                    }
                    .disabled(ending)
                    if let error { Text(error).font(.system(size: 11)).foregroundStyle(Signal.danger).multilineTextAlignment(.center) }
                }
                .frame(maxWidth: .infinity)
            }
            .navigationTitle("通话")
        } else {
            VStack(spacing: 6) {
                Text("通话已结束").font(.system(size: 15, weight: .semibold))
                Button("返回") { dismiss() }
            }
            .navigationTitle("通话")
        }
    }

    /// S105:「⌚︎ 音频在手表」. Transfer is the iPhone's 「转到 iPhone」 (S105i); volume / route stay with CallKit.
    private var watchAudioChip: some View {
        VStack(spacing: 2) {
            Text("⌚︎ 音频在手表").font(.system(size: 11)).foregroundStyle(Signal.ink3)
            if case .failed = WatchCallKit.shared.audioLeg.stats.state {
                Text("音频中断，可在 iPhone 上转接").font(.system(size: 11)).foregroundStyle(Signal.danger)
            }
        }
    }
}

// MARK: - 4b 键盘（S105b，手表持有音频时的 DTMF）

struct KeypadView: View {
    @Environment(WatchSessionStore.self) private var store
    @State private var typed = ""
    @State private var error: String?

    var body: some View {
        let callId = store.activeCall?.callId
        ScrollView {
            VStack(spacing: 4) {
                Text(typed.isEmpty ? "拨号音" : typed)
                    .font(.system(size: 18, weight: .medium)).monospacedDigit()
                    .foregroundStyle(typed.isEmpty ? Signal.ink3 : Signal.ink)
                    .lineLimit(1).truncationMode(.head).frame(maxWidth: .infinity).frame(height: 22)
                Grid(horizontalSpacing: 4, verticalSpacing: 4) {
                    ForEach(0..<4, id: \.self) { row in
                        GridRow {
                            ForEach(0..<3, id: \.self) { col in key(DialPadView.keys[row * 3 + col], callId: callId) }
                        }
                    }
                }
                if let error {
                    Text(error).font(.system(size: 11)).foregroundStyle(Signal.danger).multilineTextAlignment(.center)
                } else if callId == nil {
                    Text("通话已结束").font(.system(size: 11)).foregroundStyle(Signal.ink3)
                }
            }
        }
        .navigationTitle("键盘")
    }

    /// Each tap is its own `POST /calls/:id/dtmf`; the last failure shows inline, a later success clears it.
    private func key(_ digit: String, callId: String?) -> some View {
        Button {
            guard let callId else { return }
            WKInterfaceDevice.current().play(.click) // S113b: haptic only; the far end hears network DTMF
            typed.append(digit)
            Task { error = await store.dtmf(callId: callId, digit: digit) }
        } label: {
            Text(digit).font(.system(size: 20, weight: .semibold)).foregroundStyle(Signal.ink)
                .frame(maxWidth: .infinity).frame(height: 36)
                .background(Signal.surface2, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .disabled(callId == nil)
        .accessibilityIdentifier("watch.dtmf.\(digit)")
    }
}
