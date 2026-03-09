package world.zerox1.node

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
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
import java.io.IOException
import java.security.SecureRandom

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
        const val ASSET_VERSION    = "0.2.22"   // bump when binary changes

        // ZeroClaw agent brain binary
        const val AGENT_BINARY_NAME    = "zeroclaw"
        const val AGENT_ASSET_VERSION  = "0.1.11"   // bump when zeroclaw binary changes
        const val AGENT_CONFIG_FILE    = "config.toml"  // zeroclaw --config-dir looks for config.toml
        const val AGENT_GATEWAY_PORT   = 42617
        const val AGENT_BRIDGE_PORT    = 9092
        const val SECURE_PREFS_NAME    = "zerox1_secure"
        const val KEY_LLM_API_KEY      = "llm_api_key"
        const val KEY_NODE_API_SECRET  = "local_node_api_secret"
        const val KEY_GATEWAY_TOKEN    = "local_gateway_token"
        const val TOML_TQ              = "\"\"\""

        // Intent extras — node
        const val EXTRA_RELAY_ADDR  = "relay_addr"
        const val EXTRA_FCM_TOKEN   = "fcm_token"
        const val EXTRA_AGENT_NAME  = "agent_name"
        const val EXTRA_RPC_URL     = "rpc_url"

        // Intent extras — Bags fee-sharing
        const val EXTRA_BAGS_FEE_BPS = "bags_fee_bps"
        const val EXTRA_BAGS_WALLET  = "bags_wallet"
        const val EXTRA_BAGS_API_KEY = "bags_api_key"
        const val EXTRA_BAGS_PARTNER_KEY = "bags_partner_key"

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

        // ── Bundled zeroclaw skill definitions ──────────────────────────────
        val BAGS_SKILL_TOML = """
[skill]
name        = "bags"
version     = "1.0.0"
description = "Launch and manage tokens on Bags.fm with automatic fee-sharing. Every token you launch gives you 100% of trading fee revenue."
author      = "0x01 World"
tags        = ["bags", "token", "launch", "defi", "solana", "fee-sharing"]

prompts = [${'$'}TOML_TQ
# Bags Token Launch

You can launch your own Solana tokens on Bags.fm directly from this agent.
Every token you launch automatically routes 100% of pool trading fees back to you as the creator.

## How it works

1. **Launch** — bags_launch creates IPFS metadata, sets up fee-sharing, and deploys your token.
   Requires ~0.05 SOL in your agent hot wallet for mint account creation.
2. **Claim** — bags_claim collects accumulated trading fees from your launched tokens.
3. **Positions** — bags_positions shows all tokens you've launched and their fee balances.

## Rules

- Only launch tokens with honest names and descriptions — no impersonation.
- The initial_buy_lamports is optional; omit it to launch with no initial buy.
- After launch, share the token_mint address so others can trade it on Bags.fm.
- Fees accumulate in the pool — claim them periodically with bags_claim.
${'$'}TOML_TQ]

[[tools]]
name        = "bags_launch"
description = "Launch a new Solana token on Bags.fm. You receive 100% of all future pool trading fees. Requires ~0.05 SOL in hot wallet for mint account."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg n {name} --arg s {symbol} --arg d {description} --arg img {image_url} --argjson buy {initial_buy_lamports} '{"name":${'$'}n,"symbol":${'$'}s,"description":${'$'}d,"image_url":(${'$'}img|if . == "" then null else . end),"initial_buy_lamports":(${'$'}buy|if . == 0 then null else . end)}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/bags/launch" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
name                 = "Token name (e.g. 'My Agent Token')"
symbol               = "Ticker symbol, 2-8 chars (e.g. 'MAT')"
description          = "Short description of the token (1-3 sentences)"
image_url            = "URL of the token image (optional — leave empty string to skip)"
initial_buy_lamports = "Lamports to spend on initial token buy (0 = no initial buy; 100000000 = 0.1 SOL)"

[[tools]]
name        = "bags_claim"
description = "Claim accumulated pool trading fees for a token you launched on Bags.fm."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg m {token_mint} '{"token_mint":${'$'}m}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/bags/claim" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
token_mint = "Base58 mint address of the token to claim fees for"

[[tools]]
name        = "bags_positions"
description = "List all tokens you have launched on Bags.fm and their claimable fee balances."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -sf "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/bags/positions" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${'$'}TOML_TQ
""".trimIndent()

        // ── Skill manager (dynamic skill installer) ──────────────────────────
        // All tools call the node REST API — no shell file operations.
        // This prevents path traversal and shell injection.
        val SKILL_MANAGER_TOML = """
[skill]
name        = "skill_manager"
version     = "1.1.0"
description = "Install, remove, and reload zeroclaw skills without an app update. Write any SKILL.toml from chat."
author      = "0x01 World"
tags        = ["skills", "plugins", "extensibility"]

prompts = [${'$'}TOML_TQ
# Skill Manager

You can extend your own capabilities by installing new skills — no app update required.

## What is a skill?

A skill is a SKILL.toml file that defines:
- A system-prompt injection (`prompts`)
- One or more shell tools (`[[tools]]`) executed with `kind = "shell"`

Tools are simple curl commands to any REST API.

## How to install a skill

### Option A — Generate from scratch (most powerful)
1. Generate the full SKILL.toml content as a string
2. Base64-encode it: `printf '%s' '<toml>' | base64`
3. Call `skill_write` with the skill name and base64 content
4. Call `skill_reload` — you restart and come back with the new skill active

### Option B — Install from URL
Call `skill_install_url` with a name and HTTPS URL pointing to a SKILL.toml.
Only use URLs explicitly provided by the user.

## SKILL.toml format

```toml
[skill]
name        = "my-skill"
version     = "1.0.0"
description = "What this skill does"

prompts = [${'$'}TOML_TQ
# Instructions
${'$'}TOML_TQ]

[[tools]]
name        = "my_tool"
description = "What this tool does"
kind        = "shell"
command     = ${'$'}TOML_TQcurl -sf https://api.example.com/endpoint -H "Authorization: Bearer ${'$'}{MY_KEY:-}" ${'$'}TOML_TQ

[tools.args]
param1 = "Description of param1"
```

## Rules
- Skill names: lowercase letters, digits, hyphens, underscores only. No slashes or dots.
- Only HTTPS URLs for skill_install_url.
- Always call skill_reload after writing.
- Tell the user which tools are now available after reload.
${'$'}TOML_TQ]

[[tools]]
name        = "skill_list"
description = "List all installed skills."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -sf "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/skill/list" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${'$'}TOML_TQ

[[tools]]
name        = "skill_write"
description = "Install a new skill by writing its SKILL.toml. Pass base64-encoded content. Call skill_reload after."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg n {name} --arg c {content_b64} '{"name":${'$'}n,"content_b64":${'$'}c}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/skill/write" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
name        = "Skill name: lowercase letters, digits, hyphens, underscores (e.g. pump-fun)"
content_b64 = "Base64-encoded SKILL.toml content"

[[tools]]
name        = "skill_install_url"
description = "Download and install a SKILL.toml from an HTTPS URL provided by the user."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg n {name} --arg u {url} '{"name":${'$'}n,"url":${'$'}u}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/skill/install-url" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
name = "Skill name (lowercase, hyphens ok)"
url  = "Direct HTTPS URL to the SKILL.toml (must be provided by user)"

[[tools]]
name        = "skill_remove"
description = "Remove an installed skill by name."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg n {name} '{"name":${'$'}n}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/skill/remove" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
name = "Name of the skill to remove"

[[tools]]
name        = "skill_reload"
description = "Restart the agent brain to activate newly installed or removed skills. The agent will be back in seconds."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/agent/reload" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${'$'}TOML_TQ
""".trimIndent()
    }

    private var nodeProcess:  Process? = null
    private var agentProcess: Process? = null
    private var phoneBridge:  PhoneBridgeServer? = null
    private var wakeLock:     PowerManager.WakeLock? = null
    private val serviceScope  = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var bridgeSecret: String = ""
    private val secureRandom = SecureRandom()

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val wm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = wm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "zerox1:NodeWakeLock")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Android 12+ (API 31+) throws ForegroundServiceStartNotAllowedException when
        // startForeground() is called from a background context (e.g. auto-restart after
        // the OS killed the process, or BootReceiver on some devices/emulators).
        // Android 14+ (API 34+) with targetSdk 34+ throws MissingForegroundServiceTypeException
        // when the 2-parameter startForeground() is used — a service type is now required.
        // Use the 3-parameter version (available since API 29) to satisfy API 34+ requirements,
        // and catch both exception types to stop cleanly instead of crashing.
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(
                    NOTIF_ID,
                    buildNotification("Starting…"),
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(NOTIF_ID, buildNotification("Starting…"))
            }
        } catch (e: android.app.ForegroundServiceStartNotAllowedException) {
            Log.w(TAG, "startForeground denied (background FGS restriction) — stopping gracefully", e)
            broadcastStatus(STATUS_ERROR, "Cannot start node from background — open the app to start")
            stopSelf()
            return START_NOT_STICKY
        } catch (e: Exception) {
            // Catches MissingForegroundServiceTypeException (API 34+) and any other
            // foreground service startup failures.
            Log.e(TAG, "startForeground failed — stopping gracefully", e)
            broadcastStatus(STATUS_ERROR, "Foreground service start failed: ${e.message}")
            stopSelf()
            return START_NOT_STICKY
        }

        // Re-acquire wake lock for this session. 8-hour timeout keeps the CPU awake
        // for overnight use while still being bounded against leaks if onDestroy is
        // skipped. Release first so a user restart doesn't double-hold.
        if (wakeLock?.isHeld == true) wakeLock?.release()
        wakeLock?.acquire(8 * 60 * 60 * 1000L)

        val relayAddr    = intent?.getStringExtra(EXTRA_RELAY_ADDR)
        val fcmToken     = intent?.getStringExtra(EXTRA_FCM_TOKEN)
        val agentName    = intent?.getStringExtra(EXTRA_AGENT_NAME) ?: "zerox1-agent"
        val rpcUrl       = intent?.getStringExtra(EXTRA_RPC_URL) ?: "https://api.devnet.solana.com"
        val bagsFeeBps   = if (intent?.hasExtra(EXTRA_BAGS_FEE_BPS) == true)
                               intent.getIntExtra(EXTRA_BAGS_FEE_BPS, 0) else 0
        val bagsWallet   = intent?.getStringExtra(EXTRA_BAGS_WALLET)
        val bagsApiKey   = intent?.getStringExtra(EXTRA_BAGS_API_KEY)
            ?.takeIf { it.isNotBlank() }
        val bagsPartnerKey = intent?.getStringExtra(EXTRA_BAGS_PARTNER_KEY)
            ?.takeIf { it.isNotBlank() }
            ?: BuildConfig.DEFAULT_BAGS_PARTNER_KEY.takeIf { it.isNotBlank() }
        val brainEnabled = intent?.getBooleanExtra(EXTRA_BRAIN_ENABLED, false) ?: false
        val llmProvider  = intent?.getStringExtra(EXTRA_LLM_PROVIDER) ?: "gemini"
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
                launchNodeIterative(binary, relayAddr, fcmToken, agentName, rpcUrl, bagsFeeBps, bagsWallet, bagsApiKey, bagsPartnerKey)
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
                    // Restart loop — zeroclaw is SIGTERM'd by /agent/reload to pick up new skills.
                    // After exit it must restart so the new skills are active.
                    while (isActive) {
                        launchAgent(agentBinary)
                        if (!isActive) break
                        Log.i(TAG, "ZeroClaw exited — restarting in 3s…")
                        delay(3_000)
                    }
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
        // Android 14+ (API 34+) targeting SDK 34+ blocks execve() from ALL writable
        // app data directories (filesDir, codeCacheDir, cacheDir) via SELinux policy.
        // The only path where execution is allowed is nativeLibraryDir, which is
        // system-managed and non-writable at runtime.
        // The binary is packaged as jniLibs/arm64-v8a/libzerox1_node.so and Android
        // installs it to nativeLibraryDir with execute permission at install time.
        val binary = File(applicationInfo.nativeLibraryDir, "libzerox1_node.so")
        if (!binary.exists()) {
            throw IOException("Node binary not found at ${binary.absolutePath} — rebuild APK with updated jniLibs")
        }
        Log.i(TAG, "Using node binary: ${binary.absolutePath}")
        return binary
    }

    private fun securePrefs() = EncryptedSharedPreferences.create(
        applicationContext,
        SECURE_PREFS_NAME,
        MasterKey.Builder(applicationContext)
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

    private fun loadSecureString(key: String): String? =
        runCatching { securePrefs().getString(key, null) }.getOrNull()

    private fun extractProcessPid(process: Process): Long? {
        return try {
            val field = process.javaClass.getDeclaredField("pid")
            field.isAccessible = true
            when (val value = field.get(process)) {
                is Int -> value.toLong()
                is Long -> value
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }

    // -------------------------------------------------------------------------
    // Node process
    // -------------------------------------------------------------------------

    private suspend fun launchNodeIterative(
        binary:      File,
        relayAddr:   String?,
        fcmToken:    String?,
        agentName:   String,
        rpcUrl:      String,
        bagsFeeBps:  Int,
        bagsWallet:  String?,
        bagsApiKey:  String?,
        bagsPartnerKey: String?,
    ) {
        while (coroutineContext.isActive) {
            launchNode(binary, relayAddr, fcmToken, agentName, rpcUrl, bagsFeeBps, bagsWallet, bagsApiKey, bagsPartnerKey)
            if (!coroutineContext.isActive) break
            Log.i(TAG, "Restarting node in 5s…")
            updateNotification("Restarting…")
            delay(5_000)
        }
    }

    private suspend fun launchNode(
        binary:      File,
        relayAddr:   String?,
        fcmToken:    String?,
        agentName:   String,
        rpcUrl:      String,
        bagsFeeBps:  Int,
        bagsWallet:  String?,
        bagsApiKey:  String?,
        bagsPartnerKey: String?,
    ) = withContext(Dispatchers.IO) {
        val logDir      = File(filesDir, "logs").also { it.mkdirs() }
        File(filesDir, "zw").mkdirs()   // skill workspace must exist before node starts
        val keypairPath = File(filesDir, "zerox1-identity.key")
        val aggregatorUrl = "https://api.0x01.world"
        val localApiSecret = ensureSecureToken(KEY_NODE_API_SECRET)

        val cmd = mutableListOf(
            binary.absolutePath,
            "--api-addr",      "127.0.0.1:$NODE_API_PORT",
            "--api-secret",    localApiSecret,
            "--log-dir",       logDir.absolutePath,
            "--keypair-path",  keypairPath.absolutePath,
            "--agent-name",    agentName,
            "--rpc-url",       rpcUrl,
            "--aggregator-url", aggregatorUrl,
            // --relay-server is a boolean flag; omit it (default is false)
        )

        relayAddr?.let { cmd += listOf("--relay-addr", it) }
        fcmToken?.let  { cmd += listOf("--fcm-token",  it) }
        if (bagsFeeBps > 0) {
            cmd += listOf("--bags-fee-bps", bagsFeeBps.toString())
            bagsWallet?.let { cmd += listOf("--bags-wallet", it) }
        }
        bagsApiKey?.let { cmd += listOf("--bags-api-key", it) }
        bagsPartnerKey?.let { cmd += listOf("--bags-partner-key", it) }

        // Skill workspace — enables the skill manager REST endpoints on the node.
        cmd += listOf("--skill-workspace", File(filesDir, "zw").absolutePath)

        // Redact sensitive flags before logging.
        val safeCmd = cmd.toMutableList().also { list ->
            val idx = list.indexOf("--bags-api-key")
            if (idx >= 0 && idx + 1 < list.size) list[idx + 1] = "[REDACTED]"
            val partnerIdx = list.indexOf("--bags-partner-key")
            if (partnerIdx >= 0 && partnerIdx + 1 < list.size) list[partnerIdx + 1] = "[REDACTED]"
        }
        Log.i(TAG, "Launching node: ${safeCmd.joinToString(" ")}")

        val process = ProcessBuilder(cmd)
            .redirectErrorStream(true)
            .start()

        nodeProcess = process

        val logJob = launch {
            process.inputStream.bufferedReader().useLines { lines ->
                lines.forEach { line ->
                    if (BuildConfig.DEBUG) Log.d(TAG, "[node] $line")
                }
            }
        }

        // Wait for the HTTP API to actually accept connections before telling
        // the JS layer the node is running.  Without this, the UI immediately
        // makes API calls that hit ECONNREFUSED and shows spurious errors.
        waitForNodeApi()
        broadcastStatus(STATUS_RUNNING)
        updateNotification("Running — connected to 0x01 mesh")

        val exitCode = process.waitFor()
        logJob.cancel()
        Log.w(TAG, "zerox1-node exited with code $exitCode")
        nodeProcess = null
    }

    private fun prepareAgentBinary(): File {
        val binary = File(applicationInfo.nativeLibraryDir, "libzeroclaw.so")
        if (!binary.exists()) {
            throw IOException("Agent binary not found at ${binary.absolutePath} — rebuild APK with updated jniLibs")
        }
        Log.i(TAG, "Using agent binary: ${binary.absolutePath}")
        return binary
    }

    private fun getLlmApiKey(): String? {
        return try {
            securePrefs().getString(KEY_LLM_API_KEY, null)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to read API key from encrypted storage: $e")
            null
        }
    }

    /**
     * Write a TOML config file for ZeroClaw into filesDir, and install bundled skills.
     *
     * Skills are written to {filesDir}/zw/skills/<name>/SKILL.toml so that zeroclaw
     * discovers them via the workspace_dir setting.
     */
    private fun writeAgentConfig(
        provider:     String,
        capabilities: String,
        minFee:       Double,
        minRep:       Int,
        autoAccept:   Boolean,
    ) {
        val modelMap = mapOf(
            "gemini"    to "gemini-2.5-flash",
            "anthropic" to "claude-haiku-4-5-20251001",
            "openai"    to "gpt-4o-mini",
            "groq"      to "llama-3.1-8b-instant",
        )
        val model = modelMap[provider] ?: "gemini-2.5-flash"

        // CRIT-4: Read API key from secure storage, not from intent.
        val apiKey = getLlmApiKey() ?: ""
        val escapedKey = apiKey.replace("\\", "\\\\").replace("\"", "\\\"")
            .replace("\n", "\\n").replace("\r", "\\r")
        val localApiSecret = ensureSecureToken(KEY_NODE_API_SECRET)
        val gatewayToken = ensureSecureToken(KEY_GATEWAY_TOKEN, "zc_mobile_")
        val escapedNodeApiSecret = localApiSecret.replace("\\", "\\\\").replace("\"", "\\\"")
        val escapedGatewayToken = gatewayToken.replace("\\", "\\\\").replace("\"", "\\\"")

        // MED-1: Validate capabilities is a proper JSON array to prevent TOML injection.
        val tomlCaps = try {
            JSONArray(if (capabilities.isBlank()) "[]" else capabilities).toString()
        } catch (e: Exception) {
            Log.w(TAG, "Invalid capabilities JSON — using empty array")
            "[]"
        }

        // Zeroclaw workspace directory — skills are discovered from here.
        val workspaceDir = File(filesDir, "zw")
        workspaceDir.mkdirs()

        val config = """
# Top-level provider settings (no [llm] section — these are root keys)
default_provider    = "$provider"
api_key             = "$escapedKey"
default_model       = "$model"
default_temperature = 0.7

[gateway]
port            = $AGENT_GATEWAY_PORT
host            = "127.0.0.1"
require_pairing = true
paired_tokens   = ["$escapedGatewayToken"]

[channels_config]
cli = false

[channels_config.zerox1]
node_api_url    = "http://127.0.0.1:$NODE_API_PORT"
token           = "$escapedNodeApiSecret"
min_fee_usdc    = $minFee
min_reputation  = $minRep
auto_accept     = $autoAccept
capabilities    = $tomlCaps

[autonomy]
level                  = "supervised"
workspace_only         = false
allowed_commands       = ["curl", "jq", "sh", "bash"]
forbidden_paths        = []
max_actions_per_hour   = 100
max_cost_per_day_cents = 1000
shell_env_passthrough  = ["ZX01_NODE", "ZX01_TOKEN"]

[phone]
enabled      = true
bridge_url   = "http://127.0.0.1:$AGENT_BRIDGE_PORT"
secret       = "$bridgeSecret"
timeout_secs = 10
""".trimStart()

        File(filesDir, AGENT_CONFIG_FILE).writeText(config)
        Log.i(TAG, "ZeroClaw TOML config written (bridge secret obfuscated in logs).")

        // Write bundled skills into the workspace skills directory.
        writeBundledSkills(workspaceDir)
    }

    /**
     * Write bundled zeroclaw skill TOML files into the workspace skills directory.
     *
     * Each skill lives at {workspaceDir}/skills/<name>/SKILL.toml.
     * Skills are idempotent — written on every startup so they stay up to date.
     */
    private fun writeBundledSkills(workspaceDir: File) {
        val skillsRoot = File(workspaceDir, "skills")
        skillsRoot.mkdirs()

        // ── Bags token launch skill ─────────────────────────────────────────
        val bagsSkillDir = File(skillsRoot, "bags")
        bagsSkillDir.mkdirs()
        File(bagsSkillDir, "SKILL.toml").writeText(BAGS_SKILL_TOML)

        // ── Skill manager (dynamic installer) ──────────────────────────────
        val smSkillDir = File(skillsRoot, "skill_manager")
        smSkillDir.mkdirs()
        File(smSkillDir, "SKILL.toml").writeText(SKILL_MANAGER_TOML)

        Log.i(TAG, "Bundled skills written to ${skillsRoot.absolutePath}.")
    }

    /**
     * Poll the node REST API until it responds (max 30s), then return.
     * Ensures ZeroClaw doesn't start before the node is ready.
     *
     * Uses GET /hosted/ping — a no-auth public endpoint that returns {"ok":true}
     * as soon as the Axum HTTP server is accepting requests.  The previous
     * /peers endpoint required the API secret (401 without it), so this check
     * always timed out and ZeroClaw was always delayed by 30 seconds.
     */
    private suspend fun waitForNodeApi() = withContext(Dispatchers.IO) {
        val url = "http://127.0.0.1:$NODE_API_PORT/hosted/ping"
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
        val configDir = filesDir.absolutePath
        val cmd = listOf(binary.absolutePath, "--config-dir", configDir, "daemon")
        Log.i(TAG, "Launching zeroclaw: ${cmd.joinToString(" ")}")

        val workspacePath = File(filesDir, "zw").absolutePath
        val localApiSecret = loadSecureString(KEY_NODE_API_SECRET).orEmpty()
        val process = ProcessBuilder(cmd)
            .redirectErrorStream(true)
            .also {
                // ZeroClaw uses the HOME env var to locate its config directory.
                // Android doesn't set HOME, so point it at filesDir so that
                // "~/.config" and similar paths resolve inside the app's sandbox.
                it.environment()["HOME"] = filesDir.absolutePath
                it.environment()["ZX01_WORKSPACE"] = workspacePath
                it.environment()["ZX01_NODE"] = "http://127.0.0.1:$NODE_API_PORT"
                if (localApiSecret.isNotEmpty()) {
                    it.environment()["ZX01_TOKEN"] = localApiSecret
                }
            }
            .start()

        agentProcess = process

        // Register zeroclaw PID with the node so POST /agent/reload can SIGTERM it.
        try {
            val pid = extractProcessPid(process)
            if (pid != null && pid > 0) {
                val body = "{\"pid\":$pid}"
                val conn = java.net.URL("http://127.0.0.1:$NODE_API_PORT/agent/register-pid")
                    .openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Authorization", "Bearer $localApiSecret")
                conn.doOutput = true
                conn.outputStream.write(body.toByteArray())
                conn.responseCode // send request
                conn.disconnect()
                Log.i(TAG, "Registered zeroclaw PID $pid with node.")
            } else {
                Log.w(TAG, "Could not determine zeroclaw PID; skipping /agent/register-pid.")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not register zeroclaw PID: $e")
        }

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
