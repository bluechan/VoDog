package org.vodog.gateway.media

/**
 * One media setup's stage timings, emitted once as the `media.setup` diag row. Stages are written from
 * several threads (the setup coroutine, WebRTC observer callbacks, the factory prewarm), so every access
 * is synchronized. A later negotiation attempt overwrites an earlier one's value for the same key, so a
 * finished row describes the attempt that opened the leg. Values are durations, counts and bounded
 * words only - never an address, a phone number or a credential.
 */
internal class MediaSetupTimeline(private val clockMs: () -> Long) {
    private val values = LinkedHashMap<String, Any?>()
    private val startedAtMs = clockMs()

    fun put(key: String, value: Any?) {
        synchronized(values) { values[key] = value }
    }

    /** [key] = [toMs] - [fromMs], never negative; a [fromMs] of 0 means the stage never started. */
    fun span(key: String, fromMs: Long, toMs: Long = clockMs()) {
        if (fromMs > 0L) put(key, (toMs - fromMs).coerceAtLeast(0L))
    }

    /** A snapshot of every stage so far plus `totalMs` since construction. */
    fun fields(): Map<String, Any?> {
        val snapshot = synchronized(values) { LinkedHashMap(values) }
        snapshot["totalMs"] = (clockMs() - startedAtMs).coerceAtLeast(0L)
        return snapshot
    }
}
