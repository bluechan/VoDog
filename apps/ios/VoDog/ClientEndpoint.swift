import CoreTelephony
import Foundation

/// S99 §4 (port of Android S72b `ClientRelayPolicy`): on a China cellular network the API and the media-options
/// `relay` flag go through the optional relay host (`AppRuntimeConfiguration.relayAPIBaseURL`, VODOG_RELAY_DOMAIN);
/// everywhere else direct. With no relay configured the whole mechanism is disabled. An idempotent request that fails at the network layer retries once on the other base, and the base that
/// answered stays first on that network for `learnedTTL`.
enum ClientEndpointPolicy {
    static let chinaMCC = "460"
    static let learnedTTL: TimeInterval = 10 * 60
    /// Android's set plus "Asia/Taipei": an iPhone on a mainland carrier has been seen reporting Asia/Taipei, and
    /// with CTCarrier hiding the MCC the time zone is what decides there.
    static let chinaTimeZones: Set<String> = [
        "Asia/Shanghai", "Asia/Chongqing", "Asia/Chungking", "Asia/Harbin", "Asia/Urumqi", "Asia/Kashgar", "PRC",
        "Asia/Taipei"
    ]

    /// A real MCC is three digits. CTCarrier answers "65535" / "--" / nil to apps since iOS 16.4, so in practice
    /// the time zone usually decides.
    static func mcc(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespaces), value.count == 3,
              value.allSatisfy(\.isASCII), value.allSatisfy(\.isNumber) else { return nil }
        return value
    }

    /// The data SIM's MCC decides first (roaming data is home-routed), then the registered network's, then the
    /// time zone.
    static func chinaCellular(simMCC: String?, networkMCC: String?, timeZoneID: String?) -> Bool {
        if let mcc = mcc(simMCC) ?? mcc(networkMCC) { return mcc == chinaMCC }
        return timeZoneID.map(chinaTimeZones.contains) ?? false
    }

    /// `learned` (a measured failover on this network) wins; otherwise relay only on China cellular.
    static func relay(transport: String, chinaCellular: Bool, learned: Bool?) -> Bool {
        learned ?? (transport == "cellular" && chinaCellular)
    }

    /// GET, a POST with an `Idempotency-Key`, and `media/options`. `media/offer`, `claim` and `end` never retry
    /// on the other base (same as Android): a second offer or claim is not a no-op.
    static func retriesOnAlternate(method: String, path: String, idempotencyKey: String?) -> Bool {
        if path.hasSuffix("/media/offer") || path.hasSuffix("/claim") || path.hasSuffix("/end") { return false }
        return method == "GET" || idempotencyKey != nil || path.hasSuffix("/media/options")
    }

    /// Only a failure that never produced an HTTP response; any status code means the base is reachable.
    static func switchesEndpoint(after error: Error) -> Bool {
        guard let error = error as? URLError else { return false }
        return [.timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost, .dnsLookupFailed,
                .secureConnectionFailed].contains(error.code)
    }
}

/// The runtime half: which network the app is on (fed by `MediaNetworkGenerationSource`'s path monitor) and what
/// was learned on it. Instances exist for tests; the app uses `shared`.
final class ClientEndpoint: @unchecked Sendable {
    static let shared = ClientEndpoint()

    private let lock = NSLock()
    private var transport = "none"
    private var networkKey: String?
    private var chinaCellular = false
    private var learned: [String: (relay: Bool, until: TimeInterval)] = [:]
    /// Last value reported in `api.relay`, so the diag records flips only.
    private var reported = false
    /// False when no relay is configured, or the app targets a non-production base (S33 loopback): there is no
    /// alternate then.
    let enabled: Bool
    private let relayBaseURL: URL?

    init(
        enabled: Bool = AppRuntimeConfiguration.apiBaseURL == AppRuntimeConfiguration.productionAPIBaseURL,
        relayBaseURL: URL? = AppRuntimeConfiguration.relayAPIBaseURL
    ) {
        self.enabled = enabled && relayBaseURL != nil
        self.relayBaseURL = relayBaseURL
    }

    func relay(now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Bool {
        lock.withLock { relayLocked(now: now) }
    }

    /// Called on every path update. `key` is the monitor's `status:type` label; CoreTelephony is read only when
    /// the network actually changed to cellular.
    func onPath(transport: String, key: String, chinaCellular: () -> Bool = ClientEndpoint.readChinaCellular) {
        let changed = lock.withLock { self.transport != transport || networkKey != key }
        if changed {
            let china = transport == "cellular" && chinaCellular()
            lock.withLock { self.transport = transport; networkKey = key; self.chinaCellular = china }
        }
        reportFlip(reason: lock.withLock { self.chinaCellular } ? "china_cellular" : "network")
    }

    /// The other base answered after this one failed at the network layer: use it first on this network.
    func learn(workingRelay: Bool, now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        let stored: Bool = lock.withLock {
            guard let networkKey else { return false }
            learned = learned.filter { $0.value.until > now }
            learned[networkKey] = (workingRelay, now + ClientEndpointPolicy.learnedTTL)
            return true
        }
        if stored { reportFlip(reason: "learned", now: now) }
    }

    func baseURL(relay: Bool) -> URL {
        relay && enabled ? relayBaseURL ?? AppRuntimeConfiguration.apiBaseURL : AppRuntimeConfiguration.apiBaseURL
    }

    private func relayLocked(now: TimeInterval) -> Bool {
        guard enabled else { return false }
        let learnedRelay = networkKey.flatMap { learned[$0] }.flatMap { $0.until > now ? $0.relay : nil }
        return ClientEndpointPolicy.relay(transport: transport, chinaCellular: chinaCellular, learned: learnedRelay)
    }

    private func reportFlip(reason: String, now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        let flip: (on: Bool, network: String)? = lock.withLock {
            let next = relayLocked(now: now)
            guard next != reported else { return nil }
            reported = next
            return (next, transport)
        }
        if let flip { Diag.shared.log("api.relay", ["on": flip.on, "network": flip.network, "reason": reason]) }
    }

    static func readChinaCellular() -> Bool {
        let info = CTTelephonyNetworkInfo()
        let providers = info.serviceSubscriberCellularProviders ?? [:]
        let simMCC = info.dataServiceIdentifier.flatMap { providers[$0]?.mobileCountryCode }
        // iOS has no separate registered-network MCC; the provider of a SIM that is on a radio right now is the
        // closest reading.
        let networkMCC = (info.serviceCurrentRadioAccessTechnology ?? [:]).keys.sorted()
            .lazy.compactMap { ClientEndpointPolicy.mcc(providers[$0]?.mobileCountryCode) }.first
        return ClientEndpointPolicy.chinaCellular(
            simMCC: simMCC, networkMCC: networkMCC, timeZoneID: TimeZone.current.identifier
        )
    }
}
