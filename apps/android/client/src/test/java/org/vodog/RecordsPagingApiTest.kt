package org.vodog

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

/**
 * S28 记录分页的读法与落地。分页请求只准写自己的那份 state —— 拨号页轮询的 [ClientUiState.calls]
 * 喂运行时对账和占用释放，被第 3 页的 50 条覆盖会让「谁在通话中」整个错位。
 */
class RecordsPagingApiTest {
    private val range = ReportDateRange(LocalDate.of(2026, 9, 6), LocalDate.of(2026, 9, 12))

    private fun callRow(id: String) = JSONObject().put("id", id).put("simId", "sim-1")

    /** 编号越大越新；传 `100 downTo 51` 就是服务端 `started_at DESC` 的一段。 */
    private fun callRows(numbers: IntProgression) = numbers.map {
        callRow("call-%03d".format(it)).put("startedAt", "2026-09-12T01:%02d:%02d.000Z".format(it / 60, it % 60))
    }

    /** 「全部通话」是游标读法：一次调用一条请求，回来的就是 `{items}` 里的行，没有信封。 */
    @Test fun callsPageAsksForExactlyOneCursorRequestAndReadsTheRows() {
        val requests = mutableListOf<ClientRequest>()
        val api = ClientApi(transport = ClientTransport { request ->
            requests += request
            JSONObject().put("items", JSONArray().put(callRow("call-1")).put(callRow("call-2")))
        })

        val head = api.callsPage(query = " 张三 ", simId = "sim-1")
        api.callsPage(query = " 张三 ", simId = "sim-1", before = "2026-09-12T01:02:03.456Z", beforeId = "call-2")

        assertEquals(2, requests.size)
        assertTrue(requests.all { it.method == "GET" })
        assertEquals("/calls?limit=50&includeBlocked=true&simId=sim-1&query=%E5%BC%A0%E4%B8%89", requests[0].path)
        assertEquals(
            "/calls?limit=50&includeBlocked=true&simId=sim-1&query=%E5%BC%A0%E4%B8%89" +
                "&before=2026-09-12T01%3A02%3A03.456Z&beforeId=call-2",
            requests[1].path,
        )
        assertEquals(listOf("call-1", "call-2"), head.map { it.getString("id") })
    }

    /** 没有总数，「到底了」只看条数：不足 50 条的一段就是末尾，之后不再往下读。 */
    @Test fun aChunkShorterThanFiftyRowsIsTheEndOfTheList() {
        val shortHead = clientStateWithCallsPage(ClientUiState(), RemoteResource.Loaded(listOf(callRow("call-1"))))
        assertTrue(shortHead.callsEndReached)

        val fullHead = clientStateWithCallsPage(ClientUiState(), RemoteResource.Loaded(callRows(100 downTo 51)))
        assertFalse(fullHead.callsEndReached)

        val more = clientStateWithMoreCalls(fullHead.copy(callsLoadingMore = true), "call-051", callRows(50 downTo 1))
        assertEquals(100, (more.callsPage as RemoteResource.Loaded).value.size)
        assertFalse(more.callsEndReached)
        assertFalse(more.callsLoadingMore)

        // 正好 50 的倍数：再读一段是空的，这才知道到底了。
        val end = clientStateWithMoreCalls(more.copy(callsLoadingMore = true), "call-001", emptyList())
        assertEquals(100, (end.callsPage as RemoteResource.Loaded).value.size)
        assertTrue(end.callsEndReached)
        assertFalse(end.callsLoadingMore)
    }

    @Test fun interceptionsPageReadsTheSameEnvelope() {
        val requests = mutableListOf<ClientRequest>()
        val api = ClientApi(transport = ClientTransport { request ->
            requests += request
            JSONObject()
                .put("items", JSONArray().put(JSONObject().put("id", "int-1")))
                .put("page", 2)
                .put("pageSize", 50)
                .put("total", 51)
                .put("totalPages", 2)
        })

        val page = api.interceptionsPage(page = 2)

        assertEquals("/blocklist/interceptions?page=2&pageSize=50", requests.single().path)
        assertEquals(2, page.page)
        assertEquals(51, page.total)
        assertTrue(page.supported)
    }

    /** 报告的信封是叠加的：`window` 和 `items` 都还在，一个解码器同时服务两条路由。 */
    @Test fun reportsPageKeepsTheWindowBesideTheEnvelope() {
        val requests = mutableListOf<ClientRequest>()
        val api = ClientApi(transport = ClientTransport { request ->
            requests += request
            JSONObject()
                .put(
                    "window",
                    JSONObject()
                        .put("timeZone", "Asia/Shanghai")
                        .put("fromInclusive", "2026-09-06T00:00:00.000Z")
                        .put("toExclusive", "2026-09-13T00:00:00.000Z"),
                )
                .put("page", 2)
                .put("pageSize", 50)
                .put("total", 300)
                .put("totalPages", 2)
                .put(
                    "items",
                    JSONArray().put(
                        JSONObject()
                            .put("callId", "call-1")
                            .put("startedAt", "2026-09-12T01:00:00.000Z")
                            .put("direction", "incoming")
                            .put("remoteNumber", "+8613800000000")
                            .put("sim", JSONObject().put("id", "sim-1").put("label", "北京号").put("slotIndex", 0)),
                    ),
                )
        })

        val report = api.reportsPage(range, "Asia/Shanghai", query = "", simId = "sim-1", page = 2)

        assertEquals(
            "/reports/calls?timeZone=Asia%2FShanghai&from=2026-09-06&to=2026-09-12&page=2&pageSize=50&simId=sim-1",
            requests.single().path,
        )
        assertEquals("Asia/Shanghai", report.window.timeZone)
        assertEquals(listOf("call-1"), report.items.map { it.callId })
        assertEquals(2, report.paging.page)
        assertEquals(300, report.paging.total)
        assertTrue(report.paging.supported)
    }

    /** 不带 `page` 的老读法一个字都没变，信封缺席就退回 [Page.unpaged]。 */
    @Test fun theLegacyReportRouteStillDecodesAsASinglePage() {
        val api = ClientApi(transport = ClientTransport {
            JSONObject()
                .put(
                    "window",
                    JSONObject()
                        .put("period", "7d")
                        .put("timeZone", "Asia/Shanghai")
                        .put("fromInclusive", "2026-09-06T00:00:00.000Z")
                        .put("toExclusive", "2026-09-13T00:00:00.000Z"),
                )
                .put("items", JSONArray())
        })

        val report = api.reports(range, "Asia/Shanghai")

        assertFalse(report.paging.supported)
        assertEquals(1, report.paging.totalPages)
        assertTrue(report.items.isEmpty())
    }

    @Test fun landingAPagedResultNeverTouchesThePolledCallList() {
        val polled = RemoteList.Loaded(listOf(callRow("polled-1")))
        val before = ClientUiState(calls = polled, callsPageRefreshing = true, callsLoadingMore = true)

        val after = clientStateWithCallsPage(before, RemoteResource.Loaded(listOf(callRow("paged-1"))))

        assertSame(polled, after.calls)
        assertEquals(listOf("paged-1"), (after.callsPage as RemoteResource.Loaded).value.map { it.getString("id") })
        // 除了 callsPage / 到底标记 / 转圈位之外一个字段都没动。
        assertEquals(before.copy(callsPage = after.callsPage, callsEndReached = true, callsPageRefreshing = false), after)

        // 滚动加载的落地也一样。
        val more = clientStateWithMoreCalls(after, "paged-1", listOf(callRow("paged-2")))
        assertSame(polled, more.calls)
        assertEquals(after.copy(callsPage = more.callsPage, callsLoadingMore = false), more)
    }

    /** 失败时已经滚出来的行留在屏幕上，但转圈必须停 —— 否则它会一直转下去。 */
    @Test fun aFailedPageKeepsTheRowsThatAreAlreadyOnScreenAndStopsTheSpinner() {
        val loaded = RemoteResource.Loaded(callRows(120 downTo 1))
        val before = ClientUiState(callsPage = loaded, callsPageRefreshing = true)

        val after = clientStateWithCallsPage(before, RemoteResource.Failed("网络不给力"))

        assertSame(loaded, after.callsPage)
        assertFalse(after.callsPageRefreshing)

        // 下一段读失败：行一行不动，也不标「到底了」，再滚一下还能重试。
        val failedMore = clientStateWithMoreCalls(before.copy(callsLoadingMore = true), "call-001", null)
        assertSame(loaded, failedMore.callsPage)
        assertFalse(failedMore.callsLoadingMore)
        assertFalse(failedMore.callsEndReached)
    }

    /**
     * 游标过期的下一段不接上去：发请求之后列表被下拉刷新截回了前 50 行，这一段从第 101 行起，接上去
     * 中间会缺 50 行。丢掉它，转圈收掉，下一次滚动用新的最后一行重新读。
     */
    @Test fun aChunkWhoseCursorIsNoLongerTheLastRowIsDropped() {
        val truncated = RemoteResource.Loaded(callRows(150 downTo 101))
        val before = ClientUiState(callsPage = truncated, callsLoadingMore = true)

        val after = clientStateWithMoreCalls(before, "call-051", callRows(50 downTo 1))

        assertSame(truncated, after.callsPage)
        assertFalse(after.callsLoadingMore)
        assertFalse(after.callsEndReached)
        // 列表还没读回来（换了搜索词）时同样只收转圈。
        assertEquals(ClientUiState(), clientStateWithMoreCalls(ClientUiState(callsLoadingMore = true), "call-051", callRows(50 downTo 1)))
    }

    /** 轮询回来的最新一段是合并：滚到第 120 行的人还在第 120 行，到底的结论也跟着尾巴留着。 */
    @Test fun aHeadRefreshKeepsTheRowsAlreadyScrolledInAndTheirEndMark() {
        val before = ClientUiState(callsPage = RemoteResource.Loaded(callRows(120 downTo 1)), callsEndReached = true)

        val after = clientStateWithCallsPage(before, RemoteResource.Loaded(callRows(121 downTo 72)))

        assertEquals(callRows(121 downTo 1).map { it.getString("id") }, (after.callsPage as RemoteResource.Loaded).value.map { it.getString("id") })
        assertTrue(after.callsEndReached)
        // 接不上的一段（隔了 50 多通没读到）整份替换，「到底了」也得重新确认。
        val gap = clientStateWithCallsPage(before, RemoteResource.Loaded(callRows(300 downTo 251)))
        assertEquals(50, (gap.callsPage as RemoteResource.Loaded).value.size)
        assertFalse(gap.callsEndReached)
    }

    private fun interceptionRows(numbers: IntProgression) = numbers.map { JSONObject().put("id", "int-%03d".format(it)) }

    private fun interceptions(numbers: IntProgression, total: Int) =
        Page(interceptionRows(numbers), page = 1, pageSize = 50, total = total, totalPages = (total + 49) / 50)

    private fun reportItem(number: Int) = CallReportItem(
        callId = "call-%03d".format(number),
        startedAt = "2026-09-12T02:00:00Z",
        direction = "incoming",
        remoteNumber = "+8613800000000",
        sim = ReportSim("sim-1", "SIM", 0),
        summary = null,
        actionItems = emptyList(),
        advertisingClassification = "unknown",
        recordingStatus = "ready",
        callUrl = "",
        transcriptUrl = "",
        recordingUrl = "",
        transcriptCompletedAt = "",
    )

    private val window = ReportWindow(null, "Asia/Shanghai", "2026-09-06T00:00:00.000Z", "2026-09-13T00:00:00.000Z")

    private fun reports(numbers: IntProgression, total: Int) = CallReportPage(
        window,
        Page(numbers.map(::reportItem), page = 1, pageSize = 50, total = total, totalPages = (total + 49) / 50),
    )

    private fun ClientUiState.interceptionIds() =
        (interceptionsPage as RemoteResource.Loaded).value.items.map { it.getString("id") }

    private fun ClientUiState.reportIds() = (reports as RemoteResource.Loaded).value.items.map { it.callId }

    @Test fun interceptionsAndReportsLandOnTheirOwnFieldsOnly() {
        val interceptions = RemoteResource.Loaded(interceptions(150 downTo 101, total = 150))
        assertEquals(
            ClientUiState(interceptionsPage = interceptions),
            clientStateWithInterceptionsPage(ClientUiState(), interceptions),
        )
        val more = interceptions(100 downTo 51, total = 150)
        val afterMore = clientStateWithMoreInterceptions(
            ClientUiState(interceptionsPage = interceptions, interceptionsLoadingMore = true), "int-101", more,
        )
        assertEquals(ClientUiState(interceptionsPage = afterMore.interceptionsPage), afterMore)

        val reports = RemoteResource.Loaded(reports(400 downTo 351, total = 400))
        assertEquals(ClientUiState(reports = reports), clientStateWithReportsPage(ClientUiState(), reports))
        val afterMoreReports = clientStateWithMoreReports(
            ClientUiState(reports = reports, reportsLoadingMore = true), "call-351", reports(350 downTo 301, total = 400),
        )
        assertEquals(ClientUiState(reports = afterMoreReports.reports), afterMoreReports)
    }

    /** 滚到底一段一段接：行数够了总数才到底；轮询回来的最新一段并进去，尾巴和「到底了」都留着。 */
    @Test fun interceptionsAppendChunkByChunkAndAHeadRefreshKeepsTheTail() {
        val head = clientStateWithInterceptionsPage(ClientUiState(), RemoteResource.Loaded(interceptions(120 downTo 71, total = 120)))
        assertFalse(head.interceptionsEndReached)

        val second = clientStateWithMoreInterceptions(head.copy(interceptionsLoadingMore = true), "int-071", interceptions(70 downTo 21, total = 120))
        assertEquals(100, second.interceptionIds().size)
        assertFalse(second.interceptionsEndReached)
        assertFalse(second.interceptionsLoadingMore)

        val third = clientStateWithMoreInterceptions(second.copy(interceptionsLoadingMore = true), "int-021", interceptions(20 downTo 1, total = 120))
        assertEquals(120, third.interceptionIds().size)
        assertTrue(third.interceptionsEndReached)

        // 来了一条新的拦截：顶上多一行，滚到底的人还在底，也还是到底了。
        val polled = clientStateWithInterceptionsPage(third, RemoteResource.Loaded(interceptions(121 downTo 72, total = 121)))
        assertEquals(interceptionRows(121 downTo 1).map { it.getString("id") }, polled.interceptionIds())
        assertTrue(polled.interceptionsEndReached)

        // 最新一段读失败：行留着，什么都不变。
        assertEquals(polled, clientStateWithInterceptionsPage(polled, RemoteResource.Failed("网络不给力")))
    }

    /**
     * 不该接、接不上、或者白读的一段都只收掉转圈：请求失败；最后一行已经不是发请求时的那一行；一行新的
     * 都没带回来（总数说还有）。后一种不标「到底了」也不会循环 —— 行数没变，列表不会自己再读。
     */
    @Test fun aChunkThatFailsIsStaleOrAddsNothingOnlyStopsTheSpinner() {
        val loaded = RemoteResource.Loaded(interceptions(120 downTo 71, total = 120))
        val before = ClientUiState(interceptionsPage = loaded, interceptionsLoadingMore = true)

        val failed = clientStateWithMoreInterceptions(before, "int-071", null)
        assertSame(loaded, failed.interceptionsPage)
        assertFalse(failed.interceptionsLoadingMore)
        assertFalse(failed.interceptionsEndReached)

        val stale = clientStateWithMoreInterceptions(before, "int-021", interceptions(20 downTo 1, total = 120))
        assertSame(loaded, stale.interceptionsPage)
        assertFalse(stale.interceptionsLoadingMore)

        val nothingNew = clientStateWithMoreInterceptions(before, "int-071", interceptions(120 downTo 71, total = 120))
        assertEquals(50, nothingNew.interceptionIds().size)
        assertFalse(nothingNew.interceptionsLoadingMore)
        assertFalse(nothingNew.interceptionsEndReached)

        // 空的一段才是到底：总数说还有，但后面确实没有行了。
        val empty = clientStateWithMoreInterceptions(before, "int-071", interceptions(IntRange.EMPTY, total = 120))
        assertTrue(empty.interceptionsEndReached)
        assertEquals(ClientUiState(), clientStateWithMoreInterceptions(ClientUiState(interceptionsLoadingMore = true), "int-071", null))
    }

    /** 没有 `id` 的拦截行用 `occurredAt + remoteNumber` 当键（和列表的 key 一样），不会被去重成一行。 */
    @Test fun interceptionRowsWithoutAnIdAreKeyedByTimeAndNumber() {
        fun row(at: String) = JSONObject().put("occurredAt", at).put("remoteNumber", "+8613800000000")
        val first = Page(List(50) { row("t-$it") }, page = 1, pageSize = 50, total = 52, totalPages = 2)
        val state = clientStateWithInterceptionsPage(ClientUiState(), RemoteResource.Loaded(first))

        val after = clientStateWithMoreInterceptions(
            state, "t-49+8613800000000", first.copy(items = listOf(row("t-49"), row("t-50"), row("t-51"))),
        )

        assertEquals(52, (after.interceptionsPage as RemoteResource.Loaded).value.items.size)
        assertTrue(after.interceptionsEndReached)
    }

    /** 报告和拦截记录是同一套规则；多出来的只有下拉刷新的整份替换，以及旧 Control 的整份结果。 */
    @Test fun reportsMergeAppendAndResetToTheHead() {
        val scrolled = clientStateWithMoreReports(
            clientStateWithReportsPage(ClientUiState(), RemoteResource.Loaded(reports(120 downTo 71, total = 120))),
            "call-071",
            reports(70 downTo 21, total = 120),
        )
        assertEquals(100, scrolled.reportIds().size)
        assertFalse(scrolled.reportsEndReached)

        val head = RemoteResource.Loaded(reports(121 downTo 72, total = 121))
        val merged = clientStateWithReportsPage(scrolled, head)
        assertEquals((121 downTo 21).map { "call-%03d".format(it) }, merged.reportIds())
        assertEquals(121, (merged.reports as RemoteResource.Loaded).value.paging.total)
        assertFalse(merged.reportsEndReached)

        // 下拉刷新：完全回到最新的一段。
        val reset = clientStateWithReportsPage(scrolled, head, reset = true)
        assertEquals(50, reset.reportIds().size)
        assertFalse(reset.reportsEndReached)

        // 游标过期的下一段（列表刚被整份替换）不接上去。
        val stale = clientStateWithMoreReports(reset.copy(reportsLoadingMore = true), "call-021", reports(20 downTo 1, total = 121))
        assertEquals(50, stale.reportIds().size)
        assertFalse(stale.reportsLoadingMore)

        // 旧 Control 没有信封：回来的就是整份列表，替换并且到底了。
        val legacy = clientStateWithReportsPage(scrolled, RemoteResource.Loaded(CallReportPage(window, (300 downTo 100).map(::reportItem))))
        assertEquals(201, legacy.reportIds().size)
        assertTrue(legacy.reportsEndReached)

        // 失败时已经滚出来的行留着。
        assertEquals(scrolled, clientStateWithReportsPage(scrolled, RemoteResource.Failed("网络不给力")))
    }

}
