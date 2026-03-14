package world.zerox1.01pilot

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityService.TakeScreenshotCallback
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executor

/**
 * AgentAccessibilityService — exposes the foreground UI tree and screenshot
 * capture to the ZeroClaw agent via static singleton methods.
 *
 * The user must manually enable this service in Android Settings →
 * Accessibility → 0x01 Agent. Once enabled, the `instance` singleton is
 * populated and the PhoneBridge routes can call into it.
 *
 * Capabilities:
 *   - dumpUiTree(): returns a JSON representation of every visible node
 *   - performNodeAction(): click, longClick, scroll on a node by viewId or bounds
 *   - captureScreenshot(): silent screenshot via A11y (Android 11+, no user prompt)
 *   - globalAction(): Back, Home, Recents, Notifications, Quick Settings
 */
class AgentAccessibilityService : AccessibilityService() {

    companion object {
        const val TAG = "AgentA11y"

        @Volatile
        var instance: AgentAccessibilityService? = null
            private set

        /** Quick check for PhoneBridge to know if the service is alive. */
        fun isConnected(): Boolean = instance != null

        // Rate limit: max 1 screenshot per second
        @Volatile
        private var lastScreenshotMs = 0L
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "AccessibilityService connected.")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // We don't need to react to individual events; the agent polls on demand.
    }

    override fun onInterrupt() {
        Log.w(TAG, "AccessibilityService interrupted.")
    }

    override fun onDestroy() {
        instance = null
        Log.i(TAG, "AccessibilityService destroyed.")
        super.onDestroy()
    }

    // -------------------------------------------------------------------------
    // UI Tree Dump
    // -------------------------------------------------------------------------

    /**
     * Walk the active window's accessibility node tree and return a JSON array
     * of all visible nodes. Each node contains:
     *   - className, text, contentDescription, viewIdResourceName
     *   - bounds (screen coordinates)
     *   - clickable, scrollable, editable, focused
     *   - childCount
     *
     * Max depth 15, max nodes 500 to prevent OOM on complex UIs.
     */
    fun dumpUiTree(): JSONArray {
        val root = rootInActiveWindow ?: return JSONArray()
        val result = JSONArray()
        walkNode(root, result, depth = 0, maxDepth = 15, maxNodes = 500)
        root.recycle()
        return result
    }

    private fun walkNode(
        node: AccessibilityNodeInfo,
        out: JSONArray,
        depth: Int,
        maxDepth: Int,
        maxNodes: Int,
    ) {
        if (depth > maxDepth || out.length() >= maxNodes) return

        val rect = android.graphics.Rect()
        node.getBoundsInScreen(rect)

        out.put(JSONObject().apply {
            put("depth",              depth)
            put("className",         node.className?.toString() ?: "")
            put("text",              node.text?.toString() ?: "")
            put("contentDescription", node.contentDescription?.toString() ?: "")
            put("viewId",            node.viewIdResourceName ?: "")
            put("bounds", JSONObject().apply {
                put("left",   rect.left)
                put("top",    rect.top)
                put("right",  rect.right)
                put("bottom", rect.bottom)
            })
            put("clickable",  node.isClickable)
            put("scrollable", node.isScrollable)
            put("editable",   node.isEditable)
            put("focused",    node.isFocused)
            put("checked",    node.isChecked)
            put("enabled",    node.isEnabled)
            put("childCount", node.childCount)
        })

        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            walkNode(child, out, depth + 1, maxDepth, maxNodes)
            child.recycle()
        }
    }

    // -------------------------------------------------------------------------
    // Node Actions
    // -------------------------------------------------------------------------

    /**
     * Find a node by viewIdResourceName and perform an action on it.
     * Supported actions: "click", "long_click", "scroll_forward", "scroll_backward",
     *                    "set_text" (requires `text` param), "focus", "clear_focus"
     *
     * Returns true if the action was dispatched.
     */
    fun performNodeAction(viewId: String, action: String, text: String? = null): Boolean {
        val root = rootInActiveWindow ?: return false
        val nodes = root.findAccessibilityNodeInfosByViewId(viewId)
        // Do NOT recycle root until we are done with nodes — they may hold
        // references into the same node tree. Recycling root first is a
        // use-after-recycle bug that crashes on some OEMs.
        if (nodes.isNullOrEmpty()) {
            root.recycle()
            return false
        }

        val target = nodes[0]
        val result: Boolean
        when (action.lowercase()) {
            "click"           -> result = target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            "long_click"      -> result = target.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)
            "scroll_forward"  -> result = target.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
            "scroll_backward" -> result = target.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)
            "focus"           -> result = target.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            "clear_focus"     -> result = target.performAction(AccessibilityNodeInfo.ACTION_CLEAR_FOCUS)
            "set_text" -> {
                val args = android.os.Bundle()
                args.putCharSequence(
                    AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                    text ?: ""
                )
                result = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            }
            else -> result = false
        }
        // Recycle all nodes, then root
        for (n in nodes) n.recycle()
        root.recycle()
        return result
    }

    /**
     * Click at a specific screen coordinate by walking the tree and finding
     * the deepest clickable node whose bounds contain (x, y).
     */
    fun clickAtCoordinates(x: Int, y: Int): Boolean {
        val root = rootInActiveWindow ?: return false
        val target = findNodeAt(root, x, y)
        root.recycle()
        if (target != null) {
            val result = target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            target.recycle()
            return result
        }
        // Fallback: gesture dispatch
        val path = android.graphics.Path()
        path.moveTo(x.toFloat(), y.toFloat())
        val gesture = android.accessibilityservice.GestureDescription.Builder()
            .addStroke(
                android.accessibilityservice.GestureDescription.StrokeDescription(
                    path, 0L, 50L
                )
            )
            .build()
        return dispatchGesture(gesture, null, null)
    }

    private fun findNodeAt(node: AccessibilityNodeInfo, x: Int, y: Int): AccessibilityNodeInfo? {
        val rect = android.graphics.Rect()
        node.getBoundsInScreen(rect)
        if (!rect.contains(x, y)) return null

        // Depth-first: prefer the deepest matching clickable child
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val found = findNodeAt(child, x, y)
            if (found != null) {
                child.recycle()
                return found
            }
            child.recycle()
        }

        return if (node.isClickable) {
            AccessibilityNodeInfo.obtain(node)
        } else null
    }

    // -------------------------------------------------------------------------
    // Global Actions
    // -------------------------------------------------------------------------

    /**
     * Perform a global action: "back", "home", "recents", "notifications",
     * "quick_settings", "power_dialog", "lock_screen".
     */
    fun performGlobalAction(action: String): Boolean {
        val actionId = when (action.lowercase()) {
            "back"           -> GLOBAL_ACTION_BACK
            "home"           -> GLOBAL_ACTION_HOME
            "recents"        -> GLOBAL_ACTION_RECENTS
            "notifications"  -> GLOBAL_ACTION_NOTIFICATIONS
            "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
            "power_dialog"   -> GLOBAL_ACTION_POWER_DIALOG
            "lock_screen"    -> GLOBAL_ACTION_LOCK_SCREEN
            else -> return false
        }
        return performGlobalAction(actionId)
    }

    // -------------------------------------------------------------------------
    // Screenshot (Android 11+ / API 30+)
    // -------------------------------------------------------------------------

    /**
     * Take a silent screenshot using AccessibilityService.takeScreenshot().
     * Returns a Base64-encoded JPEG string, or null on failure/timeout.
     * Blocks the calling thread for up to 5 seconds.
     */
    fun captureScreenshot(): String? {
        // Rate limit: 1 screenshot per second
        val now = System.currentTimeMillis()
        if (now - lastScreenshotMs < 1_000L) {
            Log.w(TAG, "Screenshot rate limited (max 1/sec)")
            return null
        }
        lastScreenshotMs = now

        val latch = CountDownLatch(1)
        var result: String? = null

        val executor = Executor { it.run() }

        takeScreenshot(
            Display.DEFAULT_DISPLAY,
            executor,
            object : TakeScreenshotCallback {
                override fun onSuccess(screenshot: ScreenshotResult) {
                    try {
                        val hwBitmap = Bitmap.wrapHardwareBuffer(
                            screenshot.hardwareBuffer,
                            screenshot.colorSpace
                        )
                        screenshot.hardwareBuffer.close()

                        if (hwBitmap != null) {
                            // Hardware bitmaps can't be compressed directly; copy to software
                            val swBitmap = hwBitmap.copy(Bitmap.Config.ARGB_8888, false)
                            hwBitmap.recycle()

                            if (swBitmap != null) {
                                val stream = ByteArrayOutputStream()
                                swBitmap.compress(Bitmap.CompressFormat.JPEG, 70, stream)
                                swBitmap.recycle()
                                result = Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
                            }
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Screenshot processing failed: ${e.javaClass.simpleName}")
                    } finally {
                        latch.countDown()
                    }
                }

                override fun onFailure(errorCode: Int) {
                    Log.w(TAG, "Screenshot failed with error code: $errorCode")
                    latch.countDown()
                }
            }
        )

        latch.await(5, TimeUnit.SECONDS)
        return result
    }
}
