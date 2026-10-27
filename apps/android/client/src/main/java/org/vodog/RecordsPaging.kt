package org.vodog

import org.json.JSONObject
import java.time.Instant

/**
 * S28 记录分页信封。Control 给 `/calls`、`/reports/calls`、`/blocklist/interceptions` 三条列表加了
 * *可选* 的偏移分页：只有带上 `page` 的请求才会付一次 COUNT 并回 `{items,page,pageSize,total,
 * totalPages}`，不带 `page` 时整条路由与以前一字不差。拨号页每 2–5 秒轮询的 [ClientUiState.calls]
 * 一行都不会被这些请求改写。
 *
 * 记录页已经没有分页条：三条列表都是滚动加载。「全部通话」走游标（见
 * [RecordsPagingPolicy.mergeCallsHead]）；报告和拦截记录的路由只有偏移分页，所以仍然按 `page` 一段
 * 一段读，[items] 是已经滚出来的全部行，[total] 用来判断到没到底。
 *
 * [supported] 是「这台 Control 还没有 S28」的标记：旧服务忽略 `page`，回老的 `{items}`，信封里没有
 * `totalPages`，于是整份结果就是整份列表（到底了），页面退回旧行为而不是报错。
 */
data class Page<T>(
    val items: List<T>,
    val page: Int,
    val pageSize: Int,
    val total: Int,
    val totalPages: Int,
    val supported: Boolean = true,
) {
    companion object {
        /** 旧 Control 的 `{items}`：一页、总数就是这一页的条数。 */
        fun <T> unpaged(items: List<T>, pageSize: Int = RecordsPagingPolicy.CHUNK): Page<T> =
            Page(items, page = 1, pageSize = pageSize, total = items.size, totalPages = 1, supported = false)
    }
}

/**
 * 读信封。缺 `totalPages` 就是旧 Control（见 [Page.supported]）；其余字段缺失时退回请求时用的值。
 */
internal fun <T> readPageEnvelope(json: JSONObject, items: List<T>, requestedPageSize: Int): Page<T> {
    if (!json.has("totalPages") || json.isNull("totalPages")) return Page.unpaged(items, requestedPageSize)
    return Page(
        items = items,
        page = json.optInt("page", 1).coerceAtLeast(1),
        pageSize = json.optInt("pageSize", requestedPageSize).takeIf { it > 0 } ?: requestedPageSize,
        total = json.optInt("total", items.size).coerceAtLeast(0),
        totalPages = json.optInt("totalPages", 1).coerceAtLeast(1),
        supported = true,
    )
}

/**
 * 滚动加载的纯规则，没有任何 Compose / 网络依赖，所以每一条都能单测。
 */
object RecordsPagingPolicy {
    /** 报告 / 拦截记录一段的条数（请求里的 `pageSize`），和「全部通话」的一段一样长。 */
    const val CHUNK = ClientApiRoutes.CALLS_CHUNK

    /**
     * 下一段的页码，从已经滚出来的行数算，而不是自己记一个计数：本地删掉一行之后下一次请求会和已有
     * 的行重叠一行（去重掉），而不是跳过一行。
     */
    // ponytail: 偏移分页 —— 另一端在已加载的范围里删掉一行，下一段会整体上移、漏掉一行，要等整份重读
    // （报告下拉刷新 / 换条件；拦截记录没有下拉刷新，要等一次接不上的最新一段）才回来。Control 给这
    // 两条路由加上和 `/calls` 一样的 keyset 游标之后换掉这里。
    fun nextPage(loadedSize: Int): Int = loadedSize / CHUNK + 1

    /**
     * 轮询 / 推送 / 删除之后重读回来的最新一段 [head] 并进已经滚出来的 [loaded]，不依赖排序键：
     * 1. [head] 不足一段：它就是整份列表，替换；
     * 2. 和 [loaded] 一行都不重合：中间隔着不知道多少行，替换；
     * 3. 否则 = [head] + [loaded] 里排在「最深的那一行同时出现在 [head] 里的行」之后的行。那一行以上、
     *    却不在 [head] 里的行是在别处被删掉了。
     * 结果按 id 去重（重复的 key 会让 LazyColumn 直接崩）。
     */
    fun <T> mergeHead(loaded: List<T>, head: List<T>, idOf: (T) -> String): List<T> {
        val headIds = head.mapTo(HashSet(), idOf)
        val deepest = loaded.indexOfLast { idOf(it) in headIds }
        val tail = if (head.size < CHUNK || deepest < 0) emptyList() else loaded.drop(deepest + 1)
        return (head + tail).distinctBy(idOf)
    }

    /** [mergeHead] 的信封版：`total` 以最新一段为准；旧 Control 的整份结果（[Page.supported] 为 false）直接替换。 */
    fun <T> mergeHeadPage(loaded: Page<T>?, head: Page<T>, idOf: (T) -> String): Page<T> =
        if (loaded == null || !head.supported) head else head.copy(items = mergeHead(loaded.items, head.items, idOf))

    /** 滚到底读回来的下一段接在后面，按 id 去重；`total` 以这一段为准。 */
    fun <T> appendPage(loaded: Page<T>, more: Page<T>, idOf: (T) -> String): Page<T> =
        loaded.copy(items = (loaded.items + more.items).distinctBy(idOf), total = more.total)

    /** 最新一段落地之后到没到底：旧 Control、不足一段、或已经滚出来的行数够了总数。 */
    fun endAfterHead(head: Page<*>, mergedSize: Int): Boolean =
        !head.supported || head.items.size < CHUNK || mergedSize >= head.total

    /** 下一段落地之后到没到底：空的一段，或行数够了总数。 */
    fun endAfterMore(more: Page<*>, appendedSize: Int): Boolean = more.items.isEmpty() || appendedSize >= more.total

    // ---- 「全部通话」不翻页：游标 + 滚动加载。报告 / 拦截记录仍然用上面的页码规则。 ----

    /** 服务端的顺序是 `started_at DESC, id DESC`：[row] 是否排在 [anchor] 后面（更旧）。 */
    private fun isOlder(row: JSONObject, anchor: JSONObject): Boolean {
        val a = row.optString("startedAt")
        val b = anchor.optString("startedAt")
        val byTime = runCatching { Instant.parse(a).compareTo(Instant.parse(b)) }.getOrElse { a.compareTo(b) }
        return if (byTime != 0) byTime < 0 else row.optString("id") < anchor.optString("id")
    }

    /**
     * 轮询 / 推送重读回来的最新一段 [head] 并进已经滚出来的 [loaded]，滚到第 300 行的人不会被打回前
     * 50 行：结果 = [head] + [loaded] 里不在 [head] 中、且比 [head] 最后一行更旧的行。比它新却不在
     * [head] 里的行是在别处被删掉了。
     *
     * 两种情况整份换成 [head]：不足 [ClientApiRoutes.CALLS_CHUNK] 条（它就是整份列表）；以及和
     * [loaded] 一行都不重合（中间隔着没读到的行，接上去会留一个看不见的洞）。
     */
    fun mergeCallsHead(loaded: List<JSONObject>, head: List<JSONObject>): List<JSONObject> {
        val headIds = head.mapTo(HashSet()) { it.optString("id") }
        val last = head.lastOrNull()
        val tail = if (last == null || head.size < ClientApiRoutes.CALLS_CHUNK || loaded.none { it.optString("id") in headIds }) {
            emptyList()
        } else {
            loaded.filter { it.optString("id") !in headIds && isOlder(it, last) }
        }
        // 重复的 id 会让 LazyColumn 因为 key 相同直接崩，所以这里和 [appendCalls] 都去重。
        return (head + tail).distinctBy { it.optString("id") }
    }

    /** 滚到底读回来的下一段接在后面，按 id 去重。 */
    fun appendCalls(loaded: List<JSONObject>, more: List<JSONObject>): List<JSONObject> =
        (loaded + more).distinctBy { it.optString("id") }
}
