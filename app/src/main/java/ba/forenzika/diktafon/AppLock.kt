package ba.forenzika.diktafon

/**
 * Stanje brave aplikacije za životni vijek PROCESA.
 *
 * Politika (odluka korisnika): otključavanje se traži SAMO pri hladnom pokretanju.
 * Flag živi u memoriji procesa — povratak iz pozadine ga zatiče na true (bez ponovnog
 * otključavanja), a kad Android ubije proces, sljedeće pokretanje opet traži lozinku/otisak.
 */
object AppLock {
    @Volatile
    var unlocked: Boolean = false

    // Ključevi u SecurePrefs
    const val KEY_HASH = "lock_hash"          // Base64 PBKDF2 hash lozinke
    const val KEY_SALT = "lock_salt"          // Base64 so
    const val KEY_ITER = "lock_iter"          // broj iteracija (za buduće podizanje)
    const val KEY_BIO_ENABLED = "lock_bio_enabled"
    const val KEY_BIO_ASKED = "lock_bio_asked"

    const val PBKDF2_ITERATIONS = 120_000

    /** Da li je lozinka uopšte postavljena (prvi ulazak = nije). */
    fun isConfigured(prefs: android.content.SharedPreferences): Boolean =
        !prefs.getString(KEY_HASH, null).isNullOrEmpty()
}
