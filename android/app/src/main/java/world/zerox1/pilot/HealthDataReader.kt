package world.zerox1.pilot

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * HealthDataReader — reads structured health data from Android Health Connect.
 *
 * Supported types: steps, heart_rate, hrv, sleep, calories, oxygen_saturation, weight.
 * All computation is local; no external API calls.
 */
object HealthDataReader {

    suspend fun readHealth(context: Context, types: Set<String>, days: Int): JSONObject {
        val result = JSONObject()

        val status = HealthConnectClient.getSdkStatus(context)
        if (status != HealthConnectClient.SDK_AVAILABLE) {
            result.put("error", "Health Connect not available (status=$status)")
            return result
        }

        val client    = HealthConnectClient.getOrCreate(context)
        val endTime   = Instant.now()
        val startTime = endTime.minus(days.toLong(), ChronoUnit.DAYS)
        val filter    = TimeRangeFilter.between(startTime, endTime)

        if ("steps" in types) runCatching {
            val response = client.readRecords(ReadRecordsRequest(StepsRecord::class, filter))
            result.put("steps_total", response.records.sumOf { it.count })
            val daily = JSONArray()
            response.records.forEach { rec ->
                daily.put(JSONObject().apply {
                    put("start_ms", rec.startTime.toEpochMilli())
                    put("end_ms",   rec.endTime.toEpochMilli())
                    put("count",    rec.count)
                })
            }
            result.put("steps", daily)
        }

        if ("heart_rate" in types) runCatching {
            val response = client.readRecords(ReadRecordsRequest(HeartRateRecord::class, filter))
            val samples  = response.records.flatMap { it.samples }
            if (samples.isNotEmpty()) {
                result.put("heart_rate_avg_bpm", samples.map { it.beatsPerMinute }.average().toLong())
                result.put("heart_rate_min_bpm", samples.minOf { it.beatsPerMinute })
                result.put("heart_rate_max_bpm", samples.maxOf { it.beatsPerMinute })
                result.put("heart_rate_samples", samples.size)
                // Resting HR: lowest session average
                val sessionAvgs = response.records
                    .filter { it.samples.isNotEmpty() }
                    .map { rec -> rec.samples.map { it.beatsPerMinute }.average() }
                    .sorted()
                if (sessionAvgs.isNotEmpty()) {
                    result.put("resting_heart_rate_bpm", sessionAvgs.first().toLong())
                }
            }
        }

        if ("hrv" in types) runCatching {
            val response = client.readRecords(
                ReadRecordsRequest(HeartRateVariabilityRmssdRecord::class, filter)
            )
            if (response.records.isNotEmpty()) {
                val vals = response.records.map { it.heartRateVariabilityMillis }
                result.put("hrv_avg_ms",    vals.average())
                result.put("hrv_min_ms",    vals.min())
                result.put("hrv_max_ms",    vals.max())
                result.put("hrv_latest_ms", response.records.last().heartRateVariabilityMillis)
                result.put("hrv_samples",   vals.size)
            }
        }

        if ("sleep" in types) runCatching {
            val response = client.readRecords(ReadRecordsRequest(SleepSessionRecord::class, filter))
            val sessions = JSONArray()
            var totalMin = 0L
            response.records.forEach { rec ->
                val durMin = ChronoUnit.MINUTES.between(rec.startTime, rec.endTime)
                totalMin += durMin
                val stages = JSONArray()
                rec.stages.forEach { stage ->
                    stages.put(JSONObject().apply {
                        put("type",         stageName(stage.stage))
                        put("start_ms",     stage.startTime.toEpochMilli())
                        put("end_ms",       stage.endTime.toEpochMilli())
                        put("duration_min", ChronoUnit.MINUTES.between(stage.startTime, stage.endTime))
                    })
                }
                sessions.put(JSONObject().apply {
                    put("start_ms",    rec.startTime.toEpochMilli())
                    put("end_ms",      rec.endTime.toEpochMilli())
                    put("duration_min", durMin)
                    rec.title?.let { put("title", it) }
                    if (stages.length() > 0) put("stages", stages)
                })
            }
            result.put("sleep_sessions", sessions)
            result.put("sleep_total_min", totalMin)
            if (response.records.isNotEmpty()) {
                result.put("sleep_avg_min", totalMin / response.records.size)
            }
        }

        if ("calories" in types) runCatching {
            val response = client.readRecords(
                ReadRecordsRequest(TotalCaloriesBurnedRecord::class, filter)
            )
            result.put("calories_total_kcal", response.records.sumOf { it.energy.inKilocalories })
        }

        if ("oxygen_saturation" in types) runCatching {
            val response = client.readRecords(
                ReadRecordsRequest(OxygenSaturationRecord::class, filter)
            )
            if (response.records.isNotEmpty()) {
                val vals = response.records.map { it.percentage.value }
                result.put("oxygen_saturation_avg_pct", vals.average())
                result.put("oxygen_saturation_min_pct", vals.min())
                result.put("oxygen_saturation_samples", vals.size)
            }
        }

        if ("weight" in types) runCatching {
            val response = client.readRecords(ReadRecordsRequest(WeightRecord::class, filter))
            if (response.records.isNotEmpty()) {
                val latest = response.records.maxByOrNull { it.time }
                result.put("weight_kg",      latest?.weight?.inKilograms)
                result.put("weight_samples", response.records.size)
                val trend = response.records.sortedBy { it.time }
                if (trend.size >= 2) {
                    result.put("weight_change_kg",
                        trend.last().weight.inKilograms - trend.first().weight.inKilograms)
                }
            }
        }

        result.put("query_start_ms", startTime.toEpochMilli())
        result.put("query_end_ms",   endTime.toEpochMilli())
        result.put("days",           days)
        return result
    }

    private fun stageName(stage: Int) = when (stage) {
        SleepSessionRecord.STAGE_TYPE_AWAKE      -> "awake"
        SleepSessionRecord.STAGE_TYPE_SLEEPING   -> "sleeping"
        SleepSessionRecord.STAGE_TYPE_OUT_OF_BED -> "out_of_bed"
        SleepSessionRecord.STAGE_TYPE_LIGHT      -> "light"
        SleepSessionRecord.STAGE_TYPE_DEEP       -> "deep"
        SleepSessionRecord.STAGE_TYPE_REM        -> "rem"
        else                                     -> "unknown"
    }
}
