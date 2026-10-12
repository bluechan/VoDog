package org.vodog.gateway.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class MediaSetupTimelineTest {
    @Test fun `spans and values build the row and totalMs runs from construction`() {
        var clock = 1_000L
        val timeline = MediaSetupTimeline { clock }
        clock = 1_350L
        timeline.span("optionsMs", 1_000L)
        timeline.span("settleMs", 1_200L, 1_150L) // a stamp that raced its anchor is never negative
        timeline.put("transport", "tls")
        clock = 3_100L
        val fields = timeline.fields()
        assertEquals(350L, fields["optionsMs"])
        assertEquals(0L, fields["settleMs"])
        assertEquals("tls", fields["transport"])
        assertEquals(2_100L, fields["totalMs"])
        assertEquals(listOf("optionsMs", "settleMs", "transport", "totalMs"), fields.keys.toList())
    }

    @Test fun `a stage that never started is left out and a later attempt overwrites an earlier one`() {
        var clock = 10L
        val timeline = MediaSetupTimeline { clock }
        timeline.span("firstRelayMs", 0L)
        assertFalse("firstRelayMs" in timeline.fields())
        clock = 500L
        timeline.span("optionsMs", 100L) // the attempt that fell back
        clock = 900L
        timeline.span("optionsMs", 800L) // the attempt that opened the leg
        assertEquals(100L, timeline.fields()["optionsMs"])
    }

    @Test fun `fields is a snapshot that later writes do not change`() {
        val timeline = MediaSetupTimeline { 0L }
        timeline.put("a", 1)
        val snapshot = timeline.fields()
        timeline.put("a", 2)
        timeline.put("b", 3)
        assertEquals(1, snapshot["a"])
        assertFalse("b" in snapshot)
    }

    @Test fun `writers on several threads never lose a stage`() {
        val timeline = MediaSetupTimeline { System.nanoTime() / 1_000_000 }
        val pool = Executors.newFixedThreadPool(4)
        val start = CountDownLatch(1)
        try {
            repeat(4) { thread ->
                pool.execute {
                    start.await()
                    repeat(250) { timeline.put("t$thread-$it", it) }
                }
            }
            start.countDown()
            pool.shutdown()
            assertTrue(pool.awaitTermination(5, TimeUnit.SECONDS))
            assertEquals(1_001, timeline.fields().size)
        } finally {
            pool.shutdownNow()
        }
    }
}
