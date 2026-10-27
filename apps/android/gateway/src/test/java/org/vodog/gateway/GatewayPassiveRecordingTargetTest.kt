package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** S134: which journal record the passive recorder targets (the Context-bound preconditions are separate). */
class GatewayPassiveRecordingTargetTest {
    private val incoming = DeviceCallRecord(
        deviceCallId = "device", phoneAccountHandle = null, creationTimeMillis = 123,
        direction = DeviceCallDirection.INCOMING, state = DeviceCallState.ACTIVE,
        observedAt = "2026-10-14T00:00:00Z", remoteNumber = null, incomingEventId = null,
        incomingPayload = null, incomingReported = true, serverCallId = "server",
    )
    private fun target(record: DeviceCallRecord) = passiveRecordingCall(listOf(record))

    @Test fun incomingAnsweredOnThePixelIsATarget() {
        assertEquals(incoming, target(incoming))
    }

    @Test fun remoteAnsweredIncomingCallsAreNotTargets() {
        assertNull(target(incoming.copy(remoteAnswered = true)))
        assertNull(target(incoming.copy(remoteAnswered = true, answeredByAi = true)))
        // S94: the owner joining an AI call keeps remoteAnswered, so it stays on the media node recording.
        assertNull(target(incoming.copy(remoteAnswered = true, answeredByAi = true, ownerJoined = true)))
        // Pre-S72 journal rows default to remoteAnswered=true.
        assertNull(target(incoming.toJson().apply { remove("remoteAnswered") }.toRecord()))
    }

    @Test fun pixelDialledOutgoingStillATargetButRemoteDialIsNot() {
        val outgoing = incoming.copy(direction = DeviceCallDirection.OUTGOING)
        assertEquals(outgoing.copy(deviceOriginated = true), target(outgoing.copy(deviceOriginated = true)))
        assertNull(target(outgoing))
    }

    /** S123 决策 5 as implemented today: the owner picking up inside the deferred AI window clears remoteAnswered. */
    @Test fun ownerAnsweredDuringAiWindowIsATarget() {
        val ownerLocal = incoming.copy(answeredByAi = false, remoteAnswered = false, ownerJoined = true)
        assertEquals(ownerLocal, target(ownerLocal))
    }

    @Test fun onlyAnActiveServerBoundSingleCallQualifies() {
        assertNull(target(incoming.copy(state = DeviceCallState.RINGING)))
        assertNull(target(incoming.copy(state = DeviceCallState.ENDED)))
        assertNull(target(incoming.copy(serverCallId = null)))
        assertNull(target(incoming.copy(creationTimeMillis = null)))
        assertNull(passiveRecordingCall(listOf(incoming, incoming.copy(deviceCallId = "other"))))
        assertEquals(incoming, passiveRecordingCall(listOf(incoming, incoming.copy(deviceCallId = "rc", remoteAnswered = true))))
    }
}
