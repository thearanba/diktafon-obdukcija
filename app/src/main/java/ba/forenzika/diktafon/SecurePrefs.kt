package ba.forenzika.diktafon

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Šifrovano skladište (EncryptedSharedPreferences, AES-256 preko hardverskog Keystore-a)
 * za API ključeve i hash lozinke. Pri prvom pristupu migrira ključeve iz starih
 * (nešifrovanih) SharedPreferences i briše ih tamo.
 *
 * Fallback: ako Keystore zakaže (rijetki OEM bugovi), pada na obične prefs sa logom —
 * aplikacija radi, samo bez šifrovanja na disku.
 */
object SecurePrefs {
    private const val NAME = "diktafon_secure"

    @Volatile
    private var cached: SharedPreferences? = null

    fun get(context: Context): SharedPreferences {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            val appCtx = context.applicationContext
            val prefs = try {
                val masterKey = MasterKey.Builder(appCtx)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build()
                EncryptedSharedPreferences.create(
                    appCtx, NAME, masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
                )
            } catch (e: Throwable) {
                // Throwable (ne samo Exception): i LinkageError iz Tink/Keystore sloja
                // treba da završi u fallback-u, ne kao pad aplikacije
                Log.e(MainActivity.TAG, "SecurePrefs: Keystore fail, fallback na plain: ${e.message}", e)
                appCtx.getSharedPreferences(NAME + "_fallback", Context.MODE_PRIVATE)
            }
            migrateLegacyKeys(appCtx, prefs)
            cached = prefs
            return prefs
        }
    }

    /** Jednokratna migracija API ključeva iz starih nešifrovanih prefs. */
    private fun migrateLegacyKeys(context: Context, secure: SharedPreferences) {
        try {
            val old = context.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE)
            val anthropic = old.getString(MainActivity.KEY_ANTHROPIC, null)
            val groq = old.getString(MainActivity.KEY_GROQ, null)
            if (anthropic.isNullOrEmpty() && groq.isNullOrEmpty()) return
            val ed = secure.edit()
            if (!anthropic.isNullOrEmpty() && !secure.contains(MainActivity.KEY_ANTHROPIC)) {
                ed.putString(MainActivity.KEY_ANTHROPIC, anthropic)
            }
            if (!groq.isNullOrEmpty() && !secure.contains(MainActivity.KEY_GROQ)) {
                ed.putString(MainActivity.KEY_GROQ, groq)
            }
            ed.apply()
            old.edit()
                .remove(MainActivity.KEY_ANTHROPIC)
                .remove(MainActivity.KEY_GROQ)
                .apply()
            Log.i(MainActivity.TAG, "SecurePrefs: API ključevi migrirani u šifrovano skladište.")
        } catch (e: Exception) {
            Log.e(MainActivity.TAG, "SecurePrefs migracija: ${e.message}", e)
        }
    }
}
