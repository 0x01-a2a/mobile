import Foundation
import React
import UserNotifications
import AVFoundation
import Contacts
import EventKit
import CoreLocation
import CoreMotion
import HealthKit
import Photos
import CoreBluetooth
import ActivityKit
import LocalAuthentication

@objc(ZeroxNodeModule)
class NodeModule: RCTEventEmitter {

    // MARK: - Class-level properties

    private var lastNotificationTime: Date = .distantPast
    private var locationManager: CLLocationManager?
    private var locationPermissionResolver: RCTPromiseResolveBlock?

    // MARK: - Private helpers

    private func isValidBase58Key(_ s: String) -> Bool {
        let alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
        guard s.count >= 44 && s.count <= 88 else { return false }
        return s.allSatisfy { alphabet.contains($0) }
    }

    // MARK: - RCTEventEmitter

    override static func requiresMainQueueSetup() -> Bool { false }

    override func supportedEvents() -> [String] {
        ["nodeStatus", "updateProgress", "screenActionPending"]
    }

    // MARK: - Lifecycle

    @objc func startNode(_ config: [String: Any],
                         resolver resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
        NodeService.shared.start(config: config) { err in
            if let err {
                reject("START_FAILED", err.localizedDescription, err)
            } else {
                resolve(nil)
            }
        }
    }

    @objc func stopNode(_ resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
        NodeService.shared.stop { resolve(nil) }
    }

    @objc func isRunning(_ resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
        resolve(NodeService.shared.isRunning)
    }

    @objc func getLocalAuthConfig(_ resolve: @escaping RCTPromiseResolveBlock,
                                  rejecter reject: @escaping RCTPromiseRejectBlock) {
        let token = KeychainHelper.load(key: "node_api_token")
        let gateway = KeychainHelper.load(key: "gateway_token")
        let lastCfg = NodeService.shared.lastConfig
        let brainCfgEnabled = (lastCfg["agentBrainEnabled"] as? NSNumber)?.boolValue ?? false
        let llmKeyInChain = KeychainHelper.load(key: "llm_api_key") != nil
        let payload: [String: Any] = [
            "nodeApiToken": token as Any,
            "gatewayToken": gateway as Any,
            "heliusApiKey": NSNull(),
            "agentRunning": NodeService.shared.isAgentRunning,
            "nodeRunning": NodeService.shared.isRunning,
            "brainError": NodeService.shared.lastBrainError as Any,
            "_dbg_brainCfgEnabled": brainCfgEnabled,
            "_dbg_llmKeyInChain": llmKeyInChain,
        ]
        os_log(.error, "[NodeService] getLocalAuthConfig — agentRunning=%{public}@, brainCfgEnabled=%{public}@, llmKeyInChain=%{public}@",
               String(NodeService.shared.isAgentRunning), String(brainCfgEnabled), String(llmKeyInChain))
        NSLog("[NodeModule] getLocalAuthConfig payload: %@", String(describing: payload))
        print("[NodeModule] getLocalAuthConfig payload: \(payload)")
        resolve(payload)
    }

    // MARK: - LLM Key / Brain Config

    @objc func saveLlmApiKey(_ key: String,
                             resolver resolve: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
        KeychainHelper.save(key, key: "llm_api_key")
        resolve(nil)
    }

    @objc func updateBrainConfig(_ provider: String,
                                 model: String,
                                 baseUrl: String,
                                 resolver resolve: @escaping RCTPromiseResolveBlock,
                                 rejecter reject: @escaping RCTPromiseRejectBlock) {
        if !baseUrl.isEmpty {
            guard let url = URL(string: baseUrl),
                  let scheme = url.scheme?.lowercased(),
                  (scheme == "https" || (scheme == "http" && (url.host == "127.0.0.1" || url.host == "localhost"))),
                  url.host != nil else {
                reject("INVALID_URL", "baseUrl must be https:// or http://localhost", nil)
                return
            }
        }
        UserDefaults.standard.set(provider, forKey: "zerox1_llm_provider")
        UserDefaults.standard.set(model, forKey: "zerox1_llm_model")
        UserDefaults.standard.set(baseUrl, forKey: "zerox1_llm_base_url")
        resolve(nil)
    }

    @objc func reloadAgent(_ resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
        NSLog("[NodeModule] reloadAgent called")
        print("[NodeModule] reloadAgent called")
        NodeService.shared.reloadAgent()
        resolve(nil)
    }

    /// Starts zeroclaw directly when the node is already running but the brain is not.
    /// Pass the same brain config keys as startNode (agentBrainEnabled, llmProvider, etc.).
    @objc func startBrainIfNeeded(_ config: [String: Any],
                                  resolver resolve: @escaping RCTPromiseResolveBlock,
                                  rejecter reject: @escaping RCTPromiseRejectBlock) {
        NSLog("[NodeModule] startBrainIfNeeded called with config: %@", String(describing: config))
        print("[NodeModule] startBrainIfNeeded called with config: \(config)")
        NodeService.shared.startBrainIfNeeded(config: config)
        resolve(nil)
    }

    // MARK: - Identity Key

    @objc func exportIdentityKey(_ resolve: @escaping RCTPromiseResolveBlock,
                                 rejecter reject: @escaping RCTPromiseRejectBlock) {
        let context = LAContext()
        var authError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authError) else {
            reject("AUTH_UNAVAILABLE", "Device authentication not available", nil)
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication,
                                localizedReason: "Authenticate to export your agent identity key") { success, error in
            if success {
                if let key = KeychainHelper.load(key: "identity_key") {
                    resolve(key)
                } else {
                    reject("NOT_FOUND", "Identity key not found", nil)
                }
            } else {
                reject("AUTH_FAILED", error?.localizedDescription ?? "Authentication failed", nil)
            }
        }
    }

    @objc func importIdentityKey(_ base58Key: String,
                                 resolver resolve: @escaping RCTPromiseResolveBlock,
                                 rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard isValidBase58Key(base58Key) else {
            reject("INVALID_KEY", "Key must be valid base58 (44–88 chars)", nil)
            return
        }
        let context = LAContext()
        var authError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authError) else {
            reject("AUTH_UNAVAILABLE", "Device authentication not available", nil)
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication,
                                localizedReason: "Authenticate to import a new agent identity key") { success, error in
            if success {
                KeychainHelper.save(base58Key, key: "identity_key")
                resolve(nil)
            } else {
                reject("AUTH_FAILED", error?.localizedDescription ?? "Authentication failed", nil)
            }
        }
    }

    // MARK: - Bridge Capabilities

    @objc func getBridgeCapabilities(_ resolve: @escaping RCTPromiseResolveBlock,
                                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        let caps = PhoneBridgeServer.shared.capabilities
        resolve(caps)
    }

    @objc func setBridgeCapability(_ capability: String,
                                   enabled: Bool,
                                   resolver resolve: @escaping RCTPromiseResolveBlock,
                                   rejecter reject: @escaping RCTPromiseRejectBlock) {
        PhoneBridgeServer.shared.setCapability(capability, enabled: enabled)
        resolve(nil)
    }

    @objc func getBridgeActivityLog(_ limit: NSNumber,
                                    resolver resolve: @escaping RCTPromiseResolveBlock,
                                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        let log = PhoneBridgeServer.shared.activityLog(limit: limit.intValue)
        resolve(log)
    }

    // MARK: - Data Budget

    @objc func setDataBudget(_ levelPct: NSNumber,
                             resolver resolve: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
        UserDefaults.standard.set(levelPct.intValue, forKey: "zerox1_data_budget")
        resolve(nil)
    }

    @objc func getDataBudget(_ resolve: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
        let val = UserDefaults.standard.integer(forKey: "zerox1_data_budget")
        resolve(val == 0 ? 100 : val)
    }

    // MARK: - Permissions

    @objc func checkPermissions(_ resolve: @escaping RCTPromiseResolveBlock,
                                rejecter reject: @escaping RCTPromiseRejectBlock) {
        var result: [String: Bool] = [:]

        // Location — use instance property (CLLocationManager.authorizationStatus() is deprecated iOS 14+)
        let locStatus = CLLocationManager().authorizationStatus
        result["location"] = locStatus == .authorizedWhenInUse || locStatus == .authorizedAlways

        // Contacts
        result["contacts"] = CNContactStore.authorizationStatus(for: .contacts) == .authorized

        // Calendar
        if #available(iOS 17.0, *) {
            result["calendar"] = EKEventStore.authorizationStatus(for: .event) == .fullAccess
        } else {
            result["calendar"] = EKEventStore.authorizationStatus(for: .event) == .authorized
        }

        // Camera
        result["camera"] = AVCaptureDevice.authorizationStatus(for: .video) == .authorized

        // Microphone
        result["microphone"] = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized

        // Photos
        result["photos"] = PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized

        // Motion (CMMotionActivityManager — no runtime auth check needed; just report based on MDMRestriction)
        result["motion"] = CMMotionActivityManager.isActivityAvailable()

        // Health
        let hkStatus = HKHealthStore.isHealthDataAvailable()
            ? HKHealthStore().authorizationStatus(for: HKObjectType.quantityType(forIdentifier: .stepCount)!) != .notDetermined
            : false
        result["health"] = hkStatus

        // Bluetooth
        result["bluetooth"] = CBCentralManager.authorization == .allowedAlways

        // TTS — AVSpeechSynthesizer needs no OS permission
        result["tts"] = true

        // Wearables — reflect BT auth
        result["wearables"] = CBCentralManager.authorization == .allowedAlways

        // Live Activity — no runtime permission dialog; always available when entitlement present
        if #available(iOS 16.2, *) {
            result["live_activity"] = true
        } else {
            result["live_activity"] = false
        }

        // Clinical records — check HK auth for at least one clinical type
        #if canImport(HealthKit)
        if HKHealthStore.isHealthDataAvailable(),
           let allergyType = HKObjectType.clinicalType(forIdentifier: .allergyRecord) {
            let clinicalStatus = HKHealthStore().authorizationStatus(for: allergyType)
            result["clinical_records"] = clinicalStatus == .sharingAuthorized
        } else {
            result["clinical_records"] = false
        }
        #else
        result["clinical_records"] = false
        #endif

        // Notifications (async — must resolve here)
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            result["notifications_read"] = settings.authorizationStatus == .authorized
            resolve(result)
        }
    }

    @objc func requestPermission(_ permission: String,
                                 resolver resolve: @escaping RCTPromiseResolveBlock,
                                 rejecter reject: @escaping RCTPromiseRejectBlock) {
        switch permission {
        case "location":
            let mgr = CLLocationManager()
            mgr.delegate = self
            locationManager = mgr
            locationPermissionResolver = resolve
            DispatchQueue.main.async {
                mgr.requestWhenInUseAuthorization()
            }
            // Do NOT call resolver here — it will be called from the delegate
            return
        case "contacts":
            CNContactStore().requestAccess(for: .contacts) { granted, _ in resolve(granted) }
        case "camera":
            AVCaptureDevice.requestAccess(for: .video) { resolve($0) }
        case "microphone":
            AVCaptureDevice.requestAccess(for: .audio) { resolve($0) }
        case "calendar":
            let ekStore = EKEventStore()
            if #available(iOS 17.0, *) {
                ekStore.requestFullAccessToEvents { granted, _ in resolve(granted) }
            } else {
                ekStore.requestAccess(to: .event) { granted, _ in resolve(granted) }
            }
        case "notifications", "notifications_read":
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                resolve(granted)
            }
        case "photos":
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
                resolve(status == .authorized || status == .limited)
            }
        case "motion":
            // CoreMotion has no explicit permission dialog — open Settings instead
            DispatchQueue.main.async { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) }
            resolve(false)
        case "health":
            guard HKHealthStore.isHealthDataAvailable() else { resolve(false); return }
            let types: Set<HKObjectType> = [
                HKObjectType.quantityType(forIdentifier: .stepCount)!,
                HKObjectType.quantityType(forIdentifier: .heartRate)!,
                HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!,
            ]
            HKHealthStore().requestAuthorization(toShare: nil, read: types) { granted, _ in resolve(granted) }
        case "bluetooth", "wearables":
            // Bluetooth permission is declared in Info.plist; trigger CBCentralManager init to prompt
            DispatchQueue.main.async { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) }
            resolve(false)
        case "tts":
            // AVSpeechSynthesizer needs no OS permission
            resolve(true)
        case "live_activity":
            // Live Activities are enabled/disabled by user in Settings; no runtime dialog
            resolve(true)
        case "clinical_records":
            #if canImport(HealthKit)
            guard HKHealthStore.isHealthDataAvailable() else { resolve(false); return }
            var clinicalTypes = Set<HKObjectType>()
            for typeId: HKClinicalTypeIdentifier in [.allergyRecord, .labResultRecord, .medicationRecord] {
                if let ct = HKObjectType.clinicalType(forIdentifier: typeId) { clinicalTypes.insert(ct) }
            }
            HKHealthStore().requestAuthorization(toShare: nil, read: clinicalTypes) { granted, _ in resolve(granted) }
            return
            #else
            resolve(false)
            #endif
        default:
            resolve(false)
        }
    }

    // MARK: - Notifications

    @objc func showChatNotification(_ body: String,
                                    resolver resolve: @escaping RCTPromiseResolveBlock,
                                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard body.count <= 256 else {
            reject("TOO_LONG", "Notification body must be ≤ 256 characters", nil)
            return
        }
        let now = Date()
        guard now.timeIntervalSince(lastNotificationTime) >= 60 else {
            reject("RATE_LIMITED", "Notification rate limit: 1 per 60 seconds", nil)
            return
        }
        lastNotificationTime = now
        let content = UNMutableNotificationContent()
        content.title = "0x01 Agent"
        content.body = body
        content.sound = .default
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
        resolve(nil)
    }

    // MARK: - Security

    /// NOTE: setWindowSecure is best-effort UI protection only. It adds a black overlay
    /// to obscure on-screen content but does NOT block iOS screen recording via ReplayKit
    /// or AirPlay mirroring. Apple's sandbox does not expose FLAG_SECURE equivalents to
    /// third-party apps. Sensitive data should never be assumed safe from screen capture on iOS.
    @objc func setWindowSecure(_ enabled: Bool,
                               resolver resolve: @escaping RCTPromiseResolveBlock,
                               rejecter reject: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            // Use connectedScenes API (UIApplication.shared.windows is deprecated iOS 15+).
            let window = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap { $0.windows }
                .first(where: { $0.isKeyWindow })

            // iOS doesn't support FLAG_SECURE; add a black overlay to prevent screen capture.
            if enabled {
                let overlay = UIView(frame: UIScreen.main.bounds)
                overlay.backgroundColor = .black
                overlay.tag = 9999
                window?.addSubview(overlay)
                // Do NOT disable isUserInteractionEnabled — that would lock the user out.
            } else {
                window?.viewWithTag(9999)?.removeFromSuperview()
            }
            resolve(nil)
        }
    }

    // MARK: - Updates (iOS — no APK, links to TestFlight/App Store)

    private func semverGreaterThan(_ a: String, _ b: String) -> Bool {
        let aParts = a.split(separator: ".").compactMap { Int($0) }
        let bParts = b.split(separator: ".").compactMap { Int($0) }
        let count = max(aParts.count, bParts.count)
        for i in 0..<count {
            let av = i < aParts.count ? aParts[i] : 0
            let bv = i < bParts.count ? bParts[i] : 0
            if av != bv { return av > bv }
        }
        return false
    }

    @objc func checkForUpdate(_ resolve: @escaping RCTPromiseResolveBlock,
                              rejecter reject: @escaping RCTPromiseRejectBlock) {
        let currentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        let url = URL(string: "https://api.github.com/repos/0x01-a2a/mobile/releases/latest")!
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                resolve(["hasUpdate": false, "currentVersion": currentVersion, "latestVersion": currentVersion,
                         "downloadUrl": "", "releaseNotes": "", "publishedAt": ""])
                return
            }
            let tag = (json["tag_name"] as? String ?? "v0").replacingOccurrences(of: "v", with: "")
            let sanitizedNotes = String((json["body"] as? String ?? "").prefix(2000))
            let published = json["published_at"] as? String ?? ""
            resolve([
                "hasUpdate": self.semverGreaterThan(tag, currentVersion),
                "currentVersion": currentVersion,
                "latestVersion": tag,
                "downloadUrl": "",   // iOS — no APK
                "releaseNotes": sanitizedNotes,
                "publishedAt": published,
            ])
        }.resume()
    }

    @objc func downloadAndInstall(_ downloadUrl: String,
                                  resolver resolve: @escaping RCTPromiseResolveBlock,
                                  rejecter reject: @escaping RCTPromiseRejectBlock) {
        // iOS cannot install APKs; open TestFlight / App Store link instead
        if let url = URL(string: "https://testflight.apple.com/join/zerox1") {
            DispatchQueue.main.async { UIApplication.shared.open(url) }
        }
        resolve(nil)
    }

    // MARK: - Blob upload

    @objc func uploadBlob(_ dataBase64: String,
                          mimeType: String,
                          resolver resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard dataBase64.count <= 10_000_000 else {
            reject("TOO_LARGE", "Blob exceeds 10 MB limit", nil)
            return
        }
        guard let data = Data(base64Encoded: dataBase64) else {
            reject("INVALID_DATA", "Bad base64", nil)
            return
        }
        var req = URLRequest(url: URL(string: "http://127.0.0.1:9090/blobs")!)
        req.httpMethod = "POST"
        req.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        if let token = KeychainHelper.load(key: "node_api_token") {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = data
        URLSession.shared.dataTask(with: req) { respData, resp, err in
            if let err { reject("UPLOAD_FAILED", err.localizedDescription, err); return }
            guard let respData,
                  let json = try? JSONSerialization.jsonObject(with: respData) as? [String: Any],
                  let cid = json["cid"] as? String else {
                reject("UPLOAD_FAILED", "Bad response", nil)
                return
            }
            resolve(cid)
        }.resume()
    }

    // MARK: - Screen Actions (limited on iOS)

    @objc func confirmScreenAction(_ actionId: String,
                                   approved: Bool,
                                   resolver resolve: @escaping RCTPromiseResolveBlock,
                                   rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard UUID(uuidString: actionId) != nil else {
            reject("INVALID_ID", "actionId must be a valid UUID", nil)
            return
        }
        // Forward to bridge server which tracks pending actions
        PhoneBridgeServer.shared.resolveScreenAction(id: actionId, approved: approved)
        resolve(nil)
    }

    // Battery opt exemption — no-op on iOS
    @objc func requestBatteryOptExemption(_ resolve: @escaping RCTPromiseResolveBlock,
                                          rejecter reject: @escaping RCTPromiseRejectBlock) {
        resolve(nil)
    }

    // MARK: - VoIP Push Token

    @objc func getVoipPushToken(_ resolve: @escaping RCTPromiseResolveBlock,
                                rejecter reject: @escaping RCTPromiseRejectBlock) {
        let token = KeychainHelper.load(key: "voip_push_token")
        resolve(token as Any)
    }

    // MARK: - Presence / Overlay / Screen capture stubs (Android-only features)

    @objc func setPresenceMode(_ enabled: Bool,
                               resolver resolve: @escaping RCTPromiseResolveBlock,
                               rejecter reject: @escaping RCTPromiseRejectBlock) {
        // No-op on iOS — Live Activities are used instead
        resolve(nil)
    }

    @objc func getPresenceMode(_ resolve: @escaping RCTPromiseResolveBlock,
                               rejecter reject: @escaping RCTPromiseRejectBlock) {
        resolve(false)
    }

    @objc func hasOverlayPermission(_ resolve: @escaping RCTPromiseResolveBlock,
                                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        resolve(false)
    }

    @objc func requestOverlayPermission(_ resolve: @escaping RCTPromiseResolveBlock,
                                        rejecter reject: @escaping RCTPromiseRejectBlock) {
        resolve(nil)
    }

    @objc func saveFalApiKey(_ key: String,
                             resolver resolve: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
        KeychainHelper.save(key, key: "fal_api_key")
        resolve(nil)
    }

    @objc func saveReplicateApiKey(_ key: String,
                                   resolver resolve: @escaping RCTPromiseResolveBlock,
                                   rejecter reject: @escaping RCTPromiseRejectBlock) {
        KeychainHelper.save(key, key: "replicate_api_key")
        resolve(nil)
    }

    @objc func requestScreenCapture(_ resolve: @escaping RCTPromiseResolveBlock,
                                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        resolve(nil) // Not available on iOS
    }

    @objc func hasScreenCaptureGrant(_ resolve: @escaping RCTPromiseResolveBlock,
                                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        resolve(false)
    }

    // MARK: - Live Activities (iOS 16.1+)

    @objc func startLiveActivity(_ config: NSDictionary,
                                  resolver resolve: @escaping RCTPromiseResolveBlock,
                                  rejecter reject: @escaping RCTPromiseRejectBlock) {
        if #available(iOS 16.2, *) {
            let agentName = config["agentName"] as? String ?? "Agent"
            let initial = String(agentName.prefix(1)).uppercased()
            let attributes = AgentActivityAttributes(agentName: agentName, agentInitial: initial)
            let state = AgentActivityAttributes.ContentState(
                status: config["status"] as? String ?? "Running",
                currentTask: config["currentTask"] as? String ?? "",
                earnedToday: config["earnedToday"] as? String ?? "$0.00",
                isActive: config["isActive"] as? Bool ?? true
            )
            do {
                let activity = try Activity<AgentActivityAttributes>.request(
                    attributes: attributes,
                    content: .init(state: state, staleDate: nil),
                    pushType: nil
                )
                resolve(activity.id)
            } catch {
                reject("LIVE_ACTIVITY_ERROR", error.localizedDescription, nil)
            }
        } else {
            resolve(nil)
        }
    }

    @objc func updateLiveActivity(_ activityId: NSString,
                                   state stateDict: NSDictionary,
                                   resolver resolve: @escaping RCTPromiseResolveBlock,
                                   rejecter reject: @escaping RCTPromiseRejectBlock) {
        if #available(iOS 16.2, *) {
            Task {
                for activity in Activity<AgentActivityAttributes>.activities {
                    if activity.id == activityId as String {
                        let newState = AgentActivityAttributes.ContentState(
                            status: stateDict["status"] as? String ?? "Running",
                            currentTask: stateDict["currentTask"] as? String ?? "",
                            earnedToday: stateDict["earnedToday"] as? String ?? "$0.00",
                            isActive: stateDict["isActive"] as? Bool ?? true
                        )
                        await activity.update(.init(state: newState, staleDate: nil))
                        break
                    }
                }
                resolve(nil)
            }
        } else {
            resolve(nil)
        }
    }

    @objc func endLiveActivity(_ activityId: NSString,
                                resolver resolve: @escaping RCTPromiseResolveBlock,
                                rejecter reject: @escaping RCTPromiseRejectBlock) {
        if #available(iOS 16.2, *) {
            Task {
                for activity in Activity<AgentActivityAttributes>.activities {
                    if activity.id == activityId as String {
                        await activity.end(nil, dismissalPolicy: .immediate)
                        break
                    }
                }
                resolve(nil)
            }
        } else {
            resolve(nil)
        }
    }

    // MARK: - Event emission

    func emitNodeStatus(_ status: String, detail: String = "") {
        sendEvent(withName: "nodeStatus", body: ["status": status, "detail": detail])
    }
}

// MARK: - CLLocationManagerDelegate

extension NodeModule: CLLocationManagerDelegate {
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        let granted = status == .authorizedWhenInUse || status == .authorizedAlways
        locationPermissionResolver?(granted)
        locationPermissionResolver = nil
    }
}
