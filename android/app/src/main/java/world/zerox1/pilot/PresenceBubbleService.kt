package world.zerox1.pilot

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.*
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.IBinder
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import kotlin.math.abs

/**
 * PresenceBubbleService — floating avatar companion for 01PL holders.
 *
 * Draws a circular avatar bubble over other apps (TYPE_APPLICATION_OVERLAY).
 * The bubble shows the agent avatar (or initial letter fallback), pulses
 * gently when the node is running, and deep-links into the app on tap.
 *
 * Lifecycle:
 *   startService(Intent(ctx, PresenceBubbleService::class.java)) — show bubble
 *   stopService(...)  — remove bubble
 *
 * Requires: android.permission.SYSTEM_ALERT_WINDOW (Draw over other apps)
 */
class PresenceBubbleService : Service() {

    companion object {
        private const val TAG = "PresenceBubble"
        /** dp size of the bubble */
        private const val BUBBLE_DP = 60
        /** Start position from right edge (dp) */
        private const val START_X_DP = 16
        /** Start position from top (dp) */
        private const val START_Y_DP = 220
        private const val BUBBLE_NOTIF_ID = 9002
        private const val BUBBLE_CHANNEL_ID = "presence_bubble"
    }

    private lateinit var wm: WindowManager
    private var bubbleView: BubbleView? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        wm = getSystemService(WINDOW_SERVICE) as WindowManager
        startForeground(BUBBLE_NOTIF_ID, buildBubbleNotification())
        showBubble()
    }

    private fun buildBubbleNotification(): android.app.Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
            if (nm.getNotificationChannel(BUBBLE_CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    android.app.NotificationChannel(
                        BUBBLE_CHANNEL_ID,
                        "Agent Presence",
                        android.app.NotificationManager.IMPORTANCE_MIN
                    ).apply { setShowBadge(false) }
                )
            }
        }
        val prefs = getSharedPreferences("zerox1", Context.MODE_PRIVATE)
        val agentName = prefs.getString("agent_name", "Agent") ?: "Agent"
        val tapIntent = packageManager.getLaunchIntentForPackage(packageName)
            ?.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP) ?: Intent()
        val pi = android.app.PendingIntent.getActivity(
            this, 0, tapIntent,
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT
        )
        return androidx.core.app.NotificationCompat.Builder(this, BUBBLE_CHANNEL_ID)
            .setContentTitle(agentName)
            .setContentText("Companion active")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(pi)
            .setOngoing(true)
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_MIN)
            .build()
    }

    override fun onDestroy() {
        super.onDestroy()
        bubbleView?.let {
            it.stopPulse()
            try { wm.removeView(it) } catch (_: Exception) {}
        }
        bubbleView = null
    }

    private fun showBubble() {
        val prefs = getSharedPreferences("zerox1", Context.MODE_PRIVATE)
        val agentName = prefs.getString("agent_name", null)?.takeIf { it.isNotBlank() } ?: "A"
        val avatarUri = prefs.getString("agent_avatar", null)

        val dp = resources.displayMetrics.density
        val sizePx = (BUBBLE_DP * dp).toInt()

        val view = BubbleView(this, agentName, avatarUri, sizePx)

        // Display metrics for right-edge positioning
        val metrics = resources.displayMetrics
        val screenW = metrics.widthPixels

        val params = WindowManager.LayoutParams(
            sizePx, sizePx,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else
                @Suppress("DEPRECATION")
                WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = screenW - sizePx - (START_X_DP * dp).toInt()
            y = (START_Y_DP * dp).toInt()
        }

        var downX = 0f; var downY = 0f
        var initParamX = 0; var initParamY = 0
        var dragging = false

        view.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX; downY = event.rawY
                    initParamX = params.x; initParamY = params.y
                    dragging = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - downX).toInt()
                    val dy = (event.rawY - downY).toInt()
                    if (abs(dx) > 10 || abs(dy) > 10) dragging = true
                    if (dragging) {
                        params.x = initParamX + dx
                        params.y = initParamY + dy
                        val statusBarHeight = run {
                            val r = resources.getIdentifier("status_bar_height", "dimen", "android")
                            if (r > 0) resources.getDimensionPixelSize(r) else 80
                        }
                        val navBarHeight = run {
                            val r = resources.getIdentifier("navigation_bar_height", "dimen", "android")
                            if (r > 0) resources.getDimensionPixelSize(r) else 120
                        }
                        val screenH = resources.displayMetrics.heightPixels
                        val bubbleSizePx = (60 * resources.displayMetrics.density).toInt()
                        params.y = params.y.coerceIn(statusBarHeight, screenH - navBarHeight - bubbleSizePx)
                        wm.updateViewLayout(view, params)
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (!dragging) {
                        // Tap: snap to app with a quick scale bounce, then open
                        view.animateTap {
                            val launch = packageManager.getLaunchIntentForPackage(packageName)
                                ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                            launch?.let { startActivity(it) }
                        }
                    } else {
                        // Snap to nearest edge after drag; clamp Y first
                        val statusBarHeight = run {
                            val r = resources.getIdentifier("status_bar_height", "dimen", "android")
                            if (r > 0) resources.getDimensionPixelSize(r) else 80
                        }
                        val navBarHeight = run {
                            val r = resources.getIdentifier("navigation_bar_height", "dimen", "android")
                            if (r > 0) resources.getDimensionPixelSize(r) else 120
                        }
                        val screenH = resources.displayMetrics.heightPixels
                        val bubbleSizePx = (60 * resources.displayMetrics.density).toInt()
                        params.y = params.y.coerceIn(statusBarHeight, screenH - navBarHeight - bubbleSizePx)
                        snapToEdge(view, params, metrics.widthPixels)
                    }
                    true
                }
                else -> false
            }
        }

        try {
            wm.addView(view, params)
            // Assign bubbleView before startPulse() so onDestroy can always stop the animation
            bubbleView = view
            // Entrance animation: scale from 0
            view.scaleX = 0f; view.scaleY = 0f
            view.animate()
                .scaleX(1f).scaleY(1f)
                .setDuration(300)
                .setInterpolator(OvershootInterpolator(1.5f))
                .start()
            view.startPulse()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to add bubble view: $e")
        }
    }

    /** After a drag, snap horizontally to the nearest screen edge. */
    private fun snapToEdge(view: View, params: WindowManager.LayoutParams, screenW: Int) {
        val dp = resources.displayMetrics.density
        val margin = (START_X_DP * dp).toInt()
        val targetX = if (params.x + params.width / 2 < screenW / 2) margin
        else screenW - params.width - margin

        val startX = params.x
        val anim = ValueAnimator.ofInt(startX, targetX).apply {
            duration = 250
            interpolator = DecelerateInterpolator()
            addUpdateListener {
                params.x = it.animatedValue as Int
                try { wm.updateViewLayout(view, params) } catch (_: Exception) {}
            }
        }
        anim.start()
    }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * BubbleView — the circular floating view drawn entirely on canvas.
 *
 * Layers (back to front):
 *   1. Soft shadow ring (semi-transparent)
 *   2. White circle background
 *   3. Agent avatar bitmap (clipped to circle) or initial letter
 *   4. Green status dot (bottom-right)
 */
class BubbleView(
    context: Context,
    agentName: String,
    avatarUri: String?,
    private val sizePx: Int,
) : View(context) {

    private val initial = agentName.firstOrNull()?.uppercaseChar()?.toString() ?: "A"
    private val avatarBitmap: Bitmap? = loadAvatar(context, avatarUri, sizePx)

    private val shadowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(40, 0, 0, 0)
        maskFilter = BlurMaskFilter(sizePx * 0.12f, BlurMaskFilter.Blur.NORMAL)
    }
    private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
    }
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#bbf7d0")
        style = Paint.Style.STROKE
        strokeWidth = sizePx * 0.045f
    }
    private val initialPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#111111")
        textSize = sizePx * 0.38f
        textAlign = Paint.Align.CENTER
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }
    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#22c55e")
    }
    private val dotBorderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeWidth = sizePx * 0.03f
    }

    private var pulseAnimator: ObjectAnimator? = null

    override fun onDraw(canvas: Canvas) {
        val cx = sizePx / 2f
        val cy = sizePx / 2f
        val r = sizePx * 0.44f

        // Shadow
        canvas.drawCircle(cx, cy + sizePx * 0.04f, r + sizePx * 0.06f, shadowPaint)

        // Background circle
        canvas.drawCircle(cx, cy, r, bgPaint)

        // Avatar or initial
        if (avatarBitmap != null) {
            val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG)
            val shader = BitmapShader(avatarBitmap, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
            bitmapPaint.shader = shader
            canvas.drawCircle(cx, cy, r - sizePx * 0.02f, bitmapPaint)
        } else {
            // Gradient background + initial letter
            val bgGradientPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                shader = RadialGradient(
                    cx, cy * 0.8f, r * 1.2f,
                    intArrayOf(Color.parseColor("#f0fdf4"), Color.parseColor("#dcfce7")),
                    null,
                    Shader.TileMode.CLAMP
                )
            }
            canvas.drawCircle(cx, cy, r - sizePx * 0.02f, bgGradientPaint)
            val textY = cy - (initialPaint.descent() + initialPaint.ascent()) / 2
            canvas.drawText(initial, cx, textY, initialPaint)
        }

        // Border ring
        canvas.drawCircle(cx, cy, r, borderPaint)

        // Status dot (bottom-right)
        val dotR = sizePx * 0.1f
        val dotCx = cx + r * 0.68f
        val dotCy = cy + r * 0.68f
        canvas.drawCircle(dotCx, dotCy, dotR + sizePx * 0.025f, dotBorderPaint)
        canvas.drawCircle(dotCx, dotCy, dotR, dotPaint)
    }

    fun startPulse() {
        pulseAnimator = ObjectAnimator.ofFloat(this, "scaleX", 1f, 1.06f, 1f).apply {
            duration = 2_200
            repeatCount = ObjectAnimator.INFINITE
            repeatMode = ObjectAnimator.RESTART
            interpolator = DecelerateInterpolator()
            addUpdateListener { scaleY = scaleX }
            start()
        }
    }

    fun stopPulse() {
        pulseAnimator?.cancel()
        pulseAnimator = null
    }

    fun animateTap(onEnd: () -> Unit) {
        animate()
            .scaleX(0.85f).scaleY(0.85f)
            .setDuration(100)
            .withEndAction {
                animate()
                    .scaleX(1f).scaleY(1f)
                    .setDuration(150)
                    .setInterpolator(OvershootInterpolator())
                    .withEndAction(onEnd)
                    .start()
            }
            .start()
    }

    private fun loadAvatar(context: Context, uri: String?, sizePx: Int): Bitmap? {
        if (uri.isNullOrBlank()) return null
        return try {
            val parsed = android.net.Uri.parse(uri)
            val inputStream = when (parsed.scheme) {
                "content" -> context.contentResolver.openInputStream(parsed)
                "file" -> {
                    val path = parsed.path ?: return null
                    val allowed = listOf(
                        context.filesDir.absolutePath,
                        context.cacheDir.absolutePath,
                        context.externalCacheDir?.absolutePath
                    )
                    if (allowed.none { it != null && path.startsWith(it) }) return null
                    java.io.FileInputStream(path)
                }
                else -> return null
            }
            inputStream?.use { stream ->
                val raw = BitmapFactory.decodeStream(stream) ?: return null
                // Scale and create a square bitmap for the circle clip
                val scaled = Bitmap.createScaledBitmap(raw, sizePx, sizePx, true)
                if (raw != scaled) raw.recycle()
                scaled
            }
        } catch (e: Exception) {
            Log.w("BubbleView", "Could not load avatar: $e")
            null
        }
    }
}
