package ba.forenzika.diktafon

import android.Manifest
import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.view.Menu
import android.view.MenuItem
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.ValueCallback
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import com.chaquo.python.PyObject
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    companion object {
        const val TAG = "Diktafon"
        const val PREFS = "diktafon_prefs"
        const val KEY_ANTHROPIC = "anthropic_key"
        const val KEY_GROQ = "groq_key"
        const val MENU_SETTINGS = 1
        const val MENU_RELOAD = 2
        const val REQ_AUDIO = 100
        const val REQ_FILE = 200
        const val BASE_URL = "https://appassets.androidplatform.net/index.html"
    }

    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private val pyExecutor = Executors.newFixedThreadPool(4)
    @Volatile private var pyApi: PyObject? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var cameraPhotoUri: Uri? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Brava aplikacije: hladni start (ili direktan vanjski poziv) bez otključavanja
        // ide na LoginActivity. Flag živi u procesu → povratak iz pozadine ne traži ponovo.
        if (!AppLock.unlocked) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }

        webView = WebView(this)
        setContentView(webView)
        // Sakrij nativnu ActionBar — naslov + meni su sada u HTML traci (štedi prostor,
        // uklanja dupli „Diktafon obdukcija").
        supportActionBar?.hide()

        // Privatnost: u listi nedavnih aplikacija NE prikazuj snimak sadržaja
        // (imena pokojnika). Ručni screenshotovi korisnika i dalje rade (nije FLAG_SECURE).
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebAssetHandler(this))
            .build()

        configureWebView()

        // Runtime dozvole: mikrofon (diktiranje) + lokacija (GPS uviđaja) — traži nedostajuće
        val missing = arrayOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.ACCESS_FINE_LOCATION,
        ).filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), REQ_AUDIO)
        }

        // API ključevi iz šifrovanog skladišta (SecurePrefs migrira stare pri prvom pristupu)
        val prefs = SecurePrefs.get(this)
        val anthropic = prefs.getString(KEY_ANTHROPIC, "") ?: ""
        val groq = prefs.getString(KEY_GROQ, "") ?: ""
        if (anthropic.isBlank() && groq.isBlank()) {
            Toast.makeText(this, getString(R.string.first_run_keys), Toast.LENGTH_LONG).show()
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        Thread { bootstrapPython(anthropic, groq) }.start()
    }

    private fun configureWebView() {
        // chrome://inspect debugging ISKLJUČEN: distribuirani APK je debug-potpisan pa
        // BuildConfig.DEBUG gate ne pomaže, a sadržaj (imena pokojnika, KT brojevi,
        // draftovi) je osjetljiv — uz uključen USB debugging bio bi čitljiv sa računara.
        // Za testiranje privremeno vratiti na true.
        WebView.setWebContentsDebuggingEnabled(false)
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(true)   // GPS lokacija uviđaja (navigator.geolocation)
        }
        webView.addJavascriptInterface(AndroidBridge(), "AndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView, request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            // SIGURNOST: dozvoli navigaciju SAMO na lokalni appassets host. Svaki drugi
            // link (npr. u tekstu koji vrati Claude, ili slučajan <a href>) NE smije
            // učitati udaljenu stranicu u ovom WebView-u — ona bi dobila pun pristup
            // AndroidBridge mostu (čitanje/pisanje draftova, dijeljenje). Eksterni linkovi
            // se otvaraju u sistemskom browseru; sve ostalo se blokira.
            override fun shouldOverrideUrlLoading(
                view: WebView, request: WebResourceRequest
            ): Boolean {
                val url = request.url
                if (url.host == "appassets.androidplatform.net") return false  // dozvoli (naša app)
                if (url.scheme == "http" || url.scheme == "https") {
                    try { startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (_: Exception) {}
                }
                return true  // sve ostalo: NE učitavaj u WebView-u
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                // Odobri SAMO ako zahtjev dolazi s našeg appassets origina i SAMO mikrofon.
                val ok = request.origin?.host == "appassets.androidplatform.net"
                val wanted = request.resources.filter {
                    it == PermissionRequest.RESOURCE_AUDIO_CAPTURE
                }.toTypedArray()
                if (ok && wanted.isNotEmpty()) request.grant(wanted) else request.deny()
            }

            override fun onGeolocationPermissionsShowPrompt(
                origin: String?, callback: GeolocationPermissions.Callback?
            ) {
                // Geolokaciju odobri SAMO našem appassets originu (sistemsku runtime
                // dozvolu ACCESS_FINE_LOCATION traži onCreate).
                val ok = origin != null && origin.contains("appassets.androidplatform.net")
                callback?.invoke(origin, ok, false)
            }

            override fun onConsoleMessage(msg: android.webkit.ConsoleMessage): Boolean {
                Log.d(TAG, "WebView: ${msg.message()} @${msg.sourceId()}:${msg.lineNumber()}")
                return true
            }

            // Omogući <input type="file"> (Auto-popuni iz naredbe):
            // birač fajlova (PDF/slika) + opcija da se naredba SLIKA kamerom.
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: WebChromeClient.FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                cameraPhotoUri = null
                return try {
                    if (params.isCaptureEnabled) {
                        // <input capture> → kamera DIREKTNO (📷 Slikaj)
                        val cam = createCameraIntent()
                        startActivityForResult(cam ?: params.createIntent(), REQ_FILE)
                    } else {
                        // Bez capture → birač fajlova (📁 Fajl: PDF/slika)
                        startActivityForResult(params.createIntent(), REQ_FILE)
                    }
                    true
                } catch (e: Exception) {
                    Log.e(TAG, "onShowFileChooser greška: ${e.message}", e)
                    filePathCallback = null
                    false
                }
            }
        }
    }

    /** Intent za fotografisanje naredbe; slika ide u app-cache preko FileProvider-a. */
    private fun createCameraIntent(): Intent? {
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
        if (intent.resolveActivity(packageManager) == null) return null
        return try {
            val dir = File(cacheDir, "camera").apply { mkdirs() }
            val file = File(dir, "naredba_${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
            cameraPhotoUri = uri
            intent.putExtra(MediaStore.EXTRA_OUTPUT, uri)
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            intent
        } catch (e: Exception) {
            Log.e(TAG, "createCameraIntent greška: ${e.message}", e)
            null
        }
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FILE) {
            val cb = filePathCallback
            filePathCallback = null
            if (cb == null) return
            var result: Array<Uri>? = null
            if (resultCode == Activity.RESULT_OK) {
                if (data == null || (data.data == null && data.clipData == null)) {
                    // Kamera je upisala sliku u cameraPhotoUri (ne vraća data)
                    cameraPhotoUri?.let { result = arrayOf(it) }
                } else {
                    result = WebChromeClient.FileChooserParams.parseResult(resultCode, data)
                }
            }
            cb.onReceiveValue(result)
            cameraPhotoUri = null
        }
    }

    private fun bootstrapPython(anthropic: String, groq: String) {
        try {
            // Privatnost: fotografije naredbi i podijeljeni .docx iz ranijih sesija
            // ne trebaju ležati u kešu (share fajl je do sada već poslan)
            try { File(cacheDir, "camera").deleteRecursively() } catch (_: Exception) {}
            try { File(cacheDir, "share").deleteRecursively() } catch (_: Exception) {}

            val appDir = File(filesDir, "app")
            val dataDir = File(filesDir, "data")
            dataDir.mkdirs()
            // Kopiraj samo Python podatke (template + examples) iz assets/pydata
            copyAssetDir("pydata", appDir)

            if (!Python.isStarted()) Python.start(AndroidPlatform(this))
            val py = Python.getInstance()
            val environ = py.getModule("os").get("environ")!!
            fun setenv(k: String, v: String) = environ.callAttr("__setitem__", k, v)
            setenv("DIKTAFON_APP_DIR", appDir.absolutePath)
            setenv("DIKTAFON_DATA_DIR", dataDir.absolutePath)
            setenv("ANTHROPIC_API_KEY", anthropic)
            setenv("GROQ_API_KEY", groq)

            // Import modula POSLIJE postavljanja env-a (modul čita env pri importu)
            pyApi = py.getModule("android_api")
            Log.i(TAG, "Python spreman.")

            runOnUiThread { webView.loadUrl(BASE_URL) }
        } catch (e: Throwable) {
            Log.e(TAG, "Bootstrap greška: ${e.message}", e)
            runOnUiThread {
                Toast.makeText(this, "Greška pokretanja Python-a: ${e.message}",
                    Toast.LENGTH_LONG).show()
            }
        }
    }

    // Rekurzivno kopira assets/<assetPath> u dest (overwrite — uvijek svjež template).
    private fun copyAssetDir(assetPath: String, dest: File) {
        val children = assets.list(assetPath) ?: emptyArray()
        if (children.isEmpty()) {
            assets.open(assetPath).use { input ->
                dest.parentFile?.mkdirs()
                dest.outputStream().use { input.copyTo(it) }
            }
            return
        }
        dest.mkdirs()
        for (child in children) copyAssetDir("$assetPath/$child", File(dest, child))
    }

    // === JS → Python most ===
    inner class AndroidBridge {
        /** Asinhroni poziv Python dispatch-a. Rezultat se vraća JS-u preko __nativeResolve. */
        @JavascriptInterface
        fun call(reqId: String, endpoint: String, payloadJson: String) {
            pyExecutor.execute {
                val resultJson = try {
                    val api = pyApi ?: throw IllegalStateException("Python još nije spreman")
                    api.callAttr("dispatch", endpoint, payloadJson).toString()
                } catch (e: Throwable) {
                    Log.e(TAG, "dispatch($endpoint) greška: ${e.message}", e)
                    """{"__error":true,"status":500,"detail":${jsonString(e.message ?: "greška")}}"""
                }
                val b64 = Base64.encodeToString(
                    resultJson.toByteArray(Charsets.UTF_8), Base64.NO_WRAP
                )
                webView.post {
                    webView.evaluateJavascript(
                        "window.__nativeResolve && window.__nativeResolve('$reqId','$b64')", null
                    )
                }
            }
        }

        /** Otvori ekran Postavke (API ključevi) — poziva se iz HTML ⋮ menija. */
        @JavascriptInterface
        fun openSettings() {
            runOnUiThread {
                startActivity(Intent(this@MainActivity, SettingsActivity::class.java))
            }
        }

        /** Obrnuto geokodiranje NATIVNIM Android Geocoder-om (GPS uviđaja → adresa).
         *  Async: rezultat {"address": "Ulica broj, Grad"} ide nazad kroz __nativeResolve. */
        @JavascriptInterface
        fun reverseGeocode(reqId: String, lat: Double, lng: Double) {
            pyExecutor.execute {
                val address = try {
                    @Suppress("DEPRECATION")
                    val list = android.location.Geocoder(
                        this@MainActivity, java.util.Locale("bs", "BA")
                    ).getFromLocation(lat, lng, 1)
                    val a = list?.firstOrNull()
                    if (a == null) "" else {
                        val street = listOfNotNull(a.thoroughfare, a.subThoroughfare)
                            .joinToString(" ").trim()
                        val city = a.locality ?: a.subAdminArea ?: ""
                        val parts = mutableListOf<String>()
                        if (street.isNotBlank()) parts.add(street)
                        if (city.isNotBlank()) parts.add(city)
                        if (parts.isEmpty()) (a.getAddressLine(0) ?: "") else parts.joinToString(", ")
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "reverseGeocode: ${e.message}")
                    ""
                }
                val json = """{"address":${jsonString(address)}}"""
                val b64 = Base64.encodeToString(json.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
                webView.post {
                    webView.evaluateJavascript(
                        "window.__nativeResolve && window.__nativeResolve('$reqId','$b64')", null
                    )
                }
            }
        }

        /** Snimi proizvoljan fajl (base64) u javni Download folder — npr. ZIP izvoz draftova. */
        @JavascriptInterface
        fun saveFile(filename: String, base64Data: String, mime: String) {
            try {
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, filename)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("MediaStore insert vratio null")
                resolver.openOutputStream(uri).use { it!!.write(bytes) }
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                runOnUiThread {
                    Toast.makeText(this@MainActivity,
                        "Snimljeno u Download: $filename", Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                Log.e(TAG, "saveFile greška: ${e.message}", e)
                runOnUiThread {
                    Toast.makeText(this@MainActivity,
                        "Greška snimanja: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }

        /** „Generiši i podijeli": share sheet — jedini pouzdan put do OneDrive-a
         *  (OneDrive NE podržava SAF kreiranje pa se ne pojavljuje u „Generiši u…").
         *  Fajl ide u cache/share preko FileProvider-a; pri startu se keš čisti. */
        @JavascriptInterface
        fun shareDocx(filename: String, base64Data: String) {
            try {
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                val safeName = if (filename.endsWith(".docx")) filename else "$filename.docx"
                val dir = File(cacheDir, "share").apply { mkdirs() }
                val f = File(dir, safeName)
                f.writeBytes(bytes)
                val uri = FileProvider.getUriForFile(
                    this@MainActivity, "$packageName.fileprovider", f)
                val mime =
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = mime
                    putExtra(Intent.EXTRA_STREAM, uri)
                    putExtra(Intent.EXTRA_SUBJECT, safeName)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                runOnUiThread {
                    startActivity(Intent.createChooser(send, "Podijeli zapisnik"))
                }
            } catch (e: Exception) {
                Log.e(TAG, "shareDocx greška: ${e.message}", e)
                runOnUiThread {
                    Toast.makeText(this@MainActivity,
                        "Greška dijeljenja: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }

        /** Snimi generisani .docx (base64) u javni Download folder + ponudi otvaranje. */
        @JavascriptInterface
        fun saveDocx(filename: String, base64: String) {
            try {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                val safeName = if (filename.endsWith(".docx")) filename else "$filename.docx"
                val mime =
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("MediaStore insert vratio null")
                resolver.openOutputStream(uri).use { it!!.write(bytes) }
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)

                runOnUiThread {
                    Toast.makeText(this@MainActivity,
                        "Snimljeno u Download: $safeName", Toast.LENGTH_LONG).show()
                    openDocx(uri, mime)
                }
            } catch (e: Exception) {
                Log.e(TAG, "saveDocx greška: ${e.message}", e)
                runOnUiThread {
                    Toast.makeText(this@MainActivity,
                        "Greška snimanja: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun openDocx(uri: Uri, mime: String) {
        try {
            val view = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mime)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(view, "Otvori zapisnik"))
        } catch (e: Exception) {
            Log.w(TAG, "Nema aplikacije za .docx: ${e.message}")
        }
    }

    // === Meni ===
    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(0, MENU_SETTINGS, 0, getString(R.string.settings_title))
            .setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
        menu.add(0, MENU_RELOAD, 1, getString(R.string.menu_reload))
            .setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        MENU_SETTINGS -> { startActivity(Intent(this, SettingsActivity::class.java)); true }
        MENU_RELOAD -> { if (pyApi != null) webView.loadUrl(BASE_URL); true }
        else -> super.onOptionsItemSelected(item)
    }

    // „Back" dugme: ako je u WebView-u otvoren fokus-kokpit / overlay / modal, back radi
    // KORAK NAZAD (zatvori ga) umjesto da obori aplikaciju na home screen. JS `onAndroidBack`
    // vrati '1' ako je nešto zatvorio; inače (na listi/home) ide na home screen.
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (!::webView.isInitialized) { super.onBackPressed(); return }
        webView.evaluateJavascript(
            "(window.onAndroidBack && window.onAndroidBack()) ? '1' : '0'"
        ) { result ->
            if (result?.contains("1") != true) {
                moveTaskToBack(true)   // nema šta zatvoriti → na home (app ostaje u pozadini)
            }
        }
    }

    override fun onDestroy() {
        // Guard-put (preusmjerenje na LoginActivity) završi PRIJE inicijalizacije webView-a —
        // bezuslovni destroy() bi tu bacio UninitializedPropertyAccessException (pad pri startu)
        if (::webView.isInitialized) webView.destroy()
        pyExecutor.shutdownNow()
        super.onDestroy()
    }

    // === Pomoćno: serviranje web asseta iz assets/web ===
    class WebAssetHandler(ctx: Context) : WebViewAssetLoader.PathHandler {
        private val am = ctx.assets
        override fun handle(path: String): WebResourceResponse? {
            val rel = path.trimStart('/').ifEmpty { "index.html" }
            return try {
                val stream = am.open("web/$rel")
                WebResourceResponse(mimeOf(rel), null, stream)
            } catch (e: IOException) {
                WebResourceResponse(
                    "text/plain", "utf-8", 404, "Not Found",
                    emptyMap<String, String>(), ByteArrayInputStream(ByteArray(0))
                )
            }
        }

        private fun mimeOf(name: String): String = when {
            name.endsWith(".html") -> "text/html"
            name.endsWith(".js") -> "application/javascript"
            name.endsWith(".css") -> "text/css"
            name.endsWith(".json") || name.endsWith(".webmanifest") -> "application/json"
            name.endsWith(".svg") -> "image/svg+xml"
            name.endsWith(".png") -> "image/png"
            else -> "application/octet-stream"
        }
    }

    private fun jsonString(s: String): String {
        val sb = StringBuilder("\"")
        for (c in s) when (c) {
            '"' -> sb.append("\\\"")
            '\\' -> sb.append("\\\\")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            else -> sb.append(c)
        }
        return sb.append("\"").toString()
    }
}
