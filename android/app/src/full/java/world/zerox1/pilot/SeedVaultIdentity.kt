package world.zerox1.pilot

import android.content.Context
import java.io.File

/** No-op stub for non-Solana-Mobile distributions. */
object SeedVaultIdentity {
    fun ensureKeypairFile(context: Context, keypairFile: File) = Unit
}
