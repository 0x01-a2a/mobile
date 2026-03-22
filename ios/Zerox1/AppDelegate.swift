import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import BackgroundTasks
import UserNotifications

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    var reactNativeDelegate: ReactNativeDelegate?
    var reactNativeFactory: RCTReactNativeFactory?

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
            withModuleName: "Zerox1",
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
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            task.setTaskCompleted(success: ok)
            self.scheduleNodeKeepalive()
        }.resume()
    }

    // MARK: - Config persistence

    private func loadSavedConfig() -> [String: Any] {
        var cfg: [String: Any] = [:]
        if let name = UserDefaults.standard.string(forKey: "zerox1_agent_name") {
            cfg["agentName"] = name
        }
        if let relay = UserDefaults.standard.string(forKey: "zerox1_relay_addr") {
            cfg["relayAddr"] = relay
        }
        if let rpc = UserDefaults.standard.string(forKey: "zerox1_rpc_url") {
            cfg["rpcUrl"] = rpc
        }
        cfg["agentBrainEnabled"] = UserDefaults.standard.bool(forKey: "zerox1_brain_enabled")
        return cfg
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
