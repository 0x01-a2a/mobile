package world.zerox1.pilot

import android.app.Notification
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * AgentNotificationListener — intercepts all device notifications and exposes
 * them to the ZeroClaw agent via static singleton methods.
 *
 * The user must manually enable this service in Android Settings →
 * Apps → Special access → Notification access → 0x01 Node.
 *
 * Capabilities:
 *   - getActiveNotifications(): returns all currently visible notifications
 *   - replyToNotification(): fires a RemoteInput reply action (e.g. reply to WhatsApp)
 *   - dismissNotification(): cancel a specific notification
 *   - getNotificationHistory(): returns recent notifications from a rolling buffer
 */
class AgentNotificationListener : NotificationListenerService() {

    companion object {
        const val TAG = "AgentNotifListener"
        private const val HISTORY_SIZE = 100
        private const val MAX_TEXT_LENGTH = 500
        private const val REPLY_RATE_LIMIT = 10     // max replies per minute
        private const val REPLY_WINDOW_MS = 60_000L

        // SharedPreferences keys for triage rules (Gap 3)
        private const val PREFS_NAME              = "zerox1_bridge"
        private const val KEY_BLOCKED_PKGS        = "bridge_notif_blocked_pkgs"    // JSON array of package names
        private const val KEY_VIP_PKGS            = "bridge_notif_vip_pkgs"        // JSON array — always enqueue + log
        private const val KEY_AUTO_DISMISS_PKGS   = "bridge_notif_auto_dismiss_pkgs" // JSON array — enqueue then cancel

        @Volatile
        var instance: AgentNotificationListener? = null
            private set

        fun isConnected(): Boolean = instance != null

        // Reply rate limiter
        private val replyTimestamps = ArrayDeque<Long>(REPLY_RATE_LIMIT)

        // ── Triage rule management ────────────────────────────────────────────

        /** Update notification triage rules. All three parameters accept JSON arrays of package name strings. */
        fun setTriageRules(
            context: Context,
            blockedPkgs: JSONArray? = null,
            vipPkgs: JSONArray? = null,
            autoDismissPkgs: JSONArray? = null,
        ) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            blockedPkgs?.let      { prefs.putString(KEY_BLOCKED_PKGS,      it.toString()) }
            vipPkgs?.let          { prefs.putString(KEY_VIP_PKGS,          it.toString()) }
            autoDismissPkgs?.let  { prefs.putString(KEY_AUTO_DISMISS_PKGS, it.toString()) }
            prefs.apply()
        }

        /** Return current triage rules as a JSONObject with keys blocked, vip, auto_dismiss. */
        fun getTriageRules(context: Context): JSONObject {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            return JSONObject().apply {
                put("blocked",      runCatching { JSONArray(prefs.getString(KEY_BLOCKED_PKGS,      "[]") ?: "[]") }.getOrElse { JSONArray() })
                put("vip",          runCatching { JSONArray(prefs.getString(KEY_VIP_PKGS,          "[]") ?: "[]") }.getOrElse { JSONArray() })
                put("auto_dismiss", runCatching { JSONArray(prefs.getString(KEY_AUTO_DISMISS_PKGS, "[]") ?: "[]") }.getOrElse { JSONArray() })
            }
        }
    }

    // ── Triage helpers (instance-level) ──────────────────────────────────────

    private enum class TriageDecision { BLOCK, RECORD, VIP, AUTO_DISMISS }

    private fun triageDecision(pkg: String): TriageDecision {
        val prefs = applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        fun pkgSet(key: String): Set<String> {
            val raw = prefs.getString(key, "[]") ?: "[]"
            return runCatching {
                JSONArray(raw).let { arr -> (0 until arr.length()).map { arr.getString(it) }.toSet() }
            }.getOrElse { emptySet() }
        }
        return when (pkg) {
            in pkgSet(KEY_BLOCKED_PKGS)      -> TriageDecision.BLOCK
            in pkgSet(KEY_AUTO_DISMISS_PKGS) -> TriageDecision.AUTO_DISMISS
            in pkgSet(KEY_VIP_PKGS)          -> TriageDecision.VIP
            else                             -> TriageDecision.RECORD
        }
    }

    // Rolling history buffer of notifications (newest first)
    private val history = ArrayDeque<JSONObject>(HISTORY_SIZE)

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    override fun onListenerConnected() {
        super.onListenerConnected()
        instance = this
        Log.i(TAG, "NotificationListener connected — intercepting all notifications.")
    }

    override fun onListenerDisconnected() {
        instance = null
        Log.i(TAG, "NotificationListener disconnected.")
        super.onListenerDisconnected()
    }

    // -------------------------------------------------------------------------
    // Notification Events
    // -------------------------------------------------------------------------

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        sbn ?: return
        // Skip our own notifications to avoid feedback loops
        if (sbn.packageName == applicationContext.packageName) return

        val decision = triageDecision(sbn.packageName)

        when (decision) {
            TriageDecision.BLOCK -> {
                Log.d(TAG, "Notification BLOCKED (triage) from ${sbn.packageName}")
                return  // don't add to history, don't dismiss — just ignore
            }
            TriageDecision.AUTO_DISMISS -> {
                Log.i(TAG, "Notification AUTO_DISMISSED (triage) from ${sbn.packageName}")
                val entry = sbnToJson(sbn)
                synchronized(history) {
                    history.addFirst(entry)
                    while (history.size > HISTORY_SIZE) history.removeLast()
                }
                try { cancelNotification(sbn.key) } catch (_: Exception) {}
                return
            }
            TriageDecision.VIP -> {
                Log.i(TAG, "Notification VIP (triage) from ${sbn.packageName}")
                // VIP: fall through to normal history enqueue (future: could wake agent)
            }
            TriageDecision.RECORD -> { /* normal path */ }
        }

        val entry = sbnToJson(sbn)
        synchronized(history) {
            history.addFirst(entry)
            while (history.size > HISTORY_SIZE) history.removeLast()
        }
        Log.d(TAG, "Notification posted: ${sbn.packageName}")
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        // We keep history even after removal so the agent can reference past notifications.
    }

    // -------------------------------------------------------------------------
    // Public API (called from PhoneBridgeServer)
    // -------------------------------------------------------------------------

    /**
     * Returns all currently active (visible) notifications as a JSON array.
     */
    fun getActiveNotificationsJson(): JSONArray {
        val result = JSONArray()
        try {
            val active = activeNotifications ?: return result
            for (sbn in active) {
                if (sbn.packageName == applicationContext.packageName) continue
                result.put(sbnToJson(sbn))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get active notifications: $e")
        }
        return result
    }

    /**
     * Returns the rolling history buffer as a JSON array.
     */
    fun getHistoryJson(): JSONArray {
        val result = JSONArray()
        synchronized(history) {
            for (entry in history) result.put(entry)
        }
        return result
    }

    /**
     * Reply to a notification using RemoteInput.
     * Looks for a reply action on the notification matching [notificationKey],
     * fills in [replyText], and fires the PendingIntent.
     *
     * Returns true if the reply was dispatched successfully.
     */
    fun replyToNotification(notificationKey: String, replyText: String): Boolean {
        // Rate limit: max REPLY_RATE_LIMIT replies per REPLY_WINDOW_MS
        val now = System.currentTimeMillis()
        synchronized(replyTimestamps) {
            // Evict old timestamps
            while (replyTimestamps.isNotEmpty() && now - replyTimestamps.first() > REPLY_WINDOW_MS) {
                replyTimestamps.removeFirst()
            }
            if (replyTimestamps.size >= REPLY_RATE_LIMIT) {
                Log.w(TAG, "Reply rate limited ($REPLY_RATE_LIMIT/min)")
                return false
            }
            replyTimestamps.addLast(now)
        }

        // Cap reply text length to prevent abuse
        val safeText = replyText.take(MAX_TEXT_LENGTH)

        try {
            val active = activeNotifications ?: return false
            val sbn = active.find { it.key == notificationKey } ?: return false

            val actions = sbn.notification.actions ?: return false
            for (action in actions) {
                val remoteInputs = action.remoteInputs ?: continue
                if (remoteInputs.isEmpty()) continue

                // Found a reply action — fill the RemoteInput and fire it
                val intent = Intent()
                val bundle = Bundle()
                for (ri in remoteInputs) {
                    bundle.putCharSequence(ri.resultKey, safeText)
                }
                RemoteInput.addResultsToIntent(remoteInputs, intent, bundle)
                action.actionIntent.send(applicationContext, 0, intent)

                // Don't log message content — privacy
                Log.i(TAG, "Reply sent to ${sbn.packageName}")
                return true
            }
        } catch (e: Exception) {
            Log.e(TAG, "Reply failed: ${e.javaClass.simpleName}")
        }
        return false
    }

    /**
     * Dismiss (cancel) a notification by its key.
     */
    fun dismissNotificationByKey(notificationKey: String): Boolean {
        return try {
            cancelNotification(notificationKey)
            true
        } catch (e: Exception) {
            Log.e(TAG, "Dismiss failed: $e")
            false
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private fun sbnToJson(sbn: StatusBarNotification): JSONObject {
        val extras = sbn.notification.extras
        val hasReplyAction = sbn.notification.actions?.any { action ->
            action.remoteInputs?.isNotEmpty() == true
        } ?: false

        return JSONObject().apply {
            put("key",         sbn.key)
            put("packageName", sbn.packageName)
            put("postTime",    sbn.postTime)
            put("title",       (extras.getString(Notification.EXTRA_TITLE) ?: "").take(MAX_TEXT_LENGTH))
            put("text",        (extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: "").take(MAX_TEXT_LENGTH))
            put("subText",     (extras.getString(Notification.EXTRA_SUB_TEXT) ?: "").take(MAX_TEXT_LENGTH))
            put("bigText",     (extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString() ?: "").take(MAX_TEXT_LENGTH))
            put("category",    sbn.notification.category ?: "")
            put("isOngoing",   sbn.isOngoing)
            put("hasReplyAction", hasReplyAction)
        }
    }
}
