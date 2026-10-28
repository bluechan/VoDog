import Foundation

// S104: pure-Foundation presentation helpers shared by the iOS and watch targets. Moved verbatim from
// Components.swift, MessagesView.swift and ContactCardView.swift.

/// S20 decision 8: shared by the dialer, the call list and the records list, which used to print the raw state.
/// S143: a blocked incoming call is stored as `failed` + `number_blocked`; it reads 已拦截, never 失败.
func callStateTitle(_ state: String?, failureReason: String? = nil) -> String {
    if state == "failed", failureReason == "number_blocked" { return "已拦截" }
    return switch state {
    case "incoming_ringing": "来电响铃"
    case "outgoing_pending": "等待拨号"
    case "connecting": "连接中"
    case "active": "通话中"
    case "ending": "正在结束"
    case "ended": "已结束"
    case "failed": "失败"
    default: "状态待确认"
    }
}

/// S21 §F: a history row prints `186…1768 · 张三`, while a header or a card leads with the name. The server
/// decides the match (decision 3), so both helpers just present whatever `contactName` arrived — including
/// nothing, on a Control that predates S21.
enum ContactDisplay {
    static let unknownNumber = "未知号码"
    static let blockedSymbol = "hand.raised.slash.fill"

    static func numberWithName(number: String?, contactName: String?) -> String {
        let number = number?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let name = contactName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if number.isEmpty { return name.isEmpty ? unknownNumber : name }
        return name.isEmpty ? number : "\(number) · \(name)"
    }

    /// S22 report card, line 1. The history row leads with the number (§F); a report card leads with whoever
    /// called, because the card is read as a story about a person rather than scanned as a call log.
    static func nameWithNumber(number: String?, contactName: String?) -> String {
        let number = number?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let name = contactName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if name.isEmpty { return number.isEmpty ? unknownNumber : number }
        return number.isEmpty ? name : "\(name) · \(number)"
    }

    static func title(number: String?, contactName: String?) -> String {
        let name = contactName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !name.isEmpty { return name }
        let number = number?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return number.isEmpty ? unknownNumber : number
    }

    /// S96 完整形态：服务端字符串原样（去首尾空白），空 → nil。
    static func locationFull(_ location: String?) -> String? {
        let value = location?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? nil : value
    }

    /// S96 简短形态：第一个 ` · ` 之前（`广东 深圳 · 移动` → `广东 深圳`）。
    static func locationShort(_ location: String?) -> String? {
        guard let full = locationFull(location) else { return nil }
        return locationFull(full.components(separatedBy: " · ").first)
    }
}

enum GatewayTimeDisplay {
    static let fallbackIANA = "Asia/Shanghai"

    static func resolvedTimeZone(callZone: String?, simZone: String? = nil) -> TimeZone {
        if let callZone, let zone = TimeZone(identifier: callZone) { return zone }
        if let simZone, let zone = TimeZone(identifier: simZone) { return zone }
        return TimeZone(identifier: fallbackIANA) ?? .gmt
    }

    static func compact(_ value: String?, timeZone: TimeZone) -> String {
        guard let value, let date = parseISO(value) else { return "—" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter.string(from: date)
    }

    static func talkSeconds(answeredAt: String?, endedAt: String?) -> Int? {
        guard let answeredAt, let endedAt, let answered = parseISO(answeredAt), let ended = parseISO(endedAt) else {
            return nil
        }
        return max(0, Int(ended.timeIntervalSince(answered).rounded()))
    }

    static func parseISO(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }
}

func simTitle(_ simID: String?, in sims: [SIMChannel]) -> String {
    guard let simID else { return "SIM 未知" }
    guard let sim = sims.first(where: { $0.id == simID }) else { return "SIM \(simID.prefix(6))" }
    return sim.label ?? sim.phoneLabel ?? "SIM \((sim.slotIndex ?? 0) + 1)"
}

/// S95: client-side only — a 4–8 digit run in a message that says 验证码 / 校验码 / 动态码 / code. Copy only.
enum VerificationCodeText {
    static func code(in body: String?) -> String? {
        guard let body, body.range(of: #"验证码|校验码|动态码|确认码|code"#, options: [.regularExpression, .caseInsensitive]) != nil,
              let match = body.range(of: #"(?<![0-9])[0-9]{4,8}(?![0-9])"#, options: .regularExpression) else { return nil }
        return String(body[match])
    }
}

enum ContactLookupPolicy {
    /// Long enough that a full number typed on the dialpad costs one request, short enough to feel immediate.
    static let debounce: Duration = .milliseconds(350)
    /// `phoneMatchKeys` needs something to work with; a 2-digit prefix would match half the address book.
    static let minimumLookupDigits = 3
    /// Server max for `GET /contacts`; a full page means there may be more.
    static let listLimit = 500
    /// ponytail: unpaged browse loops stop here (40 x 500 = 20k contacts); raise if an address book outgrows it.
    static let maxBrowsePages = 40

    static func hasMorePages(_ pageCount: Int) -> Bool { pageCount >= listLimit }

    static func shouldLookup(_ number: String) -> Bool {
        PhoneNumberText.normalized(number).filter(\.isNumber).count >= minimumLookupDigits
    }

    static func listQuery(query: String) -> [URLQueryItem] {
        var items = [URLQueryItem(name: "limit", value: String(listLimit))]
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { items.insert(URLQueryItem(name: "query", value: trimmed), at: 0) }
        return items
    }
}

enum PlaybackClock {
    static func format(_ seconds: TimeInterval) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds.rounded(.down))
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    static func formatMilliseconds(_ milliseconds: Int64?) -> String? {
        guard let milliseconds, milliseconds >= 0 else { return nil }
        return format(Double(milliseconds) / 1_000)
    }
}
