package world.zerox1.pilot

import android.util.Log
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * ScreenActionQueue — pending human-approval queue for ASSISTED-mode screen actions.
 *
 * Correct ordering (race-free):
 *  1. Caller creates a [PendingAction] and calls [register] — action is in [pending] map.
 *  2. Caller emits the RN 'screenActionPending' event (safe: action already registered).
 *  3. Caller blocks on [awaitRegistered] — waits up to 30 s for a decision.
 *  4. JS calls NodeModule.confirmScreenAction(id, approved) → [decide] is called.
 *  5. [awaitRegistered] unblocks and returns the approval result.
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
     * Register an action in the pending map BEFORE emitting the RN event.
     * Guarantees that [decide] cannot miss the action even if JS responds immediately.
     */
    fun register(action: PendingAction) {
        pending[action.id] = action
        Log.i(TAG, "Registered action ${action.id}: ${action.description}")
    }

    /**
     * Block until the user decides on an already-[register]ed action (or timeout).
     * Removes the action from the map when done.
     * @return true if approved, false if rejected or timed out.
     */
    fun awaitRegistered(action: PendingAction): Boolean {
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
     * Convenience: register + emit-via-caller + await in one call.
     * Use only when the caller does not need to emit an event before blocking.
     */
    fun awaitApproval(endpoint: String, description: String): Boolean {
        val action = PendingAction(endpoint = endpoint, description = description)
        register(action)
        return awaitRegistered(action)
    }

    /** @deprecated Use register() + awaitRegistered() pair instead. */
    fun awaitApprovalWithAction(action: PendingAction): Boolean {
        register(action)
        return awaitRegistered(action)
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
