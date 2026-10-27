package org.vodog

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 记录页滚动加载的纯规则。UI 和 ViewModel 只是把这些结论接上去，所以判断都定在这里。 */
class RecordsPagingPolicyTest {
    private fun ids(numbers: IntProgression) = numbers.map { "row-%03d".format(it) }

    private fun merge(loaded: List<String>, head: List<String>) = RecordsPagingPolicy.mergeHead(loaded, head) { it }

    /** 报告 / 拦截记录一段 50 条，和「全部通话」的一段一样长（请求里的 `pageSize` 只有这一个值）。 */
    @Test fun theChunkIsFiftyRowsOnEveryList() {
        assertEquals(50, RecordsPagingPolicy.CHUNK)
        assertEquals(ClientApiRoutes.CALLS_CHUNK, RecordsPagingPolicy.CHUNK)
    }

    /**
     * 下一段的页码从已经滚出来的行数算：本地删掉一行（49）之后重读同一页、和已有的行重叠，而不是
     * 跳过一行；并进一条新行（120）也只是重叠，不会越过去。
     */
    @Test fun theNextPageIsDerivedFromTheRowsAlreadyLoaded() {
        assertEquals(2, RecordsPagingPolicy.nextPage(50))
        assertEquals(1, RecordsPagingPolicy.nextPage(49))
        assertEquals(3, RecordsPagingPolicy.nextPage(100))
        assertEquals(3, RecordsPagingPolicy.nextPage(120))
        assertEquals(1, RecordsPagingPolicy.nextPage(0))
    }

    @Test fun aNewRowOnTopKeepsTheScrolledTail() {
        assertEquals(ids(121 downTo 1), merge(ids(120 downTo 1), ids(121 downTo 72)))
        // 什么都没变的一次轮询是恒等的。
        assertEquals(ids(120 downTo 1), merge(ids(120 downTo 1), ids(120 downTo 71)))
    }

    /** 最深的那一行重合行以上、却不在最新一段里的行，是在别处被删掉了。 */
    @Test fun aRowDeletedInsideTheHeadWindowDisappearsFromTheMerge() {
        val head = ids(120 downTo 70) - "row-100"
        assertEquals(50, head.size)
        assertEquals(ids(120 downTo 1) - "row-100", merge(ids(120 downTo 1), head))
    }

    /** 不足一段就是整份列表：原来滚出来的行不管有多少都整份换掉。 */
    @Test fun aShortHeadReplacesTheLoadedRows() {
        assertEquals(ids(9 downTo 1), merge(ids(120 downTo 1), ids(9 downTo 1)))
        assertTrue(merge(ids(120 downTo 1), emptyList()).isEmpty())
        assertEquals(ids(50 downTo 1), merge(emptyList(), ids(50 downTo 1)))
    }

    /** 一行都不重合：中间隔着不知道多少行，接上去会留一个洞，所以整份替换。 */
    @Test fun aHeadWithNoSharedRowReplacesTheLoadedRows() {
        assertEquals(ids(300 downTo 251), merge(ids(120 downTo 1), ids(300 downTo 251)))
    }

    /** 重复的 id 会让 LazyColumn 崩：合并和追加的结果里每个 id 只出现一次。 */
    @Test fun mergedAndAppendedRowsNeverRepeatAnId() {
        val merged = merge(ids(120 downTo 1) + ids(60 downTo 40), ids(121 downTo 72) + ids(80 downTo 75))
        assertEquals(merged.distinct(), merged)
        assertEquals(ids(121 downTo 1), merged)

        val loaded = Page(ids(100 downTo 51), page = 1, pageSize = 50, total = 100, totalPages = 2)
        val more = Page(ids(52 downTo 3), page = 2, pageSize = 50, total = 101, totalPages = 3)
        val appended = RecordsPagingPolicy.appendPage(loaded, more) { it }
        assertEquals(ids(100 downTo 3), appended.items)
        // 总数以最新读回来的那一段为准。
        assertEquals(101, appended.total)
    }

    /** 信封版：总数跟最新一段走；旧 Control 的整份结果（哪怕有 300 行）直接替换，不走合并。 */
    @Test fun theHeadEnvelopeWinsAndAnUnpagedControlAlwaysReplaces() {
        val loaded = Page(ids(120 downTo 1), page = 1, pageSize = 50, total = 120, totalPages = 3)
        val head = Page(ids(121 downTo 72), page = 1, pageSize = 50, total = 121, totalPages = 3)
        val merged = RecordsPagingPolicy.mergeHeadPage(loaded, head) { it }
        assertEquals(ids(121 downTo 1), merged.items)
        assertEquals(121, merged.total)

        val legacy = Page.unpaged(ids(300 downTo 100))
        assertEquals(legacy, RecordsPagingPolicy.mergeHeadPage(loaded, legacy) { it })
        assertEquals(head, RecordsPagingPolicy.mergeHeadPage(null, head) { it })
    }

    /** 到没到底只在结果落地时算：行数够了总数、不足一段、空的一段，或者旧 Control（整份就是全部）。 */
    @Test fun theEndIsReachedWhenTheRowsCoverTheTotalOrAChunkComesBackEmpty() {
        val full = Page(ids(50 downTo 1), page = 1, pageSize = 50, total = 120, totalPages = 3)
        assertFalse(RecordsPagingPolicy.endAfterHead(full, mergedSize = 50))
        assertFalse(RecordsPagingPolicy.endAfterHead(full, mergedSize = 119))
        assertTrue(RecordsPagingPolicy.endAfterHead(full, mergedSize = 120))
        assertTrue(RecordsPagingPolicy.endAfterHead(full.copy(items = ids(9 downTo 1), total = 9), mergedSize = 9))
        assertTrue(RecordsPagingPolicy.endAfterHead(Page.unpaged(ids(300 downTo 1)), mergedSize = 300))

        assertFalse(RecordsPagingPolicy.endAfterMore(full, appendedSize = 100))
        assertTrue(RecordsPagingPolicy.endAfterMore(full, appendedSize = 120))
        // 总数说还有、这一段却是空的（别处删了行）：到底了，不再往下读。
        assertTrue(RecordsPagingPolicy.endAfterMore(full.copy(items = emptyList()), appendedSize = 100))
    }

    // ---- 「全部通话」的游标合并 --------------------------------------------------------------

    /** 编号越大越新；`100 downTo 51` 就是服务端 `started_at DESC, id DESC` 的一段。 */
    private fun rows(numbers: IntProgression) = numbers.map {
        JSONObject().put("id", "call-%03d".format(it)).put("startedAt", "2026-09-12T01:%02d:%02d.000Z".format(it / 60, it % 60))
    }

    private fun List<JSONObject>.ids() = map { it.getString("id") }

    @Test fun aNewCallLandsOnTopAndTheScrolledTailStays() {
        val merged = RecordsPagingPolicy.mergeCallsHead(rows(120 downTo 1), rows(121 downTo 72))
        assertEquals(rows(121 downTo 1).ids(), merged.ids())
        // 什么都没变的一次轮询是恒等的。
        assertEquals(rows(120 downTo 1).ids(), RecordsPagingPolicy.mergeCallsHead(rows(120 downTo 1), rows(120 downTo 71)).ids())
    }

    /** 比最新一段的最后一行新、却不在这一段里的行，是在别处被删掉了。 */
    @Test fun aRowDeletedInsideTheHeadWindowDisappears() {
        val head = rows(120 downTo 70).filterNot { it.getString("id") == "call-100" }
        assertEquals(50, head.size)

        val merged = RecordsPagingPolicy.mergeCallsHead(rows(120 downTo 1), head)

        assertFalse("call-100" in merged.ids())
        assertEquals((rows(120 downTo 1).ids() - "call-100"), merged.ids())
    }

    /** `startedAt` 相同的并列行按 id 决胜，和服务端的 `(started_at, id) <` 一个口径。 */
    @Test fun tiesOnStartedAtAreBrokenById() {
        val same = "2026-09-12T00:00:00.000Z"
        fun tie(id: String) = JSONObject().put("id", id).put("startedAt", same)
        // 最后一行是 tie-b：tie-a 排在它后面（保留），tie-c 排在它前面却不在这一段里（已删）。
        val head = rows(200 downTo 152) + tie("tie-b")
        val merged = RecordsPagingPolicy.mergeCallsHead(rows(200 downTo 152) + listOf(tie("tie-c"), tie("tie-b"), tie("tie-a")), head)
        assertEquals(head.ids() + "tie-a", merged.ids())
        // 毫秒写法不一样（`.000Z` 对 `Z`）也按时刻比，不按字符串比。
        val older = JSONObject().put("id", "zzz").put("startedAt", "2026-09-11T23:59:59Z")
        assertEquals(head.ids() + "zzz", RecordsPagingPolicy.mergeCallsHead(head + older, head).ids())
    }

    /** 不足 50 条的一段就是整份列表：原来滚出来的行不管有多少都整份换掉。 */
    @Test fun aShortHeadReplacesEverything() {
        assertEquals(rows(9 downTo 1).ids(), RecordsPagingPolicy.mergeCallsHead(rows(120 downTo 1), rows(9 downTo 1)).ids())
        assertTrue(RecordsPagingPolicy.mergeCallsHead(rows(120 downTo 1), emptyList()).isEmpty())
        // 第一次加载（屏幕上还没有行）就是这一段本身。
        assertEquals(rows(50 downTo 1).ids(), RecordsPagingPolicy.mergeCallsHead(emptyList(), rows(50 downTo 1)).ids())
    }

    /** 和已加载的行一行都不重合：中间隔着没读到的行，接上去会留一个洞，所以整份替换。 */
    @Test fun aHeadThatDoesNotOverlapTheLoadedRowsReplacesThem() {
        assertEquals(rows(300 downTo 251).ids(), RecordsPagingPolicy.mergeCallsHead(rows(120 downTo 1), rows(300 downTo 251)).ids())
    }

    /** 重复的 id 会让 LazyColumn 崩：合并和追加的结果里每个 id 只出现一次。 */
    @Test fun duplicateIdsNeverAppear() {
        val loaded = rows(120 downTo 1) + rows(60 downTo 40)
        val merged = RecordsPagingPolicy.mergeCallsHead(loaded, rows(121 downTo 72) + rows(80 downTo 75))
        assertEquals(merged.ids().distinct(), merged.ids())
        assertEquals(rows(121 downTo 1).ids(), merged.ids())

        // 下一段和已加载的行重叠（两次读之间来了新通话，窗口往下挪了）也只留一份。
        val appended = RecordsPagingPolicy.appendCalls(rows(100 downTo 51), rows(52 downTo 3))
        assertEquals(rows(100 downTo 3).ids(), appended.ids())
    }

    @Test fun unpagedEnvelopeKeepsTheRequestedPageSizeAndOnePage() {
        val page = Page.unpaged(listOf("a", "b"), pageSize = 200)
        assertEquals(1, page.page)
        assertEquals(200, page.pageSize)
        assertEquals(2, page.total)
        assertEquals(1, page.totalPages)
        assertFalse(page.supported)
    }

    @Test fun envelopeIsReadFromTheResponseAndDegradesWithoutTotalPages() {
        val paged = readPageEnvelope(
            JSONObject()
                .put("items", JSONArray())
                .put("page", 3)
                .put("pageSize", 100)
                .put("total", 640)
                .put("totalPages", 7),
            listOf("row"),
            requestedPageSize = 100,
        )
        assertEquals(Page(listOf("row"), page = 3, pageSize = 100, total = 640, totalPages = 7), paged)
        assertTrue(paged.supported)

        val legacy = readPageEnvelope(JSONObject().put("items", JSONArray()), listOf("row"), requestedPageSize = 50)
        assertEquals(Page.unpaged(listOf("row"), pageSize = 50), legacy)
        assertFalse(legacy.supported)
    }
}
