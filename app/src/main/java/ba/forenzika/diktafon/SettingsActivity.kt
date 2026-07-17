package ba.forenzika.diktafon

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

class SettingsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        // Privatnost: API ključevi ne trebaju u recents-pregled
        if (android.os.Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)

        // API ključevi žive u šifrovanom skladištu (SecurePrefs) — ostaje i bez brave.
        // Nermin verzija nema bravu, pa nema ni prekidača za otisak (vidi MainActivity).
        val prefs = SecurePrefs.get(this)
        val etAnthropic = findViewById<EditText>(R.id.et_anthropic)
        val etGroq = findViewById<EditText>(R.id.et_groq)
        val btnSave = findViewById<Button>(R.id.btn_save)

        etAnthropic.setText(prefs.getString(MainActivity.KEY_ANTHROPIC, ""))
        etGroq.setText(prefs.getString(MainActivity.KEY_GROQ, ""))

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
