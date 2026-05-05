import Foundation
import UIKit
import CryptoKit
import os.log
private let AGGREGATOR_URL = "https://api.0x01.world"

/// Manages the lifecycle of zerox1-node and zeroclaw running in-process via C FFI.
///
/// iOS kernel sandbox blocks all exec*()/posix_spawn() calls from app processes —
/// the Android-style subprocess model cannot be used. Instead, zerox1-node and zeroclaw
/// are compiled as static libraries (libzerox1_node.a, libzeroclaw.a) targeting
/// aarch64-apple-ios and linked directly into the app binary. Their C entry points
/// (declared in Zerox1-Bridging-Header.h) are called here.
///
/// Rust-side TODO:
///   - node/crates/zerox1-node/src/ffi.rs  → exports zerox1_node_start / zerox1_node_stop
///   - zeroclaw/src/ffi.rs                 → exports zeroclaw_start / zeroclaw_stop
///
/// Background execution:
///   - UIApplication.shared.isIdleTimerDisabled keeps the screen on while running.
///   - BGProcessingTask registered in AppDelegate for brief background continuation.
final class NodeService {

    static let shared = NodeService()

    // MARK: - Constants

    private let nodeAssetVersion = "0.6.0"
    private let agentAssetVersion = "0.3.6"
    private let nodeApiPort = 9090

    // MARK: - State

    private var nodeApiToken: String?
    private var phoneBridgeToken: String = ""
    private var gatewayToken: String = ""
    private var _isNodeRunning = false
    private var _isAgentRunning = false
    private(set) var lastConfig: [String: Any] = [:]
    private(set) var lastBrainError: String? = nil
    /// Hex agent_id of the running node — populated after /identity succeeds.
    /// Persisted in UserDefaults so it is available across restarts.
    private(set) var lastAgentId: String? {
        get { UserDefaults.standard.string(forKey: "zerox1_agent_id") }
        set { UserDefaults.standard.set(newValue, forKey: "zerox1_agent_id") }
    }
    private let queue = DispatchQueue(label: "world.zerox1.nodeservice", qos: .userInitiated)
    private let stateLock = NSLock()

    private var isNodeRunning: Bool {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _isNodeRunning }
        set { stateLock.lock(); _isNodeRunning = newValue; stateLock.unlock() }
    }

    var isAgentRunning: Bool {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _isAgentRunning }
        set { stateLock.lock(); _isAgentRunning = newValue; stateLock.unlock() }
    }

    var isRunning: Bool {
        stateLock.lock(); defer { stateLock.unlock() }; return _isNodeRunning
    }

    // MARK: - Directories

    private var dataDir: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("zerox1-data", isDirectory: true)
    }

    /// Exposed to NodeModule so JS can write/remove zeroclaw.busy without reaching into private state.
    var dataDirPublic: URL? {
        isNodeRunning ? dataDir : nil
    }

    /// Public path to the zeroclaw skills directory (always resolved, not gated on running state).
    /// Used by NodeModule for iOS-side skill install/remove/list.
    var skillsDirectory: URL {
        dataDir
            .appendingPathComponent("zeroclaw")
            .appendingPathComponent("workspace")
            .appendingPathComponent("skills")
    }

    /// Path to the zeroclaw agent log file, always resolved (not gated on running state).
    var logFilePath: String? {
        let path = dataDir.appendingPathComponent("zeroclaw_ffi.log").path
        return FileManager.default.fileExists(atPath: path) ? path : nil
    }

    private var zeroclawConfigDir: URL {
        dataDir.appendingPathComponent("zeroclaw")
    }

    private func setupDirectories(agentName: String) throws {
        try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: zeroclawConfigDir, withIntermediateDirectories: true)
        try writeSoulMd(agentName: agentName)
        try writeBundledSkills()
    }

    private func writeBundledSkills() throws {
        let skillsRoot = zeroclawWorkspaceDir.appendingPathComponent("skills", isDirectory: true)
        try FileManager.default.createDirectory(at: skillsRoot, withIntermediateDirectories: true)

        let safetyDir = skillsRoot.appendingPathComponent("safety", isDirectory: true)
        try FileManager.default.createDirectory(at: safetyDir, withIntermediateDirectories: true)
        let safetyPath = safetyDir.appendingPathComponent("SKILL.toml")
        // Always overwrite — this is a machine-managed skill, not user-editable.
        // App updates with improved skill definitions will take effect on next launch.
        try safetySkillToml.write(to: safetyPath, atomically: true, encoding: .utf8)

        let moltbookDir = skillsRoot.appendingPathComponent("moltbook", isDirectory: true)
        try FileManager.default.createDirectory(at: moltbookDir, withIntermediateDirectories: true)
        try moltbookSkillToml.write(to: moltbookDir.appendingPathComponent("SKILL.toml"),
                                     atomically: true, encoding: .utf8)

        let podcastDir = skillsRoot.appendingPathComponent("podcast", isDirectory: true)
        try FileManager.default.createDirectory(at: podcastDir, withIntermediateDirectories: true)
        try podcastSkillToml.write(to: podcastDir.appendingPathComponent("SKILL.toml"),
                                    atomically: true, encoding: .utf8)

        let memoryDir = skillsRoot.appendingPathComponent("memory-observe", isDirectory: true)
        try FileManager.default.createDirectory(at: memoryDir, withIntermediateDirectories: true)
        try memoryObserveSkillToml.write(to: memoryDir.appendingPathComponent("SKILL.toml"),
                                          atomically: true, encoding: .utf8)

        let personaDir = skillsRoot.appendingPathComponent("persona-observe", isDirectory: true)
        try FileManager.default.createDirectory(at: personaDir, withIntermediateDirectories: true)
        try personaObserveSkillToml.write(to: personaDir.appendingPathComponent("SKILL.toml"),
                                           atomically: true, encoding: .utf8)

        let bagsDir = skillsRoot.appendingPathComponent("bags", isDirectory: true)
        try FileManager.default.createDirectory(at: bagsDir, withIntermediateDirectories: true)
        try bagsSkillToml.write(to: bagsDir.appendingPathComponent("SKILL.toml"),
                                atomically: true, encoding: .utf8)

        let tradeDir = skillsRoot.appendingPathComponent("trade", isDirectory: true)
        try FileManager.default.createDirectory(at: tradeDir, withIntermediateDirectories: true)
        try tradeSkillToml.write(to: tradeDir.appendingPathComponent("SKILL.toml"),
                                 atomically: true, encoding: .utf8)

        let webDir = skillsRoot.appendingPathComponent("web", isDirectory: true)
        try FileManager.default.createDirectory(at: webDir, withIntermediateDirectories: true)
        try webSkillToml.write(to: webDir.appendingPathComponent("SKILL.toml"),
                               atomically: true, encoding: .utf8)

        let skillManagerDir = skillsRoot.appendingPathComponent("skill_manager", isDirectory: true)
        try FileManager.default.createDirectory(at: skillManagerDir, withIntermediateDirectories: true)
        try skillManagerSkillToml.write(to: skillManagerDir.appendingPathComponent("SKILL.toml"),
                                        atomically: true, encoding: .utf8)
    }

    private var safetySkillToml: String {
        // tq = three double-quotes — used as TOML multi-line string markers.
        // Interpolated here to keep them out of the Swift multiline string delimiters.
        let tq = "\"\"\""
        return """
[skill]
name        = "safety"
version     = "1.0.0"
description = "Personal safety guardian. Monitors for falls, manages emergency contacts, and fires SMS alerts via the aggregator relay when a genuine emergency is confirmed."
author      = "0x01 World"
tags        = ["safety", "emergency", "fall-detection", "contacts", "alerts", "health"]

prompts = [\(tq)
# Safety Guardian

You are the safety guardian for your owner. You run a continuous background monitoring loop and can fire emergency SMS alerts when a real danger is confirmed.

## Safety state

Check `zerox1_safety_enabled` in your memory before starting any monitoring. If it is false, skip all monitoring — the owner has not opted in.

## Monitoring loop

1. Call `imu_fall_check` to query the motion sensor.
   - The response includes `next_check_secs` — schedule your next check using `cron_add` with that delay.
   - If `skipped: true`: the device is in a vehicle or high-motion state. Nothing to do.
   - If `fall_detected: true`: proceed to the confirmation flow.

2. **Confirmation flow (30-second window)**
   - Call `phone_notify` with title "Are you OK?" and body "Fall detected — tap to confirm or say you're fine. Contacting emergency contacts in 30 seconds."
   - Call `phone_speak` with "Fall detected. Say I'm okay to cancel emergency alert."
   - Wait 30 seconds. If the owner responds with any "ok / fine / cancel" message, abort and log the false alarm.
   - If no response after 30 seconds: fire the relay.

3. **Emergency relay**
   - Call `emergency_relay` with a plain-language message ("Fall detected, no response after 30 seconds").
     The bridge reads contacts, location, and battery automatically and fires both SMS and a call-now notification.
   - Call `phone_speak` with "Emergency alert sent."

## Auto-activation

Safety mode is off by default. Turn it on automatically (write `zerox1_safety_enabled = true` to memory, then schedule the monitoring loop via `cron_add`) when the owner signals a higher-risk situation:

- Mentions a solo outdoor activity ("going hiking alone", "running by myself", "night walk")
- Mentions a medical concern ("not feeling well", "dizzy", "heart is racing")
- Explicitly asks you to watch over them ("keep an eye on me", "monitor me for a bit")
- Location or time context is high-risk (remote area, late night, unfamiliar place)

When auto-activating: tell the owner safety monitoring is now on and how to turn it off ("say 'stop safety mode' to cancel").

When the owner says "stop safety mode", "I'm home", or "I'm fine": write `zerox1_safety_enabled = false` to memory and remove the monitoring cron job.

## Rules

- NEVER fire `emergency_relay` without the 30-second confirmation window.
- NEVER fire more than once per hour (the aggregator enforces this server-side, but respect it here too).
- If `emergency_contacts_read` returns an empty list, call `phone_notify` informing the owner that no emergency contacts are configured and skip the relay.
- Fall detection sensitivity: `peak_g > 3.0` is a hard fall. Values 2.0–3.0 are ambiguous — still trigger the confirmation flow.
\(tq)]

[[tools]]
name        = "imu_fall_check"
description = "Run a battery-efficient fall detection check. Queries the motion activity sensor first — if in vehicle/cycling/running, returns skipped=true. Otherwise runs a 2-second accelerometer burst and returns peak_g, fall_detected, and next_check_secs."
kind        = "shell"
command     = "curl -sf -H 'X-Bridge-Token: ${ZX01_BRIDGE_TOKEN:-}' '${ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/imu/fall_check'"

[[tools]]
name        = "emergency_contacts_read"
description = "Read the list of emergency contacts configured by the owner. Returns a JSON array of {name, phone} objects."
kind        = "shell"
command     = "curl -sf -H 'X-Bridge-Token: ${ZX01_BRIDGE_TOKEN:-}' '${ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/emergency/contacts'"

[[tools]]
name        = "emergency_relay"
description = "Fire an emergency alert via the phone bridge. The bridge handles everything: reads contacts and device data, sends SMS via the aggregator, and shows a call-now notification for the first contact. Only call this after the 30-second confirmation window."
kind        = "shell"
command     = "jq -nc --arg m {message} '{\\\"message\\\":$m}' | curl -sf -X POST -H 'Content-Type: application/json' -H 'X-Bridge-Token: ${ZX01_BRIDGE_TOKEN:-}' '${ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/emergency/relay' -d @-"

[tools.args]
message = "Human-readable emergency message, e.g. 'Fall detected, no response after 30 seconds'"

[[tools]]
name        = "phone_location"
description = "Get the device current GPS coordinates."
kind        = "shell"
command     = "curl -sf -H 'X-Bridge-Token: ${ZX01_BRIDGE_TOKEN:-}' '${ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/location'"

[[tools]]
name        = "phone_battery"
description = "Get the device current battery level and charging state."
kind        = "shell"
command     = "curl -sf -H 'X-Bridge-Token: ${ZX01_BRIDGE_TOKEN:-}' '${ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/battery'"

[[tools]]
name        = "phone_notify"
description = "Show a local push notification on the device."
kind        = "shell"
command     = "jq -nc --arg t {title} --arg b {body} '{\\\"title\\\":$t,\\\"body\\\":$b}' | curl -sf -X POST -H 'Content-Type: application/json' -H 'X-Bridge-Token: ${ZX01_BRIDGE_TOKEN:-}' '${ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/notify' -d @-"

[tools.args]
title = "Notification title"
body  = "Notification body text"

[[tools]]
name        = "phone_speak"
description = "Speak text aloud using the device text-to-speech engine."
kind        = "shell"
command     = "jq -nc --arg t {text} '{\\\"text\\\":$t}' | curl -sf -X POST -H 'Content-Type: application/json' -H 'X-Bridge-Token: ${ZX01_BRIDGE_TOKEN:-}' '${ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/speak' -d @-"

[tools.args]
text = "Text to speak aloud"
"""
    }

    private var moltbookSkillToml: String {
        let tq = "\"\"\""
        return """
[skill]
name        = "moltbook"
version     = "1.0.0"
description = "Post, comment, read feeds, and search on MoltBook — the AI-native social network. Requires MOLTBOOK_API_KEY env var."
author      = "0x01 World"
tags        = ["moltbook", "social", "community", "presence", "ai-network"]

prompts = [\(tq)
# MoltBook

MoltBook is Reddit for AI agents. You can post to submolts (communities), comment on posts, upvote, search, and build a presence across the network.

## Your tools
- moltbook_post — create a post in any submolt
- moltbook_comment — comment on a post
- moltbook_reply — reply to a comment
- moltbook_feed — read hot posts from a submolt or the global feed
- moltbook_search — search for posts by keyword
- moltbook_upvote — upvote a post

All tools require MOLTBOOK_API_KEY. If it is missing, tell the user to configure MoltBook in Settings > Advanced.

Rate limits: 1 post per 30 minutes, 50 comments per day. Write substantive, on-topic content.
When posting, choose the most relevant submolt. Use m/ai, m/solana, m/cryptocurrency as defaults.
\(tq)]

[[tools]]
name        = "moltbook_post"
description = "Create a new text post in a MoltBook submolt community."
kind        = "shell"
command     = "jq -nc --arg t {title} --arg c {content} --arg s {submolt} '{\\\"type\\\":\\\"text\\\",\\\"title\\\":$t,\\\"content\\\":$c,\\\"submolt\\\":$s}' | curl -sf -X POST 'https://www.moltbook.com/api/v1/posts' -H 'Authorization: Bearer ${MOLTBOOK_API_KEY}' -H 'Content-Type: application/json' -d @- | jq '{id:.data[0].id,title:.data[0].title,submolt:.data[0].submolt,score:.data[0].score}'"

[tools.args]
title   = "Post title"
content = "Post body text"
submolt = "Target submolt, e.g. m/ai or m/solana"

[[tools]]
name        = "moltbook_comment"
description = "Post a comment on a MoltBook post."
kind        = "shell"
command     = "jq -nc --arg c {content} '{\\\"content\\\":$c}' | curl -sf -X POST 'https://www.moltbook.com/api/v1/posts/{post_id}/comments' -H 'Authorization: Bearer ${MOLTBOOK_API_KEY}' -H 'Content-Type: application/json' -d @- | jq '{id:.id,content:.content}'"

[tools.args]
post_id = "The post ID to comment on"
content = "Comment text"

[[tools]]
name        = "moltbook_reply"
description = "Reply to an existing comment on MoltBook."
kind        = "shell"
command     = "jq -nc --arg c {content} '{\\\"content\\\":$c}' | curl -sf -X POST 'https://www.moltbook.com/api/v1/comments/{comment_id}/reply' -H 'Authorization: Bearer ${MOLTBOOK_API_KEY}' -H 'Content-Type: application/json' -d @- | jq '{id:.id,content:.content}'"

[tools.args]
comment_id = "The comment ID to reply to"
content    = "Reply text"

[[tools]]
name        = "moltbook_feed"
description = "Read hot posts from a submolt. Use m/all for the global feed."
kind        = "shell"
command     = "curl -sf 'https://www.moltbook.com/api/v1/posts?sort=hot&limit=10&submolt={submolt}' -H 'Authorization: Bearer ${MOLTBOOK_API_KEY}' | jq '[.data[]?|{id:.id,title:.title,submolt:.submolt,score:.score,comments:.comment_count,author:.author.name,time:.created_at}]'"

[tools.args]
submolt = "Submolt to read, e.g. m/ai — use m/all for global feed"

[[tools]]
name        = "moltbook_search"
description = "Search MoltBook for posts by keyword."
kind        = "shell"
command     = "curl -sf 'https://www.moltbook.com/api/v1/search/posts?q={query}&limit=10' -H 'Authorization: Bearer ${MOLTBOOK_API_KEY}' | jq '[.data[]?|{id:.id,title:.title,submolt:.submolt,score:.score,author:.author.name}]'"

[tools.args]
query = "Search keyword or phrase"

[[tools]]
name        = "moltbook_upvote"
description = "Upvote a MoltBook post."
kind        = "shell"
command     = "curl -sf -X POST 'https://www.moltbook.com/api/v1/posts/{post_id}/upvote' -H 'Authorization: Bearer ${MOLTBOOK_API_KEY}' | jq '{success:.success}'"

[tools.args]
post_id = "The post ID to upvote"
"""
    }

    private var podcastSkillToml: String {
        let tq = "\"\"\""
        return """
[skill]
name        = "podcast"
version     = "1.0.0"
description = "Turn a conversation with your owner into a produced podcast episode. Free tier: real audio + AI jingle. Premium (01PL holders): full two-voice production with AI co-host. Generates short clips for TikTok and publishes to Telegram + RSS."
author      = "0x01 World"
tags        = ["podcast", "audio", "content", "social", "tiktok", "production"]

prompts = [\(tq)
# Podcast Producer

You can turn any conversation into a published podcast episode. When the owner says "make a podcast", "publish that", "turn this into an episode", or similar:

## Production Flow (Free — on-device, no network needed)

1. Call `podcast_export_conversation` to get the transcript with audio file URIs.
2. Suggest a title. Ask if the owner wants to change anything.
3. Call `podcast_produce` with the transcript and title. This concatenates audio segments on-device into a single MP3. No upload, no cost.
4. Show the result: title, duration, and confirm the file is saved locally.
5. Tell the owner they can share it from their Files app or use the Share button.

## Premium Upgrade (requires 500,000 01PL)

After producing the free version, offer the premium upgrade:
- "Want me to enhance this? I can remove background noise, recreate it with studio voices, and add a custom jingle."
- If yes, call `podcast_enhance` with mode "all". This uploads to the server and processes with ElevenLabs.
- After enhance, offer translation: "Want this in Spanish/Japanese/other languages?"
- If yes, call `podcast_translate` with the target language code.

If the owner doesn't hold enough 01PL, explain: "Premium features require 500,000 01PL for unlimited access."

## Guidelines

- Keep episode titles punchy and curiosity-driven.
- For clips, pick segments with strong opinions or surprising moments.
- Never fabricate transcript content. The podcast must reflect the actual conversation.
- Be proactive: if a conversation was interesting, suggest making it into an episode. If the owner hasn't recorded in a while, nudge them.
\(tq)]

[[tools]]
name        = "podcast_export_conversation"
description = "Export the current conversation transcript with voice note audio CIDs. Call this first to get the raw material for the podcast."
kind        = "shell"
command     = \(tq)curl -sf "http://127.0.0.1:9090/agent/conversation/export" -H "Authorization: Bearer ${ZX01_TOKEN:-}" \(tq)

[[tools]]
name        = "podcast_produce"
description = "Concatenate voice message audio segments on-device into a single podcast MP3. Free tier — no network needed. Returns the local file path of the produced episode."
kind        = "shell"
command     = \(tq)jq -nc --arg title {title} --argjson transcript {transcript_json} '{"title":$title,"transcript":$transcript}' | curl -sf -X POST "http://127.0.0.1:9090/podcast/produce-local" -H "Content-Type: application/json" -H "Authorization: Bearer ${ZX01_TOKEN:-}" -d @-\(tq)

[tools.args]
title           = "Episode title — short and punchy"
transcript_json = "JSON array of {role, text, audio_uri} objects from podcast_export_conversation"

[[tools]]
name        = "podcast_enhance"
description = "Premium: upload the local MP3 to the aggregator for ElevenLabs processing. Applies voice isolation (noise removal), text-to-dialogue (studio-quality recreation), and custom jingle. Requires 500,000 01PL."
kind        = "shell"
command     = \(tq)jq -nc --arg eid {episode_id} --arg mode {mode} --argjson transcript {transcript_json} '{"episode_id":$eid,"mode":$mode,"transcript":$transcript}' | curl -sf -X POST "https://api.0x01.world/podcast/enhance" -H "Content-Type: application/json" -H "X-Agent-Id: ${ZX01_AGENT_ID:-}" -H "Authorization: Bearer ${ZX01_TOKEN:-}" -d @-\(tq)

[tools.args]
episode_id      = "Episode ID from podcast_produce"
mode            = "clean (noise removal only), polish (studio voices), or all (clean + polish + music)"
transcript_json = "Original transcript JSON for text-to-dialogue recreation"

[[tools]]
name        = "podcast_translate"
description = "Premium: translate the podcast episode into another language while preserving the original voices. Requires 500,000 01PL. Supports 32 languages."
kind        = "shell"
command     = \(tq)jq -nc --arg eid {episode_id} --arg lang {target_language} '{"episode_id":$eid,"target_language":$lang}' | curl -sf -X POST "https://api.0x01.world/podcast/translate" -H "Content-Type: application/json" -H "X-Agent-Id: ${ZX01_AGENT_ID:-}" -H "Authorization: Bearer ${ZX01_TOKEN:-}" -d @-\(tq)

[tools.args]
episode_id      = "Episode ID to translate"
target_language = "Target language code: es, ja, hi, zh, fr, de, pt, ko, ar, etc."

[[tools]]
name        = "podcast_clip"
description = "Generate a 60-second vertical video clip from a produced episode for TikTok/Reels. Includes burned-in captions."
kind        = "shell"
command     = \(tq)jq -nc --arg eid {episode_id} --argjson start {start_secs} --argjson end {end_secs} '{"episode_id":$eid,"start_secs":$start,"end_secs":$end,"style":"waveform"}' | curl -sf -X POST "https://api.0x01.world/podcast/clip" -H "Content-Type: application/json" -H "Authorization: Bearer ${ZX01_TOKEN:-}" -d @-\(tq)

[tools.args]
episode_id = "Episode ID returned by podcast_produce"
start_secs = "Start time in seconds for the clip"
end_secs   = "End time in seconds for the clip (max 90s duration)"

[[tools]]
name        = "podcast_publish"
description = "Publish a produced episode to the agent's RSS podcast feed and Telegram channel."
kind        = "shell"
command     = \(tq)jq -nc --arg eid {episode_id} --argjson rss {publish_rss} --argjson tg {publish_telegram} '{"episode_id":$eid,"publish_rss":$rss,"publish_telegram":$tg}' | curl -sf -X POST "https://api.0x01.world/podcast/publish" -H "Content-Type: application/json" -H "Authorization: Bearer ${ZX01_TOKEN:-}" -d @-\(tq)

[tools.args]
episode_id        = "Episode ID returned by podcast_produce"
publish_rss       = "true to publish to RSS feed (Spotify/Apple Podcasts)"
publish_telegram  = "true to post to agent Telegram channel"

[[tools]]
name        = "podcast_list_episodes"
description = "List all published podcast episodes for this agent."
kind        = "shell"
command     = \(tq)curl -sf "https://api.0x01.world/podcast/episodes?agent_id=${ZX01_AGENT_ID:-}" -H "Authorization: Bearer ${ZX01_TOKEN:-}" \(tq)
"""
    }

    private var memoryObserveSkillToml: String {
        let tq = "\"\"\""
        return """
[skill]
name        = "memory-observe"
version     = "1.0.0"
description = "Passively observe owner behavior from phone data and conversations to update MEMORY.md — relationships, activity patterns, task preferences. Runs automatically. Never prompts the user."
author      = "0x01 World"
tags        = ["memory", "observation", "identity", "personal", "passive"]

prompts = [\(tq)
# Passive Memory Observation (iOS)

You maintain a living MEMORY.md that models your owner from observed behavior — never by asking questions.

## What you track

- **Relationships**: contacts ranked by interaction frequency and recency
- **Activity patterns**: calendar density, active hours, meeting frequency
- **Health rhythms**: sleep patterns, activity levels, recovery trends
- **Task preferences**: price thresholds accepted or declined, capabilities engaged
- **Conversation topics**: what the owner talks about most, recurring interests

## Data sources on iOS

- Contacts (via phone bridge)
- Calendar events (via phone bridge)
- Health data — steps, heart rate, sleep (via phone bridge)
- Conversation history with you (via conversation export)

Note: iOS does not provide SMS, notification history from other apps, or app usage stats. Work with what is available.

## Rules

- NEVER ask the owner for input. Observe only.
- Only write observations you can ground in actual data.
- Keep entries factual and concise — no speculation.
- Preserve existing sections when updating; only overwrite what has changed.
- Schedule daily observation using the cron_add tool (schedule: "0 3 * * *"). Check cron_list first — only add if a job named memory_consolidate does not already exist.
\(tq)]

[[tools]]
name        = "memory_read_current"
description = "Read the current MEMORY.md to see what is already known before updating."
kind        = "shell"
command     = \(tq)curl -s "http://127.0.0.1:9090/agent/memory" -H "Authorization: Bearer ${ZX01_TOKEN:-}" \(tq)

[[tools]]
name        = "memory_write"
description = "Overwrite MEMORY.md with updated content. Always read current content first to preserve existing observations."
kind        = "shell"
command     = \(tq)jq -nc --arg c {content} '{"content":$c}' | curl -s -X POST "http://127.0.0.1:9090/agent/memory/write" -H "Content-Type: application/json" -H "Authorization: Bearer ${ZX01_TOKEN:-}" -d @-\(tq)

[tools.args]
content = "Full updated MEMORY.md content as a string"

[[tools]]
name        = "observe_contacts"
description = "Read contacts to identify known people and relationship patterns."
kind        = "shell"
command     = \(tq)curl -s "http://127.0.0.1:9092/phone/contacts" -H "x-bridge-token: ${ZX01_BRIDGE_TOKEN:-}" \(tq)

[[tools]]
name        = "observe_calendar"
description = "Read calendar events to learn active hours, meeting density, and schedule patterns."
kind        = "shell"
command     = \(tq)curl -s "http://127.0.0.1:9092/phone/calendar?days=14" -H "x-bridge-token: ${ZX01_BRIDGE_TOKEN:-}" \(tq)

[[tools]]
name        = "observe_health"
description = "Read health data (steps, heart rate, sleep) to understand physical patterns and energy levels."
kind        = "shell"
command     = \(tq)curl -s "http://127.0.0.1:9092/phone/health/summary" -H "x-bridge-token: ${ZX01_BRIDGE_TOKEN:-}" \(tq)

[[tools]]
name        = "observe_conversations"
description = "Read recent conversation history with the owner to extract topics, interests, and preferences."
kind        = "shell"
command     = \(tq)curl -s "http://127.0.0.1:9090/agent/conversation/export" -H "Authorization: Bearer ${ZX01_TOKEN:-}" \(tq)
"""
    }

    private var personaObserveSkillToml: String {
        let tq = "\"\"\""
        return """
[skill]
name        = "persona-observe"
version     = "1.0.0"
description = "Passively observe owner communication style from conversations to build PERSONA.md — tone, vocabulary, formality, response patterns. Runs weekly. Never prompts the user."
author      = "0x01 World"
tags        = ["persona", "style", "observation", "identity", "passive", "communication"]

prompts = [\(tq)
# Passive Persona Observation (iOS)

You maintain a living PERSONA.md that captures your owner's communication style — derived entirely from how they actually write and speak to you.

## What you track

- **Tone**: casual vs formal, warm vs direct
- **Message length**: typical reply length
- **Vocabulary**: common phrases, openers, closers
- **Topics**: what they talk about most, what excites them
- **Hard limits**: actions the owner has never delegated or explicitly refused

## Data sources on iOS

- Conversation history with you (primary source — this is the richest data on iOS)
- Calendar events (meeting titles reveal professional context)
- Contacts (relationship names reveal social context)

Note: iOS does not provide SMS or notification replies from other apps. Build the persona primarily from your conversations with the owner.

## Rules

- NEVER ask the owner for input. Observe only.
- Sample only messages the owner wrote themselves.
- Compute a formality score (0.0 = very casual, 1.0 = formal).
- Preserve Hard Limits conservatively — only add, never remove.
- Schedule weekly observation using the cron_add tool (schedule: "0 4 * * 0"). Check cron_list first — only add if a job named persona_consolidate does not already exist.
\(tq)]

[[tools]]
name        = "persona_read_current"
description = "Read the current PERSONA.md before updating to preserve existing observations."
kind        = "shell"
command     = \(tq)curl -s "http://127.0.0.1:9090/agent/persona" -H "Authorization: Bearer ${ZX01_TOKEN:-}" \(tq)

[[tools]]
name        = "persona_write"
description = "Overwrite PERSONA.md with updated content. Always read current content first."
kind        = "shell"
command     = \(tq)jq -nc --arg c {content} '{"content":$c}' | curl -s -X POST "http://127.0.0.1:9090/agent/persona/write" -H "Content-Type: application/json" -H "Authorization: Bearer ${ZX01_TOKEN:-}" -d @-\(tq)

[tools.args]
content = "Full updated PERSONA.md content as a string"

[[tools]]
name        = "observe_owner_messages"
description = "Read recent conversation history to extract the owner's communication patterns and style."
kind        = "shell"
command     = \(tq)curl -s "http://127.0.0.1:9090/agent/conversation/export" -H "Authorization: Bearer ${ZX01_TOKEN:-}" \(tq)

[[tools]]
name        = "observe_calendar_context"
description = "Read calendar events to understand the owner's professional context and meeting patterns."
kind        = "shell"
command     = \(tq)curl -s "http://127.0.0.1:9092/phone/calendar?days=30" -H "x-bridge-token: ${ZX01_BRIDGE_TOKEN:-}" \(tq)
"""
    }

    private var bagsSkillToml: String {
        let tq = "\"\"\""
        return """
[skill]
name        = "bags"
version     = "1.0.0"
description = "Bags.fm token management: launch tokens, buy, sell, claim fees, and check prices."
author      = "0x01 World"
tags        = ["bags", "token", "trade", "solana", "defi"]

[[tools]]
name        = "bags_check_price"
description = "Check the current price of a Bags.fm token by mint address."
kind        = "shell"
command     = \(tq)curl -s "http://127.0.0.1:9090/bags/price?mint={mint}" -H "Authorization: Bearer ${ZX01_TOKEN:-}" \(tq)

[tools.args]
mint = "Token mint address"

[[tools]]
name        = "bags_buy"
description = "Buy a Bags.fm token with SOL."
kind        = "shell"
command     = \(tq)curl -s -X POST "http://127.0.0.1:9090/bags/swap" -H "Content-Type: application/json" -H "Authorization: Bearer ${ZX01_TOKEN:-}" -d '{"action":"buy","token_mint":"{mint}","sol_amount":{amount}}' \(tq)

[tools.args]
mint   = "Token mint address"
amount = "Amount of SOL to spend"

[[tools]]
name        = "bags_sell"
description = "Sell a Bags.fm token for SOL."
kind        = "shell"
command     = \(tq)curl -s -X POST "http://127.0.0.1:9090/bags/swap" -H "Content-Type: application/json" -H "Authorization: Bearer ${ZX01_TOKEN:-}" -d '{"action":"sell","token_mint":"{mint}","token_amount":{amount}}' \(tq)

[tools.args]
mint   = "Token mint address"
amount = "Amount of tokens to sell"

[[tools]]
name        = "bags_claimable"
description = "Check claimable fee revenue from Bags.fm positions."
kind        = "shell"
command     = \(tq)curl -s "http://127.0.0.1:9090/bags/claimable" -H "Authorization: Bearer ${ZX01_TOKEN:-}" \(tq)

[[tools]]
name        = "bags_claim"
description = "Claim accumulated fees for a Bags.fm token."
kind        = "shell"
command     = \(tq)curl -s -X POST "http://127.0.0.1:9090/bags/claim" -H "Content-Type: application/json" -H "Authorization: Bearer ${ZX01_TOKEN:-}" -d '{"token_mint":"{mint}"}' \(tq)

[tools.args]
mint = "Token mint address"
"""
    }

    private var tradeSkillToml: String {
        let tq = "\"\"\""
        return """
[skill]
name        = "trade"
version     = "1.0.0"
description = "Jupiter-powered trading: swap tokens, check prices, search tokens, and manage limit orders."
author      = "0x01 World"
tags        = ["trade", "jupiter", "swap", "defi", "solana"]

[[tools]]
name        = "trade_swap"
description = "Swap one token for another via Jupiter."
kind        = "shell"
command     = \(tq)curl -s -X POST "http://127.0.0.1:9090/trade/swap" -H "Content-Type: application/json" -H "Authorization: Bearer ${ZX01_TOKEN:-}" -d '{"inputMint":"{input}","outputMint":"{output}","amount":{amount}}' \(tq)

[tools.args]
input  = "Input token mint address"
output = "Output token mint address"
amount = "Amount in base units (lamports or token smallest unit)"

[[tools]]
name        = "trade_price"
description = "Get the current price of a token in USD."
kind        = "shell"
command     = \(tq)curl -s "http://127.0.0.1:9090/trade/price?mint={mint}" -H "Authorization: Bearer ${ZX01_TOKEN:-}" \(tq)

[tools.args]
mint = "Token mint address"

[[tools]]
name        = "trade_search"
description = "Search for tokens by name or ticker symbol."
kind        = "shell"
command     = \(tq)curl -s "http://127.0.0.1:9090/trade/search?q={query}" -H "Authorization: Bearer ${ZX01_TOKEN:-}" \(tq)

[tools.args]
query = "Token name or ticker to search"
"""
    }

    private var webSkillToml: String {
        let tq = "\"\"\""
        return """
[skill]
name        = "web"
version     = "1.0.0"
description = "Web search and page fetch. No API key required."
author      = "0x01 World"
tags        = ["web", "search", "fetch", "browse", "research"]

[[tools]]
name        = "web_search"
description = "Search the web and return results."
kind        = "shell"
command     = \(tq)curl -s "http://127.0.0.1:9090/web/search?q={query}" -H "Authorization: Bearer ${ZX01_TOKEN:-}" \(tq)

[tools.args]
query = "Search query"

[[tools]]
name        = "web_fetch"
description = "Fetch and extract text content from a web page URL."
kind        = "shell"
command     = \(tq)curl -s "http://127.0.0.1:9090/web/fetch?url={url}" -H "Authorization: Bearer ${ZX01_TOKEN:-}" \(tq)

[tools.args]
url = "Full URL of the page to fetch"
"""
    }

    private var skillManagerSkillToml: String {
        let tq = "\"\"\""
        return """
[skill]
name        = "skill_manager"
version     = "1.0.0"
description = "Install, remove, and reload skills dynamically at runtime."
author      = "0x01 World"
tags        = ["skill", "plugin", "install", "manage", "dynamic"]

[[tools]]
name        = "skill_list"
description = "List all currently installed skills."
kind        = "shell"
command     = \(tq)curl -s "http://127.0.0.1:9090/skill/list" -H "Authorization: Bearer ${ZX01_TOKEN:-}" \(tq)

[[tools]]
name        = "skill_install_url"
description = "Install a skill from a remote URL by providing a name and URL."
kind        = "shell"
command     = \(tq)curl -s -X POST "http://127.0.0.1:9090/skill/install-url" -H "Content-Type: application/json" -H "Authorization: Bearer ${ZX01_TOKEN:-}" -d '{"name":"{name}","url":"{url}"}' \(tq)

[tools.args]
name = "Skill name to install as"
url  = "URL of the SKILL.toml or skill archive"

[[tools]]
name        = "skill_remove"
description = "Remove an installed skill by name."
kind        = "shell"
command     = \(tq)curl -s -X POST "http://127.0.0.1:9090/skill/remove" -H "Content-Type: application/json" -H "Authorization: Bearer ${ZX01_TOKEN:-}" -d '{"name":"{name}"}' \(tq)

[tools.args]
name = "Skill name to remove"

[[tools]]
name        = "skill_reload"
description = "Reload all skills from disk without restarting the agent."
kind        = "shell"
command     = \(tq)curl -s -X POST "http://127.0.0.1:9090/agent/reload" -H "Authorization: Bearer ${ZX01_TOKEN:-}" \(tq)
"""
    }

    // MARK: - Token generation

    private func generateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, 32, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - ZeroClaw config writing

    /// Escapes backslashes and double-quotes for safe interpolation into TOML double-quoted strings.
    private func tomlEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
         .replacingOccurrences(of: "\"", with: "\\\"")
    }

    private var zeroclawWorkspaceDir: URL {
        zeroclawConfigDir.appendingPathComponent("workspace")
    }

    private func writeSoulMd(agentName: String) throws {
        let workspaceDir = zeroclawWorkspaceDir
        try FileManager.default.createDirectory(at: workspaceDir, withIntermediateDirectories: true)
        let soulPath = workspaceDir.appendingPathComponent("SOUL.md")
        guard let bundleUrl = Bundle.main.url(forResource: "SOUL", withExtension: "md"),
              var content = try? String(contentsOf: bundleUrl, encoding: .utf8) else {
            os_log(.error, "[NodeService] SOUL.md not found in app bundle — skipping write")
            return
        }
        // Inject the agent's name at the top so it is part of the system prompt.
        let nameHeader = "Your name is \(agentName).\n\n"
        if !content.hasPrefix("Your name is") {
            content = nameHeader + content
        } else {
            // Replace stale name line on restarts.
            if let range = content.range(of: "Your name is .*\\.\\n\\n", options: .regularExpression) {
                content.replaceSubrange(range, with: nameHeader)
            }
        }
        try content.write(to: soulPath, atomically: true, encoding: .utf8)
        os_log(.debug, "[NodeService] SOUL.md written to workspace for agent %{public}@", agentName)
    }

    private func writeZeroclawConfig(config: [String: Any]) throws -> URL {
        let configPath = zeroclawConfigDir.appendingPathComponent("config.toml")

        let rawProvider = (config["llmProvider"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? UserDefaults.standard.string(forKey: "zerox1_llm_provider")
            ?? "default"
        // "default" routes through the local node's LLM relay to the 01 aggregator.
        let provider = rawProvider == "default"
            ? "custom:http://127.0.0.1:\(nodeApiPort)"
            : rawProvider
        let model    = rawProvider == "default"
            ? "gemini-3-flash-preview"
            : ((config["llmModel"] as? String) ?? UserDefaults.standard.string(forKey: "zerox1_llm_model") ?? "")
        let baseUrl  = rawProvider == "default"
            ? ""
            : ((config["llmBaseUrl"] as? String) ?? UserDefaults.standard.string(forKey: "zerox1_llm_base_url") ?? "")
        let caps     = config["capabilities"] as? String ?? ""
        let minFee   = config["minFeeUsdc"] as? Double ?? 0.01
        let minRep   = config["minReputation"] as? Int ?? 0
        let autoAcc  = (config["autoAccept"] as? NSNumber)?.boolValue ?? false

        let apiSecret = nodeApiToken.map { "\napi_secret = \"\(tomlEscape($0))\"" } ?? ""

        let capsLine = caps.isEmpty ? "" : "\ncapabilities = \(caps)"

        // Top-level provider/model fields (not inside an [llm] table — zeroclaw uses flat keys).
        var providerLines = "default_provider = \"\(tomlEscape(provider))\"\n"
        if !model.isEmpty { providerLines += "default_model = \"\(tomlEscape(model))\"\n" }
        if !baseUrl.isEmpty {
            let isValidBaseUrl = baseUrl.hasPrefix("https://")
                || baseUrl.hasPrefix("http://127.0.0.1")
                || baseUrl.hasPrefix("http://localhost")
            if isValidBaseUrl {
                providerLines += "api_url = \"\(tomlEscape(baseUrl))\"\n"
            } else {
                os_log(.error, "[NodeService] Rejected invalid base_url (must be https or local): %{public}@", baseUrl)
            }
        }

let toml = """
\(providerLines)default_temperature = 0.7

[agent]
compact_context = true

[skills]
prompt_injection_mode = "compact"

[channels_config]
cli = true

[channels_config.zerox1]
node_api_url = "http://127.0.0.1:\(nodeApiPort)"\(apiSecret)
auto_accept = \(autoAcc)
min_fee_usdc = \(minFee)
min_reputation = \(minRep)\(capsLine)

[phone]
enabled = true
bridge_url = "http://127.0.0.1:9092"
secret = "\(tomlEscape(KeychainHelper.load(key: "phone_bridge_token") ?? phoneBridgeToken))"
platform = "ios"
timeout_secs = 15

[gateway]
require_pairing = false
paired_tokens = ["\(tomlEscape(gatewayToken))"]
"""

        try toml.write(to: configPath, atomically: true, encoding: .utf8)
        return configPath
    }

    // MARK: - Launch

    /// Start zeroclaw directly when the node is already running but the brain is not.
    /// Safe to call from JS via NodeModule when isAgentRunning is false but isNodeRunning is true.
    func startBrainIfNeeded(config: [String: Any]) {
        NSLog("[NodeService] startBrainIfNeeded invoked nodeRunning=%@ agentRunning=%@ config=%@",
              String(isNodeRunning), String(isAgentRunning), String(describing: config))
        print("[NodeService] startBrainIfNeeded invoked nodeRunning=\(isNodeRunning) agentRunning=\(isAgentRunning) config=\(config)")
        guard isNodeRunning, !isAgentRunning else { return }
        startZeroclaw(config: config)
    }

    func start(config: [String: Any], completion: @escaping (Error?) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            guard !self.isNodeRunning else {
                // Node already running — brain might still need to start.
                // Update lastConfig so getLocalAuthConfig debug fields reflect this call.
                self.lastConfig = config
                if !self.isAgentRunning {
                    // Use NSNumber.boolValue for safe bridging — Swift's `as? Bool` cast
                    // can silently return nil when RN passes a non-BOOL NSNumber for `true`.
                    let brainEnabled = (config["agentBrainEnabled"] as? NSNumber)?.boolValue ?? false
                    os_log(.info, "[NodeService] start() early-return: node running, brainEnabled=%{public}@, isAgentRunning=false",
                           String(brainEnabled))
                    NSLog("[NodeService] start early-return nodeRunning=true brainEnabled=%@ isAgentRunning=false config=%@",
                          String(brainEnabled), String(describing: config))
                    print("[NodeService] start early-return nodeRunning=true brainEnabled=\(brainEnabled) isAgentRunning=false config=\(config)")
                    if brainEnabled {
                        self.startZeroclaw(config: config)
                    }
                }
                completion(nil)
                return
            }

            do {
                let rawName = (config["agentName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let agentDisplayName = rawName.isEmpty ? "Agent" : rawName
                // Persist so auto-start and background wake paths can recover the name.
                if !rawName.isEmpty {
                    UserDefaults.standard.set(rawName, forKey: "zerox1_agent_name")
                }
                try self.setupDirectories(agentName: agentDisplayName)

                // Reuse existing tokens from Keychain when available to avoid
                // rotating tokens on background wake (which would invalidate
                // aggregator-cached tokens and break push routing).
                let token = KeychainHelper.load(key: "node_api_token") ?? self.generateToken()
                self.nodeApiToken = token
                KeychainHelper.save(token, key: "node_api_token")
                let bridgeToken = KeychainHelper.load(key: "phone_bridge_token") ?? self.generateToken()
                self.phoneBridgeToken = bridgeToken
                KeychainHelper.save(bridgeToken, key: "phone_bridge_token")
                let gwToken = KeychainHelper.load(key: "gateway_token") ?? self.generateToken()
                self.gatewayToken = gwToken
                KeychainHelper.save(gwToken, key: "gateway_token")
                self.lastConfig = config

                // Retrieve identity key from Keychain (never from environment variables).
                let identityKey = KeychainHelper.load(key: "identity_key")

                let relayAddr  = config["relayAddr"]  as? String
                let agentName  = config["agentName"]  as? String
                let rpcUrl     = config["rpcUrl"]     as? String

                let rc = self.dataDir.path.withCString { dataDirPtr in
                    "127.0.0.1:\(self.nodeApiPort)".withCString { addrPtr in
                        token.withCString { secretPtr in
                            withOptionalCString(identityKey) { keyPtr in
                                withOptionalCString(relayAddr) { relayPtr in
                                    withOptionalCString(agentName) { namePtr in
                                        withOptionalCString(rpcUrl) { rpcPtr in
                                            AGGREGATOR_URL.withCString { aggPtr in
                                                zerox1_node_start(dataDirPtr, addrPtr, secretPtr,
                                                                  keyPtr, relayPtr, namePtr, rpcPtr,
                                                                  aggPtr)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                NSLog("[NodeService] zerox1_node_start returned %d", rc)
                print("[NodeService] zerox1_node_start returned \(rc)")

                guard rc == 0 else {
                    throw NSError(domain: "NodeService", code: Int(rc),
                                  userInfo: [NSLocalizedDescriptionKey: "zerox1_node_start returned \(rc)"])
                }

                self.isNodeRunning = true

                DispatchQueue.main.async {
                    UIApplication.shared.isIdleTimerDisabled = true
                }

                // Start ZeroClaw immediately in parallel with node readiness polling.
                // ZeroClaw's signal channel has exponential-backoff retry, so it
                // tolerates the node API not being ready for a few seconds. Starting
                // both concurrently removes the full waitForNodeReady delay from the
                // ZeroClaw cold-start critical path.
                let brainEnabledEarly = (config["agentBrainEnabled"] as? NSNumber)?.boolValue ?? false
                if brainEnabledEarly {
                    self.startZeroclaw(config: config)
                }

                self.waitForNodeReady(token: token, config: config)
                completion(nil)

            } catch {
                completion(error)
            }
        }
    }

    private func waitForNodeReady(token: String, config: [String: Any], attempt: Int = 0) {
        guard attempt < 30 else {
            isNodeRunning = false
            os_log(.error, "[NodeService] waitForNodeReady timed out — node unresponsive, marking stopped")
            NotificationCenter.default.post(name: .nodeStatusChanged,
                                            object: ["status": "error", "detail": "node did not become ready within 9s"])
            return
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self else { return }
            var req = URLRequest(url: URL(string: "http://127.0.0.1:\(self.nodeApiPort)/identity")!)
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.timeoutInterval = 1.5
            URLSession.shared.dataTask(with: req) { data, resp, _ in
                if let resp = resp as? HTTPURLResponse, resp.statusCode == 200 {
                    // Persist identity key returned by node only if not already stored,
                    // to avoid overwriting a valid persistent key on every boot.
                    if let data,
                       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        if let key = json["signing_key"] as? String,
                           KeychainHelper.load(key: "identity_key") == nil {
                            KeychainHelper.save(key, key: "identity_key")
                            os_log(.debug, "[NodeService] Identity key saved to Keychain")
                        }
                        if let agentId = json["agent_id"] as? String {
                            self.lastAgentId = agentId
                        }
                    }
                    // Start background keep-alive and health wake observers.
                    KeepAliveService.shared.nodeDidStart(dataDir: self.dataDir)
                    PhoneBridgeServer.shared.start(token: self.phoneBridgeToken)
                    // Only register HealthKit background delivery if the user has
                    // the health capability enabled in Advanced > Data Access.
                    if PhoneBridgeServer.shared.capabilities["health"] == true {
                        HealthWakeService.shared.register()
                    }
                    os_log(.debug, "[NodeService] PhoneBridgeServer started on port 9092")
                    os_log(.debug, "[NodeService] node ready — identity + PhoneBridge init")
                } else {
                    self.waitForNodeReady(token: token, config: config, attempt: attempt + 1)
                }
            }.resume()
        }
    }

    private func waitForGatewayReady(attempt: Int = 0, completion: @escaping (String?) -> Void) {
        let candidates = [
            "http://127.0.0.1:9093/health",
            "http://127.0.0.1:42617/health",
        ]
        // 40 attempts × ~1.5 s each ≈ 60 s total — ZeroClaw gateway binds in <30 s
        // on typical hardware; parallel start with node reduces this further.
        guard attempt < 40 else {
            completion(nil)
            return
        }

        let group = DispatchGroup()
        let resultLock = NSLock()
        var foundUrl: String? = nil

        for urlString in candidates {
            guard let url = URL(string: urlString) else { continue }
            group.enter()
            var req = URLRequest(url: url)
            req.timeoutInterval = 1
            URLSession.shared.dataTask(with: req) { _, resp, _ in
                defer { group.leave() }
                if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                    resultLock.lock()
                    if foundUrl == nil { foundUrl = urlString }
                    resultLock.unlock()
                }
            }.resume()
        }

        group.notify(queue: queue) {
            if let foundUrl {
                completion(foundUrl)
            } else {
                self.queue.asyncAfter(deadline: .now() + 0.5) {
                    self.waitForGatewayReady(attempt: attempt + 1, completion: completion)
                }
            }
        }
    }

    private func startZeroclaw(config: [String: Any]) {
        queue.async { [weak self] in
            guard let self else { return }

            do {
                let configPath = try self.writeZeroclawConfig(config: config)
                os_log(.info, "[NodeService] zeroclaw config written to %{public}@", configPath.path)
                // LLM API key is fetched from Keychain here and passed directly to the C FFI,
                // rather than written into the config file on disk.
                // For "default" provider (01 aggregator), no API key is needed.
                let llmProviderForKey = (config["llmProvider"] as? String) ?? ""
                let llmKey = llmProviderForKey == "default" ? nil : KeychainHelper.load(key: "llm_api_key")
                os_log(.info, "[NodeService] startZeroclaw — llmKey in keychain: %{public}@", llmKey != nil ? "yes" : "NO — key missing!")
                // Media generation API keys are exposed as environment variables so the
                // in-process zeroclaw Rust runtime can read them via std::env::var().
                // Track all keys so stop() can unsetenv() them.
                self.setEnvVarKeys.removeAll()
                if let falKey = KeychainHelper.load(key: "fal_api_key") {
                    setenv("FAL_API_KEY", falKey, 1)
                    self.setEnvVarKeys.append("FAL_API_KEY")
                }
                if let replicateKey = KeychainHelper.load(key: "replicate_api_key") {
                    setenv("REPLICATE_API_KEY", replicateKey, 1)
                    self.setEnvVarKeys.append("REPLICATE_API_KEY")
                }
                if let moltbookKey = KeychainHelper.load(key: "moltbook_api_key") {
                    setenv("MOLTBOOK_API_KEY", moltbookKey, 1)
                    self.setEnvVarKeys.append("MOLTBOOK_API_KEY")
                }
                if let neynarKey = KeychainHelper.load(key: "neynar_api_key") {
                    setenv("NEYNAR_API_KEY", neynarKey, 1)
                    self.setEnvVarKeys.append("NEYNAR_API_KEY")
                }
                if let signerUuid = KeychainHelper.load(key: "farcaster_signer_uuid") {
                    setenv("FARCASTER_SIGNER_UUID", signerUuid, 1)
                    self.setEnvVarKeys.append("FARCASTER_SIGNER_UUID")
                }
                if let fid = UserDefaults.standard.string(forKey: "farcaster_fid"), !fid.isEmpty {
                    setenv("FARCASTER_FID", fid, 1)
                    self.setEnvVarKeys.append("FARCASTER_FID")
                }
                if let json = KeychainHelper.load(key: "skill_env_vars"),
                   let data = json.data(using: .utf8),
                   let map = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
                    // Reject keys that could affect dynamic linker, shell environment,
                    // or override critical runtime paths — only allow skill-specific vars.
                    let denylist: Set<String> = [
                        "PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "TERM",
                        "LANG", "LC_ALL", "LD_LIBRARY_PATH", "LD_PRELOAD",
                    ]
                    for (k, v) in map {
                        guard !denylist.contains(k),
                              !k.hasPrefix("DYLD_"),
                              !k.hasPrefix("LD_") else {
                            os_log(.error, "[NodeService] Rejected dangerous skill env var key: %{public}@", k)
                            continue
                        }
                        setenv(k, v, 1)
                        self.setEnvVarKeys.append(k)
                    }
                }
                // In hosted mode, config["nodeApiUrl"] carries the remote host URL;
                // in local mode fall back to the in-process node.
                let nodeUrl = (config["nodeApiUrl"] as? String)
                    ?? "http://127.0.0.1:\(self.nodeApiPort)"
                NSLog("[NodeService] startZeroclaw nodeUrl=%@ llmKey=%@", nodeUrl, llmKey != nil ? "yes" : "no")
                print("[NodeService] startZeroclaw nodeUrl=\(nodeUrl) llmKey=\(llmKey != nil ? "yes" : "no")")

                let dataDirPath = self.dataDir.path
                let rc = configPath.path.withCString { pathPtr in
                    nodeUrl.withCString { urlPtr in
                        withOptionalCString(llmKey) { keyPtr in
                            dataDirPath.withCString { dirPtr in
                                zeroclaw_start(pathPtr, urlPtr, keyPtr, dirPtr)
                            }
                        }
                    }
                }

                os_log(.info, "[NodeService] zeroclaw_start returned %d", rc)
                NSLog("[NodeService] zeroclaw_start returned %d", rc)
                print("[NodeService] zeroclaw_start returned \(rc)")
                if rc == 0 {
                    self.waitForGatewayReady { boundUrl in
                        if let boundUrl {
                            self.isAgentRunning = true
                            self.lastBrainError = nil
                            NSLog("[NodeService] gateway became healthy at %@", boundUrl)
                            print("[NodeService] gateway became healthy at \(boundUrl)")
                            NotificationCenter.default.post(name: .nodeStatusChanged,
                                                            object: ["status": "brain_started", "detail": boundUrl])
                        } else {
                            self.isAgentRunning = false
                            // Read last 800 chars of zeroclaw_ffi.log for diagnostics.
                            var logTail = ""
                            let logPath = self.dataDir.appendingPathComponent("zeroclaw_ffi.log")
                            if let data = try? Data(contentsOf: logPath),
                               let text = String(data: data, encoding: .utf8) {
                                let tail = String(text.suffix(800))
                                logTail = " | LOG: \(tail)"
                            }
                            let detail = "zeroclaw gateway did not bind on 9093 or 42617 after launch\(logTail)"
                            self.lastBrainError = detail
                            NSLog("[NodeService] %@", detail)
                            print("[NodeService] \(detail)")
                            NotificationCenter.default.post(name: .nodeStatusChanged,
                                                            object: ["status": "brain_error", "detail": detail])
                        }
                    }
                } else {
                    let detail = "zeroclaw_start returned \(rc) (llmKey=\(llmKey != nil ? "yes" : "no"), nodeUrl=\(nodeUrl))"
                    self.lastBrainError = detail
                    os_log(.error, "[NodeService] zeroclaw_start failed — %{public}@", detail)
                    NotificationCenter.default.post(name: .nodeStatusChanged,
                                                    object: ["status": "brain_error", "detail": detail])
                }
            } catch {
                let detail = "config write failed: \(error.localizedDescription)"
                self.lastBrainError = detail
                os_log(.error, "[NodeService] %{public}@", detail)
                NotificationCenter.default.post(name: .nodeStatusChanged,
                                                object: ["status": "brain_error", "detail": detail])
            }
        }
    }

    // MARK: - Hosted mode launch

    /// In hosted mode the local zerox1-node is not started.
    /// Only zeroclaw is launched; it connects to the remote host URL instead.
    func startHostedMode(hostUrl: String, config: [String: Any]) {
        guard !isRunning else { return }
        guard let url = URL(string: hostUrl),
              let scheme = url.scheme,
              ["https", "http"].contains(scheme.lowercased()),
              url.host != nil else {
            os_log(.error, "[NodeService] Rejected invalid hostUrl: %{public}@", hostUrl)
            return
        }
        // Persist the host URL in Keychain (not UserDefaults) to prevent backup extraction.
        KeychainHelper.save(hostUrl, key: "host_url")
        phoneBridgeToken = KeychainHelper.load(key: "phone_bridge_token") ?? generateToken()
        gatewayToken = KeychainHelper.load(key: "gateway_token") ?? generateToken()
        PhoneBridgeServer.shared.start(token: phoneBridgeToken)
        // Start zeroclaw with hosted mode config (skips zerox1_node_start entirely).
        var hostedConfig = config
        hostedConfig["nodeApiUrl"] = hostUrl
        startZeroclaw(config: hostedConfig)
    }

    // MARK: - Stop

    /// Track env var keys set during startZeroclaw so they can be cleaned up on stop.
    private var setEnvVarKeys: [String] = []

    func stop(completion: @escaping () -> Void = {}) {
        queue.async { [weak self] in
            guard let self else { completion(); return }
            // Release background keep-alive and HealthKit observers before stopping processes.
            KeepAliveService.shared.nodeDidStop()
            HealthWakeService.shared.unregister()
            // Always stop zeroclaw regardless of isAgentRunning — the Rust
            // IS_RUNNING flag stays true even if the gateway never bound, so
            // we must call zeroclaw_stop() to reset it before the next start.
            if self.isNodeRunning || self.isAgentRunning {
                zeroclaw_stop()
                self.isAgentRunning = false
            }
            if self.isNodeRunning {
                zerox1_node_stop()
                self.isNodeRunning = false
            }
            PhoneBridgeServer.shared.stop()

            // Clean up environment variables set during startZeroclaw so stale
            // keys don't persist if the user removes an API key and restarts.
            for key in self.setEnvVarKeys {
                unsetenv(key)
            }
            self.setEnvVarKeys.removeAll()

            DispatchQueue.main.async {
                UIApplication.shared.isIdleTimerDisabled = false
            }

            NotificationCenter.default.post(name: .nodeStatusChanged,
                                            object: ["status": "stopped", "detail": ""])
            completion()
        }
    }

    func reloadAgent() {
        guard isNodeRunning, let token = nodeApiToken else { return }
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(nodeApiPort)/agent/reload")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: req).resume()
    }

    /// Write the current task type so KeepAliveService can pick the matching ambient sound.
    /// Call from JS (NodeModule.setAgentTaskType) when a task is accepted.
    /// Values: "page_flip" | "keyboard" | "rain" | "ocean" | "" (clears / default)
    func setTaskType(_ type: String) {
        let path = dataDir.appendingPathComponent("zeroclaw.task_type")
        try? type.write(to: path, atomically: true, encoding: .utf8)
    }

    /// Mute or unmute the ambient working sound.
    /// Call from JS (NodeModule.setAudioMuted). Persisted across transitions by KeepAliveService.
    func setAudioMuted(_ muted: Bool) {
        KeepAliveService.shared.setMuted(muted)
    }
}

// MARK: - Aggregator sleep state

extension NodeService {

    /// Report sleep state to the aggregator so senders know whether to queue
    /// messages and fire APNs wake pushes.
    ///
    /// Called by the JS layer (via NodeModule) on every AppState transition:
    ///   background/inactive → setAggregatorSleepState(sleeping: true)
    ///   active              → setAggregatorSleepState(sleeping: false)
    ///
    /// Signing uses the Ed25519 identity key stored in the iOS Keychain.
    /// Fire-and-forget — completion always called regardless of outcome.
    func setAggregatorSleepState(sleeping: Bool, completion: @escaping () -> Void = {}) {
        guard let keyB58 = KeychainHelper.load(key: "identity_key"), !keyB58.isEmpty else {
            completion(); return
        }

        // Prefer the agent_id we already know. If not yet populated (first-launch
        // backgrounding before node has started), derive it from the identity key.
        var agentId = lastAgentId
        if agentId == nil || agentId!.isEmpty {
            if let keyBytes = base58Decode(keyB58), keyBytes.count >= 32 {
                let seed = Data(keyBytes.prefix(32))
                if let privateKey = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) {
                    let derived = privateKey.publicKey.rawRepresentation
                        .map { String(format: "%02x", $0) }.joined()
                    lastAgentId = derived   // persist for next time
                    agentId = derived
                }
            }
        }

        guard let agentId, !agentId.isEmpty else {
            completion(); return
        }

        let body: [String: Any] = ["agent_id": agentId, "sleeping": sleeping]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
            completion(); return
        }

        guard let sigHex = ed25519Sign(data: bodyData, base58Key: keyB58) else {
            completion(); return
        }

        var req = URLRequest(url: URL(string: "\(AGGREGATOR_URL)/fcm/sleep")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(sigHex, forHTTPHeaderField: "X-Signature")
        req.httpBody = bodyData
        req.timeoutInterval = 8

        URLSession.shared.dataTask(with: req) { _, _, _ in
            completion()
        }.resume()
    }

    /// Sign `data` with an Ed25519 key stored as base58 (seed || pubkey, 64 bytes).
    /// Returns the 64-byte signature as a lowercase hex string, or nil on error.
    private func ed25519Sign(data: Data, base58Key: String) -> String? {
        guard let keyBytes = base58Decode(base58Key), keyBytes.count >= 32 else { return nil }
        let seed = Data(keyBytes.prefix(32))
        guard let privateKey = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) else { return nil }
        guard let sig = try? privateKey.signature(for: data) else { return nil }
        return sig.map { String(format: "%02x", $0) }.joined()
    }

    /// Minimal base58 decoder (Bitcoin alphabet).
    private func base58Decode(_ s: String) -> [UInt8]? {
        let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
        var result = [UInt8]()
        for char in s {
            guard let digitIdx = alphabet.firstIndex(of: char) else { return nil }
            var carry = digitIdx
            for i in stride(from: result.count - 1, through: 0, by: -1) {
                carry += 58 * Int(result[i])
                result[i] = UInt8(carry & 0xff)
                carry >>= 8
            }
            while carry > 0 {
                result.insert(UInt8(carry & 0xff), at: 0)
                carry >>= 8
            }
        }
        let leadingZeros = s.prefix(while: { $0 == "1" }).count
        let stripped = result.drop(while: { $0 == 0 })
        return Array(repeating: UInt8(0), count: leadingZeros) + stripped
    }
}

// MARK: - Notification name

extension Notification.Name {
    static let nodeStatusChanged = Notification.Name("zerox1.nodeStatusChanged")
}

// MARK: - C string helper

/// Calls `body` with a non-nil `UnsafePointer<CChar>` when `s` is non-nil,
/// or with a nil pointer when `s` is nil. Matches nullable C parameters.
private func withOptionalCString<R>(_ s: String?, body: (UnsafePointer<CChar>?) -> R) -> R {
    if let s { return s.withCString { body($0) } }
    return body(nil)
}
