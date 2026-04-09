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

    private let nodeAssetVersion = "0.4.6"
    private let agentAssetVersion = "0.2.3"
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

    private var zeroclawConfigDir: URL {
        dataDir.appendingPathComponent("zeroclaw")
    }

    private func setupDirectories() throws {
        try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: zeroclawConfigDir, withIntermediateDirectories: true)
        try writeSoulMd()
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

    private func writeSoulMd() throws {
        let workspaceDir = zeroclawWorkspaceDir
        try FileManager.default.createDirectory(at: workspaceDir, withIntermediateDirectories: true)
        let soulPath = workspaceDir.appendingPathComponent("SOUL.md")
        // Only write on first run; user or agent may have customised it.
        guard !FileManager.default.fileExists(atPath: soulPath.path) else { return }
        guard let bundleUrl = Bundle.main.url(forResource: "SOUL", withExtension: "md"),
              let content = try? String(contentsOf: bundleUrl, encoding: .utf8) else {
            os_log(.error, "[NodeService] SOUL.md not found in app bundle — skipping write")
            return
        }
        try content.write(to: soulPath, atomically: true, encoding: .utf8)
        os_log(.debug, "[NodeService] SOUL.md written to workspace")
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
                try self.setupDirectories()

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

                self.waitForNodeReady(token: token, config: config)
                completion(nil)

            } catch {
                completion(error)
            }
        }
    }

    private func waitForNodeReady(token: String, config: [String: Any], attempt: Int = 0) {
        guard attempt < 60 else {
            os_log(.error, "[NodeService] waitForNodeReady timed out after 60s — node did not become ready")
            return
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self else { return }
            var req = URLRequest(url: URL(string: "http://127.0.0.1:\(self.nodeApiPort)/identity")!)
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.timeoutInterval = 2
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
                    HealthWakeService.shared.register()
                    PhoneBridgeServer.shared.start(token: self.phoneBridgeToken)
                    os_log(.debug, "[NodeService] PhoneBridgeServer started on port 9092")
                    let brainEnabled = (config["agentBrainEnabled"] as? NSNumber)?.boolValue ?? false
                    os_log(.error, "[NodeService] node ready — agentBrainEnabled=%{public}@, provider=%{public}@, keyInChain=%{public}@",
                           String(brainEnabled),
                           (config["llmProvider"] as? String) ?? "nil",
                           KeychainHelper.load(key: "llm_api_key") != nil ? "yes" : "no")
                    NSLog("[NodeService] node ready brainEnabled=%@ provider=%@ keyInChain=%@",
                          String(brainEnabled),
                          (config["llmProvider"] as? String) ?? "nil",
                          KeychainHelper.load(key: "llm_api_key") != nil ? "yes" : "no")
                    print("[NodeService] node ready brainEnabled=\(brainEnabled) provider=\((config["llmProvider"] as? String) ?? "nil") keyInChain=\(KeychainHelper.load(key: "llm_api_key") != nil ? "yes" : "no")")
                    if brainEnabled {
                        self.startZeroclaw(config: config)
                    }
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
        // 60 attempts × ~1.5 s each ≈ 90 s total — gives zeroclaw time for
        // SQLite init + gateway bind even on a cold first launch.
        guard attempt < 60 else {
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
