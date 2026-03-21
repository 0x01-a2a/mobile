package world.zerox1.pilot

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
    // Element selector (used by waitForElement / scrollToFind)
    // -------------------------------------------------------------------------

    /**
     * Flexible selector for locating a UI node. At least one field must be set.
     *
     * @param viewId       Exact resource-id match  e.g. "com.example.app:id/btn_ok"
     * @param text         Text / label match (exactText = true: exact, false: contains)
     * @param contentDesc  Content-description match (contains, case-insensitive)
     * @param className    Class name match  e.g. "android.widget.Button"
     * @param exactText    When matching by [text], require an exact case-insensitive match.
     *                     Defaults to false (contains). Has no effect on other fields.
     * @param mustBeEnabled Only return nodes where isEnabled = true. Defaults to true.
     */
    data class ElementSelector(
        val viewId: String? = null,
        val text: String? = null,
        val contentDesc: String? = null,
        val className: String? = null,
        val exactText: Boolean = false,
        val mustBeEnabled: Boolean = true,
    ) {
        fun isBlank() = viewId == null && text == null && contentDesc == null && className == null
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
    // Swipe Gesture
    // -------------------------------------------------------------------------

    /**
     * Dispatch a real finger-swipe gesture from (x1,y1) to (x2,y2).
     * Unlike SCROLL_FORWARD/BACKWARD, this works in apps that only respond to
     * raw touch events (Instagram, TikTok, Maps, custom recycler views).
     *
     * @param durationMs  Duration of the stroke in milliseconds (50–3000).
     *                    Shorter = faster flick; longer = slow drag.
     * @return true if the gesture was dispatched and completed successfully.
     */
    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long = 300): Boolean {
        val path = android.graphics.Path().apply {
            moveTo(x1.toFloat(), y1.toFloat())
            lineTo(x2.toFloat(), y2.toFloat())
        }
        val stroke = android.accessibilityservice.GestureDescription.StrokeDescription(
            path, 0L, durationMs.coerceIn(50, 3_000)
        )
        val gesture = android.accessibilityservice.GestureDescription.Builder()
            .addStroke(stroke)
            .build()

        val latch = CountDownLatch(1)
        var completed = false
        val dispatched = dispatchGesture(
            gesture,
            object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(g: android.accessibilityservice.GestureDescription) {
                    completed = true; latch.countDown()
                }
                override fun onCancelled(g: android.accessibilityservice.GestureDescription) {
                    latch.countDown()
                }
            },
            null
        )
        if (dispatched) latch.await(durationMs + 2_000, TimeUnit.MILLISECONDS)
        return dispatched && completed
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

    // -------------------------------------------------------------------------
    // waitForElement — poll until a node matching the selector appears
    // -------------------------------------------------------------------------

    /**
     * Poll the active window's UI tree until a node matching [selector] appears
     * or [timeoutMs] elapses. Returns the matched [AccessibilityNodeInfo] (caller
     * must NOT recycle it; this method obtains a fresh copy) or null on timeout.
     *
     * @param selector     What to look for.
     * @param timeoutMs    Maximum wait in milliseconds (default 5 000).
     * @param pollMs       Polling interval in milliseconds (default 200).
     */
    fun waitForElement(
        selector: ElementSelector,
        timeoutMs: Long = 5_000,
        pollMs: Long = 200,
    ): AccessibilityNodeInfo? {
        if (selector.isBlank()) return null
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val root = rootInActiveWindow
            if (root != null) {
                val found = findBySelector(root, selector)
                root.recycle()
                if (found != null) return found
            }
            Thread.sleep(pollMs.coerceAtLeast(50))
        }
        return null
    }

    // -------------------------------------------------------------------------
    // scrollToFind — scroll a container until the element appears, then click it
    // -------------------------------------------------------------------------

    /**
     * Scroll a container node in [direction] up to [maxScrolls] times, checking for
     * a node matching [selector] after each scroll. If found and [tapOnFind] is true,
     * the node is clicked.
     *
     * @param selector         What to look for.
     * @param direction        "down" (default), "up", "left", "right".
     * @param maxScrolls       Maximum number of scroll steps (default 10).
     * @param containerViewId  Resource-id of the scrollable container. If null, the
     *                         first scrollable node in the window is used.
     * @param waitAfterScrollMs Pause after each scroll to let the UI settle (default 400 ms).
     * @param tapOnFind        Click the found node immediately (default true).
     * @return true if the element was found (and clicked if [tapOnFind]).
     */
    fun scrollToFind(
        selector: ElementSelector,
        direction: String = "down",
        maxScrolls: Int = 10,
        containerViewId: String? = null,
        waitAfterScrollMs: Long = 400,
        tapOnFind: Boolean = true,
    ): Boolean {
        val scrollAction = when (direction.lowercase()) {
            "up", "left" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            else         -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        }

        // Check before first scroll — element may already be visible.
        rootInActiveWindow?.let { root ->
            val found = findBySelector(root, selector)
            root.recycle()
            if (found != null) {
                if (tapOnFind) { found.performAction(AccessibilityNodeInfo.ACTION_CLICK) }
                found.recycle()
                return true
            }
        }

        repeat(maxScrolls) {
            // Locate the scroll container
            val root = rootInActiveWindow ?: return false
            val container = if (containerViewId != null) {
                root.findAccessibilityNodeInfosByViewId(containerViewId)?.firstOrNull()
                    ?: findFirstScrollable(root)
            } else {
                findFirstScrollable(root)
            }
            if (container == null) {
                root.recycle()
                return false  // no scrollable at all — give up
            }
            container.performAction(scrollAction)
            container.recycle()
            root.recycle()

            Thread.sleep(waitAfterScrollMs.coerceAtLeast(100))

            // Check after scroll
            rootInActiveWindow?.let { r ->
                val found = findBySelector(r, selector)
                r.recycle()
                if (found != null) {
                    if (tapOnFind) { found.performAction(AccessibilityNodeInfo.ACTION_CLICK) }
                    found.recycle()
                    return true
                }
            }
        }
        return false
    }

    // -------------------------------------------------------------------------
    // tapByText / typeInFocused — high-level convenience actions
    // -------------------------------------------------------------------------

    /**
     * Find the first visible node whose text (or content description) matches
     * [text] and click it. Optionally waits up to [timeoutMs] for it to appear.
     *
     * @return true if a matching node was found and clicked.
     */
    fun tapByText(text: String, exact: Boolean = false, timeoutMs: Long = 3_000): Boolean {
        val sel = ElementSelector(text = text, exactText = exact)
        val node = waitForElement(sel, timeoutMs) ?: return false
        val result = node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        node.recycle()
        return result
    }

    /**
     * Type [text] into a field.
     * If [viewId] is given, finds that field. Otherwise uses the currently focused
     * editable node, or the first editable node in the window.
     *
     * @return true if text was successfully set.
     */
    fun typeInFocused(text: String, viewId: String? = null): Boolean {
        val root = rootInActiveWindow ?: return false

        val target: AccessibilityNodeInfo? = when {
            viewId != null ->
                root.findAccessibilityNodeInfosByViewId(viewId)?.firstOrNull()
            else -> {
                // Prefer focused editable node; fall back to first editable.
                findFocusedEditable(root) ?: findFirstEditable(root)
            }
        }
        root.recycle()

        if (target == null) return false

        // Ensure the field is focused before typing
        target.performAction(AccessibilityNodeInfo.ACTION_FOCUS)

        val args = android.os.Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        val result = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        target.recycle()
        return result
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Find the first node in the tree that matches [selector].
     * Caller is responsible for recycling the returned node.
     * Root node is NOT recycled by this method.
     */
    fun findBySelector(root: AccessibilityNodeInfo, sel: ElementSelector): AccessibilityNodeInfo? {
        // Use O(1) system lookups where possible before falling back to tree walk.

        if (sel.viewId != null) {
            val nodes = root.findAccessibilityNodeInfosByViewId(sel.viewId)
            if (!nodes.isNullOrEmpty()) {
                val match = nodes.firstOrNull { !sel.mustBeEnabled || it.isEnabled }
                nodes.forEachIndexed { i, n -> if (i != nodes.indexOf(match)) n.recycle() }
                return match
            }
        }

        if (sel.text != null) {
            val nodes = root.findAccessibilityNodeInfosByText(sel.text)
            if (!nodes.isNullOrEmpty()) {
                val match = nodes.firstOrNull { n ->
                    val t = n.text?.toString() ?: n.contentDescription?.toString() ?: ""
                    val textMatch = if (sel.exactText) t.equals(sel.text, ignoreCase = true)
                                    else t.contains(sel.text, ignoreCase = true)
                    textMatch && (!sel.mustBeEnabled || n.isEnabled)
                }
                nodes.forEachIndexed { i, n -> if (n !== match) n.recycle() }
                return match
            }
        }

        // Fall back to full tree walk (contentDesc / className / etc.)
        return walkForSelector(root, sel, depth = 0)
    }

    private fun walkForSelector(
        node: AccessibilityNodeInfo,
        sel: ElementSelector,
        depth: Int,
    ): AccessibilityNodeInfo? {
        if (depth > 20) return null

        val matches = (!sel.mustBeEnabled || node.isEnabled) &&
            (sel.contentDesc == null || node.contentDescription?.toString()
                ?.contains(sel.contentDesc, ignoreCase = true) == true) &&
            (sel.className == null || node.className?.toString()
                ?.equals(sel.className, ignoreCase = true) == true)

        if (matches && !sel.isBlank()) return AccessibilityNodeInfo.obtain(node)

        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val found = walkForSelector(child, sel, depth + 1)
            child.recycle()
            if (found != null) return found
        }
        return null
    }

    private fun findFirstScrollable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? =
        walkPredicate(root, depth = 0) { it.isScrollable }

    private fun findFocusedEditable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? =
        walkPredicate(root, depth = 0) { it.isFocused && it.isEditable }

    private fun findFirstEditable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? =
        walkPredicate(root, depth = 0) { it.isEditable }

    private fun walkPredicate(
        node: AccessibilityNodeInfo,
        depth: Int,
        pred: (AccessibilityNodeInfo) -> Boolean,
    ): AccessibilityNodeInfo? {
        if (depth > 20) return null
        if (pred(node)) return AccessibilityNodeInfo.obtain(node)
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val found = walkPredicate(child, depth + 1, pred)
            child.recycle()
            if (found != null) return found
        }
        return null
    }
}
