package org.vodog.gateway.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

class DownlinkLevelerTest {
    private val n = 320

    /** Sine at [rmsDbfs] RMS, 440 Hz, continuous phase across frames. */
    private fun sineFrames(rmsDbfs: Double, count: Int): List<ByteArray> {
        val amp = 32768.0 * Math.pow(10.0, rmsDbfs / 20) * sqrt(2.0)
        var t = 0
        return List(count) { frame(IntArray(n) { (amp * sin(2 * PI * 440 * t++ / 16_000)).roundToInt().coerceIn(-32768, 32767) }) }
    }

    private fun frame(s: IntArray) = ByteArray(s.size * 2).also { b ->
        s.forEachIndexed { i, v -> b[2 * i] = v.toByte(); b[2 * i + 1] = (v shr 8).toByte() }
    }

    private fun samples(b: ByteArray) = IntArray(b.size / 2) { (b[2 * it].toInt() and 0xff) or (b[2 * it + 1].toInt() shl 8) }

    private fun rmsDbfs(b: ByteArray): Double {
        val s = samples(b)
        return 20 * log10(sqrt(s.sumOf { it.toDouble() * it } / s.size) / 32768.0)
    }

    private fun adaptive() = DownlinkLeveler().apply { adaptive = true }

    @Test
    fun quietSpeechConvergesToTarget() {
        val l = adaptive()
        val frames = sineFrames(-30.0, 200) // 4 s
        frames.forEach(l::process)
        val tail = frames.takeLast(50).map(::rmsDbfs).average() // after 3 s
        assertEquals(-20.0, tail, 1.5)
    }

    @Test
    fun veryQuietSpeechNeedsLevelTrackingToConverge() {
        // -36 dBFS + the fixed +9 dB start lands at -27: only the adaptive path can reach the target.
        val l = adaptive()
        val frames = sineFrames(-36.0, 300) // 6 s
        frames.forEach(l::process)
        val tail = rmsDbfs(frames.last())
        assertEquals(-20.0, tail, 1.5)
        assertTrue(l.currentGainDb <= DownlinkLeveler.MAX_GAIN_DB)
    }

    @Test
    fun fullScaleNeverExceedsCeiling() {
        val l = adaptive()
        val frames = sineFrames(-3.0, 100) + listOf(frame(IntArray(n) { if (it % 2 == 0) 32767 else -32768 }))
        frames.forEach(l::process)
        frames.forEach { f -> samples(f).forEach { assertTrue("sample $it", abs(it) <= 29204) } }
        assertTrue((l.snapshot()["limiterFrames"] as Long) > 0)
    }

    @Test
    fun noiseBelowThresholdKeepsGain() {
        val l = adaptive()
        val rnd = Random(1)
        repeat(100) { l.process(frame(IntArray(n) { rnd.nextInt(-20, 21) })) } // ~ -67 dBFS
        assertEquals(DownlinkLeveler.INITIAL_GAIN_DB, l.currentGainDb, 0.0)
        assertEquals(0L, l.snapshot()["activeFrames"])
    }

    @Test
    fun zeroFrameStaysBitExactAndKeepsGain() {
        val l = adaptive()
        sineFrames(-30.0, 10).forEach(l::process)
        val before = l.currentGainDb
        val z = ByteArray(640)
        l.process(z)
        assertTrue(z.all { it == 0.toByte() })
        assertEquals(before, l.currentGainDb, 0.0)
        assertEquals(1L, l.snapshot()["zeroFrames"])
    }

    @Test
    fun nonAdaptiveHoldsInitialGain() {
        val l = DownlinkLeveler()
        val frames = sineFrames(-30.0, 100)
        frames.forEach(l::process)
        assertEquals(9.0, l.currentGainDb, 0.01)
        assertEquals(-21.0, rmsDbfs(frames.last()), 0.1)
    }

    @Test
    fun gainRampHasNoSteps() {
        // Constant input above target: gain falls 0.24 dB/frame; out/in is the per-sample gain.
        val l = adaptive()
        val frames = List(20) { frame(IntArray(n) { 10_000 }) }
        frames.forEach(l::process)
        val out = frames.flatMap { samples(it).toList() }
        val maxStepPerSample = 10_000 * (DownlinkLeveler.dbToLin(9.0) - DownlinkLeveler.dbToLin(9.0 - 0.24)) / n
        for (i in 1 until out.size) assertTrue("step at $i", abs(out[i] - out[i - 1]) <= maxStepPerSample + 1)
        assertTrue(out.last() < out.first())
    }

    @Test
    fun snapshotHasAllKeys() {
        val l = adaptive()
        sineFrames(-30.0, 5).forEach(l::process)
        l.process(ByteArray(640))
        val snap = l.snapshot()
        assertEquals(setOf("frames", "activeFrames", "zeroFrames", "inRmsP50Dbfs", "inRmsP95Dbfs", "inPeakDbfs",
            "outRmsP50Dbfs", "outRmsP95Dbfs", "gainDbLast", "gainDbMin", "gainDbMax", "limiterFrames"), snap.keys)
        assertEquals(6L, snap["frames"]); assertEquals(5L, snap["activeFrames"])
        assertTrue(snap.values.none { it == null })
    }
}
