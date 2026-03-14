package world.zerox1.01pilot

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.content.pm.PackageManager
import android.util.Base64
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.facebook.react.bridge.*
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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
    : ReactContextBaseJavaModule(ctx), LifecycleEventListener {

    companion object {
        private const val TAG = "NodeModule"
        private const val PERMISSION_REQUEST_CODE = 42
        private const val SECURE_PREFS_NAME = "zerox1_secure"
        private const val KEY_LLM_API_KEY = "llm_api_key"
        private const val KEY_NODE_API_SECRET = "local_node_api_secret"
        private const val KEY_GATEWAY_TOKEN = "local_gateway_token"
        private const val KEY_BAGS_API_KEY = "bags_api_key"
        private const val KEY_BAGS_PARTNER_KEY = "bags_partner_key"
    }

    private var isNodeRunning = false
    private var permissionListener: PermissionListener? = null
    // Pending FGS start — populated when startForegroundService() is denied due to background
    // UID state (Android 12+). Retried in onHostResume() when the Activity is confirmed foreground.
    @Volatile private var pendingStartIntent: Intent? = null
    @Volatile private var pendingStartPromise: Promise? = null
    private val secureRandom = SecureRandom()
    // Module-scoped coroutine scope — cancelled in invalidate() so in-flight
    // coroutines (uploadBlob, getBridgeActivityLog) never touch a dead promise.
    private val moduleScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

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
        ctx.addLifecycleEventListener(this)
    }

    override fun getName() = "ZeroxNodeModule"

    override fun invalidate() {
        super.invalidate()
        runCatching { ctx.unregisterReceiver(statusReceiver) }
        runCatching { ctx.removeLifecycleEventListener(this) }
        pendingStartPromise?.reject("CANCELLED", "Module invalidated")
        pendingStartIntent = null
        pendingStartPromise = null
        moduleScope.cancel()
    }

    // -------------------------------------------------------------------------
    // LifecycleEventListener — retry FGS start once Activity is foreground
    // -------------------------------------------------------------------------

    override fun onHostResume() {
        val intent  = pendingStartIntent  ?: return
        val promise = pendingStartPromise ?: return
        pendingStartIntent  = null
        pendingStartPromise = null
        Log.i(TAG, "Activity resumed — retrying pending FGS start")
        try {
            ctx.startForegroundService(intent)
            isNodeRunning = true
            promise.resolve(null)
        } catch (e: Exception) {
            Log.e(TAG, "Retry startForegroundService failed: ${e.message}")
            promise.reject("START_FAILED", e.message, e)
        }
    }

    override fun onHostPause() {}

    override fun onHostDestroy() {
        pendingStartPromise?.reject("CANCELLED", "Activity destroyed")
        pendingStartIntent  = null
        pendingStartPromise = null
    }

    private fun securePrefs() = EncryptedSharedPreferences.create(
        ctx,
        SECURE_PREFS_NAME,
        MasterKey.Builder(ctx)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .setRequestStrongBoxBacked(false)  // emulator compatibility: no StrongBox HSM
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
            val prefs = securePrefs()
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
                config.getString("llmProvider")?.let    { putExtra(NodeService.EXTRA_LLM_PROVIDER,  it) }
                config.getString("llmModel")?.let       { putExtra(NodeService.EXTRA_LLM_MODEL,     it) }
                val llmBaseUrl = config.getString("llmBaseUrl")
                android.util.Log.i("NodeModule", "startNode: llmBaseUrl hasKey=${config.hasKey("llmBaseUrl")} value=${llmBaseUrl?.let { "'$it'" } ?: "null"}")
                llmBaseUrl?.let { putExtra(NodeService.EXTRA_LLM_BASE_URL, it) }
                // CRIT-5: API key is no longer passed via intent extra
                config.getString("capabilities")?.let  { putExtra(NodeService.EXTRA_CAPABILITIES,  it) }
                if (config.hasKey("minFeeUsdc"))       putExtra(NodeService.EXTRA_MIN_FEE,        config.getDouble("minFeeUsdc"))
                if (config.hasKey("minReputation"))    putExtra(NodeService.EXTRA_MIN_REP,        config.getInt("minReputation"))
                if (config.hasKey("autoAccept"))       putExtra(NodeService.EXTRA_AUTO_ACCEPT,    config.getBoolean("autoAccept"))
                if (config.hasKey("agentBrainEnabled")) putExtra(NodeService.EXTRA_BRAIN_ENABLED, config.getBoolean("agentBrainEnabled"))
                // Bags fee-sharing
                if (config.hasKey("bagsFeesBps"))       putExtra(NodeService.EXTRA_BAGS_FEE_BPS,  config.getInt("bagsFeesBps"))
                config.getString("bagsWallet")?.let    { putExtra(NodeService.EXTRA_BAGS_WALLET,  it) }
                config.getString("bagsApiKey")?.let    { putExtra(NodeService.EXTRA_BAGS_API_KEY, it) }
                config.getString("bagsPartnerKey")?.let { putExtra(NodeService.EXTRA_BAGS_PARTNER_KEY, it) }
            }
            // Android 12+ may throw ForegroundServiceStartNotAllowedException here
            // when the calling context is background (e.g. JS triggered from background task).
            // NodeService.onStartCommand also catches it, but guard here too for belt-and-suspenders.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                try {
                    ctx.startForegroundService(intent)
                } catch (e: android.app.ForegroundServiceStartNotAllowedException) {
                    // Activity not yet foreground (timing race on cold launch or emulator quirk).
                    // Park the intent; onHostResume() will fire within ~100ms and retry.
                    Log.w(TAG, "startForegroundService denied — parking until onHostResume()")
                    pendingStartIntent  = intent
                    pendingStartPromise = promise
                    return
                }
            } else {
                ctx.startForegroundService(intent)
            }
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
            config.getString("llmModel")?.let       { prefs.putString("llm_model",     it) }
            config.getString("llmBaseUrl")?.let     { prefs.putString("llm_base_url",  it) }
            config.getString("capabilities")?.let   { prefs.putString("capabilities",   it) }
            if (config.hasKey("bagsFeesBps"))        prefs.putInt("bags_fee_bps",       config.getInt("bagsFeesBps"))
            config.getString("bagsWallet")?.let     { prefs.putString("bags_wallet",    it) }
            // bags API keys stored in EncryptedSharedPreferences (not plaintext)
            val ep = securePrefs().edit()
            config.getString("bagsApiKey")?.let     { ep.putString(KEY_BAGS_API_KEY,     it) }
            config.getString("bagsPartnerKey")?.let { ep.putString(KEY_BAGS_PARTNER_KEY, it) }
            ep.apply()
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
            val heliusKey = BuildConfig.HELIUS_API_KEY.takeIf { it.isNotBlank() }
            val result = Arguments.createMap().apply {
                putString("nodeApiToken", prefs.getString(KEY_NODE_API_SECRET, null))
                putString("gatewayToken", prefs.getString(KEY_GATEWAY_TOKEN, null))
                putString("heliusApiKey", heliusKey)
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
        moduleScope.launch {
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
    // Screen security — FLAG_SECURE prevents screenshots/screen recording
    // -------------------------------------------------------------------------

    @ReactMethod
    fun setWindowSecure(enabled: Boolean, promise: Promise) {
        val activity = ctx.currentActivity
        if (activity == null) {
            promise.reject("NO_ACTIVITY", "No foreground activity")
            return
        }
        activity.runOnUiThread {
            if (enabled) {
                activity.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
            } else {
                activity.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
            }
            promise.resolve(null)
        }
    }

    // -------------------------------------------------------------------------
    // Base58 helpers — used for identity key export/import
    // -------------------------------------------------------------------------

    private val B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

    private fun bs58encode(data: ByteArray): String {
        var n = java.math.BigInteger(1, data)
        val zero = java.math.BigInteger.ZERO
        val base = java.math.BigInteger.valueOf(58)
        val sb = StringBuilder()
        while (n > zero) {
            val (quotient, remainder) = n.divideAndRemainder(base)
            sb.append(B58_ALPHABET[remainder.toInt()])
            n = quotient
        }
        for (b in data) {
            if (b.toInt() != 0) break
            sb.append(B58_ALPHABET[0])
        }
        return sb.reverse().toString()
    }

    private fun bs58decode(s: String): ByteArray {
        if (s.length > 100) throw IllegalArgumentException("Input too long for base58 key (${s.length} chars)")
        var n = java.math.BigInteger.ZERO
        val base = java.math.BigInteger.valueOf(58)
        for (c in s) {
            val idx = B58_ALPHABET.indexOf(c)
            if (idx < 0) throw IllegalArgumentException("Invalid base58 character: $c")
            n = n.multiply(base).add(java.math.BigInteger.valueOf(idx.toLong()))
        }
        val bytes = n.toByteArray()
        val stripped = if (bytes.isNotEmpty() && bytes[0] == 0.toByte()) bytes.drop(1).toByteArray() else bytes
        val leadingZeros = s.takeWhile { it == '1' }.length
        return ByteArray(leadingZeros) + stripped
    }

    // -------------------------------------------------------------------------
    // Identity key export / import
    // -------------------------------------------------------------------------

    /**
     * Export the agent's Ed25519 identity as a base58-encoded 64-byte keypair
     * (32-byte seed || 32-byte pubkey), compatible with Phantom / Solana CLI.
     */
    @ReactMethod
    fun exportIdentityKey(promise: Promise) {
        moduleScope.launch {
            try {
                val keyFile = File(ctx.filesDir, "zerox1-identity.key")
                if (!keyFile.exists()) {
                    promise.reject("NO_KEYPAIR", "Identity key not found — start the node first.")
                    return@launch
                }
                val seed = keyFile.readBytes()
                if (seed.size != 32) {
                    promise.reject("BAD_KEY", "Expected 32-byte seed, got ${seed.size} bytes.")
                    return@launch
                }
                val spec     = EdDSANamedCurveTable.getByName("Ed25519")
                val privSpec = EdDSAPrivateKeySpec(seed, spec)
                val pubKey   = EdDSAPublicKey(EdDSAPublicKeySpec(privSpec.a, spec))
                val fullKeypair = seed + pubKey.abyte   // 64 bytes: seed || pubkey
                promise.resolve(bs58encode(fullKeypair))
            } catch (e: Exception) {
                Log.e(TAG, "exportIdentityKey failed: $e")
                promise.reject("EXPORT_ERROR", e.message, e)
            }
        }
    }

    /**
     * Import a Phantom/Solana CLI base58 private key (64 bytes: seed || pubkey).
     * Writes the 32-byte seed to zerox1-identity.key — takes effect on next node start.
     */
    @ReactMethod
    fun importIdentityKey(base58Key: String, promise: Promise) {
        moduleScope.launch {
            try {
                val raw = bs58decode(base58Key.trim())
                if (raw.size != 64) {
                    promise.reject("BAD_KEY", "Expected 64-byte keypair (got ${raw.size}). Export from Phantom → Show Secret Key.")
                    return@launch
                }
                val seed = raw.copyOfRange(0, 32)
                // Stop the node so the key file is not in use during write.
                ctx.stopService(Intent(ctx, NodeService::class.java))
                isNodeRunning = false
                // Atomic write: write to temp file then rename to avoid torn reads.
                val keyFile = File(ctx.filesDir, "zerox1-identity.key")
                val tmpFile = File(ctx.filesDir, "zerox1-identity.key.tmp")
                tmpFile.writeBytes(seed)
                tmpFile.renameTo(keyFile)
                promise.resolve(null)
            } catch (e: Exception) {
                Log.e(TAG, "importIdentityKey failed: $e")
                promise.reject("IMPORT_ERROR", e.message, e)
            }
        }
    }

    // -------------------------------------------------------------------------
    // Event emitter
    // -------------------------------------------------------------------------

    private fun emitStatus(status: String, detail: String) {
        // Guard: do not emit if the React bridge has been torn down (e.g. app
        // is being destroyed or hot-reloaded). Calling emit on a dead bridge
        // causes a JVM crash in the RN native module infrastructure.
        if (!ctx.hasActiveReactInstance()) return
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
     *       "screen", "calls", "calendar", "media", "motion"
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
                "microphone", "screen", "calls", "calendar", "media", "motion",
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
     * Set the minimum battery % required to serve sensor data-collection requests.
     * levelPct: 0 = disabled, 25 = low (>25%), 50 = medium (>50%), 100 = full (>100%)
     */
    @ReactMethod
    fun setDataBudget(levelPct: Int, promise: Promise) {
        try {
            ctx.getSharedPreferences("zerox1_bridge", android.content.Context.MODE_PRIVATE)
                .edit()
                .putInt("data_budget_pct", levelPct.coerceIn(0, 100))
                .apply()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("PREFS_ERROR", e.message)
        }
    }

    /**
     * Read the current data-collection battery budget threshold (0–100).
     * Default is 100 (full battery required). 0 = collection disabled.
     */
    @ReactMethod
    fun getDataBudget(promise: Promise) {
        try {
            val pct = ctx.getSharedPreferences("zerox1_bridge", android.content.Context.MODE_PRIVATE)
                .getInt("data_budget_pct", 100)
            promise.resolve(pct)
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
        moduleScope.launch {
            try {
                val json = BridgeActivityLog.toJson(limit.coerceIn(1, 200))
                promise.resolve(json.toString())
            } catch (e: Exception) {
                promise.reject("LOG_ERROR", e.message)
            }
        }
    }

    /**
     * Show a local notification when ZeroClaw replies while the app is in the background.
     * Tapping the notification reopens the app to the Chat screen.
     */
    @ReactMethod
    fun showChatNotification(body: String, promise: Promise) {
        try {
            val channelId = "zerox1_chat"
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE)
                as android.app.NotificationManager
            val channel = android.app.NotificationChannel(
                channelId,
                "01 Pilot Chat",
                android.app.NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = "Messages from your agent brain" }
            nm.createNotificationChannel(channel)

            val launchIntent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
            val pi = android.app.PendingIntent.getActivity(
                ctx, 0, launchIntent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
            )
            val notif = androidx.core.app.NotificationCompat.Builder(ctx, channelId)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("01 Pilot")
                .setContentText(body)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build()
            nm.notify(0x5A02, notif)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("NOTIF_ERROR", e.message ?: "Failed to show notification")
        }
    }

    // Required for addListener / removeListeners (RN event emitter contract)
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
