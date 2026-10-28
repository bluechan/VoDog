import SwiftUI

// S139: the 电话 / 短信 line = an account SIM (`VoDogPhone.sim.v1`) or, when
// `VoDogPhone.localLine.v1` holds the raw `CellularModuleID` of a local-only module, this Mac's module.
// A stale local line (module unplugged, or now serving an account SIM) is ignored, never rewritten.

enum VoDogLinePolicy {
    static let localLineKey = "VoDogPhone.localLine.v1"

    /// A module is local-only unless one of this Mac's gateway runtimes with its IMEI serves an account SIM.
    static func isLocalOnly(imei: String?, runtimes: [(imei: String, simID: String?)], accountSIMIDs: Set<String>) -> Bool {
        guard let imei, !imei.isEmpty else { return true }
        return !runtimes.contains { $0.imei == imei && $0.simID.map(accountSIMIDs.contains) == true }
    }
}

@MainActor
extension AppState {
    /// Attached modules that are not an account line here (signed out → every attached module).
    var localOnlyModules: [CellularModuleSummary] {
        let accountSIMIDs = voDog.user == nil ? [] : Set(voDog.sims.map(\.id))
        let runtimes = gateway.runtimes.map { (imei: $0.imei, simID: $0.sim?.id) }
        return cellularModules.filter {
            $0.modem.isConnected
                && VoDogLinePolicy.isLocalOnly(imei: $0.modem.moduleIMEI, runtimes: runtimes, accountSIMIDs: accountSIMIDs)
        }
    }

    /// The stored local line when it is still a present local-only module; nil = use the account line.
    func localOnlyModule(storedLine raw: String) -> CellularModuleSummary? {
        guard !raw.isEmpty else { return nil }
        return localOnlyModules.first { $0.id.rawValue == raw }
    }
}

/// Re-renders `content` when the gateway runtime list changes (AppState does not forward GatewayAgent).
struct VoDogGatewayReader<Content: View>: View {
    @ObservedObject var gateway: GatewayAgent
    @ViewBuilder var content: () -> Content

    var body: some View { content() }
}

/// Header line popup (spec 01 §5 线路选择): account SIMs (online first), then a 「这台 Mac」 group of local-only
/// modules. Works with zero account SIMs (signed out). Picking an account SIM clears the local line.
struct VoDogLineMenu: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var account: VoDogAccount
    @AppStorage("VoDogPhone.sim.v1") private var storedSIM = ""
    @AppStorage(VoDogLinePolicy.localLineKey) private var localLine = ""

    private var fresh: Bool { account.simsError == nil }
    private var signedIn: Bool { account.user != nil }

    /// Repair-only writes from the 5 s refresh; they must not touch the local line.
    private var simRepair: Binding<String?> {
        Binding(get: { storedSIM.isEmpty ? nil : storedSIM }, set: { storedSIM = $0 ?? "" })
    }

    var body: some View {
        VoDogGatewayReader(gateway: appState.gateway) { menu }
            .voDogSIMRefresh(account: account, selection: simRepair)
    }

    private var menu: some View {
        let modules = appState.localOnlyModules
        let local = appState.localOnlyModule(storedLine: localLine)
        let usesLocal = local != nil || !signedIn
        // The app's current module dials and sends on the local route, so the menu shows it when it is a local line.
        let shown = modules.first { $0.id == appState.currentCommunicationModuleID } ?? local ?? modules.first
        return HStack(spacing: 6) {
            if signedIn, let error = account.simsError {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Signal.warn)
                    .help(error)
                    .accessibilityLabel(error)
            }
            Menu {
                if signedIn {
                    ForEach(VoDogPhonePolicy.displayOrder(account.sims, fresh: fresh)) { sim in
                        Toggle(isOn: Binding(get: { !usesLocal && storedSIM == sim.id },
                                             set: { if $0 { storedSIM = sim.id; localLine = "" } })) {
                            Text(verbatim: [sim.displayName, sim.phoneLabel, status(sim), AiBadge.menuSuffix(sim.settings)]
                                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        }
                    }
                }
                if !modules.isEmpty {
                    Section(L10n.tr("这台 Mac")) {
                        ForEach(modules) { module in
                            Toggle(isOn: Binding(get: { usesLocal && shown?.id == module.id },
                                                 set: { if $0 {
                                                     localLine = module.id.rawValue
                                                     appState.selectCommunicationModule(module.id)
                                                 } })) {
                                Text(verbatim: moduleText(module))
                            }
                        }
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    if usesLocal, let module = shown {
                        LineBlock(color: appState.lineColor(for: module.id), size: 8)
                        Text(verbatim: module.localizedDisplayName).lineLimit(1)
                        Text(L10n.tr("这台 Mac")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    } else if !usesLocal, let sim = account.sims.first(where: { $0.id == storedSIM }) {
                        LineBlock(color: color(sim), size: 8)
                        Text(verbatim: sim.displayName).lineLimit(1)
                        AiBadge(settings: sim.settings)
                        LineStatusShape(status: VoDogPhonePolicy.showsOnline(sim, fresh: fresh) ? .online : .offline)
                    } else if signedIn {
                        Text(account.simsLoaded ? L10n.tr("没有已分配的 SIM") : L10n.tr("正在读取号码…")).lineLimit(1)
                    } else {
                        Text(L10n.tr("这台 Mac")).lineLimit(1)
                    }
                }
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .padding(.horizontal, 8)
            .frame(height: 28)
            .background(Signal.surface2, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .disabled(account.sims.isEmpty && modules.isEmpty)
            .help(L10n.tr("线路"))
            .accessibilityLabel(L10n.tr("线路"))
            .accessibilityValue(currentText(local: usesLocal ? shown : nil))
        }
    }

    private func currentText(local: CellularModuleSummary?) -> String {
        if let local { return moduleText(local) }
        if let sim = account.sims.first(where: { $0.id == storedSIM }) { return sim.displayName }
        return signedIn ? (account.simsLoaded ? L10n.tr("没有已分配的 SIM") : L10n.tr("正在读取号码…")) : L10n.tr("这台 Mac")
    }

    private func moduleText(_ module: CellularModuleSummary) -> String {
        [module.localizedDisplayName, module.modem.simPhoneNumber, module.carrierName]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func color(_ sim: VoDogSIM) -> Color {
        .voDogSIM(rank: VoDogPhonePolicy.colorRank(of: sim.id, in: account.sims))
    }

    private func status(_ sim: VoDogSIM) -> String {
        !fresh ? L10n.tr("号码状态待刷新")
            : VoDogPhonePolicy.showsOnline(sim, fresh: fresh) ? L10n.tr("在线") : L10n.tr("号码设备离线")
    }
}
