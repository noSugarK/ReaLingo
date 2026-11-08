package com.nosugark.realingo

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.media.*
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.*
import android.provider.Settings
import android.text.TextUtils
import android.view.*
import android.widget.*
import androidx.annotation.Keep
import androidx.core.content.ContextCompat
import org.json.JSONObject
import kotlin.math.roundToInt

/** Owns background capture and a native overlay; neither needs the Activity to stay visible. */
@Keep
class SubtitleService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var wm: WindowManager
    @Volatile private var panel: LinearLayout? = null
    private var source: TextView? = null
    private var target: TextView? = null
    private var handle: View? = null
    private var resize: View? = null
    private var layout: WindowManager.LayoutParams? = null
    private var projection: MediaProjection? = null
    @Volatile private var recorder: AudioRecord? = null
    @Volatile private var audioSerial = 0
    private var lastWidthSetting = -1
    private val prefs by lazy { getSharedPreferences("subtitle-window", MODE_PRIVATE) }

    external fun pushAudio(samples: ShortArray, count: Int): Boolean

    override fun onBind(intent: Intent?) = null
    override fun onCreate() {
        super.onCreate()
        instance = this
        wm = getSystemService(WINDOW_SERVICE) as WindowManager
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(
            NotificationChannel(CHANNEL, "ReaLingo", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == HIDE) visible = false
        try {
            refreshForeground()
            if (captureKind == "system" && recorder == null) {
                @Suppress("DEPRECATION")
                val token = intent?.getParcelableExtra<Intent>("projection")
                if (token != null) startPlayback(token)
            }
            render()
            ready = true
            stopIfIdle()
        } catch (e: Exception) { fail(e) }
        return START_NOT_STICKY
    }

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val hide = PendingIntent.getService(this, 1, Intent(this, SubtitleService::class.java).setAction(HIDE), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("ReaLingo")
            .setContentText(data.optString("notification", "Live translation and subtitles"))
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(Notification.Action.Builder(null, data.optString("close", "Hide subtitles"), hide).build())
            .build()
    }
    private fun refreshForeground() {
        var types = 0
        if (Build.VERSION.SDK_INT >= 34) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        if (Build.VERSION.SDK_INT >= 30 && captureKind == "mic") types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (Build.VERSION.SDK_INT >= 29 && captureKind == "system") types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification(), types)
        else startForeground(NOTIFICATION, notification())
    }
    private fun stopIfIdle() {
        if (!visible && captureKind.isEmpty()) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
    }
    private fun fail(e: Exception) {
        lastError = e.message ?: e.javaClass.simpleName
        if (captureKind == "system") systemState = "error"
        captureKind = ""
        ready = false
        visible = false
        stopPlayback()
        removePanel()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun startPlayback(token: Intent) {
        check(Build.VERSION.SDK_INT >= 29) { "System audio capture requires Android 10 or newer" }
        stopPlayback()
        val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val p = requireNotNull(manager.getMediaProjection(Activity.RESULT_OK, token)) { "System audio authorization was not granted" }
        projection = p
        p.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                if (projection === p) {
                    lastError = data.optString("captureEnded", "System audio authorization ended")
                    endCapture(this@SubtitleService)
                }
            }
        }, main)
        val config = AudioPlaybackCaptureConfiguration.Builder(p)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .excludeUid(android.os.Process.myUid()).build()
        val format = AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(48_000).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build()
        val min = AudioRecord.getMinBufferSize(48_000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(min > 0) { "No supported system audio recording format" }
        val record = AudioRecord.Builder().setAudioFormat(format).setAudioPlaybackCaptureConfig(config)
            .setBufferSizeInBytes(maxOf(min * 2, 19_200)).build()
        recorder = record
        record.startRecording()
        check(record.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "System audio recorder did not start" }
        systemState = "ready"
        val serial = audioSerial
        Thread({
            try {
                val pcm = ShortArray(4800)
                while (audioSerial == serial && recorder === record) {
                    val count = record.read(pcm, 0, pcm.size, AudioRecord.READ_BLOCKING)
                    if (count <= 0) error("AudioRecord.read failed ($count)")
                    if (audioSerial != serial || !pushAudio(pcm, count)) break
                    framesRead += count
                }
            } catch (e: Exception) {
                if (audioSerial == serial) lastError = e.message ?: "System audio recording failed"
            } finally {
                runCatching { record.release() }
                main.post { if (audioSerial == serial) endCapture(this@SubtitleService) }
            }
        }, "realingo-playback").start()
    }
    private fun stopPlayback() {
        audioSerial++
        val old = recorder
        recorder = null
        val p = projection
        projection = null
        runCatching { old?.stop() }
        runCatching { p?.stop() }
        pushAudio(ShortArray(0), 0)
        if (systemState != "asking" && systemState != "error") systemState = "idle"
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()
    private fun screenWidth() = resources.displayMetrics.widthPixels
    private fun screenHeight() = resources.displayMetrics.heightPixels
    private fun color(key: String, fallback: Int) = runCatching { Color.parseColor(data.optString(key)) }.getOrDefault(fallback)
    private fun number(key: String, fallback: Double, min: Double, max: Double): Float =
        data.optDouble(key, fallback).takeIf { it.isFinite() }?.coerceIn(min, max)?.toFloat() ?: fallback.toFloat()
    private fun removePanel() {
        panel?.let { runCatching { wm.removeView(it) } }
        panel = null; source = null; target = null; layout = null
    }
    private fun makePanel() {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), dp(6), dp(12), dp(6)) }
        val bar = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        val title = TextView(this).apply { text = "⠿  ReaLingo"; textSize = 12f; setTextColor(Color.WHITE); setPadding(0, dp(5), 0, dp(5)) }
        val close = TextView(this).apply { text = "×"; textSize = 24f; setTextColor(Color.WHITE); gravity = Gravity.CENTER; contentDescription = data.optString("close", "Hide subtitles") }
        bar.addView(title, LinearLayout.LayoutParams(0, dp(36), 1f)); bar.addView(close, LinearLayout.LayoutParams(dp(40), dp(36)))
        close.setOnClickListener { visible = false; render(); stopIfIdle() }
        root.addView(bar)
        source = TextView(this).also { root.addView(it) }
        target = TextView(this).also { root.addView(it) }
        val grip = TextView(this).apply { text = "↘"; textSize = 20f; gravity = Gravity.END; setTextColor(Color.WHITE); contentDescription = data.optString("resize", "Resize subtitles") }
        root.addView(grip, LinearLayout.LayoutParams(-1, dp(28)))
        handle = bar; resize = grip
        val width = prefs.getInt("width", (screenWidth() * number("mobileWidth", 88.0, 40.0, 100.0) / 100).toInt())
        layout = WindowManager.LayoutParams(width.coerceIn(minOf(dp(180), screenWidth()), screenWidth()), -2,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.START
            setTitle("ReaLingo subtitles")
            x = prefs.getInt("x", (screenWidth() - width) / 2)
            y = prefs.getInt("y", screenHeight() * 2 / 3)
        }
        panel = root
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            val p = layout
            if (p != null) {
                val oldX = p.x; val oldY = p.y
                clampPosition()
                if (oldX != p.x || oldY != p.y) wm.updateViewLayout(root, p)
            }
        }
        installGesture(title, false); installGesture(grip, true)
        wm.addView(root, layout)
    }
    private fun installGesture(view: View, sizing: Boolean) {
        var x = 0f; var y = 0f; var startX = 0; var startY = 0; var startWidth = 0
        view.setOnTouchListener { _, event ->
            val p = layout ?: return@setOnTouchListener false
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> { x = event.rawX; y = event.rawY; startX = p.x; startY = p.y; startWidth = p.width; true }
                MotionEvent.ACTION_MOVE -> {
                    if (sizing) p.width = (startWidth + event.rawX - x).toInt().coerceIn(minOf(dp(180), screenWidth()), screenWidth())
                    else { p.x = startX + (event.rawX - x).toInt(); p.y = startY + (event.rawY - y).toInt() }
                    clampPosition(); wm.updateViewLayout(panel, p); true
                }
                MotionEvent.ACTION_UP -> { prefs.edit().putInt("x", p.x).putInt("y", p.y).putInt("width", p.width).apply(); true }
                else -> false
            }
        }
    }
    private fun clampPosition() {
        layout?.let { p ->
            p.width = p.width.coerceIn(minOf(dp(180), screenWidth()), screenWidth())
            p.x = p.x.coerceIn(0, maxOf(0, screenWidth() - p.width))
            p.y = p.y.coerceIn(0, maxOf(0, screenHeight() - (panel?.height?.coerceAtLeast(dp(80)) ?: dp(80))))
        }
    }
    private fun render() {
        if (!visible || !Settings.canDrawOverlays(this)) { visible = false; removePanel(); return }
        if (panel == null) makePanel()
        val p = layout ?: return
        val widthSetting = number("mobileWidth", 88.0, 40.0, 100.0).roundToInt()
        if (lastWidthSetting >= 0 && widthSetting != lastWidthSetting) p.width = screenWidth() * widthSetting / 100
        lastWidthSetting = widthSetting
        val locked = data.optBoolean("locked", false)
        p.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or if (locked) WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE else 0
        // Android 12 blocks pass-through touches behind an opaque untrusted overlay.
        p.alpha = if (locked && Build.VERSION.SDK_INT >= 31) 0.8f else 1f
        handle?.visibility = if (locked) View.GONE else View.VISIBLE
        resize?.visibility = if (locked) View.GONE else View.VISIBLE
        panel?.background = GradientDrawable().apply { cornerRadius = dp(14).toFloat(); setColor(Color.argb((number("opacity", 0.5, 0.0, 1.0) * 255).toInt(), 6, 8, 14)) }
        val mode = data.optString("mode", "both")
        val src = data.optString("source").take(4000)
        val tgt = data.optString("target").take(4000)
        fun style(label: TextView?, text: String, show: Boolean, size: String, tint: String) {
            if (label == null) return
            label.text = text
            label.visibility = if (show) View.VISIBLE else View.GONE
            label.textSize = number(size, if (size == "srcSize") 19.0 else 30.0, 12.0, 72.0)
            label.setTextColor(color(tint, Color.WHITE))
            label.gravity = when (data.optString("align")) { "left" -> Gravity.START; "right" -> Gravity.END; else -> Gravity.CENTER }
            label.maxLines = if (data.optBoolean("grow", true)) 6 else 1
            label.ellipsize = if (data.optBoolean("grow", true)) TextUtils.TruncateAt.END else TextUtils.TruncateAt.START
            label.setShadowLayer(if (data.optBoolean("outline", true)) dp(2).toFloat() else 0f, 0f, 0f, Color.BLACK)
        }
        style(source, src, mode != "target" && src.isNotEmpty(), "srcSize", "srcColor")
        style(target, tgt, mode != "source" && tgt.isNotEmpty(), "tgtSize", "color")
        if (source?.visibility == View.GONE && target?.visibility == View.GONE) {
            target?.text = data.optString("empty", "Waiting for speech…"); target?.visibility = View.VISIBLE
        }
        clampPosition(); wm.updateViewLayout(panel, p)
    }
    override fun onConfigurationChanged(newConfig: Configuration) { super.onConfigurationChanged(newConfig); render() }
    override fun onDestroy() {
        stopPlayback(); removePanel(); ready = false; visible = false; captureKind = ""
        if (instance === this) instance = null
        super.onDestroy()
    }

    companion object {
        init { System.loadLibrary("realingo_lib") }
        private const val CHANNEL = "realingo-live"
        private const val NOTIFICATION = 73
        private const val HIDE = "realingo.hide-subtitles"
        @Volatile private var instance: SubtitleService? = null
        private var data = JSONObject()
        @Volatile var visible = false
        @Volatile var captureKind = ""
        @Volatile var ready = false
        @Volatile var systemState = "idle"
        @Volatile var lastError = ""
        @Volatile var framesRead = 0L

        fun begin(context: Context, kind: String, token: Intent? = null) {
            lastError = ""; captureKind = kind; ready = false; framesRead = 0
            if (kind == "system") systemState = "starting"
            try { ContextCompat.startForegroundService(context, Intent(context, SubtitleService::class.java).putExtra("projection", token)) }
            catch (e: RuntimeException) { lastError = e.message ?: "Cannot start capture service"; captureKind = ""; systemState = "error" }
        }
        fun endCapture(context: Context) {
            captureKind = ""
            instance?.let { it.stopPlayback(); if (visible) it.refreshForeground(); it.stopIfIdle() }
        }
        fun setVisible(context: Context, on: Boolean) {
            lastError = ""; visible = on
            if (on) {
                try { ContextCompat.startForegroundService(context, Intent(context, SubtitleService::class.java)) }
                catch (e: RuntimeException) { visible = false; lastError = e.message ?: "Cannot show subtitles" }
            } else instance?.let { it.render(); it.stopIfIdle() }
        }
        fun update(json: String) {
            if (json.length > 64_000) { lastError = "Subtitle payload is too large"; return }
            data = runCatching { JSONObject(json) }.getOrElse { lastError = "Invalid subtitle payload"; return }
            instance?.let { service -> try { service.render() } catch (e: Exception) { service.fail(e) } }
        }
        fun resetPosition(context: Context) {
            context.getSharedPreferences("subtitle-window", MODE_PRIVATE).edit().clear().apply()
            instance?.let { service ->
                service.layout?.let { p -> p.x = (service.screenWidth() - p.width) / 2; p.y = service.screenHeight() * 2 / 3 }
                service.render()
            }
        }
        fun state(context: Context): String = JSONObject().put("granted", Settings.canDrawOverlays(context))
            .put("visible", visible && instance?.panel != null).put("ready", ready).put("captureKind", captureKind).put("systemState", systemState)
            .put("error", lastError).put("frames", framesRead)
            .put("width", instance?.let { service -> service.layout?.width?.let { (it * 100f / service.screenWidth()).roundToInt() } } ?: 0).toString()
    }
}
