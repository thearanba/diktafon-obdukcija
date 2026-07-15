package ba.forenzika.diktafon

import android.content.Intent
import android.os.Bundle
import android.util.Base64
import android.view.View
import android.webkit.WebStorage
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * Brava aplikacije: lozinka (PBKDF2 hash u šifrovanom skladištu) + opciono otisak prsta.
 *
 * - Prvi ulazak: postavljanje lozinke (unos + potvrda).
 * - Svaki sljedeći hladni start: unos lozinke ILI otisak (ako je omogućen).
 * - "Zaboravljena lozinka" = brisanje SVIH podataka aplikacije (nema servera za reset);
 *   generisani .docx fajlovi u javnom Download folderu ostaju netaknuti.
 */
class LoginActivity : AppCompatActivity() {

    private lateinit var tvSubtitle: TextView
    private lateinit var etPassword: EditText
    private lateinit var etConfirm: EditText
    private lateinit var btnMain: Button
    private lateinit var btnBiometric: Button
    private lateinit var btnForgot: Button

    private val prefs by lazy { SecurePrefs.get(this) }
    private val setupMode: Boolean get() = !AppLock.isConfigured(prefs)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (AppLock.unlocked) { proceed(); return }
        setContentView(R.layout.activity_login)
        supportActionBar?.hide()

        tvSubtitle = findViewById(R.id.tv_login_subtitle)
        etPassword = findViewById(R.id.et_password)
        etConfirm = findViewById(R.id.et_confirm)
        btnMain = findViewById(R.id.btn_login_main)
        btnBiometric = findViewById(R.id.btn_biometric)
        btnForgot = findViewById(R.id.btn_forgot)

        if (setupMode) bindSetupMode() else bindEnterMode()
    }

    // === Prvi ulazak: postavljanje lozinke ===
    private fun bindSetupMode() {
        tvSubtitle.text = getString(R.string.login_setup_subtitle)
        etConfirm.visibility = View.VISIBLE
        btnBiometric.visibility = View.GONE
        btnForgot.visibility = View.GONE
        btnMain.text = getString(R.string.login_btn_set)
        btnMain.setOnClickListener {
            val p1 = etPassword.text.toString()
            val p2 = etConfirm.text.toString()
            when {
                p1.length < 6 ->
                    toast(getString(R.string.login_err_short))
                p1 != p2 ->
                    toast(getString(R.string.login_err_mismatch))
                else -> {
                    savePassword(p1)
                    maybeOfferBiometric(afterSetup = true)
                }
            }
        }
    }

    // === Sljedeći ulasci: otključavanje ===
    private fun bindEnterMode() {
        tvSubtitle.text = getString(R.string.login_enter_subtitle)
        etConfirm.visibility = View.GONE
        btnMain.text = getString(R.string.login_btn_unlock)

        val bioEnabled = prefs.getBoolean(AppLock.KEY_BIO_ENABLED, false)
        val bioAvailable = biometricAvailable()
        btnBiometric.visibility = if (bioEnabled && bioAvailable) View.VISIBLE else View.GONE
        btnBiometric.setOnClickListener { showBiometricPrompt() }

        btnMain.setOnClickListener {
            val waitMs = lockoutRemainingMs()
            if (waitMs > 0) {
                toast(getString(R.string.login_err_lockout, formatWait(waitMs)))
                return@setOnClickListener
            }
            if (verifyPassword(etPassword.text.toString())) {
                clearFailures()
                maybeOfferBiometric(afterSetup = false)
            } else {
                etPassword.text.clear()
                val fails = registerFailure()
                val nextWait = lockoutRemainingMs()
                if (nextWait > 0) {
                    toast(getString(R.string.login_err_lockout, formatWait(nextWait)))
                } else {
                    val left = AppLock.FREE_ATTEMPTS - fails
                    if (left in 1..2) toast(getString(R.string.login_err_wrong_left, left))
                    else toast(getString(R.string.login_err_wrong))
                }
            }
        }

        btnForgot.setOnClickListener { confirmWipe() }

        // Otisak se nudi odmah pri otvaranju (jedan dodir manje)
        if (bioEnabled && bioAvailable) showBiometricPrompt()
    }

    // === Lozinka: PBKDF2 ===
    private fun pbkdf2(password: String, salt: ByteArray, iterations: Int): ByteArray {
        val spec = PBEKeySpec(password.toCharArray(), salt, iterations, 256)
        val skf = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        return skf.generateSecret(spec).encoded
    }

    private fun savePassword(password: String) {
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val hash = pbkdf2(password, salt, AppLock.PBKDF2_ITERATIONS)
        prefs.edit()
            .putString(AppLock.KEY_HASH, Base64.encodeToString(hash, Base64.NO_WRAP))
            .putString(AppLock.KEY_SALT, Base64.encodeToString(salt, Base64.NO_WRAP))
            .putInt(AppLock.KEY_ITER, AppLock.PBKDF2_ITERATIONS)
            .apply()
    }

    // === Usporavanje pogađanja lozinke ===

    /** Koliko još traje pauza (0 = slobodno). */
    private fun lockoutRemainingMs(): Long {
        val until = prefs.getLong(AppLock.KEY_LOCKOUT_UNTIL, 0L)
        return (until - System.currentTimeMillis()).coerceAtLeast(0L)
    }

    /** Zabilježi promašaj i po potrebi postavi pauzu. Vraća ukupan broj promašaja. */
    private fun registerFailure(): Int {
        val fails = prefs.getInt(AppLock.KEY_FAILS, 0) + 1
        val e = prefs.edit().putInt(AppLock.KEY_FAILS, fails)
        val delay = AppLock.lockoutMsFor(fails)
        if (delay > 0) e.putLong(AppLock.KEY_LOCKOUT_UNTIL, System.currentTimeMillis() + delay)
        e.apply()
        return fails
    }

    private fun clearFailures() {
        prefs.edit().remove(AppLock.KEY_FAILS).remove(AppLock.KEY_LOCKOUT_UNTIL).apply()
    }

    private fun formatWait(ms: Long): String {
        val total = (ms + 999) / 1000            // zaokruži naviše — „0 s" zbunjuje
        val min = total / 60
        val sec = total % 60
        return if (min > 0) "$min min $sec s" else "$sec s"
    }

    private fun verifyPassword(password: String): Boolean {
        if (password.isEmpty()) return false
        val hashB64 = prefs.getString(AppLock.KEY_HASH, null) ?: return false
        val saltB64 = prefs.getString(AppLock.KEY_SALT, null) ?: return false
        val iter = prefs.getInt(AppLock.KEY_ITER, AppLock.PBKDF2_ITERATIONS)
        val expected = Base64.decode(hashB64, Base64.NO_WRAP)
        val actual = pbkdf2(password, Base64.decode(saltB64, Base64.NO_WRAP), iter)
        return MessageDigest.isEqual(expected, actual)  // konstantno vrijeme
    }

    // === Otisak prsta ===
    private fun biometricAvailable(): Boolean =
        BiometricManager.from(this).canAuthenticate(BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS

    private fun promptInfo() = BiometricPrompt.PromptInfo.Builder()
        .setTitle(getString(R.string.app_name))
        .setSubtitle(getString(R.string.login_bio_subtitle))
        .setNegativeButtonText(getString(R.string.login_bio_use_password))
        .setAllowedAuthenticators(BIOMETRIC_STRONG)
        .build()

    /** Otključavanje otiskom: otisak otključava Keystore ključ kojim se dešifruje marker.
     *  Nije puka UI potvrda — bez uspješne biometrije Keystore ne da Cipher. */
    private fun showBiometricPrompt() {
        val blob = prefs.getString(AppLock.KEY_BIO_BLOB, null)
        val iv = prefs.getString(AppLock.KEY_BIO_IV, null)
        if (blob.isNullOrEmpty() || iv.isNullOrEmpty()) {
            // Otisak je bio uključen u ranijoj verziji, gdje je bio samo flag bez ključa.
            // Isključujemo ga i tražimo ponovno uključivanje — ali korisniku se MORA reći
            // zašto mu je otisak odjednom nestao.
            disableBiometric()
            toast(getString(R.string.login_bio_reenable))
            return
        }
        val cipher = try {
            BioCrypto.decryptCipher(iv)
        } catch (_: BioCrypto.InvalidatedException) {
            // Dodan/uklonjen otisak na uređaju → ključ poništen; lozinka ostaje izlaz
            disableBiometric()
            toast(getString(R.string.login_bio_invalidated))
            return
        }
        val prompt = BiometricPrompt(
            this, ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val c = result.cryptoObject?.cipher
                    if (c != null && BioCrypto.verifyMarker(c, blob)) {
                        clearFailures()
                        unlock()
                    } else {
                        disableBiometric()
                        toast(getString(R.string.login_bio_invalidated))
                    }
                }
                // Greška/otkaz → korisnik normalno koristi polje za lozinku
            })
        prompt.authenticate(promptInfo(), BiometricPrompt.CryptoObject(cipher))
    }

    /** Isključi otisak i počisti ključ — lozinka ostaje jedini put. */
    private fun disableBiometric() {
        BioSetup.disable(prefs)
        btnBiometric.visibility = View.GONE
    }

    /** Poslije uspješne lozinke: jednom ponudi uključivanje otiska, pa otključaj. */
    private fun maybeOfferBiometric(afterSetup: Boolean) {
        val alreadyEnabled = prefs.getBoolean(AppLock.KEY_BIO_ENABLED, false)
        val alreadyAsked = prefs.getBoolean(AppLock.KEY_BIO_ASKED, false)
        if (alreadyEnabled || (alreadyAsked && !afterSetup) || !biometricAvailable()) {
            unlock(); return
        }
        prefs.edit().putBoolean(AppLock.KEY_BIO_ASKED, true).apply()
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.login_bio_offer_title))
            .setMessage(getString(R.string.login_bio_offer_msg))
            .setPositiveButton(getString(R.string.login_bio_offer_yes)) { _, _ ->
                // Ključ se veže za otisak ODMAH — bez toga bi „uključeno" bio samo flag
                BioSetup.enable(this, prefs) { ok ->
                    if (!ok) toast(getString(R.string.login_bio_failed))
                    unlock()
                }
            }
            .setNegativeButton(getString(R.string.login_bio_offer_no)) { _, _ -> unlock() }
            .setCancelable(false)
            .show()
    }

    // === Zaboravljena lozinka = potpuno brisanje (nema servera za reset) ===
    private fun confirmWipe() {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.login_wipe_title))
            .setMessage(getString(R.string.login_wipe_msg))
            .setPositiveButton(getString(R.string.login_wipe_continue)) { _, _ ->
                AlertDialog.Builder(this)
                    .setTitle(getString(R.string.login_wipe_title2))
                    .setMessage(getString(R.string.login_wipe_msg2))
                    .setPositiveButton(getString(R.string.login_wipe_confirm)) { _, _ -> wipeAll() }
                    .setNegativeButton(getString(R.string.login_cancel), null)
                    .show()
            }
            .setNegativeButton(getString(R.string.login_cancel), null)
            .show()
    }

    private fun wipeAll() {
        try { BioCrypto.deleteKey() } catch (_: Exception) {}
        try { prefs.edit().clear().apply() } catch (_: Exception) {}
        try {
            getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE).edit().clear().apply()
        } catch (_: Exception) {}
        // Python podaci: drafti, output, naučene korekcije
        try { File(filesDir, "data").deleteRecursively() } catch (_: Exception) {}
        // Kopija template-a — bezopasno, kopira se ponovo pri startu
        try { File(filesDir, "app").deleteRecursively() } catch (_: Exception) {}
        // WebView localStorage (keš draftova na JS strani)
        try { WebStorage.getInstance().deleteAllData() } catch (_: Exception) {}
        try { File(applicationInfo.dataDir, "app_webview").deleteRecursively() } catch (_: Exception) {}
        toast(getString(R.string.login_wipe_done))
        recreate()  // nazad na ekran postavljanja lozinke
    }

    private fun unlock() {
        AppLock.unlocked = true
        proceed()
    }

    private fun proceed() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
}
