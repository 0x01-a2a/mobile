import ActivityKit
import Foundation

/// Shared between the app and the Live Activity extension.
/// Static content set at start; ContentState updated in real-time.
@available(iOS 16.1, *)
public struct AgentActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// Current agent status shown in Dynamic Island compact view
        public var status: String        // "Running" | "Idle" | "Working" | "Stopped"
        /// Current task description (truncated for compact view)
        public var currentTask: String   // "" if idle
        /// USDC earned today (display string e.g. "$4.20")
        public var earnedToday: String
        /// Agent is actively processing (shows pulse animation)
        public var isActive: Bool
    }

    /// Static — set at Activity.request() time
    public var agentName: String
    public var agentInitial: String   // First letter for Dynamic Island minimal view
}
