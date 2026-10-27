import SwiftUI

// S139 page hosts for the main window: 记录 (通话 | 转录报告 | 拦截 | 本机录音), 通讯录 (VoDog | 这台 Mac)
// and the minimized-call 「返回通话」 bar. They only re-host existing views.

enum CommunicationRecordsSegment: String, CaseIterable {
    case calls, reports, interceptions, recordings

    static let storageKey = "CommunicationRecords.segment.v1"

    /// L10n keys; `CommunicationGlassTabs` localizes them.
    var titleKey: String {
        switch self {
        case .calls: return "通话"
        case .reports: return "转录报告"
        case .interceptions: return "拦截"
        case .recordings: return "本机录音"
        }
    }
}

struct CommunicationRecordsView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var model: PhoneWindowModel
    @ObservedObject var account: VoDogAccount
    @ObservedObject var contacts: SystemContactStore
    @Binding var sidebarWidth: CGFloat
    @AppStorage(CommunicationRecordsSegment.storageKey) private var stored = CommunicationRecordsSegment.calls.rawValue
    /// Signed out only 本机录音 works, so it is the default there; that choice is not persisted.
    @State private var signedOutSegment = CommunicationRecordsSegment.recordings

    private var signedIn: Bool { account.user != nil }

    private var segment: Binding<CommunicationRecordsSegment> {
        if !signedIn { return $signedOutSegment }
        return Binding(get: { CommunicationRecordsSegment(rawValue: stored) ?? .calls },
                       set: { stored = $0.rawValue })
    }

    /// 通话 / 转录报告 are the two pages of `VoDogRecordsView`, driven from here.
    private var recordsPage: Binding<VoDogRecordsPage> {
        Binding(get: { segment.wrappedValue == .reports ? .reports : .calls },
                set: { segment.wrappedValue = $0 == .reports ? .reports : .calls })
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text(L10n.tr("记录")).font(.headline)
                Spacer(minLength: 8)
                CommunicationGlassTabs(
                        items: CommunicationRecordsSegment.allCases.map { ($0, $0.titleKey) },
                        selection: segment
                    )
                    .overlay {
                        // S67: the calls badge sits on the 通话 quarter (tabs are equal width).
                        HStack(spacing: 0) {
                            Color.clear.overlay(alignment: .topTrailing) {
                                VoDogBadgeCount(store: account.badges, kind: .calls).offset(x: -2, y: -6)
                            }
                            Color.clear
                            Color.clear
                            Color.clear
                        }
                        .allowsHitTesting(false)
                    }
                    .frame(maxWidth: 420)
            }
            .signalToolbar()

            content.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private var content: some View {
        let current = segment.wrappedValue
        if !signedIn, current != .recordings {
            CommunicationLoginCard(account: account)
        } else {
            switch current {
        case .calls, .reports:
            VoDogRecordsView(account: account, sidebarWidth: $sidebarWidth, page: recordsPage)
        case .interceptions:
            VoDogInterceptionsView(account: account, showsTitle: false)
        case .recordings:
            RecordingsLibraryView(
                recordings: appState.callRecordings,
                contacts: contacts,
                selectedRecordingID: $model.selectedRecordingID,
                sidebarWidth: $sidebarWidth,
                focusFirstItemRequest: model.pendingListFocusSection == .records,
                didHandleFocusFirstItemRequest: {
                    model.consumeListFocusRequest(for: .records)
                }
            )
            }
        }
    }
}

/// Signed-out stand-in for account-backed pages; the button opens 设置 › 账号 (the login page).
struct CommunicationLoginCard: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var account: VoDogAccount

    var body: some View {
        VStack {
            VoDogCard(title: L10n.tr("登录 VoDog")) {
                Text(L10n.tr("登录后可在这台 Mac 上管理通讯录、屏蔽名单、通话记录与接听设置。"))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(L10n.tr("登录 VoDog")) { appState.showSettings(.account) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityLabel(L10n.tr("登录 VoDog"))
            }
            .frame(maxWidth: 460)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct CommunicationContactsView<Local: View>: View {
    private enum Source: String { case vodog, mac }

    @ObservedObject var account: VoDogAccount
    @ViewBuilder let local: () -> Local
    @AppStorage("CommunicationContacts.source.v1") private var stored = Source.vodog.rawValue

    var body: some View {
        // Signed out there is only this Mac's address book, so the switch is hidden.
        if account.user == nil {
            local()
        } else {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Text(L10n.tr("通讯录")).font(.headline)
                    Spacer(minLength: 8)
                    CommunicationGlassTabs(
                        items: [(Source.vodog.rawValue, "VoDog"), (Source.mac.rawValue, "这台 Mac")],
                        selection: $stored
                    )
                    .frame(maxWidth: 240)
                }
                .signalToolbar()

                Group {
                    if stored == Source.mac.rawValue {
                        local()
                    } else {
                        VoDogContactsView(account: account)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

/// Green full-width bar above every page while a local call is minimized; tap restores the call view.
struct ReturnToCallBar: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var contacts: SystemContactStore
    let action: () -> Void

    var body: some View {
        let number = appState.call.number ?? L10n.tr("未知号码")
        let name = CommunicationUI.displayText(contacts.displayName(for: number), number)
        Button(action: action) {
            HStack(spacing: 10) {
                Circle().fill(Color.white).frame(width: 8, height: 8)
                Text(verbatim: name).font(.callout.weight(.semibold)).lineLimit(1)
                if appState.call.phase == .active, let startedAt = appState.call.startedAt {
                    Text(startedAt, style: .timer).font(.callout.monospacedDigit())
                }
                if let line = appState.lineName(for: appState.call.moduleID) {
                    Text(verbatim: line).font(.caption).opacity(0.9).lineLimit(1)
                }
                Spacer(minLength: 8)
                Text(L10n.tr("返回通话"))
                    .font(.callout.weight(.semibold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Color.white.opacity(0.18), in: Capsule())
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(Signal.callFill)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L10n.tr("返回通话"))
        .accessibilityValue(name)
    }
}
