import SwiftUI
import WatchKit

/// Shared outcome handling for every 拨打 / 回拨 on the watch: the iPhone dials, the watch opens 通话中.
@MainActor
enum WatchDialAction {
    static func dial(store: WatchSessionStore, simId: String?, number: String, postDial: String = "") async -> String? {
        guard let simId else { return "请选择线路" }
        let reply = await store.dial(simId: simId, number: number, postDial: postDial)
        guard reply.ok else { return reply.text }
        store.path.append(.active)
        return nil
    }

    /// Why 拨打 is grey, or nil when it may be pressed.
    static func blocker(store: WatchSessionStore, simId: String?) -> String? {
        // S105: the watch dials and carries audio itself; only a session (access token) is required, not the iPhone.
        if !store.isLoggedIn { return "请先在 iPhone 上登录" }
        if !SIMSelectionPolicy.canDial(on: simId, sims: store.sims) { return "该线路暂不可拨打" }
        if store.activeCall != nil { return "正在通话中" }
        return nil
    }
}

// MARK: - 5 拨号键盘

struct DialPadView: View {
    @Environment(WatchSessionStore.self) private var store
    let initialNumber: String
    @State private var number = ""
    @State private var simId: String?
    @State private var pickingSIM = false
    @State private var error: String?
    @State private var dialing = false
    /// Long-press `*` just inserted `,`: swallow the `*` tap that may follow on release.
    @State private var commaAt: Date?

    static let keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"]

    var body: some View {
        let sims = store.sims
        let sim = sims.first { $0.id == simId }
        let blocker = WatchDialAction.blocker(store: store, simId: simId)
        let (normalized, postDial) = Self.split(number)
        let canDial = blocker == nil && !dialing && PhoneNumberText.isDialable(normalized)
        GeometryReader { geo in
            // geo = everything below the nav bar (bottom safe area included): 26 number + 14 hint + 6 gap + 3×4 key gaps
            // + 6 bottom; keys take the rest, floor 20 — below that the grid scrolls. S115: the line chip moved up into
            // the nav band under the clock (overlay below) and the hint became the number's second line: +3.5 pt per key.
            let keyHeight = max(20, (geo.size.height - 26 - 14 - 6 - 3 * 4 - 6) / 4)
            ScrollView {
                VStack(spacing: 6) {
                    VStack(spacing: 0) {
                        ZStack {
                            Text(number.isEmpty ? "输入号码" : number)
                                .font(.system(size: 20, weight: .medium)).monospacedDigit()
                                .foregroundStyle(number.isEmpty ? Signal.ink3 : Signal.ink)
                                .lineLimit(1).minimumScaleFactor(0.6)
                                .padding(.horizontal, 32)
                            HStack {
                                Spacer()
                                Image(systemName: "delete.left").font(.system(size: 18)).foregroundStyle(Signal.ink3)
                                    .frame(width: 32, height: 26).contentShape(Rectangle())
                                    .onTapGesture { number = PhoneNumberText.deletingLast(from: number) }
                                    .onLongPressGesture { number = "" }
                                    .accessibilityLabel("删除").accessibilityAddTraits(.isButton)
                                    .accessibilityAction { number = PhoneNumberText.deletingLast(from: number) }
                            }
                        }
                        .frame(height: 26)
                        // Hint slot (contact match or why 拨打 is grey): fixed height, so it never moves the keys.
                        Text(hint(blocker: blocker) ?? "").font(.system(size: 11))
                            .foregroundStyle(error != nil || (blocker != nil && !normalized.isEmpty) ? Signal.warn : Signal.brand)
                            .lineLimit(1).frame(height: 14)
                    }
                    // `keys` keeps `#` in slot 11 for the in-call DTMF pad (WatchApp); here slot 11 is the dial key.
                    Grid(horizontalSpacing: 4, verticalSpacing: 4) {
                        ForEach(0..<4, id: \.self) { row in
                            GridRow {
                                ForEach(0..<3, id: \.self) { col in
                                    if row * 3 + col == 11 {
                                        Button {
                                            WKInterfaceDevice.current().play(.start)
                                            WatchKeyTone.shared.stop() // release the tone session before the call engine wants it
                                            Task {
                                                dialing = true
                                                error = await WatchDialAction.dial(store: store, simId: simId, number: normalized, postDial: postDial)
                                                dialing = false
                                            }
                                        } label: {
                                            Label("拨打", systemImage: "phone.fill").labelStyle(.titleAndIcon)
                                                .font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                                                .frame(maxWidth: .infinity).frame(height: keyHeight)
                                                .background(canDial ? Signal.callFill : Signal.surface3, in: RoundedRectangle(cornerRadius: 10))
                                        }
                                        .buttonStyle(.plain)
                                        .disabled(!canDial)
                                        .accessibilityLabel("拨打")
                                    } else {
                                        keyButton(Self.keys[row * 3 + col], height: keyHeight)
                                    }
                                }
                            }
                        }
                    }
                    .padding(.bottom, 6) // S113: clear of the screen's rounded corners
                }
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        // Line chip (tap = 切换) drawn up into the nav band, under the clock; a toolbar item would hide the clock (S115).
        .overlay(alignment: .topTrailing) {
            Button { pickingSIM = true } label: { SIMChip(sim: sim, sims: sims) }
                .buttonStyle(.plain).accessibilityHint("切换线路")
                .accessibilitySortPriority(1) // VoiceOver still reads the line first, as when it led the content
                .offset(y: -24)
        }
        .ignoresSafeArea(edges: .bottom)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { WatchKeyTone.shared.stop() }
        .onAppear {
            if number.isEmpty { number = initialNumber }
            if simId == nil { simId = SIMSelectionPolicy.preferredID(in: sims, current: nil) }
        }
        // The 姓名 · label hint matches store.contacts, which otherwise only the 通讯录 page fetches (S115).
        .task { await store.refreshContactsOnce() }
        .sheet(isPresented: $pickingSIM) {
            List(sims, id: \.id) { candidate in
                Button {
                    simId = candidate.id; pickingSIM = false
                } label: { SIMChip(sim: candidate, sims: sims) }
            }
        }
    }

    /// S105e: `10010,1,3` → base `10010` (dialled) + post-dial `,1,3` (from the first `,`; each `,` = 1.5 s pause).
    static func split(_ typed: String) -> (number: String, postDial: String) {
        guard let comma = typed.firstIndex(of: ",") else { return (PhoneNumberText.normalized(typed), "") }
        return (PhoneNumberText.normalized(String(typed[..<comma])), String(typed[comma...]).filter { ",0123456789*#".contains($0) })
    }

    private func hint(blocker: String?) -> String? {
        if let error { return error }
        let normalized = Self.split(number).number
        guard !normalized.isEmpty else { return nil }
        if let blocker { return blocker }
        let digits = normalized.filter(\.isNumber)
        guard digits.count >= ContactLookupPolicy.minimumLookupDigits else { return nil }
        for contact in store.contacts {
            if let phone = contact.phones.first(where: { $0.displayNumber.filter(\.isNumber).hasSuffix(digits) && digits.count >= 7 }) {
                return "\(contact.displayName) · \(phoneLabel(phone.label))"
            }
        }
        return nil
    }

    private func keyButton(_ digit: String, height: CGFloat) -> some View {
        Button {
            if digit == "*", let commaAt, Date.now.timeIntervalSince(commaAt) < 1 { self.commaAt = nil; return }
            commaAt = nil
            WatchKeyTone.shared.tap(digit)
            number = PhoneNumberText.appending(digit, to: number)
        } label: {
            Text(digit).font(.system(size: 16, weight: .medium)).foregroundStyle(Signal.ink)
                .frame(maxWidth: .infinity).frame(height: height)
                .background(Signal.surface2, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .simultaneousGesture(LongPressGesture(minimumDuration: 0.5).onEnded { _ in
            switch digit {
            case "0": if !number.contains(",") { WKInterfaceDevice.current().play(.click); number = PhoneNumberText.appending("+", to: number) }
            case "*" where !number.isEmpty: WKInterfaceDevice.current().play(.click); number += ","; commaAt = .now  // S105e post-dial pause
            default: break
            }
        })
    }
}

func phoneLabel(_ raw: String?) -> String {
    switch raw?.lowercased() {
    case "mobile", "iphone", nil, "": "手机"
    case "work": "工作"
    case "home": "住宅"
    case "main": "主要"
    default: raw ?? "手机"
    }
}

// MARK: - 6 通讯录

struct ContactsListView: View {
    @Environment(WatchSessionStore.self) private var store
    @State private var query = ""

    /// Server order (as on iOS), grouped by the Latin initial of the name; anything else under「#」.
    private var sections: [(String, [Contact])] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        let filtered = trimmed.isEmpty ? store.contacts : store.contacts.filter {
            $0.displayName.localizedCaseInsensitiveContains(trimmed)
                || $0.phones.contains { $0.displayNumber.filter(\.isNumber).contains(trimmed.filter(\.isNumber)) && !trimmed.filter(\.isNumber).isEmpty }
        }
        var order: [String] = []
        var groups: [String: [Contact]] = [:]
        for contact in filtered {
            let key = Self.initial(contact.displayName)
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(contact)
        }
        return order.sorted { $0 == "#" ? false : ($1 == "#" ? true : $0 < $1) }.map { ($0, groups[$0] ?? []) }
    }

    static func initial(_ name: String) -> String {
        let latin = name.applyingTransform(.toLatin, reverse: false)?.applyingTransform(.stripDiacritics, reverse: false) ?? name
        guard let first = latin.trimmingCharacters(in: .whitespaces).first, first.isLetter, first.isASCII else { return "#" }
        return String(first).uppercased()
    }

    var body: some View {
        List {
            TextField("搜索", text: $query).signalRow()
            if store.contacts.isEmpty {
                ListPlaceholder(state: store.loadState(.contacts), emptyText: "通讯录还是空的") { await store.refreshContacts() }
            }
            ForEach(sections, id: \.0) { section in
                Section {
                    ForEach(section.1) { contact in
                        NavigationLink(value: WatchRoute.contact(contact.id)) {
                            HStack(spacing: 8) {
                                Avatar(name: contact.displayName, size: 28)
                                Text(contact.displayName).font(.system(size: 16, weight: .semibold)).lineLimit(1)
                            }
                        }
                        .signalRow()
                    }
                } header: {
                    Text(section.0).font(.system(size: 12, weight: .semibold)).foregroundStyle(Signal.ink3)
                }
            }
        }
        .navigationTitle("通讯录")
        .task { await store.refreshContacts() }
    }
}

// MARK: - 7 联系人详情

struct ContactDetailView: View {
    @Environment(WatchSessionStore.self) private var store
    let contactId: String
    @State private var error: String?

    var body: some View {
        if let contact = store.contacts.first(where: { $0.id == contactId }) {
            let simId = SIMSelectionPolicy.preferredID(in: store.sims, current: nil)
            let blocker = WatchDialAction.blocker(store: store, simId: simId)
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    VStack(spacing: 2) {
                        Avatar(name: contact.displayName, size: 40)
                        Text(contact.displayName).font(.system(size: 17, weight: .semibold))
                        let facts = [contact.organization, contact.phones.first?.location].compactMap { $0 }.filter { !$0.isEmpty }
                        if !facts.isEmpty { Text(facts.joined(separator: " · ")).font(.system(size: 11)).foregroundStyle(Signal.ink3) }
                    }
                    .frame(maxWidth: .infinity)
                    ForEach(contact.phones) { phone in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(phoneLabel(phone.label)).font(.system(size: 10)).foregroundStyle(Signal.ink3)
                            Text(phone.displayNumber).font(.system(size: 14)).monospacedDigit()
                            HStack(spacing: 6) {
                                Button {
                                    Task { error = await WatchDialAction.dial(store: store, simId: simId, number: phone.displayNumber) }
                                } label: {
                                    Label("拨打", systemImage: "phone.fill").font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(.white).frame(maxWidth: .infinity, minHeight: 36)
                                        .background(blocker == nil ? Signal.callFill : Signal.surface3, in: RoundedRectangle(cornerRadius: 12))
                                }
                                .buttonStyle(.plain).disabled(blocker != nil)
                                Button {
                                    if let simId {
                                        store.path.append(.conversation(simId: simId, number: PhoneNumberText.normalized(phone.displayNumber)))
                                    }
                                } label: {
                                    Label("短信", systemImage: "message.fill").font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(Signal.onBrand).frame(maxWidth: .infinity, minHeight: 36)
                                        .background(Signal.brand, in: RoundedRectangle(cornerRadius: 12))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    if let simId, blocker == nil {
                        Text("用\(simTitle(simId, in: store.sims))拨打 · 在 iPhone 上通话").font(.system(size: 10)).foregroundStyle(Signal.ink3)
                    } else if let blocker {
                        Text(blocker).font(.system(size: 10)).foregroundStyle(Signal.warn)
                    }
                    if let error { Text(error).font(.system(size: 11)).foregroundStyle(Signal.danger) }
                }
            }
            .navigationTitle(contact.displayName)
        } else {
            Text("联系人不存在").foregroundStyle(Signal.ink3)
        }
    }
}
