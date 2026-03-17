package world.zerox1.pilot

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import kotlin.math.sqrt

/**
 * RecoveryScorer — local sleep + recovery readiness score (0-100).
 *
 * Algorithm:
 *   Sleep score    (weight 50%) — duration + stage quality (deep %, REM %)
 *   HRV score      (weight 30%) — latest vs 30-day baseline deviation
 *   Resting HR     (weight 20%) — today's RHR vs 30-day baseline
 *
 * All data comes from Health Connect via HealthDataReader.
 * Conceptually mirrors the open-source readiness models used by Oura / Garmin.
 */
object RecoveryScorer {

    suspend fun compute(context: Context): JSONObject {
        // 7-day window for sleep + current HRV/RHR; 30-day for baselines
        val health7  = HealthDataReader.readHealth(
            context, setOf("sleep", "heart_rate", "hrv", "steps"), days = 7
        )
        val health30 = HealthDataReader.readHealth(
            context, setOf("heart_rate", "hrv"), days = 30
        )

        val insights = mutableListOf<String>()

        // ── Sleep score ──────────────────────────────────────────────────────

        val sleepSessions  = health7.optJSONArray("sleep_sessions")
        var sleepScore     = 50
        var lastDurMin     = 0L
        var deepPct        = 0.0
        var remPct         = 0.0
        var awakeMin       = 0L

        if (sleepSessions != null && sleepSessions.length() > 0) {
            val last       = sleepSessions.getJSONObject(sleepSessions.length() - 1)
            lastDurMin     = last.optLong("duration_min", 0)

            val durScore = when {
                lastDurMin in 420..540 -> 100   // 7-9h optimal
                lastDurMin >= 360      -> 75    // 6-7h acceptable
                lastDurMin >= 300      -> 50    // 5-6h short
                else                   -> 25   // < 5h very short
            }
            if (lastDurMin < 360) insights += "Short sleep (${lastDurMin / 60}h ${lastDurMin % 60}m) — aim for 7-9h"

            val stages = last.optJSONArray("stages")
            if (stages != null && lastDurMin > 0) {
                var deepMin = 0L; var remMin = 0L
                for (i in 0 until stages.length()) {
                    val s = stages.getJSONObject(i)
                    when (s.optString("type")) {
                        "deep"  -> deepMin  += s.optLong("duration_min")
                        "rem"   -> remMin   += s.optLong("duration_min")
                        "awake" -> awakeMin += s.optLong("duration_min")
                    }
                }
                deepPct = deepMin.toDouble() / lastDurMin * 100
                remPct  = remMin.toDouble()  / lastDurMin * 100

                if (deepPct < 13) insights += "Low deep sleep (${deepPct.toInt()}%) — aim for 15-20%"
                if (remPct  < 18) insights += "Low REM sleep (${remPct.toInt()}%) — aim for 20-25%"
                if (awakeMin > 30) insights += "Fragmented sleep (${awakeMin}min awake)"
            }

            val stageBonus = when {
                deepPct >= 15 && remPct >= 20 -> 20
                deepPct >= 10 && remPct >= 15 -> 10
                else                          -> 0
            }
            sleepScore = (durScore + stageBonus).coerceIn(0, 100)
        } else {
            insights += "No sleep data — enable Health Connect sleep tracking"
        }

        // ── HRV score ────────────────────────────────────────────────────────

        val hrv7     = health7.optDouble("hrv_latest_ms", Double.NaN)
        val hrv30avg = health30.optDouble("hrv_avg_ms",   Double.NaN)
        var hrvScore = 50

        if (!hrv7.isNaN() && !hrv30avg.isNaN() && hrv30avg > 0) {
            val devPct = (hrv7 - hrv30avg) / hrv30avg * 100
            hrvScore = when {
                devPct >=  10 -> 100
                devPct >=   0 -> 80
                devPct >= -10 -> 60
                devPct >= -20 -> 40
                else          -> 20
            }
            if (devPct < -10) insights += "HRV below baseline (${hrv7.toInt()}ms vs ${hrv30avg.toInt()}ms avg)"
            if (devPct >= 10) insights += "HRV above baseline — strong recovery"
        } else if (!hrv7.isNaN()) {
            // Absolute thresholds when no baseline yet
            hrvScore = when {
                hrv7 >= 60 -> 90
                hrv7 >= 40 -> 70
                hrv7 >= 25 -> 50
                else       -> 30
            }
        }

        // ── Resting HR score ─────────────────────────────────────────────────

        val rhr7  = health7.optLong("resting_heart_rate_bpm",  0)
        val rhr30 = health30.optLong("resting_heart_rate_bpm", 0)
        var rhrScore = 50

        if (rhr7 > 0 && rhr30 > 0) {
            val delta = rhr7 - rhr30
            rhrScore = when {
                delta <= -3 -> 100
                delta == 0L -> 80
                delta <= 3  -> 60
                delta <= 6  -> 40
                else        -> 20
            }
            if (delta > 5) insights += "Resting HR elevated +${delta}bpm vs 30-day avg — possible fatigue or illness"
        } else if (rhr7 > 0) {
            rhrScore = when {
                rhr7 <= 50 -> 95
                rhr7 <= 60 -> 85
                rhr7 <= 70 -> 65
                rhr7 <= 80 -> 45
                else       -> 30
            }
        }

        // ── Composite ────────────────────────────────────────────────────────

        val score = (sleepScore * 0.50 + hrvScore * 0.30 + rhrScore * 0.20).toInt()
            .coerceIn(0, 100)

        val label = when {
            score >= 85 -> "Optimal"
            score >= 70 -> "Good"
            score >= 50 -> "Fair"
            else        -> "Poor"
        }

        when {
            score >= 85 -> insights += "Ready for high-intensity training or cognitively demanding work"
            score in 70..84 -> insights += "Good day for moderate activity"
            score in 50..69 -> insights += "Consider lighter activity and an early sleep tonight"
            else -> insights += "Prioritise rest and recovery today"
        }

        val insArr = JSONArray()
        insights.forEach { insArr.put(it) }

        return JSONObject().apply {
            put("score",            score)
            put("readiness",        label)
            put("sleep_score",      sleepScore)
            put("hrv_score",        hrvScore)
            put("resting_hr_score", rhrScore)
            put("last_sleep_min",   lastDurMin)
            put("deep_sleep_pct",   deepPct)
            put("rem_sleep_pct",    remPct)
            put("awake_min",        awakeMin)
            if (!hrv7.isNaN())  put("hrv_ms",         hrv7)
            if (!hrv30avg.isNaN()) put("hrv_30d_avg_ms", hrv30avg)
            if (rhr7  > 0) put("resting_hr_bpm",     rhr7)
            if (rhr30 > 0) put("resting_hr_30d_bpm",  rhr30)
            put("insights",         insArr)
            put("computed_at_ms",   Instant.now().toEpochMilli())
        }
    }
}
