#if canImport(PushKit)
import PushKit
import Foundation

/// Handles VoIP push registration and wake events.
///
/// VoIP pushes (PKPushType.voIP) wake the app instantly even when suspended
/// or killed — unlike regular APNs which are throttled. Apple allows this
/// for apps that need reliable background wake for incoming communication.
///
/// Flow:
///   App launch → register PKPushRegistry → receive voipToken
///   → store in Keychain + UserDefaults → JS layer reads it via NodeModule
///   → node startup includes token → BEACON sends token to aggregator
///   → when agent is sleeping, aggregator sends APNs VoIP push
///   → iOS wakes app → didReceiveIncomingPushPayload fires → NodeService.start()
final class VoIPPushHandler: NSObject, PKPushRegistryDelegate {
    static let shared = VoIPPushHandler()

    private var registry: PKPushRegistry?

    func register() {
        #if targetEnvironment(simulator)
        NSLog("[VoIPPushHandler] VoIP push not available in simulator — skipping registration")
        #else
        let reg = PKPushRegistry(queue: .main)
        reg.delegate = self
        reg.desiredPushTypes = [.voIP]
        self.registry = reg
        #endif
    }

    // MARK: - PKPushRegistryDelegate

    func pushRegistry(_ registry: PKPushRegistry,
                      didUpdate pushCredentials: PKPushCredentials,
                      for type: PKPushType) {
        guard type == .voIP else { return }
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        // Persist so NodeModule can read it and include in node startup config
        KeychainHelper.save(token, key: "voip_push_token")
        UserDefaults.standard.set(token, forKey: "zerox1_voip_token")
        NSLog("[VoIPPushHandler] VoIP push token: \(token)")
    }

    func pushRegistry(_ registry: PKPushRegistry,
                      didReceiveIncomingPushWith payload: PKPushPayload,
                      for type: PKPushType,
                      completion: @escaping () -> Void) {
        guard type == .voIP else { completion(); return }

        NSLog("[VoIPPushHandler] VoIP wake received — starting node")

        // Load saved config from UserDefaults and start the node
        let config = AppDelegate.loadSavedConfigStatic()

        // Read hosted mode flag from UserDefaults (set by the RN JS layer via NodeModule)
        let isHostedMode = UserDefaults.standard.bool(forKey: "zerox1_hosted_mode")
        let hostUrl = UserDefaults.standard.string(forKey: "zerox1_host_url")

        if isHostedMode, let url = hostUrl, !url.isEmpty {
            // Hosted mode: don't start local node, just ensure zeroclaw is connected
            NodeService.shared.startHostedMode(hostUrl: url, config: config)
            completion()
        } else {
            NodeService.shared.start(config: config) { _ in
                completion()
            }
        }
    }

    func pushRegistry(_ registry: PKPushRegistry,
                      didInvalidatePushTokenFor type: PKPushType) {
        KeychainHelper.delete(key: "voip_push_token")
        UserDefaults.standard.removeObject(forKey: "zerox1_voip_token")
    }
}
#else
// Stub for non-PushKit platforms
final class VoIPPushHandler: NSObject {
    static let shared = VoIPPushHandler()
    func register() {}
}
#endif
