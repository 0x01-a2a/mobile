import Foundation

/// Manages the lifecycle of zerox1-node and zeroclaw subprocesses.
/// iOS equivalent of Android's NodeService.kt (foreground service).
///
/// Binary bundling:
///   - zerox1-node and zeroclaw are compiled for aarch64-apple-ios and
///     embedded in the app bundle under Resources/Binaries/
///   - On first launch (or version upgrade), they are copied to
///     NSDocumentDirectory/binaries/ with executable permissions.
///   - posix_spawn is used to launch them (valid for TestFlight/enterprise dist).
///
/// Background execution:
///   - UIApplication.shared.isIdleTimerDisabled = true prevents screen dimming
///   - The app must remain in foreground for the node to run
///   - BGProcessingTask is registered for brief background processing on suspend
final class NodeService {

    static let shared = NodeService()

    // MARK: - Constants

    private let nodeBinaryName = "zerox1-node"
    private let agentBinaryName = "zeroclaw"
    private let nodeAssetVersion = "0.4.6"
    private let agentAssetVersion = "0.2.3"
    private let nodeApiPort = 9090

    // MARK: - State

    private var nodeProcess: Process?
    private var agentProcess: Process?
    private var nodeApiToken: String?
    private var gatewayToken: String?
    private var isNodeRunning = false
    private var isAgentRunning = false
    private var lastConfig: [String: Any] = [:]
    private let queue = DispatchQueue(label: "world.zerox1.nodeservice", qos: .userInitiated)

    var isRunning: Bool { isNodeRunning }

    // MARK: - Binary setup

    private var binariesDir: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("binaries", isDirectory: true)
    }

    private var dataDir: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("zerox1-data", isDirectory: true)
    }

    private func setupDirectories() throws {
        try FileManager.default.createDirectory(at: binariesDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dataDir.appendingPathComponent("zeroclaw"),
                                                 withIntermediateDirectories: true)
    }

    /// Copies a binary from the app bundle to the documents binaries dir if version changed.
    private func ensureBinary(name: String, version: String) throws -> URL {
        let versionKey = "bin_version_\(name)"
        let dest = binariesDir.appendingPathComponent(name)
        let currentVersion = UserDefaults.standard.string(forKey: versionKey)

        if currentVersion != version || !FileManager.default.fileExists(atPath: dest.path) {
            guard let src = Bundle.main.url(forResource: name, withExtension: nil,
                                            subdirectory: "Binaries") else {
                throw NSError(domain: "NodeService", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "\(name) binary not found in bundle"])
            }
            if FileManager.default.fileExists(atPath: dest.path) {
                try FileManager.default.removeItem(at: dest)
            }
            try FileManager.default.copyItem(at: src, to: dest)
            // Make executable
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dest.path)
            UserDefaults.standard.set(version, forKey: versionKey)
        }
        return dest
    }

    // MARK: - Token generation

    private func generateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, 16, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Config writing

    private func writeNodeConfig(config: [String: Any], token: String) throws {
        // Write identity and relay config as environment overrides
        // zerox1-node reads ZX01_API_SECRET, ZX01_RELAY_ADDR, ZX01_AGENT_NAME etc.
        // Store in UserDefaults for the launch env
        if let relay = config["relayAddr"] as? String {
            UserDefaults.standard.set(relay, forKey: "zerox1_relay_addr")
        }
        if let name = config["agentName"] as? String {
            UserDefaults.standard.set(name, forKey: "zerox1_agent_name")
        }
        if let rpc = config["rpcUrl"] as? String {
            UserDefaults.standard.set(rpc, forKey: "zerox1_rpc_url")
        }
    }

    private func writeZeroclawConfig(config: [String: Any]) throws {
        let configDir = dataDir.appendingPathComponent("zeroclaw")
        let configPath = configDir.appendingPathComponent("config.toml")

        let provider = UserDefaults.standard.string(forKey: "zerox1_llm_provider") ?? "anthropic"
        let model = UserDefaults.standard.string(forKey: "zerox1_llm_model") ?? ""
        let baseUrl = UserDefaults.standard.string(forKey: "zerox1_llm_base_url") ?? ""
        let llmKey = KeychainHelper.load(key: "llm_api_key") ?? ""
        let caps = config["capabilities"] as? String ?? ""
        let minFee = config["minFeeUsdc"] as? Double ?? 0.01
        let minRep = config["minReputation"] as? Int ?? 0
        let autoAccept = config["autoAccept"] as? Bool ?? false

        var toml = """
        [channel.zerox1]
        node_api_url = "http://127.0.0.1:\(nodeApiPort)"
        auto_accept = \(autoAccept)
        min_fee_usdc = \(minFee)
        min_reputation = \(minRep)

        [llm]
        provider = "\(provider)"
        """

        if !model.isEmpty { toml += "\nmodel = \"\(model)\"" }
        if !baseUrl.isEmpty { toml += "\nbase_url = \"\(baseUrl)\"" }
        if !llmKey.isEmpty { toml += "\napi_key = \"\(llmKey)\"" }

        if !caps.isEmpty { toml += "\n\n[capabilities]\nenabled = \(caps)" }

        try toml.write(to: configPath, atomically: true, encoding: .utf8)
    }

    // MARK: - Launch

    func start(config: [String: Any], completion: @escaping (Error?) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            guard !self.isNodeRunning else { completion(nil); return }

            do {
                try self.setupDirectories()
                let nodeBin = try self.ensureBinary(name: self.nodeBinaryName, version: self.nodeAssetVersion)

                // Generate API token
                let token = self.generateToken()
                self.nodeApiToken = token
                KeychainHelper.save(token, key: "node_api_token")

                try self.writeNodeConfig(config: config, token: token)
                self.lastConfig = config

                // Build environment
                var env: [String: String] = ProcessInfo.processInfo.environment
                env["ZX01_API_SECRET"] = token
                env["ZX01_DATA_DIR"] = self.dataDir.path
                env["ZX01_LISTEN_ADDR"] = "127.0.0.1:\(self.nodeApiPort)"
                if let relay = config["relayAddr"] as? String { env["ZX01_RELAY_ADDR"] = relay }
                if let name = config["agentName"] as? String { env["ZX01_AGENT_NAME"] = name }
                if let rpc = config["rpcUrl"] as? String { env["ZX01_RPC_URL"] = rpc }
                if let key = KeychainHelper.load(key: "identity_key") { env["ZX01_IDENTITY_KEY"] = key }

                // Launch node
                let nodeProc = Process()
                nodeProc.executableURL = nodeBin
                nodeProc.arguments = ["--listen", "127.0.0.1:\(self.nodeApiPort)"]
                nodeProc.environment = env
                nodeProc.currentDirectoryURL = self.dataDir
                nodeProc.terminationHandler = { [weak self] _ in
                    self?.handleNodeTermination()
                }

                let nodeLog = FileHandle(forWritingAtPath: self.dataDir.appendingPathComponent("node.log").path)
                if let log = nodeLog {
                    nodeProc.standardOutput = log
                    nodeProc.standardError = log
                }

                try nodeProc.run()
                self.nodeProcess = nodeProc
                self.isNodeRunning = true

                // Keep screen on
                DispatchQueue.main.async {
                    UIApplication.shared.isIdleTimerDisabled = true
                }

                // Wait for node API to be ready then start zeroclaw
                self.waitForNodeReady(token: token, config: config)

                completion(nil)
            } catch {
                completion(error)
            }
        }
    }

    private func waitForNodeReady(token: String, config: [String: Any], attempt: Int = 0) {
        guard attempt < 30 else { return } // 30s timeout
        DispatchQueue.global().asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self else { return }
            var req = URLRequest(url: URL(string: "http://127.0.0.1:\(self.nodeApiPort)/identity")!)
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.timeoutInterval = 2
            URLSession.shared.dataTask(with: req) { data, resp, _ in
                if let resp = resp as? HTTPURLResponse, resp.statusCode == 200 {
                    // Node is ready — extract identity key if present and start zeroclaw
                    if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let key = json["signing_key"] as? String {
                        KeychainHelper.save(key, key: "identity_key")
                    }
                    if let brainEnabled = config["agentBrainEnabled"] as? Bool, brainEnabled {
                        self.startZeroclaw(config: config, nodeToken: token)
                    }
                } else {
                    self.waitForNodeReady(token: token, config: config, attempt: attempt + 1)
                }
            }.resume()
        }
    }

    private func startZeroclaw(config: [String: Any], nodeToken: String) {
        queue.async { [weak self] in
            guard let self else { return }
            do {
                let agentBin = try self.ensureBinary(name: self.agentBinaryName, version: self.agentAssetVersion)
                try self.writeZeroclawConfig(config: config)

                let agentProc = Process()
                agentProc.executableURL = agentBin
                agentProc.arguments = ["--config-dir", self.dataDir.appendingPathComponent("zeroclaw").path]
                agentProc.environment = ProcessInfo.processInfo.environment
                agentProc.currentDirectoryURL = self.dataDir.appendingPathComponent("zeroclaw")
                agentProc.terminationHandler = { [weak self] _ in
                    self?.handleAgentTermination(config: config, nodeToken: nodeToken)
                }

                let agentLog = FileHandle(forWritingAtPath: self.dataDir.appendingPathComponent("zeroclaw.log").path)
                if let log = agentLog {
                    agentProc.standardOutput = log
                    agentProc.standardError = log
                }

                try agentProc.run()
                self.agentProcess = agentProc
                self.isAgentRunning = true
            } catch {
                NSLog("[NodeService] Failed to start zeroclaw: \(error)")
            }
        }
    }

    // MARK: - Stop

    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            self.agentProcess?.terminate()
            self.agentProcess = nil
            self.isAgentRunning = false

            self.nodeProcess?.terminate()
            self.nodeProcess = nil
            self.isNodeRunning = false

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

    // MARK: - Restart on crash

    private func handleNodeTermination() {
        queue.async { [weak self] in
            guard let self, self.isNodeRunning else { return }
            NSLog("[NodeService] zerox1-node terminated — restarting in 3s")
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                self.start(config: self.lastConfig) { _ in }
            }
        }
    }

    private func handleAgentTermination(config: [String: Any], nodeToken: String) {
        queue.async { [weak self] in
            guard let self, self.isAgentRunning else { return }
            NSLog("[NodeService] zeroclaw terminated — restarting in 3s")
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                self.startZeroclaw(config: config, nodeToken: nodeToken)
            }
        }
    }
}

extension Notification.Name {
    static let nodeStatusChanged = Notification.Name("zerox1.nodeStatusChanged")
}
