import Foundation

// S104: shared with the watch target (no UIKit / CoreTelephony). Moved verbatim from APIClient.swift.

enum APIError: LocalizedError {
    case invalidResponse, unauthorized, server(Int, String, String?)
    var errorDescription: String? {
        switch self {
        case .invalidResponse: "服务器响应无效"
        case .unauthorized: "登录已失效"
        case let .server(status, message, code):
            Self.codeTitles[code ?? ""] ?? (message.isEmpty ? "请求失败（\(status)）" : message)
        }
    }

    /// S72：这两个 409 固定写中文，不看服务端 message。
    static let codeTitles: [String: String] = [
        "SAME_DEVICE_INTERNAL": "同一设备上的两张卡不能互打",
        "OWN_OUTGOING_CALL": "这是你正在拨出的通话",
    ]

    /// Dial path: Control's validation / fallback messages are English ("Request validation failed"); show Chinese.
    static func dialMessage(for error: Error) -> String {
        guard case let .server(status, _, code)? = error as? APIError else { return error.localizedDescription }
        if code == "INVALID_REQUEST" { return "号码格式不正确，无法拨打" }
        let text = error.localizedDescription
        return text.contains(where: { ("\u{4E00}"..."\u{9FFF}").contains($0) }) ? text : "拨打失败（\(code ?? String(status))）"
    }

    var serverCode: String? {
        if case let .server(_, _, code) = self { return code }
        return nil
    }

    /// S36 C3: the HTTP status a diagnostic records; `0` for a response that never parsed.
    var diagCode: Int {
        switch self {
        case .invalidResponse: 0
        case .unauthorized: 401
        case let .server(status, _, _): status
        }
    }
}

enum AppRuntimeConfiguration {
    static let productionAPIBaseURL = URL(string: "https://\(Bundle.main.object(forInfoDictionaryKey: "VoDogDomain") as? String ?? "vodog.example.com")/api/v1")!
    /// S99 §4: optional relay API host for networks where the direct host is unreliable (VODOG_RELAY_DOMAIN,
    /// hostname[:port]). Bearer only; used by `ClientEndpoint`. Empty or unset = relay disabled.
    static let relayAPIBaseURL: URL? = relayAPIBaseURL(domain: Bundle.main.object(forInfoDictionaryKey: "VoDogRelayDomain") as? String)
    static let productionKeychainService = "org.vodog"

    static func relayAPIBaseURL(domain: String?) -> URL? {
        guard let domain = domain?.trimmingCharacters(in: .whitespaces), !domain.isEmpty,
              !domain.contains("$("), !domain.contains("/") else { return nil }
        return URL(string: "https://\(domain)/api/v1")
    }
    static let isolatedSimulatorKeychainService = "org.vodog.s33-local-ui"

    /// S33's real-backend UI suite is allowed to target one isolated loopback service. The compiler removes this
    /// branch from device and Release builds, and strict equality keeps an injected value from becoming an
    /// arbitrary clear-text endpoint.
    static func simulatorUITestAPIBaseURL(environment: [String: String]) -> URL? {
        #if DEBUG && targetEnvironment(simulator)
        guard environment["VODOG_UI_TEST_API_BASE_URL"] == "http://127.0.0.1:16880/api/v1" else { return nil }
        return URL(string: "http://127.0.0.1:16880/api/v1")
        #else
        return nil
        #endif
    }

    static var isolatedSimulatorUITestEnabled: Bool {
        simulatorUITestAPIBaseURL(environment: ProcessInfo.processInfo.environment) != nil
    }

    static var apiBaseURL: URL {
        simulatorUITestAPIBaseURL(environment: ProcessInfo.processInfo.environment) ?? productionAPIBaseURL
    }

    static var keychainService: String {
        keychainService(environment: ProcessInfo.processInfo.environment)
    }

    static func keychainService(environment: [String: String]) -> String {
        simulatorUITestAPIBaseURL(environment: environment) == nil
            ? productionKeychainService : isolatedSimulatorKeychainService
    }
}
