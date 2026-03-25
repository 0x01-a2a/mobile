import Foundation
import Network
import Contacts
import EventKit
import CoreLocation
import AVFoundation
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
    private var _capabilities: [String: Bool] = [
        "location": true, "contacts": true, "calendar": true,
        "camera": true, "microphone": true, "media": true,
        "health": true, "notifications_read": true,
    ]
    private let locationManager = CLLocationManager()
    private var lastLocation: CLLocation?
    #if canImport(HealthKit)
    private let hkStore = HKHealthStore()
    #endif

    // MARK: - Start / Stop

    func start(token: String) {
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

    private var pendingScreenActions: [String: CheckedContinuation<Bool, Never>] = [:]

    func resolveScreenAction(id: String, approved: Bool) {
        // No-op on iOS (limited screen access)
    }

    // MARK: - HTTP connection handling

    private func handleConnection(_ conn: NWConnection) {
        conn.start(queue: .global(qos: .utility))
        receiveRequest(conn: conn)
    }

    private func receiveRequest(conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, err in
            guard let self, let data, !data.isEmpty else { return }
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
        let path = String(parts[1]).components(separatedBy: "?")[0]

        // Auth check — constant-time comparison to prevent timing-based token oracle attacks.
        let authLine = lines.first(where: { $0.lowercased().hasPrefix("authorization:") }) ?? ""
        let token = authLine.replacingOccurrences(of: "Authorization: Bearer ", with: "",
                                                    options: .caseInsensitive).trimmingCharacters(in: .whitespaces)
        guard timingSafeEqual(token, bridgeToken) else {
            sendResponse(conn: conn, status: 401, body: #"{"error":"unauthorized"}"#)
            return
        }

        // Body
        let bodyMarker = raw.range(of: "\r\n\r\n")
        let body = bodyMarker.map { String(raw[raw.index($0.upperBound, offsetBy: 0)...]) } ?? ""

        route(method: method, path: path, body: body, conn: conn)
    }

    private func route(method: String, path: String, body: String, conn: NWConnection) {
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
                locationManager.requestWhenInUseAuthorization()
                locationManager.requestLocation()
                sendJSON(conn: conn, obj: ["error": "location unavailable"])
            }

        // ── Contacts ────────────────────────────────────────────────────────
        case "/contacts":
            guard _capabilities["contacts"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"])
                return
            }
            let store = CNContactStore()
            let keys = [CNContactGivenNameKey, CNContactFamilyNameKey,
                        CNContactPhoneNumbersKey, CNContactEmailAddressesKey] as [CNKeyDescriptor]
            let req = CNFetchRequest(forKeysToFetch: keys)
            var contacts: [[String: Any]] = []
            try? store.enumerateContacts(with: req) { contact, _ in
                contacts.append([
                    "name": "\(contact.givenName) \(contact.familyName)".trimmingCharacters(in: .whitespaces),
                    "phones": contact.phoneNumbers.map { $0.value.stringValue },
                    "emails": contact.emailAddresses.map { $0.value as String },
                ])
            }
            logActivity(capability: "contacts", action: "read", outcome: "\(contacts.count) contacts")
            sendJSON(conn: conn, obj: ["contacts": contacts, "count": contacts.count])

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
            UIDevice.current.isBatteryMonitoringEnabled = true
            let level = UIDevice.current.batteryLevel
            let charging = UIDevice.current.batteryState == .charging || UIDevice.current.batteryState == .full
            sendJSON(conn: conn, obj: [
                "level": level >= 0 ? Int(level * 100) : -1,
                "charging": charging,
            ])

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
        #endif

        default:
            sendResponse(conn: conn, status: 404, body: #"{"error":"not found"}"#)
        }
    }

    // MARK: - HealthKit

    #if canImport(HealthKit)
    /// All HK types this bridge may read — used for bulk authorization.
    private var allHealthReadTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = []
        let quantityIds: [HKQuantityTypeIdentifier] = [
            .stepCount, .heartRate, .heartRateVariabilitySDNN,
            .oxygenSaturation, .activeEnergyBurned,
        ]
        for id in quantityIds {
            if let t = HKQuantityType.quantityType(forIdentifier: id) { types.insert(t) }
        }
        if let sleep = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis) { types.insert(sleep) }
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
                                      limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { [weak self] _, samples, _ in
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
                                      limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, samples, _ in
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
    #endif

    // MARK: - HTTP helpers

    private func sendJSON(conn: NWConnection, obj: Any) {
        let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"error\":\"serialize\"}".utf8)
        let body = String(data: data, encoding: .utf8) ?? "{}"
        sendResponse(conn: conn, status: 200, body: body)
    }

    private func sendResponse(conn: NWConnection, status: Int, body: String) {
        let resp = "HTTP/1.1 \(status) OK\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
        conn.send(content: resp.data(using: .utf8), completion: .contentProcessed { _ in
            conn.cancel()
        })
    }
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
