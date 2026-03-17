package world.zerox1.pilot

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * WearableScanner — BLE GATT client for standard health-profile devices.
 *
 * Supported Bluetooth SIG services:
 *   Heart Rate Service       0x180D  — Polar H10, Garmin HRM, most chest straps
 *   Glucose Service          0x1808  — dedicated glucose meters
 *   CGM Service              0x181F  — Dexcom G7, Libre 3 (raw; CGM requires pairing)
 *   Battery Service          0x180F  — universal
 *   Body Composition         0x181B  — Withings / Eufy smart scales
 *   Running Speed & Cadence  0x1814  — Garmin foot pods, some treadmills
 *
 * All operations are fire-and-forget GATT reads (no notifications) to keep the
 * implementation simple and battery-friendly. Devices that require bonding before
 * exposing encrypted characteristics will return an error; the user must pair first.
 */
@SuppressLint("MissingPermission")
object WearableScanner {

    private const val TAG              = "WearableScanner"
    private const val SCAN_DURATION_MS = 8_000L
    private const val GATT_TIMEOUT_MS  = 12_000L

    // ── Standard BLE SIG UUIDs ──────────────────────────────────────────────

    private val HEART_RATE_SERVICE     = UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb")
    private val HEART_RATE_MEAS        = UUID.fromString("00002a37-0000-1000-8000-00805f9b34fb")

    private val GLUCOSE_SERVICE        = UUID.fromString("00001808-0000-1000-8000-00805f9b34fb")
    private val GLUCOSE_MEAS           = UUID.fromString("00002a18-0000-1000-8000-00805f9b34fb")

    private val CGM_SERVICE            = UUID.fromString("0000181f-0000-1000-8000-00805f9b34fb")
    private val CGM_MEAS               = UUID.fromString("00002aa7-0000-1000-8000-00805f9b34fb")

    private val BATTERY_SERVICE        = UUID.fromString("0000180f-0000-1000-8000-00805f9b34fb")
    private val BATTERY_LEVEL          = UUID.fromString("00002a19-0000-1000-8000-00805f9b34fb")

    private val BODY_COMP_SERVICE      = UUID.fromString("0000181b-0000-1000-8000-00805f9b34fb")
    private val BODY_COMP_MEAS         = UUID.fromString("00002a9b-0000-1000-8000-00805f9b34fb")

    private val RSC_SERVICE            = UUID.fromString("00001814-0000-1000-8000-00805f9b34fb")
    private val RSC_MEAS               = UUID.fromString("00002a53-0000-1000-8000-00805f9b34fb")

    private val DEVICE_INFO_SERVICE    = UUID.fromString("0000180a-0000-1000-8000-00805f9b34fb")
    private val MANUFACTURER_NAME      = UUID.fromString("00002a29-0000-1000-8000-00805f9b34fb")
    private val MODEL_NUMBER           = UUID.fromString("00002a24-0000-1000-8000-00805f9b34fb")

    private val HEALTH_SERVICE_UUIDS = listOf(
        HEART_RATE_SERVICE, GLUCOSE_SERVICE, CGM_SERVICE,
        BATTERY_SERVICE, BODY_COMP_SERVICE, RSC_SERVICE,
    )

    private fun serviceName(uuid: UUID) = when (uuid) {
        HEART_RATE_SERVICE -> "heart_rate"
        GLUCOSE_SERVICE    -> "glucose"
        CGM_SERVICE        -> "cgm"
        BATTERY_SERVICE    -> "battery"
        BODY_COMP_SERVICE  -> "body_composition"
        RSC_SERVICE        -> "running_speed_cadence"
        DEVICE_INFO_SERVICE-> "device_info"
        else               -> uuid.toString()
    }

    // ── Scan ────────────────────────────────────────────────────────────────

    /**
     * Active BLE scan for devices advertising any health service UUID.
     * Returns JSON array of { address, name, rssi, services[] }.
     */
    suspend fun scan(context: Context, durationMs: Long = SCAN_DURATION_MS): JSONArray {
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            ?: return JSONArray()
        val adapter = manager.adapter ?: return JSONArray()
        if (!adapter.isEnabled) return JSONArray()

        val found    = mutableMapOf<String, JSONObject>()
        val filters  = HEALTH_SERVICE_UUIDS.map { uuid ->
            ScanFilter.Builder().setServiceUuid(android.os.ParcelUuid(uuid)).build()
        }
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val addr = result.device.address ?: return
                if (addr in found) return
                val svcNames = result.scanRecord?.serviceUuids
                    ?.map { serviceName(it.uuid) } ?: emptyList()
                found[addr] = JSONObject().apply {
                    put("address",  addr)
                    put("name",     result.device.name ?: "Unknown")
                    put("rssi",     result.rssi)
                    val arr = JSONArray(); svcNames.forEach { arr.put(it) }
                    put("services", arr)
                }
                Log.d(TAG, "Wearable found: ${result.device.name} @ $addr svcs=$svcNames")
            }
            override fun onScanFailed(errorCode: Int) {
                Log.w(TAG, "BLE scan failed: $errorCode")
            }
        }

        val scanner = adapter.bluetoothLeScanner ?: return JSONArray()
        scanner.startScan(filters, settings, callback)
        delay(durationMs)
        scanner.stopScan(callback)

        val result = JSONArray()
        found.values.forEach { result.put(it) }
        return result
    }

    // ── Read ─────────────────────────────────────────────────────────────────

    /**
     * Connect to a known BLE device and read one health service characteristic.
     * service: heart_rate | glucose | cgm | battery | body_composition | running_speed_cadence
     */
    suspend fun readDevice(context: Context, address: String, service: String): JSONObject {
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            ?: return jsonErr("Bluetooth not available")
        val adapter = manager.adapter ?: return jsonErr("Bluetooth adapter null")
        val device  = runCatching { adapter.getRemoteDevice(address) }.getOrNull()
            ?: return jsonErr("Invalid BLE address: $address")

        val (svcUuid, charUuid) = when (service) {
            "heart_rate"            -> HEART_RATE_SERVICE to HEART_RATE_MEAS
            "glucose"               -> GLUCOSE_SERVICE    to GLUCOSE_MEAS
            "cgm"                   -> CGM_SERVICE        to CGM_MEAS
            "battery"               -> BATTERY_SERVICE    to BATTERY_LEVEL
            "body_composition"      -> BODY_COMP_SERVICE  to BODY_COMP_MEAS
            "running_speed_cadence" -> RSC_SERVICE        to RSC_MEAS
            else                    -> return jsonErr("Unknown service: $service")
        }

        val result  = JSONObject()
        val latch   = CountDownLatch(1)
        var gattRef: BluetoothGatt? = null

        val callback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                when (newState) {
                    BluetoothProfile.STATE_CONNECTED    -> g.discoverServices()
                    BluetoothProfile.STATE_DISCONNECTED -> {
                        if (!result.has("error") && result.length() == 0) {
                            result.put("error", "Disconnected before read (status=$status)")
                        }
                        latch.countDown()
                    }
                }
            }

            override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    result.put("error", "Service discovery failed (status=$status)")
                    g.disconnect(); return
                }
                val char = g.getService(svcUuid)?.getCharacteristic(charUuid)
                if (char == null) {
                    result.put("error", "Characteristic not found for service '$service'")
                    g.disconnect(); return
                }
                // Opportunistically read device info characteristics if present
                g.getService(DEVICE_INFO_SERVICE)?.let { di ->
                    di.getCharacteristic(MANUFACTURER_NAME)?.let { g.readCharacteristic(it) }
                    di.getCharacteristic(MODEL_NUMBER)?.let      { g.readCharacteristic(it) }
                }
                g.readCharacteristic(char)
            }

            @Suppress("DEPRECATION")
            override fun onCharacteristicRead(
                g: BluetoothGatt,
                char: BluetoothGattCharacteristic,
                status: Int,
            ) = handleRead(g, char, char.value ?: byteArrayOf(), status)

            override fun onCharacteristicRead(
                g: BluetoothGatt,
                char: BluetoothGattCharacteristic,
                value: ByteArray,
                status: Int,
            ) = handleRead(g, char, value, status)

            private fun handleRead(
                g: BluetoothGatt,
                char: BluetoothGattCharacteristic,
                value: ByteArray,
                status: Int,
            ) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    result.put("error", "GATT read failed (status=$status)")
                    g.disconnect(); latch.countDown(); return
                }
                when (char.uuid) {
                    MANUFACTURER_NAME -> result.put("manufacturer", String(value).trim())
                    MODEL_NUMBER      -> result.put("model",        String(value).trim())
                    BATTERY_LEVEL     -> {
                        result.put("battery_pct", value[0].toInt() and 0xFF)
                        g.disconnect()
                    }
                    HEART_RATE_MEAS   -> { parseHeartRate(value, result); g.disconnect() }
                    GLUCOSE_MEAS,
                    CGM_MEAS          -> { parseCgm(value, service, result); g.disconnect() }
                    BODY_COMP_MEAS    -> { parseBodyComp(value, result); g.disconnect() }
                    RSC_MEAS          -> { parseRsc(value, result); g.disconnect() }
                    else              -> {}  // device_info chars — no disconnect yet
                }
                if (char.uuid == charUuid) latch.countDown()
            }
        }

        val transport = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            BluetoothDevice.TRANSPORT_LE else 0
        gattRef = device.connectGatt(context, false, callback, transport)
        withContext(Dispatchers.IO) { latch.await(GATT_TIMEOUT_MS, TimeUnit.MILLISECONDS) }
        gattRef?.close()

        if (!result.has("error") && result.length() == 0) {
            result.put("error", "Read timed out")
        }
        result.put("address", address)
        result.put("service", service)
        return result
    }

    // ── Parsers ──────────────────────────────────────────────────────────────

    private fun parseHeartRate(value: ByteArray, out: JSONObject) {
        if (value.isEmpty()) { out.put("error", "Empty HR payload"); return }
        val flags  = value[0].toInt() and 0xFF
        val hr16   = (flags and 0x01) != 0
        val bpm    = if (hr16) {
            ((value[2].toInt() and 0xFF) shl 8) or (value[1].toInt() and 0xFF)
        } else {
            value[1].toInt() and 0xFF
        }
        out.put("bpm", bpm)
        // RR intervals → RMSSD (HRV proxy) if present
        val rrPresent = (flags shr 4) and 0x01
        if (rrPresent == 1) {
            val offset = if (hr16) 3 else 2
            val rrs    = mutableListOf<Double>()
            var i      = offset
            while (i + 1 < value.size) {
                val rr = (((value[i + 1].toInt() and 0xFF) shl 8) or (value[i].toInt() and 0xFF))
                rrs += rr / 1024.0 * 1000.0   // 1/1024s units → ms
                i += 2
            }
            if (rrs.isNotEmpty()) {
                val rrArr = org.json.JSONArray(); rrs.forEach { rrArr.put(it) }
                out.put("rr_intervals_ms", rrArr)
                if (rrs.size >= 2) {
                    val diffs  = rrs.zipWithNext { a, b -> (b - a) * (b - a) }
                    val rmssd  = Math.sqrt(diffs.average())
                    out.put("rmssd_ms", rmssd)
                }
            }
        }
    }

    private fun parseCgm(value: ByteArray, service: String, out: JSONObject) {
        val hex = value.joinToString("") { "%02x".format(it) }
        out.put("raw_hex", hex)
        out.put("note", "$service requires device-specific pairing and proprietary decoding")
    }

    private fun parseBodyComp(value: ByteArray, out: JSONObject) {
        if (value.size < 4) { out.put("error", "Body composition payload too short"); return }
        val flags  = ((value[1].toInt() and 0xFF) shl 8) or (value[0].toInt() and 0xFF)
        val unit   = flags and 0x01   // 0 = SI (kg), 1 = imperial (lb)
        val fatRaw = ((value[3].toInt() and 0xFF) shl 8) or (value[2].toInt() and 0xFF)
        out.put("body_fat_pct", fatRaw / 10.0)
        out.put("unit", if (unit == 0) "SI" else "imperial")
    }

    private fun parseRsc(value: ByteArray, out: JSONObject) {
        if (value.size < 4) { out.put("error", "RSC payload too short"); return }
        val flags   = value[0].toInt() and 0xFF
        val speed   = (((value[2].toInt() and 0xFF) shl 8) or (value[1].toInt() and 0xFF)) / 256.0  // m/s
        val cadence = value[3].toInt() and 0xFF   // steps/min
        out.put("speed_m_s",    speed)
        out.put("cadence_spm",  cadence)
        out.put("pace_min_km",  if (speed > 0) (1000.0 / speed / 60.0) else 0.0)
        if ((flags and 0x01) != 0 && value.size >= 6) {
            val stride = (((value[5].toInt() and 0xFF) shl 8) or (value[4].toInt() and 0xFF)) / 100.0  // m
            out.put("stride_length_m", stride)
        }
    }

    private fun jsonErr(msg: String) = JSONObject().apply { put("error", msg) }
}
