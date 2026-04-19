import ActivityKit
import WidgetKit
import SwiftUI

// MARK: - Accent color

private let accent = Color(red: 0.38, green: 1.0, blue: 0.55)   // #61FF8D — matches app green

// MARK: - Pulse animation helper

@available(iOS 16.1, *)
private struct PulseDot: View {
    let active: Bool
    @State private var pulsing = false

    var body: some View {
        ZStack {
            if active {
                Circle()
                    .fill(accent.opacity(0.25))
                    .frame(width: 14, height: 14)
                    .scaleEffect(pulsing ? 1.5 : 1.0)
                    .opacity(pulsing ? 0 : 1)
                    .animation(.easeOut(duration: 1.2).repeatForever(autoreverses: false), value: pulsing)
            }
            Circle()
                .fill(active ? accent : Color.white.opacity(0.25))
                .frame(width: 8, height: 8)
        }
        .onAppear { if active { pulsing = true } }
    }
}

// MARK: - Badge view

@available(iOS 16.1, *)
private struct PendingBadge: View {
    let count: Int
    var body: some View {
        if count > 0 {
            Text("\(count)")
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(.black)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(accent)
                .clipShape(Capsule())
        }
    }
}

// MARK: - Widget

@available(iOS 16.1, *)
struct AgentLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentActivityAttributes.self) { context in
            AgentLockScreenView(context: context)
                .activityBackgroundTint(Color(white: 0.06))
                .activitySystemActionForegroundColor(accent)
        } dynamicIsland: { context in
            DynamicIsland {
                // ── Expanded (long-press) ────────────────────────────────────
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        PulseDot(active: context.state.isActive)
                        Text(context.attributes.agentName)
                            .font(.caption.bold())
                            .foregroundColor(.white)
                            .lineLimit(1)
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    HStack(spacing: 4) {
                        if context.state.pendingCount > 0 {
                            PendingBadge(count: context.state.pendingCount)
                        }
                        Text(context.state.earnedToday)
                            .font(.caption.bold())
                            .foregroundColor(accent)
                    }
                    .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.statusPhrase)
                        .font(.caption2)
                        .foregroundColor(.white.opacity(0.75))
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 16) {
                        Link(destination: URL(string: "zerox1://chat")!) {
                            Label("Chat", systemImage: "bubble.left.fill")
                                .font(.caption.bold())
                                .foregroundColor(accent)
                        }
                        Link(destination: URL(string: "zerox1://inbox")!) {
                            HStack(spacing: 4) {
                                Image(systemName: "tray.fill")
                                Text("Inbox")
                                if context.state.pendingCount > 0 {
                                    PendingBadge(count: context.state.pendingCount)
                                }
                            }
                            .font(.caption.bold())
                            .foregroundColor(.white.opacity(0.65))
                        }
                        Spacer()
                        // Mute / unmute ambient working sound
                        Link(destination: URL(string: context.state.audioMuted
                                ? "zerox1://unmute-audio"
                                : "zerox1://mute-audio")!) {
                            Image(systemName: context.state.audioMuted
                                    ? "speaker.slash.fill"
                                    : "speaker.wave.2.fill")
                                .font(.caption.bold())
                                .foregroundColor(context.state.audioMuted
                                    ? .white.opacity(0.35)
                                    : accent.opacity(0.75))
                        }
                    }
                    .padding(.horizontal, 4)
                    .padding(.bottom, 4)
                }
            } compactLeading: {
                // ── Compact left: pulse dot ──────────────────────────────────
                PulseDot(active: context.state.isActive)
                    .padding(.leading, 4)
            } compactTrailing: {
                // ── Compact right: muted icon > badge > earned today ─────────
                if context.state.audioMuted {
                    Image(systemName: "speaker.slash.fill")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.white.opacity(0.35))
                        .padding(.trailing, 2)
                } else if context.state.pendingCount > 0 {
                    PendingBadge(count: context.state.pendingCount)
                        .padding(.trailing, 2)
                } else {
                    Text(context.state.earnedToday)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(accent)
                        .padding(.trailing, 2)
                }
            } minimal: {
                // ── Minimal (two Live Activities): just the agent initial ─────
                Text(context.attributes.agentInitial)
                    .font(.caption2.bold())
                    .foregroundColor(accent)
            }
            .widgetURL(URL(string: "zerox1://today"))
            .keylineTint(accent)
        }
    }
}

// MARK: - Lock Screen / Notification banner

@available(iOS 16.1, *)
struct AgentLockScreenView: View {
    let context: ActivityViewContext<AgentActivityAttributes>

    var body: some View {
        HStack(spacing: 12) {
            // Agent avatar circle
            ZStack {
                Circle()
                    .fill(Color(white: 0.14))
                    .frame(width: 46, height: 46)
                Text(context.attributes.agentInitial)
                    .font(.title3.bold())
                    .foregroundColor(accent)
                if context.state.isActive {
                    Circle()
                        .stroke(accent.opacity(0.35), lineWidth: 1.5)
                        .frame(width: 52, height: 52)
                }
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(context.attributes.agentName)
                        .font(.subheadline.bold())
                        .foregroundColor(.white)
                    Spacer()
                    Text(context.state.earnedToday)
                        .font(.subheadline.bold())
                        .foregroundColor(accent)
                }
                HStack(spacing: 6) {
                    Text(context.state.statusPhrase)
                        .font(.caption)
                        .foregroundColor(.white.opacity(0.7))
                        .lineLimit(1)
                    if context.state.pendingCount > 0 {
                        PendingBadge(count: context.state.pendingCount)
                    }
                }
                if !context.state.currentTask.isEmpty {
                    Text(context.state.currentTask)
                        .font(.caption2)
                        .foregroundColor(.white.opacity(0.45))
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}
