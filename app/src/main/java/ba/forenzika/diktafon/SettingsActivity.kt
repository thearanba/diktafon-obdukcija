package ba.forenzika.diktafon

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

class SettingsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)

        val prefs = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE)
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

            // Server čita ključeve iz environmenta pri pokretanju, pa novi ključevi
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
