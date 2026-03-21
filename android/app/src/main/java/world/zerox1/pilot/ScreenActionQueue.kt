package world.zerox1.pilot

import android.util.Log
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * ScreenActionQueue — pending human-approval queue for ASSISTED-mode screen actions.
 *
 * When POLICY_MODE = "ASSISTED" and an action endpoint is called:
 *  1. A PendingAction is created and stored here.
 *  2. NodeModule emits a 'screenActionPending' RN event with the action details.
 *  3. The bridge handler blocks on [PendingAction.latch] (timeout: 30s).
 *  4. The user approves/rejects via NodeModule.confirmScreenAction() which calls [decide].
 *  5. The blocking handler wakes, checks [PendingAction.approved], and proceeds or rejects.
 *
 * Thread safety: ConcurrentHashMap + CountDownLatch — no additional synchronisation needed.
 */
object ScreenActionQueue {

    private const val TAG = "ScreenActionQueue"
    private const val TIMEOUT_SECONDS = 30L

    data class PendingAction(
        val id: String = UUID.randomUUID().toString(),
        val endpoint: String,
        val description: String,
        val latch: CountDownLatch = CountDownLatch(1),
        @Volatile var approved: Boolean = false,
    )

    private val pending = ConcurrentHashMap<String, PendingAction>()

    /**
     * Enqueue a new pending action and block until the user decides (or timeout).
     * @return true if approved, false if rejected or timed out.
     */
    fun awaitApproval(endpoint: String, description: String): Boolean =
        awaitApprovalWithAction(PendingAction(endpoint = endpoint, description = description))

    /**
     * Enqueue a pre-built [PendingAction] (so the caller can emit its ID before blocking)
     * and block until the user decides (or timeout).
     */
    fun awaitApprovalWithAction(action: PendingAction): Boolean {
        pending[action.id] = action
        Log.i(TAG, "Queued action ${action.id}: ${action.description}")

        val decided = action.latch.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        pending.remove(action.id)

        return if (decided) {
            Log.i(TAG, "Action ${action.id} ${if (action.approved) "APPROVED" else "REJECTED"} by user")
            action.approved
        } else {
            Log.w(TAG, "Action ${action.id} TIMED OUT after ${TIMEOUT_SECONDS}s — rejecting")
            false
        }
    }

    /**
     * Resolve a pending action from the React Native side.
     * Called by NodeModule.confirmScreenAction().
     */
    fun decide(id: String, approved: Boolean) {
        val action = pending[id]
        if (action == null) {
            Log.w(TAG, "decide($id) — no such pending action")
            return
        }
        action.approved = approved
        action.latch.countDown()
    }

    /** Snapshot of all pending action IDs + descriptions — for UI listing. */
    fun snapshot(): List<Map<String, String>> =
        pending.values.map { mapOf("id" to it.id, "endpoint" to it.endpoint, "description" to it.description) }
}
