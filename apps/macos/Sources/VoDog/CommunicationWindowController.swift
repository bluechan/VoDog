import AppKit
import SwiftUI

enum PhoneWindowSection: String, CaseIterable, Identifiable {
    case phone
    case messages
    case records
    case contacts
    case sim
    case proxy
    case settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .phone: return L10n.tr("电话")
        case .messages: return L10n.tr("短信")
        case .records: return L10n.tr("记录")
        case .contacts: return L10n.tr("通讯录")
        case .sim: return L10n.tr("蜂窝模组")
        case .proxy: return L10n.tr("网络与代理")
        case .settings: return L10n.tr("设置")
        }
    }

    var systemImage: String {
        switch self {
        case .phone: return "phone"
        case .messages: return "message"
        case .records: return "list.bullet.rectangle"
        case .contacts: return "person"
        case .sim: return "simcard"
        case .proxy: return "globe"
        case .settings: return "slider.horizontal.3"
        }
    }
}

@MainActor
final class PhoneWindowModel: ObservableObject {
    @Published var selection: PhoneWindowSection = .messages
    @Published var settingsPane: SettingsPane = .appearance
    @Published private(set) var prefersFullCallPresentation = false
    @Published private(set) var pendingListFocusSection: PhoneWindowSection?
    @Published var dialNumber = ""
    @Published var selectedCallRecordID: CallHistoryRecord.ID?
    @Published var selectedRecordingID: CallRecordingRecord.ID?
    @Published private(set) var callRecordRequestSerial = 0
    @Published private(set) var requestedCallRecordID: CallHistoryRecord.ID?
    @Published private(set) var simModuleRequestSerial = 0
    @Published private(set) var requestedSIMModuleID: CellularModuleID?

    var onCallPresentationChange: (() -> Void)?

    func activateFromRail(_ section: PhoneWindowSection) {
        setFullCallPresentation(false)
        pendingListFocusSection = section
        selection = section
    }

    func setFullCallPresentation(_ isFull: Bool) {
        guard prefersFullCallPresentation != isFull else { return }
        prefersFullCallPresentation = isFull
        onCallPresentationChange?()
    }

    func consumeCallRecordRequest() {
        requestedCallRecordID = nil
    }

    func consumeListFocusRequest(for section: PhoneWindowSection) {
        guard pendingListFocusSection == section else { return }
        pendingListFocusSection = nil
    }

    func present(
        number: String?,
        section: PhoneWindowSection?,
        callRecordID: CallHistoryRecord.ID? = nil,
        simModuleID: CellularModuleID? = nil
    ) {
        if number != nil || section != nil || callRecordID != nil || simModuleID != nil {
            setFullCallPresentation(false)
        }
        if let section { selection = section }
        if let callRecordID {
            requestedCallRecordID = callRecordID
            selectedCallRecordID = callRecordID
            selection = .phone
            callRecordRequestSerial &+= 1
        }
        if let simModuleID {
            requestedSIMModuleID = simModuleID
            selection = .sim
            simModuleRequestSerial &+= 1
        }
        if let number, !number.isEmpty {
            dialNumber = number
            selectedCallRecordID = nil  // S139: the 电话 detail pane shows the dialer
            selection = .phone
        }
    }
}

@MainActor
final class MessagesWindowModel: ObservableObject {
    @Published private(set) var requestSerial = 0
    @Published private(set) var composeSerial = 0
    @Published private(set) var requestedMessageID: SMSMessage.ID?
    @Published private(set) var requestedDestination: String?

    func present(messageID: SMSMessage.ID? = nil, destination: String? = nil) {
        requestedMessageID = messageID
        requestedDestination = destination
        requestSerial &+= 1
    }

    func beginComposing() {
        composeSerial &+= 1
    }
}

@MainActor
final class CommunicationWindowController: NSObject, NSWindowDelegate {
    static let shared = CommunicationWindowController()

    private enum Kind: Hashable {
        case phone
    }

    let phoneModel = PhoneWindowModel()
    let messagesModel = MessagesWindowModel()

    private weak var appState: AppState?
    private var windows: [Kind: NSWindow] = [:]

    private override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appLanguageDidChange),
            name: .cellDockAppLanguageDidChange,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appActivationDidChange),
            name: NSApplication.didBecomeActiveNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appActivationDidChange),
            name: NSApplication.didResignActiveNotification,
            object: nil
        )
    }

    var hasVisibleWindows: Bool {
        windows.values.contains(where: \.isVisible)
    }

    func configure(appState: AppState) {
        self.appState = appState
        phoneModel.onCallPresentationChange = { [weak self] in
            self?.updateCallIslandVisibility()
        }
        CallIslandWindowController.shared.configure(
            appState: appState,
            onOpenFullCall: { [weak self] in
                self?.showCurrentCall()
            }
        )
    }

    /// Reopens the primary communication window without changing the section
    /// that was selected before the window closed. A newly-created model starts
    /// on Messages, so this also gives first-time Dock reopens the expected page.
    func handleApplicationReopen() {
        show(.phone)
    }

    func showPhone(
        number: String? = nil,
        section: PhoneWindowSection? = nil,
        callRecordID: CallHistoryRecord.ID? = nil,
        simModuleID: CellularModuleID? = nil
    ) {
        // A local history id never matches a cloud row, so only a locally shown record is requested.
        let localRecordID = callRecordID.flatMap { routeLineForCallRecord($0) ? $0 : nil }
        phoneModel.present(
            number: number,
            section: section ?? (number == nil ? .phone : nil),
            callRecordID: localRecordID,
            simModuleID: simModuleID
        )
        if phoneModel.selection == .phone {
            appState?.callHistory.acknowledgeMissedCalls()
        }
        show(.phone)
    }

    /// S139: a local call record opens 电话 on its line — the account SIM when its module serves one
    /// (cloud list), else this Mac's module (local list with the record selected). Returns true when the
    /// record will be shown in the local list.
    private func routeLineForCallRecord(_ id: CallHistoryRecord.ID) -> Bool {
        guard let appState else { return false }
        guard appState.voDog.user != nil else { return true }  // signed out → always the local route
        guard let moduleID = appState.callHistory.records.first(where: { $0.id == id })?.moduleID else {
            return appState.localOnlyModule(storedLine: UserDefaults.standard.string(forKey: VoDogLinePolicy.localLineKey) ?? "") != nil
        }
        let defaults = UserDefaults.standard
        if appState.localOnlyModules.contains(where: { $0.id == moduleID }) {
            defaults.set(moduleID.rawValue, forKey: VoDogLinePolicy.localLineKey)
            return true
        }
        defaults.set("", forKey: VoDogLinePolicy.localLineKey)
        if let simID = appState.gatewayRuntime(for: moduleID)?.sim?.id {
            defaults.set(simID, forKey: "VoDogPhone.sim.v1")
        }
        return false
    }

    func showMessages(
        messageID: SMSMessage.ID? = nil,
        destination: String? = nil
    ) {
        messagesModel.present(messageID: messageID, destination: destination)
        phoneModel.activateFromRail(.messages)
        show(.phone)
    }

    func showCurrentCall() {
        guard appState?.showsLocalCallUI == true else { return }
        phoneModel.setFullCallPresentation(true)
        show(.phone)
    }

    func callDidChange(previousHadCall: Bool) {
        guard let appState else { return }
        if appState.showsLocalCallUI {
            if !previousHadCall {
                let phoneWindow = windows[.phone]
                let canPresentFullCall = NSApplication.shared.isActive &&
                    phoneWindow?.isVisible == true &&
                    phoneWindow?.isKeyWindow == true
                phoneModel.setFullCallPresentation(canPresentFullCall)
            }
        } else {
            phoneModel.setFullCallPresentation(false)
        }
        updateCallIslandVisibility()
    }

    var isPresentingCallUI: Bool {
        isFullCallForeground || CallIslandWindowController.shared.isVisible
    }

    private func show(_ kind: Kind) {
        guard let appState else { return }
        let window: NSWindow
        if let existing = windows[kind] {
            window = existing
        } else {
            let hostingController: NSHostingController<AnyView>
            switch kind {
            case .phone:
                hostingController = NSHostingController(
                    rootView: AnyView(
                        PhoneWindowView(
                            model: phoneModel,
                            messagesModel: messagesModel,
                            contacts: SystemContactStore.shared
                        )
                        .environmentObject(appState)
                        .cellDockLanguageEnvironment()
                    )
                )
            }

            window = NSWindow(contentViewController: hostingController)
            window.title = communicationWindowTitle
            window.styleMask = [
                .titled,
                .closable,
                .miniaturizable,
                .resizable,
                .fullSizeContentView
            ]
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.toolbar = nil
            window.titlebarSeparatorStyle = .none
            // The full-size SwiftUI content replaces the visible title bar, so
            // let unhandled background regions retain native window dragging.
            window.isMovable = true
            window.isMovableByWindowBackground = true
            window.isReleasedWhenClosed = false
            window.tabbingMode = .disallowed
            window.delegate = self
            window.backgroundColor = .windowBackgroundColor
            window.isOpaque = true
            switch kind {
            case .phone:
                // 220 sidebar + 300 list + a usable detail column.
                window.minSize = NSSize(width: 940, height: 560)
                window.setContentSize(NSSize(width: 1000, height: 640))
                window.setFrameAutosaveName("VoDogCommunicationWindow.v6")
            }
            window.center()
            windows[kind] = window
        }

        window.title = communicationWindowTitle

        NSApplication.shared.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        DispatchQueue.main.async { [weak self] in
            self?.updateCallIslandVisibility()
        }
    }

    func refreshCommunicationWindowTitle() {
        windows[.phone]?.title = communicationWindowTitle
    }

    @objc private func appLanguageDidChange() {
        windows[.phone]?.title = communicationWindowTitle
    }

    @objc private func appActivationDidChange() {
        updateCallIslandVisibility()
    }

    private var communicationWindowTitle: String {
        phoneModel.selection.title
    }

    func windowWillClose(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.updateCallIslandVisibility()
            guard
                  !self.hasVisibleWindows,
                  !StandaloneFlowWindowController.shared.hasVisibleWindows,
                  !InitialSetupWindowController.shared.isVisible else {
                return
            }
            NSApplication.shared.setActivationPolicy(.accessory)
        }
    }

    func windowDidBecomeKey(_ notification: Notification) {
        updateCallIslandVisibility()
    }

    func windowDidResignKey(_ notification: Notification) {
        updateCallIslandVisibility()
    }

    private var isFullCallForeground: Bool {
        guard let window = windows[.phone] else { return false }
        return appState?.showsLocalCallUI == true &&
            phoneModel.prefersFullCallPresentation &&
            NSApplication.shared.isActive &&
            window.isVisible &&
            window.isKeyWindow
    }

    private func updateCallIslandVisibility() {
        guard let appState else { return }
        let alwaysShowsIncomingIsland = appState.call.phase == .incoming
        CallIslandWindowController.shared.updateVisibility(
            shouldShow: appState.showsLocalCallUI &&
                (alwaysShowsIncomingIsland || !isFullCallForeground)
        )
    }
}
