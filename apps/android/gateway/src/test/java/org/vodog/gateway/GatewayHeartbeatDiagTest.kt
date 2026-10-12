package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayHeartbeatDiagTest {
    @Test fun `S69 heartbeat failure is logged on 1 3 10 then every 10`() {
        val logged = (1..45).filter(::heartbeatFailureLogged)
        assertEquals(listOf(1, 3, 10, 20, 30, 40), logged)
        assertFalse(heartbeatFailureLogged(0))
    }

    @Test fun `S69 heartbeat summary carries slowCount and maxGapMs and resets per window`() {
        val window = HeartbeatRttWindow(windowMs = 1_000L)
        assertNull(window.due(0L))
        window.sample(100L, slow = false, gapMs = 2_000L)
        window.sample(2_000L, slow = true, gapMs = 9_000L)
        window.sample(300L, slow = false, gapMs = null)
        val fields = window.due(1_000L)!!
        assertEquals(3L, fields["count"])
        assertEquals(1L, fields["slowCount"])
        assertEquals(9_000L, fields["maxGapMs"])
        window.sample(50L)
        val next = window.due(2_000L)!!
        assertEquals(0L, next["slowCount"])
        assertEquals(0L, next["maxGapMs"])
        assertTrue(next["maxMs"] == 50L)
        assertEquals(50L, next["p50Ms"])
        assertEquals(50L, next["p95Ms"])
    }

    @Test fun `heartbeat summary carries nearest-rank p50 and p95 per window`() {
        val window = HeartbeatRttWindow(windowMs = 1_000L)
        assertNull(window.due(0L))
        (1..100).shuffled(java.util.Random(7)).forEach { window.sample(it * 10L) }
        val fields = window.due(1_000L)!!
        assertEquals(500L, fields["p50Ms"])
        assertEquals(950L, fields["p95Ms"])
        assertEquals(1_000L, fields["maxMs"])
        // A new window starts empty: one slow outlier is its own p50 and p95.
        window.sample(4_000L)
        val next = window.due(2_000L)!!
        assertEquals(4_000L, next["p50Ms"])
        assertEquals(4_000L, next["p95Ms"])
    }
}
