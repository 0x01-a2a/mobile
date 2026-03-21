package world.zerox1.pilot

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import androidx.work.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * NtfyWakeWorker — polls the ntfy server for wake events when NodeService is stopped.
 *
 * The 0x01 aggregator sends a lightweight JSON message to
 * `https://ntfy.sh/{agent_pubkey_hex}` whenever a message arrives for a
 * sleeping agent.  This worker polls that endpoint periodically and starts
 * NodeService when a wake event is found.
 *
 * ntfy topic = agent's Ed25519 pubkey (hex, 64 chars), stored in SharedPreferences
 * as `ntfy_topic` by NodeService when it starts.
 *
 * # Scheduling
 * - Scheduled by `NodeService.onDestroy()` via `NtfyWakeWorker.schedule(ctx)`
 * - Cancelled by `NodeService.onCreate()` via `NtfyWakeWorker.cancel(ctx)`
 * - Minimum repeat interval: 15 minutes (Android WorkManager enforced)
 * - Requires network connectivity (WorkManager constraint)
 */
class NtfyWakeWorker(
    private val context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    companion object {
        private const val TAG         = "NtfyWakeWorker"
        private const val WORK_NAME   = "ntfy_wake_poll"
        private const val DEFAULT_NTFY = "https://ntfy.sh"
        private const val PREFS        = "zerox1"
        private const val KEY_SINCE    = "ntfy_since_ts"

        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val request = PeriodicWorkRequestBuilder<NtfyWakeWorker>(
                repeatInterval = 15,
                repeatIntervalTimeUnit = TimeUnit.MINUTES,
            )
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
            Log.d(TAG, "ntfy wake polling scheduled (15-min interval)")
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
            Log.d(TAG, "ntfy wake polling cancelled (NodeService running)")
        }
    }

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        // Skip if NodeService is already running — nothing to wake.
        if (NodeService.isRunning) {
            Log.d(TAG, "NodeService already running — skipping ntfy poll")
            return@withContext Result.success()
        }

        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val topic = prefs.getString("ntfy_topic", null)
        if (topic.isNullOrBlank()) {
            Log.d(TAG, "No ntfy_topic stored — skipping (node never started)")
            return@withContext Result.success()
        }

        if (!prefs.getBoolean("node_auto_start", false)) {
            Log.d(TAG, "Auto-start disabled — skipping ntfy wake")
            return@withContext Result.success()
        }

        val ntfyBase = prefs.getString("ntfy_server", DEFAULT_NTFY) ?: DEFAULT_NTFY
        // `since` = Unix timestamp in seconds of last successful check.
        // On first run use "all" to catch any recent messages.
        val since = prefs.getLong(KEY_SINCE, 0L)
            .takeIf { it > 0 }
            ?.let { it.toString() } ?: "all"

        val pollUrl = "$ntfyBase/$topic/json?poll=1&since=$since"
        Log.d(TAG, "Polling ntfy: $pollUrl")

        try {
            val conn = (URL(pollUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 10_000
                readTimeout    = 15_000
            }
            val responseCode = conn.responseCode
            if (responseCode != 200) {
                Log.w(TAG, "ntfy poll returned HTTP $responseCode — retrying later")
                return@withContext Result.retry()
            }

            val body = conn.inputStream.bufferedReader().readText()
            conn.disconnect()

            // ntfy returns newline-delimited JSON — each line is one ntfy message event.
            // Structure: {"id":"...","event":"message","topic":"...","message":"<body>"}
            // The aggregator posts a JSON body so `message` is a JSON string.
            val hasWakeEvent = body.lines()
                .filter { it.isNotBlank() }
                .any { line ->
                    try {
                        val obj = JSONObject(line)
                        if (obj.optString("event") != "message") return@any false
                        val msgBody = obj.optString("message", "")
                        // The body is the JSON we posted: {"type":"wake",...}
                        JSONObject(msgBody).optString("type") == "wake"
                    } catch (_: Exception) {
                        false
                    }
                }

            // Advance `since` to now so future polls only fetch new messages.
            prefs.edit()
                .putLong(KEY_SINCE, System.currentTimeMillis() / 1000L)
                .apply()

            if (hasWakeEvent) {
                Log.i(TAG, "ntfy wake event received for topic $topic — starting NodeService")
                startNodeService(prefs)
            }

            Result.success()
        } catch (e: Exception) {
            Log.w(TAG, "ntfy poll failed: ${e.message}")
            Result.retry()
        }
    }

    /** Start NodeService with the same config as BootReceiver. */
    private fun startNodeService(prefs: android.content.SharedPreferences) {
        val serviceIntent = Intent(context, NodeService::class.java).apply {
            putExtra(NodeService.EXTRA_AGENT_NAME, prefs.getString("agent_name", "zerox1-agent"))
            putExtra(NodeService.EXTRA_RPC_URL,    prefs.getString("rpc_url",    "https://api.mainnet-beta.solana.com"))
            prefs.getString("relay_addr", null)?.let { putExtra(NodeService.EXTRA_RELAY_ADDR, it) }
            putExtra(NodeService.EXTRA_BRAIN_ENABLED, prefs.getBoolean("brain_enabled", false))
            prefs.getString("llm_provider", null)?.let { putExtra(NodeService.EXTRA_LLM_PROVIDER, it) }
            prefs.getString("llm_model",    null)?.let { putExtra(NodeService.EXTRA_LLM_MODEL,    it) }
            prefs.getString("llm_base_url", null)?.let { putExtra(NodeService.EXTRA_LLM_BASE_URL, it) }
            prefs.getString("capabilities", null)?.let { putExtra(NodeService.EXTRA_CAPABILITIES, it) }
            val bagsFeeBps = prefs.getInt("bags_fee_bps", 0)
            if (bagsFeeBps > 0) {
                putExtra(NodeService.EXTRA_BAGS_FEE_BPS, bagsFeeBps)
                prefs.getString("bags_wallet", null)?.let { putExtra(NodeService.EXTRA_BAGS_WALLET, it) }
            }
            try {
                val masterKey = MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .setRequestStrongBoxBacked(false)
                    .build()
                val securePrefs = EncryptedSharedPreferences.create(
                    context, "zerox1_secure", masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
                )
                securePrefs.getString("bags_api_key",     null)?.let { putExtra(NodeService.EXTRA_BAGS_API_KEY,     it) }
                securePrefs.getString("bags_partner_key", null)?.let { putExtra(NodeService.EXTRA_BAGS_PARTNER_KEY, it) }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to read secure prefs: ${e.message}")
            }
        }
        context.startForegroundService(serviceIntent)
    }
}
