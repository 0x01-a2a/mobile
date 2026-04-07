#if canImport(PushKit)
import PushKit
import CallKit
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

    // MARK: - CallKit provider
    // iOS 13+ requires reportNewIncomingCall within seconds of didReceiveIncomingPushPayload.
    // We report a silent system call then end it immediately — satisfying the OS requirement
    // while the real work (starting the node) happens in the background.
    private lazy var callProvider: CXProvider = {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.iconTemplateImageData = nil
        return CXProvider(configuration: config)
    }()

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

        // iOS 13+: report a call immediately, then end it once the node is up.
        // Failure to call reportNewIncomingCall causes the OS to terminate the process.
        let callUUID = UUID()
        let handle = CXHandle(type: .generic, value: "01 Agent")
        let callUpdate = CXCallUpdate()
        callUpdate.remoteHandle = handle
        callUpdate.hasVideo = false
        callProvider.reportNewIncomingCall(with: callUUID, update: callUpdate) { _ in }

        // Load saved config from UserDefaults and start the node
        let config = AppDelegate.loadSavedConfigStatic()

        // Read hosted mode flag from UserDefaults (set by the RN JS layer via NodeModule)
        let isHostedMode = UserDefaults.standard.bool(forKey: "zerox1_hosted_mode")
        let hostUrl = UserDefaults.standard.string(forKey: "zerox1_host_url")

        if isHostedMode, let url = hostUrl, !url.isEmpty {
            // Hosted mode: don't start local node, just ensure zeroclaw is connected
            NodeService.shared.startHostedMode(hostUrl: url, config: config)
            callProvider.reportCall(with: callUUID, endedAt: Date(), reason: .remoteEnded)
            completion()
        } else {
            NodeService.shared.start(config: config) { [weak self] _ in
                self?.callProvider.reportCall(with: callUUID, endedAt: Date(), reason: .remoteEnded)
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
