package world.zerox1.pilot

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * BootReceiver — restarts the node service after device reboot.
 *
 * Only fires when RECEIVE_BOOT_COMPLETED permission is granted and the
 * user has started the node at least once (stored preference checked).
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val prefs = context.getSharedPreferences("zerox1", Context.MODE_PRIVATE)
        if (!prefs.getBoolean("node_auto_start", false)) return

        val serviceIntent = Intent(context, NodeService::class.java).apply {
            putExtra(NodeService.EXTRA_AGENT_NAME, prefs.getString("agent_name", "zerox1-agent"))
            putExtra(NodeService.EXTRA_RPC_URL,    prefs.getString("rpc_url",    "https://api.mainnet-beta.solana.com"))
            prefs.getString("relay_addr", null)?.let { putExtra(NodeService.EXTRA_RELAY_ADDR, it) }
            prefs.getString("fcm_token",  null)?.let { putExtra(NodeService.EXTRA_FCM_TOKEN,  it) }
            // Agent brain config
            putExtra(NodeService.EXTRA_BRAIN_ENABLED, prefs.getBoolean("brain_enabled", false))
            prefs.getString("llm_provider",  null)?.let { putExtra(NodeService.EXTRA_LLM_PROVIDER, it) }
            prefs.getString("llm_model",     null)?.let { putExtra(NodeService.EXTRA_LLM_MODEL,    it) }
            prefs.getString("llm_base_url",  null)?.let { putExtra(NodeService.EXTRA_LLM_BASE_URL, it) }
            prefs.getString("capabilities",  null)?.let { putExtra(NodeService.EXTRA_CAPABILITIES, it) }
            // Bags fee-sharing config
            val bagsFeeBps = prefs.getInt("bags_fee_bps", 0)
            if (bagsFeeBps > 0) {
                putExtra(NodeService.EXTRA_BAGS_FEE_BPS, bagsFeeBps)
                prefs.getString("bags_wallet", null)?.let { putExtra(NodeService.EXTRA_BAGS_WALLET, it) }
            }
            // bags API keys are stored in EncryptedSharedPreferences
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
                android.util.Log.e("BootReceiver", "Failed to load secure prefs for bags keys: $e")
            }
        }

        context.startForegroundService(serviceIntent)
    }
}
