package world.zerox1.node

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.os.PowerManager
import android.system.Os
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.*
import kotlinx.coroutines.isActive
import org.json.JSONArray
import java.io.File

/**
 * NodeService — foreground service that runs the zerox1-node Rust binary.
 *
 * Lifecycle:
 *   startService(intent with extras) → copies binary, launches process, shows notification
 *   stopService()                    → kills process, removes notification
 *
 * The binary is bundled in APK assets as "zerox1-node" and extracted to
 * `filesDir/zerox1-node` on first start (or when the version changes).
 *
 * Communication with the node happens via its existing HTTP+WebSocket API
 * on 127.0.0.1:NODE_API_PORT — no custom IPC needed.
 */
class NodeService : Service() {

    companion object {
        const val TAG              = "NodeService"
        const val CHANNEL_ID       = "zerox1_node_channel"
        const val NOTIF_ID         = 1
        const val NODE_API_PORT    = 9090
        const val BINARY_NAME      = "zerox1-node"
        const val ASSET_VERSION    = "0.2.2"    // bump when binary changes

        // ZeroClaw agent brain binary
        const val AGENT_BINARY_NAME    = "zeroclaw"
        const val AGENT_ASSET_VERSION  = "0.1.0"   // bump when zeroclaw binary changes
        const val AGENT_CONFIG_FILE    = "zeroclaw-config.toml"
        const val AGENT_GATEWAY_PORT   = 42617
        const val AGENT_BRIDGE_PORT    = 9092

        // Intent extras — node
        const val EXTRA_RELAY_ADDR  = "relay_addr"
        const val EXTRA_FCM_TOKEN   = "fcm_token"
        const val EXTRA_AGENT_NAME  = "agent_name"
        const val EXTRA_RPC_URL     = "rpc_url"

        // Intent extras — ZeroClaw brain
        const val EXTRA_BRAIN_ENABLED = "brain_enabled"
        const val EXTRA_LLM_PROVIDER  = "llm_provider"
        const val EXTRA_CAPABILITIES  = "capabilities"       // JSON array string
        const val EXTRA_MIN_FEE       = "min_fee_usdc"
        const val EXTRA_MIN_REP       = "min_reputation"
        const val EXTRA_AUTO_ACCEPT   = "auto_accept"

        // Broadcast action so NodeModule can observe state changes
        const val ACTION_STATUS     = "world.zerox1.node.STATUS"
        const val STATUS_RUNNING    = "running"
        const val STATUS_STOPPED    = "stopped"
        const val STATUS_ERROR      = "error"
    }

    private var nodeProcess:  Process? = null
    private var agentProcess: Process? = null
    private var phoneBridge:  PhoneBridgeServer? = null
    private var wakeLock:     PowerManager.WakeLock? = null
    private val serviceScope  = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var bridgeSecret: String = ""

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val wm = getSystemService(POWER_SERVICE) as PowerManager
        // MED-3: wakeLock.acquire() with 1-hour timeout instead of no timeout
        wakeLock = wm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "zerox1:NodeWakeLock")
            .also { it.acquire(60 * 60 * 1000L) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification("Starting…"))

        val relayAddr    = intent?.getStringExtra(EXTRA_RELAY_ADDR)
        val fcmToken     = intent?.getStringExtra(EXTRA_FCM_TOKEN)
        val agentName    = intent?.getStringExtra(EXTRA_AGENT_NAME) ?: "zerox1-agent"
        val rpcUrl       = intent?.getStringExtra(EXTRA_RPC_URL) ?: "https://api.devnet.solana.com"
        val brainEnabled = intent?.getBooleanExtra(EXTRA_BRAIN_ENABLED, false) ?: false
        val llmProvider  = intent?.getStringExtra(EXTRA_LLM_PROVIDER) ?: "anthropic"
        val capabilities = intent?.getStringExtra(EXTRA_CAPABILITIES) ?: "[]"
        val minFee       = intent?.getDoubleExtra(EXTRA_MIN_FEE, 0.01) ?: 0.01
        val minRep       = intent?.getIntExtra(EXTRA_MIN_REP, 50) ?: 50
        val autoAccept   = intent?.getBooleanExtra(EXTRA_AUTO_ACCEPT, true) ?: true

        // CRIT-1: Generate a random bridge secret
        if (bridgeSecret.isEmpty()) {
            bridgeSecret = java.util.UUID.randomUUID().toString().replace("-", "").take(16)
            Log.i(TAG, "Phone Bridge Secret generated.")
        }

        // CRIT-4: Read API key from Keystore later, not from intent
        // For now, removing it from intent extraction to satisfy audit, 
        // we will implement the Keystore read in writeAgentConfig.

        serviceScope.launch {
            try {
                val binary = prepareNodeBinary()
                // MED-4: Replace recursive launchNode with iterative loop in separate job
                launchNodeIterative(binary, relayAddr, fcmToken, agentName, rpcUrl)
            } catch (e: Exception) {
                Log.e(TAG, "Node start failed: $e")
                broadcastStatus(STATUS_ERROR, e.message ?: "unknown error")
                stopSelf()
            }
        }

        if (brainEnabled) {
            phoneBridge = PhoneBridgeServer(applicationContext, bridgeSecret)
            phoneBridge?.start()
            serviceScope.launch {
                try {
                    // Wait for the node REST API to be ready before starting agent
                    waitForNodeApi()
                    val agentBinary = prepareAgentBinary()
                    writeAgentConfig(llmProvider, capabilities, minFee, minRep, autoAccept)
                    launchAgent(agentBinary)
                } catch (e: Exception) {
                    Log.e(TAG, "Agent brain start failed: $e")
                    // Non-fatal — node continues without brain
                }
            }
        }

        return START_STICKY   // restart if killed by OS
    }

    override fun onDestroy() {
        super.onDestroy()
        serviceScope.cancel()
        agentProcess?.destroy()
        agentProcess = null
        phoneBridge?.stop()
        phoneBridge = null
        nodeProcess?.destroy()
        nodeProcess = null
        if (wakeLock?.isHeld == true) wakeLock?.release()
        broadcastStatus(STATUS_STOPPED)
        Log.i(TAG, "NodeService destroyed — zerox1-node and zeroclaw stopped.")
    }

    // -------------------------------------------------------------------------
    // Binary extraction
    // -------------------------------------------------------------------------

    /**
     * Copy the binary from APK assets to filesDir if:
     *   - it doesn't exist yet, OR
     *   - the bundled version string changed (version file mismatch)
     *
     * Returns the executable File.
     */
    private fun prepareNodeBinary(): File {
        val binaryFile  = File(filesDir, BINARY_NAME)
        val versionFile = File(filesDir, "$BINARY_NAME.version")

        val alreadyExtracted = binaryFile.exists()
            && versionFile.exists()
            && versionFile.readText().trim() == ASSET_VERSION

        if (!alreadyExtracted) {
            Log.i(TAG, "Extracting $BINARY_NAME $ASSET_VERSION from assets…")
            assets.open(BINARY_NAME).use { input ->
                binaryFile.outputStream().use { output -> input.copyTo(output) }
            }
            Os.chmod(binaryFile.absolutePath, 0b111_101_101)   // rwxr-xr-x (755)
            versionFile.writeText(ASSET_VERSION)
            Log.i(TAG, "Binary extracted to ${binaryFile.absolutePath}")
        }

        return binaryFile
    }

    // -------------------------------------------------------------------------
    // Node process
    // -------------------------------------------------------------------------

    private suspend fun launchNodeIterative(
        binary:    File,
        relayAddr: String?,
        fcmToken:  String?,
        agentName: String,
        rpcUrl:    String,
    ) {
        while (coroutineContext.isActive) {
            launchNode(binary, relayAddr, fcmToken, agentName, rpcUrl)
            if (!coroutineContext.isActive) break
            Log.i(TAG, "Restarting node in 5s…")
            updateNotification("Restarting…")
            delay(5_000)
        }
    }

    private suspend fun launchNode(
        binary:    File,
        relayAddr: String?,
        fcmToken:  String?,
        agentName: String,
        rpcUrl:    String,
    ) = withContext(Dispatchers.IO) {
        val logDir      = File(filesDir, "logs").also { it.mkdirs() }
        val keypairPath = File(filesDir, "zerox1-identity.key")
        val aggregatorUrl = "https://api.0x01.world"

        val cmd = mutableListOf(
            binary.absolutePath,
            "--api-addr",      "127.0.0.1:$NODE_API_PORT",
            "--log-dir",       logDir.absolutePath,
            "--keypair-path",  keypairPath.absolutePath,
            "--agent-name",    agentName,
            "--rpc-url",       rpcUrl,
            "--aggregator-url", aggregatorUrl,
            "--relay-server",  "false",
        )

        relayAddr?.let { cmd += listOf("--relay-addr", it) }
        fcmToken?.let  { cmd += listOf("--fcm-token",  it) }

        Log.i(TAG, "Launching node: ${cmd.joinToString(" ")}")

        val process = ProcessBuilder(cmd)
            .redirectErrorStream(true)
            .start()

        nodeProcess = process
        broadcastStatus(STATUS_RUNNING)
        updateNotification("Running — connected to 0x01 mesh")

        val logJob = launch {
            process.inputStream.bufferedReader().useLines { lines ->
                lines.forEach { line ->
                    if (BuildConfig.DEBUG) Log.d(TAG, "[node] $line")
                }
            }
        }

        val exitCode = process.waitFor()
        logJob.cancel()
        Log.w(TAG, "zerox1-node exited with code $exitCode")
        nodeProcess = null
    }

    private fun prepareAgentBinary(): File {
        val binaryFile  = File(filesDir, AGENT_BINARY_NAME)
        val versionFile = File(filesDir, "$AGENT_BINARY_NAME.version")

        val alreadyExtracted = binaryFile.exists()
            && versionFile.exists()
            && versionFile.readText().trim() == AGENT_ASSET_VERSION

        if (!alreadyExtracted) {
            Log.i(TAG, "Extracting $AGENT_BINARY_NAME $AGENT_ASSET_VERSION from assets…")
            assets.open(AGENT_BINARY_NAME).use { input ->
                binaryFile.outputStream().use { output -> input.copyTo(output) }
            }
            Os.chmod(binaryFile.absolutePath, 0b111_101_101)
            versionFile.writeText(AGENT_ASSET_VERSION)
        }

        return binaryFile
    }

    private fun getLlmApiKey(): String? {
        return try {
            val masterKey = MasterKey.Builder(applicationContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            val prefs = EncryptedSharedPreferences.create(
                applicationContext,
                "zerox1_secure",
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            prefs.getString("llm_api_key", null)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to read API key from encrypted storage: $e")
            null
        }
    }

    /**
     * Write a TOML config file for ZeroClaw into filesDir.
     */
    private fun writeAgentConfig(
        provider:     String,
        capabilities: String,
        minFee:       Double,
        minRep:       Int,
        autoAccept:   Boolean,
    ) {
        val modelMap = mapOf(
            "anthropic" to "claude-haiku-4-5-20251001",
            "openai"    to "gpt-4o-mini",
            "gemini"    to "gemini-2.0-flash",
            "groq"      to "llama-3.1-8b-instant",
        )
        val model = modelMap[provider] ?: "claude-haiku-4-5-20251001"

        // CRIT-4: Read API key from secure storage, not from intent.
        val apiKey = getLlmApiKey() ?: ""
        val escapedKey = apiKey.replace("\\", "\\\\").replace("\"", "\\\"")

        // MED-1: Validate capabilities is a proper JSON array to prevent TOML injection.
        val tomlCaps = try {
            JSONArray(if (capabilities.isBlank()) "[]" else capabilities).toString()
        } catch (e: Exception) {
            Log.w(TAG, "Invalid capabilities JSON — using empty array")
            "[]"
        }

        val config = """
[llm]
provider = "$provider"
api_key  = "$escapedKey"
model    = "$model"

[gateway]
port            = $AGENT_GATEWAY_PORT
host            = "127.0.0.1"
require_pairing = false

[channels_config.zerox1]
node_api_url    = "http://127.0.0.1:$NODE_API_PORT"
min_fee_usdc    = $minFee
min_reputation  = $minRep
auto_accept     = $autoAccept
capabilities    = $tomlCaps

[phone]
enabled      = true
bridge_url   = "http://127.0.0.1:$AGENT_BRIDGE_PORT"
secret       = "$bridgeSecret"
timeout_secs = 10
""".trimStart()

        File(filesDir, AGENT_CONFIG_FILE).writeText(config)
        Log.i(TAG, "ZeroClaw TOML config written (bridge secret obfuscated in logs).")
    }

    /**
     * Poll the node REST API until it responds (max 30s), then return.
     * Ensures ZeroClaw doesn't start before the node is ready.
     */
    private suspend fun waitForNodeApi() = withContext(Dispatchers.IO) {
        val url = "http://127.0.0.1:$NODE_API_PORT/peers"
        repeat(30) {
            try {
                val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                conn.connectTimeout = 1_000
                conn.readTimeout    = 1_000
                val code = conn.responseCode
                conn.disconnect()
                if (code == 200) return@withContext
            } catch (_: Exception) { /* not ready yet */ }
            delay(1_000)
        }
        Log.w(TAG, "Node API not ready after 30s — starting ZeroClaw anyway.")
    }

    private suspend fun launchAgent(binary: File) = withContext(Dispatchers.IO) {
        val configPath = File(filesDir, AGENT_CONFIG_FILE).absolutePath
        val cmd = listOf(binary.absolutePath, "--config", configPath)
        Log.i(TAG, "Launching zeroclaw: ${cmd.joinToString(" ")}")

        val process = ProcessBuilder(cmd)
            .redirectErrorStream(true)
            .start()

        agentProcess = process

        // HIGH-5: only pipe agent output to logcat in debug builds
        launch {
            process.inputStream.bufferedReader().useLines { lines ->
                lines.forEach { line ->
                    if (BuildConfig.DEBUG) Log.d(TAG, "[zeroclaw] $line")
                }
            }
        }

        val exitCode = process.waitFor()
        Log.w(TAG, "zeroclaw exited with code $exitCode")
        // Non-fatal: agent exits alone, node keeps running
    }

    // -------------------------------------------------------------------------
    // Notification
    // -------------------------------------------------------------------------

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "0x01 Node",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Keeps your 0x01 mesh node running in the background"
        }
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(status: String): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pi = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("0x01 Node")
            .setContentText(status)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(status: String) {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, buildNotification(status))
    }

    // -------------------------------------------------------------------------
    // Status broadcast (picked up by NodeModule via BroadcastReceiver)
    // -------------------------------------------------------------------------

    private fun broadcastStatus(status: String, detail: String = "") {
        sendBroadcast(Intent(ACTION_STATUS).apply {
            putExtra("status", status)
            putExtra("detail", detail)
        })
    }
}
