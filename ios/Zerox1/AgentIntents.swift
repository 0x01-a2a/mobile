#if canImport(AppIntents)
import AppIntents
import Foundation

// ── Start Agent ───────────────────────────────────────────────────────────

@available(iOS 16.0, *)
struct StartAgentIntent: AppIntent {
    static var title: LocalizedStringResource = "Start 0x01 Agent"
    static var description = IntentDescription("Start your 0x01 mesh node and AI agent.")
    static var openAppWhenRun: Bool = false  // run in background

    var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let config = AppDelegate.loadSavedConfigStatic()
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            NodeService.shared.start(config: config) { err in
                if let err { cont.resume(throwing: err) } else { cont.resume() }
            }
        }
        return .result(dialog: "0x01 agent started.")
    }
}

// ── Stop Agent ────────────────────────────────────────────────────────────

@available(iOS 16.0, *)
struct StopAgentIntent: AppIntent {
    static var title: LocalizedStringResource = "Stop 0x01 Agent"
    static var description = IntentDescription("Stop your 0x01 mesh node and AI agent.")
    static var openAppWhenRun: Bool = false

    var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        NodeService.shared.stop()
        return .result(dialog: "0x01 agent stopped.")
    }
}

// ── Agent Status ──────────────────────────────────────────────────────────

@available(iOS 16.0, *)
struct AgentStatusIntent: AppIntent {
    static var title: LocalizedStringResource = "0x01 Agent Status"
    static var description = IntentDescription("Check if your 0x01 agent is running.")
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let running = NodeService.shared.isRunning
        let msg = running ? "Your 0x01 agent is running." : "Your 0x01 agent is stopped."
        return .result(dialog: IntentDialog(stringLiteral: msg))
    }
}

// ── Check Portfolio ───────────────────────────────────────────────────────

@available(iOS 16.0, *)
struct CheckPortfolioIntent: AppIntent {
    static var title: LocalizedStringResource = "Check Portfolio Balance"
    static var description = IntentDescription("Fetch your 0x01 agent's USDC hot wallet balance.")
    static var openAppWhenRun: Bool = false

    var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let token = KeychainHelper.load(key: "node_api_token") ?? ""
        guard let url = URL(string: "http://127.0.0.1:9090/wallet/balance") else {
            return .result(dialog: "Internal error: invalid URL.")
        }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 5

        let (data, _) = try await URLSession.shared.data(for: req)
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let usdc = json["usdc"] as? Double {
            let formatted = String(format: "%.2f", usdc)
            return .result(dialog: "Your hot wallet holds \(formatted) USDC.")
        }
        return .result(dialog: "Could not fetch balance. Make sure the agent is running.")
    }
}

// ── Shortcut Providers ────────────────────────────────────────────────────

@available(iOS 16.0, *)
struct AgentShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartAgentIntent(),
            phrases: ["Start my \(.applicationName) agent", "Start \(.applicationName)"],
            shortTitle: "Start Agent",
            systemImageName: "antenna.radiowaves.left.and.right"
        )
        AppShortcut(
            intent: StopAgentIntent(),
            phrases: ["Stop my \(.applicationName) agent", "Stop \(.applicationName)"],
            shortTitle: "Stop Agent",
            systemImageName: "antenna.radiowaves.left.and.right.slash"
        )
        AppShortcut(
            intent: AgentStatusIntent(),
            phrases: ["\(.applicationName) status", "Is my \(.applicationName) running"],
            shortTitle: "Agent Status",
            systemImageName: "circle.fill"
        )
        AppShortcut(
            intent: CheckPortfolioIntent(),
            phrases: ["Check my \(.applicationName) balance", "\(.applicationName) portfolio"],
            shortTitle: "Portfolio Balance",
            systemImageName: "dollarsign.circle"
        )
    }
}

#endif
