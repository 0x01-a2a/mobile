package world.zerox1.node

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

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
            putExtra(NodeService.EXTRA_RPC_URL,    prefs.getString("rpc_url",    "https://api.devnet.solana.com"))
            prefs.getString("relay_addr", null)?.let { putExtra(NodeService.EXTRA_RELAY_ADDR, it) }
            prefs.getString("fcm_token",  null)?.let { putExtra(NodeService.EXTRA_FCM_TOKEN,  it) }
        }

        context.startForegroundService(serviceIntent)
    }
}
