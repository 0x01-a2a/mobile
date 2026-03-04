package world.zerox1.node

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
import android.os.Vibrator
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
    }

    private var serverSocket: ServerSocket? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val smsTimestamps    = mutableListOf<Long>()
    private val notifyTimestamps = mutableListOf<Long>()
    private val audioMutex       = kotlinx.coroutines.sync.Mutex()
    private val cameraMutex      = kotlinx.coroutines.sync.Mutex()

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

                // Authentication Check (CRIT-1)
                val token = headers["x-bridge-token"]
                if (token == null || token != secret) {
                    Log.w(TAG, "Unauthorized request from ${socket.inetAddress}: $path")
                    val err = jsonError("UNAUTHORIZED", 401)
                    writeResponse(socket, err.body, err.status)
                    return
                }

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
            } catch (e: Exception) {
                Log.w(TAG, "Client error: $e")
                val err = jsonError("INTERNAL_ERROR: ${e.message}", 500)
                writeResponse(socket, err.body, err.status)
            }
        }
    }

    private fun route(
        method: String,
        path: String,
        params: Map<String, String>,
        body: JSONObject?,
    ): BridgeResponse {
        return when {
            method == "GET"  && path == "/phone/contacts"        -> handleContactsRead(params)
            method == "POST" && path == "/phone/contacts"        -> handleContactsWrite(body)
            method == "GET"  && path == "/phone/sms"             -> handleSmsRead(params)
            method == "POST" && path == "/phone/sms/send"        -> handleSmsSend(body)
            method == "GET"  && path == "/phone/location"        -> handleLocation()
            method == "GET"  && path == "/phone/calendar"        -> handleCalendarRead(params)
            method == "POST" && path == "/phone/calendar"        -> handleCalendarWrite(body)
            method == "POST" && path == "/phone/notify"          -> handleNotify(body)
            method == "GET"  && path == "/phone/call_log"        -> handleCallLog(params)
            method == "GET"  && path == "/phone/clipboard"       -> handleClipboardRead()
            method == "POST" && path == "/phone/clipboard"       -> handleClipboardWrite(body)
            method == "POST" && path == "/phone/camera/capture"  -> handleCameraCapture(body)
            method == "POST" && path == "/phone/audio/record"    -> handleAudioRecord(body)
            method == "GET"  && path == "/phone/permissions"     -> handlePermissions()
            method == "GET"  && path == "/phone/device"          -> handleDevice()
            method == "GET"  && path == "/phone/battery"         -> handleBattery()
            method == "POST" && path == "/phone/vibrate"         -> handleVibrate(body)
            method == "GET"  && path == "/phone/timezone"        -> handleTimezone()
            method == "GET"  && path == "/phone/network"         -> handleNetwork()
            method == "GET"  && path == "/phone/wifi"            -> handleWifi()
            method == "GET"  && path == "/phone/carrier"         -> handleCarrier()
            method == "GET"  && path == "/phone/bluetooth"       -> handleBluetooth()
            method == "GET"  && path == "/phone/activity"        -> handleActivity()
            method == "GET"  && path == "/phone/media/images"    -> handleMediaImages(params)
            method == "PUT"  && path.startsWith("/phone/contacts/") ->
                handleContactsUpdate(path.substringAfterLast("/"), body)
            method == "PUT"  && path.startsWith("/phone/calendar/") ->
                handleCalendarUpdate(path.substringAfterLast("/"), body)
            else -> jsonError("NOT_FOUND: $method $path", 404)
        }
    }

    // -------------------------------------------------------------------------
    // Endpoints
    // -------------------------------------------------------------------------

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
            // SmsManager.getDefault() is deprecated in API 31+; use system service on newer devices
            val smsManager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                context.getSystemService(android.telephony.SmsManager::class.java)
            else
                @Suppress("DEPRECATION") android.telephony.SmsManager.getDefault()
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(
                    NOTIF_CHANNEL_ID, "0x01 Agent Bridge",
                    NotificationManager.IMPORTANCE_DEFAULT
                )
            )
        }
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

    private fun handleClipboardRead(): BridgeResponse {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE)
            as android.content.ClipboardManager
        val text = cm.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString() ?: ""
        return jsonOk(JSONObject().put("text", text))
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
        // READ_MEDIA_IMAGES is API 33+; fall back to READ_EXTERNAL_STORAGE on older devices
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms["READ_MEDIA_IMAGES"] = Manifest.permission.READ_MEDIA_IMAGES
        } else {
            perms["READ_EXTERNAL_STORAGE"] = Manifest.permission.READ_EXTERNAL_STORAGE
        }
        // BLUETOOTH_CONNECT is API 31+; older uses legacy BLUETOOTH
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            perms["BLUETOOTH_CONNECT"] = Manifest.permission.BLUETOOTH_CONNECT
        }
        // ACTIVITY_RECOGNITION is API 29+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            perms["ACTIVITY_RECOGNITION"] = Manifest.permission.ACTIVITY_RECOGNITION
        }
        val result = JSONObject()
        for ((name, manifest) in perms) {
            result.put(name, hasPermission(manifest))
        }
        return jsonOk(result)
    }

    private fun handleDevice(): BridgeResponse {
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager
        val screenWidth: Int
        val screenHeight: Int
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = wm.currentWindowMetrics.bounds
            screenWidth  = bounds.width()
            screenHeight = bounds.height()
        } else {
            @Suppress("DEPRECATION")
            val display = wm.defaultDisplay
            val size = android.graphics.Point()
            @Suppress("DEPRECATION")
            display.getSize(size)
            screenWidth  = size.x
            screenHeight = size.y
        }
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
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = context.getSystemService(VibratorManager::class.java)
                val effect = if (amplitude == -1)
                    VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE)
                else
                    VibrationEffect.createOneShot(durationMs, amplitude)
                vm.defaultVibrator.vibrate(effect)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                @Suppress("DEPRECATION")
                val vib = context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                val effect = if (amplitude == -1)
                    VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE)
                else
                    VibrationEffect.createOneShot(durationMs, amplitude)
                vib.vibrate(effect)
            } else {
                @Suppress("DEPRECATION")
                val vib = context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                @Suppress("DEPRECATION")
                vib.vibrate(durationMs)
            }
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
        // BLUETOOTH_CONNECT required on API 31+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            !hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) return permDenied()
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
        // ACTIVITY_RECOGNITION is a dangerous permission only from API 29+;
        // checkSelfPermission returns DENIED for unknown strings on older SDKs even though
        // the sensor would work. Return a clear error rather than a misleading PERMISSION_DENIED.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q)
            return jsonError("step counter requires Android 10+", 400)
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

    private fun handleMediaImages(params: Map<String, String>): BridgeResponse {
        val perm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            Manifest.permission.READ_MEDIA_IMAGES
        else
            Manifest.permission.READ_EXTERNAL_STORAGE
        if (!hasPermission(perm)) return permDenied()

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
