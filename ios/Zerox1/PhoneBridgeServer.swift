import Foundation
import Network
import Contacts
import EventKit
import CoreLocation
import AVFoundation
import CoreMotion
import Photos
import CoreTelephony
import CoreBluetooth
import UIKit
import AudioToolbox
import UserNotifications
import CryptoKit
import os.log
#if canImport(HealthKit)
import HealthKit
#endif

/// Lightweight loopback HTTP server on port 9092.
/// Provides ZeroClaw with access to device sensors and data.
/// All endpoints require: Authorization: Bearer <bridgeToken>
final class PhoneBridgeServer: NSObject {

    static let shared = PhoneBridgeServer()

    private let port: UInt16 = 9092
    private var listener: NWListener?
    private var bridgeToken: String = ""
    private let activityLogLock = NSLock()
    private var _activityLog: [[String: String]] = []
    private static let capDefaults: [String: Bool] = [
        "location": true, "contacts": true, "calendar": true,
        "camera": true, "microphone": true, "media": true,
        "health": true, "notifications_read": true, "motion": true,
        "battery": true, "clinical_records": false,
        "tts": true, "live_activity": true, "wearables": false,
    ]
    private var _capabilities: [String: Bool] = {
        var result = capDefaults
        let ud = UserDefaults.standard
        for key in capDefaults.keys {
            let udKey = "zerox1_cap_\(key)"
            if ud.object(forKey: udKey) != nil {
                result[key] = ud.bool(forKey: udKey)
            }
        }
        return result
    }()
    private let locationManager = CLLocationManager()
    private var lastLocation: CLLocation?
    #if canImport(HealthKit)
    private let hkStore = HKHealthStore()
    #endif

    // CoreMotion managers — retained as instance vars to avoid premature dealloc
    private let motionActivityManager = CMMotionActivityManager()
    private let pedometer = CMPedometer()
    private let altimeter = CMAltimeter()

    // AVSpeechSynthesizer retained so speech isn't cut off when the local var is released
    private let speechSynthesizer = AVSpeechSynthesizer()

    // C-1: Connection count limiting
    private var activeConnections = 0
    private let maxConnections = 32

    // H-5: TTS rate limit
    private var lastTtsTime: Date = .distantPast

    // L-1: Battery reading cache
    private var lastBatteryReading: [String: Any]? = nil
    private var lastBatteryReadingTime: Date = .distantPast

    // L-3: Barometer concurrency guard
    private var barometerBusy = false

    // IMU concurrency guard
    private var imuBusy = false

    // CMMotionManager for IMU access
    private let motionManager = CMMotionManager()

    // CBCentralManager retained to keep BT auth state accessible
    private var cbManager: CBCentralManager?

    // MARK: - Start / Stop

    func start(token: String) {
        guard token.count >= 32 else {
            os_log(.error, "PhoneBridgeServer: token too short (%d chars), minimum 32 required", token.count)
            return
        }
        bridgeToken = token
        locationManager.delegate = self
        // Build NWParameters with loopback constraint BEFORE constructing the listener.
        // Setting requiredInterfaceType on listener?.parameters after construction is ignored
        // and falls back to binding on all interfaces — a security regression.
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        listener = try? NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        listener?.newConnectionHandler = { [weak self] conn in
            self?.handleConnection(conn)
        }
        listener?.start(queue: .global(qos: .utility))
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    // MARK: - Capabilities

    var capabilities: [String: Bool] { _capabilities }

    func setCapability(_ cap: String, enabled: Bool) {
        _capabilities[cap] = enabled
        UserDefaults.standard.set(enabled, forKey: "zerox1_cap_\(cap)")
    }

    func activityLog(limit: Int) -> String {
        activityLogLock.lock()
        defer { activityLogLock.unlock() }
        let slice = Array(_activityLog.prefix(limit))
        let data = (try? JSONSerialization.data(withJSONObject: slice)) ?? Data()
        return String(data: data, encoding: .utf8) ?? "[]"
    }

    private func logActivity(capability: String, action: String, outcome: String) {
        activityLogLock.lock()
        defer { activityLogLock.unlock() }
        let entry: [String: String] = [
            "time": ISO8601DateFormatter().string(from: Date()),
            "capability": capability,
            "action": action,
            "outcome": outcome,
        ]
        _activityLog.insert(entry, at: 0)
        if _activityLog.count > 200 { _activityLog.removeLast() }
    }

    // MARK: - Screen action pending map

    func resolveScreenAction(id: String, approved: Bool) {
        // Screen actions not implemented on iOS
    }

    // MARK: - HTTP connection handling

    private func handleConnection(_ conn: NWConnection) {
        // C-2: Enforce loopback-only connections
        if case .hostPort(let host, _) = conn.endpoint {
            let hostStr = "\(host)"
            let isLoopback = hostStr == "127.0.0.1" || hostStr == "::1" || hostStr.hasSuffix("localhost")
            if !isLoopback {
                conn.cancel()
                return
            }
        }

        // C-1: Enforce connection count limit
        guard activeConnections < maxConnections else {
            conn.cancel()
            return
        }
        activeConnections += 1

        // C-1: Per-connection 30-second timeout
        let timeoutItem = DispatchWorkItem { conn.cancel() }
        DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: timeoutItem)

        conn.stateUpdateHandler = { [weak self] state in
            switch state {
            case .cancelled, .failed:
                self?.activeConnections -= 1
            default:
                break
            }
        }

        conn.start(queue: .global(qos: .utility))
        receiveRequest(conn: conn, timeoutItem: timeoutItem)
    }

    private func receiveRequest(conn: NWConnection, timeoutItem: DispatchWorkItem? = nil) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, err in
            guard let self, let data, !data.isEmpty else { return }
            timeoutItem?.cancel()
            let raw = String(data: data, encoding: .utf8) ?? ""
            self.processHTTP(raw: raw, conn: conn)
        }
    }

    private func processHTTP(raw: String, conn: NWConnection) {
        let lines = raw.components(separatedBy: "\r\n")
        guard let reqLine = lines.first else { sendResponse(conn: conn, status: 400, body: "{}"); return }
        let parts = reqLine.split(separator: " ")
        guard parts.count >= 2 else { sendResponse(conn: conn, status: 400, body: "{}"); return }

        let method = String(parts[0])
        let fullPath = String(parts[1])
        let path = fullPath.components(separatedBy: "?")[0]
        let queryString = fullPath.contains("?") ? String(fullPath.dropFirst(path.count + 1)) : ""

        // M-1: Reject chunked transfer encoding
        if lines.contains(where: { $0.lowercased().contains("transfer-encoding: chunked") }) {
            sendResponse(conn: conn, status: 400, body: "{\"error\":\"chunked encoding not supported\"}")
            return
        }
        // M-1: Enforce Content-Length cap (64 KB)
        if let clLine = lines.first(where: { $0.lowercased().hasPrefix("content-length:") }) {
            let clStr = clLine.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)
            if let cl = Int(clStr), cl > 65536 {
                sendResponse(conn: conn, status: 413, body: "{\"error\":\"payload too large\"}")
                return
            }
        }

        // Auth check — constant-time comparison to prevent timing-based token oracle attacks.
        // M-5: Use prefix strip instead of replacingOccurrences to avoid partial-match injection.
        let authLine = lines.first(where: { $0.lowercased().hasPrefix("authorization:") }) ?? ""
        let prefix = "authorization: bearer "
        let lowerLine = authLine.lowercased()
        let token: String
        if lowerLine.hasPrefix(prefix) {
            token = String(authLine.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
        } else {
            token = ""
        }
        guard timingSafeEqual(token, bridgeToken) else {
            sendResponse(conn: conn, status: 401, body: #"{"error":"unauthorized"}"#)
            return
        }

        // Body
        let bodyMarker = raw.range(of: "\r\n\r\n")
        let body = bodyMarker.map { String(raw[raw.index($0.upperBound, offsetBy: 0)...]) } ?? ""

        route(method: method, path: path, queryString: queryString, body: body, conn: conn)
    }

    // MARK: - Query string parsing helper

    private func queryParams(_ qs: String) -> [String: String] {
        var result: [String: String] = [:]
        for pair in qs.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            if kv.count == 2 {
                let key = String(kv[0]).removingPercentEncoding ?? String(kv[0])
                let val = String(kv[1]).removingPercentEncoding ?? String(kv[1])
                result[key] = val
            }
        }
        return result
    }

    private func route(method: String, path: String, queryString: String, body: String, conn: NWConnection) {
        switch path {

        // ── Health ──────────────────────────────────────────────────────────
        case "/health":
            sendJSON(conn: conn, obj: ["status": "ok", "platform": "ios"])

        // ── Location ────────────────────────────────────────────────────────
        case "/location":
            guard _capabilities["location"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"])
                return
            }
            if let loc = lastLocation {
                logActivity(capability: "location", action: "read", outcome: "ok")
                sendJSON(conn: conn, obj: [
                    "latitude": loc.coordinate.latitude,
                    "longitude": loc.coordinate.longitude,
                    "accuracy": loc.horizontalAccuracy,
                    "timestamp": loc.timestamp.timeIntervalSince1970,
                ])
            } else {
                // L-2: Location auth must be requested on the main thread
                DispatchQueue.main.async {
                    self.locationManager.requestWhenInUseAuthorization()
                    self.locationManager.requestLocation()
                }
                sendJSON(conn: conn, obj: ["error": "location unavailable"])
            }

        // ── Contacts ────────────────────────────────────────────────────────
        case "/contacts":
            guard _capabilities["contacts"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"])
                return
            }
            let qp = queryParams(queryString)
            // H-4: Pagination support
            let limit = min(Int(qp["limit"] ?? "100") ?? 100, 500)
            let offset = Int(qp["offset"] ?? "0") ?? 0
            let store = CNContactStore()
            let keys = [CNContactGivenNameKey, CNContactFamilyNameKey,
                        CNContactPhoneNumbersKey, CNContactEmailAddressesKey] as [CNKeyDescriptor]
            let req = CNContactFetchRequest(keysToFetch: keys)
            var contacts: [[String: Any]] = []
            var idx = 0
            try? store.enumerateContacts(with: req) { contact, stop in
                if contacts.count >= limit { stop.pointee = true; return }
                if idx < offset { idx += 1; return }
                contacts.append([
                    "name": "\(contact.givenName) \(contact.familyName)".trimmingCharacters(in: .whitespaces),
                    "phones": contact.phoneNumbers.map { $0.value.stringValue },
                    "emails": contact.emailAddresses.map { $0.value as String },
                ])
                idx += 1
            }
            logActivity(capability: "contacts", action: "read", outcome: "\(contacts.count) contacts")
            sendJSON(conn: conn, obj: ["contacts": contacts, "count": contacts.count, "limit": limit, "offset": offset])

        // ── Calendar ────────────────────────────────────────────────────────
        case "/calendar":
            guard _capabilities["calendar"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"])
                return
            }
            let ekStore = EKEventStore()
            let start = Date()
            let end = Calendar.current.date(byAdding: .day, value: 7, to: start)!
            let pred = ekStore.predicateForEvents(withStart: start, end: end, calendars: nil)
            let events = ekStore.events(matching: pred).prefix(50).map { ev -> [String: Any] in
                [
                    "title": ev.title ?? "",
                    "start": ev.startDate.timeIntervalSince1970,
                    "end": ev.endDate.timeIntervalSince1970,
                    "location": ev.location ?? "",
                    "notes": ev.notes ?? "",
                ]
            }
            logActivity(capability: "calendar", action: "read", outcome: "\(events.count) events")
            sendJSON(conn: conn, obj: ["events": Array(events)])

        // ── Battery ─────────────────────────────────────────────────────────
        case "/battery":
            // L-1: Capability gate
            guard _capabilities["battery"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403)
                return
            }
            // L-1: 60-second cache
            if let cached = lastBatteryReading, Date().timeIntervalSince(lastBatteryReadingTime) < 60 {
                sendJSON(conn: conn, obj: cached)
            } else {
                UIDevice.current.isBatteryMonitoringEnabled = true
                let level = UIDevice.current.batteryLevel
                let charging = UIDevice.current.batteryState == .charging || UIDevice.current.batteryState == .full
                let reading: [String: Any] = [
                    "level": level >= 0 ? Int(level * 100) : -1,
                    "charging": charging,
                ]
                lastBatteryReading = reading
                lastBatteryReadingTime = Date()
                sendJSON(conn: conn, obj: reading)
            }

        // ── Health (HealthKit) ───────────────────────────────────────────────
        #if canImport(HealthKit)
        case "/health/steps":
            guard _capabilities["health"] == true else {
                sendJSON(conn: conn, obj: ["error": "health capability disabled"])
                return
            }
            readSteps(conn: conn)

        case "/health/heart_rate":
            guard _capabilities["health"] == true else {
                sendJSON(conn: conn, obj: ["error": "health capability disabled"])
                return
            }
            fetchLatestQuantity(conn: conn, typeId: .heartRate,
                                unit: HKUnit(from: "count/min"), key: "bpm",
                                action: "read_heart_rate")

        case "/health/hrv":
            guard _capabilities["health"] == true else {
                sendJSON(conn: conn, obj: ["error": "health capability disabled"])
                return
            }
            fetchLatestQuantity(conn: conn, typeId: .heartRateVariabilitySDNN,
                                unit: HKUnit.secondUnit(with: .milli), key: "hrv_ms",
                                action: "read_hrv")

        case "/health/blood_oxygen":
            guard _capabilities["health"] == true else {
                sendJSON(conn: conn, obj: ["error": "health capability disabled"])
                return
            }
            fetchLatestQuantity(conn: conn, typeId: .oxygenSaturation,
                                unit: HKUnit.percent(), key: "spo2_pct",
                                action: "read_blood_oxygen",
                                transform: { $0 * 100.0 })

        case "/health/sleep":
            guard _capabilities["health"] == true else {
                sendJSON(conn: conn, obj: ["error": "health capability disabled"])
                return
            }
            readSleep(conn: conn)

        case "/health/active_energy":
            guard _capabilities["health"] == true else {
                sendJSON(conn: conn, obj: ["error": "health capability disabled"])
                return
            }
            fetchTodaySum(conn: conn, typeId: .activeEnergyBurned,
                          unit: HKUnit.kilocalorie(), key: "kcal",
                          action: "read_active_energy")

        case "/health/summary":
            guard _capabilities["health"] == true else {
                sendJSON(conn: conn, obj: ["error": "health capability disabled"])
                return
            }
            readHealthSummary(conn: conn)

        // ── HealthKit expansion ──────────────────────────────────────────────

        case "/phone/health/workout_routes":
            guard _capabilities["health"] == true else {
                sendJSON(conn: conn, obj: ["error": "health capability disabled"])
                return
            }
            let qp = queryParams(queryString)
            let days = min(Int(qp["days"] ?? "7") ?? 7, 90)  // H-1
            readWorkoutRoutes(conn: conn, days: days)

        case "/phone/health/mindfulness":
            guard _capabilities["health"] == true else {
                sendJSON(conn: conn, obj: ["error": "health capability disabled"])
                return
            }
            let qp = queryParams(queryString)
            let days = min(Int(qp["days"] ?? "30") ?? 30, 90)  // H-1
            readMindfulness(conn: conn, days: days)

        case "/phone/health/blood_glucose":
            guard _capabilities["health"] == true else {
                sendJSON(conn: conn, obj: ["error": "health capability disabled"])
                return
            }
            let qp = queryParams(queryString)
            let days = min(Int(qp["days"] ?? "30") ?? 30, 90)  // H-1
            readBloodGlucose(conn: conn, days: days)

        case "/phone/health/clinical_records":
            // H-2: Require both health AND clinical_records capability
            guard _capabilities["health"] == true && _capabilities["clinical_records"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403)
                return
            }
            let qp = queryParams(queryString)
            // M-2: Sanitize type param
            let rawType = qp["type"] ?? "allergy"
            let safeType: String
            switch rawType {
            case "lab": safeType = "lab"
            case "medication": safeType = "medication"
            default: safeType = "allergy"
            }
            readClinicalRecords(conn: conn, type: safeType)
        #endif

        // ── Calendar Write ───────────────────────────────────────────────────
        case "/phone/calendar/create":
            guard method == "POST" else {
                sendResponse(conn: conn, status: 405, body: #"{"error":"method not allowed"}"#)
                return
            }
            guard _capabilities["calendar"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"])
                return
            }
            createCalendarEvent(conn: conn, body: body)

        // ── Contacts Write ───────────────────────────────────────────────────
        case "/phone/contacts/create":
            guard method == "POST" else {
                sendResponse(conn: conn, status: 405, body: #"{"error":"method not allowed"}"#)
                return
            }
            guard _capabilities["contacts"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"])
                return
            }
            createContact(conn: conn, body: body)

        // ── Motion ──────────────────────────────────────────────────────────
        case "/phone/motion/activity":
            guard _capabilities["motion"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"])
                return
            }
            readMotionActivity(conn: conn)

        case "/phone/motion/pedometer":
            guard _capabilities["motion"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"])
                return
            }
            let qp = queryParams(queryString)
            let hours = Double(min(Int(qp["hours"] ?? "24") ?? 24, 168))  // H-1
            readPedometer(conn: conn, hours: hours)

        case "/phone/motion/barometer":
            guard _capabilities["motion"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"])
                return
            }
            readBarometer(conn: conn)

        // ── TTS ─────────────────────────────────────────────────────────────
        case "/phone/tts/speak", "/phone/tts":
            guard method == "POST" else {
                sendResponse(conn: conn, status: 405, body: #"{"error":"method not allowed"}"#)
                return
            }
            guard _capabilities["tts"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            speakText(conn: conn, body: body)

        // ── /phone/ prefixed routes zeroclaw calls ───────────────────────────

        case "/phone/location":
            guard _capabilities["location"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            if let loc = lastLocation {
                logActivity(capability: "location", action: "read", outcome: "ok")
                sendJSON(conn: conn, obj: [
                    "latitude": loc.coordinate.latitude,
                    "longitude": loc.coordinate.longitude,
                    "accuracy": loc.horizontalAccuracy,
                    "timestamp": loc.timestamp.timeIntervalSince1970,
                ])
            } else {
                DispatchQueue.main.async {
                    self.locationManager.requestWhenInUseAuthorization()
                    self.locationManager.requestLocation()
                }
                sendJSON(conn: conn, obj: ["error": "location unavailable, requesting permission"])
            }

        case "/phone/contacts":
            guard _capabilities["contacts"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            if method == "POST" {
                createContact(conn: conn, body: body)
            } else {
                let qp = queryParams(queryString)
                let query = qp["query"] ?? ""
                let limit = min(Int(qp["limit"] ?? "100") ?? 100, 500)
                let offset = Int(qp["offset"] ?? "0") ?? 0
                let store = CNContactStore()
                let keys = [CNContactGivenNameKey, CNContactFamilyNameKey,
                            CNContactPhoneNumbersKey, CNContactEmailAddressesKey,
                            CNContactIdentifierKey] as [CNKeyDescriptor]
                let req = CNContactFetchRequest(keysToFetch: keys)
                var contacts: [[String: Any]] = []
                var idx = 0
                try? store.enumerateContacts(with: req) { contact, stop in
                    if contacts.count >= limit { stop.pointee = true; return }
                    let name = "\(contact.givenName) \(contact.familyName)"
                        .trimmingCharacters(in: .whitespaces)
                    if !query.isEmpty {
                        let q = query.lowercased()
                        let matches = name.lowercased().contains(q)
                            || contact.phoneNumbers.contains { $0.value.stringValue.contains(q) }
                            || contact.emailAddresses.contains { ($0.value as String).lowercased().contains(q) }
                        if !matches { return }
                    }
                    if idx < offset { idx += 1; return }
                    contacts.append([
                        "id": contact.identifier,
                        "name": name,
                        "phones": contact.phoneNumbers.map { $0.value.stringValue },
                        "emails": contact.emailAddresses.map { $0.value as String },
                    ])
                    idx += 1
                }
                logActivity(capability: "contacts", action: "read", outcome: "\(contacts.count) contacts")
                sendJSON(conn: conn, obj: ["contacts": contacts, "count": contacts.count,
                                          "limit": limit, "offset": offset])
            }

        case "/phone/calendar":
            guard _capabilities["calendar"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            if method == "POST" {
                createCalendarEvent(conn: conn, body: body)
            } else {
                let qp = queryParams(queryString)
                let days = min(max(Int(qp["days"] ?? "7") ?? 7, 1), 90)
                let ekStore = EKEventStore()
                let start = Date()
                let end = Calendar.current.date(byAdding: .day, value: days, to: start)!
                let pred = ekStore.predicateForEvents(withStart: start, end: end, calendars: nil)
                let events = ekStore.events(matching: pred).prefix(100).map { ev -> [String: Any] in [
                    "id":       ev.eventIdentifier ?? "",
                    "title":    ev.title ?? "",
                    "start":    ev.startDate.timeIntervalSince1970,
                    "end":      ev.endDate.timeIntervalSince1970,
                    "location": ev.location ?? "",
                    "notes":    ev.notes ?? "",
                    "all_day":  ev.isAllDay,
                ]}
                logActivity(capability: "calendar", action: "read", outcome: "\(events.count) events")
                sendJSON(conn: conn, obj: ["events": Array(events)])
            }

        case "/phone/battery":
            guard _capabilities["battery"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            if let cached = lastBatteryReading, Date().timeIntervalSince(lastBatteryReadingTime) < 60 {
                sendJSON(conn: conn, obj: cached)
            } else {
                UIDevice.current.isBatteryMonitoringEnabled = true
                let level = UIDevice.current.batteryLevel
                let charging = UIDevice.current.batteryState == .charging
                    || UIDevice.current.batteryState == .full
                let reading: [String: Any] = ["level": level >= 0 ? Int(level * 100) : -1,
                                              "charging": charging]
                lastBatteryReading = reading
                lastBatteryReadingTime = Date()
                sendJSON(conn: conn, obj: reading)
            }

        case "/phone/device":
            let device = UIDevice.current
            device.isBatteryMonitoringEnabled = true
            sendJSON(conn: conn, obj: [
                "model":          device.model,
                "name":           device.name,
                "system_name":    device.systemName,
                "system_version": device.systemVersion,
                "battery_level":  device.batteryLevel >= 0 ? Int(device.batteryLevel * 100) : -1,
                "charging":       device.batteryState == .charging || device.batteryState == .full,
                "platform":       "ios",
            ])

        case "/phone/network":
            let monitor = NWPathMonitor()
            let sema = DispatchSemaphore(value: 0)
            var netResult: [String: Any] = ["connected": false, "wifi": false, "cellular": false]
            monitor.pathUpdateHandler = { path in
                netResult["connected"] = path.status == .satisfied
                netResult["wifi"]      = path.usesInterfaceType(.wifi)
                netResult["cellular"]  = path.usesInterfaceType(.cellular)
                sema.signal()
            }
            monitor.start(queue: .global())
            _ = sema.wait(timeout: .now() + 2)
            monitor.cancel()
            sendJSON(conn: conn, obj: netResult)

        case "/phone/activity":
            guard _capabilities["motion"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            guard CMPedometer.isStepCountingAvailable() else {
                sendJSON(conn: conn, obj: ["error": "step counting not available"]); return
            }
            let actStart = Calendar.current.startOfDay(for: Date())
            pedometer.queryPedometerData(from: actStart, to: Date()) { [weak self] data, error in
                guard let self else { return }
                if let error { sendJSON(conn: conn, obj: ["error": error.localizedDescription]); return }
                guard let data else { sendJSON(conn: conn, obj: ["error": "no data"]); return }
                logActivity(capability: "motion", action: "read_activity", outcome: "ok")
                sendJSON(conn: conn, obj: [
                    "steps":         data.numberOfSteps.intValue,
                    "distance_m":    data.distance?.doubleValue ?? 0.0,
                    "active_time_s": (data.endDate.timeIntervalSince(data.startDate)),
                ])
            }

        case "/phone/timezone":
            let tz = TimeZone.current
            sendJSON(conn: conn, obj: [
                "timezone_id":     tz.identifier,
                "abbreviation":    tz.abbreviation() ?? "",
                "utc_offset_secs": tz.secondsFromGMT(),
            ])

        case "/phone/media/images":
            guard _capabilities["media"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            let qp = queryParams(queryString)
            let imgLimit = min(Int(qp["limit"] ?? "20") ?? 20, 100)
            let authStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
            guard authStatus == .authorized || authStatus == .limited else {
                PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] _ in
                    self?.sendJSON(conn: conn, obj: ["error": "photos access not granted"])
                }
                return
            }
            let fetchOptions = PHFetchOptions()
            fetchOptions.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            fetchOptions.fetchLimit = imgLimit
            let assets = PHAsset.fetchAssets(with: .image, options: fetchOptions)
            var images: [[String: Any]] = []
            assets.enumerateObjects { asset, _, _ in
                var entry: [String: Any] = [
                    "local_id":    asset.localIdentifier,
                    "width":       asset.pixelWidth,
                    "height":      asset.pixelHeight,
                    "is_favorite": asset.isFavorite,
                ]
                if let date = asset.creationDate {
                    entry["created_at"] = ISO8601DateFormatter().string(from: date)
                }
                images.append(entry)
            }
            logActivity(capability: "media", action: "read_images", outcome: "\(images.count) images")
            sendJSON(conn: conn, obj: ["images": images, "count": images.count])

        case "/phone/bluetooth":
            let btAuth = CBCentralManager.authorization
            let btStatus: String
            switch btAuth {
            case .allowedAlways:  btStatus = "authorized"
            case .denied:         btStatus = "denied"
            case .restricted:     btStatus = "restricted"
            case .notDetermined:  btStatus = "not_determined"
            @unknown default:     btStatus = "unknown"
            }
            sendJSON(conn: conn, obj: ["status": btStatus, "available": btAuth == .allowedAlways])

        case "/phone/wifi":
            let wifiMonitor = NWPathMonitor(requiredInterfaceType: .wifi)
            let wifiSema = DispatchSemaphore(value: 0)
            var wifiResult: [String: Any] = ["connected": false]
            wifiMonitor.pathUpdateHandler = { path in
                wifiResult["connected"] = path.status == .satisfied
                wifiSema.signal()
            }
            wifiMonitor.start(queue: .global())
            _ = wifiSema.wait(timeout: .now() + 2)
            wifiMonitor.cancel()
            sendJSON(conn: conn, obj: wifiResult)

        case "/phone/carrier":
            let info = CTTelephonyNetworkInfo()
            var carrierResult: [String: Any] = ["available": false]
            if let carriers = info.serviceSubscriberCellularProviders {
                let names = carriers.values.compactMap { $0.carrierName }.filter { !$0.isEmpty }
                if let first = names.first {
                    carrierResult["available"]    = true
                    carrierResult["carrier_name"] = first
                }
            }
            sendJSON(conn: conn, obj: carrierResult)

        case "/phone/notifications":
            guard _capabilities["notifications_read"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            UNUserNotificationCenter.current().getPendingNotificationRequests { [weak self] requests in
                guard let self else { return }
                let items = requests.prefix(50).map { req -> [String: Any] in
                    var item: [String: Any] = ["id": req.identifier,
                                               "title": req.content.title,
                                               "body":  req.content.body]
                    if let t = req.trigger as? UNTimeIntervalNotificationTrigger {
                        item["fires_in_secs"] = t.timeInterval
                    }
                    return item
                }
                logActivity(capability: "notifications", action: "list_pending",
                            outcome: "\(items.count)")
                sendJSON(conn: conn, obj: ["notifications": Array(items), "count": items.count])
            }

        case "/phone/notifications/history":
            guard _capabilities["notifications_read"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            let histQp = queryParams(queryString)
            let histLimit = min(Int(histQp["limit"] ?? "50") ?? 50, 200)
            UNUserNotificationCenter.current().getDeliveredNotifications { [weak self] notifications in
                guard let self else { return }
                let items = notifications.prefix(histLimit).map { n -> [String: Any] in [
                    "id":           n.request.identifier,
                    "title":        n.request.content.title,
                    "body":         n.request.content.body,
                    "delivered_at": ISO8601DateFormatter().string(from: n.date),
                ]}
                logActivity(capability: "notifications", action: "list_delivered",
                            outcome: "\(items.count)")
                sendJSON(conn: conn, obj: ["notifications": Array(items), "count": items.count])
            }

        case "/phone/wearables/scan":
            guard _capabilities["wearables"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            sendJSON(conn: conn, obj: ["devices": [],
                                       "note": "BLE scan not supported via bridge; check /phone/bluetooth"])

        case "/phone/wearables/read":
            guard _capabilities["wearables"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            sendResponse(conn: conn, status: 501,
                         body: #"{"error":"BLE characteristic read not supported via bridge"}"#)

        // ── Camera ──────────────────────────────────────────────────────────
        case "/phone/camera":
            guard method == "POST" else {
                sendResponse(conn: conn, status: 405, body: #"{"error":"method not allowed"}"#); return
            }
            guard _capabilities["camera"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
                sendJSON(conn: conn, obj: ["error": "camera access not granted"]); return
            }
            capturePhoto(conn: conn, body: body)

        // ── Microphone ───────────────────────────────────────────────────────
        case "/phone/microphone/record":
            guard method == "POST" else {
                sendResponse(conn: conn, status: 405, body: #"{"error":"method not allowed"}"#); return
            }
            guard _capabilities["microphone"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
                sendJSON(conn: conn, obj: ["error": "microphone access not granted"]); return
            }
            recordAudio(conn: conn, body: body)

        case "/phone/recovery":
            sendJSON(conn: conn, obj: ["status": "ok", "platform": "ios"])

        #if canImport(HealthKit)
        case "/phone/health":
            guard _capabilities["health"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            readHealthUnified(conn: conn, queryString: queryString)
        #endif

        // ── Context aggregate ────────────────────────────────────────────────
        case "/phone/context":
            phoneContext(conn: conn)

        // ── Clipboard ────────────────────────────────────────────────────────
        case "/phone/clipboard":
            phoneClipboard(conn: conn, method: method, body: body)

        // ── Vibrate ──────────────────────────────────────────────────────────
        case "/phone/vibrate":
            guard method == "POST" else {
                sendResponse(conn: conn, status: 405, body: #"{"error":"method not allowed"}"#); return
            }
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
            logActivity(capability: "tts", action: "vibrate", outcome: "ok")
            sendJSON(conn: conn, obj: ["vibrated": true])

        // ── Schedule local notification ──────────────────────────────────────
        case "/phone/notify":
            guard method == "POST" else {
                sendResponse(conn: conn, status: 405, body: #"{"error":"method not allowed"}"#); return
            }
            guard _capabilities["notifications_read"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            scheduleLocalNotification(conn: conn, body: body)

        // ── Dismiss notifications ────────────────────────────────────────────
        case "/phone/notifications/dismiss":
            guard method == "POST" else {
                sendResponse(conn: conn, status: 405, body: #"{"error":"method not allowed"}"#); return
            }
            guard _capabilities["notifications_read"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            dismissNotifications(conn: conn, body: body)

        // ── IMU snapshot ─────────────────────────────────────────────────────
        case "/phone/imu":
            guard _capabilities["motion"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            readImuSnapshot(conn: conn)

        // ── IMU record ───────────────────────────────────────────────────────
        case "/phone/imu/record":
            guard method == "POST" else {
                sendResponse(conn: conn, status: 405, body: #"{"error":"method not allowed"}"#); return
            }
            guard _capabilities["motion"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            recordImu(conn: conn, body: body)

        // ── Emergency relay ──────────────────────────────────────────────────
        // POST — fire emergency alert to contacts via aggregator SMS relay.
        // Reads emergency contacts and agent_id from UserDefaults automatically.
        // The ZeroClaw safety skill calls this after the 30-second confirmation
        // window expires with no cancel tap.
        case "/phone/emergency/relay":
            guard method == "POST" else {
                sendResponse(conn: conn, status: 405, body: #"{"error":"method not allowed"}"#); return
            }
            fireEmergencyRelay(conn: conn, body: body)

        // ── Emergency contacts read ──────────────────────────────────────────
        case "/phone/emergency/contacts":
            let contactsJson = UserDefaults.standard.string(forKey: "zerox1_emergency_contacts") ?? "[]"
            let safetyEnabled = UserDefaults.standard.bool(forKey: "zerox1_safety_enabled")
            sendJSON(conn: conn, obj: [
                "contacts":        contactsJson,
                "safety_enabled":  safetyEnabled,
            ])

        // ── Fall check (battery-efficient) ──────────────────────────────────
        // Does NOT run the accelerometer if the motion activity manager reports
        // the user is running, cycling, or in a vehicle — situations where
        // continuous IMU would drain battery and produce false positives.
        // Returns next_check_secs so the caller can back off adaptively.
        case "/phone/imu/fall_check":
            guard _capabilities["motion"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403); return
            }
            fallCheck(conn: conn)

        // ── Permissions summary ──────────────────────────────────────────────
        case "/phone/permissions":
            readPermissions(conn: conn)

        // ── Audio profile ────────────────────────────────────────────────────
        case "/phone/audio/profile":
            if method == "POST" {
                setAudioProfile(conn: conn, body: body)
            } else {
                readAudioProfile(conn: conn)
            }

        // ── Activity log ─────────────────────────────────────────────────────
        case "/phone/activity_log":
            let qp = queryParams(queryString)
            let logLimit = min(Int(qp["limit"] ?? "50") ?? 50, 200)
            sendResponse(conn: conn, status: 200, body: activityLog(limit: logLimit))

        default:
            // Dynamic PATCH routes for contacts and calendar updates
            if path.hasPrefix("/phone/contacts/") && method == "PATCH" {
                guard _capabilities["contacts"] == true else {
                    sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403)
                    return
                }
                let contactId = String(path.dropFirst("/phone/contacts/".count))
                    .removingPercentEncoding ?? ""
                updateContact(conn: conn, contactId: contactId, body: body)
            } else if path.hasPrefix("/phone/calendar/") && method == "PATCH" {
                guard _capabilities["calendar"] == true else {
                    sendJSON(conn: conn, obj: ["error": "capability disabled"], status: 403)
                    return
                }
                let eventId = String(path.dropFirst("/phone/calendar/".count))
                    .removingPercentEncoding ?? ""
                updateCalendarEvent(conn: conn, eventId: eventId, body: body)
            } else {
                sendResponse(conn: conn, status: 404, body: #"{"error":"not found"}"#)
            }
        }
    }

    // MARK: - Calendar Write

    private func createCalendarEvent(conn: NWConnection, body: String) {
        guard let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            sendJSON(conn: conn, obj: ["error": "missing required field: title"])
            return
        }
        // H-6: Field length limits
        let title = String((json["title"] as? String ?? "Untitled").prefix(200))
        let notes = String((json["notes"] as? String ?? "").prefix(4000))
        let location = String((json["location"] as? String ?? "").prefix(200))

        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let isoBasic = ISO8601DateFormatter()

        func parseDate(_ key: String) -> Date? {
            guard let s = json[key] as? String else { return nil }
            return iso.date(from: s) ?? isoBasic.date(from: s)
        }

        guard let startDate = parseDate("start_date"),
              let endDate = parseDate("end_date") else {
            sendJSON(conn: conn, obj: ["error": "missing or invalid start_date/end_date (ISO8601 required)"])
            return
        }

        let ekStore = EKEventStore()
        let requestAccess: (@escaping (Bool, Error?) -> Void) -> Void
        if #available(iOS 17.0, *) {
            requestAccess = { handler in ekStore.requestFullAccessToEvents(completion: handler) }
        } else {
            requestAccess = { handler in ekStore.requestAccess(to: .event, completion: handler) }
        }

        requestAccess { [weak self] granted, _ in
            guard let self else { return }
            guard granted else {
                self.sendJSON(conn: conn, obj: ["error": "calendar access not granted"])
                return
            }
            let event = EKEvent(eventStore: ekStore)
            event.title     = title
            event.startDate = startDate
            event.endDate   = endDate
            event.notes     = notes.isEmpty ? nil : notes
            event.location  = location.isEmpty ? nil : location
            event.isAllDay  = json["all_day"] as? Bool ?? false
            event.calendar  = ekStore.defaultCalendarForNewEvents

            do {
                try ekStore.save(event, span: .thisEvent)
                self.logActivity(capability: "calendar", action: "create", outcome: "ok")
                self.sendJSON(conn: conn, obj: ["event_id": event.eventIdentifier ?? ""])
            } catch {
                self.sendJSON(conn: conn, obj: ["error": error.localizedDescription])
            }
        }
    }

    // MARK: - Contacts Write

    private func createContact(conn: NWConnection, body: String) {
        guard let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            sendJSON(conn: conn, obj: ["error": "invalid JSON body"])
            return
        }

        let contactStore = CNContactStore()
        contactStore.requestAccess(for: .contacts) { [weak self] granted, _ in
            guard let self else { return }
            guard granted else {
                self.sendJSON(conn: conn, obj: ["error": "contacts access not granted"])
                return
            }

            // H-6: Field length limits
            let givenName  = String((json["given_name"]   as? String ?? "").prefix(100))
            let familyName = String((json["family_name"]  as? String ?? "").prefix(100))
            let org        = String((json["organization"] as? String ?? "").prefix(200))
            let phone      = String((json["phone"]        as? String ?? "").prefix(30))
            let email      = String((json["email"]        as? String ?? "").prefix(254))

            let contact = CNMutableContact()
            contact.givenName        = givenName
            contact.familyName       = familyName
            contact.organizationName = org

            if !phone.isEmpty {
                contact.phoneNumbers = [
                    CNLabeledValue(label: CNLabelPhoneNumberMain,
                                  value: CNPhoneNumber(stringValue: phone))
                ]
            }
            if !email.isEmpty {
                contact.emailAddresses = [
                    CNLabeledValue(label: CNLabelWork,
                                  value: email as NSString)
                ]
            }

            let saveRequest = CNSaveRequest()
            saveRequest.add(contact, toContainerWithIdentifier: nil)

            do {
                try contactStore.execute(saveRequest)
                self.logActivity(capability: "contacts", action: "create", outcome: "ok")
                self.sendJSON(conn: conn, obj: ["contact_id": contact.identifier])
            } catch {
                self.sendJSON(conn: conn, obj: ["error": error.localizedDescription])
            }
        }
    }

    // MARK: - CoreMotion: Activity

    private func readMotionActivity(conn: NWConnection) {
        guard CMMotionActivityManager.isActivityAvailable() else {
            sendJSON(conn: conn, obj: ["error": "motion activity not available on this device"])
            return
        }
        let start = Date(timeIntervalSinceNow: -60)
        motionActivityManager.queryActivityStarting(from: start, to: Date(), to: .main) { [weak self] activities, error in
            guard let self else { return }
            if let error {
                self.sendJSON(conn: conn, obj: ["error": error.localizedDescription])
                return
            }
            // Use the most recent activity
            guard let activity = activities?.last else {
                self.sendJSON(conn: conn, obj: ["error": "no activity data"])
                return
            }
            let confidence: String
            switch activity.confidence {
            case .low:    confidence = "low"
            case .medium: confidence = "medium"
            case .high:   confidence = "high"
            @unknown default: confidence = "unknown"
            }
            self.logActivity(capability: "motion", action: "read_activity", outcome: "ok")
            self.sendJSON(conn: conn, obj: [
                "stationary":  activity.stationary,
                "walking":     activity.walking,
                "running":     activity.running,
                "cycling":     activity.cycling,
                "automotive":  activity.automotive,
                "confidence":  confidence,
            ])
        }
    }

    // MARK: - CoreMotion: Pedometer

    private func readPedometer(conn: NWConnection, hours: Double) {
        guard CMPedometer.isStepCountingAvailable() else {
            sendJSON(conn: conn, obj: ["error": "step counting not available on this device"])
            return
        }
        let start = Date(timeIntervalSinceNow: -hours * 3600)
        pedometer.queryPedometerData(from: start, to: Date()) { [weak self] pedometerData, error in
            guard let self else { return }
            if let error {
                self.sendJSON(conn: conn, obj: ["error": error.localizedDescription])
                return
            }
            guard let data = pedometerData else {
                self.sendJSON(conn: conn, obj: ["error": "no pedometer data"])
                return
            }
            self.logActivity(capability: "motion", action: "read_pedometer", outcome: "ok")
            var result: [String: Any] = [
                "steps":      data.numberOfSteps.intValue,
                "distance_m": data.distance?.doubleValue ?? 0.0,
            ]
            if CMPedometer.isFloorCountingAvailable() {
                result["floors_ascended"]  = data.floorsAscended?.intValue ?? 0
                result["floors_descended"] = data.floorsDescended?.intValue ?? 0
            }
            if CMPedometer.isPaceAvailable() {
                result["active_time_s"] = data.endDate.timeIntervalSince(data.startDate)
            }
            self.sendJSON(conn: conn, obj: result)
        }
    }

    // MARK: - CoreMotion: Barometer

    private func readBarometer(conn: NWConnection) {
        // L-3: Serialize barometer requests
        guard !barometerBusy else {
            sendJSON(conn: conn, obj: ["error": "barometer busy, try again"], status: 429)
            return
        }
        barometerBusy = true

        guard CMAltimeter.isRelativeAltitudeAvailable() else {
            barometerBusy = false
            sendJSON(conn: conn, obj: ["error": "barometer not available on this device"])
            return
        }
        // Take one reading then stop
        altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] altitudeData, error in
            guard let self else { return }
            // Stop immediately after first reading
            self.altimeter.stopRelativeAltitudeUpdates()
            self.barometerBusy = false  // L-3: release on both paths

            if let error {
                self.sendJSON(conn: conn, obj: ["error": error.localizedDescription])
                return
            }
            guard let data = altitudeData else {
                self.sendJSON(conn: conn, obj: ["error": "no barometer data"])
                return
            }
            self.logActivity(capability: "motion", action: "read_barometer", outcome: "ok")
            self.sendJSON(conn: conn, obj: [
                "pressure_kpa":        data.pressure.doubleValue,
                "relative_altitude_m": data.relativeAltitude.doubleValue,
            ])
        }
    }

    // MARK: - TTS

    private func speakText(conn: NWConnection, body: String) {
        // H-5: Rate limit — at most 1 TTS per 5 seconds
        let now = Date()
        guard now.timeIntervalSince(lastTtsTime) >= 5 else {
            sendJSON(conn: conn, obj: ["error": "rate limited: 1 TTS per 5 seconds"], status: 429)
            return
        }
        lastTtsTime = now

        guard let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let text = json["text"] as? String,
              !text.isEmpty else {
            sendJSON(conn: conn, obj: ["error": "missing required field: text"])
            return
        }
        let trimmed = String(text.prefix(4000))
        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.rate = (json["rate"] as? Float).map { max(0.0, min(1.0, $0)) }
                        ?? AVSpeechUtteranceDefaultSpeechRate
        utterance.pitchMultiplier = (json["pitch"] as? Float).map { max(0.5, min(2.0, $0)) } ?? 1.0

        // H-5: Validate language with BCP-47 pattern (letters/hyphens, 2-8 char segments)
        let rawLang = json["language"] as? String ?? "en-US"
        let bcp47 = try? NSRegularExpression(pattern: "^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$")
        let safeLanguage: String
        if bcp47?.firstMatch(in: rawLang, range: NSRange(rawLang.startIndex..., in: rawLang)) != nil {
            safeLanguage = rawLang
        } else {
            safeLanguage = "en-US"
        }
        utterance.voice = AVSpeechSynthesisVoice(language: safeLanguage)

        // H-5: Stop existing speech before enqueuing new
        if speechSynthesizer.isSpeaking { speechSynthesizer.stopSpeaking(at: .immediate) }
        speechSynthesizer.speak(utterance)
        logActivity(capability: "tts", action: "speak", outcome: "\(trimmed.count) chars")
        sendJSON(conn: conn, obj: ["spoken": true])
    }

    // MARK: - HealthKit

    #if canImport(HealthKit)
    /// All HK types this bridge may read — used for bulk authorization.
    private var allHealthReadTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = []
        let quantityIds: [HKQuantityTypeIdentifier] = [
            .stepCount, .heartRate, .heartRateVariabilitySDNN,
            .oxygenSaturation, .activeEnergyBurned, .bloodGlucose,
        ]
        for id in quantityIds {
            if let t = HKQuantityType.quantityType(forIdentifier: id) { types.insert(t) }
        }
        if let sleep = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis) { types.insert(sleep) }
        if let mindful = HKCategoryType.categoryType(forIdentifier: .mindfulSession) { types.insert(mindful) }
        types.insert(HKObjectType.workoutType())
        if #available(iOS 12.0, *) {
            for typeId: HKClinicalTypeIdentifier in [.allergyRecord, .labResultRecord, .medicationRecord] {
                if let ct = HKObjectType.clinicalType(forIdentifier: typeId) { types.insert(ct) }
            }
        }
        return types
    }

    private func readSteps(conn: NWConnection) {
        guard HKHealthStore.isHealthDataAvailable(),
              let stepType = HKQuantityType.quantityType(forIdentifier: .stepCount) else {
            sendJSON(conn: conn, obj: ["error": "HealthKit unavailable"])
            return
        }
        hkStore.requestAuthorization(toShare: [], read: allHealthReadTypes) { [weak self] granted, _ in
            guard let self, granted else {
                self?.sendJSON(conn: conn, obj: ["error": "HealthKit not authorized"])
                return
            }
            let start = Calendar.current.startOfDay(for: Date())
            let pred = HKQuery.predicateForSamples(withStart: start, end: Date())
            let query = HKStatisticsQuery(quantityType: stepType, quantitySamplePredicate: pred,
                                          options: .cumulativeSum) { [weak self] _, result, _ in
                let steps = result?.sumQuantity()?.doubleValue(for: .count()) ?? 0
                self?.logActivity(capability: "health", action: "read_steps", outcome: "\(Int(steps)) steps")
                self?.sendJSON(conn: conn, obj: ["steps": Int(steps), "date": ISO8601DateFormatter().string(from: start)])
            }
            self.hkStore.execute(query)
        }
    }

    /// Fetch the single most-recent sample for a HKQuantityType and return `{key: value, "timestamp": iso8601}`.
    /// `transform` lets callers rescale the raw unit value (e.g. fraction → percentage).
    private func fetchLatestQuantity(conn: NWConnection,
                                     typeId: HKQuantityTypeIdentifier,
                                     unit: HKUnit,
                                     key: String,
                                     action: String,
                                     transform: ((Double) -> Double)? = nil) {
        guard HKHealthStore.isHealthDataAvailable(),
              let qType = HKQuantityType.quantityType(forIdentifier: typeId) else {
            sendJSON(conn: conn, obj: ["error": "HealthKit unavailable"])
            return
        }
        hkStore.requestAuthorization(toShare: [], read: allHealthReadTypes) { [weak self] granted, _ in
            guard let self, granted else {
                self?.sendJSON(conn: conn, obj: ["error": "HealthKit not authorized"])
                return
            }
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
            let query = HKSampleQuery(sampleType: qType, predicate: nil,
                                      limit: 1, sortDescriptors: [sort]) { [weak self] _, samples, _ in
                guard let self else { return }
                if let sample = samples?.first as? HKQuantitySample {
                    var value = sample.quantity.doubleValue(for: unit)
                    if let t = transform { value = t(value) }
                    let ts = ISO8601DateFormatter().string(from: sample.startDate)
                    logActivity(capability: "health", action: action, outcome: "\(value)")
                    sendJSON(conn: conn, obj: [key: value, "timestamp": ts])
                } else {
                    logActivity(capability: "health", action: action, outcome: "no data")
                    sendJSON(conn: conn, obj: ["error": "no data"])
                }
            }
            self.hkStore.execute(query)
        }
    }

    /// Sum a cumulative quantity type over today and return `{key: value, "date": iso8601}`.
    private func fetchTodaySum(conn: NWConnection,
                               typeId: HKQuantityTypeIdentifier,
                               unit: HKUnit,
                               key: String,
                               action: String) {
        guard HKHealthStore.isHealthDataAvailable(),
              let qType = HKQuantityType.quantityType(forIdentifier: typeId) else {
            sendJSON(conn: conn, obj: ["error": "HealthKit unavailable"])
            return
        }
        hkStore.requestAuthorization(toShare: [], read: allHealthReadTypes) { [weak self] granted, _ in
            guard let self, granted else {
                self?.sendJSON(conn: conn, obj: ["error": "HealthKit not authorized"])
                return
            }
            let start = Calendar.current.startOfDay(for: Date())
            let pred = HKQuery.predicateForSamples(withStart: start, end: Date())
            let query = HKStatisticsQuery(quantityType: qType, quantitySamplePredicate: pred,
                                          options: .cumulativeSum) { [weak self] _, result, _ in
                guard let self else { return }
                let value = result?.sumQuantity()?.doubleValue(for: unit) ?? 0
                logActivity(capability: "health", action: action, outcome: "\(value)")
                sendJSON(conn: conn, obj: [key: value, "date": ISO8601DateFormatter().string(from: start)])
            }
            self.hkStore.execute(query)
        }
    }

    /// Read last 24 h of sleep samples and bucket into inBed / asleep / awake minutes.
    private func readSleep(conn: NWConnection) {
        guard HKHealthStore.isHealthDataAvailable(),
              let sleepType = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis) else {
            sendJSON(conn: conn, obj: ["error": "HealthKit unavailable"])
            return
        }
        hkStore.requestAuthorization(toShare: [], read: allHealthReadTypes) { [weak self] granted, _ in
            guard let self, granted else {
                self?.sendJSON(conn: conn, obj: ["error": "HealthKit not authorized"])
                return
            }
            let since = Date(timeIntervalSinceNow: -86400)
            let pred = HKQuery.predicateForSamples(withStart: since, end: Date())
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
            let query = HKSampleQuery(sampleType: sleepType, predicate: pred,
                                      limit: 500, sortDescriptors: [sort]) { [weak self] _, samples, _ in
                guard let self else { return }
                var inBedSec: TimeInterval = 0
                var asleepSec: TimeInterval = 0
                var awakeSec: TimeInterval = 0
                for sample in (samples ?? []) {
                    guard let cat = sample as? HKCategorySample else { continue }
                    let dur = cat.endDate.timeIntervalSince(cat.startDate)
                    switch HKCategoryValueSleepAnalysis(rawValue: cat.value) {
                    case .inBed:
                        inBedSec += dur
                    case .asleepUnspecified, .asleepCore, .asleepDeep, .asleepREM:
                        asleepSec += dur
                    case .awake:
                        awakeSec += dur
                    default:
                        break
                    }
                }
                let dateStr = ISO8601DateFormatter().string(from: since)
                logActivity(capability: "health", action: "read_sleep",
                            outcome: "asleep \(Int(asleepSec/60))min")
                sendJSON(conn: conn, obj: [
                    "in_bed_min": Int(inBedSec / 60),
                    "asleep_min": Int(asleepSec / 60),
                    "awake_min":  Int(awakeSec / 60),
                    "date": dateStr,
                ])
            }
            self.hkStore.execute(query)
        }
    }

    /// Aggregate all health metrics in parallel and return a single combined JSON object.
    /// Any individual metric that fails is simply omitted — the call never fails as a whole.
    private func readHealthSummary(conn: NWConnection) {
        guard HKHealthStore.isHealthDataAvailable() else {
            sendJSON(conn: conn, obj: ["error": "HealthKit unavailable"])
            return
        }
        hkStore.requestAuthorization(toShare: [], read: allHealthReadTypes) { [weak self] granted, _ in
            guard let self, granted else {
                self?.sendJSON(conn: conn, obj: ["error": "HealthKit not authorized"])
                return
            }

            let group = DispatchGroup()
            let lock = NSLock()
            var summary: [String: Any] = [:]

            // Steps (today's sum)
            if let stepType = HKQuantityType.quantityType(forIdentifier: .stepCount) {
                group.enter()
                let start = Calendar.current.startOfDay(for: Date())
                let pred = HKQuery.predicateForSamples(withStart: start, end: Date())
                let q = HKStatisticsQuery(quantityType: stepType, quantitySamplePredicate: pred,
                                          options: .cumulativeSum) { _, result, _ in
                    if let val = result?.sumQuantity()?.doubleValue(for: .count()) {
                        lock.lock(); summary["steps"] = Int(val); summary["steps_date"] = ISO8601DateFormatter().string(from: start); lock.unlock()
                    }
                    group.leave()
                }
                hkStore.execute(q)
            }

            // Heart rate (latest)
            if let hrType = HKQuantityType.quantityType(forIdentifier: .heartRate) {
                group.enter()
                let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
                let q = HKSampleQuery(sampleType: hrType, predicate: nil, limit: 1, sortDescriptors: [sort]) { _, samples, _ in
                    if let s = samples?.first as? HKQuantitySample {
                        let bpm = s.quantity.doubleValue(for: HKUnit(from: "count/min"))
                        lock.lock(); summary["heart_rate_bpm"] = bpm; summary["heart_rate_ts"] = ISO8601DateFormatter().string(from: s.startDate); lock.unlock()
                    }
                    group.leave()
                }
                hkStore.execute(q)
            }

            // HRV (latest)
            if let hrvType = HKQuantityType.quantityType(forIdentifier: .heartRateVariabilitySDNN) {
                group.enter()
                let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
                let q = HKSampleQuery(sampleType: hrvType, predicate: nil, limit: 1, sortDescriptors: [sort]) { _, samples, _ in
                    if let s = samples?.first as? HKQuantitySample {
                        let ms = s.quantity.doubleValue(for: HKUnit.secondUnit(with: .milli))
                        lock.lock(); summary["hrv_ms"] = ms; summary["hrv_ts"] = ISO8601DateFormatter().string(from: s.startDate); lock.unlock()
                    }
                    group.leave()
                }
                hkStore.execute(q)
            }

            // Blood oxygen (latest)
            if let spo2Type = HKQuantityType.quantityType(forIdentifier: .oxygenSaturation) {
                group.enter()
                let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
                let q = HKSampleQuery(sampleType: spo2Type, predicate: nil, limit: 1, sortDescriptors: [sort]) { _, samples, _ in
                    if let s = samples?.first as? HKQuantitySample {
                        let pct = s.quantity.doubleValue(for: HKUnit.percent()) * 100.0
                        lock.lock(); summary["spo2_pct"] = pct; summary["spo2_ts"] = ISO8601DateFormatter().string(from: s.startDate); lock.unlock()
                    }
                    group.leave()
                }
                hkStore.execute(q)
            }

            // Active energy (today's sum)
            if let aeType = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned) {
                group.enter()
                let start = Calendar.current.startOfDay(for: Date())
                let pred = HKQuery.predicateForSamples(withStart: start, end: Date())
                let q = HKStatisticsQuery(quantityType: aeType, quantitySamplePredicate: pred,
                                          options: .cumulativeSum) { _, result, _ in
                    if let val = result?.sumQuantity()?.doubleValue(for: HKUnit.kilocalorie()) {
                        lock.lock(); summary["active_kcal"] = val; summary["active_kcal_date"] = ISO8601DateFormatter().string(from: start); lock.unlock()
                    }
                    group.leave()
                }
                hkStore.execute(q)
            }

            // Sleep (last 24 h)
            if let sleepType = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis) {
                group.enter()
                let since = Date(timeIntervalSinceNow: -86400)
                let pred = HKQuery.predicateForSamples(withStart: since, end: Date())
                let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
                let q = HKSampleQuery(sampleType: sleepType, predicate: pred,
                                      limit: 500, sortDescriptors: [sort]) { _, samples, _ in
                    var inBedSec: TimeInterval = 0; var asleepSec: TimeInterval = 0; var awakeSec: TimeInterval = 0
                    for sample in (samples ?? []) {
                        guard let cat = sample as? HKCategorySample else { continue }
                        let dur = cat.endDate.timeIntervalSince(cat.startDate)
                        switch HKCategoryValueSleepAnalysis(rawValue: cat.value) {
                        case .inBed: inBedSec += dur
                        case .asleepUnspecified, .asleepCore, .asleepDeep, .asleepREM: asleepSec += dur
                        case .awake: awakeSec += dur
                        default: break
                        }
                    }
                    lock.lock()
                    summary["sleep_in_bed_min"] = Int(inBedSec / 60)
                    summary["sleep_asleep_min"] = Int(asleepSec / 60)
                    summary["sleep_awake_min"]  = Int(awakeSec / 60)
                    lock.unlock()
                    group.leave()
                }
                hkStore.execute(q)
            }

            group.notify(queue: .global(qos: .utility)) { [weak self] in
                guard let self else { return }
                logActivity(capability: "health", action: "read_summary", outcome: "\(summary.count) fields")
                sendJSON(conn: conn, obj: summary)
            }
        }
    }

    // MARK: - HealthKit: Workout Routes

    private func readWorkoutRoutes(conn: NWConnection, days: Int) {
        guard HKHealthStore.isHealthDataAvailable() else {
            sendJSON(conn: conn, obj: ["error": "HealthKit unavailable"])
            return
        }
        hkStore.requestAuthorization(toShare: [], read: allHealthReadTypes) { [weak self] granted, _ in
            guard let self, granted else {
                self?.sendJSON(conn: conn, obj: ["error": "HealthKit not authorized"])
                return
            }
            let start = Date(timeIntervalSinceNow: -Double(days) * 86400)
            let pred  = HKQuery.predicateForSamples(withStart: start, end: Date())
            let sort  = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
            let workoutQuery = HKSampleQuery(
                sampleType: HKObjectType.workoutType(),
                predicate: pred,
                limit: 20,
                sortDescriptors: [sort]
            ) { [weak self] _, samples, _ in
                guard let self else { return }
                guard let workouts = samples as? [HKWorkout], !workouts.isEmpty else {
                    self.logActivity(capability: "health", action: "read_workout_routes", outcome: "0 workouts")
                    self.sendJSON(conn: conn, obj: ["workouts": [Any]() as Any])
                    return
                }

                let group   = DispatchGroup()
                let lock    = NSLock()
                var results = [[String: Any]](repeating: [:], count: workouts.count)

                for (idx, workout) in workouts.enumerated() {
                    var workoutDict: [String: Any] = [
                        "workout_type": workout.workoutActivityType.name,
                        "start":        ISO8601DateFormatter().string(from: workout.startDate),
                        "end":          ISO8601DateFormatter().string(from: workout.endDate),
                        "duration_s":   workout.duration,
                        "distance_m":   workout.totalDistance?.doubleValue(for: .meter()) ?? 0.0,
                        "calories":     workout.totalEnergyBurned?.doubleValue(for: .kilocalorie()) ?? 0.0,
                        "route":        [Any]() as Any,
                    ]

                    // Query associated route
                    group.enter()
                    let routePred = HKQuery.predicateForObjects(from: workout)
                    let routeType = HKSeriesType.workoutRoute()
                    let routeQuery = HKSampleQuery(
                        sampleType: routeType,
                        predicate: routePred,
                        limit: 1,
                        sortDescriptors: nil
                    ) { [weak self] _, routeSamples, _ in
                        guard let self else { group.leave(); return }
                        guard let route = routeSamples?.first as? HKWorkoutRoute else {
                            lock.lock(); results[idx] = workoutDict; lock.unlock()
                            group.leave()
                            return
                        }

                        var coords: [[String: Any]] = []
                        let locQuery = HKWorkoutRouteQuery(route: route) { _, locations, done, _ in
                            if let locations {
                                for loc in locations {
                                    coords.append([
                                        "lat":          loc.coordinate.latitude,
                                        "lng":          loc.coordinate.longitude,
                                        "altitude_m":   loc.altitude,
                                        "timestamp":    ISO8601DateFormatter().string(from: loc.timestamp),
                                    ])
                                }
                            }
                            if done {
                                workoutDict["route"] = coords
                                lock.lock(); results[idx] = workoutDict; lock.unlock()
                                group.leave()
                            }
                        }
                        self.hkStore.execute(locQuery)
                    }
                    self.hkStore.execute(routeQuery)
                }

                group.notify(queue: .global(qos: .utility)) { [weak self] in
                    guard let self else { return }
                    let filtered = results.filter { !$0.isEmpty }
                    self.logActivity(capability: "health", action: "read_workout_routes",
                                     outcome: "\(filtered.count) workouts")
                    self.sendJSON(conn: conn, obj: ["workouts": filtered])
                }
            }
            self.hkStore.execute(workoutQuery)
        }
    }

    // MARK: - HealthKit: Mindfulness

    private func readMindfulness(conn: NWConnection, days: Int) {
        guard HKHealthStore.isHealthDataAvailable(),
              let mindfulType = HKCategoryType.categoryType(forIdentifier: .mindfulSession) else {
            sendJSON(conn: conn, obj: ["error": "HealthKit unavailable"])
            return
        }
        hkStore.requestAuthorization(toShare: [], read: allHealthReadTypes) { [weak self] granted, _ in
            guard let self, granted else {
                self?.sendJSON(conn: conn, obj: ["error": "HealthKit not authorized"])
                return
            }
            let start = Date(timeIntervalSinceNow: -Double(days) * 86400)
            let pred  = HKQuery.predicateForSamples(withStart: start, end: Date())
            let sort  = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
            let query = HKSampleQuery(sampleType: mindfulType, predicate: pred,
                                      limit: 500, sortDescriptors: [sort]) { [weak self] _, samples, _ in
                guard let self else { return }
                let sessions = samples ?? []
                let totalSeconds = sessions.reduce(0.0) { $0 + $1.endDate.timeIntervalSince($1.startDate) }
                let totalMinutes = totalSeconds / 60.0
                let count = sessions.count
                let avg = count > 0 ? totalMinutes / Double(count) : 0.0
                self.logActivity(capability: "health", action: "read_mindfulness",
                                 outcome: "\(count) sessions, \(Int(totalMinutes))min")
                self.sendJSON(conn: conn, obj: [
                    "sessions":             count,
                    "total_minutes":        totalMinutes,
                    "avg_session_minutes":  avg,
                ])
            }
            self.hkStore.execute(query)
        }
    }

    // MARK: - HealthKit: Blood Glucose

    private func readBloodGlucose(conn: NWConnection, days: Int) {
        guard HKHealthStore.isHealthDataAvailable(),
              let glucoseType = HKQuantityType.quantityType(forIdentifier: .bloodGlucose) else {
            sendJSON(conn: conn, obj: ["error": "HealthKit unavailable"])
            return
        }
        hkStore.requestAuthorization(toShare: [], read: allHealthReadTypes) { [weak self] granted, _ in
            guard let self, granted else {
                self?.sendJSON(conn: conn, obj: ["error": "HealthKit not authorized"])
                return
            }
            let start = Date(timeIntervalSinceNow: -Double(days) * 86400)
            let pred  = HKQuery.predicateForSamples(withStart: start, end: Date())
            let sort  = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
            // mg/dL unit
            let mgdL  = HKUnit(from: "mg/dL")
            let query = HKSampleQuery(sampleType: glucoseType, predicate: pred,
                                      limit: 500, sortDescriptors: [sort]) { [weak self] _, samples, _ in
                guard let self else { return }
                let readings: [[String: Any]] = (samples as? [HKQuantitySample] ?? []).map { s in
                    [
                        "value_mg_dl": s.quantity.doubleValue(for: mgdL),
                        "timestamp":   ISO8601DateFormatter().string(from: s.startDate),
                    ]
                }
                let values = readings.compactMap { $0["value_mg_dl"] as? Double }
                let avg = values.isEmpty ? 0.0 : values.reduce(0, +) / Double(values.count)
                let mn  = values.min() ?? 0.0
                let mx  = values.max() ?? 0.0
                self.logActivity(capability: "health", action: "read_blood_glucose",
                                 outcome: "\(readings.count) readings")
                self.sendJSON(conn: conn, obj: [
                    "readings":   readings,
                    "avg_mg_dl":  avg,
                    "min_mg_dl":  mn,
                    "max_mg_dl":  mx,
                ])
            }
            self.hkStore.execute(query)
        }
    }

    // MARK: - HealthKit: Clinical Records

    private func readClinicalRecords(conn: NWConnection, type: String) {
        guard #available(iOS 12.0, *) else {
            sendJSON(conn: conn, obj: ["error": "clinical records require iOS 12+"])
            return
        }
        guard HKHealthStore.isHealthDataAvailable() else {
            sendJSON(conn: conn, obj: ["error": "HealthKit unavailable"])
            return
        }
        let typeId: HKClinicalTypeIdentifier
        switch type {
        case "lab":        typeId = .labResultRecord
        case "medication": typeId = .medicationRecord
        default:           typeId = .allergyRecord
        }
        guard let clinicalType = HKObjectType.clinicalType(forIdentifier: typeId) else {
            sendJSON(conn: conn, obj: ["error": "clinical type unavailable"])
            return
        }
        hkStore.requestAuthorization(toShare: [], read: [clinicalType]) { [weak self] granted, _ in
            guard let self, granted else {
                self?.sendJSON(conn: conn, obj: ["error": "HealthKit not authorized"])
                return
            }
            let sort  = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
            let query = HKSampleQuery(sampleType: clinicalType, predicate: nil,
                                      limit: 500, sortDescriptors: [sort]) { [weak self] _, samples, _ in
                guard let self else { return }
                var records: [[String: Any]] = []
                for sample in (samples as? [HKClinicalRecord] ?? []) {
                    var entry: [String: Any] = [
                        "type":    type,
                        "display": sample.displayName,
                        "date":    ISO8601DateFormatter().string(from: sample.startDate),
                    ]
                    if let fhir = sample.fhirResource, let b64 = String(data: fhir.data.base64EncodedData(), encoding: .utf8) {
                        entry["fhir_base64"] = b64
                    }
                    records.append(entry)
                }
                self.logActivity(capability: "health", action: "read_clinical_records",
                                 outcome: "\(records.count) \(type) records")
                self.sendJSON(conn: conn, obj: records)
            }
            self.hkStore.execute(query)
        }
    }

    /// Unified /phone/health endpoint — returns requested metric types for the given day window.
    /// `types` comma-separated: steps, heart_rate, sleep, hrv, spo2, calories
    private func readHealthUnified(conn: NWConnection, queryString: String) {
        let qp    = queryParams(queryString)
        let types = Set((qp["types"] ?? "steps,heart_rate,sleep")
            .split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) })
        let days  = min(max(Int(qp["days"] ?? "7") ?? 7, 1), 90)
        guard HKHealthStore.isHealthDataAvailable() else {
            sendJSON(conn: conn, obj: ["error": "HealthKit unavailable"]); return
        }
        hkStore.requestAuthorization(toShare: [], read: allHealthReadTypes) { [weak self] granted, _ in
            guard let self, granted else {
                self?.sendJSON(conn: conn, obj: ["error": "HealthKit not authorized"]); return
            }
            var result: [String: Any] = [:]
            let group = DispatchGroup()
            let since = Date(timeIntervalSinceNow: -Double(days) * 86400)

            if types.contains("steps"),
               let stepType = HKQuantityType.quantityType(forIdentifier: .stepCount) {
                group.enter()
                let pred  = HKQuery.predicateForSamples(withStart: since, end: Date())
                let query = HKStatisticsQuery(quantityType: stepType,
                                              quantitySamplePredicate: pred,
                                              options: .cumulativeSum) { _, r, _ in
                    result["steps"] = Int(r?.sumQuantity()?.doubleValue(for: .count()) ?? 0)
                    group.leave()
                }
                hkStore.execute(query)
            }

            if types.contains("heart_rate"),
               let hrType = HKQuantityType.quantityType(forIdentifier: .heartRate) {
                group.enter()
                let sort  = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
                let query = HKSampleQuery(sampleType: hrType, predicate: nil,
                                          limit: 1, sortDescriptors: [sort]) { _, samples, _ in
                    if let s = samples?.first as? HKQuantitySample {
                        result["heart_rate_bpm"] = s.quantity.doubleValue(for: HKUnit(from: "count/min"))
                        result["heart_rate_ts"]  = ISO8601DateFormatter().string(from: s.startDate)
                    }
                    group.leave()
                }
                hkStore.execute(query)
            }

            if types.contains("sleep"),
               let sleepType = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis) {
                group.enter()
                let pred  = HKQuery.predicateForSamples(withStart: since, end: Date())
                let sort  = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
                let query = HKSampleQuery(sampleType: sleepType, predicate: pred,
                                          limit: 500, sortDescriptors: [sort]) { _, samples, _ in
                    var inBed = 0.0; var asleep = 0.0
                    for s in (samples as? [HKCategorySample] ?? []) {
                        let mins = s.endDate.timeIntervalSince(s.startDate) / 60.0
                        if s.value == HKCategoryValueSleepAnalysis.inBed.rawValue { inBed += mins }
                        else { asleep += mins }
                    }
                    result["sleep_in_bed_min"] = Int(inBed)
                    result["sleep_asleep_min"] = Int(asleep)
                    group.leave()
                }
                hkStore.execute(query)
            }

            if types.contains("calories"),
               let calType = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned) {
                group.enter()
                let start = Calendar.current.startOfDay(for: Date())
                let pred  = HKQuery.predicateForSamples(withStart: start, end: Date())
                let query = HKStatisticsQuery(quantityType: calType,
                                              quantitySamplePredicate: pred,
                                              options: .cumulativeSum) { _, r, _ in
                    result["active_kcal"] = r?.sumQuantity()?.doubleValue(for: .kilocalorie()) ?? 0
                    group.leave()
                }
                hkStore.execute(query)
            }

            group.notify(queue: .global()) { [weak self] in
                self?.logActivity(capability: "health", action: "read_unified",
                                  outcome: "\(result.keys.count) metrics")
                self?.sendJSON(conn: conn, obj: result)
            }
        }
    }
    #endif

    // MARK: - Contact Update

    private func updateContact(conn: NWConnection, contactId: String, body: String) {
        guard !contactId.isEmpty else {
            sendJSON(conn: conn, obj: ["error": "missing contact id"]); return
        }
        guard let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            sendJSON(conn: conn, obj: ["error": "invalid JSON body"]); return
        }
        let store = CNContactStore()
        store.requestAccess(for: .contacts) { [weak self] granted, _ in
            guard let self else { return }
            guard granted else {
                sendJSON(conn: conn, obj: ["error": "contacts access not granted"]); return
            }
            let keysToFetch = [CNContactGivenNameKey, CNContactFamilyNameKey,
                               CNContactPhoneNumbersKey, CNContactEmailAddressesKey,
                               CNContactOrganizationNameKey] as [CNKeyDescriptor]
            guard let contact = try? store.unifiedContact(withIdentifier: contactId,
                                                          keysToFetch: keysToFetch),
                  let mutable = contact.mutableCopy() as? CNMutableContact else {
                sendJSON(conn: conn, obj: ["error": "contact not found"]); return
            }
            if let v = json["given_name"]   as? String { mutable.givenName        = String(v.prefix(100)) }
            if let v = json["family_name"]  as? String { mutable.familyName       = String(v.prefix(100)) }
            if let v = json["organization"] as? String { mutable.organizationName = String(v.prefix(200)) }
            if let v = json["phone"] as? String {
                mutable.phoneNumbers = [CNLabeledValue(
                    label: CNLabelPhoneNumberMain,
                    value: CNPhoneNumber(stringValue: String(v.prefix(30))))]
            }
            if let v = json["email"] as? String {
                mutable.emailAddresses = [CNLabeledValue(
                    label: CNLabelWork,
                    value: String(v.prefix(254)) as NSString)]
            }
            let req = CNSaveRequest()
            req.update(mutable)
            do {
                try store.execute(req)
                logActivity(capability: "contacts", action: "update", outcome: "ok")
                sendJSON(conn: conn, obj: ["ok": true])
            } catch {
                sendJSON(conn: conn, obj: ["error": error.localizedDescription])
            }
        }
    }

    // MARK: - Calendar Event Update

    private func updateCalendarEvent(conn: NWConnection, eventId: String, body: String) {
        guard !eventId.isEmpty else {
            sendJSON(conn: conn, obj: ["error": "missing event id"]); return
        }
        guard let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            sendJSON(conn: conn, obj: ["error": "invalid JSON body"]); return
        }
        let ekStore = EKEventStore()
        let requestAccess: (@escaping (Bool, Error?) -> Void) -> Void
        if #available(iOS 17.0, *) {
            requestAccess = { h in ekStore.requestFullAccessToEvents(completion: h) }
        } else {
            requestAccess = { h in ekStore.requestAccess(to: .event, completion: h) }
        }
        requestAccess { [weak self] granted, _ in
            guard let self else { return }
            guard granted else {
                sendJSON(conn: conn, obj: ["error": "calendar access not granted"]); return
            }
            guard let event = ekStore.event(withIdentifier: eventId) else {
                sendJSON(conn: conn, obj: ["error": "event not found"]); return
            }
            if let v = json["title"]    as? String { event.title    = String(v.prefix(200)) }
            if let v = json["notes"]    as? String { event.notes    = String(v.prefix(4000)) }
            if let v = json["location"] as? String { event.location = String(v.prefix(200)) }
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let s = json["start_date"] as? String, let d = iso.date(from: s) { event.startDate = d }
            if let s = json["end_date"]   as? String, let d = iso.date(from: s) { event.endDate   = d }
            do {
                try ekStore.save(event, span: .thisEvent)
                logActivity(capability: "calendar", action: "update", outcome: "ok")
                sendJSON(conn: conn, obj: ["ok": true])
            } catch {
                sendJSON(conn: conn, obj: ["error": error.localizedDescription])
            }
        }
    }

    // MARK: - Camera

    private func capturePhoto(conn: NWConnection, body: String) {
        let json = (body.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) ?? [:]
        let useFront = (json["camera"] as? String) == "front"
        let position: AVCaptureDevice.Position = useFront ? .front : .back
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) else {
            sendJSON(conn: conn, obj: ["error": "camera not available on this device"]); return
        }
        let session = AVCaptureSession()
        session.sessionPreset = .photo
        guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
            sendJSON(conn: conn, obj: ["error": "failed to create camera input"]); return
        }
        session.addInput(input)
        let output = AVCapturePhotoOutput()
        guard session.canAddOutput(output) else {
            sendJSON(conn: conn, obj: ["error": "cannot add photo output"]); return
        }
        session.addOutput(output)

        let sema = DispatchSemaphore(value: 0)
        var capturedData: Data?
        let delegate = PhotoCaptureDelegate { data in
            capturedData = data
            sema.signal()
        }
        // Retain delegate for the async capture duration
        objc_setAssociatedObject(output, "delegate", delegate, .OBJC_ASSOCIATION_RETAIN)

        session.startRunning()
        Thread.sleep(forTimeInterval: 0.5)  // Let camera stabilize
        output.capturePhoto(with: AVCapturePhotoSettings(), delegate: delegate)

        let result = sema.wait(timeout: .now() + 10)
        session.stopRunning()

        guard result == .success, let data = capturedData else {
            sendJSON(conn: conn, obj: ["error": "photo capture timed out or failed"]); return
        }
        logActivity(capability: "camera", action: "capture", outcome: "\(data.count) bytes")
        sendJSON(conn: conn, obj: ["image_base64": data.base64EncodedString(), "format": "jpeg"])
    }

    // MARK: - Microphone

    private func recordAudio(conn: NWConnection, body: String) {
        let json = (body.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) ?? [:]
        let duration = min(max(Double(json["duration_secs"] as? Int ?? 5), 1.0), 30.0)

        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.record, mode: .default)
            try audioSession.setActive(true)
        } catch {
            sendJSON(conn: conn, obj: ["error": "audio session setup failed: \(error.localizedDescription)"]); return
        }

        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("zc_audio_\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 22050,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            AVEncoderBitRateKey: 32000,
        ]
        guard let recorder = try? AVAudioRecorder(url: fileURL, settings: settings) else {
            try? audioSession.setActive(false)
            sendJSON(conn: conn, obj: ["error": "failed to create audio recorder"]); return
        }
        recorder.record(forDuration: duration)
        Thread.sleep(forTimeInterval: duration + 0.5)
        recorder.stop()
        try? audioSession.setActive(false)

        guard let audioData = try? Data(contentsOf: fileURL) else {
            sendJSON(conn: conn, obj: ["error": "failed to read recorded audio"]); return
        }
        try? FileManager.default.removeItem(at: fileURL)

        logActivity(capability: "microphone", action: "record",
                    outcome: "\(Int(duration))s, \(audioData.count) bytes")
        sendJSON(conn: conn, obj: [
            "audio_base64": audioData.base64EncodedString(),
            "format": "m4a",
            "duration_secs": duration,
            "sample_rate": 22050,
        ])
    }

    // MARK: - Context aggregate

    private func phoneContext(conn: NWConnection) {
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        let tz = TimeZone.current
        let monitor = NWPathMonitor()
        let sema = DispatchSemaphore(value: 0)
        var wifi = false; var cellular = false; var connected = false
        monitor.pathUpdateHandler = { path in
            connected = path.status == .satisfied
            wifi      = path.usesInterfaceType(.wifi)
            cellular  = path.usesInterfaceType(.cellular)
            sema.signal()
        }
        monitor.start(queue: .global())
        _ = sema.wait(timeout: .now() + 2)
        monitor.cancel()
        let result: [String: Any] = [
            "model":           device.model,
            "name":            device.name,
            "system_version":  device.systemVersion,
            "battery_level":   device.batteryLevel >= 0 ? Int(device.batteryLevel * 100) : -1,
            "charging":        device.batteryState == .charging || device.batteryState == .full,
            "platform":        "ios",
            "connected":       connected,
            "wifi":            wifi,
            "cellular":        cellular,
            "timezone_id":     tz.identifier,
            "utc_offset_secs": tz.secondsFromGMT(),
        ]
        logActivity(capability: "battery", action: "read_context", outcome: "ok")
        sendJSON(conn: conn, obj: result)
    }

    // MARK: - Clipboard

    private func phoneClipboard(conn: NWConnection, method: String, body: String) {
        if method == "POST" {
            guard let data = body.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let text = json["text"] as? String else {
                sendJSON(conn: conn, obj: ["error": "missing required field: text"]); return
            }
            DispatchQueue.main.async {
                UIPasteboard.general.string = String(text.prefix(100_000))
                self.logActivity(capability: "tts", action: "clipboard_write", outcome: "ok")
                self.sendJSON(conn: conn, obj: ["ok": true])
            }
        } else {
            DispatchQueue.main.async {
                let text = UIPasteboard.general.string ?? ""
                self.logActivity(capability: "tts", action: "clipboard_read",
                                 outcome: "\(text.count) chars")
                self.sendJSON(conn: conn, obj: ["text": text, "has_content": !text.isEmpty])
            }
        }
    }

    // MARK: - Local notification

    private func scheduleLocalNotification(conn: NWConnection, body: String) {
        guard let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            sendJSON(conn: conn, obj: ["error": "invalid JSON body"]); return
        }
        let title      = String((json["title"] as? String ?? "").prefix(200))
        let bodyText   = String((json["body"]  as? String ?? "").prefix(4000))
        let delaySecs  = max(1.0, min(Double(json["delay_secs"] as? Int ?? 1), 3600.0))
        let identifier = json["id"] as? String ?? UUID().uuidString

        let content = UNMutableNotificationContent()
        content.title = title
        content.body  = bodyText
        content.sound = .default
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: delaySecs, repeats: false)
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)
        UNUserNotificationCenter.current().add(request) { [weak self] error in
            guard let self else { return }
            if let error {
                sendJSON(conn: conn, obj: ["error": error.localizedDescription])
            } else {
                logActivity(capability: "notifications", action: "schedule", outcome: identifier)
                sendJSON(conn: conn, obj: ["ok": true, "id": identifier])
            }
        }
    }

    // MARK: - Dismiss notifications

    private func dismissNotifications(conn: NWConnection, body: String) {
        let json = (body.data(using: .utf8).flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        }) ?? [:]
        let ids = Array((json["ids"] as? [String] ?? []).prefix(50))
        let center = UNUserNotificationCenter.current()
        if ids.isEmpty {
            center.removeAllPendingNotificationRequests()
            center.removeAllDeliveredNotifications()
            logActivity(capability: "notifications", action: "dismiss_all", outcome: "ok")
            sendJSON(conn: conn, obj: ["ok": true, "removed": "all"])
        } else {
            center.removePendingNotificationRequests(withIdentifiers: ids)
            center.removeDeliveredNotifications(withIdentifiers: ids)
            logActivity(capability: "notifications", action: "dismiss",
                        outcome: "\(ids.count) ids")
            sendJSON(conn: conn, obj: ["ok": true, "removed": ids.count])
        }
    }

    // MARK: - IMU snapshot

    private func readImuSnapshot(conn: NWConnection) {
        guard !imuBusy else {
            sendJSON(conn: conn, obj: ["error": "imu busy, try again"], status: 429); return
        }
        guard motionManager.isAccelerometerAvailable else {
            sendJSON(conn: conn, obj: ["error": "accelerometer not available on this device"]); return
        }
        imuBusy = true

        var accelX = 0.0, accelY = 0.0, accelZ = 0.0
        var gyroX  = 0.0, gyroY  = 0.0, gyroZ  = 0.0
        var gotAccel = false, gotGyro = false
        let lock = NSLock()
        let sema = DispatchSemaphore(value: 0)
        let updateInterval = 1.0 / 50.0

        func checkDone() {
            lock.lock(); let done = gotAccel && gotGyro; lock.unlock()
            if done { sema.signal() }
        }

        motionManager.accelerometerUpdateInterval = updateInterval
        motionManager.startAccelerometerUpdates(to: .main) { [weak self] data, _ in
            guard let self, let data else { return }
            motionManager.stopAccelerometerUpdates()
            lock.lock()
            accelX = data.acceleration.x; accelY = data.acceleration.y; accelZ = data.acceleration.z
            gotAccel = true
            lock.unlock()
            checkDone()
        }

        if motionManager.isGyroAvailable {
            motionManager.gyroUpdateInterval = updateInterval
            motionManager.startGyroUpdates(to: .main) { [weak self] data, _ in
                guard let self, let data else { return }
                motionManager.stopGyroUpdates()
                lock.lock()
                gyroX = data.rotationRate.x; gyroY = data.rotationRate.y; gyroZ = data.rotationRate.z
                gotGyro = true
                lock.unlock()
                checkDone()
            }
        } else {
            lock.lock(); gotGyro = true; lock.unlock()
            checkDone()
        }

        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            _ = sema.wait(timeout: .now() + 3)
            imuBusy = false
            logActivity(capability: "motion", action: "read_imu", outcome: "ok")
            sendJSON(conn: conn, obj: [
                "accel_x": accelX, "accel_y": accelY, "accel_z": accelZ,
                "gyro_x":  gyroX,  "gyro_y":  gyroY,  "gyro_z":  gyroZ,
                "timestamp": Date().timeIntervalSince1970,
            ])
        }
    }

    // MARK: - IMU record

    private func recordImu(conn: NWConnection, body: String) {
        let json = (body.data(using: .utf8).flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        }) ?? [:]
        let durationSecs = min(max(Double(json["duration_secs"] as? Int ?? 2), 0.5), 10.0)
        let hz           = min(max(Double(json["hz"] as? Int ?? 10), 1.0), 50.0)

        guard !imuBusy else {
            sendJSON(conn: conn, obj: ["error": "imu busy, try again"], status: 429); return
        }
        guard motionManager.isAccelerometerAvailable else {
            sendJSON(conn: conn, obj: ["error": "accelerometer not available on this device"]); return
        }
        imuBusy = true

        var samples: [[String: Double]] = []
        let lock     = NSLock()
        let interval = 1.0 / hz

        motionManager.accelerometerUpdateInterval = interval
        motionManager.startAccelerometerUpdates(to: OperationQueue()) { data, _ in
            guard let data else { return }
            let sample: [String: Double] = [
                "t": data.timestamp, "ax": data.acceleration.x,
                "ay": data.acceleration.y, "az": data.acceleration.z,
            ]
            lock.lock(); samples.append(sample); lock.unlock()
        }

        DispatchQueue.global().asyncAfter(deadline: .now() + durationSecs) { [weak self] in
            guard let self else { return }
            motionManager.stopAccelerometerUpdates()
            imuBusy = false
            lock.lock(); let result = samples; lock.unlock()
            logActivity(capability: "motion", action: "record_imu",
                        outcome: "\(result.count) samples")
            sendJSON(conn: conn, obj: [
                "samples":       result,
                "count":         result.count,
                "duration_secs": durationSecs,
                "hz":            hz,
            ])
        }
    }

    // MARK: - Emergency relay

    /// Called by the ZeroClaw safety skill after the 30-second confirmation window.
    /// Packages location, health, battery, reads stored contacts and agent_id, then
    /// fires a POST to the aggregator emergency relay endpoint.
    /// The aggregator sends Twilio SMS to each contact.
    private func fireEmergencyRelay(conn: NWConnection, body: String) {
        let json = (body.data(using: .utf8).flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        }) ?? [:]

        let message = String((json["message"] as? String ?? "Emergency: your contact may need help.").prefix(500))

        // Read contacts and agent_id from UserDefaults (written by Settings UI)
        let contactsRaw = UserDefaults.standard.string(forKey: "zerox1_emergency_contacts") ?? "[]"
        let agentId     = UserDefaults.standard.string(forKey: "zerox1_agent_id") ?? ""

        guard !agentId.isEmpty else {
            sendJSON(conn: conn, obj: ["error": "agent_id not available — node not running"], status: 503)
            return
        }

        guard let contactsData = contactsRaw.data(using: .utf8),
              let contacts = try? JSONSerialization.jsonObject(with: contactsData) as? [[String: String]],
              !contacts.isEmpty else {
            sendJSON(conn: conn, obj: ["error": "no emergency contacts configured"], status: 400)
            return
        }

        // Package device snapshot
        UIDevice.current.isBatteryMonitoringEnabled = true
        var payload: [String: Any] = [
            "agent_id":  agentId,
            "message":   message,
            "contacts":  contacts,
            "battery":   [
                // Send as fraction 0.0–1.0; aggregator multiplies by 100 to get %.
                "level":    UIDevice.current.batteryLevel >= 0 ? Double(UIDevice.current.batteryLevel) : -1.0,
                "charging": UIDevice.current.batteryState == .charging || UIDevice.current.batteryState == .full,
            ],
            "timestamp": Date().timeIntervalSince1970,
            "platform":  "ios",
        ]

        if let loc = lastLocation {
            payload["location"] = [
                "lat":       loc.coordinate.latitude,
                "lon":       loc.coordinate.longitude,
                "accuracy":  loc.horizontalAccuracy,
                "timestamp": loc.timestamp.timeIntervalSince1970,
            ]
        }

        guard let bodyData = try? JSONSerialization.data(withJSONObject: payload) else {
            sendJSON(conn: conn, obj: ["error": "failed to serialize payload"], status: 500)
            return
        }

        let aggregatorUrl = "https://api.0x01.world/emergency/relay"
        guard let url = URL(string: aggregatorUrl) else {
            sendJSON(conn: conn, obj: ["error": "invalid aggregator url"], status: 500)
            return
        }

        // Require the identity key — without it the aggregator will reject with 401
        // and no SMS will be sent. Fail fast here with a clear error.
        guard let keyB58 = KeychainHelper.load(key: "identity_key"),
              let sigHex = ed25519SignBridge(data: bodyData, base58Key: keyB58) else {
            os_log(.error, "[EmergencyRelay] identity key missing or signing failed — cannot authenticate relay")
            sendJSON(conn: conn, obj: [
                "ok":    false,
                "error": "identity_key not found in Keychain — node must be started before emergency relay",
            ], status: 500)
            return
        }

        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(sigHex, forHTTPHeaderField: "X-Agent-Signature")
        req.httpBody = bodyData

        logActivity(capability: "tts", action: "emergency_relay",
                    outcome: "\(contacts.count) contacts, \(message.prefix(40))")

        let bridgeConn = conn
        let capturedContacts = contacts
        let capturedCount = contacts.count

        URLSession.shared.dataTask(with: req) { [weak self] data, response, error in
            guard let self else { return }
            let httpStatus = (response as? HTTPURLResponse)?.statusCode ?? 0
            let relayOk = error == nil && (200...299).contains(httpStatus)

            if let error {
                os_log(.error, "[EmergencyRelay] relay failed: %{public}@", error.localizedDescription)
                sendJSON(conn: bridgeConn, obj: [
                    "ok":    false,
                    "error": error.localizedDescription,
                ])
                return
            }

            sendJSON(conn: bridgeConn, obj: [
                "ok":                relayOk,
                "contacts_notified": capturedCount,
                "aggregator_status": httpStatus,
            ])

            guard relayOk else {
                os_log(.error, "[EmergencyRelay] aggregator returned %d — SMS not sent", httpStatus)
                return
            }

            // Schedule the call-UI notification only after the relay succeeds so the
            // body accurately reflects that SMS was sent. The call button remains the
            // primary action; SMS is the background fallback.
            let firstContact = capturedContacts.first
            let firstName = firstContact?["name"] ?? "your contact"
            let firstPhone = firstContact?["phone"] ?? ""

            if !firstPhone.isEmpty {
                let content = UNMutableNotificationContent()
                content.title = "Emergency Alert Sent"
                content.body = "SMS sent to \(capturedCount) contact\(capturedCount == 1 ? "" : "s"). Tap to call \(firstName) now."
                content.sound = UNNotificationSound.default
                content.categoryIdentifier = "EMERGENCY_CALL"
                content.userInfo = [
                    "emergency_phone": firstPhone,
                    "emergency_name":  firstName,
                ]
                let notifRequest = UNNotificationRequest(
                    identifier: "zerox1.emergency.call.\(Int(Date().timeIntervalSince1970))",
                    content: content,
                    trigger: nil
                )
                UNUserNotificationCenter.current().add(notifRequest) { error in
                    if let error {
                        os_log(.error, "[EmergencyRelay] call-UI notification failed: %{public}@",
                               error.localizedDescription)
                    }
                }
            }

            // TTS confirmation on the main thread
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self else { return }
                let spoken = "Emergency alert sent to \(capturedCount) contact\(capturedCount == 1 ? "" : "s")."
                let utterance = AVSpeechUtterance(string: spoken)
                utterance.rate = AVSpeechUtteranceDefaultSpeechRate
                if speechSynthesizer.isSpeaking { speechSynthesizer.stopSpeaking(at: .immediate) }
                speechSynthesizer.speak(utterance)
            }
        }.resume()
    }

    // MARK: - Fall check (battery-efficient IMU burst)

    /// Battery-efficient fall detection check for the ZeroClaw safety skill.
    ///
    /// Design:
    ///   1. Query CMMotionActivityManager for the most recent activity.
    ///      If the user is running, cycling, or in a vehicle → return immediately
    ///      with fall_detected=false and a long next_check_secs (60s).  No IMU
    ///      hardware is activated — zero extra battery draw.
    ///   2. If stationary or walking → run a 2-second accelerometer burst at 50 Hz.
    ///      Compute the peak resultant acceleration (in g).
    ///   3. A peak > 3g is a candidate fall.  Return the result plus a short
    ///      next_check_secs (10s) so the caller knows to check again soon.
    ///
    /// Response fields:
    ///   fall_detected   bool    — peak_g exceeded the 3g threshold
    ///   peak_g          Double  — highest resultant acceleration seen in the burst
    ///   activity        String  — stationary|walking|running|cycling|automotive|unknown
    ///   skipped         bool    — true if IMU was not run (high-motion activity gated it)
    ///   next_check_secs Int     — suggested interval before calling again
    private func fallCheck(conn: NWConnection) {
        guard !imuBusy else {
            sendJSON(conn: conn, obj: ["error": "imu busy, try again"], status: 429); return
        }

        // Step 1 — query activity manager first to gate the IMU burst.
        guard CMMotionActivityManager.isActivityAvailable() else {
            // No activity manager (iPod touch etc.) — fall through to raw burst.
            runFallBurst(conn: conn, activity: "unknown")
            return
        }

        let actStart = Date(timeIntervalSinceNow: -5)
        motionActivityManager.queryActivityStarting(from: actStart, to: Date(), to: .main) { [weak self] activities, _ in
            guard let self else { return }
            let activity = activities?.last
            let label: String
            let highMotion: Bool
            if let a = activity {
                if      a.automotive { label = "automotive"; highMotion = true  }
                else if a.cycling    { label = "cycling";    highMotion = true  }
                else if a.running    { label = "running";    highMotion = true  }
                else if a.walking    { label = "walking";    highMotion = false }
                else                 { label = "stationary"; highMotion = false }
            } else {
                label = "unknown"; highMotion = false
            }

            if highMotion {
                // High-motion: skip the IMU entirely — fall detection is meaningless
                // and continuous accelerometer use would drain battery fast.
                logActivity(capability: "motion", action: "fall_check",
                            outcome: "skipped (\(label))")
                sendJSON(conn: conn, obj: [
                    "fall_detected":   false,
                    "peak_g":          0.0,
                    "activity":        label,
                    "skipped":         true,
                    "next_check_secs": 60,
                ])
            } else {
                runFallBurst(conn: conn, activity: label)
            }
        }
    }

    /// Runs a 2-second 50 Hz accelerometer burst and checks for peak > 3g.
    private func runFallBurst(conn: NWConnection, activity: String) {
        guard motionManager.isAccelerometerAvailable else {
            sendJSON(conn: conn, obj: [
                "fall_detected": false, "peak_g": 0.0,
                "activity": activity, "skipped": true,
                "next_check_secs": 30,
            ]); return
        }
        imuBusy = true

        var peakG: Double = 0.0
        let lock = NSLock()
        motionManager.accelerometerUpdateInterval = 1.0 / 50.0
        motionManager.startAccelerometerUpdates(to: OperationQueue()) { data, _ in
            guard let data else { return }
            let g = sqrt(
                data.acceleration.x * data.acceleration.x +
                data.acceleration.y * data.acceleration.y +
                data.acceleration.z * data.acceleration.z
            )
            lock.lock(); if g > peakG { peakG = g }; lock.unlock()
        }

        DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) { [weak self] in
            guard let self else { return }
            motionManager.stopAccelerometerUpdates()
            imuBusy = false

            lock.lock(); let peak = peakG; lock.unlock()
            let fallDetected = peak > 3.0
            // Back off longer if nothing detected; check sooner after a candidate.
            let nextCheck = fallDetected ? 5 : 10
            logActivity(capability: "motion", action: "fall_check",
                        outcome: fallDetected ? "candidate (peak \(String(format:"%.2f",peak))g)" : "clear")
            sendJSON(conn: conn, obj: [
                "fall_detected":   fallDetected,
                "peak_g":          peak,
                "activity":        activity,
                "skipped":         false,
                "next_check_secs": nextCheck,
            ])
        }
    }

    // MARK: - Permissions summary

    private func readPermissions(conn: NWConnection) {
        var result: [String: String] = [:]

        switch CLLocationManager.authorizationStatus() {
        case .authorizedAlways:       result["location"] = "authorized_always"
        case .authorizedWhenInUse:    result["location"] = "authorized_when_in_use"
        case .denied:                 result["location"] = "denied"
        case .restricted:             result["location"] = "restricted"
        case .notDetermined:          result["location"] = "not_determined"
        @unknown default:             result["location"] = "unknown"
        }

        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized:    result["contacts"] = "authorized"
        case .denied:        result["contacts"] = "denied"
        case .restricted:    result["contacts"] = "restricted"
        case .notDetermined: result["contacts"] = "not_determined"
        @unknown default:    result["contacts"] = "unknown"
        }

        switch EKEventStore.authorizationStatus(for: .event) {
        case .authorized:    result["calendar"] = "authorized"
        case .denied:        result["calendar"] = "denied"
        case .restricted:    result["calendar"] = "restricted"
        case .notDetermined: result["calendar"] = "not_determined"
        default:             result["calendar"] = "authorized"
        }

        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:    result["camera"] = "authorized"
        case .denied:        result["camera"] = "denied"
        case .restricted:    result["camera"] = "restricted"
        case .notDetermined: result["camera"] = "not_determined"
        @unknown default:    result["camera"] = "unknown"
        }

        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:    result["microphone"] = "authorized"
        case .denied:        result["microphone"] = "denied"
        case .restricted:    result["microphone"] = "restricted"
        case .notDetermined: result["microphone"] = "not_determined"
        @unknown default:    result["microphone"] = "unknown"
        }

        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized:    result["photos"] = "authorized"
        case .limited:       result["photos"] = "limited"
        case .denied:        result["photos"] = "denied"
        case .restricted:    result["photos"] = "restricted"
        case .notDetermined: result["photos"] = "not_determined"
        @unknown default:    result["photos"] = "unknown"
        }

        result["motion"] = CMMotionActivityManager.isActivityAvailable() ? "available" : "unavailable"

        let notifSema = DispatchSemaphore(value: 0)
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .authorized:    result["notifications"] = "authorized"
            case .provisional:   result["notifications"] = "provisional"
            case .ephemeral:     result["notifications"] = "ephemeral"
            case .denied:        result["notifications"] = "denied"
            case .notDetermined: result["notifications"] = "not_determined"
            @unknown default:    result["notifications"] = "unknown"
            }
            notifSema.signal()
        }
        _ = notifSema.wait(timeout: .now() + 3)

        logActivity(capability: "battery", action: "read_permissions", outcome: "ok")
        sendJSON(conn: conn, obj: result)
    }

    // MARK: - Audio profile

    private func readAudioProfile(conn: NWConnection) {
        let session = AVAudioSession.sharedInstance()
        let outputs = session.currentRoute.outputs.map { $0.portType.rawValue }
        let inputs  = session.currentRoute.inputs.map  { $0.portType.rawValue }
        sendJSON(conn: conn, obj: [
            "category":      session.category.rawValue,
            "mode":          session.mode.rawValue,
            "output_routes": outputs,
            "input_routes":  inputs,
            "output_volume": session.outputVolume,
        ])
    }

    private func setAudioProfile(conn: NWConnection, body: String) {
        guard let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rawCategory = json["category"] as? String else {
            sendJSON(conn: conn, obj: ["error": "missing required field: category"]); return
        }
        let category: AVAudioSession.Category
        switch rawCategory {
        case "ambient":       category = .ambient
        case "soloAmbient":   category = .soloAmbient
        case "playback":      category = .playback
        case "record":        category = .record
        case "playAndRecord": category = .playAndRecord
        case "multiRoute":    category = .multiRoute
        default:
            sendJSON(conn: conn, obj: ["error": "unknown category: \(rawCategory)"]); return
        }
        do {
            try AVAudioSession.sharedInstance().setCategory(category)
            logActivity(capability: "tts", action: "set_audio_profile", outcome: rawCategory)
            sendJSON(conn: conn, obj: ["ok": true, "category": rawCategory])
        } catch {
            sendJSON(conn: conn, obj: ["error": error.localizedDescription])
        }
    }

    // MARK: - HTTP helpers

    private func sendJSON(conn: NWConnection, obj: Any, status: Int = 200) {
        let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"error\":\"serialize\"}".utf8)
        let body = String(data: data, encoding: .utf8) ?? "{}"
        sendResponse(conn: conn, status: status, body: body)
    }

    private func sendResponse(conn: NWConnection, status: Int, body: String) {
        let reason: String
        switch status {
        case 200: reason = "OK"
        case 400: reason = "Bad Request"
        case 401: reason = "Unauthorized"
        case 403: reason = "Forbidden"
        case 404: reason = "Not Found"
        case 405: reason = "Method Not Allowed"
        case 413: reason = "Payload Too Large"
        case 429: reason = "Too Many Requests"
        default: reason = "Internal Server Error"
        }
        let resp = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
        conn.send(content: resp.data(using: .utf8), completion: .contentProcessed { _ in
            conn.cancel()
        })
    }
}

// MARK: - HKWorkoutActivityType name helper

extension HKWorkoutActivityType {
    fileprivate var name: String {
        switch self {
        case .running:          return "Running"
        case .walking:          return "Walking"
        case .cycling:          return "Cycling"
        case .swimming:         return "Swimming"
        case .hiking:           return "Hiking"
        case .yoga:             return "Yoga"
        case .functionalStrengthTraining: return "Strength Training"
        case .highIntensityIntervalTraining: return "HIIT"
        case .soccer:           return "Soccer"
        case .basketball:       return "Basketball"
        case .tennis:           return "Tennis"
        case .golf:             return "Golf"
        case .rowing:           return "Rowing"
        case .elliptical:       return "Elliptical"
        case .stairClimbing:    return "Stair Climbing"
        case .crossTraining:    return "Cross Training"
        case .dance:            return "Dance"
        case .pilates:          return "Pilates"
        case .mixedCardio:      return "Mixed Cardio"
        case .other:            return "Other"
        default:                return "Workout(\(rawValue))"
        }
    }
}

// MARK: - Photo capture delegate

private class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
    private let completion: (Data?) -> Void
    init(completion: @escaping (Data?) -> Void) { self.completion = completion }
    func photoOutput(_ output: AVCapturePhotoOutput,
                     didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        completion(error == nil ? photo.fileDataRepresentation() : nil)
    }
}

// MARK: - Ed25519 signing helper (emergency relay auth)

/// Sign `data` with the agent Ed25519 identity key stored as base58 (seed bytes).
/// Returns 64-byte signature as lowercase hex, or nil on any error.
private func ed25519SignBridge(data: Data, base58Key: String) -> String? {
    guard let keyBytes = base58DecodeBridge(base58Key), keyBytes.count >= 32 else { return nil }
    let seed = Data(keyBytes.prefix(32))
    guard let privateKey = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) else { return nil }
    guard let sig = try? privateKey.signature(for: data) else { return nil }
    return sig.map { String(format: "%02x", $0) }.joined()
}

private func base58DecodeBridge(_ s: String) -> [UInt8]? {
    let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
    var result = [UInt8]()
    for char in s {
        guard let idx = alphabet.firstIndex(of: char) else { return nil }
        var carry = idx
        for i in stride(from: result.count - 1, through: 0, by: -1) {
            carry += 58 * Int(result[i])
            result[i] = UInt8(carry & 0xff)
            carry >>= 8
        }
        while carry > 0 { result.insert(UInt8(carry & 0xff), at: 0); carry >>= 8 }
    }
    let leadingZeros = s.prefix(while: { $0 == "1" }).count
    return Array(repeating: 0, count: leadingZeros) + result.drop(while: { $0 == 0 })
}

// MARK: - Timing-safe comparison

/// XOR-based constant-time string comparison.
/// Swift's `==` short-circuits on first mismatch — timing leak allows oracle attacks
/// against predictable token spaces. This function always runs in O(max(a,b)) time.
private func timingSafeEqual(_ a: String, _ b: String) -> Bool {
    let aBytes = Array(a.utf8)
    let bBytes = Array(b.utf8)
    let len = max(aBytes.count, bBytes.count)
    guard len > 0 else { return aBytes.count == bBytes.count }
    var diff: UInt8 = 0
    for i in 0..<len {
        let x: UInt8 = i < aBytes.count ? aBytes[i] : 0
        let y: UInt8 = i < bBytes.count ? bBytes[i] : 0
        diff |= x ^ y
    }
    // Also catch length differences via a separate flag to avoid early exit.
    let lenDiff: UInt8 = aBytes.count == bBytes.count ? 0 : 1
    return (diff | lenDiff) == 0
}

// MARK: - CLLocationManagerDelegate

extension PhoneBridgeServer: CLLocationManagerDelegate {
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        lastLocation = locations.last
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        NSLog("[BridgeServer] Location error: \(error)")
    }
}
