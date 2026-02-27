package world.zerox1.node

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.os.PowerManager
import android.system.Os
import android.util.Log
import kotlinx.coroutines.*
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
        const val ASSET_VERSION    = "0.1.28"   // bump when binary changes

        // Intent extras
        const val EXTRA_RELAY_ADDR  = "relay_addr"
        const val EXTRA_FCM_TOKEN   = "fcm_token"
        const val EXTRA_AGENT_NAME  = "agent_name"
        const val EXTRA_RPC_URL     = "rpc_url"

        // Broadcast action so NodeModule can observe state changes
        const val ACTION_STATUS     = "world.zerox1.node.STATUS"
        const val STATUS_RUNNING    = "running"
        const val STATUS_STOPPED    = "stopped"
        const val STATUS_ERROR      = "error"
    }

    private var nodeProcess:  Process? = null
    private var wakeLock:     PowerManager.WakeLock? = null
    private val serviceScope  = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val wm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = wm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "zerox1:NodeWakeLock")
            .also { it.acquire() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification("Starting…"))

        val relayAddr  = intent?.getStringExtra(EXTRA_RELAY_ADDR)
        val fcmToken   = intent?.getStringExtra(EXTRA_FCM_TOKEN)
        val agentName  = intent?.getStringExtra(EXTRA_AGENT_NAME) ?: "zerox1-agent"
        val rpcUrl     = intent?.getStringExtra(EXTRA_RPC_URL)
                         ?: "https://api.devnet.solana.com"

        serviceScope.launch {
            try {
                val binary = prepareNodeBinary()
                launchNode(binary, relayAddr, fcmToken, agentName, rpcUrl)
            } catch (e: Exception) {
                Log.e(TAG, "Node start failed: $e")
                broadcastStatus(STATUS_ERROR, e.message ?: "unknown error")
                stopSelf()
            }
        }

        return START_STICKY   // restart if killed by OS
    }

    override fun onDestroy() {
        super.onDestroy()
        serviceScope.cancel()
        nodeProcess?.destroy()
        nodeProcess = null
        wakeLock?.release()
        broadcastStatus(STATUS_STOPPED)
        Log.i(TAG, "NodeService destroyed — zerox1-node stopped.")
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

    private suspend fun launchNode(
        binary:    File,
        relayAddr: String?,
        fcmToken:  String?,
        agentName: String,
        rpcUrl:    String,
    ) = withContext(Dispatchers.IO) {

        val logDir     = File(filesDir, "logs").also { it.mkdirs() }
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
            "--relay-server",  "false",   // phones are never relay servers
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

        // Stream node stdout/stderr to Android logcat
        val logJob = launch {
            process.inputStream.bufferedReader().forEachLine { line ->
                Log.d(TAG, "[node] $line")
            }
        }

        // Wait for process to exit
        val exitCode = process.waitFor()
        logJob.cancel()
        Log.w(TAG, "zerox1-node exited with code $exitCode")

        if (isActive) {
            // Unexpected exit — restart after a short delay
            Log.i(TAG, "Restarting node in 5s…")
            updateNotification("Restarting…")
            delay(5_000)
            launchNode(binary, relayAddr, fcmToken, agentName, rpcUrl)
        }
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
