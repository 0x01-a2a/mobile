package world.zerox1.node

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
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
import java.security.SecureRandom

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
        private const val SECURE_PREFS_NAME = "zerox1_secure"
        private const val KEY_LLM_API_KEY = "llm_api_key"
        private const val KEY_NODE_API_SECRET = "local_node_api_secret"
        private const val KEY_GATEWAY_TOKEN = "local_gateway_token"
    }

    private var isNodeRunning = false
    private var permissionListener: PermissionListener? = null
    private val secureRandom = SecureRandom()

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
        ctx.registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    }

    override fun getName() = "ZeroxNodeModule"

    override fun invalidate() {
        super.invalidate()
        runCatching { ctx.unregisterReceiver(statusReceiver) }
    }

    private fun securePrefs() = EncryptedSharedPreferences.create(
        ctx,
        SECURE_PREFS_NAME,
        MasterKey.Builder(ctx)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    private fun randomHex(bytes: Int): String {
        val data = ByteArray(bytes)
        secureRandom.nextBytes(data)
        return data.joinToString("") { "%02x".format(it) }
    }

    private fun ensureSecureToken(key: String, prefix: String = ""): String {
        val prefs = securePrefs()
        prefs.getString(key, null)?.takeIf { it.isNotBlank() }?.let { return it }
        val value = prefix + randomHex(32)
        prefs.edit().putString(key, value).apply()
        return value
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
                SECURE_PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            prefs.edit().putString(KEY_LLM_API_KEY, key).apply()
            promise.resolve(null)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save API key to encrypted storage: $e")
            promise.reject("SAVE_FAILED", e.message)
        }
    }

    @ReactMethod
    fun startNode(config: ReadableMap, promise: Promise) {
        try {
            ensureSecureToken(KEY_NODE_API_SECRET)
            ensureSecureToken(KEY_GATEWAY_TOKEN, "zc_mobile_")
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
                // Bags fee-sharing
                if (config.hasKey("bagsFeesBps"))       putExtra(NodeService.EXTRA_BAGS_FEE_BPS,  config.getInt("bagsFeesBps"))
                config.getString("bagsWallet")?.let    { putExtra(NodeService.EXTRA_BAGS_WALLET,  it) }
                config.getString("bagsApiKey")?.let    { putExtra(NodeService.EXTRA_BAGS_API_KEY, it) }
            }
            ctx.startForegroundService(intent)
            isNodeRunning = true
            // Persist config to SharedPreferences so BootReceiver can restore it on reboot.
            val prefs = ctx.getSharedPreferences("zerox1", Context.MODE_PRIVATE).edit()
            prefs.putBoolean("node_auto_start", true)
            config.getString("agentName")?.let  { prefs.putString("agent_name",  it) }
            config.getString("relayAddr")?.let  { prefs.putString("relay_addr",  it) }
            config.getString("fcmToken")?.let   { prefs.putString("fcm_token",   it) }
            config.getString("rpcUrl")?.let     { prefs.putString("rpc_url",     it) }
            if (config.hasKey("agentBrainEnabled")) prefs.putBoolean("brain_enabled", config.getBoolean("agentBrainEnabled"))
            config.getString("llmProvider")?.let    { prefs.putString("llm_provider",  it) }
            config.getString("capabilities")?.let   { prefs.putString("capabilities",   it) }
            if (config.hasKey("bagsFeesBps"))        prefs.putInt("bags_fee_bps",       config.getInt("bagsFeesBps"))
            config.getString("bagsWallet")?.let     { prefs.putString("bags_wallet",    it) }
            config.getString("bagsApiKey")?.let     { prefs.putString("bags_api_key",   it) }
            prefs.apply()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("START_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun getLocalAuthConfig(promise: Promise) {
        try {
            val prefs = securePrefs()
            val result = Arguments.createMap().apply {
                putString("nodeApiToken", prefs.getString(KEY_NODE_API_SECRET, null))
                putString("gatewayToken", prefs.getString(KEY_GATEWAY_TOKEN, null))
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("AUTH_READ_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun stopNode(promise: Promise) {
        try {
            ctx.stopService(Intent(ctx, NodeService::class.java))
            isNodeRunning = false
            ctx.getSharedPreferences("zerox1", Context.MODE_PRIVATE).edit()
                .putBoolean("node_auto_start", false).apply()
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
        // Reject if a previous request dialog is still open; only one can be shown at a time.
        if (permissionListener != null) {
            promise.reject("PENDING", "Another permission request is already in progress")
            return
        }
        val listener = PermissionListener { requestCode, _, grantResults ->
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
        permissionListener = listener
        activity.requestPermissions(arrayOf(manifest), PERMISSION_REQUEST_CODE, listener)
    }

    // -------------------------------------------------------------------------
    // Bridge capability settings (read/write SharedPreferences)
    // -------------------------------------------------------------------------

    /**
     * Set or clear a bridge capability toggle.
     * Keys: "messaging", "contacts", "location", "camera", "microphone",
     *       "screen", "calls", "calendar", "media"
     * Default for all keys is enabled (true) — disable explicitly.
     */
    @ReactMethod
    fun setBridgeCapability(capability: String, enabled: Boolean, promise: Promise) {
        try {
            ctx.getSharedPreferences("zerox1_bridge", android.content.Context.MODE_PRIVATE)
                .edit()
                .putBoolean("bridge_cap_$capability", enabled)
                .apply()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("PREFS_ERROR", e.message)
        }
    }

    /**
     * Read all bridge capability toggles. Returns a map of capability → boolean.
     */
    @ReactMethod
    fun getBridgeCapabilities(promise: Promise) {
        try {
            val prefs = ctx.getSharedPreferences("zerox1_bridge", android.content.Context.MODE_PRIVATE)
            val caps  = listOf(
                "messaging", "contacts", "location", "camera",
                "microphone", "screen", "calls", "calendar", "media",
            )
            val result = WritableNativeMap()
            for (cap in caps) {
                result.putBoolean(cap, prefs.getBoolean("bridge_cap_$cap", true))
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("PREFS_ERROR", e.message)
        }
    }

    /**
     * Fetch the bridge activity log from the PhoneBridgeServer.
     * Returns a JSON string (array of {time, capability, action, outcome}).
     * Only works while the node/agent is running.
     */
    @ReactMethod
    fun getBridgeActivityLog(limit: Int, promise: Promise) {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val json = BridgeActivityLog.toJson(limit.coerceIn(1, 200))
                promise.resolve(json.toString())
            } catch (e: Exception) {
                promise.reject("LOG_ERROR", e.message)
            }
        }
    }

    // Required for addListener / removeListeners (RN event emitter contract)
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
