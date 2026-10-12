import SwiftUI

/// Signal dark column (DESIGN.md); the watch ground is pure black. Green only for 接听 / 拨打 / 回拨, red only for
/// 拒接 / 结束 / 删除 and the unread count.
enum W {
    static let bg = Color.black
}

/// ● online / ○ offline / ◐ pending — always next to its text.
struct StatusShape: View {
    enum Kind { case on, off, pending }
    let kind: Kind
    var text: String?
    var body: some View {
        HStack(spacing: 4) {
            switch kind {
            case .on: Circle().fill(Signal.call).frame(width: 7, height: 7)
            case .off: Circle().strokeBorder(Signal.ink3, lineWidth: 1.5).frame(width: 7, height: 7)
            case .pending:
                Circle().strokeBorder(Signal.warn, lineWidth: 1.5)
                    .background(Circle().trim(from: 0.5, to: 1).fill(Signal.warn).rotationEffect(.degrees(90)))
                    .frame(width: 7, height: 7)
            }
            if let text { Text(text) }
        }
    }
}

/// SIM identifier: rounded square in the SIM colour, never a dot.
struct SIMSquare: View {
    let sim: SIMChannel?
    let sims: [SIMChannel]
    var size: CGFloat = 8
    var body: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(sim.map { SIMPalette.color(for: $0, in: sims) } ?? Signal.ink3)
            .frame(width: size, height: size)
    }
}

struct SIMChip: View {
    let sim: SIMChannel?
    let sims: [SIMChannel]
    var fallbackLabel: String?
    var showsStatus = true
    var body: some View {
        HStack(spacing: 5) {
            SIMSquare(sim: sim, sims: sims)
            Text(sim.map { simTitle($0.id, in: sims) } ?? fallbackLabel ?? "线路").lineLimit(1)
            if showsStatus, let sim {
                StatusShape(kind: sim.online == true ? .on : .off, text: sim.online == true ? nil : "离线")
            }
        }
        .font(.system(size: 12))
        .foregroundStyle(Signal.ink)
        .padding(.horizontal, 8).frame(height: 20)
        .background(Signal.surface2, in: Capsule())
    }
}

struct AiBadge: View {
    var body: some View {
        Text("✦ AI").font(.system(size: 10, weight: .semibold)).foregroundStyle(Signal.ai)
            .padding(.horizontal, 6).frame(height: 16).background(Signal.aiSoft, in: Capsule())
    }
}

struct UnreadBadge: View {
    let count: Int
    var body: some View {
        if let text = BadgeText.text(count) {
            Text(text).font(.system(size: 12, weight: .bold)).monospacedDigit().foregroundStyle(.white)
                .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18)
                .background(Signal.dangerFill, in: Capsule())
                .accessibilityLabel("\(count) 条未读")
        }
    }
}

enum BadgeText {
    static func text(_ n: Int) -> String? { n <= 0 ? nil : (n > 99 ? "99+" : String(n)) }
}

/// 28 pt direction circle: outgoing / incoming / missed / AI / blocked.
struct DirIcon: View {
    enum Kind { case outgoing, incoming, missed, ai, blocked }
    let kind: Kind
    var body: some View {
        let (symbol, fg, bg): (String, Color, Color) = switch kind {
        case .outgoing: ("arrow.up.right", Signal.brand, Signal.brandSoft)
        case .incoming: ("arrow.down.left", Signal.ink2, Signal.surface3)
        case .missed: ("arrow.down.left", Signal.danger, Signal.dangerSoft)
        case .ai: ("sparkle", Signal.ai, Signal.aiSoft)
        case .blocked: ("shield.slash", Signal.ink2, Signal.surface3)
        }
        Image(systemName: symbol).font(.system(size: 12, weight: .semibold)).foregroundStyle(fg)
            .frame(width: 28, height: 28).background(bg, in: Circle())
            .accessibilityHidden(true)
    }

    static func kind(for call: CallRecord) -> Kind {
        if call.showsBlockedMark { return .blocked }
        if call.isMissedIncoming { return .missed }
        if call.answeredByPlatform == "ai" || call.suppressesRinging { return .ai }
        return call.direction == "incoming" ? .incoming : .outgoing
    }
}

struct Avatar: View {
    let name: String
    var size: CGFloat = 44
    var body: some View {
        Text(String(name.trimmingCharacters(in: .whitespaces).first.map(String.init) ?? "#"))
            .font(.system(size: size * 0.4, weight: .semibold)).foregroundStyle(Signal.ink)
            .frame(width: size, height: size).background(Signal.surface3, in: Circle())
            .accessibilityHidden(true)
    }
}

/// A full-width 44 pt rounded button (radius 12, not a capsule).
struct WideButton: View {
    let title: String
    var subtitle: String?
    var symbol: String?
    var fill: Color = Signal.surface2
    var ink: Color = Signal.ink
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: 1) {
                HStack(spacing: 6) {
                    if let symbol { Image(systemName: symbol) }
                    Text(title).font(.system(size: 15, weight: .semibold))
                }
                if let subtitle { Text(subtitle).font(.system(size: 10)).opacity(0.85) }
            }
            .foregroundStyle(ink)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(fill, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
    }
}

/// Round action button with a caption under it (answer / reject 56 pt, hang-up 64 pt).
struct RoundAction: View {
    let symbol: String
    let caption: String
    let fill: Color
    var size: CGFloat = 56
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: symbol).font(.system(size: size * 0.38, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: size, height: size).background(fill, in: Circle())
                Text(caption).font(.system(size: 11)).foregroundStyle(Signal.ink)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(caption)
    }
}

/// What an empty list shows: spinner before the first load, 重试 after a failed one, the empty text once loaded.
struct ListPlaceholder: View {
    let state: LoadState
    let emptyText: String
    let retry: () async -> Void
    var body: some View {
        Group {
            switch state {
            case .loading:
                VStack(spacing: 6) {
                    ProgressView()
                    Text("加载中…").font(.system(size: 13)).foregroundStyle(Signal.ink3)
                }
            case .failed:
                VStack(spacing: 6) {
                    Text("暂时无法加载").font(.system(size: 13)).foregroundStyle(Signal.ink3)
                    Button { Task { await retry() } } label: {
                        Text("重试").font(.system(size: 15, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 44)
                    }
                }
            case .loaded:
                Text(emptyText).font(.system(size: 13)).foregroundStyle(Signal.ink3)
            }
        }
        .frame(maxWidth: .infinity)
        .listRowBackground(Color.clear)
    }
}

extension View {
    func signalRow() -> some View {
        listRowBackground(RoundedRectangle(cornerRadius: 12).fill(Signal.surface2))
    }
}

// MARK: - Time text

enum WatchTime {
    static func date(_ iso: String?) -> Date? { iso.flatMap(GatewayTimeDisplay.parseISO) }

    static func clock(_ iso: String?, zone: TimeZone = .current) -> String {
        guard let date = date(iso) else { return "—" }
        let f = DateFormatter(); f.timeZone = zone; f.locale = Locale(identifier: "zh_CN"); f.dateFormat = "HH:mm"
        return f.string(from: date)
    }

    /// 今天 / 昨天 / M月D日.
    static func day(_ iso: String?, zone: TimeZone = .current, now: Date = .now) -> String {
        guard let date = date(iso) else { return "更早" }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        if calendar.isDate(date, inSameDayAs: now) { return "今天" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "昨天"
        }
        let c = calendar.dateComponents([.month, .day], from: date)
        return "\(c.month ?? 0)月\(c.day ?? 0)日"
    }

    /// Row time: HH:mm today, otherwise the day label.
    static func rowTime(_ iso: String?, zone: TimeZone = .current) -> String {
        let label = day(iso, zone: zone)
        return label == "今天" ? clock(iso, zone: zone) : label
    }

    static func timer(since answeredAt: String?, now: Date) -> String {
        guard let start = date(answeredAt) else { return "00:00" }
        let s = max(0, Int(now.timeIntervalSince(start)))
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%02d:%02d", s / 60, s % 60)
    }
}

extension ReceptionMode {
    /// S104 page 13 wording.
    func watchTitle(timeout: Int) -> String {
        switch self {
        case .normal: "我自己接"
        case .timeoutAI: "先响铃 \(timeout) 秒再交给 AI"
        case .ai: "AI 立即代接"
        }
    }

    var watchSubtitle: String {
        switch self {
        case .normal: "来电在 iPhone 与手表响铃"
        case .timeoutAI: "无人接听时由 AI 代接"
        case .ai: "所有来电由 AI 接听"
        }
    }
}
