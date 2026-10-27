package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayIncomingReportPayloadTest {
    @Test fun screenedRingingCallCarriesEveryFieldPlusScreenedTrue() {
        val body = incomingReportPayload(record(), 7L, "sim-1", screened = true)
        assertEquals("33333333-3333-4333-8333-333333333333", body.getString("eventId"))
        assertEquals(7L, body.getLong("generation"))
        assertEquals("device-a", body.getString("deviceCallId"))
        assertEquals("sim-1", body.getString("simId"))
        assertEquals("2026-09-09T00:00:00Z", body.getString("observedAt"))
        assertEquals("+12025550101", body.getString("remoteNumber"))
        assertTrue(body.getBoolean("screened"))
    }

    @Test fun unscreenedCallOmitsScreenedAndMissingNumber() {
        val body = incomingReportPayload(record(remoteNumber = null), 7L, "sim-1", screened = false)
        assertFalse(body.has("screened"))
        assertFalse(body.has("remoteNumber"))
        assertEquals("device-a", body.getString("deviceCallId"))
    }

    private fun record(remoteNumber: String? = "+12025550101") = DeviceCallRecord(
        deviceCallId = "device-a",
        phoneAccountHandle = "account-a",
        creationTimeMillis = 100L,
        direction = DeviceCallDirection.INCOMING,
        state = DeviceCallState.RINGING,
        observedAt = "2026-09-09T00:00:00Z",
        remoteNumber = remoteNumber,
        incomingEventId = "33333333-3333-4333-8333-333333333333",
        incomingPayload = null,
        incomingReported = false,
        serverCallId = null,
    )
}
