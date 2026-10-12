package org.vodog.gateway

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class DeviceCredentialVault internal constructor(
    private val store: SealedCredentialStore,
    private val cache: DeviceCredentialCache = DeviceCredentialCache.PROCESS,
) {
    constructor(context: Context) : this(KeystoreCredentialStore(context))

    fun hasCredential(): Boolean = read()?.isNotBlank() == true

    fun save(token: String) {
        require(token.isNotBlank())
        cache.write { store.seal(token); token }
    }

    /**
     * The service reads this on every wake intent, on the main thread, several times per call. Only
     * the first read in a process pays for the AndroidKeyStore decrypt; [save] and [clear] replace or
     * drop the remembered value under the same lock, and a failed read is never remembered.
     */
    fun read(): String? = cache.read { runCatching { store.open() }.getOrNull() }

    fun clear() {
        cache.write { store.clear(); null }
    }
}

/** The sealed-at-rest half of [DeviceCredentialVault]; a fake in unit tests. */
internal interface SealedCredentialStore {
    fun seal(token: String)
    /** The stored token, or null when there is none; throws when it cannot be decrypted. */
    fun open(): String?
    fun clear()
}

/** The decrypted token for this process. Shared by every vault instance, since they share one store. */
internal class DeviceCredentialCache {
    private val lock = Any()
    private var token: String? = null

    fun read(load: () -> String?): String? = synchronized(lock) {
        token ?: load()?.also { token = it }
    }

    fun write(change: () -> String?) {
        synchronized(lock) {
            token = null
            token = change()
        }
    }

    companion object { val PROCESS = DeviceCredentialCache() }
}

private class KeystoreCredentialStore(context: Context) : SealedCredentialStore {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences("gateway_credentials", Context.MODE_PRIVATE)

    override fun seal(token: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        prefs.edit()
            .putString(KEY_CIPHERTEXT, Base64.encodeToString(cipher.doFinal(token.toByteArray()), Base64.NO_WRAP))
            .putString(KEY_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
    }

    override fun open(): String? {
        val encrypted = Base64.decode(prefs.getString(KEY_CIPHERTEXT, null), Base64.NO_WRAP)
        val iv = Base64.decode(prefs.getString(KEY_IV, null), Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
        return cipher.doFinal(encrypted).toString(Charsets.UTF_8)
    }

    override fun clear() {
        prefs.edit().clear().apply()
        runCatching { keyStore().deleteEntry(ALIAS) }
    }

    private fun secretKey(): SecretKey {
        val store = keyStore()
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build()
            )
            generateKey()
        }
    }

    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private companion object {
        const val ALIAS = "vodog_gateway_device_credential"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val KEY_CIPHERTEXT = "ciphertext"
        const val KEY_IV = "iv"
    }
}
