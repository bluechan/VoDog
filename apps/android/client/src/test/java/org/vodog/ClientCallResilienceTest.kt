package org.vodog

import android.media.AudioManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class ClientCallResilienceTest {
    @Test
    fun ringVerifyOnlyStopsOnDefinitiveAnswers() {
        assertEquals("network", incomingVerifyFailureReason(IOException("timeout")))
        assertEquals("network", incomingVerifyFailureReason(ApiError(503, "UNAVAILABLE", "x")))
        assertEquals("network", incomingVerifyFailureReason(ApiError(429, "RATE_LIMITED", "x")))
        assertEquals("session", incomingVerifyFailureReason(SessionChangedException()))
        assertEquals("session", incomingVerifyFailureReason(ApiError(401, "UNAUTHORIZED", "x")))
        assertEquals("not_ringing", incomingVerifyFailureReason(ApiError(404, "NOT_FOUND", "x")))
        assertEquals("not_ringing", incomingVerifyFailureReason(ApiError(409, "CALL_NOT_RINGING", "x")))
    }

    @Test
    fun onlyPermanentFocusLossIsTerminal() {
        assertEquals("loss", audioFocusChangeName(AudioManager.AUDIOFOCUS_LOSS))
        assertEquals("loss_transient", audioFocusChangeName(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT))
        assertEquals("loss_transient_can_duck", audioFocusChangeName(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK))
        assertEquals("gain", audioFocusChangeName(AudioManager.AUDIOFOCUS_GAIN))
    }

    @Test
    fun livenessRefreshesOnlyForegroundAndNotOnRinging() {
        for (phase in listOf(ClientCallLivenessPhase.CLAIMED, ClientCallLivenessPhase.MEDIA_ACTIVE, ClientCallLivenessPhase.ENDED)) {
            assertTrue(livenessTriggersRefresh(phase, foregroundActive = true))
            assertFalse(livenessTriggersRefresh(phase, foregroundActive = false))
        }
        assertFalse(livenessTriggersRefresh(ClientCallLivenessPhase.RINGING, foregroundActive = true))
    }

    @Test
    fun killedMarkerOnlyForUncleanExitWithin24h() {
        val now = 100_000_000_000L
        assertEquals(90L, killedLastAliveAgoS(now - 90_000, cleanShutdown = false, nowMs = now))
        assertNull(killedLastAliveAgoS(now - 90_000, cleanShutdown = true, nowMs = now))
        assertNull(killedLastAliveAgoS(0L, cleanShutdown = false, nowMs = now))
        assertNull(killedLastAliveAgoS(now - 24 * 3_600_000L, cleanShutdown = false, nowMs = now))
        assertNull(killedLastAliveAgoS(now + 5_000, cleanShutdown = false, nowMs = now))
    }

    @Test
    fun answerDuringRingVerifyWaitsForTelecomRegistration() = runBlocking {
        // ACTION_RING prepares before its verify GET; the Answer tap lands before Telecom registered.
        val registry = TelecomScopeRegistry<String>(readyTimeoutMs = 5_000)
        registry.prepare("call")
        val answer = async(Dispatchers.Default) { registry.await("call") }
        delay(100)
        assertFalse(answer.isCompleted)
        registry.register("call", "scope")
        assertEquals("scope", withTimeout(1_000) { answer.await() })
        // Once registered, an answer needs no wait at all.
        assertEquals("scope", registry.await("call"))
    }

    @Test
    fun answerWithoutRegistrationReturnsNullAfterTheTimeout() = runBlocking {
        val registry = TelecomScopeRegistry<String>(readyTimeoutMs = 150)
        // No ring in this process (e.g. a redelivered ANSWER): nothing to wait for.
        val unknownStart = System.nanoTime()
        assertNull(registry.await("never-rang"))
        assertTrue((System.nanoTime() - unknownStart) / 1_000_000 < 100)
        registry.prepare("call")
        val start = System.nanoTime()
        assertNull(registry.await("call"))
        assertTrue((System.nanoTime() - start) / 1_000_000 >= 140)
        assertEquals(5_000L, TelecomScopeRegistry.ANSWER_READY_TIMEOUT_MS)
    }

    @Test
    fun prepareIsIdempotentAndReleaseWakesAWaitingAnswer() = runBlocking {
        val registry = TelecomScopeRegistry<String>(readyTimeoutMs = 5_000)
        assertSame(registry.prepare("call"), registry.prepare("call"))
        val answer = async(Dispatchers.Default) { registry.await("call") }
        delay(100)
        // Verify said "not ringing" (or registration failed): the ring job releases, the answer gives up now.
        registry.release("call")
        assertNull(withTimeout(1_000) { answer.await() })
        assertNull(registry.await("call"))

        // Telecom disconnect drops the scope; the ring job's release then clears the readiness.
        registry.prepare("other")
        registry.register("other", "scope")
        assertEquals("scope", registry.detach("other"))
        assertNull(registry.detach("other"))
        registry.release("other")
        assertNull(registry.await("other"))
    }
}
