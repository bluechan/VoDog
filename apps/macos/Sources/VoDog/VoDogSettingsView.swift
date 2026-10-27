import AppKit
import AVFoundation
import SwiftUI
import UniformTypeIdentifiers

/// S139 设置: the eight S138 panes, each built from the existing cards.
struct VoDogSettingsView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject private var contacts = SystemContactStore.shared
    @ObservedObject private var alertSounds = AlertSoundService.shared
    @ObservedObject private var languageController = AppLanguageController.shared
    @Binding private var sidebarWidth: CGFloat
    @Binding private var pane: SettingsPane
    private let focusFirstItemRequest: Bool
    private let didHandleFocusFirstItemRequest: () -> Void
    @AppStorage(AppAppearanceMode.defaultsKey) private var appearanceModeRawValue =
        AppAppearanceMode.system.rawValue
    @State private var isConfirmingVerificationAutoDelete = false
    @State private var soundImportError: String?
    @State private var microphoneAuthorizationStatus =
        AVCaptureDevice.authorizationStatus(for: .audio)
    @FocusState private var listFocused: Bool

    init(
        sidebarWidth: Binding<CGFloat> = .constant(CommunicationUI.sidebarWidth),
        pane: Binding<SettingsPane>,
        focusFirstItemRequest: Bool = false,
        didHandleFocusFirstItemRequest: @escaping () -> Void = {}
    ) {
        _sidebarWidth = sidebarWidth
        _pane = pane
        self.focusFirstItemRequest = focusFirstItemRequest
        self.didHandleFocusFirstItemRequest = didHandleFocusFirstItemRequest
    }

    var body: some View {
        ResizableCommunicationSplit(sidebarWidth: $sidebarWidth) {
            settingsSidebar
        } detail: {
            SettingsDetailHost(account: appState.voDog, pane: pane) {
                settingsHeader
                settingsCards
            }
        }
        .frame(
            minWidth: 560,
            maxWidth: .infinity,
            maxHeight: .infinity
        )
        .onAppear {
            refreshSettingsState()
            handleFocusFirstItemRequest()
        }
        .onChange(of: pane) { _, current in refreshState(for: current) }
        .onChange(of: focusFirstItemRequest) { _, requested in
            if requested { handleFocusFirstItemRequest() }
        }
        .onReceive(NotificationCenter.default.publisher(
            for: NSApplication.didBecomeActiveNotification
        )) { _ in
            refreshSystemPermissionState()
        }
        .alert("开启验证码自动删除？", isPresented: $isConfirmingVerificationAutoDelete) {
            Button("取消", role: .cancel) { }
            Button("开启", role: .destructive) {
                appState.setAutoDeleteReadVerificationMessages(true)
            }
        } message: {
            Text("验证码短信被标记已读 30 分钟后，将从模块/SIM 和本地永久删除，无法撤销。")
        }
        .alert(
            "无法使用音频文件",
            isPresented: Binding(
                get: { soundImportError != nil },
                set: { if !$0 { soundImportError = nil } }
            )
        ) {
            Button("好", role: .cancel) { soundImportError = nil }
        } message: {
            Text(soundImportError ?? L10n.tr("请选择其他音频文件。"))
        }
    }

    private var settingsSidebar: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(L10n.tr("设置"))
                        .font(.title2.bold())
                        .padding(.horizontal, 14)

                    VStack(spacing: 2) {
                        ForEach(SettingsPane.allCases) { item in
                            settingsSidebarRow(item)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 16)
            }
            .communicationSidebarScrollEdgeEffect()

            Text(verbatim: "VoDog · \(appVersion)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 12)
                .accessibilityLabel("VoDog \(appVersion)")
        }
        .communicationInitialListFocus($listFocused)
        .communicationSidebarColumnStyle()
    }

    private func settingsSidebarRow(_ item: SettingsPane) -> some View {
        let isSelected = pane == item

        return Button {
            pane = item
        } label: {
            HStack(spacing: 11) {
                Image(systemName: item.systemImage)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                    .frame(width: 24)

                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.body.weight(isSelected ? .semibold : .regular))
                        .foregroundStyle(isSelected ? Color.accentColor : Color.primary)
                    Text(item.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 4)

                if item == .device, allSettingsPermissionsAllowed {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Signal.call)
                        .accessibilityLabel(L10n.tr("已允许"))
                }

                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background {
            if isSelected {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .fill(Color.accentColor.opacity(0.12))
                    .overlay {
                        RoundedRectangle(cornerRadius: 13, style: .continuous)
                            .strokeBorder(Color.accentColor.opacity(0.22), lineWidth: 0.7)
                    }
            }
        }
        .accessibilityLabel(item.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func refreshState(for item: SettingsPane) {
        switch item {
        case .gateways: appState.refresh()
        case .notifications, .device: refreshSystemPermissionState()
        default: break
        }
    }

    private func handleFocusFirstItemRequest() {
        guard focusFirstItemRequest else { return }
        didHandleFocusFirstItemRequest()
        listFocused = false
        DispatchQueue.main.async {
            listFocused = true
        }
    }

    private var settingsHeader: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(pane.title)
                .font(.largeTitle.bold())
            Text(pane.detail)
                .font(.body)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var settingsCards: some View {
        let account = appState.voDog
        VStack(spacing: 16) {
            switch pane {
            case .appearance:
                appearanceSettings
            case .aiAnswer:
                SettingsLoginGate(account: account, pane: $pane) {
                    VoDogVoiceProviderCard(account: account)
                }
            case .sims:
                SettingsLoginGate(account: account, pane: $pane) {
                    VoDogNumbersView(account: account)
                }
            case .gateways:
                SettingsLoginGate(account: account, pane: $pane, showsLoginCard: false) {
                    VoDogGatewayPowerCard(account: account)
                }
                GatewaySettingsSection(gateway: appState.gateway)
            case .privacy:
                SettingsLoginGate(account: account, pane: $pane) {
                    VoDogBlockedNumbersView(account: account)
                        .frame(height: 380)
                        .padding(.vertical, 12)
                        .adaptiveGlassSurface(cornerRadius: 18, treatment: .regular)
                    VoDogPasskeysCard(account: account)
                }
                // Local-only (this Mac's own SIMs), so it stays usable while signed out.
                verificationAutoDeleteSettings
            case .notifications:
                notificationSettings
            case .device:
                deviceSettings
            case .account:
                VoDogAccountView(account: account)
            }
        }
    }

    private var appearanceSettings: some View {
        settingsSection(title: L10n.tr("外观与语言")) {
            VStack(spacing: 0) {
                settingRow(
                    title: L10n.tr("主题模式")
                ) {
                    Picker("主题模式", selection: appearanceModeBinding) {
                        ForEach(AppAppearanceMode.allCases) { mode in
                            Text(mode.title)
                                .lineLimit(1)
                                .tag(mode)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .frame(width: 276)
                }
                .padding(16)

                Divider().padding(.horizontal, 16)

                settingRow(
                    title: L10n.tr("应用语言"),
                    detail: L10n.tr("切换后立即应用，无需重新启动")
                ) {
                    Picker("应用语言", selection: languageBinding) {
                        ForEach(AppLanguage.allCases) { language in
                            Text(verbatim: language.nativeName).tag(language)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .frame(width: 142)
                }
                .padding(16)
            }
        }
    }

    private var deviceSettings: some View {
        VStack(spacing: 16) {
            settingsSection(title: L10n.tr("隐私权限")) {
                VStack(spacing: 0) {
                    settingRow(
                        title: L10n.tr("麦克风"),
                        status: microphonePermissionStatus.text,
                        statusColor: microphonePermissionStatus.color,
                        detail: L10n.tr("用于通话时传输本机音频")
                    ) {
                        Button(microphonePermissionButtonTitle) {
                            handleMicrophonePermissionAction()
                        }
                        .adaptiveGlassButton()
                        .controlSize(.small)
                        .frame(width: 112)
                    }
                    .padding(16)

                    Divider().padding(.horizontal, 16)

                    settingRow(
                        title: L10n.tr("通讯录"),
                        status: contactPermissionStatus.text,
                        statusColor: contactPermissionStatus.color,
                        detail: L10n.tr("用于识别来电、短信联系人和拨号")
                    ) {
                        Button(contactPermissionButtonTitle) {
                            handleContactPermissionAction()
                        }
                        .adaptiveGlassButton()
                        .controlSize(.small)
                        .frame(width: 112)
                    }
                    .padding(16)
                }
            }

            inlineMessage(
                L10n.tr("权限由 macOS 管理，可随时在系统设置中更改。"),
                systemImage: "checkmark.shield",
                color: .secondary
            )
            .padding(4)
            .adaptiveGlassSurface(
                cornerRadius: 18,
                padding: 13,
                treatment: .clear
            )

            settingsSection(title: L10n.tr("通话录音")) {
                settingRow(
                    title: L10n.tr("通话录音"),
                    detail: L10n.tr("已接入 VoDog 网关的 SIM，通话录音会自动上传服务器保存，登录后可在其他客户端查看；未接入网关时录音仅保存在这台 Mac。")
                ) {
                    Text(L10n.tr("始终开启"))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .padding(16)
            }

            settingsSection(title: L10n.tr("启动与菜单栏")) {
                VStack(spacing: 0) {
                    settingRow(
                        title: L10n.tr("登录时启动"),
                        detail: launchAtLoginDetail
                    ) {
                        if appState.isChangingLaunchAtLogin {
                            ProgressView().controlSize(.small)
                        } else {
                            settingsToggle(L10n.tr("登录时启动"), isOn: Binding(
                                get: { appState.launchAtLoginStatus.isRegistered },
                                set: { appState.setLaunchAtLogin($0) }
                            ))
                            .disabled(appState.launchAtLoginStatus == .unavailable)
                        }
                    }
                    .padding(16)

                    if let error = appState.launchAtLoginError {
                        inlineMessage(
                            error,
                            systemImage: "exclamationmark.triangle.fill",
                            color: .red
                        )
                        .padding(.horizontal, 16)
                        .padding(.bottom, 14)
                    }

                    Divider().padding(.horizontal, 16)

                    settingRow(
                        title: L10n.tr("未连接模块时隐藏菜单栏图标"),
                        detail: appState.hideMenuBarIconWhenDisconnected
                            ? L10n.tr("重新连接模块后自动显示")
                            : L10n.tr("模块断开后继续显示状态图标")
                    ) {
                        settingsToggle(L10n.tr("未连接模块时隐藏菜单栏图标"), isOn: Binding(
                            get: { appState.hideMenuBarIconWhenDisconnected },
                            set: { appState.setHideMenuBarIconWhenDisconnected($0) }
                        ))
                    }
                    .padding(16)
                }
            }

            settingsSection(title: L10n.tr("应用操作")) {
                settingRow(
                    title: L10n.tr("完全退出 VoDog"),
                    detail: L10n.tr("关闭窗口不会停止短信、来电和模块监测")
                ) {
                    Button(role: .destructive) {
                        appState.quit()
                    } label: {
                        Label("完全退出 VoDog", systemImage: "power")
                    }
                    .adaptiveGlassButton()
                    .tint(.red)
                    .help("完全退出 VoDog，并停止后台短信、来电和模块监测")
                }
                .padding(16)
            }
        }
    }

    private var verificationAutoDeleteSettings: some View {
        settingsSection(title: L10n.tr("短信处理")) {
            VStack(spacing: 12) {
                settingRow(
                    title: L10n.tr("已读验证码自动删除"),
                    detail: L10n.tr("标记已读 30 分钟后，从模块/SIM 与本地永久删除；不适用于已接入 VoDog 的 SIM")
                ) {
                    settingsToggle(L10n.tr("已读验证码自动删除"), isOn: Binding(
                        get: { appState.autoDeleteReadVerificationMessages },
                        set: { enabled in
                            if enabled {
                                isConfirmingVerificationAutoDelete = true
                            } else {
                                appState.setAutoDeleteReadVerificationMessages(false)
                            }
                        }
                    ))
                }

                inlineCallout(
                    L10n.tr("删除后无法恢复，开启时需要确认。"),
                    systemImage: "exclamationmark.triangle.fill",
                    color: .orange
                )
            }
            .padding(16)
        }
    }

    private var notificationSettings: some View {
        VStack(spacing: 16) {
            settingsSection(title: L10n.tr("通知")) {
                settingRow(
                    title: L10n.tr("系统通知"),
                    status: notificationPermissionStatus.text,
                    statusColor: notificationPermissionStatus.color,
                    detail: L10n.tr("用于来电、新短信和未接来电提醒")
                ) {
                    notificationPermissionAccessory
                }
                .padding(16)
            }

            settingsSection(title: L10n.tr("声音")) {
                VStack(spacing: 0) {
                    soundSettingRow(.message)
                        .padding(16)

                    Divider().padding(.horizontal, 16)

                    soundSettingRow(.incomingCall)
                        .padding(16)
                }
            }
        }
    }

    /// The title is already printed by `settingRow`; `AdaptiveGlassToggleStyle` draws its label even when
    /// `labelsHidden()` is set, so the toggle carries it only for accessibility.
    private func settingsToggle(_ title: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) { EmptyView() }
            .toggleStyle(.adaptiveGlass)
            .fixedSize()
            .accessibilityLabel(title)
    }

    private func soundSettingRow(_ kind: AlertSoundKind) -> some View {
        settingRow(
            title: kind.title,
            detail: alertSounds.displayName(for: kind)
        ) {
            HStack(spacing: 8) {
                settingsToggle(kind.title, isOn: Binding(
                    get: { alertSounds.isEnabled(kind) },
                    set: { alertSounds.setEnabled($0, for: kind) }
                ))

                Button {
                    previewSound(kind)
                } label: {
                    Label(
                        alertSounds.previewingKind == kind ? L10n.tr("停止") : L10n.tr("试听"),
                        systemImage: alertSounds.previewingKind == kind
                            ? "stop.fill"
                            : "play.fill"
                    )
                }
                .adaptiveGlassButton()
                .controlSize(.small)

                Button("选择…") {
                    chooseCustomSound(kind)
                }
                .adaptiveGlassButton()
                .controlSize(.small)

                if !alertSounds.isUsingDefault(kind) {
                    Button {
                        alertSounds.restoreDefault(for: kind)
                    } label: {
                        Image(systemName: "arrow.counterclockwise")
                    }
                    .adaptiveGlassButton()
                    .buttonBorderShape(.circle)
                    .controlSize(.small)
                    .help("恢复默认")
                    .accessibilityLabel(L10n.tr("恢复默认%@", kind.title))
                }
            }
        }
    }

    private func previewSound(_ kind: AlertSoundKind) {
        do {
            try alertSounds.togglePreview(for: kind)
        } catch {
            soundImportError = error.localizedDescription
        }
    }

    private func chooseCustomSound(_ kind: AlertSoundKind) {
        let panel = NSOpenPanel()
        panel.title = L10n.tr("选择%@", kind.title)
        panel.prompt = L10n.tr("选择")
        panel.message = L10n.tr("音频将复制到 VoDog 的应用支持目录，原文件可以安全移动或删除。")
        panel.allowedContentTypes = [.audio]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.begin { response in
            guard response == .OK, let sourceURL = panel.url else { return }
            Task { @MainActor in
                do {
                    try alertSounds.installCustomSound(from: sourceURL, for: kind)
                } catch {
                    soundImportError = error.localizedDescription
                }
            }
        }
    }

    @ViewBuilder
    private var notificationPermissionAccessory: some View {
        if appState.isRequestingNotificationAuthorization ||
            appState.notificationAuthorizationStatus == .unknown {
            ProgressView()
                .controlSize(.small)
                .frame(width: 112)
        } else {
            Button(notificationPermissionButtonTitle) {
                if appState.notificationAuthorizationStatus == .notDetermined {
                    appState.requestNotificationAuthorization()
                } else {
                    appState.openNotificationSettings()
                }
            }
            .adaptiveGlassButton()
            .controlSize(.small)
            .frame(width: 112)
        }
    }

    private func settingsSection<Content: View>(
        title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .font(.headline)
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 12)

            Divider().padding(.horizontal, 16)
            content()
        }
        .adaptiveGlassSurface(
            cornerRadius: 18,
            treatment: .regular
        )
    }

    private func settingRow<Accessory: View>(
        title: String,
        status: String? = nil,
        statusColor: Color = .secondary,
        detail: String? = nil,
        @ViewBuilder accessory: () -> Accessory
    ) -> some View {
        HStack(alignment: .center, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(title)
                        .font(.headline)
                        .lineLimit(1)
                    if let status {
                        Text(status)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(statusColor)
                    }
                }
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 16)
            accessory()
        }
    }

    private func inlineMessage(
        _ text: String,
        systemImage: String,
        color: Color
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: systemImage)
            Text(text).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .font(.caption)
        .foregroundStyle(color)
    }

    private func inlineCallout(
        _ text: String,
        systemImage: String,
        color: Color
    ) -> some View {
        inlineMessage(text, systemImage: systemImage, color: color)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .adaptiveGlassSurface(
                cornerRadius: 10,
                treatment: .clear,
                tint: color.opacity(0.08)
            )
    }

    private var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
            as? String ?? "—"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion")
            as? String ?? "—"
        return L10n.tr("版本 %@（构建 %@）", version, build)
    }

    private var selectedAppearanceMode: AppAppearanceMode {
        AppAppearanceMode(rawValue: appearanceModeRawValue) ?? .system
    }

    private var appearanceModeBinding: Binding<AppAppearanceMode> {
        Binding(
            get: { selectedAppearanceMode },
            set: { mode in
                appearanceModeRawValue = mode.rawValue
                mode.apply()
            }
        )
    }

    private var languageBinding: Binding<AppLanguage> {
        Binding(
            get: { languageController.selectedLanguage },
            set: { languageController.select($0) }
        )
    }

    private var launchAtLoginDetail: String {
        switch appState.launchAtLoginStatus {
        case .disabled: return L10n.tr("登录 Mac 后可在后台自动运行 VoDog")
        case .enabled: return L10n.tr("登录 Mac 后在后台运行 VoDog")
        case .unavailable: return L10n.tr("当前应用位置或用户会话不支持登录启动")
        }
    }




    private var notificationPermissionStatus: (text: String, color: Color) {
        switch appState.notificationAuthorizationStatus {
        case .unknown: return (L10n.tr("读取中"), .secondary)
        case .notDetermined: return (L10n.tr("未请求"), .secondary)
        case .denied: return (L10n.tr("未允许"), .orange)
        case .authorized: return (L10n.tr("已允许"), Signal.call)
        }
    }

    private var allSettingsPermissionsAllowed: Bool {
        appState.notificationAuthorizationStatus == .authorized &&
            microphoneAuthorizationStatus == .authorized &&
            contacts.authorizationState == .authorized
    }

    private var notificationPermissionButtonTitle: String {
        appState.notificationAuthorizationStatus == .notDetermined
            ? L10n.tr("允许通知")
            : L10n.tr("通知设置…")
    }

    private var microphonePermissionStatus: (text: String, color: Color) {
        switch microphoneAuthorizationStatus {
        case .notDetermined: return (L10n.tr("未请求"), .secondary)
        case .restricted: return (L10n.tr("受限制"), .orange)
        case .denied: return (L10n.tr("未允许"), .orange)
        case .authorized: return (L10n.tr("已允许"), Signal.call)
        @unknown default: return (L10n.tr("未知"), .secondary)
        }
    }

    private var microphonePermissionButtonTitle: String {
        microphoneAuthorizationStatus == .notDetermined
            ? L10n.tr("请求权限")
            : L10n.tr("系统设置…")
    }

    private var contactPermissionStatus: (text: String, color: Color) {
        switch contacts.authorizationState {
        case .notDetermined: return (L10n.tr("未请求"), .secondary)
        case .authorized: return (L10n.tr("已允许"), Signal.call)
        case .denied: return (L10n.tr("未允许"), .orange)
        case .restricted: return (L10n.tr("受限制"), .orange)
        }
    }

    private var contactPermissionButtonTitle: String {
        contacts.authorizationState == .notDetermined
            ? L10n.tr("请求权限")
            : L10n.tr("系统设置…")
    }

    private func handleMicrophonePermissionAction() {
        if microphoneAuthorizationStatus == .notDetermined {
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                DispatchQueue.main.async {
                    microphoneAuthorizationStatus =
                        AVCaptureDevice.authorizationStatus(for: .audio)
                }
            }
        } else {
            openPrivacySettings(anchor: "Privacy_Microphone")
        }
    }

    private func handleContactPermissionAction() {
        if contacts.authorizationState == .notDetermined {
            contacts.requestAccess()
        } else {
            contacts.openPrivacySettings()
        }
    }

    private func openPrivacySettings(anchor: String) {
        guard let url = URL(
            string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)"
        ) else { return }
        NSWorkspace.shared.open(url)
    }

    private func refreshSettingsState() {
        appState.refresh()
        refreshSystemPermissionState()
    }

    private func refreshSystemPermissionState() {
        appState.refreshSystemSettingsStatus()
        contacts.reload()
        microphoneAuthorizationStatus = AVCaptureDevice.authorizationStatus(for: .audio)
    }
}

/// Detail column. Observes the account so signing in / out re-renders every pane; signed-out 账号 is the
/// full-height login page (it scrolls by itself).
private struct SettingsDetailHost<Content: View>: View {
    @ObservedObject var account: VoDogAccount
    let pane: SettingsPane
    @ViewBuilder var content: Content

    var body: some View {
        if pane == .account, account.user == nil {
            VoDogLoginView(account: account)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .communicationDetailColumnStyle()
        } else {
            ScrollView {
                AdaptiveGlassContainer(spacing: 16) {
                    VStack(alignment: .leading, spacing: 20) { content }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(22)
            }
            .scrollContentBackground(.hidden)
            .background(Color.clear)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .communicationDetailColumnStyle()
        }
    }
}

/// Account-backed cards: shown signed in; otherwise a login card that opens 设置 › 账号 (or nothing).
private struct SettingsLoginGate<Content: View>: View {
    @ObservedObject var account: VoDogAccount
    @Binding var pane: SettingsPane
    var showsLoginCard = true
    @ViewBuilder var content: Content

    var body: some View {
        if account.user != nil {
            content
        } else if showsLoginCard {
            VoDogCard(title: L10n.tr("登录 VoDog")) {
                Text(L10n.tr("登录后可在这台 Mac 上管理通讯录、屏蔽名单、通话记录与接听设置。"))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(L10n.tr("登录 VoDog")) { pane = .account }
                    .buttonStyle(.borderedProminent)
                    .accessibilityLabel(L10n.tr("登录 VoDog"))
            }
        }
    }
}
