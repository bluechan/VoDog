import SwiftUI

/// S139 电话 (signed in, account line): recent calls of the selected account SIM (`GET /calls?simId=`) with
/// 全部 | 未接来电; the detail column is the selected call's `VoDogRecordDetail` or, with nothing
/// selected, the dialer. The full list lives in 记录.
struct VoDogPhoneRecentsView: View {
    @ObservedObject var account: VoDogAccount
    @Binding var sidebarWidth: CGFloat
    @StateObject private var player = VoDogRecordingPlayer()
    @AppStorage("VoDogPhone.sim.v1") private var storedSIM = ""

    @State private var missedOnly = false
    @State private var query = ""
    @State private var calls: [CCCallRecord] = []
    @State private var loadedPage = 0
    @State private var totalPages = 1
    @State private var loading = false
    @State private var listError: String?
    @State private var reloadToken = 0
    @State private var selectedID: String?

    private static let pageSize = 50

    private struct RequestKey: Equatable { var sim: String, query: String, token: Int }
    private var requestKey: RequestKey { RequestKey(sim: storedSIM, query: query, token: reloadToken) }

    /// Same predicate as iOS `CallRecord.isMissedIncoming`; the server has no missed filter.
    // ponytail: filters only the pages loaded so far; 加载更多 fetches the next 50.
    private var shown: [CCCallRecord] { missedOnly ? calls.filter(\.isMissedIncoming) : calls }

    private var sims: [CCSimItem] {
        account.sims.map { CCSimItem(id: $0.id, label: $0.label, phoneLabel: $0.phoneLabel, slotIndex: $0.slotIndex,
                                     gatewayId: $0.gatewayId, gatewayKind: $0.gatewayKind) }
    }

    var body: some View {
        ResizableCommunicationSplit(sidebarWidth: $sidebarWidth) {
            sidebar.communicationSidebarColumnStyle()
        } detail: {
            detail.frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
        }
        .task(id: requestKey) { await reload() }
        .onChange(of: storedSIM) { _, _ in selectedID = nil }
        // S139: a handed-over number (菜单栏 拨号 / 通讯录 拨打) needs the dialer on screen.
        .onReceive(CommunicationWindowController.shared.phoneModel.$dialNumber) { if !$0.isEmpty { selectedID = nil } }
        .onDisappear { player.stop() }
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(L10n.tr("电话")).font(.headline)
                Spacer(minLength: 6)
                VoDogLineMenu(account: account)
                if let sim = account.sims.first(where: { $0.id == storedSIM }) { AiBadge(settings: sim.settings, full: true) }
                if selectedID != nil {
                    CommunicationIconActionButton(systemImage: "circle.grid.3x3.fill", accessibilityLabel: L10n.tr("拨号盘")) {
                        selectedID = nil
                    }
                }
            }
            .signalToolbar()

            TextField(L10n.tr("搜索姓名或号码"), text: $query)
                .communicationSearchField()
                .padding(.horizontal, 14)
                .padding(.top, 10)
                .padding(.bottom, 8)

            CommunicationGlassTabs(items: [(false, "全部"), (true, "未接来电")], selection: $missedOnly)
                .padding(.horizontal, 14)
                .padding(.bottom, 8)

            listBody
        }
    }

    @ViewBuilder private var listBody: some View {
        if let listError, calls.isEmpty {
            VStack(spacing: 10) {
                Label(listError, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                Button(L10n.tr("重试")) { reloadToken += 1 }.adaptiveGlassButton()
            }
            .font(.callout)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding()
        } else if shown.isEmpty && !(missedOnly && loadedPage < totalPages) {
            VStack(spacing: 8) {
                if loading { ProgressView().controlSize(.small) }
                Text(L10n.tr(loading ? "正在读取…"
                    : !query.trimmingCharacters(in: .whitespaces).isEmpty ? "没有匹配的通话"
                    : missedOnly ? "没有未接来电" : "暂无通话记录"))
                    .font(.callout).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List {
                ForEach(shown) { call in
                    VoDogBadgeReader(store: account.badges) { badges in
                        let unseen = call.showsUnseenDot(seen: badges.seenCalls)
                        let ownSIM = simTitle(call.simId)
                        Button { select(call) } label: {
                            VoDogCallRow(call: call, simTitle: simLine(call.simId), ownSIM: ownSIM, unseen: unseen)
                                .communicationSelectionHighlight(selectedID == call.id)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel((unseen ? L10n.tr("未查看") + "，" : "")
                            + rowLabel(number: call.remoteNumber, name: call.internal == true ? recordTitle(call, ownSIM: ownSIM) : call.contactName,
                                       state: call.isMissedIncoming ? "未接来电" : CCRecordLabels.state(call.state, failureReason: call.failureReason))
                            + VoDogLocation.accessibilitySuffix(call.remoteLocation))
                        .accessibilityAddTraits(selectedID == call.id ? .isSelected : [])
                    }
                    .listRowInsets(CommunicationUI.listRowInsets)
                }
                if loadedPage < totalPages {
                    Button(L10n.tr("加载更多")) { Task { await load(page: loadedPage + 1) } }
                        .buttonStyle(.borderless)
                        .disabled(loading)
                        .frame(maxWidth: .infinity)
                }
                if let listError {
                    Label(listError, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.red)
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .communicationSidebarScrollEdgeEffect()
        }
    }

    @ViewBuilder private var detail: some View {
        if let selectedID {
            VoDogRecordDetail(
                account: account,
                player: player,
                callId: selectedID,
                seed: calls.first { $0.id == selectedID },
                report: nil,
                simTitle: { simLine($0) },
                onBlocked: { reloadToken += 1 },
                onDeleted: {
                    calls.removeAll { $0.id == selectedID }
                    self.selectedID = nil
                    reloadToken += 1
                }
            )
            .id(selectedID)
        } else {
            VoDogDialerView(account: account, showsSIMStrip: false)
        }
    }

    private func select(_ call: CCCallRecord) {
        selectedID = call.id
        markCallSeen(call.id, call: call, account: account)
    }

    private func simTitle(_ id: String?) -> String? { id.flatMap { id in sims.first { $0.id == id }?.title } }
    private func simLine(_ id: String?) -> String? { id.flatMap { id in sims.first { $0.id == id }?.lineText } }

    private func reload() async {
        if !query.isEmpty {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
        }
        calls = []
        loadedPage = 0
        totalPages = 1
        // No SIM yet (the line menu repairs it within one refresh): show the empty state, not every SIM's calls.
        guard !storedSIM.isEmpty else { loading = false; return }
        await load(page: 1)
    }

    private func load(page: Int) async {
        let key = requestKey
        loading = true
        defer { if requestKey == key { loading = false } }
        var params = ["page": String(page), "pageSize": String(Self.pageSize), "simId": key.sim,
                      // S38：拦截掉的来电也要出现在记录里。
                      "includeBlocked": "true"]
        let text = key.query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { params["query"] = String(text.prefix(64)) }
        do {
            let result = try CCRecords.decode(CCCallsPage.self, from: try await account.json("GET", "/calls", query: params))
            guard !Task.isCancelled, requestKey == key else { return }
            let known = Set(calls.map(\.id))
            calls = page == 1 ? result.items : calls + result.items.filter { !known.contains($0.id) }
            loadedPage = page
            totalPages = max(result.totalPages ?? 1, 1)
            listError = nil
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled, requestKey == key else { return }
            listError = VoDogRecordsError.message(error)
        }
    }
}
