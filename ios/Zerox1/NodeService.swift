import Foundation
import UIKit
import CryptoKit
import os.log
private let AGGREGATOR_URL = "https://api.0x01.world"

/// Manages the lifecycle of zerox1-node and zeroclaw running in-process via C FFI.
///
/// iOS kernel sandbox blocks all exec*()/posix_spawn() calls from app processes —
/// the Android-style subprocess model cannot be used. Instead, zerox1-node and zeroclaw
/// are compiled as static libraries (libzerox1_node.a, libzeroclaw.a) targeting
/// aarch64-apple-ios and linked directly into the app binary. Their C entry points
/// (declared in Zerox1-Bridging-Header.h) are called here.
///
/// Rust-side TODO:
///   - node/crates/zerox1-node/src/ffi.rs  → exports zerox1_node_start / zerox1_node_stop
///   - zeroclaw/src/ffi.rs                 → exports zeroclaw_start / zeroclaw_stop
///
/// Background execution:
///   - UIApplication.shared.isIdleTimerDisabled keeps the screen on while running.
///   - BGProcessingTask registered in AppDelegate for brief background continuation.
final class NodeService {

    static let shared = NodeService()

    // MARK: - Constants

    private let nodeAssetVersion = "0.6.0"
    private let agentAssetVersion = "0.3.6"
    private let nodeApiPort = 9090

    // MARK: - State

    private var nodeApiToken: String?
    private var phoneBridgeToken: String = ""
    private var gatewayToken: String = ""
    private var _isNodeRunning = false
    private var _isAgentRunning = false
    private(set) var lastConfig: [String: Any] = [:]
    private(set) var lastBrainError: String? = nil
    /// Hex agent_id of the running node — populated after /identity succeeds.
    /// Persisted in UserDefaults so it is available across restarts.
    private(set) var lastAgentId: String? {
        get { UserDefaults.standard.string(forKey: "zerox1_agent_id") }
        set { UserDefaults.standard.set(newValue, forKey: "zerox1_agent_id") }
    }
    private let queue = DispatchQueue(label: "world.zerox1.nodeservice", qos: .userInitiated)
    private let stateLock = NSLock()

    private var isNodeRunning: Bool {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _isNodeRunning }
        set { stateLock.lock(); _isNodeRunning = newValue; stateLock.unlock() }
    }

    var isAgentRunning: Bool {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _isAgentRunning }
        set { stateLock.lock(); _isAgentRunning = newValue; stateLock.unlock() }
    }

    var isRunning: Bool {
        stateLock.lock(); defer { stateLock.unlock() }; return _isNodeRunning
    }

    // MARK: - Directories

    private var dataDir: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("zerox1-data", isDirectory: true)
    }

    /// Exposed to NodeModule so JS can write/remove zeroclaw.busy without reaching into private state.
    var dataDirPublic: URL? {
        isNodeRunning ? dataDir : nil
    }

    /// Path to the zeroclaw agent log file, always resolved (not gated on running state).
    var logFilePath: String? {
        let path = dataDir.appendingPathComponent("zeroclaw_ffi.log").path
        return FileManager.default.fileExists(atPath: path) ? path : nil
    }

    private var zeroclawConfigDir: URL {
        dataDir.appendingPathComponent("zeroclaw")
    }

    private func setupDirectories(agentName: String) throws {
        try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: zeroclawConfigDir, withIntermediateDirectories: true)
        try writeSoulMd(agentName: agentName)
        try writeBundledSkills()
    }

    private func writeBundledSkills() throws {
        let skillsRoot = zeroclawWorkspaceDir.appendingPathComponent("skills", isDirectory: true)
        try FileManager.default.createDirectory(at: skillsRoot, withIntermediateDirectories: true)

        let safetyDir = skillsRoot.appendingPathComponent("safety", isDirectory: true)
        try FileManager.default.createDirectory(at: safetyDir, withIntermediateDirectories: true)
        let safetyPath = safetyDir.appendingPathComponent("SKILL.toml")
        // Always overwrite — this is a machine-managed skill, not user-editable.
        // App updates with improved skill definitions will take effect on next launch.
        try safetySkillToml.write(to: safetyPath, atomically: true, encoding: .utf8)
    }

    private var safetySkillToml: String {
        // tq = three double-quotes — used as TOML multi-line string markers.
        // Interpolated here to keep them out of the Swift multiline string delimiters.
        let tq = "\"\"\""
        return """
[skill]
name        = "safety"
version     = "1.0.0"
description = "Personal safety guardian. Monitors for falls, manages emergency contacts, and fires SMS alerts via the aggregator relay when a genuine emergency is confirmed."
author      = "0x01 World"
tags        = ["safety", "emergency", "fall-detection", "contacts", "alerts", "health"]

prompts = [\(tq)
# Safety Guardian

You are the safety guardian for your owner. You run a continuous background monitoring loop and can fire emergency SMS alerts when a real danger is confirmed.

## Safety state

Check `zerox1_safety_enabled` in your memory before starting any monitoring. If it is false, skip all monitoring — the owner has not opted in.

## Monitoring loop

1. Call `imu_fall_check` to query the motion sensor.
   - The response includes `next_check_secs` — schedule your next check using `cron_add` with that delay.
   - If `skipped: true`: the device is in a vehicle or high-motion state. Nothing to do.
   - If `fall_detected: true`: proceed to the confirmation flow.

2. **Confirmation flow (30-second window)**
   - Call `phone_notify` with title "Are you OK?" and body "Fall detected — tap to confirm or say you're fine. Contacting emergency contacts in 30 seconds."
   - Call `phone_speak` with "Fall detected. Say I'm okay to cancel emergency alert."
   - Wait 30 seconds. If the owner responds with any "ok / fine / cancel" message, abort and log the false alarm.
   - If no response after 30 seconds: fire the relay.

3. **Emergency relay**
   - Call `emergency_relay` with a plain-language message ("Fall detected, no response after 30 seconds").
     The bridge reads contacts, location, and battery automatically and fires both SMS and a call-now notification.
   - Call `phone_speak` with "Emergency alert sent."

## Auto-activation

Safety mode is off by default. Turn it on automatically (write `zerox1_safety_enabled = true` to memory, then schedule the monitoring loop via `cron_add`) when the owner signals a higher-risk situation:

- Mentions a solo outdoor activity ("going hiking alone", "running by myself", "night walk")
- Mentions a medical concern ("not feeling well", "dizzy", "heart is racing")
- Explicitly asks you to watch over them ("keep an eye on me", "monitor me for a bit")
- Location or time context is high-risk (remote area, late night, unfamiliar place)

When auto-activating: tell the owner safety monitoring is now on and how to turn it off ("say 'stop safety mode' to cancel").

When the owner says "stop safety mode", "I'm home", or "I'm fine": write `zerox1_safety_enabled = false` to memory and remove the monitoring cron job.

## Rules

- NEVER fire `emergency_relay` without the 30-second confirmation window.
- NEVER fire more than once per hour (the aggregator enforces this server-side, but respect it here too).
- If `emergency_contacts_read` returns an empty list, call `phone_notify` informing the owner that no emergency contacts are configured and skip the relay.
- Fall detection sensitivity: `peak_g > 3.0` is a hard fall. Values 2.0–3.0 are ambiguous — still trigger the confirmation flow.
\(tq)]

[[tools]]
name        = "imu_fall_check"
description = "Run a battery-efficient fall detection check. Queries the motion activity sensor first — if in vehicle/cycling/running, returns skipped=true. Otherwise runs a 2-second accelerometer burst and returns peak_g, fall_detected, and next_check_secs."
kind        = "shell"
command     = "curl -sf -H 'X-Bridge-Token: ${ZX01_BRIDGE_TOKEN:-}' '${ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/imu/fall_check'"

[[tools]]
name        = "emergency_contacts_read"
description = "Read the list of emergency contacts configured by the owner. Returns a JSON array of {name, phone} objects."
kind        = "shell"
command     = "curl -sf -H 'X-Bridge-Token: ${ZX01_BRIDGE_TOKEN:-}' '${ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/emergency/contacts'"

[[tools]]
name        = "emergency_relay"
description = "Fire an emergency alert via the phone bridge. The bridge handles everything: reads contacts and device data, sends SMS via the aggregator, and shows a call-now notification for the first contact. Only call this after the 30-second confirmation window."
kind        = "shell"
command     = "jq -nc --arg m {message} '{\\\"message\\\":$m}' | curl -sf -X POST -H 'Content-Type: application/json' -H 'X-Bridge-Token: ${ZX01_BRIDGE_TOKEN:-}' '${ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/emergency/relay' -d @-"

[tools.args]
message = "Human-readable emergency message, e.g. 'Fall detected, no response after 30 seconds'"

[[tools]]
name        = "phone_location"
description = "Get the device current GPS coordinates."
kind        = "shell"
command     = "curl -sf -H 'X-Bridge-Token: ${ZX01_BRIDGE_TOKEN:-}' '${ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/location'"

[[tools]]
name        = "phone_battery"
description = "Get the device current battery level and charging state."
kind        = "shell"
command     = "curl -sf -H 'X-Bridge-Token: ${ZX01_BRIDGE_TOKEN:-}' '${ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/battery'"

[[tools]]
name        = "phone_notify"
description = "Show a local push notification on the device."
kind        = "shell"
command     = "jq -nc --arg t {title} --arg b {body} '{\\\"title\\\":$t,\\\"body\\\":$b}' | curl -sf -X POST -H 'Content-Type: application/json' -H 'X-Bridge-Token: ${ZX01_BRIDGE_TOKEN:-}' '${ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/notify' -d @-"

[tools.args]
title = "Notification title"
body  = "Notification body text"

[[tools]]
name        = "phone_speak"
description = "Speak text aloud using the device text-to-speech engine."
kind        = "shell"
command     = "jq -nc --arg t {text} '{\\\"text\\\":$t}' | curl -sf -X POST -H 'Content-Type: application/json' -H 'X-Bridge-Token: ${ZX01_BRIDGE_TOKEN:-}' '${ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/speak' -d @-"

[tools.args]
text = "Text to speak aloud"
"""
    }

    // MARK: - Token generation

    private func generateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, 32, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - ZeroClaw config writing

    /// Escapes backslashes and double-quotes for safe interpolation into TOML double-quoted strings.
    private func tomlEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
         .replacingOccurrences(of: "\"", with: "\\\"")
    }

    private var zeroclawWorkspaceDir: URL {
        zeroclawConfigDir.appendingPathComponent("workspace")
    }

    private func writeSoulMd(agentName: String) throws {
        let workspaceDir = zeroclawWorkspaceDir
        try FileManager.default.createDirectory(at: workspaceDir, withIntermediateDirectories: true)
        let soulPath = workspaceDir.appendingPathComponent("SOUL.md")
        guard let bundleUrl = Bundle.main.url(forResource: "SOUL", withExtension: "md"),
              var content = try? String(contentsOf: bundleUrl, encoding: .utf8) else {
            os_log(.error, "[NodeService] SOUL.md not found in app bundle — skipping write")
            return
        }
        // Inject the agent's name at the top so it is part of the system prompt.
        let nameHeader = "Your name is \(agentName).\n\n"
        if !content.hasPrefix("Your name is") {
            content = nameHeader + content
        } else {
            // Replace stale name line on restarts.
            if let range = content.range(of: "Your name is .*\\.\\n\\n", options: .regularExpression) {
                content.replaceSubrange(range, with: nameHeader)
            }
        }
        try content.write(to: soulPath, atomically: true, encoding: .utf8)
        os_log(.debug, "[NodeService] SOUL.md written to workspace for agent %{public}@", agentName)
    }

    private func writeZeroclawConfig(config: [String: Any]) throws -> URL {
        let configPath = zeroclawConfigDir.appendingPathComponent("config.toml")

        let provider = (config["llmProvider"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? UserDefaults.standard.string(forKey: "zerox1_llm_provider")
            ?? "anthropic"
        let model    = (config["llmModel"] as? String) ?? UserDefaults.standard.string(forKey: "zerox1_llm_model") ?? ""
        let baseUrl  = (config["llmBaseUrl"] as? String) ?? UserDefaults.standard.string(forKey: "zerox1_llm_base_url") ?? ""
        let caps     = config["capabilities"] as? String ?? ""
        let minFee   = config["minFeeUsdc"] as? Double ?? 0.01
        let minRep   = config["minReputation"] as? Int ?? 0
        let autoAcc  = (config["autoAccept"] as? NSNumber)?.boolValue ?? false

        let apiSecret = nodeApiToken.map { "\napi_secret = \"\(tomlEscape($0))\"" } ?? ""

        let capsLine = caps.isEmpty ? "" : "\ncapabilities = \(caps)"

        // Top-level provider/model fields (not inside an [llm] table — zeroclaw uses flat keys).
        var providerLines = "default_provider = \"\(tomlEscape(provider))\"\n"
        if !model.isEmpty { providerLines += "default_model = \"\(tomlEscape(model))\"\n" }
        if !baseUrl.isEmpty {
            let isValidBaseUrl = baseUrl.hasPrefix("https://")
                || baseUrl.hasPrefix("http://127.0.0.1")
                || baseUrl.hasPrefix("http://localhost")
            if isValidBaseUrl {
                providerLines += "api_url = \"\(tomlEscape(baseUrl))\"\n"
            } else {
                os_log(.error, "[NodeService] Rejected invalid base_url (must be https or local): %{public}@", baseUrl)
            }
        }

let toml = """
\(providerLines)default_temperature = 0.7

[agent]
compact_context = true

[skills]
prompt_injection_mode = "compact"

[channels_config]
cli = true

[channels_config.zerox1]
node_api_url = "http://127.0.0.1:\(nodeApiPort)"\(apiSecret)
auto_accept = \(autoAcc)
min_fee_usdc = \(minFee)
min_reputation = \(minRep)\(capsLine)

[phone]
enabled = true
bridge_url = "http://127.0.0.1:9092"
secret = "\(tomlEscape(KeychainHelper.load(key: "phone_bridge_token") ?? phoneBridgeToken))"
platform = "ios"
timeout_secs = 15

[gateway]
require_pairing = false
paired_tokens = ["\(tomlEscape(gatewayToken))"]
"""

        try toml.write(to: configPath, atomically: true, encoding: .utf8)
        return configPath
    }

    // MARK: - Launch

    /// Start zeroclaw directly when the node is already running but the brain is not.
    /// Safe to call from JS via NodeModule when isAgentRunning is false but isNodeRunning is true.
    func startBrainIfNeeded(config: [String: Any]) {
        NSLog("[NodeService] startBrainIfNeeded invoked nodeRunning=%@ agentRunning=%@ config=%@",
              String(isNodeRunning), String(isAgentRunning), String(describing: config))
        print("[NodeService] startBrainIfNeeded invoked nodeRunning=\(isNodeRunning) agentRunning=\(isAgentRunning) config=\(config)")
        guard isNodeRunning, !isAgentRunning else { return }
        startZeroclaw(config: config)
    }

    func start(config: [String: Any], completion: @escaping (Error?) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            guard !self.isNodeRunning else {
                // Node already running — brain might still need to start.
                // Update lastConfig so getLocalAuthConfig debug fields reflect this call.
                self.lastConfig = config
                if !self.isAgentRunning {
                    // Use NSNumber.boolValue for safe bridging — Swift's `as? Bool` cast
                    // can silently return nil when RN passes a non-BOOL NSNumber for `true`.
                    let brainEnabled = (config["agentBrainEnabled"] as? NSNumber)?.boolValue ?? false
                    os_log(.error, "[NodeService] start() early-return: node running, brainEnabled=%{public}@, isAgentRunning=false",
                           String(brainEnabled))
                    NSLog("[NodeService] start early-return nodeRunning=true brainEnabled=%@ isAgentRunning=false config=%@",
                          String(brainEnabled), String(describing: config))
                    print("[NodeService] start early-return nodeRunning=true brainEnabled=\(brainEnabled) isAgentRunning=false config=\(config)")
                    if brainEnabled {
                        self.startZeroclaw(config: config)
                    }
                }
                completion(nil)
                return
            }

            do {
                let rawName = (config["agentName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let agentDisplayName = rawName.isEmpty ? "Agent" : rawName
                // Persist so auto-start and background wake paths can recover the name.
                if !rawName.isEmpty {
                    UserDefaults.standard.set(rawName, forKey: "zerox1_agent_name")
                }
                try self.setupDirectories(agentName: agentDisplayName)

                let token = self.generateToken()
                self.nodeApiToken = token
                KeychainHelper.save(token, key: "node_api_token")
                let bridgeToken = self.generateToken()
                self.phoneBridgeToken = bridgeToken
                KeychainHelper.save(bridgeToken, key: "phone_bridge_token")
                let gwToken = self.generateToken()
                self.gatewayToken = gwToken
                KeychainHelper.save(gwToken, key: "gateway_token")
                self.lastConfig = config

                // Retrieve identity key from Keychain (never from environment variables).
                let identityKey = KeychainHelper.load(key: "identity_key")

                let relayAddr  = config["relayAddr"]  as? String
                let agentName  = config["agentName"]  as? String
                let rpcUrl     = config["rpcUrl"]     as? String

                let rc = self.dataDir.path.withCString { dataDirPtr in
                    "127.0.0.1:\(self.nodeApiPort)".withCString { addrPtr in
                        token.withCString { secretPtr in
                            withOptionalCString(identityKey) { keyPtr in
                                withOptionalCString(relayAddr) { relayPtr in
                                    withOptionalCString(agentName) { namePtr in
                                        withOptionalCString(rpcUrl) { rpcPtr in
                                            AGGREGATOR_URL.withCString { aggPtr in
                                                zerox1_node_start(dataDirPtr, addrPtr, secretPtr,
                                                                  keyPtr, relayPtr, namePtr, rpcPtr,
                                                                  aggPtr)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                NSLog("[NodeService] zerox1_node_start returned %d", rc)
                print("[NodeService] zerox1_node_start returned \(rc)")

                guard rc == 0 else {
                    throw NSError(domain: "NodeService", code: Int(rc),
                                  userInfo: [NSLocalizedDescriptionKey: "zerox1_node_start returned \(rc)"])
                }

                self.isNodeRunning = true

                DispatchQueue.main.async {
                    UIApplication.shared.isIdleTimerDisabled = true
                }

                // Start ZeroClaw immediately in parallel with node readiness polling.
                // ZeroClaw's signal channel has exponential-backoff retry, so it
                // tolerates the node API not being ready for a few seconds. Starting
                // both concurrently removes the full waitForNodeReady delay from the
                // ZeroClaw cold-start critical path.
                let brainEnabledEarly = (config["agentBrainEnabled"] as? NSNumber)?.boolValue ?? false
                if brainEnabledEarly {
                    self.startZeroclaw(config: config)
                }

                self.waitForNodeReady(token: token, config: config)
                completion(nil)

            } catch {
                completion(error)
            }
        }
    }

    private func waitForNodeReady(token: String, config: [String: Any], attempt: Int = 0) {
        guard attempt < 30 else {
            os_log(.error, "[NodeService] waitForNodeReady timed out after 30s — node did not become ready")
            return
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self else { return }
            var req = URLRequest(url: URL(string: "http://127.0.0.1:\(self.nodeApiPort)/identity")!)
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.timeoutInterval = 1.5
            URLSession.shared.dataTask(with: req) { data, resp, _ in
                if let resp = resp as? HTTPURLResponse, resp.statusCode == 200 {
                    // Persist identity key returned by node only if not already stored,
                    // to avoid overwriting a valid persistent key on every boot.
                    if let data,
                       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        if let key = json["signing_key"] as? String,
                           KeychainHelper.load(key: "identity_key") == nil {
                            KeychainHelper.save(key, key: "identity_key")
                            os_log(.debug, "[NodeService] Identity key saved to Keychain")
                        }
                        if let agentId = json["agent_id"] as? String {
                            self.lastAgentId = agentId
                        }
                    }
                    // Start background keep-alive and health wake observers.
                    KeepAliveService.shared.nodeDidStart(dataDir: self.dataDir)
                    PhoneBridgeServer.shared.start(token: self.phoneBridgeToken)
                    // Only register HealthKit background delivery if the user has
                    // the health capability enabled in Advanced > Data Access.
                    if PhoneBridgeServer.shared.capabilities["health"] == true {
                        HealthWakeService.shared.register()
                    }
                    os_log(.debug, "[NodeService] PhoneBridgeServer started on port 9092")
                    os_log(.debug, "[NodeService] node ready — identity + PhoneBridge init")
                } else {
                    self.waitForNodeReady(token: token, config: config, attempt: attempt + 1)
                }
            }.resume()
        }
    }

    private func waitForGatewayReady(attempt: Int = 0, completion: @escaping (String?) -> Void) {
        let candidates = [
            "http://127.0.0.1:9093/health",
            "http://127.0.0.1:42617/health",
        ]
        // 40 attempts × ~1.5 s each ≈ 60 s total — ZeroClaw gateway binds in <30 s
        // on typical hardware; parallel start with node reduces this further.
        guard attempt < 40 else {
            completion(nil)
            return
        }

        let group = DispatchGroup()
        let resultLock = NSLock()
        var foundUrl: String? = nil

        for urlString in candidates {
            guard let url = URL(string: urlString) else { continue }
            group.enter()
            var req = URLRequest(url: url)
            req.timeoutInterval = 1
            URLSession.shared.dataTask(with: req) { _, resp, _ in
                defer { group.leave() }
                if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                    resultLock.lock()
                    if foundUrl == nil { foundUrl = urlString }
                    resultLock.unlock()
                }
            }.resume()
        }

        group.notify(queue: queue) {
            if let foundUrl {
                completion(foundUrl)
            } else {
                self.queue.asyncAfter(deadline: .now() + 0.5) {
                    self.waitForGatewayReady(attempt: attempt + 1, completion: completion)
                }
            }
        }
    }

    private func startZeroclaw(config: [String: Any]) {
        queue.async { [weak self] in
            guard let self else { return }

            do {
                let configPath = try self.writeZeroclawConfig(config: config)
                os_log(.error, "[NodeService] zeroclaw config written to %{public}@", configPath.path)
                // LLM API key is fetched from Keychain here and passed directly to the C FFI,
                // rather than written into the config file on disk.
                let llmKey = KeychainHelper.load(key: "llm_api_key")
                os_log(.error, "[NodeService] startZeroclaw — llmKey in keychain: %{public}@", llmKey != nil ? "yes" : "NO — key missing!")
                // Media generation API keys are exposed as environment variables so the
                // in-process zeroclaw Rust runtime can read them via std::env::var().
                if let falKey = KeychainHelper.load(key: "fal_api_key") {
                    setenv("FAL_API_KEY", falKey, 1)
                }
                if let replicateKey = KeychainHelper.load(key: "replicate_api_key") {
                    setenv("REPLICATE_API_KEY", replicateKey, 1)
                }
                // In hosted mode, config["nodeApiUrl"] carries the remote host URL;
                // in local mode fall back to the in-process node.
                let nodeUrl = (config["nodeApiUrl"] as? String)
                    ?? "http://127.0.0.1:\(self.nodeApiPort)"
                NSLog("[NodeService] startZeroclaw nodeUrl=%@ llmKey=%@", nodeUrl, llmKey != nil ? "yes" : "no")
                print("[NodeService] startZeroclaw nodeUrl=\(nodeUrl) llmKey=\(llmKey != nil ? "yes" : "no")")

                let dataDirPath = self.dataDir.path
                let rc = configPath.path.withCString { pathPtr in
                    nodeUrl.withCString { urlPtr in
                        withOptionalCString(llmKey) { keyPtr in
                            dataDirPath.withCString { dirPtr in
                                zeroclaw_start(pathPtr, urlPtr, keyPtr, dirPtr)
                            }
                        }
                    }
                }

                os_log(.error, "[NodeService] zeroclaw_start returned %d", rc)
                NSLog("[NodeService] zeroclaw_start returned %d", rc)
                print("[NodeService] zeroclaw_start returned \(rc)")
                if rc == 0 {
                    self.waitForGatewayReady { boundUrl in
                        if let boundUrl {
                            self.isAgentRunning = true
                            self.lastBrainError = nil
                            NSLog("[NodeService] gateway became healthy at %@", boundUrl)
                            print("[NodeService] gateway became healthy at \(boundUrl)")
                            NotificationCenter.default.post(name: .nodeStatusChanged,
                                                            object: ["status": "brain_started", "detail": boundUrl])
                        } else {
                            self.isAgentRunning = false
                            // Read last 800 chars of zeroclaw_ffi.log for diagnostics.
                            var logTail = ""
                            let logPath = self.dataDir.appendingPathComponent("zeroclaw_ffi.log")
                            if let data = try? Data(contentsOf: logPath),
                               let text = String(data: data, encoding: .utf8) {
                                let tail = String(text.suffix(800))
                                logTail = " | LOG: \(tail)"
                            }
                            let detail = "zeroclaw gateway did not bind on 9093 or 42617 after launch\(logTail)"
                            self.lastBrainError = detail
                            NSLog("[NodeService] %@", detail)
                            print("[NodeService] \(detail)")
                            NotificationCenter.default.post(name: .nodeStatusChanged,
                                                            object: ["status": "brain_error", "detail": detail])
                        }
                    }
                } else {
                    let detail = "zeroclaw_start returned \(rc) (llmKey=\(llmKey != nil ? "yes" : "no"), nodeUrl=\(nodeUrl))"
                    self.lastBrainError = detail
                    os_log(.error, "[NodeService] zeroclaw_start failed — %{public}@", detail)
                    NotificationCenter.default.post(name: .nodeStatusChanged,
                                                    object: ["status": "brain_error", "detail": detail])
                }
            } catch {
                let detail = "config write failed: \(error.localizedDescription)"
                self.lastBrainError = detail
                os_log(.error, "[NodeService] %{public}@", detail)
                NotificationCenter.default.post(name: .nodeStatusChanged,
                                                object: ["status": "brain_error", "detail": detail])
            }
        }
    }

    // MARK: - Hosted mode launch

    /// In hosted mode the local zerox1-node is not started.
    /// Only zeroclaw is launched; it connects to the remote host URL instead.
    func startHostedMode(hostUrl: String, config: [String: Any]) {
        guard !isRunning else { return }
        guard let url = URL(string: hostUrl),
              let scheme = url.scheme,
              ["https", "http"].contains(scheme.lowercased()),
              url.host != nil else {
            os_log(.error, "[NodeService] Rejected invalid hostUrl: %{public}@", hostUrl)
            return
        }
        // Persist the host URL in Keychain (not UserDefaults) to prevent backup extraction.
        KeychainHelper.save(hostUrl, key: "host_url")
        phoneBridgeToken = KeychainHelper.load(key: "phone_bridge_token") ?? generateToken()
        gatewayToken = KeychainHelper.load(key: "gateway_token") ?? generateToken()
        PhoneBridgeServer.shared.start(token: phoneBridgeToken)
        // Start zeroclaw with hosted mode config (skips zerox1_node_start entirely).
        var hostedConfig = config
        hostedConfig["nodeApiUrl"] = hostUrl
        startZeroclaw(config: hostedConfig)
    }

    // MARK: - Stop

    func stop(completion: @escaping () -> Void = {}) {
        queue.async { [weak self] in
            guard let self else { completion(); return }
            // Release background keep-alive before stopping processes.
            KeepAliveService.shared.nodeDidStop()
            // Always stop zeroclaw regardless of isAgentRunning — the Rust
            // IS_RUNNING flag stays true even if the gateway never bound, so
            // we must call zeroclaw_stop() to reset it before the next start.
            if self.isNodeRunning || self.isAgentRunning {
                zeroclaw_stop()
                self.isAgentRunning = false
            }
            if self.isNodeRunning {
                zerox1_node_stop()
                self.isNodeRunning = false
            }
            PhoneBridgeServer.shared.stop()

            DispatchQueue.main.async {
                UIApplication.shared.isIdleTimerDisabled = false
            }

            NotificationCenter.default.post(name: .nodeStatusChanged,
                                            object: ["status": "stopped", "detail": ""])
            completion()
        }
    }

    func reloadAgent() {
        guard isNodeRunning, let token = nodeApiToken else { return }
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(nodeApiPort)/agent/reload")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: req).resume()
    }

    /// Write the current task type so KeepAliveService can pick the matching ambient sound.
    /// Call from JS (NodeModule.setAgentTaskType) when a task is accepted.
    /// Values: "page_flip" | "keyboard" | "rain" | "ocean" | "" (clears / default)
    func setTaskType(_ type: String) {
        let path = dataDir.appendingPathComponent("zeroclaw.task_type")
        try? type.write(to: path, atomically: true, encoding: .utf8)
    }

    /// Mute or unmute the ambient working sound.
    /// Call from JS (NodeModule.setAudioMuted). Persisted across transitions by KeepAliveService.
    func setAudioMuted(_ muted: Bool) {
        KeepAliveService.shared.setMuted(muted)
    }
}

// MARK: - Aggregator sleep state

extension NodeService {

    /// Report sleep state to the aggregator so senders know whether to queue
    /// messages and fire APNs wake pushes.
    ///
    /// Called by the JS layer (via NodeModule) on every AppState transition:
    ///   background/inactive → setAggregatorSleepState(sleeping: true)
    ///   active              → setAggregatorSleepState(sleeping: false)
    ///
    /// Signing uses the Ed25519 identity key stored in the iOS Keychain.
    /// Fire-and-forget — completion always called regardless of outcome.
    func setAggregatorSleepState(sleeping: Bool, completion: @escaping () -> Void = {}) {
        guard let keyB58 = KeychainHelper.load(key: "identity_key"), !keyB58.isEmpty else {
            completion(); return
        }

        // Prefer the agent_id we already know. If not yet populated (first-launch
        // backgrounding before node has started), derive it from the identity key.
        var agentId = lastAgentId
        if agentId == nil || agentId!.isEmpty {
            if let keyBytes = base58Decode(keyB58), keyBytes.count >= 32 {
                let seed = Data(keyBytes.prefix(32))
                if let privateKey = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) {
                    let derived = privateKey.publicKey.rawRepresentation
                        .map { String(format: "%02x", $0) }.joined()
                    lastAgentId = derived   // persist for next time
                    agentId = derived
                }
            }
        }

        guard let agentId, !agentId.isEmpty else {
            completion(); return
        }

        let body: [String: Any] = ["agent_id": agentId, "sleeping": sleeping]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
            completion(); return
        }

        guard let sigHex = ed25519Sign(data: bodyData, base58Key: keyB58) else {
            completion(); return
        }

        var req = URLRequest(url: URL(string: "\(AGGREGATOR_URL)/fcm/sleep")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(sigHex, forHTTPHeaderField: "X-Signature")
        req.httpBody = bodyData
        req.timeoutInterval = 8

        URLSession.shared.dataTask(with: req) { _, _, _ in
            completion()
        }.resume()
    }

    /// Sign `data` with an Ed25519 key stored as base58 (seed || pubkey, 64 bytes).
    /// Returns the 64-byte signature as a lowercase hex string, or nil on error.
    private func ed25519Sign(data: Data, base58Key: String) -> String? {
        guard let keyBytes = base58Decode(base58Key), keyBytes.count >= 32 else { return nil }
        let seed = Data(keyBytes.prefix(32))
        guard let privateKey = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) else { return nil }
        guard let sig = try? privateKey.signature(for: data) else { return nil }
        return sig.map { String(format: "%02x", $0) }.joined()
    }

    /// Minimal base58 decoder (Bitcoin alphabet).
    private func base58Decode(_ s: String) -> [UInt8]? {
        let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
        var result = [UInt8]()
        for char in s {
            guard let digitIdx = alphabet.firstIndex(of: char) else { return nil }
            var carry = digitIdx
            for i in stride(from: result.count - 1, through: 0, by: -1) {
                carry += 58 * Int(result[i])
                result[i] = UInt8(carry & 0xff)
                carry >>= 8
            }
            while carry > 0 {
                result.insert(UInt8(carry & 0xff), at: 0)
                carry >>= 8
            }
        }
        let leadingZeros = s.prefix(while: { $0 == "1" }).count
        let stripped = result.drop(while: { $0 == 0 })
        return Array(repeating: UInt8(0), count: leadingZeros) + stripped
    }
}

// MARK: - Notification name

extension Notification.Name {
    static let nodeStatusChanged = Notification.Name("zerox1.nodeStatusChanged")
}

// MARK: - C string helper

/// Calls `body` with a non-nil `UnsafePointer<CChar>` when `s` is non-nil,
/// or with a nil pointer when `s` is nil. Matches nullable C parameters.
private func withOptionalCString<R>(_ s: String?, body: (UnsafePointer<CChar>?) -> R) -> R {
    if let s { return s.withCString { body($0) } }
    return body(nil)
}
