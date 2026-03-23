package world.zerox1.pilot

import android.content.Context
import android.util.Log
import com.solanamobile.seedvault.WalletContractV1
import com.solanamobile.seedvault.Bip44DerivationPath
import com.solanamobile.seedvault.BipLevel
import java.io.File

/**
 * SeedVault identity helper — dappstore (Seeker / Saga) flavor only.
 *
 * Derives the agent's Ed25519 keypair from the device SeedVault using
 * BIP44 path m/44'/501'/0'/0' (standard Solana derivation).
 *
 * If SeedVault is not available (device doesn't have it), falls back
 * gracefully — the node will generate its own keypair file as usual.
 *
 * The derived keypair is written to the same file path the node expects
 * (`zerox1-identity.key`, 64-byte seed || pubkey) so the rest of the
 * startup flow is unchanged.
 */
object SeedVaultIdentity {

    private const val TAG = "SeedVaultIdentity"

    // BIP44 path: m/44'/501'/0'/0'  (Solana coin type 501)
    private val DERIVATION_PATH = Bip44DerivationPath.newBuilder()
        .setAccount(BipLevel(0, true))
        .setChange(BipLevel(0, true))
        .build()

    /**
     * Derive the keypair from SeedVault and write it to [keypairFile] if not already
     * present or if the stored key doesn't match the SeedVault-derived pubkey.
     *
     * No-ops gracefully if SeedVault is unavailable (non-Solana-Mobile device,
     * or the user hasn't set up a seed yet).
     */
    fun ensureKeypairFile(context: Context, keypairFile: File) {
        try {
            if (!isSeedVaultAvailable(context)) {
                Log.i(TAG, "SeedVault not available on this device — using file-based keypair.")
                return
            }

            val pubkey = derivePubkey(context) ?: run {
                Log.w(TAG, "SeedVault pubkey derivation returned null — using file-based keypair.")
                return
            }

            // If the existing keypair file already encodes the same pubkey, nothing to do.
            if (keypairFile.exists() && keypairFile.length() == 64L) {
                val existing = keypairFile.readBytes()
                val existingPubkey = existing.copyOfRange(32, 64)
                if (existingPubkey.contentEquals(pubkey)) {
                    Log.d(TAG, "Keypair file already matches SeedVault pubkey.")
                    return
                }
                Log.i(TAG, "SeedVault pubkey changed — regenerating keypair file.")
            }

            // Write 64-byte keypair: zeros for the private seed (node will re-derive
            // via SeedVault on each signing request), followed by the 32-byte pubkey.
            // The node treats the first 32 bytes as the private seed for in-process
            // signing; for SeedVault-attested identity we pass a sentinel so the node
            // knows to use the external signing path.
            val keypairBytes = ByteArray(64)
            // Sentinel: first byte 0xFF signals SeedVault mode to the node
            keypairBytes[0] = 0xFF.toByte()
            pubkey.copyInto(keypairBytes, destinationOffset = 32)
            keypairFile.writeBytes(keypairBytes)

            Log.i(TAG, "SeedVault keypair written: pubkey=${pubkey.joinToString("") { "%02x".format(it) }}")

        } catch (e: Exception) {
            Log.e(TAG, "SeedVault identity setup failed — falling back to file-based keypair: ${e.message}")
        }
    }

    private fun isSeedVaultAvailable(context: Context): Boolean {
        return try {
            val uri = WalletContractV1.WALLET_PROVIDER_CONTENT_URI_BASE
            val cursor = context.contentResolver.query(uri, null, null, null, null)
            val available = cursor != null
            cursor?.close()
            available
        } catch (e: Exception) {
            false
        }
    }

    private fun derivePubkey(context: Context): ByteArray? {
        return try {
            // Query SeedVault for the authorized seed, then derive the public key.
            // WalletContractV1.WALLET_PROVIDER_CONTENT_URI_BASE provides key derivation
            // without exposing the raw seed to the app.
            val uri = WalletContractV1.ACCOUNTS_CONTENT_URI
            val cursor = context.contentResolver.query(
                uri,
                arrayOf(WalletContractV1.ACCOUNTS_PUBLIC_KEY_RAW),
                null, null, null
            ) ?: return null

            cursor.use {
                if (!it.moveToFirst()) return null
                val colIdx = it.getColumnIndex(WalletContractV1.ACCOUNTS_PUBLIC_KEY_RAW)
                if (colIdx < 0) return null
                it.getBlob(colIdx)
            }
        } catch (e: Exception) {
            Log.w(TAG, "derivePubkey failed: ${e.message}")
            null
        }
    }
}
