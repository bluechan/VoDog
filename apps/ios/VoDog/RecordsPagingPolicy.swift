import Foundation

/// S133. 全部通话 is no longer paged: the newest `chunk` rows first, then the next `chunk` behind a keyset cursor
/// as the list nears its end. What a head refresh keeps, where the next chunk starts and when the list is
/// known to be complete are pure functions here so the poll can never throw a scrolled user back to 50 rows.
enum CallsScrollPolicy {
    /// One request's `limit`, and therefore also the row count below which an answer is the end of the list.
    static let chunk = 50
    /// A row this close to the end appearing asks for the next chunk.
    static let prefetchDistance = 10

    /// A fresh head merged over what is already loaded: the head, then the loaded rows that are not in it and
    /// not newer than its last row. A loaded row that is newer than that and still absent from the head was
    /// deleted elsewhere. A short head is the whole list, and so is a full one with no row in common with
    /// `loaded`. `loaded` must be in list order (newest first) — pass `[]` when it belongs to another search
    /// or account.
    static func afterHead(
        _ head: [CallRecord], loaded: [CallRecord], reachedEnd: Bool
    ) -> (calls: [CallRecord], reachedEnd: Bool) {
        guard head.count >= chunk, let floor = head.last?.startedAt.flatMap(GatewayTimeDisplay.parseISO) else {
            return (head, head.count < chunk)
        }
        // A full head that shares no row with what is loaded leaves a gap of unknown size between the two
        // (50+ calls arrived while backgrounded): the head replaces the list and scrolling refills it.
        let loadedIDs = Set(loaded.map(\.id))
        guard head.contains(where: { loadedIDs.contains($0.id) }) else { return (head, false) }
        let ids = Set(head.map(\.id))
        // Dates rather than strings: "…:00Z" and "…:00.000Z" are the same instant. `loaded` is newest first, so
        // only its leading rows are parsed; one there whose time cannot be read counts as newer and goes too.
        let tail = loaded.drop { row in
            guard let startedAt = row.startedAt.flatMap(GatewayTimeDisplay.parseISO) else { return true }
            return startedAt > floor
        }.filter { !ids.contains($0.id) }
        let calls = head + tail
        // The end stays known only while the list still ends on the row it was learnt at.
        return (calls, reachedEnd && calls.last?.id == loaded.last?.id)
    }

    /// The next chunk appended, de-duplicated by id. Fewer than `chunk` rows means there is nothing older.
    static func afterChunk(_ rows: [CallRecord], loaded: [CallRecord]) -> (calls: [CallRecord], reachedEnd: Bool) {
        let ids = Set(loaded.map(\.id))
        return (loaded + rows.filter { !ids.contains($0.id) }, rows.count < chunk)
    }

    /// `before` is the last row's `startedAt` untouched — the server compares it at the precision it sent.
    static func cursor(after loaded: [CallRecord]) -> SMSPageCursor? {
        guard let last = loaded.last, let before = last.startedAt else { return nil }
        return SMSPageCursor(before: before, beforeId: last.id)
    }

    static func isNearEnd(_ id: String, in loaded: [CallRecord]) -> Bool {
        loaded.suffix(prefetchDistance).contains { $0.id == id }
    }
}

/// S133. 报告 and 拦截记录 scroll too, but their routes only page by offset (`page`/`pageSize`, no cursor), so
/// the rules are order-key-free and shared by both lists: the head is page 1, the next chunk is the page
/// after the rows already loaded, and the envelope's `total` says when to stop.
enum RecordsScrollPolicy {
    static let chunk = CallsScrollPolicy.chunk

    /// A fresh head merged over what is already loaded. A short head is the whole list; a full one with no row
    /// in common with `loaded` leaves a gap of unknown size — both replace. Otherwise the head is followed by
    /// the loaded rows after the deepest one it also carries: nothing after that row can be in the head, and a
    /// loaded row before it that the head lacks was deleted elsewhere.
    static func afterHead<Row: Identifiable>(_ head: [Row], loaded: [Row]) -> [Row] {
        let ids = Set(head.map(\.id))
        guard head.count >= chunk, let deepest = loaded.lastIndex(where: { ids.contains($0.id) }) else { return head }
        return head + loaded[(deepest + 1)...]
    }

    /// The next chunk appended, de-duplicated by id.
    static func afterChunk<Row: Identifiable>(_ rows: [Row], loaded: [Row]) -> [Row] {
        let ids = Set(loaded.map(\.id))
        return loaded + rows.filter { !ids.contains($0.id) }
    }

    /// Derived from the rows on screen rather than counted, so a locally deleted row makes the next request
    /// overlap instead of skip.
    // ponytail: offset paging — a row deleted on another device inside the loaded range can make one row be
    // skipped until 下拉刷新; a Control keyset cursor on these two routes is the upgrade path.
    static func nextPage(loadedCount: Int) -> Int { loadedCount / chunk + 1 }

    /// Nothing older to ask for. `total` is nil when a Control that predates paging answered its one unpaged
    /// page, which is then the whole list; `answered` is the row count of the response just applied.
    static func reachedEnd(loadedCount: Int, total: Int?, answered: Int) -> Bool {
        guard let total, answered > 0 else { return true }
        return loadedCount >= total
    }

    /// A row this close to the end appearing asks for the next chunk.
    static func isNearEnd<Row: Identifiable>(_ id: Row.ID, in loaded: [Row]) -> Bool {
        loaded.suffix(CallsScrollPolicy.prefetchDistance).contains { $0.id == id }
    }
}
