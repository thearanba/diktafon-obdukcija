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
    const val KEY_BIO_BLOB = "lock_bio_blob"   // Base64 marker šifrovan biometrijskim ključem
    const val KEY_BIO_IV = "lock_bio_iv"       // Base64 IV tog markera

    // Usporavanje pogađanja lozinke. Brojač uzastopnih promašaja PERZISTIRA — gašenje
    // aplikacije ga ne resetuje, inače bi restart bio besplatan obilazak pauze.
    const val KEY_FAILS = "lock_fails"
    const val KEY_LOCKOUT_UNTIL = "lock_lockout_until"

    /** Prvih toliko promašaja je bez pauze — pogrešan unos rukavicama usred obdukcije
     *  je normalan i ne smije koštati čekanje. */
    const val FREE_ATTEMPTS = 5

    /** Pauza poslije n-tog UZASTOPNOG promašaja; raste do 10 minuta.
     *  Otisak prsta namjerno zaobilazi pauzu (ne može se pogađati), a „Zaboravio sam
     *  lozinku" (brisanje svega) ostaje izlaz za vlasnika. */
    fun lockoutMsFor(fails: Int): Long = when {
        fails < FREE_ATTEMPTS -> 0L
        fails == 5 -> 30_000L
        fails == 6 -> 60_000L
        fails == 7 -> 2 * 60_000L
        fails == 8 -> 5 * 60_000L
        else -> 10 * 60_000L
    }

    const val PBKDF2_ITERATIONS = 120_000

    /** Da li je lozinka uopšte postavljena (prvi ulazak = nije). */
    fun isConfigured(prefs: android.content.SharedPreferences): Boolean =
        !prefs.getString(KEY_HASH, null).isNullOrEmpty()
}
