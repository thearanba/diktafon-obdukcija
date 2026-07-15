package ba.forenzika.diktafon

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Biometrijski ključ u AndroidKeyStore — otisak kao STVARNA brava, ne samo potvrda u UI-ju.
 *
 * Bez ovoga `onAuthenticationSucceeded → unlock()` je gola grana u kodu: ko može da
 * instrumentira proces, preskoči je bez ijednog otiska. Ovdje otisak otključava ključ
 * (`setUserAuthenticationRequired(true)`) kojim se dešifruje marker; bez uspješne
 * biometrije Keystore odbija Cipher, pa nema šta da se preskoči.
 *
 * Ključ se poništava ako se doda/ukloni otisak na uređaju
 * (`setInvalidatedByBiometricEnrollment`) — tada se biometrija isključi, a lozinka
 * ostaje kao izlaz.
 */
object BioCrypto {

    private const val KEY_NAME = "diktafon_bio_key"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORMATION =
        "${KeyProperties.KEY_ALGORITHM_AES}/${KeyProperties.BLOCK_MODE_GCM}/${KeyProperties.ENCRYPTION_PADDING_NONE}"

    /** Sadržaj markera je nebitan — bitno je da se dešifruje SAMO uz otisak. */
    private val MARKER = "diktafon-bio-ok".toByteArray(Charsets.UTF_8)

    /** Signal pozivaocu da je ključ propao (nov otisak na uređaju, wipe Keystore-a...). */
    class InvalidatedException(cause: Throwable?) : Exception(cause)

    private fun keystore(): KeyStore =
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? =
        try { keystore().getKey(KEY_NAME, null) as? SecretKey } catch (_: Exception) { null }

    private fun createKey(): SecretKey {
        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        kg.init(
            KeyGenParameterSpec.Builder(
                KEY_NAME,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true)
                .build()
        )
        return kg.generateKey()
    }

    fun deleteKey() {
        try { keystore().deleteEntry(KEY_NAME) } catch (_: Exception) {}
    }

    /** Cipher za UPIS markera (uključivanje otiska). Ide u BiometricPrompt.CryptoObject. */
    fun encryptCipher(): Cipher {
        deleteKey()  // svjež ključ pri svakom uključivanju — bez zaostalog stanja
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, createKey())
        return cipher
    }

    /** Cipher za ČITANJE markera (otključavanje). Baca InvalidatedException ako je
     *  ključ poništen (nov otisak) — pozivalac tada isključi biometriju i traži lozinku. */
    fun decryptCipher(ivB64: String): Cipher {
        val key = existingKey() ?: throw InvalidatedException(null)
        return try {
            val iv = Base64.decode(ivB64, Base64.NO_WRAP)
            Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
            }
        } catch (e: android.security.keystore.KeyPermanentlyInvalidatedException) {
            throw InvalidatedException(e)
        } catch (e: Exception) {
            throw InvalidatedException(e)
        }
    }

    /** Šifruj marker cipher-om koji je BiometricPrompt već autentikovao.
     *  Vraća (blobB64, ivB64) za upis u SecurePrefs. */
    fun sealMarker(cipher: Cipher): Pair<String, String> {
        val blob = cipher.doFinal(MARKER)
        return Base64.encodeToString(blob, Base64.NO_WRAP) to
            Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
    }

    /** Provjeri marker autentikovanim cipher-om. false = ne otključavaj. */
    fun verifyMarker(cipher: Cipher, blobB64: String): Boolean = try {
        cipher.doFinal(Base64.decode(blobB64, Base64.NO_WRAP)).contentEquals(MARKER)
    } catch (_: Exception) {
        false
    }
}
