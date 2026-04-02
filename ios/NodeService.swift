import Foundation
import UIKit
import os.log

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
    private var _isNodeRunning = false
    private var _isAgentRunning = false
    private var lastConfig: [String: Any] = [:]
    private let queue = DispatchQueue(label: "world.zerox1.nodeservice", qos: .userInitiated)
    private let stateLock = NSLock()

    private var isNodeRunning: Bool {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _isNodeRunning }
        set { stateLock.lock(); _isNodeRunning = newValue; stateLock.unlock() }
    }

    private var isAgentRunning: Bool {
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

    private func writeZeroclawConfig(config: [String: Any]) throws -> URL {
        let configPath = zeroclawConfigDir.appendingPathComponent("config.toml")

        let provider = UserDefaults.standard.string(forKey: "zerox1_llm_provider") ?? "anthropic"
        let model    = UserDefaults.standard.string(forKey: "zerox1_llm_model") ?? ""
        let baseUrl  = UserDefaults.standard.string(forKey: "zerox1_llm_base_url") ?? ""
        let caps     = config["capabilities"] as? String ?? ""
        let minFee   = config["minFeeUsdc"] as? Double ?? 0.01
        let minRep   = config["minReputation"] as? Int ?? 0
        let autoAcc  = config["autoAccept"] as? Bool ?? false

        let apiSecret = nodeApiToken.map { "\napi_secret = \"\(tomlEscape($0))\"" } ?? ""

        let capsLine = caps.isEmpty ? "" : "\ncapabilities = \(caps)"

        var toml = """
        [channels_config.zerox1]
        node_api_url = "http://127.0.0.1:\(nodeApiPort)"\(apiSecret)
        auto_accept = \(autoAcc)
        min_fee_usdc = \(minFee)
        min_reputation = \(minRep)\(capsLine)

        [llm]
        provider = "\(tomlEscape(provider))"
        """

        if !model.isEmpty { toml += "\nmodel = \"\(tomlEscape(model))\"" }

        if !baseUrl.isEmpty {
            let isValidBaseUrl = baseUrl.hasPrefix("https://")
                || baseUrl.hasPrefix("http://127.0.0.1")
                || baseUrl.hasPrefix("http://localhost")
            if isValidBaseUrl {
                toml += "\nbase_url = \"\(tomlEscape(baseUrl))\""
            } else {
                os_log(.error, "[NodeService] Rejected invalid base_url (must be https or local): %{public}@", baseUrl)
            }
        }

        // Include bridge config so zeroclaw registers phone tools
        toml += """

[phone]
enabled = true
bridge_url = "http://127.0.0.1:9092"
secret = "\(tomlEscape(KeychainHelper.load(key: "phone_bridge_token") ?? phoneBridgeToken))"
platform = "ios"
timeout_secs = 15
"""

        try toml.write(to: configPath, atomically: true, encoding: .utf8)
        return configPath
    }

    // MARK: - Launch

    func start(config: [String: Any], completion: @escaping (Error?) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            guard !self.isNodeRunning else { completion(nil); return }

            do {
                try self.setupDirectories()

                let token = self.generateToken()
                self.nodeApiToken = token
                KeychainHelper.save(token, key: "node_api_token")
                let bridgeToken = self.generateToken()
                self.phoneBridgeToken = bridgeToken
                KeychainHelper.save(bridgeToken, key: "phone_bridge_token")
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
                                            zerox1_node_start(dataDirPtr, addrPtr, secretPtr,
                                                              keyPtr, relayPtr, namePtr, rpcPtr)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

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
        guard attempt < 30 else { return }
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
                       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let key = json["signing_key"] as? String,
                       KeychainHelper.load(key: "identity_key") == nil {
                        KeychainHelper.save(key, key: "identity_key")
                        os_log(.debug, "[NodeService] Identity key saved to Keychain")
                    }
                    // Start background keep-alive now that the node is ready.
                    KeepAliveService.shared.nodeDidStart(dataDir: self.dataDir)
                    PhoneBridgeServer.shared.start(token: self.phoneBridgeToken)
                    os_log(.debug, "[NodeService] PhoneBridgeServer started on port 9092")
                    if let brainEnabled = config["agentBrainEnabled"] as? Bool, brainEnabled {
                        self.startZeroclaw(config: config)
                    }
                } else {
                    self.waitForNodeReady(token: token, config: config, attempt: attempt + 1)
                }
            }.resume()
        }
    }

    private func startZeroclaw(config: [String: Any]) {
        queue.async { [weak self] in
            guard let self else { return }
            do {
                let configPath = try self.writeZeroclawConfig(config: config)
                // LLM API key is fetched from Keychain here and passed directly to the C FFI,
                // rather than written into the config file on disk.
                let llmKey = KeychainHelper.load(key: "llm_api_key")
                let nodeUrl = "http://127.0.0.1:\(self.nodeApiPort)"

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

                if rc != 0 {
                    os_log(.error, "[NodeService] zeroclaw_start returned %d", rc)
                } else {
                    self.isAgentRunning = true
                    os_log(.debug, "[NodeService] zeroclaw started")
                }
            } catch {
                os_log(.error, "[NodeService] Failed to write zeroclaw config: %{public}@", error.localizedDescription)
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
        PhoneBridgeServer.shared.start(token: phoneBridgeToken)
        // Start zeroclaw with hosted mode config (skips zerox1_node_start entirely).
        var hostedConfig = config
        hostedConfig["nodeApiUrl"] = hostUrl
        startZeroclaw(config: hostedConfig)
    }

    // MARK: - Stop

    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            // Release background keep-alive before stopping processes.
            KeepAliveService.shared.nodeDidStop()
            if self.isAgentRunning {
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
