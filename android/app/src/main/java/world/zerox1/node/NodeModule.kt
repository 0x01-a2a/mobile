package world.zerox1.node

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import net.i2p.crypto.eddsa.EdDSAEngine
import net.i2p.crypto.eddsa.EdDSAPrivateKey
import net.i2p.crypto.eddsa.EdDSAPublicKey
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable
import net.i2p.crypto.eddsa.spec.EdDSAPrivateKeySpec
import net.i2p.crypto.eddsa.spec.EdDSAPublicKeySpec
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * NodeModule — React Native native module exposing node lifecycle to JS.
 *
 * JS API:
 *   NativeModules.ZeroxNodeModule.startNode(config) → Promise<void>
 *   NativeModules.ZeroxNodeModule.stopNode()         → Promise<void>
 *   NativeModules.ZeroxNodeModule.isRunning()        → Promise<boolean>
 *
 * Events emitted to JS via DeviceEventEmitter:
 *   'nodeStatus' { status: 'running' | 'stopped' | 'error', detail?: string }
 */
class NodeModule(private val ctx: ReactApplicationContext)
    : ReactContextBaseJavaModule(ctx) {

    companion object {
        private const val TAG = "NodeModule"
        private const val PERMISSION_REQUEST_CODE = 42
    }

    private var isNodeRunning = false
    private var permissionListener: PermissionListener? = null

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val status = intent.getStringExtra("status") ?: return
            val detail = intent.getStringExtra("detail") ?: ""
            isNodeRunning = (status == NodeService.STATUS_RUNNING)
            emitStatus(status, detail)
        }
    }

    init {
        val filter = IntentFilter(NodeService.ACTION_STATUS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            ctx.registerReceiver(statusReceiver, filter)
        }
    }

    override fun getName() = "ZeroxNodeModule"

    override fun invalidate() {
        super.invalidate()
        runCatching { ctx.unregisterReceiver(statusReceiver) }
    }

    // -------------------------------------------------------------------------
    // JS-callable methods
    // -------------------------------------------------------------------------

    @ReactMethod
    fun saveLlmApiKey(key: String, promise: Promise) {
        try {
            val masterKey = MasterKey.Builder(ctx)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            val prefs = EncryptedSharedPreferences.create(
                ctx,
                "zerox1_secure",
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            prefs.edit().putString("llm_api_key", key).apply()
            promise.resolve(null)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save API key to encrypted storage: $e")
            promise.reject("SAVE_FAILED", e.message)
        }
    }

    @ReactMethod
    fun startNode(config: ReadableMap, promise: Promise) {
        try {
            val intent = Intent(ctx, NodeService::class.java).apply {
                config.getString("relayAddr")?.let      { putExtra(NodeService.EXTRA_RELAY_ADDR,   it) }
                config.getString("fcmToken")?.let       { putExtra(NodeService.EXTRA_FCM_TOKEN,    it) }
                config.getString("agentName")?.let      { putExtra(NodeService.EXTRA_AGENT_NAME,   it) }
                config.getString("rpcUrl")?.let         { putExtra(NodeService.EXTRA_RPC_URL,      it) }
                // ZeroClaw agent brain config
                config.getString("llmProvider")?.let   { putExtra(NodeService.EXTRA_LLM_PROVIDER, it) }
                // CRIT-5: API key is no longer passed via intent extra
                config.getString("capabilities")?.let  { putExtra(NodeService.EXTRA_CAPABILITIES, it) }
                if (config.hasKey("minFeeUsdc"))       putExtra(NodeService.EXTRA_MIN_FEE,        config.getDouble("minFeeUsdc"))
                if (config.hasKey("minReputation"))    putExtra(NodeService.EXTRA_MIN_REP,        config.getInt("minReputation"))
                if (config.hasKey("autoAccept"))       putExtra(NodeService.EXTRA_AUTO_ACCEPT,    config.getBoolean("autoAccept"))
                if (config.hasKey("agentBrainEnabled")) putExtra(NodeService.EXTRA_BRAIN_ENABLED, config.getBoolean("agentBrainEnabled"))
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
            isNodeRunning = true
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("START_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun stopNode(promise: Promise) {
        try {
            ctx.stopService(Intent(ctx, NodeService::class.java))
            isNodeRunning = false
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("STOP_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun isRunning(promise: Promise) {
        promise.resolve(isNodeRunning)
    }

    // -------------------------------------------------------------------------
    // Blob upload — signs with identity key, POSTs to aggregator /blobs
    // -------------------------------------------------------------------------

    /**
     * Upload a binary blob to the aggregator on behalf of the local agent.
     *
     * Signs the request using the agent's Ed25519 identity key (same key the
     * Rust node uses — 32-byte raw seed stored at zerox1-identity.key).
     *
     * @param dataBase64  Base64-encoded bytes to upload.
     * @param mimeType    MIME type for the Content-Type header.
     * @param promise     Resolves with the CID string on success.
     */
    @ReactMethod
    fun uploadBlob(dataBase64: String, mimeType: String, promise: Promise) {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                // ── 1. Load the 32-byte identity key seed ──────────────────
                val keyFile = File(ctx.filesDir, "zerox1-identity.key")
                if (!keyFile.exists()) {
                    promise.reject("NO_KEYPAIR", "Identity key not found — start the node first.")
                    return@launch
                }
                val seed = keyFile.readBytes()
                if (seed.size != 32) {
                    promise.reject("BAD_KEY", "Expected 32-byte key, got ${seed.size} bytes.")
                    return@launch
                }

                // ── 2. Derive Ed25519 key pair from seed ───────────────────
                val spec       = EdDSANamedCurveTable.getByName("Ed25519")
                val privSpec   = EdDSAPrivateKeySpec(seed, spec)
                val privKey    = EdDSAPrivateKey(privSpec)
                val pubKey     = EdDSAPublicKey(EdDSAPublicKeySpec(privSpec.a, spec))
                val agentIdHex = pubKey.abyte.joinToString("") { "%02x".format(it) }

                // ── 3. Decode body ─────────────────────────────────────────
                val body = Base64.decode(dataBase64, Base64.DEFAULT)

                // ── 4. Build message: body || timestamp_le_u64 ────────────
                val timestamp = System.currentTimeMillis() / 1000L
                val tsBytes   = ByteArray(8) { i -> ((timestamp shr (i * 8)) and 0xFF).toByte() }
                val message   = body + tsBytes

                // ── 5. Sign ────────────────────────────────────────────────
                val signer = EdDSAEngine()
                signer.initSign(privKey)
                signer.update(message)
                val sigHex = signer.sign().joinToString("") { "%02x".format(it) }

                // ── 6. POST to aggregator ──────────────────────────────────
                val conn = URL("https://api.0x01.world/blobs").openConnection() as HttpURLConnection
                conn.apply {
                    requestMethod = "POST"
                    doOutput      = true
                    connectTimeout = 30_000
                    readTimeout    = 30_000
                    setRequestProperty("Content-Type",       mimeType)
                    setRequestProperty("X-0x01-Agent-Id",   agentIdHex)
                    setRequestProperty("X-0x01-Signer",     agentIdHex)
                    setRequestProperty("X-0x01-Timestamp",  timestamp.toString())
                    setRequestProperty("X-0x01-Signature",  sigHex)
                    outputStream.use { it.write(body) }
                }

                val code = conn.responseCode
                if (code != 201) {
                    val err = conn.errorStream?.bufferedReader()?.readText() ?: "no body"
                    conn.disconnect()
                    promise.reject("HTTP_$code", "Upload failed ($code): $err")
                    return@launch
                }

                val responseText = conn.inputStream.bufferedReader().readText()
                conn.disconnect()

                // ── 7. Parse and return CID ────────────────────────────────
                val cid = JSONObject(responseText).getString("cid")
                promise.resolve(cid)

            } catch (e: Exception) {
                Log.e(TAG, "uploadBlob failed: $e")
                promise.reject("UPLOAD_ERROR", e.message ?: "unknown error", e)
            }
        }
    }

    // -------------------------------------------------------------------------
    // Event emitter
    // -------------------------------------------------------------------------

    private fun emitStatus(status: String, detail: String) {
        val params = Arguments.createMap().apply {
            putString("status", status)
            putString("detail", detail)
        }
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("nodeStatus", params)
    }

    // -------------------------------------------------------------------------
    // Permission helpers
    // -------------------------------------------------------------------------

    @ReactMethod
    fun checkPermissions(promise: Promise) {
        val perms = listOf(
            "READ_CONTACTS", "WRITE_CONTACTS",
            "READ_SMS", "SEND_SMS",
            "ACCESS_FINE_LOCATION",
            "READ_CALENDAR", "WRITE_CALENDAR",
            "READ_CALL_LOG",
            "CAMERA", "RECORD_AUDIO",
            "READ_MEDIA_IMAGES",
        )
        val result = WritableNativeMap()
        for (name in perms) {
            val manifest = "android.permission.$name"
            val granted  = ContextCompat.checkSelfPermission(reactApplicationContext, manifest) ==
                           PackageManager.PERMISSION_GRANTED
            result.putBoolean(name, granted)
        }
        promise.resolve(result)
    }

    @ReactMethod
    fun requestPermission(permission: String, promise: Promise) {
        val manifest = "android.permission.$permission"
        if (ContextCompat.checkSelfPermission(reactApplicationContext, manifest) ==
            PackageManager.PERMISSION_GRANTED) {
            promise.resolve(true)
            return
        }
        val activity = reactApplicationContext.currentActivity as? PermissionAwareActivity
        if (activity == null) {
            promise.reject("NO_ACTIVITY", "No foreground activity available")
            return
        }
        permissionListener = PermissionListener { requestCode, _, grantResults ->
            if (requestCode == PERMISSION_REQUEST_CODE) {
                val granted = grantResults.isNotEmpty() &&
                              grantResults[0] == PackageManager.PERMISSION_GRANTED
                promise.resolve(granted)
                permissionListener = null
                true
            } else {
                false
            }
        }
        activity.requestPermissions(arrayOf(manifest), PERMISSION_REQUEST_CODE, permissionListener!!)
    }

    // Required for addListener / removeListeners (RN event emitter contract)
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
