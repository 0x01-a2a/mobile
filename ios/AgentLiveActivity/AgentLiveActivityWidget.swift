import ActivityKit
import WidgetKit
import SwiftUI

@available(iOS 16.1, *)
struct AgentLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentActivityAttributes.self) { context in
            // Lock Screen / Notification banner expanded view
            AgentLockScreenView(context: context)
                .activityBackgroundTint(Color.black)
                .activitySystemActionForegroundColor(Color.green)
        } dynamicIsland: { context in
            DynamicIsland {
                // Expanded (long press)
                DynamicIslandExpandedRegion(.leading) {
                    HStack {
                        Circle()
                            .fill(context.state.isActive ? Color.green : Color.gray)
                            .frame(width: 8, height: 8)
                        Text(context.attributes.agentName)
                            .font(.caption.bold())
                            .foregroundColor(.white)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.earnedToday)
                        .font(.caption.bold())
                        .foregroundColor(.green)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.currentTask.isEmpty ? context.state.status : context.state.currentTask)
                        .font(.caption2)
                        .foregroundColor(.white.opacity(0.8))
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 16) {
                        Link(destination: URL(string: "zerox1://chat")!) {
                            Label("Chat", systemImage: "bubble.left.fill")
                                .font(.caption.bold())
                                .foregroundColor(.green)
                        }
                        Link(destination: URL(string: "zerox1://inbox")!) {
                            Label("Inbox", systemImage: "tray.fill")
                                .font(.caption.bold())
                                .foregroundColor(.white.opacity(0.7))
                        }
                    }
                }
            } compactLeading: {
                // Compact left: colored dot
                Circle()
                    .fill(context.state.isActive ? Color.green : Color.gray)
                    .frame(width: 8, height: 8)
                    .padding(.leading, 4)
            } compactTrailing: {
                // Compact right: initial + status
                Text(context.attributes.agentInitial)
                    .font(.caption.bold())
                    .foregroundColor(.green)
            } minimal: {
                // Minimal (when two Live Activities active): just the initial
                Text(context.attributes.agentInitial)
                    .font(.caption2.bold())
                    .foregroundColor(.green)
            }
            .widgetURL(URL(string: "zerox1://today"))
            .keylineTint(Color.green)
        }
    }
}

@available(iOS 16.1, *)
struct AgentLockScreenView: View {
    let context: ActivityViewContext<AgentActivityAttributes>

    var body: some View {
        HStack(spacing: 12) {
            // Agent avatar circle
            ZStack {
                Circle()
                    .fill(Color(white: 0.12))
                    .frame(width: 44, height: 44)
                Text(context.attributes.agentInitial)
                    .font(.title3.bold())
                    .foregroundColor(.green)
                if context.state.isActive {
                    Circle()
                        .stroke(Color.green.opacity(0.4), lineWidth: 1.5)
                        .frame(width: 48, height: 48)
                }
            }

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(context.attributes.agentName)
                        .font(.subheadline.bold())
                        .foregroundColor(.white)
                    Spacer()
                    Text(context.state.earnedToday)
                        .font(.subheadline.bold())
                        .foregroundColor(.green)
                }
                Text(context.state.currentTask.isEmpty ? context.state.status : context.state.currentTask)
                    .font(.caption)
                    .foregroundColor(.white.opacity(0.7))
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}
