// ReaLingo's Android bridge: the runtime permissions, settings deep links, keep-screen-on
// flag and file picker the phone shell needs, exposed to the webview as
// window.ReaLingoAndroid. Modeled on LittleLobby's MainActivity, which proved this
// pattern end to end; the Rust JNI experiment is gone — Tauri's AppHandle offers no
// stable Activity accessor, and fighting the jni lifetimes in CI was losing rounds,
// not lessons.
//
// JavascriptInterface methods run on the WebView's JavaBridge thread: anything touching
// the window or starting activities hops through runOnUiThread. Long work (the SAF copy)
// runs on a plain thread; the frontend polls, exactly like it polls micStatus after
// requestMic — Android hands no JS callback for either.
package com.nosugark.realingo

import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.WindowManager
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import java.io.File
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject
import androidx.annotation.Keep
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
    @Volatile private var keepFlag = WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
    @Volatile private var micRequesting = false
    private var systemRequestPending = false

    // One-slot result for the file picker: busy while the dialog/copy lives, then a
    // terminal JSON the frontend reads and resets. "picked" carries a real path the
    // decode pipeline can open (the SAF content:// uri is copied into cache first).
    private val pick = AtomicReference("""{"state":"idle"}""")
    private val pickThread = AtomicReference<Thread?>(null)
    private val exportState = AtomicReference("""{"state":"idle"}""")
    private var exportContents: String? = null

    // WebView resolves these names through reflection, outside R8's call graph.
    @Keep
    inner class Bridge {
        /// {"granted":bool,"rationale":bool} — the same shape the Rust command answered,
        /// so the state machine in src/mobile/perms.ts did not change: rationale is the
        /// line between "denied once" and "never ask again".
        @JavascriptInterface
        fun micStatus(): String {
            val granted = checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
            val rationale = shouldShowRequestPermissionRationale(android.Manifest.permission.RECORD_AUDIO)
            return """{"granted":$granted,"rationale":$rationale,"requesting":$micRequesting}"""
        }

        @JavascriptInterface
        fun requestMic() {
            if (micRequesting) return
            micRequesting = true
            runOnUiThread {
                try {
                    requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), REQUEST_MIC)
                } catch (_: RuntimeException) {
                    micRequesting = false
                }
            }
        }

        @JavascriptInterface
        fun notifEnabled(): Boolean =
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).areNotificationsEnabled()

        @JavascriptInterface
        fun batteryIgnored(): Boolean {
            val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
            return pm.isIgnoringBatteryOptimizations(packageName)
        }

        @JavascriptInterface
        fun openAppSettings() {
            runOnUiThread {
                try {
                    startActivity(
                        Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:$packageName"),
                        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                } catch (_: ActivityNotFoundException) {}
            }
        }

        @JavascriptInterface
        fun openBatterySettings() {
            runOnUiThread {
                try {
                    startActivity(
                        Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                } catch (_: ActivityNotFoundException) {}
            }
        }

        @JavascriptInterface
        fun setKeepScreenOn(on: Boolean) {
            runOnUiThread {
                if (on) window.addFlags(keepFlag) else window.clearFlags(keepFlag)
            }
        }

        @JavascriptInterface fun overlayStatus(): String = SubtitleService.state(this@MainActivity)
        @JavascriptInterface fun systemAudioSupported(): Boolean = Build.VERSION.SDK_INT >= 29
        @JavascriptInterface fun requestOverlay() {
            runOnUiThread {
                try { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))) }
                catch (_: ActivityNotFoundException) { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
            }
        }
        @JavascriptInterface fun showOverlay(show: Boolean) {
            runOnUiThread {
                if (!show || Settings.canDrawOverlays(this@MainActivity)) SubtitleService.setVisible(this@MainActivity, show)
            }
        }
        @JavascriptInterface fun updateOverlay(json: String) { runOnUiThread { SubtitleService.update(json) } }
        @JavascriptInterface fun resetOverlayPosition() { runOnUiThread { SubtitleService.resetPosition(this@MainActivity) } }
        @JavascriptInterface fun startCapture(kind: String) {
            if (kind != "mic" && kind != "file") return
            runOnUiThread { SubtitleService.begin(this@MainActivity, kind) }
        }
        @JavascriptInterface fun stopCapture() { runOnUiThread { systemRequestPending = false; SubtitleService.endCapture(this@MainActivity) } }
        @JavascriptInterface fun requestSystemAudio() {
            runOnUiThread {
                if (systemRequestPending) return@runOnUiThread
                if (Build.VERSION.SDK_INT < 29) { SubtitleService.lastError = "System audio requires Android 10+"; SubtitleService.systemState = "error"; return@runOnUiThread }
                SubtitleService.systemState = "asking"
                systemRequestPending = true
                SubtitleService.lastError = ""
                try {
                    val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                    val intent = if (Build.VERSION.SDK_INT >= 34) manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
                        else manager.createScreenCaptureIntent()
                    startActivityForResult(intent, REQUEST_SYSTEM_AUDIO)
                } catch (e: RuntimeException) { SubtitleService.lastError = e.message ?: "Cannot request system audio"; SubtitleService.systemState = "error" }
            }
        }

        @JavascriptInterface fun saveText(name: String, contents: String) {
            if (contents.length > 5_000_000) { exportState.set("""{"state":"error","error":"Export exceeds 5 MB"}"""); return }
            exportState.set("""{"state":"busy"}""")
            runOnUiThread {
                exportContents = contents
                try {
                    startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "text/plain"
                        putExtra(Intent.EXTRA_TITLE, name.substringAfterLast('/').substringAfterLast('\\').take(160))
                    }, REQUEST_EXPORT)
                } catch (e: RuntimeException) {
                    exportContents = null
                    exportState.set(JSONObject().put("state", "error").put("error", e.message).toString())
                }
            }
        }
        @JavascriptInterface fun saveTextResult(): String = exportState.get()

        // Device identity must not query Wi-Fi/location services without permissions.
        @JavascriptInterface
        fun deviceName(): String {
            return "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        }

        /// Opens the system document picker. The result arrives via onActivityResult on
        /// the UI thread; copy runs on a worker; pickResult() reports the states.
        @JavascriptInterface
        fun pickAudioFile() {
            pick.set("""{"state":"busy"}""")
            runOnUiThread {
                try {
                    startActivityForResult(
                        Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = "audio/*"
                        },
                        PICK_AUDIO,
                    )
                } catch (_: ActivityNotFoundException) {
                    pick.set("""{"state":"error"}""")
                }
            }
        }

        @JavascriptInterface
        fun pickResult(): String {
            val s = pick.get()
            // One-shot: a consumed terminal state falls back to idle so the watch in
            // MobileApp can prompt again next time instead of replaying the old path.
            if (s != """{"state":"busy"}""" && s != """{"state":"idle"}""") pick.set("""{"state":"idle"}""")
            return s
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_MIC) micRequesting = false
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_EXPORT) {
            val contents = exportContents
            exportContents = null
            val uri = data?.data
            if (resultCode != RESULT_OK || uri == null || contents == null) {
                exportState.set("""{"state":"cancelled"}""")
            } else Thread {
                try {
                    val output = contentResolver.openOutputStream(uri, "wt") ?: error("Cannot open export destination")
                    output.bufferedWriter(Charsets.UTF_8).use { it.write(contents) }
                    exportState.set("""{"state":"saved"}""")
                } catch (e: Exception) { exportState.set(JSONObject().put("state", "error").put("error", e.message).toString()) }
            }.start()
            return
        }
        if (requestCode == REQUEST_SYSTEM_AUDIO) {
            if (!systemRequestPending) return
            systemRequestPending = false
            if (resultCode == RESULT_OK && data != null) SubtitleService.begin(this, "system", data)
            else SubtitleService.systemState = "cancelled"
            return
        }
        if (requestCode != PICK_AUDIO) return
        val uri = data?.data
        if (resultCode != RESULT_OK || uri == null) {
            pick.set("""{"state":"cancelled"}""")
            return
        }
        // Take the grant before leaving the UI thread, then stream the content into our
        // cache — the decode pipeline (and every later resume) needs a plain file path.
        try {
            contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: SecurityException) {
            // Non-persistable providers still work while the process lives; the session
            // reads within that window anyway.
        }
        pickThread.get()?.interrupt()
        val t = Thread {
            // Providers control DISPLAY_NAME. Keep only the basename, and make each
            // cache entry unique so a later pick cannot overwrite an active decoder.
            var out: File? = null
            try {
                val name = File(queryName(uri) ?: "audio.m4a").name
                val file = File.createTempFile("picked-", "-${name.takeLast(80)}", cacheDir)
                out = file
                contentResolver.openInputStream(uri)?.use { input ->
                    file.outputStream().use { input.copyTo(it) }
                } ?: error("no stream")
                pick.set(JSONObject().put("state", "picked").put("path", file.absolutePath).toString())
            } catch (_: Exception) {
                out?.delete()
                pick.set("""{"state":"error"}""")
            }
        }
        pickThread.set(t)
        t.start()
    }

    private fun queryName(uri: Uri): String? {
        val cursor = contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)
            ?: return null
        return cursor.use { if (it.moveToFirst()) it.getString(0) else null }
    }

    // TauriActivity's hook for touching the WebView before first load — the same one
    // LittleLobby registers its bridge in.
    override fun onWebViewCreate(webView: android.webkit.WebView) {
        super.onWebViewCreate(webView)
        // Android 15+ enforces edge-to-edge, but WebView's CSS safe-area env values
        // can stay zero. Resize the actual viewport around system bars/cutouts/IME.
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or
                WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            val params = view.layoutParams as? ViewGroup.MarginLayoutParams
            if (params != null && (params.leftMargin != safe.left || params.topMargin != safe.top ||
                params.rightMargin != safe.right || params.bottomMargin != safe.bottom)) {
                params.setMargins(safe.left, safe.top, safe.right, safe.bottom)
                view.layoutParams = params
            }
            WindowInsetsCompat.CONSUMED
        }
        webView.post { ViewCompat.requestApplyInsets(webView) }
        val lightBars = resources.configuration.uiMode and
            android.content.res.Configuration.UI_MODE_NIGHT_MASK != android.content.res.Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, webView).apply {
            isAppearanceLightStatusBars = lightBars
            isAppearanceLightNavigationBars = lightBars
        }
        webView.addJavascriptInterface(Bridge(), "ReaLingoAndroid")
    }

    companion object {
        private const val PICK_AUDIO = 42
        private const val REQUEST_MIC = 43
        private const val REQUEST_SYSTEM_AUDIO = 44
        private const val REQUEST_EXPORT = 45
    }
}
