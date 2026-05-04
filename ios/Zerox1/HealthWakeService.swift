import Foundation
import HealthKit
import os.log

/// Registers HealthKit observer queries with background delivery so iOS wakes
/// the app when relevant health data arrives (steps, heart rate, workouts).
///
/// When woken, the node is started (if not running) and the Live Activity is
/// updated so the agent can act on the new health context.
///
/// Call `register()` once, after HealthKit authorization has been granted.
/// Safe to call multiple times — already-registered observers are no-ops.
final class HealthWakeService {
    static let shared = HealthWakeService()
    private let store = HKHealthStore()
    private var registered = false
    private var activeQueries: [HKObserverQuery] = []

    // ── Types we watch ────────────────────────────────────────────────────────
    // Extend this list freely — each type that the agent is configured to use.
    private var watchedTypes: [HKQuantityTypeIdentifier] {
        [
            .stepCount,
            .heartRate,
            .activeEnergyBurned,
            .restingHeartRate,
        ]
    }

    // MARK: - Public

    func register() {
        guard HKHealthStore.isHealthDataAvailable(), !registered else { return }
        registered = true

        for identifier in watchedTypes {
            guard let type = HKQuantityType.quantityType(forIdentifier: identifier) else { continue }
            // iOS will wake the app at most at the requested frequency.
            // .immediate is fine here — the system batches updates anyway.
            store.enableBackgroundDelivery(for: type, frequency: .immediate) { success, error in
                if !success {
                    os_log(.error, "[HealthWake] enableBackgroundDelivery failed for %{public}@: %{public}@",
                           identifier.rawValue, error?.localizedDescription ?? "unknown")
                    return
                }
                // Observer query must be running for the background delivery callback to fire.
                let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completionHandler, error in
                    guard error == nil else { completionHandler(); return }
                    self?.handleHealthWake(type: identifier, completionHandler: completionHandler)
                }
                self.activeQueries.append(query)
                self.store.execute(query)
                os_log(.debug, "[HealthWake] Registered background delivery for %{public}@", identifier.rawValue)
            }
        }
    }

    /// Stop all observer queries and allow re-registration.
    /// Called from NodeService.stop() so HealthKit wakes no longer restart the node
    /// after the user explicitly stopped it.
    func unregister() {
        for query in activeQueries {
            store.stop(query)
        }
        activeQueries.removeAll()
        registered = false
    }

    // MARK: - Private

    private func handleHealthWake(type: HKQuantityTypeIdentifier,
                                  completionHandler: @escaping () -> Void) {
        os_log(.debug, "[HealthWake] Background wake for %{public}@", type.rawValue)

        // Update the Dynamic Island immediately.
        LiveActivityBridge.updateForWake(wakeType: "health", from: nil, detail: humanLabel(for: type))

        // Start the node so zeroclaw can process the health update.
        let config = AppDelegate.loadSavedConfigStatic()
        let isHosted = UserDefaults.standard.bool(forKey: "zerox1_hosted_mode")
        let hostUrl  = UserDefaults.standard.string(forKey: "zerox1_host_url") ?? ""

        if isHosted, !hostUrl.isEmpty {
            NodeService.shared.startHostedMode(hostUrl: hostUrl, config: config)
            completionHandler()
        } else {
            NodeService.shared.start(config: config) { _ in completionHandler() }
        }
    }

    private func humanLabel(for id: HKQuantityTypeIdentifier) -> String {
        switch id {
        case .stepCount:           return "New step data"
        case .heartRate:           return "Heart rate update"
        case .activeEnergyBurned:  return "Activity update"
        case .restingHeartRate:    return "Resting HR update"
        default:                   return "Health update"
        }
    }
}
