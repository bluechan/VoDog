package org.vodog

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** S101: `transcript.dialog` parsing and the conversation-view policy, against docs/specs/fixtures/s101-dialog.json. */
class S101DialogTest {
    private val fixture: JSONObject by lazy {
        val relative = "docs/specs/fixtures/s101-dialog.json"
        // The shared repo fixture wins; the bundled copy covers checkouts without docs/specs/fixtures.
        val file = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, relative) }.firstOrNull { it.isFile }
        JSONObject(file?.readText() ?: javaClass.getResource("/s101-dialog.json")!!.readText())
    }

    private fun envelope(dialog: Any?, includeDialog: Boolean = true): JSONObject {
        val result = JSONObject().put("text", "remote: 你好")
            .put("segments", JSONArray().put(JSONObject().put("track", "remote_original").put("speaker", "remote").put("text", "你好")))
            .put("providers", JSONArray()).put("advertisingClassification", "not_advertising")
            .put("includeInReports", true).put("actionItems", JSONArray())
        val transcript = JSONObject().put("id", "tr-1").put("callId", "call-1").put("status", "succeeded").put("attempts", 1)
            .put("result", result).put("createdAt", "now").put("updatedAt", "now").put("completedAt", "now")
        if (includeDialog) transcript.put("dialog", dialog ?: JSONObject.NULL)
        return JSONObject().put("transcript", transcript)
    }

    @Test fun parsesEveryFixtureExpectedDialog() {
        for (case in listOf("humanCall", "aiCallRealtime", "aiCallWithoutRealtime")) {
            val expected = fixture.getJSONObject(case).getJSONObject("expected")
            val dialog = requireNotNull(requireNotNull(parseCallTranscript(envelope(expected))).dialog) { case }
            assertEquals(case, expected.getString("timebase"), dialog.timebase)
            assertEquals(case, expected.getLong("maxSkewMs"), dialog.maxSkewMs)
            val turns = expected.getJSONArray("turns")
            assertEquals(case, turns.length(), dialog.turns.size)
            dialog.turns.forEachIndexed { index, turn ->
                val want = turns.getJSONObject(index)
                assertEquals(want.getString("role"), turn.role.wire)
                assertEquals(want.getString("text"), turn.text)
                assertEquals(want.getLong("atMs"), turn.atMs)
                assertEquals(if (want.has("endAtMs")) want.getLong("endAtMs") else null, turn.endAtMs)
                assertEquals(want.getString("source"), turn.source)
                assertEquals(want.optString("track").ifEmpty { null }, turn.track)
            }
            assertTrue(case, TranscriptDialogPolicy.useDialog(dialog))
        }
    }

    @Test fun missingNullOrMalformedDialogFallsBackWithoutLosingTheResult() {
        assertNull(fixture.getJSONObject("noSegments").opt("expected").takeUnless { it == JSONObject.NULL })
        for (json in listOf(envelope(null), envelope(null, includeDialog = false), envelope(JSONObject().put("turns", "x")))) {
            val transcript = requireNotNull(parseCallTranscript(json))
            assertNull(transcript.dialog)
            assertNotNull(transcript.result)
            assertFalse(TranscriptDialogPolicy.useDialog(transcript.dialog))
        }
        assertFalse(TranscriptDialogPolicy.useDialog(TranscriptDialog("end_aligned", 0, emptyList())))
    }

    @Test fun unknownRolesAndBlankTurnsAreDropped() {
        val dialog = JSONObject().put("timebase", "end_aligned").put("maxSkewMs", 0).put("turns", JSONArray()
            .put(JSONObject().put("role", "robot").put("text", "x").put("atMs", 0).put("source", "asr"))
            .put(JSONObject().put("role", "me").put("text", "  ").put("atMs", 1).put("source", "asr"))
            .put(JSONObject().put("role", "remote").put("text", "喂").put("atMs", 2.5).put("source", "asr")))
        val turns = requireNotNull(requireNotNull(parseCallTranscript(envelope(dialog))).dialog).turns
        assertEquals(listOf(TranscriptRole.REMOTE), turns.map { it.role })
        assertEquals(2L, turns.single().atMs)
    }

    @Test fun rolesMapToSideToneAndLabel() {
        assertFalse(TranscriptDialogPolicy.alignEnd(TranscriptRole.REMOTE))
        assertTrue(TranscriptDialogPolicy.alignEnd(TranscriptRole.ME))
        assertTrue(TranscriptDialogPolicy.alignEnd(TranscriptRole.AI))
        assertEquals(TranscriptBubbleTone.SURFACE3, TranscriptDialogPolicy.tone(TranscriptRole.REMOTE))
        assertEquals(TranscriptBubbleTone.BUBBLE_OUT, TranscriptDialogPolicy.tone(TranscriptRole.ME))
        assertEquals(TranscriptBubbleTone.AI_SOFT, TranscriptDialogPolicy.tone(TranscriptRole.AI))
        assertEquals("✦ AI", TranscriptDialogPolicy.badge(TranscriptRole.AI))
        assertNull(TranscriptDialogPolicy.badge(TranscriptRole.ME))
        assertEquals(listOf("对方", "我", "AI"), TranscriptRole.entries.map(TranscriptDialogPolicy::speakerLabel))
    }

    @Test fun clockIsMinutesAndSecondsFromCallStart() {
        assertEquals("00:02", TranscriptDialogPolicy.clock(2753))
        assertEquals("00:12", TranscriptDialogPolicy.clock(12231))
        assertEquals("01:23", TranscriptDialogPolicy.clock(83000))
        assertEquals("00:00", TranscriptDialogPolicy.clock(-5))
    }

    @Test fun spacingAndEstimateNote() {
        assertEquals(0, TranscriptDialogPolicy.spacingDp(null, TranscriptRole.ME))
        assertEquals(4, TranscriptDialogPolicy.spacingDp(TranscriptRole.AI, TranscriptRole.AI))
        assertEquals(12, TranscriptDialogPolicy.spacingDp(TranscriptRole.REMOTE, TranscriptRole.ME))
        assertFalse(TranscriptDialogPolicy.showEstimateNote(TranscriptDialog("end_aligned", 600, emptyList())))
        assertFalse(TranscriptDialogPolicy.showEstimateNote(TranscriptDialog("end_aligned", 1500, emptyList())))
        assertTrue(TranscriptDialogPolicy.showEstimateNote(TranscriptDialog("end_aligned", 1520, emptyList())))
    }
}
