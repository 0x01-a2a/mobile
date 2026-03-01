package world.zerox1.node

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener

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
