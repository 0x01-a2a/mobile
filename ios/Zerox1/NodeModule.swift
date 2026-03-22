import Foundation
import React
import UserNotifications
import AVFoundation
import Contacts
import EventKit
import CoreLocation

@objc(ZeroxNodeModule)
class NodeModule: RCTEventEmitter {

    // MARK: - RCTEventEmitter

    override static func requiresMainQueueSetup() -> Bool { false }

    override func supportedEvents() -> [String] {
        ["nodeStatus", "updateProgress"]
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
        NodeService.shared.stop()
        resolve(nil)
    }

    @objc func isRunning(_ resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
        resolve(NodeService.shared.isRunning)
    }

    @objc func getLocalAuthConfig(_ resolve: @escaping RCTPromiseResolveBlock,
                                  rejecter reject: @escaping RCTPromiseRejectBlock) {
        let token = KeychainHelper.load(key: "node_api_token")
        let gateway = KeychainHelper.load(key: "gateway_token")
        resolve([
            "nodeApiToken": token as Any,
            "gatewayToken": gateway as Any,
            "heliusApiKey": NSNull(),
        ])
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
        UserDefaults.standard.set(provider, forKey: "zerox1_llm_provider")
        UserDefaults.standard.set(model, forKey: "zerox1_llm_model")
        UserDefaults.standard.set(baseUrl, forKey: "zerox1_llm_base_url")
        resolve(nil)
    }

    @objc func reloadAgent(_ resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
        NodeService.shared.reloadAgent()
        resolve(nil)
    }

    // MARK: - Identity Key

    @objc func exportIdentityKey(_ resolve: @escaping RCTPromiseResolveBlock,
                                 rejecter reject: @escaping RCTPromiseRejectBlock) {
        if let key = KeychainHelper.load(key: "identity_key") {
            resolve(key)
        } else {
            reject("NO_KEY", "No identity key stored", nil)
        }
    }

    @objc func importIdentityKey(_ base58Key: String,
                                 resolver resolve: @escaping RCTPromiseResolveBlock,
                                 rejecter reject: @escaping RCTPromiseRejectBlock) {
        KeychainHelper.save(base58Key, key: "identity_key")
        resolve(nil)
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

        // Notifications
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
            // CLLocationManager authorization is asynchronous via delegate; cannot await inline.
            // We trigger the request and resolve on the main queue after the system prompt.
            let mgr = CLLocationManager()
            mgr.requestWhenInUseAuthorization()
            // Resolve optimistically — the JS layer should re-check via checkPermissions().
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                resolve(mgr.authorizationStatus == .authorizedWhenInUse ||
                        mgr.authorizationStatus == .authorizedAlways)
            }
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
        case "notifications":
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                resolve(granted)
            }
        default:
            resolve(false)
        }
    }

    // MARK: - Notifications

    @objc func showChatNotification(_ body: String,
                                    resolver resolve: @escaping RCTPromiseResolveBlock,
                                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        let content = UNMutableNotificationContent()
        content.title = "0x01 Agent"
        content.body = body
        content.sound = .default
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
        resolve(nil)
    }

    // MARK: - Security

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
            let notes = json["body"] as? String ?? ""
            let published = json["published_at"] as? String ?? ""
            resolve([
                "hasUpdate": tag > currentVersion,
                "currentVersion": currentVersion,
                "latestVersion": tag,
                "downloadUrl": "",   // iOS — no APK
                "releaseNotes": notes,
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
        // Forward to bridge server which tracks pending actions
        PhoneBridgeServer.shared.resolveScreenAction(id: actionId, approved: approved)
        resolve(nil)
    }

    // Battery opt exemption — no-op on iOS
    @objc func requestBatteryOptExemption(_ resolve: @escaping RCTPromiseResolveBlock,
                                          rejecter reject: @escaping RCTPromiseRejectBlock) {
        resolve(nil)
    }

    // MARK: - Event emission

    func emitNodeStatus(_ status: String, detail: String = "") {
        sendEvent(withName: "nodeStatus", body: ["status": status, "detail": detail])
    }
}
