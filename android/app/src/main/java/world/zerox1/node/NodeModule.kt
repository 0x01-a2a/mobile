package world.zerox1.node

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

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

    private var isNodeRunning = false

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
    fun startNode(config: ReadableMap, promise: Promise) {
        try {
            val intent = Intent(ctx, NodeService::class.java).apply {
                config.getString("relayAddr")?.let  { putExtra(NodeService.EXTRA_RELAY_ADDR, it) }
                config.getString("fcmToken")?.let   { putExtra(NodeService.EXTRA_FCM_TOKEN,  it) }
                config.getString("agentName")?.let  { putExtra(NodeService.EXTRA_AGENT_NAME, it) }
                config.getString("rpcUrl")?.let     { putExtra(NodeService.EXTRA_RPC_URL,    it) }
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

    // Required for addListener / removeListeners (RN event emitter contract)
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
