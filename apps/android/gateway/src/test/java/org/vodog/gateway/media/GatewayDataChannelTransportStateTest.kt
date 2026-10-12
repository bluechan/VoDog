package org.vodog.gateway.media

import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.webrtc.PeerConnection
import java.io.Closeable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The fatal set is the whole fix: a transient DISCONNECTED must not tear a live call down, because
 * libwebrtc escalates a dead pair to FAILED itself. Enumerating the enums keeps a future libwebrtc
 * state from silently joining either set.
 */
class GatewayDataChannelTransportStateTest {

    @Test fun onlyFailedAndClosedIceStatesAreFatal() {
        assertEquals(
            setOf(PeerConnection.IceConnectionState.FAILED, PeerConnection.IceConnectionState.CLOSED),
            PeerConnection.IceConnectionState.values().filter(::isFatalIceState).toSet(),
        )
    }

    @Test fun onlyFailedAndClosedPeerStatesAreFatal() {
        assertEquals(
            setOf(PeerConnection.PeerConnectionState.FAILED, PeerConnection.PeerConnectionState.CLOSED),
            PeerConnection.PeerConnectionState.values().filter(::isFatalPeerState).toSet(),
        )
    }

    // The PeerConnectionFactory now builds while media options is in flight (PrewarmedResource).
    private class FakeFactory : Closeable {
        val closes = AtomicInteger()
        override fun close() { closes.incrementAndGet() }
    }

    @Test fun factoryBuiltDuringOptionsIsReleasedWhenOptionsFails() = runBlocking {
        val factory = FakeFactory()
        val prewarm = PrewarmedResource(Executor { it.run() }) { factory }
        val failure = runCatching<Unit> {
            try {
                throw GatewayMediaHttpException(409, "CAPTURE_BINDING_CONFLICT", "options refused")
            } catch (error: Throwable) {
                prewarm.abandon() // the negotiate catch path, before releaseNegotiation
                throw error
            }
        }.exceptionOrNull()
        assertTrue(failure is GatewayMediaHttpException)
        assertEquals(1, factory.closes.get())
        prewarm.abandon()
        assertEquals(1, factory.closes.get())
    }

    @Test fun factoryStillBuildingWhenTheSetupIsCancelledIsReleasedOnceItIsBuilt() {
        val factory = FakeFactory()
        val building = CountDownLatch(1)
        val finishBuild = CountDownLatch(1)
        val pool = Executors.newSingleThreadExecutor()
        try {
            val prewarm = PrewarmedResource(pool) {
                building.countDown()
                check(finishBuild.await(5, TimeUnit.SECONDS)) // a blocking native build ignores cancellation
                factory
            }
            assertTrue(building.await(5, TimeUnit.SECONDS))
            runBlocking {
                val setup = launch { prewarm.take() }
                delay(50)
                setup.cancel()
                setup.join()
                assertTrue(setup.isCancelled)
            }
            prewarm.abandon()
            assertEquals(0, factory.closes.get())
            finishBuild.countDown()
            pool.shutdown()
            assertTrue(pool.awaitTermination(5, TimeUnit.SECONDS))
            assertEquals(1, factory.closes.get())
        } finally {
            finishBuild.countDown()
            pool.shutdownNow()
        }
    }

    @Test fun takenFactoryBelongsToTheCallerAndAFailedBuildSurfaces() = runBlocking {
        val factory = FakeFactory()
        val prewarm = PrewarmedResource(Executor { it.run() }) { factory }
        assertSame(factory, prewarm.take())
        prewarm.abandon() // releaseNegotiation owns it now
        assertEquals(0, factory.closes.get())

        val broken = PrewarmedResource<FakeFactory>(Executor { it.run() }) { error("audio device module unavailable") }
        assertEquals("audio device module unavailable", runCatching { broken.take() }.exceptionOrNull()?.message)
        broken.abandon()
    }
}
