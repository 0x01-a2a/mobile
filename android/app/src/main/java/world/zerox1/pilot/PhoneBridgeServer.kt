package world.zerox1.pilot

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.Intent
import android.content.IntentFilter
import android.graphics.ImageFormat
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.VibrationEffect
import android.os.VibratorManager
import android.provider.MediaStore
import android.telephony.TelephonyManager
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import android.location.LocationManager
import android.media.MediaRecorder
import android.net.Uri
import android.provider.CalendarContract
import android.provider.CallLog
import android.provider.ContactsContract
import android.provider.Telephony
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.text.SimpleDateFormat
import java.util.*

/**
 * PhoneBridgeServer — local HTTP server on 127.0.0.1:9092
 * Exposes Android phone APIs to the ZeroClaw agent via REST endpoints.
 *
 * All endpoints return {"ok": true, "data": ...} or {"ok": false, "error": "..."}.
 * Runtime permissions are checked at the endpoint level; missing permission returns
 * {"ok": false, "error": "PERMISSION_DENIED"} rather than crashing.
 */
class PhoneBridgeServer(private val context: Context, private val secret: String) {

    companion object {
        const val TAG             = "PhoneBridgeServer"
        const val PORT            = 9092
        const val NOTIF_CHANNEL_ID = "zerox1_phone_bridge"
        const val BRIDGE_NOTIF_ID  = 0x7A01  // fixed ID so notifications replace each other
        const val MAX_AUTH_FAILURES_PER_MINUTE = 10
        const val AUTH_LOCKOUT_SLEEP_MS = 5_000L
    }

    // Failed-auth rate limiter — global counter over a 60-second rolling window.
    // After MAX_AUTH_FAILURES_PER_MINUTE consecutive failures the handler sleeps
    // AUTH_LOCKOUT_SLEEP_MS before replying, making brute-force impractical even
    // on a rooted device where loopback traffic can be observed.
    private val failedAuthCount = java.util.concurrent.atomic.AtomicInteger(0)
    private val authWindowStart = java.util.concurrent.atomic.AtomicLong(System.currentTimeMillis())

    private var serverSocket: ServerSocket? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val smsTimestamps    = mutableListOf<Long>()
    private val notifyTimestamps = mutableListOf<Long>()
    private val audioMutex       = kotlinx.coroutines.sync.Mutex()
    private val cameraMutex      = kotlinx.coroutines.sync.Mutex()
    private val imuMutex         = kotlinx.coroutines.sync.Mutex()

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    fun start() {
        scope.launch {
            try {
                serverSocket = ServerSocket(PORT, 50, InetAddress.getByName("127.0.0.1"))
                Log.i(TAG, "PhoneBridgeServer listening on 127.0.0.1:$PORT")
                while (isActive) {
                    val client = serverSocket?.accept() ?: break
                    launch { handleClient(client) }
                }
            } catch (e: Exception) {
                if (isActive) Log.e(TAG, "Server error: $e")
            }
        }
    }

    fun stop() {
        scope.cancel()
        serverSocket?.close()
        serverSocket = null
        Log.i(TAG, "PhoneBridgeServer stopped.")
    }

    // -------------------------------------------------------------------------
    // HTTP dispatch
    // -------------------------------------------------------------------------

    private data class BridgeResponse(val body: String, val status: Int = 200)

    private fun handleClient(socket: Socket) {
        socket.use {
            socket.soTimeout = 10_000  // 10s read timeout; prevents hung-connection exhaustion
            try {
                val reader = BufferedReader(InputStreamReader(socket.getInputStream()))
                val firstLine = reader.readLine() ?: return
                val parts = firstLine.trim().split(" ")
                if (parts.size < 2) return
                val method = parts[0]
                val fullPath = parts[1]
                val path = fullPath.substringBefore("?")
                val query = if (fullPath.contains("?")) fullPath.substringAfter("?") else ""

                // Read headers
                val headers = mutableMapOf<String, String>()
                var line = reader.readLine()
                while (!line.isNullOrEmpty()) {
                    val colon = line.indexOf(':')
                    if (colon > 0) {
                        headers[line.substring(0, colon).trim().lowercase()] =
                            line.substring(colon + 1).trim()
                    }
                    line = reader.readLine()
                }

                // Authentication Check (CRIT-1) + brute-force rate limit (SEC-1)
                val token = headers["x-bridge-token"]
                if (token == null || token != secret) {
                    val now = System.currentTimeMillis()
                    if (now - authWindowStart.get() > 60_000L) {
                        authWindowStart.set(now)
                        failedAuthCount.set(0)
                    }
                    val attempts = failedAuthCount.incrementAndGet()
                    if (attempts > MAX_AUTH_FAILURES_PER_MINUTE) {
                        Log.w(TAG, "Auth rate limit exceeded ($attempts failures/min) — throttling")
                        Thread.sleep(AUTH_LOCKOUT_SLEEP_MS)
                    }
                    Log.w(TAG, "Unauthorized request (attempt $attempts) from ${socket.inetAddress}: $path")
                    val err = jsonError("UNAUTHORIZED", 401)
                    writeResponse(socket, err.body, err.status)
                    return
                }
                // Successful auth — reset failure counter.
                failedAuthCount.set(0)

                // Read body (HIGH-1: Content-Length cap)
                val contentLength = headers["content-length"]?.toIntOrNull()?.coerceIn(0, 1_048_576) ?: 0
                val bodyBuilder = CharArray(contentLength)
                if (contentLength > 0) reader.read(bodyBuilder, 0, contentLength)
                val body = String(bodyBuilder)

                val params = parseQuery(query)
                val bodyJson = if (body.isNotBlank()) runCatching { JSONObject(body) }.getOrNull()
                               else null

                val response = route(method, path, params, bodyJson)
                writeResponse(socket, response.body, response.status)
                // Log every bridge call to the activity log (skip health-check paths).
                if (path != "/phone/permissions" && path != "/phone/activity_log") {
                    val outcome = when {
                        response.status == 403 -> if (response.body.contains("CAPABILITY_DISABLED"))
                            "disabled" else "denied"
                        response.status == 429 -> "rate_limited"
                        response.status in 200..299 -> "ok"
                        else -> "error"
                    }
                    val (cap, action) = describeRequest(method, path, params, bodyJson)
                    BridgeActivityLog.record(cap, action, outcome)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Client error: $e")
                val err = jsonError("INTERNAL_ERROR: ${e.message}", 500)
                writeResponse(socket, err.body, err.status)
            }
        }
    }

    // ── Capability gate ──────────────────────────────────────────────────────
    // SharedPreferences key: bridge_cap_<name> → Boolean (default true)
    private fun isCapEnabled(cap: String): Boolean =
        context.getSharedPreferences("zerox1_bridge", android.content.Context.MODE_PRIVATE)
            .getBoolean("bridge_cap_$cap", true)

    private fun capDisabled(cap: String): BridgeResponse =
        BridgeResponse(
            JSONObject().apply { put("ok", false); put("error", "CAPABILITY_DISABLED"); put("capability", cap) }.toString(),
            403
        )

    // ── Policy-mode gate ─────────────────────────────────────────────────────
    // BuildConfig.POLICY_MODE: "AUTONOMOUS" | "ASSISTED" | "CLIENT_ONLY"
    // BuildConfig.ALLOW_ACCESSIBILITY_SERVICE / ALLOW_NOTIFICATION_LISTENER /
    //             ALLOW_AUTONOMOUS_UI_EXECUTION

    private fun policyBlocked(reason: String): BridgeResponse =
        BridgeResponse(
            JSONObject().apply { put("ok", false); put("error", "POLICY_BLOCKED"); put("reason", reason) }.toString(),
            403
        )

    /** Passive observation (read_tree, screenshot, vision) allowed in AUTONOMOUS + ASSISTED. */
    private fun isObserveAllowed(): Boolean =
        BuildConfig.ALLOW_ACCESSIBILITY_SERVICE &&
            BuildConfig.POLICY_MODE != "CLIENT_ONLY"

    /**
     * Active UI manipulation (act, global_nav).
     * In AUTONOMOUS: allowed directly.
     * In ASSISTED: allowed only after user confirms via [ScreenActionQueue].
     * In CLIENT_ONLY: blocked.
     */
    private fun isActAllowed(): Boolean =
        BuildConfig.ALLOW_AUTONOMOUS_UI_EXECUTION ||
            BuildConfig.POLICY_MODE == "ASSISTED"

    /**
     * Autonomous UI execution without human-in-the-loop.
     * Only allowed when BuildConfig.ALLOW_AUTONOMOUS_UI_EXECUTION = true (full flavor).
     */
    private fun isAutonomyAllowed(): Boolean =
        BuildConfig.ALLOW_AUTONOMOUS_UI_EXECUTION

    /**
     * Gate for action endpoints in ASSISTED mode.
     * Blocks the IO thread and emits a 'screenActionPending' RN event.
     * Returns null if approved (caller should proceed), or a [BridgeResponse] to return.
     */
    private fun requireAssistedApproval(endpoint: String, description: String): BridgeResponse? {
        if (!BuildConfig.ALLOW_AUTONOMOUS_UI_EXECUTION && BuildConfig.POLICY_MODE == "ASSISTED") {
            // Find the next pending ID — emit before blocking so JS can show the modal.
            val pendingId = java.util.UUID.randomUUID().toString()
            // We inline the action into ScreenActionQueue with a known ID by using awaitApproval
            // which generates its own UUID. Emit the event with the data, then defer to queue.
            // Since we need the ID before enqueuing, we use a wrapper that pre-announces it.
            val approved = awaitAssistedApproval(endpoint, description)
            if (!approved) return policyBlocked("user_rejected_or_timeout")
        }
        return null
    }

    /**
     * Suspend the calling thread while waiting for user confirmation.
     * Emits the RN event before blocking so the UI can show the modal promptly.
     */
    private fun awaitAssistedApproval(endpoint: String, description: String): Boolean {
        // Build a PendingAction externally so we can emit its ID before blocking.
        val action = ScreenActionQueue.PendingAction(endpoint = endpoint, description = description)
        NodeModule.emitScreenActionPending(action.id, endpoint, description)
        return ScreenActionQueue.awaitApprovalWithAction(action)
    }

    private fun route(
        method: String,
        path: String,
        params: Map<String, String>,
        body: JSONObject?,
    ): BridgeResponse {
        return when {
            // ---- Contacts ----
            method == "GET"  && path == "/phone/contacts" ->
                if (!isCapEnabled("contacts")) capDisabled("contacts") else handleContactsRead(params)
            method == "POST" && path == "/phone/contacts" ->
                if (!isCapEnabled("contacts")) capDisabled("contacts") else handleContactsWrite(body)
            method == "PUT"  && path.startsWith("/phone/contacts/") ->
                if (!isCapEnabled("contacts")) capDisabled("contacts")
                else handleContactsUpdate(path.substringAfterLast("/"), body)

            // ---- SMS / Messaging ----
            method == "GET"  && path == "/phone/sms" ->
                if (!isCapEnabled("sms_read")) capDisabled("sms_read") else handleSmsRead(params)
            method == "POST" && path == "/phone/sms/send" ->
                if (!isCapEnabled("sms_send")) capDisabled("sms_send") else handleSmsSend(body)

            // ---- Location ----
            method == "GET"  && path == "/phone/location" ->
                if (!isCapEnabled("location")) capDisabled("location") else handleLocation()

            // ---- Calendar ----
            method == "GET"  && path == "/phone/calendar" ->
                if (!isCapEnabled("calendar")) capDisabled("calendar") else handleCalendarRead(params)
            method == "POST" && path == "/phone/calendar" ->
                if (!isCapEnabled("calendar")) capDisabled("calendar") else handleCalendarWrite(body)
            method == "PUT"  && path.startsWith("/phone/calendar/") ->
                if (!isCapEnabled("calendar")) capDisabled("calendar")
                else handleCalendarUpdate(path.substringAfterLast("/"), body)

            // ---- Notifications (push from app) ----
            method == "POST" && path == "/phone/notify"  -> handleNotify(body)

            // ---- Call log ----
            method == "GET"  && path == "/phone/call_log" ->
                if (!isCapEnabled("calls")) capDisabled("calls") else handleCallLog(params)

            // ---- Clipboard ----
            method == "POST" && path == "/phone/clipboard"  -> handleClipboardWrite(body)

            // ---- Camera ----
            method == "POST" && path == "/phone/camera/capture" ->
                if (!isCapEnabled("camera")) capDisabled("camera") else handleCameraCapture(body)

            // ---- Microphone ----
            method == "POST" && path == "/phone/audio/record" ->
                if (!isCapEnabled("microphone")) capDisabled("microphone") else handleAudioRecord(body)

            // ---- Audio profile (volume + DND) ----
            method == "GET"  && path == "/phone/audio/profile" -> handleAudioProfileGet()
            method == "POST" && path == "/phone/audio/profile" -> handleAudioProfileSet(body)

            // ---- Alarm ----
            method == "POST" && path == "/phone/alarm" -> handleAlarmSet(body)

            // ---- App usage (screen time) ----
            method == "GET"  && path == "/phone/app_usage" -> handleAppUsage(params)

            // ---- Documents ----
            method == "GET"  && path == "/phone/documents" ->
                if (!isCapEnabled("media")) capDisabled("media") else handleDocuments(params)

            // ---- Device context (no sensitive data) ----
            method == "GET"  && path == "/phone/permissions" -> handlePermissions()
            method == "GET"  && path == "/phone/device"      -> handleDevice()
            method == "GET"  && path == "/phone/battery"     -> handleBattery()
            method == "POST" && path == "/phone/vibrate"     -> handleVibrate(body)
            method == "GET"  && path == "/phone/timezone"    -> handleTimezone()
            method == "GET"  && path == "/phone/network"     -> handleNetwork()
            method == "GET"  && path == "/phone/wifi"        -> handleWifi()
            method == "GET"  && path == "/phone/carrier"     -> handleCarrier()
            method == "GET"  && path == "/phone/bluetooth"   -> handleBluetooth()
            method == "GET"  && path == "/phone/activity"    -> handleActivity()

            // ---- IMU (accelerometer + gyroscope) ----
            method == "GET"  && path == "/phone/imu" ->
                if (!isCapEnabled("motion")) capDisabled("motion") else handleImuSnapshot()
            method == "POST" && path == "/phone/imu/record" ->
                if (!isCapEnabled("motion")) capDisabled("motion") else handleImuRecord(body, params)

            // ---- Media images ----
            method == "GET"  && path == "/phone/media/images" ->
                if (!isCapEnabled("media")) capDisabled("media") else handleMediaImages(params)

            // ---- Accessibility Service ----
            method == "GET"  && path == "/phone/a11y/status" -> handleA11yStatus()

            // Observation cluster — allowed in AUTONOMOUS + ASSISTED (read-only, no confirmation needed)
            method == "GET"  && path == "/phone/a11y/tree" -> when {
                !isCapEnabled("screen_read_tree") -> capDisabled("screen_read_tree")
                !isObserveAllowed()               -> policyBlocked("observation_not_allowed_in_${BuildConfig.POLICY_MODE}")
                else -> handleA11yTree()
            }
            method == "GET"  && path == "/phone/a11y/screenshot" -> when {
                !isCapEnabled("screen_capture") -> capDisabled("screen_capture")
                !isObserveAllowed()             -> policyBlocked("observation_not_allowed_in_${BuildConfig.POLICY_MODE}")
                else -> handleA11yScreenshot()
            }
            method == "POST" && path == "/phone/a11y/vision" -> when {
                !isCapEnabled("screen_vision") -> capDisabled("screen_vision")
                !isObserveAllowed()            -> policyBlocked("observation_not_allowed_in_${BuildConfig.POLICY_MODE}")
                else -> handleA11yVision(body)
            }

            // Action cluster — AUTONOMOUS: direct; ASSISTED: confirmation required; CLIENT_ONLY: blocked
            method == "POST" && path == "/phone/a11y/action" -> when {
                !isCapEnabled("screen_act") -> capDisabled("screen_act")
                !isActAllowed()             -> policyBlocked("action_not_allowed_in_${BuildConfig.POLICY_MODE}")
                else -> {
                    val desc = "UI action: ${body?.optString("action") ?: "?"}"
                    val block = requireAssistedApproval(path, desc)
                    block ?: handleA11yAction(body)
                }
            }
            method == "POST" && path == "/phone/a11y/click" -> when {
                !isCapEnabled("screen_act") -> capDisabled("screen_act")
                !isActAllowed()             -> policyBlocked("action_not_allowed_in_${BuildConfig.POLICY_MODE}")
                else -> {
                    val desc = "Tap at (${body?.optInt("x") ?: "?"}, ${body?.optInt("y") ?: "?"})"
                    val block = requireAssistedApproval(path, desc)
                    block ?: handleA11yClick(body)
                }
            }
            method == "POST" && path == "/phone/a11y/global" -> when {
                !isCapEnabled("screen_global_nav") -> capDisabled("screen_global_nav")
                !isActAllowed()                    -> policyBlocked("action_not_allowed_in_${BuildConfig.POLICY_MODE}")
                else -> {
                    val desc = "Global nav: ${body?.optString("action") ?: "?"}"
                    val block = requireAssistedApproval(path, desc)
                    block ?: handleA11yGlobal(body)
                }
            }

            // Autonomy cluster — only full flavor
            method == "GET"  && path == "/phone/a11y/autonomy" -> when {
                !isCapEnabled("screen_autonomy") -> capDisabled("screen_autonomy")
                !isAutonomyAllowed()             -> policyBlocked("autonomy_not_allowed_in_${BuildConfig.POLICY_MODE}")
                else -> handleA11yTree()  // autonomy reads tree as foundation
            }

            // ---- Notification Listener ----
            method == "GET"  && path == "/phone/notifications" -> when {
                !isCapEnabled("notifications_read") -> capDisabled("notifications_read")
                !BuildConfig.ALLOW_NOTIFICATION_LISTENER -> policyBlocked("notification_listener_disabled_in_${BuildConfig.POLICY_MODE}")
                else -> handleNotificationsGet()
            }
            method == "GET"  && path == "/phone/notifications/history" -> when {
                !isCapEnabled("notifications_read") -> capDisabled("notifications_read")
                !BuildConfig.ALLOW_NOTIFICATION_LISTENER -> policyBlocked("notification_listener_disabled_in_${BuildConfig.POLICY_MODE}")
                else -> handleNotificationsHistory()
            }
            method == "POST" && path == "/phone/notifications/reply" -> when {
                !isCapEnabled("notifications_reply") -> capDisabled("notifications_reply")
                !BuildConfig.ALLOW_NOTIFICATION_LISTENER -> policyBlocked("notification_listener_disabled_in_${BuildConfig.POLICY_MODE}")
                else -> {
                    val block = requireAssistedApproval(path, "Reply to notification from ${body?.optString("key")?.substringBefore("|") ?: "?"}")
                    block ?: handleNotificationsReply(body)
                }
            }
            method == "POST" && path == "/phone/notifications/dismiss" -> when {
                !isCapEnabled("notifications_dismiss") -> capDisabled("notifications_dismiss")
                !BuildConfig.ALLOW_NOTIFICATION_LISTENER -> policyBlocked("notification_listener_disabled_in_${BuildConfig.POLICY_MODE}")
                else -> {
                    val block = requireAssistedApproval(path, "Dismiss notification")
                    block ?: handleNotificationsDismiss(body)
                }
            }

            // ---- Call Screening ----
            method == "GET"  && path == "/phone/calls/pending"  ->
                if (!isCapEnabled("calls")) capDisabled("calls") else handleCallsPending()
            method == "GET"  && path == "/phone/calls/history"  ->
                if (!isCapEnabled("calls")) capDisabled("calls") else handleCallsHistory()
            method == "POST" && path == "/phone/calls/respond"  ->
                if (!isCapEnabled("calls")) capDisabled("calls") else handleCallsRespond(body)

            // ---- Health Connect ----
            method == "GET"  && path == "/phone/health" ->
                if (!isCapEnabled("health")) capDisabled("health") else handleHealthRead(params)

            // ---- Wearables (BLE GATT) ----
            method == "GET"  && path == "/phone/wearables/scan" ->
                if (!isCapEnabled("wearables")) capDisabled("wearables") else handleWearablesScan(params)
            method == "GET"  && path == "/phone/wearables/read" ->
                if (!isCapEnabled("wearables")) capDisabled("wearables") else handleWearablesRead(params)

            // ---- Recovery / readiness ----
            method == "GET"  && path == "/phone/recovery" ->
                if (!isCapEnabled("health")) capDisabled("health") else handleRecovery()

            // ---- Activity log ----
            method == "GET"  && path == "/phone/activity_log"   -> handleActivityLog(params)

            else -> jsonError("NOT_FOUND: $method $path", 404)
        }
    }

    // ── Request description (for human-readable activity log) ─────────────
    private fun describeRequest(
        method: String,
        path: String,
        params: Map<String, String>,
        body: JSONObject?,
    ): Pair<String, String> = when {
        path == "/phone/contacts" && method == "GET"  -> "CONTACTS" to "Read contacts${params["query"]?.let { " (search: $it)" } ?: ""}"
        path == "/phone/contacts" && method == "POST" -> "CONTACTS" to "Added contact \"${body?.optString("name") ?: "?"}\""
        path.startsWith("/phone/contacts/") && method == "PUT" -> "CONTACTS" to "Updated contact ${path.substringAfterLast("/")}"
        path == "/phone/sms" -> "MESSAGING" to "Read ${params["box"] ?: "inbox"} SMS messages"
        path == "/phone/sms/send" -> "MESSAGING" to "Sent SMS to ${body?.optString("to") ?: "?"}"
        path == "/phone/location" -> "LOCATION" to "Read GPS location"
        path == "/phone/calendar" && method == "GET"  -> "CALENDAR" to "Read calendar (next ${params["days"] ?: "7"} days)"
        path == "/phone/calendar" && method == "POST" -> "CALENDAR" to "Created event \"${body?.optString("title") ?: "?"}\""
        path.startsWith("/phone/calendar/") && method == "PUT" -> "CALENDAR" to "Updated event ${path.substringAfterLast("/")}"
        path == "/phone/notify" -> "SYSTEM" to "Sent notification \"${body?.optString("title") ?: "?"}\""
        path == "/phone/call_log" -> "CALLS" to "Read call log"
        path == "/phone/clipboard" && method == "POST" -> "SYSTEM" to "Wrote to clipboard"
        path == "/phone/camera/capture" -> "CAMERA" to "Captured photo (${body?.optString("facing") ?: "back"} camera)"
        path == "/phone/audio/record" -> "MICROPHONE" to "Recorded ${body?.optLong("duration_ms", 3000)?.div(1000) ?: 3}s audio"
        path == "/phone/audio/profile" && method == "GET"  -> "SYSTEM" to "Read volume / DND mode"
        path == "/phone/audio/profile" && method == "POST" -> "SYSTEM" to "Changed volume / DND mode"
        path == "/phone/alarm" -> "SYSTEM" to "Set alarm for ${body?.optString("message") ?: "?"}"
        path == "/phone/app_usage" -> "SYSTEM" to "Read app usage stats (${params["days"] ?: "7"} days)"
        path == "/phone/documents" -> "MEDIA" to "Listed documents"
        path == "/phone/battery"   -> "SYSTEM" to "Read battery status"
        path == "/phone/network"   -> "SYSTEM" to "Read network status"
        path == "/phone/wifi"      -> "SYSTEM" to "Read WiFi info"
        path == "/phone/carrier"   -> "SYSTEM" to "Read carrier info"
        path == "/phone/bluetooth" -> "SYSTEM" to "Read Bluetooth devices"
        path == "/phone/activity"  -> "SYSTEM" to "Read step count"
        path == "/phone/media/images" -> "MEDIA" to "Listed photos"
        path == "/phone/vibrate"   -> "SYSTEM" to "Triggered vibration"
        path == "/phone/a11y/tree" -> "SCREEN" to "Read UI tree"
        path == "/phone/a11y/action" -> "SCREEN" to "Performed UI action \"${body?.optString("action") ?: "?"}\""
        path == "/phone/a11y/click" -> "SCREEN" to "Tapped at (${body?.optInt("x") ?: "?"}, ${body?.optInt("y") ?: "?"})"
        path == "/phone/a11y/global" -> "SCREEN" to "Global action: ${body?.optString("action") ?: "?"}"
        path == "/phone/a11y/screenshot" -> "SCREEN" to "Took screenshot"
        path == "/phone/notifications" -> "NOTIFICATIONS" to "Read active notifications"
        path == "/phone/notifications/history" -> "NOTIFICATIONS" to "Read notification history"
        path == "/phone/notifications/reply" -> "NOTIFICATIONS" to "Replied to notification from ${
            body?.optString("key")?.substringBefore("|") ?: "?"}"
        path == "/phone/notifications/dismiss" -> "NOTIFICATIONS" to "Dismissed notification"
        path == "/phone/calls/pending" -> "CALLS" to "Checked pending calls"
        path == "/phone/calls/history" -> "CALLS" to "Read call screening history"
        path == "/phone/calls/respond" -> "CALLS" to "${body?.optString("action")?.replaceFirstChar { it.uppercase() } ?: "Handled"} incoming call"
        path == "/phone/imu" -> "MOTION" to "Read IMU snapshot (accelerometer + gyroscope)"
        path == "/phone/imu/record" -> "MOTION" to "Recorded ${
            (body?.optLong("duration_ms") ?: params["duration_ms"]?.toLongOrNull() ?: 5_000L) / 1000
        }s IMU data at ${body?.optInt("rate_hz") ?: params["rate_hz"]?.toIntOrNull() ?: 50}Hz"
        path == "/phone/health"          -> "HEALTH" to "Read health data (${params["types"] ?: "default"}, ${params["days"] ?: "7"} days)"
        path == "/phone/wearables/scan"  -> "WEARABLES" to "Scanned for nearby BLE health devices"
        path == "/phone/wearables/read"  -> "WEARABLES" to "Read ${params["service"] ?: "?"} from ${params["device"] ?: "?"}"
        path == "/phone/recovery"        -> "HEALTH" to "Computed sleep + recovery readiness score"
        else -> "SYSTEM" to "$method $path"
    }

    // -------------------------------------------------------------------------
    // Endpoints
    // -------------------------------------------------------------------------

    // ── Health Connect ───────────────────────────────────────────────────────

    private fun handleHealthRead(params: Map<String, String>): BridgeResponse {
        val typesParam = params["types"] ?: "steps,heart_rate,sleep,calories"
        val types = typesParam.split(",").map { it.trim() }.filter { it.isNotBlank() }.toSet()
        val days  = params["days"]?.toIntOrNull()?.coerceIn(1, 90) ?: 7
        return runBlocking {
            try {
                val data = HealthDataReader.readHealth(context, types, days)
                jsonOk(data)
            } catch (e: Exception) {
                jsonError("health read failed: ${e.message}")
            }
        }
    }

    private fun handleRecovery(): BridgeResponse {
        return runBlocking {
            try {
                val data = RecoveryScorer.compute(context)
                jsonOk(data)
            } catch (e: Exception) {
                jsonError("recovery score failed: ${e.message}")
            }
        }
    }

    // ── Wearables (BLE GATT) ─────────────────────────────────────────────────

    private fun handleWearablesScan(params: Map<String, String>): BridgeResponse {
        val durationMs = params["duration_ms"]?.toLongOrNull()?.coerceIn(2_000, 15_000) ?: 8_000
        return runBlocking {
            try {
                val devices = WearableScanner.scan(context, durationMs)
                jsonOk(devices)
            } catch (e: Exception) {
                jsonError("wearable scan failed: ${e.message}")
            }
        }
    }

    private fun handleWearablesRead(params: Map<String, String>): BridgeResponse {
        val address = params["device"] ?: return jsonError("device address required")
        val service = params["service"] ?: return jsonError("service required (heart_rate|battery|body_composition|running_speed_cadence|glucose|cgm)")
        return runBlocking {
            try {
                val data = WearableScanner.readDevice(context, address, service)
                jsonOk(data)
            } catch (e: Exception) {
                jsonError("wearable read failed: ${e.message}")
            }
        }
    }

    private fun handleContactsRead(params: Map<String, String>): BridgeResponse {
        if (!hasPermission(Manifest.permission.READ_CONTACTS)) return permDenied()
        val query = params["query"] ?: ""
        val results = JSONArray()
        val selection = if (query.isNotBlank())
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?"
        else null
        val selArgs = if (query.isNotBlank()) arrayOf("%$query%") else null

        context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(
                ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                ContactsContract.CommonDataKinds.Phone.NUMBER,
            ),
            selection, selArgs, null
        )?.use { cursor ->
            while (cursor.moveToNext() && results.length() < 100) {
                results.put(JSONObject().apply {
                    put("id",    cursor.getString(0) ?: "")
                    put("name",  cursor.getString(1) ?: "")
                    put("phone", cursor.getString(2) ?: "")
                })
            }
        }
        return jsonOk(results)
    }

    private fun handleContactsWrite(body: JSONObject?): BridgeResponse {
        if (!hasPermission(Manifest.permission.WRITE_CONTACTS)) return permDenied()
        if (body == null) return jsonError("missing body")
        val name  = body.optString("name",  "")
        val phone = body.optString("phone", "")
        if (name.isBlank() || phone.isBlank()) return jsonError("name and phone required")

        val rawId = run {
            val cv = ContentValues().apply {
                put(ContactsContract.RawContacts.ACCOUNT_TYPE, null as String?)
                put(ContactsContract.RawContacts.ACCOUNT_NAME, null as String?)
            }
            val uri = context.contentResolver.insert(
                ContactsContract.RawContacts.CONTENT_URI, cv)
            uri?.lastPathSegment?.toLongOrNull() ?: return jsonError("insert raw contact failed")
        }

        ContentValues().apply {
            put(ContactsContract.Data.RAW_CONTACT_ID, rawId)
            put(ContactsContract.Data.MIMETYPE,
                ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
            put(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name)
        }.let { context.contentResolver.insert(ContactsContract.Data.CONTENT_URI, it) }

        ContentValues().apply {
            put(ContactsContract.Data.RAW_CONTACT_ID, rawId)
            put(ContactsContract.Data.MIMETYPE,
                ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
            put(ContactsContract.CommonDataKinds.Phone.NUMBER, phone)
            put(ContactsContract.CommonDataKinds.Phone.TYPE,
                ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
        }.let { context.contentResolver.insert(ContactsContract.Data.CONTENT_URI, it) }

        return jsonOk(JSONObject().put("raw_contact_id", rawId))
    }

    private fun handleSmsRead(params: Map<String, String>): BridgeResponse {
        if (!hasPermission(Manifest.permission.READ_SMS)) return permDenied()
        val box   = params["box"] ?: "inbox"
        val limit = params["limit"]?.toIntOrNull()?.coerceIn(1, 200) ?: 20
        val uri   = when (box.lowercase()) {
            "sent"  -> Telephony.Sms.Sent.CONTENT_URI
            "draft" -> Telephony.Sms.Draft.CONTENT_URI
            else    -> Telephony.Sms.Inbox.CONTENT_URI
        }
        val results = JSONArray()
        context.contentResolver.query(
            uri,
            arrayOf(Telephony.Sms._ID, Telephony.Sms.ADDRESS,
                    Telephony.Sms.BODY, Telephony.Sms.DATE),
            null, null,
            "${Telephony.Sms.DATE} DESC"
        )?.use { cursor ->
            var count = 0
            while (cursor.moveToNext() && count < limit) {
                results.put(JSONObject().apply {
                    put("id",      cursor.getString(0) ?: "")
                    put("address", cursor.getString(1) ?: "")
                    put("body",    cursor.getString(2) ?: "")
                    put("date",    cursor.getLong(3))
                })
                count++
            }
        }
        return jsonOk(results)
    }

    private fun handleSmsSend(body: JSONObject?): BridgeResponse {
        if (!hasPermission(Manifest.permission.SEND_SMS)) return permDenied()
        if (body == null) return jsonError("missing body", 400)
        val to  = body.optString("to",   "")
        val msg = body.optString("body", "")
        if (to.isBlank() || msg.isBlank()) return jsonError("to and body required", 400)
        // Basic phone number sanity check — reject obviously invalid values
        if (!Regex("""^\+?[0-9\s\-().]{5,20}$""").matches(to))
            return jsonError("invalid phone number format", 400)
        if (msg.length > 1600) return jsonError("message too long (max 1600 chars)", 400)

        // Rate limit: 5 SMS per minute
        synchronized(smsTimestamps) {
            val now = System.currentTimeMillis()
            smsTimestamps.removeAll { it < now - 60_000 }
            if (smsTimestamps.size >= 5) {
                return jsonError("rate limit exceeded (max 5 SMS/min)", 429)
            }
            smsTimestamps.add(now)
        }

        return try {
            val smsManager = context.getSystemService(android.telephony.SmsManager::class.java)
            smsManager.sendTextMessage(to, null, msg, null, null)
            jsonOk(JSONObject().put("sent", true))
        } catch (e: Exception) {
            jsonError("send failed: ${e.message}", 500)
        }
    }

    private fun handleLocation(): BridgeResponse {
        if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) &&
            !hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)) return permDenied()
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val providers = listOf(
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER,
            LocationManager.PASSIVE_PROVIDER,
        )
        for (provider in providers) {
            val loc = try { lm.getLastKnownLocation(provider) } catch (_: Exception) { null }
            if (loc != null) {
                val ageMs = System.currentTimeMillis() - loc.time
                val isStale = ageMs > 300_000 // 5 minutes (HIGH-4)
                return jsonOk(JSONObject().apply {
                    put("latitude",  loc.latitude)
                    put("longitude", loc.longitude)
                    put("accuracy",  loc.accuracy)
                    put("provider",  provider)
                    put("time",      loc.time)
                    put("age_ms",    ageMs)
                    put("stale",     isStale)
                })
            }
        }
        return jsonError("no location available", 404)
    }

    private fun handleCalendarRead(params: Map<String, String>): BridgeResponse {
        if (!hasPermission(Manifest.permission.READ_CALENDAR)) return permDenied()
        val days = params["days"]?.toIntOrNull() ?: 7
        val now  = System.currentTimeMillis()
        val end  = now + days * 86_400_000L
        val results = JSONArray()
        context.contentResolver.query(
            CalendarContract.Events.CONTENT_URI,
            arrayOf(
                CalendarContract.Events._ID,
                CalendarContract.Events.TITLE,
                CalendarContract.Events.DESCRIPTION,
                CalendarContract.Events.DTSTART,
                CalendarContract.Events.DTEND,
            ),
            "${CalendarContract.Events.DTSTART} BETWEEN ? AND ?",
            arrayOf(now.toString(), end.toString()),
            "${CalendarContract.Events.DTSTART} ASC"
        )?.use { cursor ->
            while (cursor.moveToNext() && results.length() < 50) {
                results.put(JSONObject().apply {
                    put("id",          cursor.getLong(0))
                    put("title",       cursor.getString(1) ?: "")
                    put("description", cursor.getString(2) ?: "")
                    put("dtstart",     cursor.getLong(3))
                    put("dtend",       cursor.getLong(4))
                })
            }
        }
        return jsonOk(results)
    }

    private fun handleCalendarWrite(body: JSONObject?): BridgeResponse {
        if (!hasPermission(Manifest.permission.WRITE_CALENDAR)) return permDenied()
        if (body == null) return jsonError("missing body")
        val title   = body.optString("title",  "")
        val dtstart = body.optLong("dtstart",  0L)
        val dtend   = body.optLong("dtend",    0L)
        val desc    = body.optString("description", "")
        if (title.isBlank() || dtstart == 0L) return jsonError("title and dtstart required")

        // Find first available calendar ID
        var calId = 1L
        context.contentResolver.query(
            CalendarContract.Calendars.CONTENT_URI,
            arrayOf(CalendarContract.Calendars._ID),
            null, null, null
        )?.use { if (it.moveToFirst()) calId = it.getLong(0) }

        val cv = ContentValues().apply {
            put(CalendarContract.Events.CALENDAR_ID, calId)
            put(CalendarContract.Events.TITLE,       title)
            put(CalendarContract.Events.DESCRIPTION, desc)
            put(CalendarContract.Events.DTSTART,     dtstart)
            put(CalendarContract.Events.DTEND,       if (dtend > 0) dtend else dtstart + 3_600_000L)
            put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
        }
        val uri = context.contentResolver.insert(CalendarContract.Events.CONTENT_URI, cv)
            ?: return jsonError("insert failed")
        return jsonOk(JSONObject().put("event_id", uri.lastPathSegment))
    }

    private fun handleNotify(body: JSONObject?): BridgeResponse {
        if (body == null) return jsonError("missing body")
        val title   = body.optString("title",   "0x01 Agent")
        val message = body.optString("message", "")
        if (message.isBlank()) return jsonError("message required")

        // Rate limit: 10 notifications per minute
        synchronized(notifyTimestamps) {
            val now = System.currentTimeMillis()
            notifyTimestamps.removeAll { it < now - 60_000 }
            if (notifyTimestamps.size >= 10) {
                return jsonError("rate limit exceeded (max 10 notifications/min)", 429)
            }
            notifyTimestamps.add(now)
        }

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(
                NOTIF_CHANNEL_ID, "0x01 Agent Bridge",
                NotificationManager.IMPORTANCE_DEFAULT
            )
        )
        val notif = NotificationCompat.Builder(context, NOTIF_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(message)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setAutoCancel(true)
            .build()
        // Fixed ID so each new notification replaces the previous one
        nm.notify(BRIDGE_NOTIF_ID, notif)
        return jsonOk(JSONObject().put("notified", true))
    }

    private fun handleCallLog(params: Map<String, String>): BridgeResponse {
        if (!hasPermission(Manifest.permission.READ_CALL_LOG)) return permDenied()
        val limit = params["limit"]?.toIntOrNull()?.coerceIn(1, 200) ?: 20
        val results = JSONArray()
        context.contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            arrayOf(
                CallLog.Calls._ID,
                CallLog.Calls.NUMBER,
                CallLog.Calls.TYPE,
                CallLog.Calls.DATE,
                CallLog.Calls.DURATION,
            ),
            null, null,
            "${CallLog.Calls.DATE} DESC"
        )?.use { cursor ->
            var count = 0
            while (cursor.moveToNext() && count < limit) {
                val type = when (cursor.getInt(2)) {
                    CallLog.Calls.INCOMING_TYPE  -> "incoming"
                    CallLog.Calls.OUTGOING_TYPE  -> "outgoing"
                    CallLog.Calls.MISSED_TYPE    -> "missed"
                    else                          -> "unknown"
                }
                results.put(JSONObject().apply {
                    put("id",       cursor.getString(0) ?: "")
                    put("number",   cursor.getString(1) ?: "")
                    put("type",     type)
                    put("date",     cursor.getLong(3))
                    put("duration", cursor.getLong(4))
                })
                count++
            }
        }
        return jsonOk(results)
    }

    private fun handleClipboardWrite(body: JSONObject?): BridgeResponse {
        if (body == null) return jsonError("missing body", 400)
        val text = body.optString("text", "")
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE)
            as android.content.ClipboardManager
        cm.setPrimaryClip(android.content.ClipData.newPlainText("zeroclaw", text))
        return jsonOk(JSONObject().put("set", true))
    }

    private fun handleCameraCapture(body: JSONObject?): BridgeResponse {
        if (!hasPermission(Manifest.permission.CAMERA)) return permDenied()
        if (!checkDataBudget()) return jsonError("battery below data collection budget threshold", 429)
        if (!cameraMutex.tryLock()) return jsonError("another capture is in progress", 409)

        val facingPref = if (body?.optString("facing") == "front")
            CameraCharacteristics.LENS_FACING_FRONT
        else
            CameraCharacteristics.LENS_FACING_BACK

        val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val cameraId = cm.cameraIdList.firstOrNull { id ->
            cm.getCameraCharacteristics(id)
                .get(CameraCharacteristics.LENS_FACING) == facingPref
        } ?: cm.cameraIdList.firstOrNull()
        ?: run { cameraMutex.unlock(); return jsonError("no camera available", 404) }

        val captureWidth  = 1280
        val captureHeight = 720
        val resultLatch   = CountDownLatch(1)
        var bridgeResult: BridgeResponse = jsonError("capture timeout", 504)
        var cameraRef: CameraDevice? = null  // tracked so we can close it on any path

        val ht      = HandlerThread("CameraCapture").also { it.start() }
        val handler = Handler(ht.looper)

        val imageReader = ImageReader.newInstance(captureWidth, captureHeight, ImageFormat.JPEG, 1)
        imageReader.setOnImageAvailableListener({ reader ->
            try {
                val img    = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
                val buffer = img.planes[0].buffer
                val bytes  = ByteArray(buffer.remaining()).also { b -> buffer.get(b) }
                img.close()
                cameraRef?.close()  // close camera as soon as image is in hand
                bridgeResult = jsonOk(JSONObject().apply {
                    put("width",       captureWidth)
                    put("height",      captureHeight)
                    put("format",      "jpeg")
                    put("data_base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                })
            } catch (e: Exception) {
                bridgeResult = jsonError("image read failed: ${e.message}", 500)
            } finally {
                resultLatch.countDown()
            }
        }, handler)

        val cameraCallback = object : CameraDevice.StateCallback() {
            override fun onOpened(camera: CameraDevice) {
                cameraRef = camera
                try {
                    @Suppress("DEPRECATION")
                    camera.createCaptureSession(
                        listOf(imageReader.surface),
                        object : CameraCaptureSession.StateCallback() {
                            override fun onConfigured(session: CameraCaptureSession) {
                                try {
                                    val req = camera.createCaptureRequest(
                                        CameraDevice.TEMPLATE_STILL_CAPTURE
                                    ).apply {
                                        addTarget(imageReader.surface)
                                        set(CaptureRequest.CONTROL_MODE,
                                            CaptureRequest.CONTROL_MODE_AUTO)
                                    }.build()
                                    session.capture(req, null, handler)
                                } catch (e: Exception) {
                                    bridgeResult = jsonError("capture failed: ${e.message}", 500)
                                    camera.close(); resultLatch.countDown()
                                }
                            }
                            override fun onConfigureFailed(session: CameraCaptureSession) {
                                bridgeResult = jsonError("session configure failed", 500)
                                camera.close(); resultLatch.countDown()
                            }
                        },
                        handler
                    )
                } catch (e: Exception) {
                    bridgeResult = jsonError("session creation failed: ${e.message}", 500)
                    camera.close(); resultLatch.countDown()
                }
            }
            override fun onDisconnected(camera: CameraDevice) {
                camera.close()
                if (resultLatch.count > 0) {
                    bridgeResult = jsonError("camera disconnected", 503)
                    resultLatch.countDown()
                }
            }
            override fun onError(camera: CameraDevice, error: Int) {
                camera.close()
                bridgeResult = jsonError("camera error code: $error", 500)
                if (resultLatch.count > 0) resultLatch.countDown()
            }
        }

        return try {
            @SuppressLint("MissingPermission") // permission checked at top of method
            cm.openCamera(cameraId, cameraCallback, handler)
            resultLatch.await(10, TimeUnit.SECONDS)
            ht.quitSafely()
            ht.join()           // wait for handler thread to drain before closing ImageReader
            cameraRef?.close()  // no-op if already closed in onImageAvailable; handles timeout path
            imageReader.close()
            bridgeResult
        } catch (e: SecurityException) {
            ht.quitSafely(); ht.join(); cameraRef?.close(); imageReader.close()
            permDenied()
        } catch (e: Exception) {
            ht.quitSafely(); ht.join(); cameraRef?.close(); imageReader.close()
            jsonError("camera open failed: ${e.message}", 500)
        } finally {
            cameraMutex.unlock()
        }
    }

    private fun handleAudioRecord(body: JSONObject?): BridgeResponse {
        if (!hasPermission(Manifest.permission.RECORD_AUDIO)) return permDenied()
        if (!checkDataBudget()) return jsonError("battery below data collection budget threshold", 429)
        val durationMs = body?.optLong("duration_ms", 3_000L) ?: 3_000L
        val maxMs      = 30_000L
        val clampedMs  = durationMs.coerceIn(500L, maxMs)

        // tryLock gives an immediate 409 if already recording — avoids the TOCTOU
        // that the old isLocked-then-withLock pattern had.
        if (!audioMutex.tryLock()) return jsonError("another recording is in progress", 409)

        val deferred = scope.async {
            var outFile: File? = null
            var recorder: MediaRecorder? = null
            try {
                outFile = File(context.cacheDir, "bridge_audio_${System.currentTimeMillis()}.aac")
                recorder = MediaRecorder().apply {
                    setAudioSource(MediaRecorder.AudioSource.MIC)
                    setOutputFormat(MediaRecorder.OutputFormat.AAC_ADTS)
                    setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                    setOutputFile(outFile!!.absolutePath)
                    prepare()
                    start()
                }
                delay(clampedMs)
                recorder.stop()

                val bytes = outFile.readBytes()
                val b64   = Base64.encodeToString(bytes, Base64.NO_WRAP)
                jsonOk(JSONObject().apply {
                    put("duration_ms", clampedMs)
                    put("format",      "aac")
                    put("data_base64", b64)
                    put("note",        "recording complete")
                })
            } catch (e: Exception) {
                jsonError("audio record failed: ${e.message}", 500)
            } finally {
                recorder?.release()
                outFile?.delete()
                audioMutex.unlock()
            }
        }

        return runBlocking { deferred.await() }
    }

    private fun handlePermissions(): BridgeResponse {
        val perms = mutableMapOf(
            "READ_CONTACTS"        to Manifest.permission.READ_CONTACTS,
            "WRITE_CONTACTS"       to Manifest.permission.WRITE_CONTACTS,
            "READ_SMS"             to Manifest.permission.READ_SMS,
            "SEND_SMS"             to Manifest.permission.SEND_SMS,
            "ACCESS_FINE_LOCATION" to Manifest.permission.ACCESS_FINE_LOCATION,
            "READ_CALENDAR"        to Manifest.permission.READ_CALENDAR,
            "WRITE_CALENDAR"       to Manifest.permission.WRITE_CALENDAR,
            "READ_CALL_LOG"        to Manifest.permission.READ_CALL_LOG,
            "CAMERA"               to Manifest.permission.CAMERA,
            "RECORD_AUDIO"         to Manifest.permission.RECORD_AUDIO,
            "READ_PHONE_STATE"     to Manifest.permission.READ_PHONE_STATE,
        )
        perms["READ_MEDIA_IMAGES"]      = Manifest.permission.READ_MEDIA_IMAGES
        perms["BLUETOOTH_CONNECT"]      = Manifest.permission.BLUETOOTH_CONNECT
        perms["ACTIVITY_RECOGNITION"]   = Manifest.permission.ACTIVITY_RECOGNITION
        val result = JSONObject()
        for ((name, manifest) in perms) {
            result.put(name, hasPermission(manifest))
        }
        return jsonOk(result)
    }

    private fun handleDevice(): BridgeResponse {
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager
        val bounds = wm.currentWindowMetrics.bounds
        val screenWidth  = bounds.width()
        val screenHeight = bounds.height()
        return jsonOk(JSONObject().apply {
            put("manufacturer",   Build.MANUFACTURER)
            put("model",          Build.MODEL)
            put("brand",          Build.BRAND)
            put("android_version", Build.VERSION.RELEASE)
            put("sdk_int",        Build.VERSION.SDK_INT)
            put("screen_width",   screenWidth)
            put("screen_height",  screenHeight)
            put("locale",         Locale.getDefault().toString())
        })
    }

    private fun handleBattery(): BridgeResponse {
        val intent = context.registerReceiver(
            null,
            IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        ) ?: return jsonError("battery info unavailable", 503)
        val level   = intent.getIntExtra(BatteryManager.EXTRA_LEVEL,  -1)
        val scale   = intent.getIntExtra(BatteryManager.EXTRA_SCALE,  -1)
        val status  = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)
        val pct     = if (scale > 0) (level * 100f / scale).toInt() else -1
        val statusStr = when (status) {
            BatteryManager.BATTERY_STATUS_CHARGING    -> "charging"
            BatteryManager.BATTERY_STATUS_DISCHARGING -> "discharging"
            BatteryManager.BATTERY_STATUS_FULL        -> "full"
            BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "not_charging"
            else -> "unknown"
        }
        val sourceStr = when (plugged) {
            BatteryManager.BATTERY_PLUGGED_AC     -> "ac"
            BatteryManager.BATTERY_PLUGGED_USB    -> "usb"
            BatteryManager.BATTERY_PLUGGED_WIRELESS -> "wireless"
            else -> "unplugged"
        }
        return jsonOk(JSONObject().apply {
            put("percent", pct)
            put("status",  statusStr)
            put("source",  sourceStr)
        })
    }

    private fun handleVibrate(body: JSONObject?): BridgeResponse {
        val durationMs = body?.optLong("duration_ms", 200L)?.coerceIn(1L, 5_000L) ?: 200L
        val amplitude  = body?.optInt("amplitude", -1)?.coerceIn(-1, 255) ?: -1
        return try {
            val vm = context.getSystemService(VibratorManager::class.java)
            val effect = if (amplitude == -1)
                VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE)
            else
                VibrationEffect.createOneShot(durationMs, amplitude)
            vm.defaultVibrator.vibrate(effect)
            jsonOk(JSONObject().put("vibrating", true).put("duration_ms", durationMs))
        } catch (e: Exception) {
            jsonError("vibrate failed: ${e.message}", 500)
        }
    }

    private fun handleTimezone(): BridgeResponse {
        val tz = TimeZone.getDefault()
        return jsonOk(JSONObject().apply {
            put("id",          tz.id)
            put("display_name", tz.getDisplayName(false, TimeZone.SHORT))
            put("offset_ms",   tz.rawOffset)
            put("dst_active",  tz.inDaylightTime(Date()))
        })
    }

    private fun handleNetwork(): BridgeResponse {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val net = cm.activeNetwork
        val caps = if (net != null) cm.getNetworkCapabilities(net) else null
        val connected = caps != null
        val type = when {
            caps == null                                              -> "none"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)    -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else                                                      -> "other"
        }
        return jsonOk(JSONObject().apply {
            put("connected", connected)
            put("type",      type)
            put("internet",  caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ?: false)
            put("validated", caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) ?: false)
        })
    }

    @SuppressLint("WifiManagerPotentialLeak")
    private fun handleWifi(): BridgeResponse {
        val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        // getConnectionInfo() is deprecated in API 31+; the async NetworkCallback replacement
        // is incompatible with our sync endpoint pattern. On API 29+ SSID/BSSID also require
        // ACCESS_FINE_LOCATION — if not granted they come back as "<unknown ssid>" which we
        // already handle below.
        @Suppress("DEPRECATION")
        val info = wm.connectionInfo
        val ssid = info.ssid.removeSurrounding("\"").let {
            if (it == "<unknown ssid>") null else it
        }
        val ipInt = info.ipAddress
        val ip = if (ipInt != 0)
            "${ipInt and 0xff}.${(ipInt shr 8) and 0xff}.${(ipInt shr 16) and 0xff}.${(ipInt shr 24) and 0xff}"
        else null
        return jsonOk(JSONObject().apply {
            put("enabled",    wm.isWifiEnabled)
            if (ssid != null) put("ssid", ssid)
            if (ip != null)   put("ip",   ip)
            put("rssi",      info.rssi)
            put("link_speed", info.linkSpeed)
            put("frequency",  info.frequency)
            put("state",      wm.wifiState)
        })
    }

    @SuppressLint("MissingPermission")
    private fun handleCarrier(): BridgeResponse {
        if (!hasPermission(Manifest.permission.READ_PHONE_STATE)) return permDenied()
        val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        // callState and dataNetworkType are deprecated on API 31+ (multi-SIM awareness);
        // the replacements require subscription IDs we don't track, so suppress for now.
        @Suppress("DEPRECATION")
        val callState = when (tm.callState) {
            TelephonyManager.CALL_STATE_IDLE    -> "idle"
            TelephonyManager.CALL_STATE_RINGING -> "ringing"
            TelephonyManager.CALL_STATE_OFFHOOK -> "offhook"
            else -> "unknown"
        }
        @Suppress("DEPRECATION")
        val networkType = tm.dataNetworkType
        return jsonOk(JSONObject().apply {
            put("operator_name",   tm.networkOperatorName.ifBlank { null })
            put("sim_operator",    tm.simOperatorName.ifBlank { null })
            put("country_iso",     tm.networkCountryIso.ifBlank { null })
            put("network_type",    networkType)
            put("roaming",         tm.isNetworkRoaming)
            put("call_state",      callState)
        })
    }

    @SuppressLint("MissingPermission")
    private fun handleBluetooth(): BridgeResponse {
        val bm = context.getSystemService(BluetoothManager::class.java)
        val adapter = bm?.adapter
        if (adapter == null) return jsonError("bluetooth not available", 404)
        if (!adapter.isEnabled) return jsonOk(JSONObject().apply {
            put("enabled", false)
            put("devices", JSONArray())
        })
        if (!hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) return permDenied()
        val devices = JSONArray()
        for (device in adapter.bondedDevices ?: emptySet()) {
            devices.put(JSONObject().apply {
                put("address", device.address)
                put("name",    device.name ?: "")
                put("type",    when (device.type) {
                    BluetoothDevice.DEVICE_TYPE_CLASSIC -> "classic"
                    BluetoothDevice.DEVICE_TYPE_LE      -> "le"
                    BluetoothDevice.DEVICE_TYPE_DUAL    -> "dual"
                    else -> "unknown"
                })
            })
        }
        return jsonOk(JSONObject().apply {
            put("enabled", true)
            put("devices", devices)
        })
    }

    private fun handleActivity(): BridgeResponse {
        if (!hasPermission(Manifest.permission.ACTIVITY_RECOGNITION)) return permDenied()
        val sm = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val sensor = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
            ?: return jsonError("step counter sensor not available", 404)

        val latch = CountDownLatch(1)
        var steps = -1L
        val listener = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
                steps = event.values[0].toLong()
                latch.countDown()
            }
            override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {}
        }
        sm.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_NORMAL)
        val got = latch.await(5, TimeUnit.SECONDS)
        sm.unregisterListener(listener)
        return if (got)
            jsonOk(JSONObject().put("steps_since_reboot", steps))
        else
            jsonError("step count not available (sensor timeout)", 503)
    }

    /**
     * Returns true if the current battery level meets the operator-configured
     * data-collection budget threshold.  Call before any long-running sensor op.
     */
    private fun checkDataBudget(): Boolean {
        val budgetPct = context.getSharedPreferences("zerox1_bridge", Context.MODE_PRIVATE)
            .getInt("data_budget_pct", 100)
        if (budgetPct == 0) return false
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as android.os.BatteryManager
        val batteryPct = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return batteryPct >= budgetPct
    }

    private fun handleImuSnapshot(): BridgeResponse {
        val sm = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val accelSensor = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
            ?: return jsonError("accelerometer not available", 404)
        val gyroSensor = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE)

        val needed = if (gyroSensor != null) 2 else 1
        val latch   = CountDownLatch(needed)

        var ax = 0f; var ay = 0f; var az = 0f
        var gx = 0f; var gy = 0f; var gz = 0f
        var gyroReady = false

        val accelListener = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
                ax = event.values[0]; ay = event.values[1]; az = event.values[2]
                latch.countDown()
            }
            override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {}
        }
        val gyroListener = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
                gx = event.values[0]; gy = event.values[1]; gz = event.values[2]
                gyroReady = true
                latch.countDown()
            }
            override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {}
        }

        sm.registerListener(accelListener, accelSensor, SensorManager.SENSOR_DELAY_NORMAL)
        gyroSensor?.let { sm.registerListener(gyroListener, it, SensorManager.SENSOR_DELAY_NORMAL) }

        val got = latch.await(5, TimeUnit.SECONDS)
        sm.unregisterListener(accelListener)
        gyroSensor?.let { sm.unregisterListener(gyroListener) }

        if (!got) return jsonError("IMU snapshot timeout", 503)

        val result = JSONObject()
            .put("timestamp_ms", System.currentTimeMillis())
            .put("accelerometer", JSONObject()
                .put("x", ax).put("y", ay).put("z", az).put("unit", "m/s²"))
        if (gyroReady) {
            result.put("gyroscope", JSONObject()
                .put("x", gx).put("y", gy).put("z", gz).put("unit", "rad/s"))
        }
        return jsonOk(result)
    }

    private fun handleImuRecord(body: JSONObject?, params: Map<String, String>): BridgeResponse {
        val durationMs = (body?.optLong("duration_ms")
            ?: params["duration_ms"]?.toLongOrNull() ?: 5_000L).coerceIn(500L, 30_000L)
        val rateHz = (body?.optInt("rate_hz")
            ?: params["rate_hz"]?.toIntOrNull() ?: 50).coerceIn(10, 200)
        val delayUs = (1_000_000.0 / rateHz).toInt()

        if (!checkDataBudget()) return jsonError("battery below data collection budget threshold", 429)
        if (!imuMutex.tryLock()) return jsonError("another IMU recording is in progress", 409)

        val deferred = scope.async {
            try {
                val sm = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
                val accelSensor = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
                val gyroSensor  = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE)

                if (accelSensor == null) return@async jsonError("accelerometer not available", 404)

                // CopyOnWriteArrayList: sensor callbacks write from main thread,
                // coroutine reads after delay from IO thread — needs thread safety.
                val accelSamples = java.util.concurrent.CopyOnWriteArrayList<JSONObject>()
                val gyroSamples  = java.util.concurrent.CopyOnWriteArrayList<JSONObject>()
                val startMs = System.currentTimeMillis()

                val accelListener = object : SensorEventListener {
                    override fun onSensorChanged(event: SensorEvent) {
                        accelSamples.add(JSONObject()
                            .put("t_ms", System.currentTimeMillis() - startMs)
                            .put("x", event.values[0])
                            .put("y", event.values[1])
                            .put("z", event.values[2]))
                    }
                    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {}
                }
                val gyroListener = object : SensorEventListener {
                    override fun onSensorChanged(event: SensorEvent) {
                        gyroSamples.add(JSONObject()
                            .put("t_ms", System.currentTimeMillis() - startMs)
                            .put("x", event.values[0])
                            .put("y", event.values[1])
                            .put("z", event.values[2]))
                    }
                    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {}
                }

                sm.registerListener(accelListener, accelSensor, delayUs)
                gyroSensor?.let { sm.registerListener(gyroListener, it, delayUs) }

                delay(durationMs)

                sm.unregisterListener(accelListener)
                gyroSensor?.let { sm.unregisterListener(gyroListener) }

                val accelArr = JSONArray().apply { accelSamples.forEach { put(it) } }
                val gyroArr  = JSONArray().apply { gyroSamples.forEach { put(it) } }

                jsonOk(JSONObject()
                    .put("duration_ms", durationMs)
                    .put("rate_hz", rateHz)
                    .put("sample_count", accelSamples.size)
                    .put("has_gyroscope", gyroSensor != null)
                    .put("accelerometer", accelArr)
                    .put("gyroscope", gyroArr))
            } finally {
                imuMutex.unlock()
            }
        }
        return runBlocking { deferred.await() }
    }

    private fun handleMediaImages(params: Map<String, String>): BridgeResponse {
        if (!hasPermission(Manifest.permission.READ_MEDIA_IMAGES)) return permDenied()

        val limit  = params["limit"]?.toIntOrNull()?.coerceIn(1, 50) ?: 20
        val offset = params["offset"]?.toIntOrNull()?.coerceAtLeast(0) ?: 0
        val results = JSONArray()
        context.contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            arrayOf(
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.DATE_TAKEN,
                MediaStore.Images.Media.SIZE,
                MediaStore.Images.Media.WIDTH,
                MediaStore.Images.Media.HEIGHT,
            ),
            null, null,
            "${MediaStore.Images.Media.DATE_TAKEN} DESC"
        )?.use { cursor ->
            // moveToPosition(offset-1) puts the cursor just before the first wanted row so
            // the subsequent moveToNext() lands on row `offset`. O(1) seek vs O(N) skip loop.
            if (offset > 0 && !cursor.moveToPosition(offset - 1)) return@use
            while (cursor.moveToNext() && results.length() < limit) {
                val id  = cursor.getLong(0)
                val uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                    .buildUpon().appendPath(id.toString()).build()
                results.put(JSONObject().apply {
                    put("id",           id)
                    put("uri",          uri.toString())
                    put("name",         cursor.getString(1) ?: "")
                    put("date_taken",   cursor.getLong(2))
                    put("size_bytes",   cursor.getLong(3))
                    put("width",        cursor.getInt(4))
                    put("height",       cursor.getInt(5))
                })
            }
        }
        return jsonOk(results)
    }

    private fun handleContactsUpdate(contactId: String, body: JSONObject?): BridgeResponse {
        if (!hasPermission(Manifest.permission.WRITE_CONTACTS)) return permDenied()
        if (body == null) return jsonError("missing body")
        val id = contactId.toLongOrNull() ?: return jsonError("invalid contact id", 400)

        val name  = body.optString("name",  "")
        val phone = body.optString("phone", "")
        if (name.isBlank() && phone.isBlank()) return jsonError("name or phone required", 400)

        var updated = 0
        if (name.isNotBlank()) {
            val cv = ContentValues().apply {
                put(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name)
            }
            updated += context.contentResolver.update(
                ContactsContract.Data.CONTENT_URI,
                cv,
                "${ContactsContract.Data.CONTACT_ID} = ? AND " +
                    "${ContactsContract.Data.MIMETYPE} = ?",
                arrayOf(
                    id.toString(),
                    ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE
                )
            )
        }
        if (phone.isNotBlank()) {
            val cv = ContentValues().apply {
                put(ContactsContract.CommonDataKinds.Phone.NUMBER, phone)
            }
            updated += context.contentResolver.update(
                ContactsContract.Data.CONTENT_URI,
                cv,
                "${ContactsContract.Data.CONTACT_ID} = ? AND " +
                    "${ContactsContract.Data.MIMETYPE} = ?",
                arrayOf(
                    id.toString(),
                    ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE
                )
            )
        }
        return jsonOk(JSONObject().put("rows_updated", updated))
    }

    private fun handleCalendarUpdate(eventId: String, body: JSONObject?): BridgeResponse {
        if (!hasPermission(Manifest.permission.WRITE_CALENDAR)) return permDenied()
        if (body == null) return jsonError("missing body")
        val id = eventId.toLongOrNull() ?: return jsonError("invalid event id", 400)

        val cv = ContentValues()
        body.optString("title").takeIf { it.isNotBlank() }?.let {
            cv.put(CalendarContract.Events.TITLE, it)
        }
        body.optString("description").takeIf { it.isNotBlank() }?.let {
            cv.put(CalendarContract.Events.DESCRIPTION, it)
        }
        // optLong avoids JSONException if the caller passes a non-numeric value
        body.optLong("dtstart", 0L).takeIf { it > 0 }?.let {
            cv.put(CalendarContract.Events.DTSTART, it)
        }
        body.optLong("dtend", 0L).takeIf { it > 0 }?.let {
            cv.put(CalendarContract.Events.DTEND, it)
        }

        if (cv.size() == 0) return jsonError("no updatable fields provided", 400)

        val updated = context.contentResolver.update(
            CalendarContract.Events.CONTENT_URI,
            cv,
            "${CalendarContract.Events._ID} = ?",
            arrayOf(id.toString())
        )
        return jsonOk(JSONObject().put("rows_updated", updated))
    }

    // -------------------------------------------------------------------------
    // Accessibility Service endpoints
    // -------------------------------------------------------------------------

    private fun handleA11yStatus(): BridgeResponse {
        return jsonOk(JSONObject().apply {
            put("connected", AgentAccessibilityService.isConnected())
        })
    }

    private fun handleA11yTree(): BridgeResponse {
        val svc = AgentAccessibilityService.instance
            ?: return jsonError("accessibility service not connected — enable in Settings", 503)
        return jsonOk(svc.dumpUiTree())
    }

    private fun handleA11yAction(body: JSONObject?): BridgeResponse {
        if (body == null) return jsonError("missing body", 400)
        val svc = AgentAccessibilityService.instance
            ?: return jsonError("accessibility service not connected", 503)
        val viewId = body.optString("viewId", "")
        val action = body.optString("action", "")
        val text   = body.optString("text", null)
        if (viewId.isBlank() || action.isBlank()) return jsonError("viewId and action required", 400)
        val result = svc.performNodeAction(viewId, action, text)
        return jsonOk(JSONObject().put("success", result))
    }

    private fun handleA11yClick(body: JSONObject?): BridgeResponse {
        if (body == null) return jsonError("missing body", 400)
        val svc = AgentAccessibilityService.instance
            ?: return jsonError("accessibility service not connected", 503)
        val x = body.optInt("x", -1)
        val y = body.optInt("y", -1)
        if (x < 0 || y < 0) return jsonError("x and y coordinates required", 400)
        val result = svc.clickAtCoordinates(x, y)
        return jsonOk(JSONObject().put("success", result))
    }

    private fun handleA11yGlobal(body: JSONObject?): BridgeResponse {
        if (body == null) return jsonError("missing body", 400)
        val svc = AgentAccessibilityService.instance
            ?: return jsonError("accessibility service not connected", 503)
        val action = body.optString("action", "")
        if (action.isBlank()) return jsonError("action required", 400)
        val result = svc.performGlobalAction(action)
        return jsonOk(JSONObject().put("success", result))
    }

    private fun handleA11yScreenshot(): BridgeResponse {
        val svc = AgentAccessibilityService.instance
            ?: return jsonError("accessibility service not connected", 503)
        val b64 = svc.captureScreenshot()
            ?: return jsonError("screenshot failed (requires Android 11+)", 500)
        return jsonOk(JSONObject().apply {
            put("format", "jpeg")
            put("data_base64", b64)
        })
    }

    // -------------------------------------------------------------------------
    // Gemini Vision — screenshot + optional UI tree → structured actions
    // -------------------------------------------------------------------------

    /**
     * POST /phone/a11y/vision
     * Body: { "prompt": "...", "include_tree": true|false }
     *
     * Captures a screenshot, optionally includes the UI tree, and sends both
     * to Gemini 2.5 Flash Vision for analysis. Returns the model's response
     * with structured action suggestions.
     */
    // Rate limit: max 1 vision call per 3 seconds
    @Volatile
    private var lastVisionCallMs = 0L

    private fun handleA11yVision(body: JSONObject?): BridgeResponse {
        // Rate limit
        val now = System.currentTimeMillis()
        if (now - lastVisionCallMs < 3_000L) {
            return jsonError("Vision rate limited (max 1 call per 3s)", 429)
        }
        lastVisionCallMs = now

        // 1. Validate input
        val prompt = body?.optString("prompt", "")?.takeIf { it.isNotBlank() }
            ?: return jsonError("'prompt' is required", 400)
        val includeTree = body.optBoolean("include_tree", false)

        // 2. Read API key from encrypted storage
        val apiKey = getGeminiApiKey()
            ?: return jsonError("No Gemini API key configured — set it in Settings → Agent Brain", 400)

        // 3. Capture screenshot
        val svc = AgentAccessibilityService.instance
            ?: return jsonError("accessibility service not connected — enable in Settings", 503)
        val screenshotB64 = svc.captureScreenshot()
            ?: return jsonError("screenshot failed (requires Android 11+)", 500)

        // 4. Build system prompt with optional UI tree context
        val systemParts = StringBuilder()
        systemParts.append("You are a device-control AI. Analyze the screenshot and respond with a JSON object containing:\n")
        systemParts.append("- \"analysis\": a brief description of what you see on screen\n")
        systemParts.append("- \"actions\": an array of actions to perform, each with:\n")
        systemParts.append("  - \"type\": \"click\" | \"type_text\" | \"scroll\" | \"global\" | \"wait\"\n")
        systemParts.append("  - \"x\", \"y\": pixel coordinates (for click)\n")
        systemParts.append("  - \"text\": text to type (for type_text)\n")
        systemParts.append("  - \"direction\": \"up\" | \"down\" | \"left\" | \"right\" (for scroll)\n")
        systemParts.append("  - \"action\": \"BACK\" | \"HOME\" | \"RECENTS\" (for global)\n")
        systemParts.append("  - \"description\": what this action does\n")
        systemParts.append("Respond ONLY with valid JSON, no markdown fences.")

        if (includeTree) {
            try {
                val tree = svc.dumpUiTree()
                systemParts.append("\n\nUI accessibility tree:\n")
                systemParts.append(tree.toString().take(8000)) // Cap at 8K chars
            } catch (e: Exception) {
                Log.w(TAG, "Failed to dump UI tree for vision context: $e")
            }
        }

        // 5. Build Gemini API request — API key in header, not URL
        val model = "gemini-2.5-flash"
        val url = java.net.URL(
            "https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent"
        )

        val requestBody = JSONObject().apply {
            put("contents", JSONArray().put(JSONObject().apply {
                put("parts", JSONArray().apply {
                    // Text part: system instructions + user prompt
                    put(JSONObject().apply {
                        put("text", "${systemParts}\n\nUser request: $prompt")
                    })
                    // Image part: screenshot
                    put(JSONObject().apply {
                        put("inline_data", JSONObject().apply {
                            put("mime_type", "image/jpeg")
                            put("data", screenshotB64)
                        })
                    })
                })
            }))
            put("generationConfig", JSONObject().apply {
                put("temperature", 0.1)
                put("maxOutputTokens", 2048)
            })
        }

        // 6. Call Gemini API (blocking — ok because bridge runs on IO thread)
        return try {
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("x-goog-api-key", apiKey)
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.doOutput = true

            conn.outputStream.bufferedWriter().use { it.write(requestBody.toString()) }

            val responseCode = conn.responseCode
            val responseText = if (responseCode in 200..299) {
                conn.inputStream.bufferedReader().use { it.readText() }
            } else {
                val errorText = conn.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
                conn.disconnect()
                return jsonError("Gemini API error ($responseCode): $errorText", 502)
            }
            conn.disconnect()

            // 7. Parse response — extract text from candidates[0].content.parts[0].text
            val geminiResp = JSONObject(responseText)
            val candidates = geminiResp.optJSONArray("candidates")
            val text = candidates
                ?.optJSONObject(0)
                ?.optJSONObject("content")
                ?.optJSONArray("parts")
                ?.optJSONObject(0)
                ?.optString("text", "")
                ?: ""

            // Try to parse the model output as JSON; if it fails, return raw text
            val result = try {
                JSONObject(text.trim().removePrefix("```json").removePrefix("```").removeSuffix("```").trim())
            } catch (_: Exception) {
                JSONObject().apply {
                    put("analysis", text)
                    put("actions", JSONArray())
                }
            }

            jsonOk(result)
        } catch (e: Exception) {
            Log.e(TAG, "Gemini Vision call failed: ${e.message}")
            jsonError("Gemini Vision call failed: ${e.message}", 502)
        }
    }

    /**
     * Read the LLM API key from Android EncryptedSharedPreferences.
     */
    private fun getGeminiApiKey(): String? {
        return try {
            val masterKey = androidx.security.crypto.MasterKey.Builder(context)
                .setKeyScheme(androidx.security.crypto.MasterKey.KeyScheme.AES256_GCM)
                .build()
            val prefs = androidx.security.crypto.EncryptedSharedPreferences.create(
                context,
                "zerox1_secure",
                masterKey,
                androidx.security.crypto.EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                androidx.security.crypto.EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            prefs.getString("llm_api_key", null)?.takeIf { it.isNotBlank() }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to read API key: $e")
            null
        }
    }

    // -------------------------------------------------------------------------
    // Notification Listener endpoints
    // -------------------------------------------------------------------------

    private fun handleNotificationsGet(): BridgeResponse {
        val svc = AgentNotificationListener.instance
            ?: return jsonError("notification listener not connected — enable in Settings", 503)
        return jsonOk(svc.getActiveNotificationsJson())
    }

    private fun handleNotificationsHistory(): BridgeResponse {
        val svc = AgentNotificationListener.instance
            ?: return jsonError("notification listener not connected", 503)
        return jsonOk(svc.getHistoryJson())
    }

    private fun handleNotificationsReply(body: JSONObject?): BridgeResponse {
        if (body == null) return jsonError("missing body", 400)
        val svc = AgentNotificationListener.instance
            ?: return jsonError("notification listener not connected", 503)
        val key  = body.optString("key", "")
        val text = body.optString("text", "")
        if (key.isBlank() || text.isBlank()) return jsonError("key and text required", 400)
        val result = svc.replyToNotification(key, text)
        return if (result) jsonOk(JSONObject().put("replied", true))
        else jsonError("no reply action found on notification", 404)
    }

    private fun handleNotificationsDismiss(body: JSONObject?): BridgeResponse {
        if (body == null) return jsonError("missing body", 400)
        val svc = AgentNotificationListener.instance
            ?: return jsonError("notification listener not connected", 503)
        val key = body.optString("key", "")
        if (key.isBlank()) return jsonError("key required", 400)
        val result = svc.dismissNotificationByKey(key)
        return jsonOk(JSONObject().put("dismissed", result))
    }

    // -------------------------------------------------------------------------
    // Call Screening endpoints
    // -------------------------------------------------------------------------

    private fun handleCallsPending(): BridgeResponse {
        return jsonOk(AgentCallScreeningService.getPendingCallsJson())
    }

    private fun handleCallsHistory(): BridgeResponse {
        return jsonOk(AgentCallScreeningService.getHistoryJson())
    }

    private fun handleCallsRespond(body: JSONObject?): BridgeResponse {
        if (body == null) return jsonError("missing body", 400)
        val callId = body.optString("callId", "")
        val action = body.optString("action", "")
        if (callId.isBlank() || action.isBlank()) return jsonError("callId and action required", 400)
        val result = AgentCallScreeningService.respondToCall(callId, action)
        return if (result) jsonOk(JSONObject().put("responded", true))
        else jsonError("call not found or already decided", 404)
    }

    // -------------------------------------------------------------------------
    // New endpoints: audio profile, alarm, app usage, documents, activity log
    // -------------------------------------------------------------------------

    private fun handleAudioProfileGet(): BridgeResponse {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
        val streams = mapOf(
            "music"        to android.media.AudioManager.STREAM_MUSIC,
            "ring"         to android.media.AudioManager.STREAM_RING,
            "notification" to android.media.AudioManager.STREAM_NOTIFICATION,
            "alarm"        to android.media.AudioManager.STREAM_ALARM,
            "voice_call"   to android.media.AudioManager.STREAM_VOICE_CALL,
        )
        val volumes = JSONObject()
        for ((name, stream) in streams) {
            volumes.put(name, JSONObject().apply {
                put("volume", am.getStreamVolume(stream))
                put("max",    am.getStreamMaxVolume(stream))
            })
        }
        val nm2 = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        val dndMode = when (nm2.currentInterruptionFilter) {
            android.app.NotificationManager.INTERRUPTION_FILTER_ALL       -> "all"
            android.app.NotificationManager.INTERRUPTION_FILTER_PRIORITY  -> "priority"
            android.app.NotificationManager.INTERRUPTION_FILTER_NONE      -> "none"
            android.app.NotificationManager.INTERRUPTION_FILTER_ALARMS    -> "alarms"
            else -> "unknown"
        }

        val ringerMode = when (am.ringerMode) {
            android.media.AudioManager.RINGER_MODE_NORMAL  -> "normal"
            android.media.AudioManager.RINGER_MODE_VIBRATE -> "vibrate"
            android.media.AudioManager.RINGER_MODE_SILENT  -> "silent"
            else -> "unknown"
        }

        return jsonOk(JSONObject().apply {
            put("streams",     volumes)
            put("ringer_mode", ringerMode)
            put("dnd_mode",    dndMode)
        })
    }

    private fun handleAudioProfileSet(body: JSONObject?): BridgeResponse {
        if (body == null) return jsonError("missing body", 400)
        val am = context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager

        // Set volume for a stream
        val streamName = body.optString("stream", "")
        val streamMap = mapOf(
            "music"        to android.media.AudioManager.STREAM_MUSIC,
            "ring"         to android.media.AudioManager.STREAM_RING,
            "notification" to android.media.AudioManager.STREAM_NOTIFICATION,
            "alarm"        to android.media.AudioManager.STREAM_ALARM,
        )
        if (streamName.isNotBlank() && body.has("volume")) {
            val streamId = streamMap[streamName] ?: return jsonError("unknown stream: $streamName", 400)
            if (!hasPermission(Manifest.permission.MODIFY_AUDIO_SETTINGS))
                return permDenied()
            val level = body.optInt("volume", -1)
            val max   = am.getStreamMaxVolume(streamId)
            if (level < 0 || level > max) return jsonError("volume must be 0–$max", 400)
            am.setStreamVolume(streamId, level, 0)
            return jsonOk(JSONObject().put("stream", streamName).put("volume", level))
        }

        // Set DND mode
        val dnd = body.optString("dnd_mode", "")
        if (dnd.isNotBlank()) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            if (!nm.isNotificationPolicyAccessGranted)
                return jsonError("PERMISSION_DENIED — grant Notification Policy access in Settings", 403)
            val filter = when (dnd.lowercase()) {
                "all"      -> android.app.NotificationManager.INTERRUPTION_FILTER_ALL
                "priority" -> android.app.NotificationManager.INTERRUPTION_FILTER_PRIORITY
                "none"     -> android.app.NotificationManager.INTERRUPTION_FILTER_NONE
                "alarms"   -> android.app.NotificationManager.INTERRUPTION_FILTER_ALARMS
                else       -> return jsonError("unknown dnd_mode: $dnd", 400)
            }
            nm.setInterruptionFilter(filter)
            return jsonOk(JSONObject().put("dnd_mode", dnd))
        }

        return jsonError("provide 'stream' + 'volume' or 'dnd_mode'", 400)
    }

    private fun handleAlarmSet(body: JSONObject?): BridgeResponse {
        if (body == null) return jsonError("missing body", 400)
        val hour    = body.optInt("hour",   -1)
        val minute  = body.optInt("minute", -1)
        val message = body.optString("message", "")
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
            return jsonError("hour (0-23) and minute (0-59) required", 400)

        val intent = Intent(android.provider.AlarmClock.ACTION_SET_ALARM).apply {
            putExtra(android.provider.AlarmClock.EXTRA_HOUR,    hour)
            putExtra(android.provider.AlarmClock.EXTRA_MINUTES, minute)
            if (message.isNotBlank())
                putExtra(android.provider.AlarmClock.EXTRA_MESSAGE, message.take(200))
            // SKIP_UI = true sets alarm silently; may not be honoured on all OEMs
            putExtra(android.provider.AlarmClock.EXTRA_SKIP_UI, true)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            context.startActivity(intent)
            jsonOk(JSONObject().apply {
                put("hour",    hour)
                put("minute",  minute)
                put("message", message)
            })
        } catch (e: Exception) {
            jsonError("could not set alarm: ${e.message}", 500)
        }
    }

    @android.annotation.SuppressLint("WrongConstant")
    private fun handleAppUsage(params: Map<String, String>): BridgeResponse {
        val usm = context.getSystemService(android.app.usage.UsageStatsManager::class.java)
        // Check if permission has been granted (it's a special permission, not runtime)
        val days   = params["days"]?.toIntOrNull()?.coerceIn(1, 30) ?: 7
        val endMs  = System.currentTimeMillis()
        val startMs = endMs - days * 86_400_000L
        val stats  = usm.queryUsageStats(
            android.app.usage.UsageStatsManager.INTERVAL_DAILY, startMs, endMs
        )
        if (stats.isNullOrEmpty()) {
            // Either no data or permission not granted — tell the user how to fix it
            return jsonError(
                "no usage data — grant Usage Access in Settings → Apps → Special access → Usage access",
                403
            )
        }
        // Aggregate by package, sort by total foreground time descending
        val aggregated = stats
            .groupBy { it.packageName }
            .map { (pkg, entries) ->
                val totalMs = entries.sumOf { it.totalTimeInForeground }
                pkg to totalMs
            }
            .filter { it.second > 0 }
            .sortedByDescending { it.second }
            .take(params["limit"]?.toIntOrNull()?.coerceIn(1, 50) ?: 20)

        val pm = context.packageManager
        val result = JSONArray()
        for ((pkg, totalMs) in aggregated) {
            val label = try { pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() } catch (_: Exception) { pkg }
            result.put(JSONObject().apply {
                put("package",      pkg)
                put("app_name",     label)
                put("foreground_ms", totalMs)
                put("foreground_min", totalMs / 60_000)
            })
        }
        return jsonOk(result)
    }

    private fun handleDocuments(params: Map<String, String>): BridgeResponse {
        if (!hasPermission(Manifest.permission.READ_MEDIA_IMAGES)) return permDenied()

        val limit   = params["limit"]?.toIntOrNull()?.coerceIn(1, 50) ?: 20
        val query   = params["query"] ?: ""
        val mimeFilter = params["type"] // "pdf", "doc", "text", or null for all
        val mimeType = when (mimeFilter?.lowercase()) {
            "pdf"  -> "application/pdf"
            "doc"  -> "application/msword"
            "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            "text" -> "text/plain"
            else   -> null
        }

        val selection = buildString {
            val conditions = mutableListOf<String>()
            if (query.isNotBlank())
                conditions.add("${MediaStore.Files.FileColumns.DISPLAY_NAME} LIKE '%${query.replace("'", "''")}%'")
            if (mimeType != null)
                conditions.add("${MediaStore.Files.FileColumns.MIME_TYPE} = '${mimeType.replace("'", "''")}'")
            else
                // Common document MIME types
                conditions.add("${MediaStore.Files.FileColumns.MIME_TYPE} IN (" +
                    "'application/pdf'," +
                    "'application/msword'," +
                    "'application/vnd.openxmlformats-officedocument.wordprocessingml.document'," +
                    "'application/vnd.ms-excel'," +
                    "'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'," +
                    "'application/vnd.ms-powerpoint'," +
                    "'application/vnd.openxmlformats-officedocument.presentationml.presentation'," +
                    "'text/plain')")
            if (conditions.isNotEmpty()) append(conditions.joinToString(" AND "))
        }

        val results = JSONArray()
        context.contentResolver.query(
            MediaStore.Files.getContentUri("external"),
            arrayOf(
                MediaStore.Files.FileColumns._ID,
                MediaStore.Files.FileColumns.DISPLAY_NAME,
                MediaStore.Files.FileColumns.MIME_TYPE,
                MediaStore.Files.FileColumns.SIZE,
                MediaStore.Files.FileColumns.DATE_MODIFIED,
            ),
            selection.ifBlank { null }, null,
            "${MediaStore.Files.FileColumns.DATE_MODIFIED} DESC"
        )?.use { cursor ->
            while (cursor.moveToNext() && results.length() < limit) {
                results.put(JSONObject().apply {
                    put("id",            cursor.getLong(0))
                    put("name",          cursor.getString(1) ?: "")
                    put("mime_type",     cursor.getString(2) ?: "")
                    put("size_bytes",    cursor.getLong(3))
                    put("modified_ms",   cursor.getLong(4) * 1_000)
                })
            }
        }
        return jsonOk(results)
    }

    private fun handleActivityLog(params: Map<String, String>): BridgeResponse {
        val limit = params["limit"]?.toIntOrNull()?.coerceIn(1, 200) ?: 50
        return jsonOk(BridgeActivityLog.toJson(limit))
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) ==
        PackageManager.PERMISSION_GRANTED

    private fun permDenied() = jsonError("PERMISSION_DENIED", 403)

    private fun jsonOk(data: Any): BridgeResponse =
        BridgeResponse(JSONObject().apply { put("ok", true); put("data", data) }.toString(), 200)

    private fun jsonError(msg: String, status: Int = 400): BridgeResponse =
        BridgeResponse(JSONObject().apply { put("ok", false); put("error", msg) }.toString(), status)

    private fun parseQuery(query: String): Map<String, String> {
        if (query.isBlank()) return emptyMap()
        return query.split("&").mapNotNull { kv ->
            val eq = kv.indexOf('=')
            if (eq < 0) null
            else kv.substring(0, eq) to java.net.URLDecoder.decode(kv.substring(eq + 1), "UTF-8")
        }.toMap()
    }

    private fun writeResponse(socket: Socket, body: String, status: Int = 200) {
        val statusText = when (status) {
            200 -> "200 OK"
            400 -> "400 Bad Request"
            401 -> "401 Unauthorized"
            403 -> "403 Forbidden"
            404 -> "404 Not Found"
            409 -> "409 Conflict"
            429 -> "429 Too Many Requests"
            500 -> "500 Internal Server Error"
            503 -> "503 Service Unavailable"
            504 -> "504 Gateway Timeout"
            else -> "$status Unknown"
        }
        val bytes = body.toByteArray(Charsets.UTF_8)
        val out = socket.getOutputStream()
        out.write(
            ("HTTP/1.1 $statusText\r\n" +
            "Content-Type: application/json\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Connection: close\r\n" +
            "\r\n").toByteArray(Charsets.UTF_8))
        out.write(bytes)
        out.flush()
    }
}
