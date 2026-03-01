package world.zerox1.node

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
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
        const val TAG  = "PhoneBridgeServer"
        const val PORT = 9092
        const val NOTIF_CHANNEL_ID = "zerox1_phone_bridge"
    }

    private var serverSocket: ServerSocket? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val smsTimestamps = mutableListOf<Long>()
    private val audioMutex    = kotlinx.coroutines.sync.Mutex()

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
            method == "POST" && path == "/phone/camera/capture"  -> handleCameraCapture()
            method == "POST" && path == "/phone/audio/record"    -> handleAudioRecord(body)
            method == "GET"  && path == "/phone/permissions"     -> handlePermissions()
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
        if (msg.length > 1600) return jsonError("message too long (max 1600 chars)", 400) // CRIT-2

        // Rate limit: 5 SMS per minute (CRIT-2)
        synchronized(smsTimestamps) {
            val now = System.currentTimeMillis()
            smsTimestamps.removeAll { it < now - 60_000 }
            if (smsTimestamps.size >= 5) {
                return jsonError("rate limit exceeded (max 5 SMS/min)", 429)
            }
            smsTimestamps.add(now)
        }

        return try {
            android.telephony.SmsManager.getDefault()
                .sendTextMessage(to, null, msg, null, null)
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

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
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
        nm.notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), notif)
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

    private fun handleCameraCapture(): BridgeResponse {
        if (!hasPermission(Manifest.permission.CAMERA)) return permDenied()
        return try {
            val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val cameraId = cm.cameraIdList.firstOrNull { id ->
                cm.getCameraCharacteristics(id)
                    .get(CameraCharacteristics.LENS_FACING) ==
                CameraCharacteristics.LENS_FACING_BACK
            } ?: cm.cameraIdList.firstOrNull()
            ?: return jsonError("no camera available", 404)

            // Camera2 requires a Surface to capture — full implementation needs
            // ImageReader + CameraCaptureSession. Return a placeholder indicating
            // the capability is present but the capture path requires the UI thread.
            val data = JSONObject().apply {
                put("camera_id", cameraId)
                put("note", "capture requires foreground activity; use camera intent instead")
            }
            jsonOk(data)
        } catch (e: Exception) {
            jsonError("camera error: ${e.message}", 500)
        }
    }

    private fun handleAudioRecord(body: JSONObject?): BridgeResponse {
        if (!hasPermission(Manifest.permission.RECORD_AUDIO)) return permDenied()
        val durationMs = body?.optLong("duration_ms", 3_000L) ?: 3_000L
        val maxMs      = 30_000L
        val clampedMs  = durationMs.coerceIn(500L, maxMs)

        // Mutex to prevent concurrent recording (CRIT-3, MED-2)
        if (audioMutex.isLocked) return jsonError("another recording is in progress", 409)

        val deferred = scope.async {
            audioMutex.withLock {
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
                    delay(clampedMs) // CRIT-3: use delay() instead of Thread.sleep()
                    recorder.stop()

                    val bytes  = outFile.readBytes()
                    val b64    = Base64.encodeToString(bytes, Base64.NO_WRAP)
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
                }
            }
        }

        return runBlocking { deferred.await() }
    }

    private fun handlePermissions(): BridgeResponse {
        val perms = mapOf(
            "READ_CONTACTS"       to Manifest.permission.READ_CONTACTS,
            "WRITE_CONTACTS"      to Manifest.permission.WRITE_CONTACTS,
            "READ_SMS"            to Manifest.permission.READ_SMS,
            "SEND_SMS"            to Manifest.permission.SEND_SMS,
            "ACCESS_FINE_LOCATION" to Manifest.permission.ACCESS_FINE_LOCATION,
            "READ_CALENDAR"       to Manifest.permission.READ_CALENDAR,
            "WRITE_CALENDAR"      to Manifest.permission.WRITE_CALENDAR,
            "READ_CALL_LOG"       to Manifest.permission.READ_CALL_LOG,
            "CAMERA"              to Manifest.permission.CAMERA,
            "RECORD_AUDIO"        to Manifest.permission.RECORD_AUDIO,
            "READ_MEDIA_IMAGES"   to "android.permission.READ_MEDIA_IMAGES",
        )
        val result = JSONObject()
        for ((name, manifest) in perms) {
            result.put(name, hasPermission(manifest))
        }
        return jsonOk(result)
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
            500 -> "500 Internal Server Error"
            else -> "$status Unknown"
        }
        val bytes = body.toByteArray(Charsets.UTF_8)
        val out = socket.getOutputStream()
        out.write(
            "HTTP/1.1 $statusText\r\n" +
            "Content-Type: application/json\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Connection: close\r\n" +
            "\r\n"
        .toByteArray())
        out.write(bytes)
        out.flush()
    }
}
