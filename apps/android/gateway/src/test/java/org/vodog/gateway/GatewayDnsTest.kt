package org.vodog.gateway

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** S118: DNS fallback for Control hosts and the TURN URL pin. */
class GatewayDnsTest {
    private val down: (String) -> List<InetAddress> = { throw UnknownHostException(it) }

    @After fun reset() = GatewayDns.resetForTest()

    @Test fun `success updates the cache and a later failure returns it`() {
        val good = InetAddress.getByAddress("example.com", byteArrayOf(10, 0, 0, 7))
        GatewayDns.system = { listOf(good) }
        assertEquals(listOf(good), GatewayDns.lookup("example.com"))
        GatewayDns.system = down
        assertEquals(listOf(good), GatewayDns.lookup("example.com"))
    }

    @Test fun `nothing cached rethrows even for a control host - no built-in table`() {
        GatewayDns.system = down
        assertThrows(UnknownHostException::class.java) { GatewayDns.lookup("control.example.com") }
    }

    @Test fun `unknown host with nothing cached rethrows`() {
        GatewayDns.system = down
        assertThrows(UnknownHostException::class.java) { GatewayDns.lookup("nope.example") }
    }

    private fun ip(host: String, last: Int) = InetAddress.getByAddress(host, byteArrayOf(10, 0, 0, last.toByte()))

    @Test fun `slow system with a cached answer returns the cache within the bound and the late answer refreshes it`() {
        val old = ip("slow.example", 1)
        val fresh = ip("slow.example", 2)
        GatewayDns.system = { listOf(old) }
        GatewayDns.lookup("slow.example")
        GatewayDns.systemWaitMs = 50
        val release = CountDownLatch(1)
        val calls = AtomicInteger()
        GatewayDns.system = { calls.incrementAndGet(); release.await(5, TimeUnit.SECONDS); listOf(fresh) }
        val pool = Executors.newFixedThreadPool(2)
        val started = System.nanoTime()
        val answers = List(2) { pool.submit<List<InetAddress>> { GatewayDns.lookup("slow.example") } }.map { it.get(2, TimeUnit.SECONDS) }
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        pool.shutdown()
        assertEquals(listOf(listOf(old), listOf(old)), answers)
        assertTrue("took $elapsedMs ms", elapsedMs < 1_000)
        assertEquals("one system lookup in flight per host", 1, calls.get())
        release.countDown()
        GatewayDns.system = down
        val deadline = System.currentTimeMillis() + 2_000
        while (GatewayDns.lookup("slow.example") != listOf(fresh) && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertEquals(listOf(fresh), GatewayDns.lookup("slow.example"))
    }

    @Test fun `slow system with no fallback waits past the bound for the system answer`() {
        val fresh = ip("slow.example", 3)
        GatewayDns.systemWaitMs = 20
        GatewayDns.system = { Thread.sleep(150); listOf(fresh) }
        val started = System.nanoTime()
        assertEquals(listOf(fresh), GatewayDns.lookup("slow.example"))
        assertTrue((System.nanoTime() - started) / 1_000_000 >= 150)
    }

    @Test fun `fast system with a cached fallback returns the fresh system answer`() {
        GatewayDns.system = { listOf(ip("control.example.com", 4)) }
        GatewayDns.lookup("control.example.com")
        val fresh = ip("control.example.com", 5)
        GatewayDns.system = { listOf(fresh) }
        assertEquals(listOf(fresh), GatewayDns.lookup("control.example.com"))
    }

    @Test fun `turn url is pinned to the resolved ip and keeps the name as hostname`() {
        val v4 = InetAddress.getByAddress("control.example.com", byteArrayOf(192.toByte(), 0, 2, 10))
        assertEquals(
            "turns:192.0.2.10:16802?transport=tcp" to "control.example.com",
            pinTurnUrl("turns:control.example.com:16802?transport=tcp") { v4 },
        )
        val v6 = InetAddress.getByAddress("h.example.com", ByteArray(16).also { it[15] = 1 })
        assertEquals("turns:[0:0:0:0:0:0:0:1]:443?transport=tcp" to "h.example.com", pinTurnUrl("turns:h.example.com:443?transport=tcp") { v6 })
        assertEquals("turn:1.2.3.4:3478?transport=udp" to null, pinTurnUrl("turn:1.2.3.4:3478?transport=udp") { error("not called") })
        assertEquals("turns:[::1]:443?transport=tcp" to null, pinTurnUrl("turns:[::1]:443?transport=tcp") { error("not called") })
        val failed = "turns:control.example.com:16802?transport=tcp"
        assertEquals(failed to null, pinTurnUrl(failed) { throw UnknownHostException(it) })
    }
}
