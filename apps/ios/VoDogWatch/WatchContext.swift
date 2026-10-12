import Foundation

/// S104 applicationContext (iPhone → watch, latest-only). Field names are the spec table's; everything is optional
/// so a partial or older payload still decodes.
struct WatchContext: Codable, Sendable, Equatable {
    struct Session: Codable, Sendable, Equatable {
        var accessToken: String
        var expiresAt: String?
        var userId: String?
        var deviceName: String?
    }
    struct SIM: Codable, Sendable, Equatable {
        var id: String
        var label: String?
        var phoneLabel: String?
        var slotIndex: Int?
        var online: Bool?
        var telephonyReady: Bool?
        var mediaReady: Bool?
        var smsReady: Bool?
        var gatewayName: String?
        var gatewayKind: String?
        var settings: Settings?
        struct Settings: Codable, Sendable, Equatable { var mode: String; var timeoutSeconds: Int; var version: Int }
    }
    struct ActiveCall: Codable, Sendable, Equatable {
        var callId: String
        var remoteNumber: String?
        var contactName: String?
        var simLabel: String?
        var state: String?
        var answeredAt: String?
        var muted: Bool?
    }

    var v: Int? = 1
    var session: Session?
    var sims: [SIM]? = []
    var badges: WatchBadges?
    var activeCall: ActiveCall?
    var phoneReachableAt: String?

    /// WatchConnectivity carries plist dictionaries, which cannot hold `null`. Accept both encodings: JSON `Data`
    /// under `"json"`, or the plain dictionary (a missing key reads as null).
    static func decode(_ dictionary: [String: Any]) -> WatchContext? {
        guard let data = jsonData(dictionary) else { return nil }
        return try? JSONDecoder().decode(WatchContext.self, from: data)
    }

    static func jsonData(_ dictionary: [String: Any]) -> Data? {
        if let data = dictionary["json"] as? Data { return data }
        if let text = dictionary["json"] as? String { return Data(text.utf8) }
        let plain = dictionary.mapValues(jsonSafe)
        guard JSONSerialization.isValidJSONObject(plain) else { return nil }
        return try? JSONSerialization.data(withJSONObject: plain)
    }

    private static func jsonSafe(_ value: Any) -> Any {
        switch value {
        case let date as Date: ISO8601DateFormatter().string(from: date)
        case let dict as [String: Any]: dict.mapValues(jsonSafe)
        case let array as [Any]: array.map(jsonSafe)
        default: value
        }
    }
}

extension WatchContext.SIM {
    /// The shared `SIMChannel` so `SIMPalette`, `SIMSelectionPolicy` and `simTitle` work unchanged.
    var channel: SIMChannel {
        SIMChannel(
            id: id, gatewayId: nil, label: label, phoneLabel: phoneLabel, slotIndex: slotIndex, online: online,
            telephonyReady: telephonyReady, mediaReady: mediaReady, smsReady: smsReady, version: nil, present: nil,
            assignmentPending: nil, countryIso: nil, embedded: nil, timeZone: nil,
            settings: settings.map {
                SIMSettings(mode: $0.mode, timeoutSeconds: $0.timeoutSeconds, version: $0.version, appliedVersion: nil,
                            availableModes: nil, aiUnavailableReason: nil)
            },
            gatewayKind: gatewayKind, gatewayName: gatewayName
        )
    }
}

/// Reply of a `sendMessage`: `{ok, callId?, error?}`. `error` may be a code string or `{code, message}`.
struct WatchReply: Sendable {
    var ok: Bool
    var callId: String?
    var code: String?
    var message: String?

    init(ok: Bool, callId: String? = nil, code: String? = nil, message: String? = nil) {
        self.ok = ok; self.callId = callId; self.code = code; self.message = message
    }

    init(_ data: Data) {
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        ok = object["ok"] as? Bool ?? false
        callId = object["callId"] as? String
        if let error = object["error"] as? [String: Any] {
            code = error["code"] as? String
            message = error["message"] as? String
        } else {
            code = object["error"] as? String
            message = object["message"] as? String
        }
    }

    /// User-readable text for a failed reply (the iPhone's own text first).
    var text: String {
        if let message, !message.isEmpty { return message }
        switch code {
        case "NOT_LOGGED_IN": return "请先在 iPhone 上登录 VoDog"
        case "NO_SUCH_CALL": return "这通电话已不在 iPhone 上"
        case "SIM_NOT_READY": return "该线路暂不可拨打"
        case "PHONE_BUSY": return "iPhone 正在通话中"
        case "UNREACHABLE": return "需要 iPhone 在附近"
        default: return "iPhone 未能完成操作"
        }
    }
}
