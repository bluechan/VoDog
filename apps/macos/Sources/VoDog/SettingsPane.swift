import Foundation

/// S139 设置 panes, in the S138 order shared with iOS / Android.
enum SettingsPane: String, CaseIterable, Identifiable {
    case appearance, aiAnswer, sims, gateways, privacy, notifications, device, account

    var id: String { rawValue }

    var title: String {
        switch self {
        case .appearance: return L10n.tr("外观")
        case .aiAnswer: return L10n.tr("AI 代接")
        case .sims: return L10n.tr("SIM 卡")
        case .gateways: return L10n.tr("网关设备")
        case .privacy: return L10n.tr("隐私与安全")
        case .notifications: return L10n.tr("通知与声音")
        case .device: return L10n.tr("设备与连接")
        case .account: return L10n.tr("账号")
        }
    }

    var systemImage: String {
        switch self {
        case .appearance: return "paintbrush"
        case .aiAnswer: return "sparkles"
        case .sims: return "simcard"
        case .gateways: return "server.rack"
        case .privacy: return "hand.raised"
        case .notifications: return "bell.badge"
        case .device: return "desktopcomputer"
        case .account: return "person.crop.circle"
        }
    }

    var detail: String {
        switch self {
        case .appearance: return L10n.tr("主题与应用语言")
        case .aiAnswer: return L10n.tr("语音服务与通讯录来电")
        case .sims: return L10n.tr("号码备注与接听方式")
        case .gateways: return L10n.tr("账号下的网关与这台 Mac")
        case .privacy: return L10n.tr("已屏蔽号码 · 通行密钥 · 验证码")
        case .notifications: return L10n.tr("系统通知 · 提示音与铃声")
        case .device: return L10n.tr("权限 · 登录时启动 · 菜单栏")
        case .account: return L10n.tr("账号信息与当前会话")
        }
    }
}

@MainActor
extension AppState {
    /// Opens the main window on 设置 with `pane` selected.
    func showSettings(_ pane: SettingsPane) {
        CommunicationWindowController.shared.phoneModel.settingsPane = pane
        showPhoneWindow(section: .settings)
    }
}
