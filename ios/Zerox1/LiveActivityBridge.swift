import Foundation
import ActivityKit

/// Native-side Live Activity updater — called from AppDelegate / wake services
/// without going through the React Native JS bridge.
///
/// All paths that can wake the app (APNs push, HealthKit observer, BGTask) use this
/// to update the Dynamic Island before the JS layer has had a chance to load.
enum LiveActivityBridge {

    /// Map a push wake_type to a status phrase shown in the Dynamic Island.
    private static func phrase(for wakeType: String, from: String?) -> String {
        switch wakeType {
        case "bounty":   return from.map { "Bounty from \($0)" } ?? "New bounty!"
        case "propose":  return from.map { "Proposal from \($0)" } ?? "New proposal"
        case "trading":  return "Trading opportunity"
        case "health":   return "Health alert"
        case "calendar": return "Schedule update"
        default:         return from.map { "Message from \($0)" } ?? "Incoming event"
        }
    }

    /// Update every running Live Activity with a wake-derived phrase.
    /// Safe to call from any thread (uses Swift concurrency Task).
    static func updateForWake(wakeType: String, from: String?, detail: String?) {
        guard #available(iOS 16.2, *) else { return }
        let newPhrase = phrase(for: wakeType, from: from)
        Task {
            for activity in Activity<AgentActivityAttributes>.activities {
                let current = activity.content.state
                let updated = AgentActivityAttributes.ContentState(
                    statusPhrase: newPhrase,
                    currentTask:  detail ?? current.currentTask,
                    earnedToday:  current.earnedToday,
                    isActive:     true,
                    pendingCount: current.pendingCount + 1
                )
                await activity.update(.init(state: updated, staleDate: nil))
            }
        }
    }
}
