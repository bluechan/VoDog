import XCTest
@testable import VoDog

/// S99: iOS call response and stability (media before refresh, poll timeout, PushKit placeholder, cellular relay).
final class S99ClientPolicyTests: XCTestCase {
    override func tearDown() {
        S99URLProtocol.handler = nil
        super.tearDown()
    }

    func testCallStartBeginsMediaWithoutWaitingForTheListRefresh() {
        XCTAssertFalse(CallStartSequencePolicy.mediaWaitsForRefresh)
        XCTAssertEqual(
            CallStartSequencePolicy.steps(registersOwnedCall: true), [.registerOwnedCall, .refreshList, .startMedia]
        )
        XCTAssertEqual(CallStartSequencePolicy.steps(registersOwnedCall: false), [.refreshList, .startMedia])
    }

    func testStaleRefreshCannotStopMediaStartedAfterItBegan() {
        XCTAssertTrue(CallStartSequencePolicy.mayStopMedia(loadGeneration: 3, currentGeneration: 3))
        XCTAssertFalse(CallStartSequencePolicy.mayStopMedia(loadGeneration: 3, currentGeneration: 4))
    }

    func testPollRequestTimeoutIsEightSeconds() {
        XCTAssertEqual(CallRefreshCadencePolicy.pollRequestTimeout, 8)
    }

    func testUnusableVoIPPushStillReportsAPlaceholderCall() {
        XCTAssertTrue(IncomingCallReportPolicy.needsPlaceholderReport(event: nil))
        XCTAssertTrue(IncomingCallReportPolicy.needsPlaceholderReport(event: "call.cancelled"))
        XCTAssertFalse(IncomingCallReportPolicy.needsPlaceholderReport(event: "call.incoming"))
        // A payload that does not parse (wrong version, non-UUID id) arrives as `event: nil`.
        XCTAssertNil(PushCallPayload(["version": 1, "event": "call.incoming", "callId": "not-a-uuid"]))
        XCTAssertNil(PushCallPayload(["event": "call.incoming"]))
        XCTAssertEqual(IncomingCallReportPolicy.placeholderCallerName, "未知来电")
    }

    func testRelayDecisionTable() {
        let cn = ClientEndpointPolicy.chinaCellular(simMCC: "460", networkMCC: nil, timeZoneID: "Europe/Berlin")
        XCTAssertTrue(ClientEndpointPolicy.relay(transport: "cellular", chinaCellular: cn, learned: nil))
        let de = ClientEndpointPolicy.chinaCellular(simMCC: "262", networkMCC: "460", timeZoneID: "Asia/Shanghai")
        XCTAssertFalse(ClientEndpointPolicy.relay(transport: "cellular", chinaCellular: de, learned: nil))
        // Unknown MCC (CTCarrier placeholders) → the time zone decides.
        XCTAssertTrue(ClientEndpointPolicy.chinaCellular(simMCC: "65535", networkMCC: "--", timeZoneID: "Asia/Shanghai"))
        XCTAssertTrue(ClientEndpointPolicy.chinaCellular(simMCC: nil, networkMCC: nil, timeZoneID: "PRC"))
        let taipei = ClientEndpointPolicy.chinaCellular(simMCC: "65535", networkMCC: nil, timeZoneID: "Asia/Taipei")
        XCTAssertTrue(ClientEndpointPolicy.relay(transport: "cellular", chinaCellular: taipei, learned: nil))
        XCTAssertFalse(ClientEndpointPolicy.chinaCellular(simMCC: nil, networkMCC: nil, timeZoneID: "Europe/Berlin"))
        XCTAssertTrue(ClientEndpointPolicy.chinaCellular(simMCC: nil, networkMCC: "460", timeZoneID: "Europe/Berlin"))
        // Wi-Fi is direct even in China; a learned failover wins either way.
        XCTAssertFalse(ClientEndpointPolicy.relay(transport: "wifi", chinaCellular: true, learned: nil))
        XCTAssertTrue(ClientEndpointPolicy.relay(transport: "wifi", chinaCellular: false, learned: true))
        XCTAssertFalse(ClientEndpointPolicy.relay(transport: "cellular", chinaCellular: true, learned: false))
    }

    func testOnlyIdempotentRequestsRetryAndOnlyOnNetworkFailures() {
        XCTAssertTrue(ClientEndpointPolicy.retriesOnAlternate(method: "GET", path: "calls", idempotencyKey: nil))
        XCTAssertTrue(ClientEndpointPolicy.retriesOnAlternate(method: "POST", path: "calls/outbound", idempotencyKey: "k"))
        XCTAssertTrue(ClientEndpointPolicy.retriesOnAlternate(method: "POST", path: "calls/a/media/options", idempotencyKey: nil))
        for path in ["calls/a/media/offer", "calls/a/claim", "calls/a/end"] {
            XCTAssertFalse(ClientEndpointPolicy.retriesOnAlternate(method: "POST", path: path, idempotencyKey: nil))
        }
        XCTAssertFalse(ClientEndpointPolicy.retriesOnAlternate(method: "POST", path: "sms", idempotencyKey: nil))
        XCTAssertTrue(ClientEndpointPolicy.switchesEndpoint(after: URLError(.timedOut)))
        XCTAssertTrue(ClientEndpointPolicy.switchesEndpoint(after: URLError(.cannotConnectToHost)))
        XCTAssertTrue(ClientEndpointPolicy.switchesEndpoint(after: URLError(.networkConnectionLost)))
        XCTAssertTrue(ClientEndpointPolicy.switchesEndpoint(after: URLError(.dnsLookupFailed)))
        XCTAssertFalse(ClientEndpointPolicy.switchesEndpoint(after: URLError(.cancelled)))
        XCTAssertFalse(ClientEndpointPolicy.switchesEndpoint(after: APIError.server(502, "", nil)))
    }

    func testNetworkFailureSwitchesEndpointAndIsRememberedTenMinutes() async throws {
        let endpoint = ClientEndpoint(enabled: true, relayBaseURL: Self.relayBase)
        endpoint.onPath(transport: "cellular", key: "satisfied:cellular", chinaCellular: { false })
        XCTAssertFalse(endpoint.relay())
        let hosts = S99Hosts()
        S99URLProtocol.handler = { request in
            hosts.append(request.url?.host ?? "")
            if request.url?.host == Self.directHost { throw URLError(.timedOut) }
            return (200, #"{"items":[]}"#)
        }
        let _: ItemEnvelope<CallRecord> = try await APIClient(token: "t", session: Self.session(), endpoint: endpoint)
            .request("calls")
        XCTAssertEqual(hosts.values, [Self.directHost, Self.relayHost])
        let now = ProcessInfo.processInfo.systemUptime
        XCTAssertTrue(endpoint.relay(now: now))
        XCTAssertTrue(endpoint.relay(now: now + ClientEndpointPolicy.learnedTTL - 5))
        XCTAssertFalse(endpoint.relay(now: now + ClientEndpointPolicy.learnedTTL + 1))
    }

    func testHTTPErrorAndNonIdempotentRequestsDoNotSwitch() async {
        let endpoint = ClientEndpoint(enabled: true, relayBaseURL: Self.relayBase)
        endpoint.onPath(transport: "cellular", key: "satisfied:cellular", chinaCellular: { false })
        let hosts = S99Hosts()
        S99URLProtocol.handler = { request in
            hosts.append(request.url?.host ?? "")
            return (502, #"{"error":{"message":"bad gateway"}}"#)
        }
        let client = APIClient(token: "t", session: Self.session(), endpoint: endpoint)
        do { let _: ItemEnvelope<CallRecord> = try await client.request("calls"); XCTFail("expected 502") } catch {}
        XCTAssertEqual(hosts.values, [Self.directHost])
        XCTAssertFalse(endpoint.relay())

        S99URLProtocol.handler = { request in
            hosts.append(request.url?.host ?? "")
            throw URLError(.timedOut)
        }
        do {
            let _: EmptyResponse = try await client.request("calls/a/claim", method: "POST")
            XCTFail("expected timeout")
        } catch {}
        XCTAssertEqual(hosts.values, [Self.directHost, Self.directHost])
    }

    func testMediaOptionsRelayFieldIsEncoded() throws {
        let body = try JSONEncoder().encode(MediaOptionsRequest(transport: .tls, networkGeneration: "g", relay: true))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["relay"] as? Bool, true)
        let ice = try JSONDecoder().decode(MediaIceServer.self, from: Data(
            #"{"urls":["turns:192.0.2.10:3478?transport=tcp"],"hostname":"relay.example.com","username":"u","credential":"c"}"#.utf8
        ))
        XCTAssertEqual(ice.hostname, "relay.example.com")
    }

    func testRelayIsDisabledUnlessConfigured() {
        XCTAssertNil(AppRuntimeConfiguration.relayAPIBaseURL(domain: nil))
        XCTAssertNil(AppRuntimeConfiguration.relayAPIBaseURL(domain: " "))
        XCTAssertNil(AppRuntimeConfiguration.relayAPIBaseURL(domain: "$(VODOG_RELAY_DOMAIN)"))
        XCTAssertEqual(
            AppRuntimeConfiguration.relayAPIBaseURL(domain: "relay.example.com:8443")?.absoluteString,
            "https://relay.example.com:8443/api/v1"
        )
        // The shipped default (empty VODOG_RELAY_DOMAIN) leaves the relay off even on China cellular.
        XCTAssertNil(AppRuntimeConfiguration.relayAPIBaseURL)
        let endpoint = ClientEndpoint(enabled: true, relayBaseURL: nil)
        endpoint.onPath(transport: "cellular", key: "satisfied:cellular", chinaCellular: { true })
        XCTAssertFalse(endpoint.enabled)
        XCTAssertFalse(endpoint.relay())
        XCTAssertEqual(endpoint.baseURL(relay: true), AppRuntimeConfiguration.apiBaseURL)
    }

    private static let directHost = AppRuntimeConfiguration.apiBaseURL.host ?? ""
    private static let relayHost = "relay.example.com"
    private static let relayBase = URL(string: "https://relay.example.com/api/v1")!

    private static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [S99URLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

private final class S99Hosts: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String] = []
    var values: [String] { lock.withLock { stored } }
    func append(_ host: String) { lock.withLock { stored.append(host) } }
}

private final class S99URLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, String))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let result = try Self.handler?(request) ?? (500, "")
            let response = HTTPURLResponse(
                url: request.url!, statusCode: result.0, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(result.1.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
