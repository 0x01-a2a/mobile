import Foundation
import Network
import Contacts
import EventKit
import CoreLocation
import AVFoundation
import HealthKit

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
    private let hkStore = HKHealthStore()

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
        case "/health/steps":
            guard _capabilities["health"] == true else {
                sendJSON(conn: conn, obj: ["error": "capability disabled"])
                return
            }
            readSteps(conn: conn)

        default:
            sendResponse(conn: conn, status: 404, body: #"{"error":"not found"}"#)
        }
    }

    // MARK: - HealthKit

    private func readSteps(conn: NWConnection) {
        guard HKHealthStore.isHealthDataAvailable(),
              let stepType = HKQuantityType.quantityType(forIdentifier: .stepCount) else {
            sendJSON(conn: conn, obj: ["error": "HealthKit unavailable"])
            return
        }
        hkStore.requestAuthorization(toShare: [], read: [stepType]) { [weak self] granted, _ in
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
