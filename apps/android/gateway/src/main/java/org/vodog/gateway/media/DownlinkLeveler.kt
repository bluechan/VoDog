package org.vodog.gateway.media

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * S126: slow digital AGC + peak limiter on the cellular downlink encode copy (never the
 * `remote_original` recording copy). PCM16LE mono, processed in place, one frame per call.
 *
 * ponytail: single band, no lookahead, no noise-floor estimate. If real calls pump or lift the noise
 * floor, replace with libwebrtc AGC2 via JNI.
 */
class DownlinkLeveler {
    companion object {
        const val TARGET_DBFS = -20.0
        const val INITIAL_GAIN_DB = 9.0
        const val MIN_GAIN_DB = 0.0
        const val MAX_GAIN_DB = 18.0
        const val ACTIVE_THRESHOLD_DBFS = -50.0
        const val LEVEL_ALPHA = 1.0 / 50 // ~1 s over 20 ms active frames
        const val GAIN_UP_DB_PER_FRAME = 0.06 // 3 dB/s
        const val GAIN_DOWN_DB_PER_FRAME = 0.24 // 12 dB/s
        const val CEILING = 29204.0 // -1 dBFS
        private const val HIST_MIN_DB = -90
        private const val HIST_BINS = 91 // 1 dB bins, -90 .. 0
        private const val FULL_SCALE = 32768.0

        fun dbToLin(db: Double) = 10.0.pow(db / 20)
        fun linToDb(lin: Double) = 20 * log10(lin)
    }

    /** False before ACTIVE (S56 early media / ringback): fixed initial gain, no adaptation. */
    @Volatile var adaptive = false

    // Capture-thread state.
    private var gainDb = INITIAL_GAIN_DB
    private var levelDb = Double.NaN

    // Stats, guarded by this.
    private var frames = 0L
    private var activeFrames = 0L
    private var zeroFrames = 0L
    private var limiterFrames = 0L
    private val inHist = LongArray(HIST_BINS)
    private val outHist = LongArray(HIST_BINS)
    private var inPeakDbfs = Double.NEGATIVE_INFINITY
    private var gainDbLast = INITIAL_GAIN_DB
    private var gainDbMin = Double.NaN
    private var gainDbMax = Double.NaN

    val currentGainDb: Double get() = gainDb

    fun process(pcm: ByteArray) {
        val n = pcm.size / 2
        if (n == 0) return
        var sumSq = 0.0
        var peak = 0
        for (i in 0 until n) {
            val s = sample(pcm, i)
            sumSq += s.toDouble() * s
            peak = maxOf(peak, abs(s))
        }
        if (peak == 0) {
            synchronized(this) { frames++; zeroFrames++ }
            return
        }
        val inRmsDb = linToDb(sqrt(sumSq / n) / FULL_SCALE)
        val active = inRmsDb > ACTIVE_THRESHOLD_DBFS
        val prevGainDb = gainDb
        if (active && adaptive) {
            levelDb = if (levelDb.isNaN()) inRmsDb else levelDb + LEVEL_ALPHA * (inRmsDb - levelDb)
            val desired = (TARGET_DBFS - levelDb).coerceIn(MIN_GAIN_DB, MAX_GAIN_DB)
            gainDb = when {
                desired > gainDb -> minOf(desired, gainDb + GAIN_UP_DB_PER_FRAME)
                else -> maxOf(desired, gainDb - GAIN_DOWN_DB_PER_FRAME)
            }
        }
        val g0 = dbToLin(prevGainDb)
        var g1 = dbToLin(gainDb)
        val out = DoubleArray(n)
        var outPeak = 0.0
        for (i in 0 until n) {
            val g = g0 + (g1 - g0) * (i + 1) / n
            out[i] = sample(pcm, i) * g
            outPeak = maxOf(outPeak, abs(out[i]))
        }
        var limited = false
        if (outPeak > CEILING) {
            val scale = CEILING / outPeak
            for (i in 0 until n) out[i] *= scale
            g1 *= scale
            gainDb = linToDb(g1)
            limited = true
        }
        var outSumSq = 0.0
        for (i in 0 until n) {
            val v = out[i].roundToInt().coerceIn(-32768, 32767)
            outSumSq += v.toDouble() * v
            pcm[2 * i] = v.toByte()
            pcm[2 * i + 1] = (v shr 8).toByte()
        }
        val outRmsDb = linToDb(sqrt(outSumSq / n) / FULL_SCALE)
        synchronized(this) {
            frames++
            if (limited) limiterFrames++
            inPeakDbfs = maxOf(inPeakDbfs, linToDb(peak / FULL_SCALE))
            gainDbLast = gainDb
            gainDbMin = if (gainDbMin.isNaN()) gainDb else minOf(gainDbMin, gainDb)
            gainDbMax = if (gainDbMax.isNaN()) gainDb else maxOf(gainDbMax, gainDb)
            if (active) {
                activeFrames++
                inHist[bin(inRmsDb)]++
                outHist[bin(outRmsDb)]++
            }
        }
    }

    @Synchronized
    fun snapshot(): Map<String, Any?> = mapOf(
        "frames" to frames, "activeFrames" to activeFrames, "zeroFrames" to zeroFrames,
        "inRmsP50Dbfs" to percentile(inHist, 0.50), "inRmsP95Dbfs" to percentile(inHist, 0.95),
        "inPeakDbfs" to inPeakDbfs.takeIf { it.isFinite() }?.let(::round1),
        "outRmsP50Dbfs" to percentile(outHist, 0.50), "outRmsP95Dbfs" to percentile(outHist, 0.95),
        "gainDbLast" to round1(gainDbLast),
        "gainDbMin" to gainDbMin.takeIf { !it.isNaN() }?.let(::round1),
        "gainDbMax" to gainDbMax.takeIf { !it.isNaN() }?.let(::round1),
        "limiterFrames" to limiterFrames,
    )

    private fun sample(pcm: ByteArray, i: Int): Int =
        (pcm[2 * i].toInt() and 0xff) or (pcm[2 * i + 1].toInt() shl 8)

    private fun bin(db: Double) = (floor(db).toInt() - HIST_MIN_DB).coerceIn(0, HIST_BINS - 1)

    private fun percentile(hist: LongArray, p: Double): Int? {
        val total = hist.sum()
        if (total == 0L) return null
        var seen = 0L
        for (i in hist.indices) {
            seen += hist[i]
            if (seen >= total * p) return i + HIST_MIN_DB
        }
        return null
    }

    private fun round1(v: Double) = (v * 10).roundToInt() / 10.0
}
