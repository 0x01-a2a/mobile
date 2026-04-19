import ActivityKit
import Foundation

/// Shared between the app and the Live Activity extension.
/// Static content set at start; ContentState updated in real-time.
@available(iOS 16.1, *)
public struct AgentActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// Short human phrase shown as the primary status line.
        /// e.g. "Standing by", "New proposal", "Work ready", "Working…"
        public var statusPhrase: String
        /// Longer task description for the expanded / lock-screen view (empty if idle).
        public var currentTask: String
        /// USDC earned today, display string e.g. "$4.20"
        public var earnedToday: String
        /// Agent is actively processing (drives pulse animation)
        public var isActive: Bool
        /// Number of unread messages / proposals waiting for user action (0 = none)
        public var pendingCount: Int
        /// User has muted ambient working sounds (zeroclaw audio keepalive).
        public var audioMuted: Bool
    }

    /// Static — set at Activity.request() time
    public var agentName: String
    public var agentInitial: String   // First letter for Dynamic Island minimal view
}
