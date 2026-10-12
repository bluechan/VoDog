import Foundation

/// S104 thin client: Bearer + `Idempotency-Key`, direct and relay bases with the same values as iOS
/// (`AppRuntimeConfiguration`). No refresh, no logout: a 401 is reported to the caller, which keeps its snapshot.
struct WatchAPIClient: Sendable {
    let token: String

    /// The base that answered last; a network-layer failure on a GET or idempotent request retries once on the other.
    nonisolated(unsafe) private static var preferRelay = false

    func request<Response: Decodable & Sendable>(
        _ path: String, method: String = "GET", body: (any Encodable & Sendable)? = nil,
        idempotencyKey: String? = nil, query: [URLQueryItem] = [], headers: [String: String] = [:]
    ) async throws -> Response {
        let relay = Self.preferRelay
        do {
            return try await send(path, base: base(relay), method: method, body: body, key: idempotencyKey, query: query,
                                  headers: headers)
        } catch let error as URLError where Self.switches(error) && AppRuntimeConfiguration.relayAPIBaseURL != nil
            && (method == "GET" || idempotencyKey != nil) {
            let response: Response = try await send(path, base: base(!relay), method: method, body: body,
                                                    key: idempotencyKey, query: query, headers: headers)
            Self.preferRelay = !relay
            _ = error
            return response
        }
    }

    private func base(_ relay: Bool) -> URL {
        // VoDog: the relay host is optional (VODOG_RELAY_DOMAIN); with none configured every request goes direct.
        relay ? AppRuntimeConfiguration.relayAPIBaseURL ?? AppRuntimeConfiguration.productionAPIBaseURL
            : AppRuntimeConfiguration.productionAPIBaseURL
    }

    private static func switches(_ error: URLError) -> Bool {
        [.timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost, .dnsLookupFailed,
         .secureConnectionFailed, .notConnectedToInternet].contains(error.code)
    }

    private func send<Response: Decodable & Sendable>(
        _ path: String, base: URL, method: String, body: (any Encodable & Sendable)?, key: String?, query: [URLQueryItem],
        headers: [String: String]
    ) async throws -> Response {
        var components = URLComponents(url: path.split(separator: "/").reduce(base) { $0.appendingPathComponent(String($1)) },
                                       resolvingAgainstBaseURL: false)
        if !query.isEmpty {
            components?.queryItems = query
            let encoded = components?.percentEncodedQuery
            components?.percentEncodedQuery = encoded?.replacingOccurrences(of: "+", with: "%2B")
        }
        guard let url = components?.url else { throw APIError.invalidResponse }
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
            throw APIError.server(http.statusCode, envelope?.error.message ?? "", envelope?.error.code)
        }
        if data.isEmpty || Response.self == EmptyResponse.self, let empty = EmptyResponse() as? Response { return empty }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private struct ErrorEnvelope: Decodable {
        let error: Body
        struct Body: Decodable { let code: String?; let message: String? }
    }
}

// MARK: - Request / response shapes (same fields as the iOS client)

struct WatchCallEndBody: Encodable, Sendable { var onlyIfRinging: Bool? }
struct WatchSMSReadBody: Encodable, Sendable { let ids: [String] }
struct WatchBlockBody: Encodable, Sendable { let remoteNumber: String; let sourceCallId: String?; let scope: String }
struct WatchSettingsBody: Encodable, Sendable { let mode: String; let timeoutSeconds: Int; let expectedVersion: Int }
struct WatchSettingsEnvelope: Decodable, Sendable { let settings: SIMSettings }
struct WatchSMSEnvelope: Decodable, Sendable { let sms: SMSMessage }
struct WatchBadges: Codable, Sendable, Equatable { var calls = 0; var sms = 0 }

struct WatchPushBody: Encodable, Sendable {
    let platform = "watchos"
    let bundleId = "org.vodog.watchkitapp"
    let environment: String
    let deviceName: String
    let apnsToken: String
}
