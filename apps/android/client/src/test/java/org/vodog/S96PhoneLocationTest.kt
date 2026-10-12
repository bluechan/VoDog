package org.vodog

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** S96 号码归属地 — shared vectors, optional DTO keys (absent on old Control), ringing and dialer composition. */
class S96PhoneLocationTest {
    @Test fun `short and full forms follow the shared vectors`() {
        assertEquals("广东 深圳", locationShort("广东 深圳 · 移动"))
        assertEquals("北京", locationShort("北京 · 联通"))
        assertEquals("加纳", locationShort("加纳"))
        assertEquals("广东 深圳", locationShort("广东 深圳 · 固话"))
        listOf(null, "", "   ", "null").forEach {
            assertNull(locationShort(it))
            assertNull(locationFull(it))
        }
        assertEquals("广东 深圳 · 移动", locationFull(" 广东 深圳 · 移动 "))
    }

    @Test fun `shared title functions are unchanged by a location`() {
        val call = JSONObject().put("remoteNumber", "19900000101").put("contactName", "张三").put("remoteLocation", "北京 · 移动")
        assertEquals("19900000101 · 张三", callTitle(call))
    }

    @Test fun `call history and report items read remoteLocation optionally`() {
        val call = JSONObject().put("id", "c").put("remoteNumber", "19900000101")
        assertNull(parseCallHistoryItem(call, null).remoteLocation)
        assertNull(parseCallHistoryItem(JSONObject(call.toString()).put("remoteLocation", JSONObject.NULL), null).remoteLocation)
        assertEquals("广东 深圳 · 移动", parseCallHistoryItem(call.put("remoteLocation", "广东 深圳 · 移动"), null).remoteLocation)

        fun report(item: JSONObject) = parseCallReport(
            JSONObject()
                .put("window", JSONObject().put("timeZone", "Asia/Shanghai").put("fromInclusive", "a").put("toExclusive", "b"))
                .put("items", JSONArray().put(item)),
        ).items.single()
        val item = JSONObject().put("callId", "c").put("startedAt", "t").put("direction", "incoming")
            .put("sim", JSONObject().put("id", "s").put("label", "SIM"))
        assertNull(report(item).remoteLocation)
        assertEquals("加纳", report(item.put("remoteLocation", "加纳")).remoteLocation)
    }

    @Test fun `sms messages and conversations take the latest message location`() {
        fun sms(id: String, at: String, location: String?) = JSONObject().put("id", id).put("simId", "s")
            .put("direction", "incoming").put("remoteNumber", "19900000201").put("body", "b").put("receivedAt", at)
            .apply { location?.let { put("remoteLocation", it) } }
        assertNull(sms("1", "2026-01-01T00:00:00Z", null).toClientSmsMessage().remoteLocation)
        val conversation = smsConversations(
            listOf(sms("1", "2026-01-01T00:00:00Z", "北京 · 移动"), sms("2", "2026-01-02T00:00:00Z", "广东 深圳 · 移动")),
            "s",
        ).single()
        assertEquals("广东 深圳 · 移动", conversation.remoteLocation)
        assertEquals(
            null,
            smsConversations(listOf(sms("1", "2026-01-01T00:00:00Z", "北京 · 移动"), sms("2", "2026-01-02T00:00:00Z", null)), "s")
                .single().remoteLocation,
        )
    }

    @Test fun `interceptions and contact phones read location optionally`() {
        val interception = JSONObject().put("id", "i").put("remoteNumber", "19900000101").put("occurredAt", "t")
        assertNull(interception.toClientInterception().remoteLocation)
        assertEquals("北京 · 联通", interception.put("remoteLocation", "北京 · 联通").toClientInterception().remoteLocation)

        val contact = JSONObject().put("id", "c").put("displayName", "张三").put(
            "phones",
            JSONArray()
                .put(JSONObject().put("rawNumber", "19900000101").put("location", "北京 · 移动"))
                .put(JSONObject().put("rawNumber", "+233200000001"))
                .put(JSONObject().put("rawNumber", "0755123").put("location", JSONObject.NULL)),
        ).toClientContact()
        assertEquals(listOf("北京 · 移动", null, null), contact.phones.map { it.location })
    }

    @Test fun `call record subline puts the short location first`() {
        assertEquals("广东 深圳 · 19900000301 · 已接 · 24 秒", callRowSubline("广东 深圳", "19900000301", "已接", null, "24 秒"))
        assertEquals("北京 · 呼出 · 失败", callRowSubline("北京", null, "呼出", "失败", null))
        assertEquals("19900000301 · 未接", callRowSubline(null, "19900000301", "未接", null, null))
    }

    @Test fun `ringing subtitle puts the full location first`() {
        assertEquals("广东 深圳 · 移动 · 电信133 · Pixel", ringingSubtitle("广东 深圳 · 移动", "电信133", "Pixel"))
        assertEquals("电信133 · Pixel", ringingSubtitle(null, "电信133", "Pixel"))
        assertEquals("电信133", ringingSubtitle(" ", "电信133", null))
        assertNull(JSONObject().toString().let { JSONObject(it) }.remoteLocation())
        assertNull(JSONObject().put("remoteLocation", JSONObject.NULL).remoteLocation())
    }

    @Test fun `dialer hint shows name and location only for the looked-up number`() {
        val both = DialerLookupState("19900000101", "c-1", "张三", "北京 · 移动")
        assertEquals("张三", both.hintFor("19900000101"))
        assertEquals("北京 · 移动", both.locationFor("19900000101"))
        assertNull(both.locationFor("1990000020"))
        val partial = DialerLookupState("1990000", location = "广东 深圳 · 移动")
        assertNull(partial.hintFor("1990000"))
        assertEquals("广东 深圳 · 移动", partial.locationFor("1990000"))
        assertNull(DialerLookupState("1990000").locationFor("1990000"))
        assertNull(DialerLookupState().locationFor(""))
    }

    @Test fun `lookupNumber returns the item and top-level location while lookupContact stays item-only`() {
        val api = ClientApi(transport = ClientTransport {
            JSONObject().put("item", JSONObject.NULL).put("location", "广东 深圳 · 移动")
        })
        val (item, location) = api.lookupNumber("1990000")
        assertNull(item)
        assertEquals("广东 深圳 · 移动", location)
        assertNull(api.lookupContact("1990000"))
        val old = ClientApi(transport = ClientTransport { JSONObject().put("item", JSONObject().put("id", "c-1")) })
        assertEquals("c-1", old.lookupNumber("138").first?.optString("id"))
        assertNull(old.lookupNumber("138").second)
    }
}
