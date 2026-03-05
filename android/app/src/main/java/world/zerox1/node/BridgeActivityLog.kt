package world.zerox1.node

import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*

/**
 * BridgeActivityLog — thread-safe ring buffer of human-readable bridge events.
 *
 * Every PhoneBridgeServer endpoint call logs one entry here before returning.
 * Entries are formatted for display to the user, not for machine consumption.
 *
 * Capacity: CAPACITY most recent entries.
 */
object BridgeActivityLog {

    private const val CAPACITY = 200

    data class Entry(
        val timestampMs: Long,
        val capability: String,   // e.g. "MESSAGING", "CAMERA"
        val action: String,       // short verb phrase: "Read 12 SMS messages"
        val outcome: String,      // "ok" | "denied" | "error" | "rate_limited"
    )

    private val entries = ArrayDeque<Entry>(CAPACITY)
    private val fmt = SimpleDateFormat("HH:mm:ss", Locale.US)

    @Synchronized
    fun record(capability: String, action: String, outcome: String) {
        entries.addFirst(Entry(System.currentTimeMillis(), capability, action, outcome))
        while (entries.size > CAPACITY) entries.removeLast()
    }

    @Synchronized
    fun toJson(limit: Int = 50): JSONArray {
        val result = JSONArray()
        var count = 0
        for (e in entries) {
            if (count >= limit) break
            result.put(JSONObject().apply {
                put("time",       fmt.format(Date(e.timestampMs)))
                put("timestamp",  e.timestampMs)
                put("capability", e.capability)
                put("action",     e.action)
                put("outcome",    e.outcome)
            })
            count++
        }
        return result
    }

    @Synchronized
    fun clear() = entries.clear()
}
