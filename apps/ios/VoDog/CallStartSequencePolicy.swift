import Foundation

/// S99 §1: once Control hands over a call (dial response, in-app claim), media starts first and the list refresh
/// runs alongside it — Web's order. Waiting for `sims` + `calls` first cost one RTT plus two list payloads before
/// `media/options` (0.3–0.5 s at high RTT). S20 decision 6 still owns the dialled call id before anything awaits.
enum CallStartSequencePolicy {
    enum Step: Equatable { case registerOwnedCall, startMedia, refreshList }

    /// The order each step begins in. `refreshList` is started without being awaited, so `startMedia` follows it
    /// immediately.
    static func steps(registersOwnedCall: Bool) -> [Step] {
        (registersOwnedCall ? [.registerOwnedCall] : []) + [.refreshList, .startMedia]
    }

    static let mediaWaitsForRefresh = false

    /// A list refresh may stop media for a call missing from its list only if no media start happened since the
    /// refresh began: a poll whose GET left before the dial/claim carries a list without the new call (S98 Android).
    static func mayStopMedia(loadGeneration: Int, currentGeneration: Int) -> Bool {
        loadGeneration == currentGeneration
    }
}
