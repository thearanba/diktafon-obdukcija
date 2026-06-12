package ba.forenzika.diktafon

import android.app.Application
import android.content.ContentValues
import android.provider.MediaStore
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Globalni crash-logger: svaki nepokupljeni pad upiše kompletan stack trace u javni
 * Download folder (diktafon_crash_*.txt), pa se uzrok vidi bez adb/logcat-a.
 * Nakon upisa pad se proslijedi sistemskom handleru (normalan crash dijalog).
 */
class App : Application() {

    override fun onCreate() {
        super.onCreate()
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            try { writeCrashFile(e) } catch (_: Throwable) {}
            previous?.uncaughtException(thread, e)
        }
    }

    private fun writeCrashFile(e: Throwable) {
        val sw = StringWriter()
        sw.append("Diktafon obdukcija — crash report\n")
        sw.append(SimpleDateFormat("dd.MM.yyyy HH:mm:ss", Locale.US).format(Date()))
        sw.append("\n\n")
        e.printStackTrace(PrintWriter(sw))
        val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, "diktafon_crash_$stamp.txt")
            put(MediaStore.Downloads.MIME_TYPE, "text/plain")
        }
        val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: return
        contentResolver.openOutputStream(uri)?.use { os ->
            os.write(sw.toString().toByteArray(Charsets.UTF_8))
        }
    }
}
