import SwiftUI

// MARK: - 8 最近通话

struct RecentsView: View {
    @Environment(WatchSessionStore.self) private var store

    var body: some View {
        let sims = store.sims
        let groups = Dictionary(grouping: store.calls) { WatchTime.day($0.startedAt) }
        let order = store.calls.reduce(into: [String]()) { result, call in
            let day = WatchTime.day(call.startedAt)
            if !result.contains(day) { result.append(day) }
        }
        List {
            if store.calls.isEmpty {
                ListPlaceholder(state: store.loadState(.calls), emptyText: "暂无通话") { await store.refreshCalls() }
            }
            ForEach(order, id: \.self) { day in
                Section {
                    ForEach(groups[day] ?? []) { call in
                        NavigationLink(value: WatchRoute.call(call.id)) { CallRow(call: call, sims: sims) }.signalRow()
                    }
                } header: {
                    Text(day).font(.system(size: 12, weight: .semibold)).tracking(0.4).foregroundStyle(Signal.ink3)
                }
            }
        }
        .navigationTitle("最近通话")
        .task { await store.refreshCalls() }
    }
}

struct CallRow: View {
    let call: CallRecord
    let sims: [SIMChannel]

    var body: some View {
        let sim = sims.first { $0.id == call.simId }
        // Two lines so the 16 pt title gets the full width: icon + title + unseen dot, then SIM · subline + time.
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                DirIcon(kind: DirIcon.kind(for: call))
                Text(call.shownContactName ?? call.shownNumber(in: sims) ?? ContactDisplay.unknownNumber)
                    .font(.system(size: 16, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.9)
                    .foregroundStyle(call.isMissedIncoming ? Signal.danger : Signal.ink)
                Spacer(minLength: 2)
                if call.unseen == true && !call.isInternal { Circle().fill(Signal.brand).frame(width: 6, height: 6) }
            }
            HStack(spacing: 3) {
                SIMSquare(sim: sim, sims: sims)
                Text(Self.subline(call, sims: sims)).font(.system(size: 13)).monospacedDigit().foregroundStyle(Signal.ink3)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 4)
                Text(WatchTime.rowTime(call.startedAt, zone: GatewayTimeDisplay.resolvedTimeZone(callZone: call.gatewayTimeZone)))
                    .font(.system(size: 13)).monospacedDigit().foregroundStyle(Signal.ink3).lineLimit(1).layoutPriority(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    static func subline(_ call: CallRecord, sims: [SIMChannel]) -> String {
        var parts = [simTitle(call.simId, in: sims)]
        if call.isMissedIncoming { parts.append(call.rowStateTitle) }
        else if call.answeredByPlatform == "ai" { parts.append("AI 代接") }
        else if call.showsBlockedMark { parts.append("已拦截") }
        else { parts.append(call.directionTitle) }
        if let duration = CallDurationLabel.text(answeredAt: call.answeredAt, endedAt: call.endedAt) { parts.append(duration) }
        return parts.joined(separator: " · ")
    }
}

// MARK: - 9 通话详情

struct CallDetailView: View {
    @Environment(WatchSessionStore.self) private var store
    let callId: String
    @State private var confirmingBlock = false
    @State private var message: String?

    var body: some View {
        if let call = store.calls.first(where: { $0.id == callId }) {
            let sims = store.sims
            let number = call.remoteNumber ?? ""
            let blocker = WatchDialAction.blocker(store: store, simId: call.simId)
            let zone = GatewayTimeDisplay.resolvedTimeZone(callZone: call.gatewayTimeZone)
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        DirIcon(kind: DirIcon.kind(for: call))
                        VStack(alignment: .leading, spacing: 1) {
                            if let name = call.shownContactName { Text(name).font(.system(size: 15, weight: .semibold)) }
                            Text(call.shownNumber(in: sims) ?? ContactDisplay.unknownNumber)
                                .font(.system(size: call.shownContactName == nil ? 15 : 12, weight: call.shownContactName == nil ? .semibold : .regular))
                                .monospacedDigit()
                                .foregroundStyle(call.isMissedIncoming ? Signal.danger : Signal.ink)
                        }
                    }
                    Text(([ContactDisplay.locationShort(call.remoteLocation)].compactMap { $0 } + [CallRow.subline(call, sims: sims)])
                        .joined(separator: " · "))
                        .font(.system(size: 11)).foregroundStyle(Signal.ink3)
                    Text("\(WatchTime.day(call.startedAt, zone: zone)) \(WatchTime.clock(call.startedAt, zone: zone))")
                        .font(.system(size: 11)).monospacedDigit().foregroundStyle(Signal.ink3)
                    if !call.isInternal, PhoneNumberText.isDialable(PhoneNumberText.normalized(number)) {
                        WideButton(title: "回拨", subtitle: blocker ?? "用\(simTitle(call.simId, in: sims)) · 在 iPhone 上拨打",
                                   symbol: "phone.fill", fill: blocker == nil ? Signal.callFill : Signal.surface3, ink: .white) {
                            Task { message = await WatchDialAction.dial(store: store, simId: call.simId, number: number) }
                        }
                        .disabled(blocker != nil)
                    }
                    if let simId = call.simId, !number.isEmpty, !call.isInternal {
                        WideButton(title: "发短信", fill: Signal.brand, ink: Signal.onBrand) {
                            store.path.append(.conversation(simId: simId, number: PhoneNumberText.normalized(number)))
                        }
                    }
                    if !number.isEmpty, !call.isInternal, call.isBlocked == false {
                        WideButton(title: "屏蔽此号码", ink: Signal.danger) { confirmingBlock = true }
                    }
                    if let message { Text(message).font(.system(size: 11)).foregroundStyle(Signal.ink2) }
                }
            }
            .navigationTitle("详情")
            .task { await store.markSeen(call) }
            .confirmationDialog("屏蔽 \(number)？", isPresented: $confirmingBlock, titleVisibility: .visible) {
                Button("屏蔽", role: .destructive) {
                    Task { message = await store.block(number: number, sourceCallId: call.id) ?? "已屏蔽" }
                }
                Button("取消", role: .cancel) {}
            }
        } else {
            Text("通话记录不存在").foregroundStyle(Signal.ink3)
        }
    }
}

// MARK: - 10 短信

/// Threads per (SIM, number), built with the shared `MessageConversation.grouped` for each SIM.
@MainActor
func watchConversations(_ store: WatchSessionStore) -> [MessageConversation] {
    let simIDs = Set(store.sms.compactMap(\.simId))
    return simIDs.flatMap { MessageConversation.grouped(store.sms, selectedSIMID: $0) }
        .sorted { ($0.latest?.createdAt ?? "") > ($1.latest?.createdAt ?? "") }
}

struct SMSListView: View {
    @Environment(WatchSessionStore.self) private var store
    @State private var shownCode: String?

    var body: some View {
        let sims = store.sims
        let conversations = watchConversations(store)
        List {
            if conversations.isEmpty {
                ListPlaceholder(state: store.loadState(.sms), emptyText: "暂无短信") { await store.refreshSMS() }
            }
            ForEach(conversations) { conversation in
                let unread = conversation.messages.filter { $0.unread == true }
                let code = conversation.latest?.direction == "incoming" ? VerificationCodeText.code(in: conversation.latest?.body) : nil
                VStack(alignment: .leading, spacing: 4) {
                    NavigationLink(value: WatchRoute.conversation(simId: conversation.id.simID, number: conversation.id.remoteNumber)) {
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 4) {
                                Text(conversation.contactName ?? conversation.displayNumber).font(.system(size: 16, weight: .semibold))
                                    .lineLimit(1)
                                Spacer(minLength: 2)
                                Text(WatchTime.rowTime(conversation.latest?.createdAt)).font(.system(size: 13)).monospacedDigit()
                                    .foregroundStyle(Signal.ink3)
                                UnreadBadge(count: unread.count)
                            }
                            HStack(spacing: 3) {
                                SIMSquare(sim: sims.first { $0.id == conversation.id.simID }, sims: sims)
                                Text(conversation.latest?.body ?? "").font(.system(size: 13)).foregroundStyle(Signal.ink3).lineLimit(1)
                            }
                        }
                    }
                    if let code {
                        // watchOS has no pasteboard: 复制 shows the code large to read off, and marks the thread read (S97).
                        Button {
                            shownCode = code
                            Task { await store.markRead(unread.map(\.id)) }
                        } label: {
                            Text("复制验证码 \(code)").font(.system(size: 13, weight: .semibold)).monospacedDigit()
                                .foregroundStyle(Signal.brand).padding(.horizontal, 10).frame(minHeight: 32)
                                .background(Signal.brandSoft, in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .signalRow()
            }
        }
        .navigationTitle("短信")
        .task { await store.refreshSMS() }
        .sheet(item: Binding(get: { shownCode.map(CodeItem.init) }, set: { shownCode = $0?.code })) { item in
            VStack(spacing: 6) {
                Text("验证码").font(.system(size: 12)).foregroundStyle(Signal.ink3)
                Text(item.code).font(.system(size: 32, weight: .semibold)).monospacedDigit()
            }
        }
    }
}

private struct CodeItem: Identifiable { let code: String; var id: String { code } }

// MARK: - 11 会话

struct ConversationView: View {
    @Environment(WatchSessionStore.self) private var store
    let simId: String
    let number: String
    @State private var draft = ""
    @State private var sending = false
    @State private var error: String?

    private static let quickReplies = ["好的", "稍后回电", "我在开会"]

    var body: some View {
        let sims = store.sims
        let conversation = MessageConversation.grouped(store.sms, selectedSIMID: simId)
            .first { $0.id.remoteNumber == ConversationAddress.key(number) }
        let messages = conversation?.messages ?? []
        let canSend = SIMSelectionPolicy.canSendSMS(on: simId, sims: sims) && (conversation?.canReply ?? true)
        let replyTo = conversation?.replyNumber ?? PhoneNumberText.normalized(number)
        ScrollView {
            VStack(spacing: 6) {
                if messages.isEmpty, store.loadState(.sms) != .loaded {
                    ListPlaceholder(state: store.loadState(.sms), emptyText: "") { await store.refreshSMS() }
                }
                ForEach(messages) { message in bubble(message) }
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 3) {
                        Text("从").font(.system(size: 12)).foregroundStyle(Signal.ink3)
                        SIMSquare(sim: sims.first { $0.id == simId }, sims: sims)
                        Text("\(simTitle(simId, in: sims)) 发送").font(.system(size: 12)).foregroundStyle(Signal.ink3)
                    }
                    if !canSend {
                        Text(conversation?.canReply == false ? "该号码不支持回复" : "线路离线，暂不能发送")
                            .font(.system(size: 12)).foregroundStyle(Signal.warn)
                    }
                    ForEach(Self.quickReplies, id: \.self) { reply in
                        Button { send(reply, to: replyTo) } label: { Text(reply).font(.system(size: 15)) }
                            .disabled(!canSend || sending)
                    }
                    // Native field: dictation and Scribble come with it.
                    TextField("回复…", text: $draft).font(.system(size: 15)).onSubmit { send(draft, to: replyTo) }
                    if !draft.trimmingCharacters(in: .whitespaces).isEmpty {
                        Button { send(draft, to: replyTo) } label: { Text("发送").font(.system(size: 15, weight: .semibold)) }
                            .foregroundStyle(Signal.brand).disabled(!canSend || sending)
                    }
                    if let error { Text(error).font(.system(size: 12)).foregroundStyle(Signal.danger) }
                }
                .padding(.top, 4)
            }
        }
        .navigationTitle(conversation?.contactName ?? conversation?.displayNumber ?? number)
        .task {
            if store.sms.isEmpty { await store.refreshSMS() }
            await store.markRead(messages.filter { $0.unread == true && $0.direction == "incoming" }.map(\.id))
        }
    }

    private func send(_ text: String, to replyTo: String) {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, !sending else { return }
        Task {
            sending = true
            error = await store.sendSMS(simId: simId, to: replyTo, body: body)
            if error == nil { draft = "" }
            sending = false
        }
    }

    @ViewBuilder private func bubble(_ message: SMSMessage) -> some View {
        let outgoing = message.direction == "outgoing"
        VStack(alignment: outgoing ? .trailing : .leading, spacing: 2) {
            Text(message.body ?? "").font(.system(size: 15))
                .foregroundStyle(outgoing ? Color.white : Signal.ink)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(outgoing ? Signal.bubbleOut : Signal.surface3, in: RoundedRectangle(cornerRadius: 16))
            if outgoing {
                outgoingStatus(message.state).font(.system(size: 12)).monospacedDigit()
            } else {
                Text(WatchTime.clock(message.createdAt)).font(.system(size: 12)).monospacedDigit().foregroundStyle(Signal.ink3)
            }
        }
        // ~80% max width: the far side keeps a fifth of the column free.
        .containerRelativeFrame(.horizontal, alignment: outgoing ? .trailing : .leading) { width, _ in width * 0.8 }
        .frame(maxWidth: .infinity, alignment: outgoing ? .trailing : .leading)
    }

    @ViewBuilder private func outgoingStatus(_ state: String?) -> some View {
        switch state {
        case "failed": Text("失败").foregroundStyle(Signal.danger)
        case "sent", "delivered": Text("已发送").foregroundStyle(Signal.ink3)
        default: StatusShape(kind: .pending, text: "排队中").foregroundStyle(Signal.warn)
        }
    }
}

// MARK: - 12 线路

struct LinesView: View {
    @Environment(WatchSessionStore.self) private var store

    var body: some View {
        let sims = store.sims
        List {
            if sims.isEmpty {
                ListPlaceholder(state: store.loadState(.sims), emptyText: "暂无线路") { await store.refreshOverview() }
            }
            ForEach(sims, id: \.id) { sim in
                NavigationLink(value: WatchRoute.mode(sim.id)) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 5) {
                            SIMSquare(sim: sim, sims: sims, size: 10)
                            Text(simTitle(sim.id, in: sims)).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                            Spacer(minLength: 2)
                            StatusShape(kind: sim.online == true ? .on : .off, text: sim.online == true ? "在线" : "离线")
                                .font(.system(size: 11)).foregroundStyle(Signal.ink2)
                        }
                        HStack(spacing: 4) {
                            Text(sim.gatewayName ?? GatewayKind(sim.gatewayKind).deviceName).lineLimit(1)
                            if let settings = sim.settings, let mode = ReceptionMode(rawValue: settings.mode) {
                                Text("·")
                                if mode != .normal { AiBadge() }
                                Text(mode.watchTitle(timeout: settings.timeoutSeconds)).lineLimit(1)
                            }
                        }
                        .font(.system(size: 11)).foregroundStyle(Signal.ink3)
                    }
                }
                .signalRow()
            }
            Section { ConnectionFooter() }.listRowBackground(Color.clear)
            // S117: the S105 「音频回环测试」 entry is hidden; WatchAudioLoopbackView stays in the target. To bring it
            // back for a test build: NavigationLink { WatchAudioLoopbackView() } label: { Text("音频回环测试") }.
        }
        .navigationTitle("线路")
        .task { await store.refreshOverview() }
    }
}

// MARK: - 13 接听方式

struct AnswerModeView: View {
    @Environment(WatchSessionStore.self) private var store
    let simId: String
    @State private var saving = false
    @State private var message: String?

    var body: some View {
        let sims = store.sims
        if let sim = sims.first(where: { $0.id == simId }), let settings = sim.settings {
            let offline = sim.online != true
            let disabledReason = !store.connected && !store.preview ? "iPhone 未连接，暂不能更改" : (offline ? "线路离线，暂不能更改" : nil)
            List {
                SIMChip(sim: sim, sims: sims).listRowBackground(Color.clear)
                ForEach([ReceptionMode.normal, .timeoutAI, .ai]) { mode in
                    let selected = settings.mode == mode.rawValue
                    let available = settings.isAvailable(mode)
                    Button {
                        guard !selected else { return }
                        Task { await save(sim: sim, mode: mode) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(mode.watchTitle(timeout: settings.timeoutSeconds)).font(.system(size: 14, weight: .semibold))
                                Text(available ? mode.watchSubtitle : (settings.aiUnavailableReason ?? "AI 代接暂不可用"))
                                    .font(.system(size: 11)).foregroundStyle(Signal.ink3)
                            }
                            Spacer(minLength: 2)
                            if selected { Image(systemName: "checkmark").foregroundStyle(Signal.brand) }
                        }
                    }
                    .disabled(saving || (!selected && (!available || disabledReason != nil)))
                    .listRowBackground(RoundedRectangle(cornerRadius: 12)
                        .fill(selected ? Signal.brandSoft : Signal.surface2)
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(selected ? Signal.brand : .clear, lineWidth: 1.5)))
                }
                Group {
                    if let note = message ?? disabledReason {
                        Text(note).foregroundStyle(Signal.warn)
                    } else {
                        Text("\(SettingsApplyPolicy.subtitle(appliedVersion: settings.appliedVersion, version: settings.version)) · v\(settings.version)")
                            .monospacedDigit().foregroundStyle(Signal.ink3)
                    }
                }
                .font(.system(size: 10)).listRowBackground(Color.clear)
            }
            .navigationTitle("接听方式")
        } else {
            Text("该线路暂无接听设置").foregroundStyle(Signal.ink3).navigationTitle("接听方式")
        }
    }

    private func save(sim: SIMChannel, mode: ReceptionMode) async {
        saving = true
        defer { saving = false }
        switch await store.saveMode(sim: sim, mode: mode) {
        case .saved: message = nil
        case .conflict: message = "设置已在别处更改"
        case let .failed(text): message = text
        }
    }
}
