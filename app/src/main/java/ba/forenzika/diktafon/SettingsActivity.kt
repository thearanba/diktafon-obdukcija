package ba.forenzika.diktafon

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG

class SettingsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)

        // API ključevi + brava žive u šifrovanom skladištu (SecurePrefs)
        val prefs = SecurePrefs.get(this)
        val etAnthropic = findViewById<EditText>(R.id.et_anthropic)
        val etGroq = findViewById<EditText>(R.id.et_groq)
        val btnSave = findViewById<Button>(R.id.btn_save)
        val swBiometric = findViewById<SwitchCompat>(R.id.sw_biometric)

        etAnthropic.setText(prefs.getString(MainActivity.KEY_ANTHROPIC, ""))
        etGroq.setText(prefs.getString(MainActivity.KEY_GROQ, ""))

        // Prekidač za otisak: vidljiv samo kad je lozinka postavljena i uređaj ima biometriju
        val bioAvailable = BiometricManager.from(this)
            .canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
        if (AppLock.isConfigured(prefs) && bioAvailable) {
            swBiometric.visibility = android.view.View.VISIBLE
            swBiometric.isChecked = prefs.getBoolean(AppLock.KEY_BIO_ENABLED, false)
            swBiometric.setOnCheckedChangeListener { _, checked ->
                prefs.edit()
                    .putBoolean(AppLock.KEY_BIO_ENABLED, checked)
                    .putBoolean(AppLock.KEY_BIO_ASKED, true)
                    .apply()
            }
        }

        btnSave.setOnClickListener {
            prefs.edit()
                .putString(MainActivity.KEY_ANTHROPIC, etAnthropic.text.toString().trim())
                .putString(MainActivity.KEY_GROQ, etGroq.text.toString().trim())
                .apply()

            // Python čita ključeve iz environmenta pri pokretanju, pa novi ključevi
            // zahtijevaju svjež start procesa. Zatvori app — korisnik je ponovo otvori.
            AlertDialog.Builder(this)
                .setTitle("Sačuvano")
                .setMessage("Ključevi su sačuvani. Aplikacija će se zatvoriti — otvori je ponovo da se primijene.")
                .setCancelable(false)
                .setPositiveButton("Zatvori") { _, _ ->
                    finishAffinity()
                    Runtime.getRuntime().exit(0)
                }
                .show()
        }
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
        return true
    }
}
