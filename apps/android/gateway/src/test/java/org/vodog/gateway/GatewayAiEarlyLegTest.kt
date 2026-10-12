package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** S123: deferred AI answer + AI early leg. */
class GatewayAiEarlyLegTest {
    private val ringing = DeviceCallRecord(
        deviceCallId = "device", phoneAccountHandle = null, creationTimeMillis = 123,
        direction = DeviceCallDirection.INCOMING, state = DeviceCallState.RINGING,
        observedAt = "2026-10-09T00:00:00Z", remoteNumber = null, incomingEventId = "event",
        incomingPayload = null, incomingReported = true, serverCallId = "server",
    )
    private val answeredByAi = ringing.copy(answeredByAi = true, remoteAnswered = true)
    private val deferred = answeredByAi.copy(aiAnswerDeadlineMs = 10_000L, aiAnswerBootId = "7")

    @Test fun onlyARingingIncomingAiAnswerIsDeferred() {
        val r = ActualTelecomState.RINGING
        assertTrue(shouldDeferAiAnswer(true, true, answeredByAi, r))
        assertFalse(shouldDeferAiAnswer(false, true, answeredByAi, r)) // flag off
        assertFalse(shouldDeferAiAnswer(true, false, answeredByAi, r)) // human remote answer
        assertFalse(shouldDeferAiAnswer(true, true, answeredByAi.copy(direction = DeviceCallDirection.OUTGOING), r))
        assertFalse(shouldDeferAiAnswer(true, true, answeredByAi.copy(deviceOriginated = true), r))
        assertFalse(shouldDeferAiAnswer(true, true, answeredByAi.copy(serverCallId = null), r))
        assertFalse(shouldDeferAiAnswer(true, true, answeredByAi, ActualTelecomState.ACTIVE))
    }

    @Test fun aiEarlyLegPredicateTruthTable() {
        val r = ActualTelecomState.RINGING
        assertTrue(isAiEarlyLegCall(deferred, r, flag = true))
        assertFalse(isAiEarlyLegCall(deferred, r, flag = false))
        assertFalse(isAiEarlyLegCall(deferred.copy(answeredByAi = false), r, true)) // INCOMING human
        assertFalse(isAiEarlyLegCall(deferred.copy(direction = DeviceCallDirection.OUTGOING), r, true))
        assertFalse(isAiEarlyLegCall(deferred.copy(deviceOriginated = true), r, true))
        assertFalse(isAiEarlyLegCall(deferred.copy(remoteAnswered = false), r, true))
        assertFalse(isAiEarlyLegCall(deferred.copy(aiAnswerIssuedMs = 1L), r, true))
        assertFalse(isAiEarlyLegCall(answeredByAi, r, true)) // answered at once: no deadline
        assertFalse(isAiEarlyLegCall(deferred, ActualTelecomState.ACTIVE, true))
        assertFalse(isAiEarlyLegCall(deferred.copy(state = DeviceCallState.ACTIVE), r, true))
        // S56 is untouched: an incoming call is never an S56 early-media call.
        assertFalse(isEarlyMediaCall(deferred, r))
    }

    @Test fun aBuiltLegIsKeptFromTheIssuedAnswerUntilBothSidesReadActive() {
        val issued = deferred.copy(aiAnswerIssuedMs = 9_000L)
        assertTrue(isAiEarlyLegLive(issued, ActualTelecomState.RINGING))
        assertTrue(isAiEarlyLegLive(issued, ActualTelecomState.ACTIVE))
        assertTrue(isAiEarlyLegLive(issued.copy(state = DeviceCallState.ACTIVE), ActualTelecomState.RINGING))
        assertFalse(isAiEarlyLegLive(issued.copy(state = DeviceCallState.ACTIVE), ActualTelecomState.ACTIVE))
        assertFalse(isAiEarlyLegLive(issued, ActualTelecomState.DISCONNECTED))
        assertFalse(isAiEarlyLegLive(answeredByAi, ActualTelecomState.RINGING))
    }

    @Test fun legReadyBudgetLegFailedAndNoLegAnswerOnceWhileRinging() {
        // All four triggers go through answerIfRinging: ringing + deadline + not issued → issue, then never again.
        assertTrue(shouldIssueAiAnswer(deferred, ActualTelecomState.RINGING))
        assertFalse(shouldIssueAiAnswer(deferred.copy(aiAnswerIssuedMs = 9_000L), ActualTelecomState.RINGING))
        assertFalse(shouldIssueAiAnswer(answeredByAi, ActualTelecomState.RINGING)) // never deferred
        assertFalse(shouldIssueAiAnswer(deferred, ActualTelecomState.ACTIVE)) // the owner picked up first
    }

    @Test fun answerStateMachine() {
        val r = ActualTelecomState.RINGING
        // Inside the window: wait for leg_ready / leg_failed / budget.
        assertEquals(AiAnswerStep.WAIT, aiAnswerStep(deferred, r, nowMs = 9_999L, bootId = "7"))
        // restart: deadline passed, or a new boot.
        assertEquals(AiAnswerStep.RESTART, aiAnswerStep(deferred, r, nowMs = 10_000L, bootId = "7"))
        assertEquals(AiAnswerStep.RESTART, aiAnswerStep(deferred, r, nowMs = 1L, bootId = "8"))
        // caller_hangup: nothing to answer; the leg goes with active == null.
        assertNull(aiAnswerStep(deferred, ActualTelecomState.DISCONNECTED, 1L, "7"))
        assertNull(aiAnswerStep(deferred, null, 1L, "7"))
        // owner_local: ACTIVE with nothing issued is the owner on the Pixel ...
        assertEquals(AiAnswerStep.OWNER_LOCAL, aiAnswerStep(deferred, ActualTelecomState.ACTIVE, 1L, "7"))
        assertEquals(AiAnswerStep.OWNER_LOCAL,
            aiAnswerStep(deferred.copy(state = DeviceCallState.ACTIVE), ActualTelecomState.HOLDING, 1L, "7"))
        // ... and once marked (answeredByAi/remoteAnswered cleared, ownerJoined) it is never detected again.
        val local = deferred.copy(state = DeviceCallState.ACTIVE, answeredByAi = false, remoteAnswered = false, ownerJoined = true)
        assertNull(aiAnswerStep(local, ActualTelecomState.ACTIVE, 1L, "7"))
        assertFalse(needsRemoteMedia(local))
        // Issued (any trigger): ACTIVE is the AI path.
        assertNull(aiAnswerStep(deferred.copy(aiAnswerIssuedMs = 9_000L), ActualTelecomState.ACTIVE, 1L, "7"))
        assertNull(aiAnswerStep(answeredByAi, r, 1L, "7"))
    }

    @Test fun mediaSetupCarriesTheAnswerFields() {
        val issued = deferred.copy(aiAnswerIssuedMs = 6_200L) // ANSWER at 5_000, answered 1_200 ms later
        assertEquals(mapOf("aiEarly" to true, "answerTrigger" to "leg_ready", "answerDeferredMs" to 1_200L),
            aiAnswerSetupFields(true, issued, "leg_ready", "7"))
        // Another boot: elapsedRealtime restarted, the delay is unknown.
        assertNull(aiAnswerSetupFields(true, issued, "restart", "8")["answerDeferredMs"])
        // Not issued yet: no trigger.
        assertNull(aiAnswerSetupFields(true, deferred, "budget", "7")["answerTrigger"])
        assertEquals(mapOf("aiEarly" to false, "answerTrigger" to null, "answerDeferredMs" to null),
            aiAnswerSetupFields(false, answeredByAi, null, "7"))
        val row = mediaSetupDiagFields(aiAnswerSetupFields(true, issued, "budget", "7"), emptyMap(), null)
        assertEquals("budget", row["answerTrigger"])
    }

    @Test fun deferredAnswerFieldsSurviveTheJournalAndOldRowsReadNull() {
        val issued = deferred.copy(aiAnswerIssuedMs = 6_200L)
        assertEquals(issued, issued.toJson().toRecord())
        val legacy = answeredByAi.toJson().apply {
            remove("aiAnswerDeadlineMs"); remove("aiAnswerIssuedMs"); remove("aiAnswerBootId")
        }.toRecord()
        assertNull(legacy.aiAnswerDeadlineMs)
        assertNull(legacy.aiAnswerIssuedMs)
        assertNull(legacy.aiAnswerBootId)
    }

    @Test fun activeCallbackArmsOnlyAnUnarmedAiEarlyLegItsHolderOwns() {
        val issued = deferred.copy(state = DeviceCallState.ACTIVE, aiAnswerIssuedMs = 6_200L)
        fun arm(record: DeviceCallRecord?, armed: Boolean = false, failed: Boolean = false, hasApi: Boolean = true) =
            shouldArmAiEarlyLegNow("server", "device", 123, armed, failed, hasApi, record)
        assertTrue(arm(issued))
        assertFalse(arm(null)) // no record / not exactly ACTIVE
        assertFalse(arm(issued.copy(deviceCallId = "other")))
        assertFalse(arm(issued.copy(serverCallId = "other")))
        assertFalse(arm(issued.copy(creationTimeMillis = 124)))
        assertFalse(arm(issued, armed = true)) // the loop's reconcile won the CAS
        assertFalse(arm(issued, failed = true))
        assertFalse(arm(issued, hasApi = false))
        // Not an S123 AI early leg: S56 human early legs and the owner-local window stay with the loop.
        assertFalse(arm(issued.copy(aiAnswerIssuedMs = null)))
    }

    @Test fun aCancelledSetupOfAnEndedCallIsNotAFailure() {
        val cancelled = kotlinx.coroutines.CancellationException("StandaloneCoroutine was cancelled")
        assertEquals("setup_cancelled_call_ended", setupCancelledFailureCode(cancelled, terminal = true))
        // A live call (OFF, identity change) keeps today's code.
        assertNull(setupCancelledFailureCode(cancelled, terminal = false))
        assertEquals("data_channel_connect_failed", mediaSetupFailureCode("data_channel_connect", cancelled))
        // A timeout is a CancellationException too, and stays a failure.
        val timeout = runCatching { kotlinx.coroutines.runBlocking { kotlinx.coroutines.withTimeout(1) { kotlinx.coroutines.delay(1_000) } } }
            .exceptionOrNull()!!
        assertNull(setupCancelledFailureCode(timeout, terminal = true))
        assertNull(setupCancelledFailureCode(IllegalStateException("x"), terminal = true))
        assertTrue(mediaCallTerminal(null, DeviceCallState.ACTIVE))
        assertTrue(mediaCallTerminal(ActualTelecomState.DISCONNECTED, DeviceCallState.ACTIVE))
        assertTrue(mediaCallTerminal(ActualTelecomState.RINGING, DeviceCallState.ENDED))
        assertFalse(mediaCallTerminal(ActualTelecomState.RINGING, DeviceCallState.RINGING))
        assertFalse(mediaCallTerminal(ActualTelecomState.DISCONNECTING, DeviceCallState.ACTIVE))
    }
}
