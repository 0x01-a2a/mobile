package world.zerox1.node

import android.os.Build
import android.telecom.Call
import android.telecom.CallScreeningService
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*

/**
 * AgentCallScreeningService — intercepts incoming phone calls and exposes them
 * to the ZeroClaw agent via static singleton methods.
 *
 * The user must set this app as the default "Caller ID & Spam" app in
 * Android Settings → Apps → Default apps → Caller ID & spam.
 *
 * When an incoming call arrives, the service:
 *   1. Captures the caller number and timestamp.
 *   2. Adds it to a pending queue accessible by PhoneBridge.
 *   3. Holds the call in a ringing state for up to 15 seconds.
 *   4. The agent can then decide to allow, reject, or silence the call
 *      via the PhoneBridge REST API.
 *   5. If no decision is made within the timeout, the call rings through.
 */
class AgentCallScreeningService : CallScreeningService() {

    companion object {
        const val TAG = "AgentCallScreen"
        private const val DECISION_TIMEOUT_MS = 15_000L
        private const val HISTORY_SIZE = 50
        private const val MAX_PENDING = 10         // max simultaneous pending calls

        @Volatile
        var instance: AgentCallScreeningService? = null
            private set

        // Pending calls awaiting agent decision
        private val pendingCalls = mutableMapOf<String, PendingCall>()

        // History of screened calls
        private val callHistory = ArrayDeque<JSONObject>(HISTORY_SIZE)

        fun isConnected(): Boolean = instance != null

        /**
         * Get all pending calls as JSON.
         */
        fun getPendingCallsJson(): JSONArray {
            val result = JSONArray()
            synchronized(pendingCalls) {
                for ((id, call) in pendingCalls) {
                    result.put(JSONObject().apply {
                        put("callId", id)
                        put("number", call.number)
                        put("timestamp", call.timestamp)
                        put("age_ms", System.currentTimeMillis() - call.timestamp)
                    })
                }
            }
            return result
        }

        /**
         * Get call screening history as JSON.
         */
        fun getHistoryJson(): JSONArray {
            val result = JSONArray()
            synchronized(callHistory) {
                for (entry in callHistory) result.put(entry)
            }
            return result
        }

        /**
         * Submit a decision for a pending call.
         * Actions: "allow", "reject", "silence", "reject_with_message"
         */
        fun respondToCall(callId: String, action: String): Boolean {
            val pending: PendingCall
            synchronized(pendingCalls) {
                pending = pendingCalls.remove(callId) ?: return false
            }
            pending.decide(action)
            return true
        }
    }

    data class PendingCall(
        val number: String,
        val timestamp: Long,
        val details: Call.Details,
        val responder: (CallResponse) -> Unit,
    ) {
        fun decide(action: String) {
            val response = when (action.lowercase()) {
                "reject" -> CallResponse.Builder()
                    .setDisallowCall(true)
                    .setRejectCall(true)
                    .build()
                "silence" -> CallResponse.Builder()
                    .setDisallowCall(false)
                    .setSilenceCall(true)
                    .build()
                "reject_with_message" -> CallResponse.Builder()
                    .setDisallowCall(true)
                    .setRejectCall(true)
                    .setSkipNotification(false)
                    .build()
                else /* "allow" */ -> CallResponse.Builder()
                    .setDisallowCall(false)
                    .setRejectCall(false)
                    .setSilenceCall(false)
                    .build()
            }
            responder(response)
        }
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    override fun onCreate() {
        super.onCreate()
        instance = this
        Log.i(TAG, "CallScreeningService created.")
    }

    override fun onDestroy() {
        instance = null
        Log.i(TAG, "CallScreeningService destroyed.")
        super.onDestroy()
    }

    // -------------------------------------------------------------------------
    // Call Screening
    // -------------------------------------------------------------------------

    override fun onScreenCall(callDetails: Call.Details) {
        val rawNumber = callDetails.handle?.schemeSpecificPart ?: "unknown"
        // Mask number in logs for privacy — show last 4 digits only
        val maskedNumber = if (rawNumber.length > 4) "***${rawNumber.takeLast(4)}" else rawNumber
        val callId = UUID.randomUUID().toString().take(8)
        val timestamp = System.currentTimeMillis()

        Log.i(TAG, "Incoming call from $maskedNumber (id=$callId)")

        // Record in history (store full number for agent, but never log it)
        val historyEntry = JSONObject().apply {
            put("callId", callId)
            put("number", rawNumber)
            put("timestamp", timestamp)
            put("direction", "incoming")
        }
        synchronized(callHistory) {
            callHistory.addFirst(historyEntry)
            while (callHistory.size > HISTORY_SIZE) callHistory.removeLast()
        }

        // Reject immediately if too many pending calls (prevent memory exhaustion)
        synchronized(pendingCalls) {
            if (pendingCalls.size >= MAX_PENDING) {
                Log.w(TAG, "Too many pending calls ($MAX_PENDING) — allowing $callId through.")
                respondToCall(callDetails, CallResponse.Builder()
                    .setDisallowCall(false)
                    .setRejectCall(false)
                    .setSilenceCall(false)
                    .build())
                return
            }
        }

        // Create pending call entry
        val pending = PendingCall(
            number = rawNumber,
            timestamp = timestamp,
            details = callDetails,
            responder = { response -> respondToCall(callDetails, response) },
        )

        synchronized(pendingCalls) {
            pendingCalls[callId] = pending
        }

        // Auto-allow after timeout if agent doesn't respond
        // Use daemon thread so it doesn't prevent service GC
        Thread {
            try {
                Thread.sleep(DECISION_TIMEOUT_MS)
                val stillPending: PendingCall?
                synchronized(pendingCalls) {
                    stillPending = pendingCalls.remove(callId)
                }
                if (stillPending != null) {
                    Log.i(TAG, "Call $callId timed out — allowing through.")
                    stillPending.decide("allow")
                    synchronized(callHistory) {
                        historyEntry.put("decision", "timeout_allow")
                    }
                }
            } catch (_: InterruptedException) {
                // Service shutting down
            }
        }.apply { isDaemon = true }.start()
    }
}
