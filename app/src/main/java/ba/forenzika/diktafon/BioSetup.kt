package ba.forenzika.diktafon

import android.content.SharedPreferences
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricPrompt
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.core.content.ContextCompat

/**
 * Uključivanje/isključivanje otiska — JEDNO mjesto za oba ekrana (Login i Postavke).
 *
 * Uključivanje NIJE samo flag: traži se otisak odmah i njime se zapečati marker
 * Keystore ključem (`BioCrypto`). Bez toga bi „uključeno" u Postavkama značilo samo
 * `true` u prefs-u, a otključavanje bi pri prvom pokušaju tiho palo na lozinku.
 */
object BioSetup {

    /** onDone(true) = otisak stvarno uključen (ključ napravljen, marker zapečaćen). */
    fun enable(activity: AppCompatActivity, prefs: SharedPreferences, onDone: (Boolean) -> Unit) {
        val cipher = try {
            BioCrypto.encryptCipher()
        } catch (_: Exception) {
            onDone(false); return
        }
        val prompt = BiometricPrompt(
            activity, ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val c = result.cryptoObject?.cipher
                    if (c == null) { onDone(false); return }
                    val ok = try {
                        val (blob, iv) = BioCrypto.sealMarker(c)
                        prefs.edit()
                            .putBoolean(AppLock.KEY_BIO_ENABLED, true)
                            .putBoolean(AppLock.KEY_BIO_ASKED, true)
                            .putString(AppLock.KEY_BIO_BLOB, blob)
                            .putString(AppLock.KEY_BIO_IV, iv)
                            .apply()
                        true
                    } catch (_: Exception) {
                        false
                    }
                    onDone(ok)
                }
                override fun onAuthenticationError(code: Int, msg: CharSequence) = onDone(false)
                override fun onAuthenticationFailed() { /* prompt ostaje otvoren */ }
            })
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(activity.getString(R.string.app_name))
            .setSubtitle(activity.getString(R.string.login_bio_subtitle))
            .setNegativeButtonText(activity.getString(R.string.login_cancel))
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .build()
        prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    /** Isključi otisak i uništi ključ — lozinka ostaje jedini put. */
    fun disable(prefs: SharedPreferences) {
        BioCrypto.deleteKey()
        prefs.edit()
            .putBoolean(AppLock.KEY_BIO_ENABLED, false)
            .remove(AppLock.KEY_BIO_BLOB)
            .remove(AppLock.KEY_BIO_IV)
            .apply()
    }
}
