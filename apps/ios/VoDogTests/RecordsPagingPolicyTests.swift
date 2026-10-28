import XCTest
@testable import VoDog

/// S133 滚动加载。记录 的三个分段都不再分页：全部通话走游标，报告与拦截记录走 page 偏移。这里把"首批怎么合并、
/// 下一批从哪里要、什么时候算到底"定死成纯函数事实，Android 照抄同一套规则。
final class RecordsPagingPolicyTests: XCTestCase {
    private struct Row: Identifiable, Equatable { let id: String }

    private func items(_ range: ClosedRange<Int>) -> [Row] { range.map { Row(id: "r\($0)") } }

    // MARK: - 报告 / 拦截记录：首批合并（不依赖排序键）

    func testGenericHeadMergePutsANewRowOnTopAndKeepsTheLoadedTail() {
        let head = [Row(id: "new")] + items(1...49)
        let merged = RecordsScrollPolicy.afterHead(head, loaded: items(1...120))
        XCTAssertEqual(merged, [Row(id: "new")] + items(1...120), "滚到深处的用户不被弹回前 50 条")
        XCTAssertEqual(Set(merged.map(\.id)).count, merged.count, "不出现重复 id")
        // 没有变化的首批：原样。
        XCTAssertEqual(RecordsScrollPolicy.afterHead(items(1...50), loaded: items(1...120)), items(1...120))
    }

    func testGenericHeadMergeDropsARowDeletedInsideTheHeadWindow() {
        // 第 7 行在别处被删了：首批变成 1…6、8…51；第 7 行排在"首批里最深的已加载行"之前又不在首批里。
        let head = items(1...51).filter { $0.id != "r7" }
        let merged = RecordsScrollPolicy.afterHead(head, loaded: items(1...80))
        XCTAssertEqual(merged, items(1...80).filter { $0.id != "r7" })
        XCTAssertEqual(Set(merged.map(\.id)).count, merged.count)
    }

    func testGenericShortHeadIsTheWholeListAndReplacesEverything() {
        XCTAssertEqual(RecordsScrollPolicy.afterHead(items(1...12), loaded: items(1...120)), items(1...12))
        XCTAssertEqual(RecordsScrollPolicy.afterHead([Row](), loaded: items(1...120)), [])
        // 搜索词、日期范围或账号变了：调用方传空的 loaded。
        XCTAssertEqual(RecordsScrollPolicy.afterHead(items(1...50), loaded: []), items(1...50))
    }

    func testGenericFullHeadWithNoRowInCommonReplacesInsteadOfLeavingAGap() {
        let head = (1...50).map { Row(id: "n\($0)") }
        XCTAssertEqual(RecordsScrollPolicy.afterHead(head, loaded: items(1...120)), head)
        // 只要有一行相同就仍然合并。
        let touching = Array(head.dropFirst()) + items(1...1)
        XCTAssertEqual(RecordsScrollPolicy.afterHead(touching, loaded: items(1...120)).count, 49 + 120)
    }

    // MARK: - 下一批：页码、去重、到底

    func testNextPageIsDerivedFromTheRowsLoadedNotCounted() {
        XCTAssertEqual(RecordsScrollPolicy.chunk, 50)
        XCTAssertEqual(RecordsScrollPolicy.nextPage(loadedCount: 50), 2)
        XCTAssertEqual(RecordsScrollPolicy.nextPage(loadedCount: 49), 1, "本地删了一行：重取第 1 页，重叠而不是跳过")
        XCTAssertEqual(RecordsScrollPolicy.nextPage(loadedCount: 100), 3)
        XCTAssertEqual(RecordsScrollPolicy.nextPage(loadedCount: 120), 3)
        XCTAssertEqual(RecordsScrollPolicy.nextPage(loadedCount: 0), 1)
    }

    func testNextChunkAppendsByIdAndAnOverlappingPageOnlyAddsTheNewRows() {
        XCTAssertEqual(RecordsScrollPolicy.afterChunk(items(51...100), loaded: items(1...50)), items(1...100))
        // 本地删掉第 7 行后重取第 1 页（服务端的 1…6、8…51）：只多出第 51 行。
        let loaded = items(1...50).filter { $0.id != "r7" }
        let page1 = items(1...51).filter { $0.id != "r7" }
        XCTAssertEqual(RecordsScrollPolicy.afterChunk(page1, loaded: loaded), loaded + items(51...51))
        // 一行都没多出来：列表不变，由调用方收起转圈、等下一次滚动或首批合并，不循环。
        XCTAssertEqual(RecordsScrollPolicy.afterChunk(items(1...50), loaded: items(1...50)), items(1...50))
    }

    func testEndIsTheEnvelopeTotalAnEmptyChunkOrAnUnpagedControl() {
        XCTAssertFalse(RecordsScrollPolicy.reachedEnd(loadedCount: 50, total: 187, answered: 50))
        XCTAssertTrue(RecordsScrollPolicy.reachedEnd(loadedCount: 187, total: 187, answered: 37))
        XCTAssertTrue(RecordsScrollPolicy.reachedEnd(loadedCount: 190, total: 187, answered: 50))
        XCTAssertTrue(RecordsScrollPolicy.reachedEnd(loadedCount: 100, total: 187, answered: 0), "空的一批就是末尾")
        XCTAssertTrue(RecordsScrollPolicy.reachedEnd(loadedCount: 0, total: 0, answered: 0))
        // 旧 Control：只有 items，没有任何计数——它答的那一页就是全部。
        XCTAssertTrue(RecordsScrollPolicy.reachedEnd(loadedCount: 100, total: nil, answered: 100))
    }

    func testOnlyARowNearTheEndOfTheGivenRowsAsksForMore() {
        let loaded = items(1...50)
        XCTAssertTrue(RecordsScrollPolicy.isNearEnd("r50", in: loaded))
        XCTAssertTrue(RecordsScrollPolicy.isNearEnd("r41", in: loaded))
        XCTAssertFalse(RecordsScrollPolicy.isNearEnd("r40", in: loaded))
        XCTAssertFalse(RecordsScrollPolicy.isNearEnd("gone", in: loaded))
        // 拦截记录按类型筛过之后只剩几行：每一行都算"接近末尾"。
        XCTAssertTrue(RecordsScrollPolicy.isNearEnd("r1", in: items(1...3)))
    }

    // MARK: - 查询串

    func testCallsQuerySendsLimitAndTheKeysetCursorAndNeverAPage() {
        // 首批：最新 50 条，连拦截行一起，绝不带 page / pageSize。
        let head = RecordSearchPolicy.callsQuery(query: "  张三  ")
        XCTAssertEqual(query(head), ["limit": "50", "includeBlocked": "true", "query": "张三"])
        XCTAssertEqual(query(RecordSearchPolicy.callsQuery(query: "   ")), ["limit": "50", "includeBlocked": "true"])

        // 下一批：同一请求加上最后一行的 startedAt（服务端原样的毫秒串）和它的 id。
        let last = call("0c7336d3-0000-4000-8000-000000000050", "2026-09-12T01:02:03.456Z")
        let cursor = CallsScrollPolicy.cursor(after: [call("a", "2026-09-12T02:00:00.000Z"), last])
        XCTAssertEqual(cursor, SMSPageCursor(before: "2026-09-12T01:02:03.456Z", beforeId: last.id))
        let next = RecordSearchPolicy.callsQuery(query: "张三", cursor: cursor)
        XCTAssertEqual(query(next), [
            "limit": "50", "includeBlocked": "true", "query": "张三",
            "before": "2026-09-12T01:02:03.456Z", "beforeId": "0c7336d3-0000-4000-8000-000000000050",
        ])
        XCTAssertNil(query(next)["page"], "page 与 before 同发会被服务端 400")
        XCTAssertNil(query(next)["pageSize"])
        var components = URLComponents(string: "https://example.invalid/api/v1/calls")!
        components.queryItems = RecordSearchPolicy.callsQuery(query: "", cursor: cursor)
        XCTAssertEqual(
            components.url?.query,
            "limit=50&includeBlocked=true&before=2026-09-12T01:02:03.456Z&beforeId=0c7336d3-0000-4000-8000-000000000050"
        )

        // 选中某条线路时按 simId 让服务端筛，而不是把一批里不属于它的行删掉。
        XCTAssertEqual(query(RecordSearchPolicy.callsQuery(query: "", simId: "sim-1"))["simId"], "sim-1")
        XCTAssertNil(query(RecordSearchPolicy.callsQuery(query: "", simId: "  "))["simId"])

        // 没有可用的游标：空列表，或最后一行没有 startedAt。
        XCTAssertNil(CallsScrollPolicy.cursor(after: []))
        XCTAssertNil(CallsScrollPolicy.cursor(after: [call("a", nil)]))
    }

    // MARK: - S133 全部通话滚动加载

    func testHeadMergePutsANewCallOnTopAndKeepsTheLoadedTail() {
        let loaded = rows(1...120)
        // 来了一通新电话：首批 = 新行 + 原来的第 1…49 行。
        let head = [call("new", stamp(0))] + rows(1...49)
        let feed = CallsScrollPolicy.afterHead(head, loaded: loaded, reachedEnd: false)
        XCTAssertEqual(feed.calls.map(\.id), ["new"] + rows(1...120).map(\.id), "滚到深处的用户不被弹回前 50 条")
        XCTAssertEqual(Set(feed.calls.map(\.id)).count, feed.calls.count, "不出现重复 id")
        XCTAssertFalse(feed.reachedEnd)

        // 已经到底的列表在合并后仍然到底：末尾还是同一行。
        XCTAssertTrue(CallsScrollPolicy.afterHead(head, loaded: loaded, reachedEnd: true).reachedEnd)
    }

    func testHeadMergeDropsARowDeletedInsideTheHeadWindow() {
        let loaded = rows(1...80)
        // 第 7 行在别处被删了：首批变成 1…6、8…51，第 7 行比首批末行新却不在首批里。
        let head = rows(1...51).filter { $0.id != "c7" }
        let feed = CallsScrollPolicy.afterHead(head, loaded: loaded, reachedEnd: false)
        XCTAssertEqual(feed.calls.map(\.id), rows(1...80).map(\.id).filter { $0 != "c7" })
    }

    func testAShortHeadIsTheWholeListAndReplacesEverything() {
        let feed = CallsScrollPolicy.afterHead(rows(1...12), loaded: rows(1...120), reachedEnd: false)
        XCTAssertEqual(feed.calls.map(\.id), rows(1...12).map(\.id))
        XCTAssertTrue(feed.reachedEnd)
        let empty = CallsScrollPolicy.afterHead([], loaded: rows(1...120), reachedEnd: false)
        XCTAssertTrue(empty.calls.isEmpty)
        XCTAssertTrue(empty.reachedEnd)

        // 搜索词或账号变了：调用方传空的 loaded，满 50 行的首批就是新列表，后面还可能有。
        let replaced = CallsScrollPolicy.afterHead(rows(1...50), loaded: [], reachedEnd: true)
        XCTAssertEqual(replaced.calls.count, 50)
        XCTAssertFalse(replaced.reachedEnd)
    }

    func testAFullHeadWithNoRowInCommonReplacesTheListInsteadOfLeavingAGap() {
        // 后台期间来了 50 多通电话：首批与已加载的行没有交集，中间隔着未知数量的行，不能直接接上。
        let head = (1...50).map { call("n\($0)", stamp(-100 + $0)) }
        let feed = CallsScrollPolicy.afterHead(head, loaded: rows(1...120), reachedEnd: true)
        XCTAssertEqual(feed.calls.map(\.id), head.map(\.id))
        XCTAssertFalse(feed.reachedEnd, "到底标记清掉，往下滚动重新取回更早的行")

        // 只要有一行相同就仍然合并。
        let touching = Array(head.dropFirst()) + rows(1...1)
        XCTAssertEqual(
            CallsScrollPolicy.afterHead(touching, loaded: rows(1...120), reachedEnd: true).calls.count, 49 + 120
        )
    }

    func testHeadMergeComparesInstantsNotStringsAndDropsRowsItCannotPlace() {
        // 与首批末行同一时刻的已加载行保留（"不比它新"），哪怕一个写了毫秒一个没写。
        let head = rows(1...49) + [call("c50", "2026-09-12T00:00:00.000Z")]
        let tie = call("tie", "2026-09-12T00:00:00Z")
        let noTime = call("no-time", nil)
        let older = call("older", "2026-09-11T23:59:59.999Z")
        let feed = CallsScrollPolicy.afterHead(head, loaded: [noTime] + head + [tie, older], reachedEnd: false)
        XCTAssertEqual(feed.calls.map(\.id), head.map(\.id) + ["tie", "older"], "排在首批末行之前又读不出时间的行算作更新的，丢掉")

        // 首批末行没有时间：没有可比的界线，首批就是列表（也取不出游标）。
        let unplaced = CallsScrollPolicy.afterHead(rows(1...49) + [noTime], loaded: rows(1...120), reachedEnd: false)
        XCTAssertEqual(unplaced.calls.count, 50)
        XCTAssertFalse(unplaced.reachedEnd)
    }

    func testNextChunkAppendsWithoutDuplicatesAndAShortChunkEndsTheList() {
        let full = CallsScrollPolicy.afterChunk(rows(50...99), loaded: rows(1...50))
        XCTAssertEqual(full.calls.map(\.id), rows(1...99).map(\.id), "第 50 行两边都有，只留一份")
        XCTAssertFalse(full.reachedEnd)
        let short = CallsScrollPolicy.afterChunk(rows(100...120), loaded: full.calls)
        XCTAssertEqual(short.calls.count, 120)
        XCTAssertTrue(short.reachedEnd, "不足 50 行就是末尾，不再请求")
        XCTAssertTrue(CallsScrollPolicy.afterChunk([], loaded: rows(1...50)).reachedEnd)

        // 首批刷新与下一批赛跑，无论谁先到，结果一样、不丢不重。
        let head = [call("new", stamp(0))] + rows(1...49)
        let headFirst = CallsScrollPolicy.afterChunk(
            rows(51...100), loaded: CallsScrollPolicy.afterHead(head, loaded: rows(1...50), reachedEnd: false).calls
        )
        let chunkFirst = CallsScrollPolicy.afterHead(
            head, loaded: CallsScrollPolicy.afterChunk(rows(51...100), loaded: rows(1...50)).calls, reachedEnd: false
        )
        XCTAssertEqual(headFirst.calls.map(\.id), ["new"] + rows(1...100).map(\.id))
        XCTAssertEqual(chunkFirst.calls.map(\.id), headFirst.calls.map(\.id))
    }

    func testOnlyARowNearTheEndAsksForTheNextChunk() {
        let loaded = rows(1...50)
        XCTAssertEqual(CallsScrollPolicy.chunk, 50)
        XCTAssertTrue(CallsScrollPolicy.isNearEnd("c50", in: loaded))
        XCTAssertTrue(CallsScrollPolicy.isNearEnd("c41", in: loaded))
        XCTAssertFalse(CallsScrollPolicy.isNearEnd("c40", in: loaded))
        XCTAssertFalse(CallsScrollPolicy.isNearEnd("c1", in: loaded))
        XCTAssertFalse(CallsScrollPolicy.isNearEnd("gone", in: loaded))
    }

    func testReportQueryPagesTheCalendarWindowFiftyRowsAtATime() {
        let next = query(RecordSearchPolicy.reportQuery(
            from: "2026-09-05", to: "2026-09-11", timeZone: "Asia/Shanghai", query: "  保险 ",
            page: 3, simId: "sim-2"
        ))
        XCTAssertEqual(next, [
            "timeZone": "Asia/Shanghai", "from": "2026-09-05", "to": "2026-09-11",
            "page": "3", "pageSize": "50", "query": "保险", "simId": "sim-2",
        ])
        XCTAssertNil(next["limit"], "page 与 limit 会给出两个互相矛盾的窗口")
        XCTAssertNil(next["period"], "S22 起只发显式日历窗口")

        // 首批就是第 1 页；没有搜索词和线路时不带这两个参数。
        let head = query(RecordSearchPolicy.reportQuery(
            from: "2026-09-05", to: "2026-09-11", timeZone: "Asia/Shanghai", query: "", page: 1
        ))
        XCTAssertEqual(head, [
            "timeZone": "Asia/Shanghai", "from": "2026-09-05", "to": "2026-09-11", "page": "1", "pageSize": "50",
        ])
    }

    func testInterceptionsQueryIsOnlyThePageAtFiftyRows() {
        XCTAssertEqual(query(RecordSearchPolicy.interceptionsQuery(page: 1)), ["page": "1", "pageSize": "50"])
        XCTAssertEqual(
            query(RecordSearchPolicy.interceptionsQuery(page: RecordsScrollPolicy.nextPage(loadedCount: 150))),
            ["page": "4", "pageSize": "50"]
        )
    }

    private func query(_ items: [URLQueryItem]) -> [String: String] {
        Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
    }

    /// Row `n` started `n` seconds before a fixed instant, so a higher number is an older call.
    private func stamp(_ n: Int) -> String {
        ISO8601DateFormatter.string(
            from: Date(timeIntervalSince1970: 1_790_000_000 - Double(n)), timeZone: .gmt,
            formatOptions: [.withInternetDateTime, .withFractionalSeconds]
        )
    }

    private func rows(_ range: ClosedRange<Int>) -> [CallRecord] {
        range.map { call("c\($0)", stamp($0)) }
    }

    private func call(_ id: String, _ startedAt: String?) -> CallRecord {
        let time = startedAt.map { "\"\($0)\"" } ?? "null"
        return try! JSONDecoder().decode(CallRecord.self, from: Data(#"{"id":"\#(id)","startedAt":\#(time)}"#.utf8))
    }
}
