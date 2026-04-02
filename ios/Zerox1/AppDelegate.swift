import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import BackgroundTasks
import UserNotifications
import os.log

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    var reactNativeDelegate: ReactNativeDelegate?
    var reactNativeFactory: RCTReactNativeFactory?

    // M-3: Hardened session for health-check requests — no redirects, no cellular
    private lazy var healthCheckSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.allowsCellularAccess = false
        config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 5
        return URLSession(configuration: config, delegate: HealthCheckSessionDelegate(), delegateQueue: nil)
    }()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // React Native setup
        let delegate = ReactNativeDelegate()
        let factory = RCTReactNativeFactory(delegate: delegate)
        delegate.dependencyProvider = RCTAppDependencyProvider()
        reactNativeDelegate = delegate
        reactNativeFactory = factory

        window = UIWindow(frame: UIScreen.main.bounds)
        factory.startReactNative(
            withModuleName: "01pilot",
            in: window,
            launchOptions: launchOptions
        )

        // Register background task
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: "world.zerox1.pilot.node-keepalive",
            using: nil
        ) { task in
            self.handleNodeKeepalive(task: task as! BGProcessingTask)
        }

        // Request notification permissions
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }

        // Register notification category with agent quick-actions
        let chatAction = UNNotificationAction(
            identifier: "AGENT_CHAT",
            title: "→ Chat",
            options: [.foreground]
        )
        let briefAction = UNNotificationAction(
            identifier: "AGENT_BRIEF",
            title: "✦ Brief",
            options: [.foreground]
        )
        let inboxAction = UNNotificationAction(
            identifier: "AGENT_INBOX",
            title: "◈ Inbox",
            options: [.foreground]
        )
        let agentCategory = UNNotificationCategory(
            identifier: "AGENT_STATUS",
            actions: [chatAction, briefAction, inboxAction],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([agentCategory])
        UNUserNotificationCenter.current().delegate = self

        // Register VoIP push for instant background wake
        #if canImport(PushKit)
        VoIPPushHandler.shared.register()
        #endif

        // Auto-start node if enabled
        let autoStart = UserDefaults.standard.bool(forKey: "zerox1_auto_start")
        if autoStart {
            let config = loadSavedConfig()
            NodeService.shared.start(config: config) { _ in }
        }

        return true
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        scheduleNodeKeepalive()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        NodeService.shared.stop()
    }

    // MARK: - Background Task

    private func scheduleNodeKeepalive() {
        let req = BGProcessingTaskRequest(identifier: "world.zerox1.pilot.node-keepalive")
        req.requiresNetworkConnectivity = true
        req.requiresExternalPower = false
        req.earliestBeginDate = Date(timeIntervalSinceNow: 60)
        try? BGTaskScheduler.shared.submit(req)
    }

    private func handleNodeKeepalive(task: BGProcessingTask) {
        task.expirationHandler = { task.setTaskCompleted(success: false) }
        // Ping node API to check health
        let token = KeychainHelper.load(key: "node_api_token") ?? ""
        var req = URLRequest(url: URL(string: "http://127.0.0.1:9090/identity")!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 10
        healthCheckSession.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            task.setTaskCompleted(success: ok)
            self.scheduleNodeKeepalive()
        }.resume()
    }

    // MARK: - Config persistence

    private func loadSavedConfig() -> [String: Any] {
        AppDelegate.loadSavedConfigStatic()
    }

    /// Static variant so VoIPPushHandler (and other non-instance callers) can
    /// load the persisted node config without a reference to the AppDelegate instance.
    static func loadSavedConfigStatic() -> [String: Any] {
        var cfg: [String: Any] = [:]
        if let name = UserDefaults.standard.string(forKey: "zerox1_agent_name") {
            cfg["agentName"] = name
        }
        // L-5: Validate relayAddr — must begin with a recognised multiaddr prefix
        if let relay = UserDefaults.standard.string(forKey: "zerox1_relay_addr"), !relay.isEmpty {
            let validPrefixes = ["/ip4/", "/ip6/", "/dns4/", "/dns6/"]
            if validPrefixes.contains(where: { relay.hasPrefix($0) }) {
                cfg["relayAddr"] = relay
            }
            // silently ignore invalid relay addresses
        }

        // L-5: Validate rpcUrl — must be a well-formed http/https URL
        if let rpc = UserDefaults.standard.string(forKey: "zerox1_rpc_url"), !rpc.isEmpty {
            if let url = URL(string: rpc),
               let scheme = url.scheme?.lowercased(),
               (scheme == "https" || scheme == "http"),
               url.host != nil {
                cfg["rpcUrl"] = rpc
            }
            // silently ignore invalid URLs
        }
        cfg["agentBrainEnabled"] = UserDefaults.standard.bool(forKey: "zerox1_brain_enabled")
        return cfg
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension AppDelegate: UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let url: URL?
        switch response.actionIdentifier {
        case "AGENT_CHAT":
            url = URL(string: "zerox1://chat")
        case "AGENT_BRIEF":
            url = URL(string: "zerox1://chat?mode=brief")
        case "AGENT_INBOX":
            url = URL(string: "zerox1://inbox")
        default:
            url = nil
        }
        if let url = url {
            DispatchQueue.main.async { UIApplication.shared.open(url) }
        }
        completionHandler()
    }
}

// M-3: Rejects all HTTP redirects for health-check requests
private final class HealthCheckSessionDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession,
                    task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil) // Reject all redirects
    }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
    override func sourceURL(for bridge: RCTBridge) -> URL? {
        self.bundleURL()
    }

    override func bundleURL() -> URL? {
#if DEBUG
        RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
        Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
    }
}
