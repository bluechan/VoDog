package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The wake-intent read path must not hit the (fake) keystore cipher more than once per stored token. */
class DeviceCredentialVaultCacheTest {
    private class FakeSealedStore(var sealed: String? = null) : SealedCredentialStore {
        var opens = 0
        var seals = 0
        var failNextOpen = false
        var failNextSeal = false
        override fun seal(token: String) {
            seals++
            if (failNextSeal) { failNextSeal = false; error("keystore unavailable") }
            sealed = "cipher:$token"
        }
        override fun open(): String? {
            opens++
            if (failNextOpen) { failNextOpen = false; error("keystore locked") }
            return sealed?.removePrefix("cipher:")
        }
        override fun clear() { sealed = null }
    }

    @Test fun `repeated reads decrypt once`() {
        val store = FakeSealedStore("cipher:device-token")
        val vault = DeviceCredentialVault(store, DeviceCredentialCache())
        repeat(10) { assertEquals("device-token", vault.read()) }
        assertTrue(vault.hasCredential())
        assertEquals(1, store.opens)
    }

    @Test fun `every vault instance shares the cache of its process`() {
        val store = FakeSealedStore("cipher:device-token")
        val cache = DeviceCredentialCache()
        assertEquals("device-token", DeviceCredentialVault(store, cache).read())
        assertEquals("device-token", DeviceCredentialVault(store, cache).read())
        assertEquals(1, store.opens)
    }

    @Test fun `save replaces the remembered token without a decrypt`() {
        val store = FakeSealedStore("cipher:old-token")
        val vault = DeviceCredentialVault(store, DeviceCredentialCache())
        assertEquals("old-token", vault.read())
        vault.save("new-token")
        assertEquals("new-token", vault.read())
        assertEquals("cipher:new-token", store.sealed)
        assertEquals(1, store.opens)
        assertThrows(IllegalArgumentException::class.java) { vault.save(" ") }
    }

    @Test fun `a failed save forgets the old token so the store decides`() {
        val store = FakeSealedStore("cipher:old-token")
        val vault = DeviceCredentialVault(store, DeviceCredentialCache())
        assertEquals("old-token", vault.read())
        store.failNextSeal = true
        assertThrows(IllegalStateException::class.java) { vault.save("new-token") }
        assertEquals("old-token", vault.read())
        assertEquals(2, store.opens)
    }

    @Test fun `clear drops the remembered token`() {
        val store = FakeSealedStore("cipher:device-token")
        val vault = DeviceCredentialVault(store, DeviceCredentialCache())
        assertEquals("device-token", vault.read())
        vault.clear()
        assertNull(vault.read())
        assertFalse(vault.hasCredential())
        assertEquals(3, store.opens) // after clear, nothing is remembered and the store is asked again
    }

    @Test fun `a failed or empty read is never remembered`() {
        val store = FakeSealedStore()
        val vault = DeviceCredentialVault(store, DeviceCredentialCache())
        assertNull(vault.read())
        store.sealed = "cipher:device-token"
        store.failNextOpen = true
        assertNull(vault.read())
        assertEquals("device-token", vault.read())
        assertEquals("device-token", vault.read())
        assertEquals(3, store.opens)
    }
}
