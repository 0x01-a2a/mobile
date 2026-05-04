# Podcast Production Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a bundled zeroclaw skill that lets the owner turn a voice conversation with their agent into a produced podcast episode — real audio for free tier, full ElevenLabs recreation for $01PL holders — with short-form clips for TikTok and publishing to Telegram + RSS.

**Architecture:** The skill is a set of TOML-defined tools backed by aggregator HTTP endpoints. The owner talks to the agent via the existing Chat screen (voice notes). When they say "make a podcast," the agent uses skill tools to: (1) export the conversation transcript + audio references, (2) call the aggregator's new `/podcast/*` endpoints which handle ElevenLabs API calls + audio mixing, (3) receive back URLs for the full episode and short clips, (4) publish to Telegram channel and RSS feed via aggregator. The $01PL gate is checked server-side by the aggregator (same pattern as `/llm/chat`).

**Tech Stack:** SKILL.toml (zeroclaw), aggregator Rust endpoints (ElevenLabs SDK), existing blob storage, existing Telegram channel infrastructure.

---

## File Structure

### Mobile app (this repo)

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `PODCAST_SKILL_TOML` constant in `NodeService.kt` | Android bundled skill definition |
| Modify | `NodeService.kt` `writeBundledSkills()` | Write podcast skill to workspace |
| Create | `podcastSkillToml` property in `NodeService.swift` | iOS bundled skill definition |
| Modify | `NodeService.swift` `writeBundledSkills()` | Write podcast skill to workspace |
| Modify | `useNodeApi.ts` `BUILTIN_LISTINGS` | Add podcast to marketplace listing |
| Modify | `useAgentBrain.ts` | No changes — skill is tool-only, no brain config needed |

### Aggregator (separate repo — endpoint contracts only in this plan)

The skill tools call aggregator endpoints. This plan defines the **contracts** (URL, method, request/response JSON) so the skill TOML can be written now and the aggregator can implement independently.

---

## Aggregator Endpoint Contracts

These endpoints live on `https://api.0x01.world` (the existing `AGGREGATOR_API`). All require `Authorization: Bearer <agent_api_token>` or the agent's identity signature.

### POST /podcast/produce

Produces a full podcast episode from a conversation transcript.

**Request:**
```json
{
  "agent_id": "hex64",
  "title": "Episode title (optional, agent generates if empty)",
  "transcript": [
    { "role": "user", "text": "...", "audio_cid": "hex-cid-or-null" },
    { "role": "assistant", "text": "..." }
  ],
  "voice_id": "elevenlabs-voice-id-or-null",
  "tier": "free|premium"
}
```

**Behavior by tier:**
- `free`: trims silence from user audio CIDs, generates 10s intro jingle via ElevenLabs Music, concatenates: jingle + real user audio + jingle outro. Agent text lines become caption-only (not voiced).
- `premium` ($01PL verified server-side): full two-voice production. User lines voiced with cloned voice (or original audio if CIDs present). Agent lines voiced with agent voice. Intro/outro music. Transitions between segments.

**Response:**
```json
{
  "episode_id": "uuid",
  "audio_url": "https://api.0x01.world/blobs/<cid>.mp3",
  "duration_secs": 342,
  "title": "Generated or provided title",
  "description": "Auto-generated show notes",
  "tier_used": "free|premium"
}
```

### POST /podcast/clip

Generates a short-form vertical video clip from an episode.

**Request:**
```json
{
  "episode_id": "uuid",
  "start_secs": 45,
  "end_secs": 105,
  "style": "waveform|avatar"
}
```

**Response:**
```json
{
  "clip_url": "https://api.0x01.world/blobs/<cid>.mp4",
  "duration_secs": 60,
  "caption_srt": "subtitle text in SRT format"
}
```

### POST /podcast/publish

Publishes an episode to the agent's RSS feed + Telegram channel.

**Request:**
```json
{
  "agent_id": "hex64",
  "episode_id": "uuid",
  "publish_rss": true,
  "publish_telegram": true
}
```

**Response:**
```json
{
  "rss_url": "https://api.0x01.world/podcast/<agent_id>/feed.xml",
  "telegram_message_id": 12345
}
```

### GET /podcast/episodes?agent_id=hex64

List published episodes for an agent.

**Response:**
```json
{
  "episodes": [
    {
      "episode_id": "uuid",
      "title": "...",
      "audio_url": "...",
      "duration_secs": 342,
      "published_at": 1714830000,
      "tier_used": "free"
    }
  ]
}
```

---

## Task 1: Write the SKILL.toml for Android

**Files:**
- Modify: `android/app/src/main/java/world/zerox1/pilot/NodeService.kt`

- [ ] **Step 1: Add the PODCAST_SKILL_TOML constant**

Add after the existing `PERSONA_OBSERVE_SKILL_TOML` constant in the companion object:

```kotlin
        val PODCAST_SKILL_TOML = """
[skill]
name        = "podcast"
version     = "1.0.0"
description = "Turn a conversation with your owner into a produced podcast episode. Free tier: real audio + AI jingle. Premium (01PL holders): full two-voice production with AI co-host. Generates short clips for TikTok and publishes to Telegram + RSS."
author      = "0x01 World"
tags        = ["podcast", "audio", "content", "social", "tiktok", "production"]

prompts = [${TOML_TQ}
# Podcast Producer

You can turn any conversation into a published podcast episode. When the owner says "make a podcast", "publish that", "turn this into an episode", or similar:

## Production Flow

1. Call `podcast_export_conversation` to get the current chat transcript with any voice note audio CIDs.
2. Review the transcript. Suggest a title and ask if the owner wants to change anything.
3. Once confirmed, call `podcast_produce` with the transcript, title, and the owner's preferred tier.
4. Show the owner the result: duration, title, and a preview link.
5. Ask if they want short clips for social media. If yes, identify the most interesting 60-second segment and call `podcast_clip`.
6. Ask if they want to publish. If yes, call `podcast_publish`.
7. If the owner wants the audio file locally, mention they can find it in the link provided.

## Guidelines

- Keep episode titles punchy and curiosity-driven — these appear in podcast apps and Telegram.
- For clips, pick segments with strong opinions, surprising facts, or emotional moments — not intros or pleasantries.
- The "premium" tier requires the owner to hold 500,000 01PL. If the aggregator returns a tier error, explain this and offer the free tier instead.
- Never fabricate transcript content. The podcast must reflect the actual conversation.
${TOML_TQ}]

[[tools]]
name        = "podcast_export_conversation"
description = "Export the current conversation transcript with voice note audio CIDs. Call this first to get the raw material for the podcast."
kind        = "shell"
command     = ${TOML_TQ}curl -sf "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/agent/conversation/export" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${TOML_TQ}

[[tools]]
name        = "podcast_produce"
description = "Send a conversation transcript to the aggregator to produce a full podcast episode. Returns an audio URL and episode metadata. Tier: 'free' for real-audio-only production, 'premium' for full ElevenLabs two-voice recreation."
kind        = "shell"
command     = ${TOML_TQ}jq -nc --arg title {title} --arg tier {tier} --argjson transcript {transcript_json} '{"title":${'$'}title,"tier":${'$'}tier,"transcript":${'$'}transcript}' | curl -sf -X POST "https://api.0x01.world/podcast/produce" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${TOML_TQ}

[tools.args]
title           = "Episode title — short and punchy"
tier            = "free or premium"
transcript_json = "JSON array of {role, text, audio_cid} objects from podcast_export_conversation"

[[tools]]
name        = "podcast_clip"
description = "Generate a 60-second vertical video clip from a produced episode for TikTok/Reels. Includes burned-in captions."
kind        = "shell"
command     = ${TOML_TQ}jq -nc --arg eid {episode_id} --argjson start {start_secs} --argjson end {end_secs} '{"episode_id":${'$'}eid,"start_secs":${'$'}start,"end_secs":${'$'}end,"style":"waveform"}' | curl -sf -X POST "https://api.0x01.world/podcast/clip" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${TOML_TQ}

[tools.args]
episode_id = "Episode ID returned by podcast_produce"
start_secs = "Start time in seconds for the clip"
end_secs   = "End time in seconds for the clip (max 90s duration)"

[[tools]]
name        = "podcast_publish"
description = "Publish a produced episode to the agent's RSS podcast feed and Telegram channel."
kind        = "shell"
command     = ${TOML_TQ}jq -nc --arg eid {episode_id} --argjson rss {publish_rss} --argjson tg {publish_telegram} '{"episode_id":${'$'}eid,"publish_rss":${'$'}rss,"publish_telegram":${'$'}tg}' | curl -sf -X POST "https://api.0x01.world/podcast/publish" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${TOML_TQ}

[tools.args]
episode_id        = "Episode ID returned by podcast_produce"
publish_rss       = "true to publish to RSS feed (Spotify/Apple Podcasts)"
publish_telegram  = "true to post to agent Telegram channel"

[[tools]]
name        = "podcast_list_episodes"
description = "List all published podcast episodes for this agent."
kind        = "shell"
command     = ${TOML_TQ}curl -sf "https://api.0x01.world/podcast/episodes?agent_id=${'$'}{ZX01_AGENT_ID:-}" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${TOML_TQ}
""".trimIndent()
```

- [ ] **Step 2: Verify the constant compiles**

Run: `cd android && ./gradlew compileDebugKotlin 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/world/zerox1/pilot/NodeService.kt
git commit -m "feat: add podcast production SKILL.toml constant (Android)"
```

---

## Task 2: Wire podcast skill into Android writeBundledSkills

**Files:**
- Modify: `android/app/src/main/java/world/zerox1/pilot/NodeService.kt` — `writeBundledSkills()` around line 2738

- [ ] **Step 1: Add podcast skill write**

Add after the last skill write in `writeBundledSkills()`:

```kotlin
        // ── Podcast production skill ────────────────────────────────────────
        val podcastSkillDir = File(skillsRoot, "podcast")
        podcastSkillDir.mkdirs()
        File(podcastSkillDir, "SKILL.toml").writeText(PODCAST_SKILL_TOML)
```

- [ ] **Step 2: Verify build**

Run: `cd android && ./gradlew compileDebugKotlin 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/world/zerox1/pilot/NodeService.kt
git commit -m "feat: bundle podcast skill in Android writeBundledSkills"
```

---

## Task 3: Write the SKILL.toml for iOS

**Files:**
- Modify: `ios/Zerox1/NodeService.swift` — add `podcastSkillToml` property and update `writeBundledSkills()`

- [ ] **Step 1: Add the podcastSkillToml computed property**

Add after the existing `moltbookSkillToml` property in NodeService.swift:

```swift
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

## Production Flow

1. Call `podcast_export_conversation` to get the current chat transcript with any voice note audio CIDs.
2. Review the transcript. Suggest a title and ask if the owner wants to change anything.
3. Once confirmed, call `podcast_produce` with the transcript, title, and the owner's preferred tier.
4. Show the owner the result: duration, title, and a preview link.
5. Ask if they want short clips for social media. If yes, identify the most interesting 60-second segment and call `podcast_clip`.
6. Ask if they want to publish. If yes, call `podcast_publish`.
7. If the owner wants the audio file locally, mention they can find it in the link provided.

## Guidelines

- Keep episode titles punchy and curiosity-driven — these appear in podcast apps and Telegram.
- For clips, pick segments with strong opinions, surprising facts, or emotional moments — not intros or pleasantries.
- The "premium" tier requires the owner to hold 500,000 01PL. If the aggregator returns a tier error, explain this and offer the free tier instead.
- Never fabricate transcript content. The podcast must reflect the actual conversation.
\(tq)]

[[tools]]
name        = "podcast_export_conversation"
description = "Export the current conversation transcript with voice note audio CIDs. Call this first to get the raw material for the podcast."
kind        = "shell"
command     = \(tq)curl -sf "http://127.0.0.1:9090/agent/conversation/export" -H "Authorization: Bearer ${ZX01_TOKEN:-}" \(tq)

[[tools]]
name        = "podcast_produce"
description = "Send a conversation transcript to the aggregator to produce a full podcast episode. Returns an audio URL and episode metadata. Tier: 'free' for real-audio-only production, 'premium' for full ElevenLabs two-voice recreation."
kind        = "shell"
command     = \(tq)jq -nc --arg title {title} --arg tier {tier} --argjson transcript {transcript_json} '{"title":$title,"tier":$tier,"transcript":$transcript}' | curl -sf -X POST "https://api.0x01.world/podcast/produce" -H "Content-Type: application/json" -H "Authorization: Bearer ${ZX01_TOKEN:-}" -d @-\(tq)

[tools.args]
title           = "Episode title — short and punchy"
tier            = "free or premium"
transcript_json = "JSON array of {role, text, audio_cid} objects from podcast_export_conversation"

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
```

- [ ] **Step 2: Update writeBundledSkills to write the podcast skill**

In `writeBundledSkills()`, add after the moltbook skill write:

```swift
        let podcastDir = skillsRoot.appendingPathComponent("podcast", isDirectory: true)
        try FileManager.default.createDirectory(at: podcastDir, withIntermediateDirectories: true)
        try podcastSkillToml.write(to: podcastDir.appendingPathComponent("SKILL.toml"),
                                    atomically: true, encoding: .utf8)
```

- [ ] **Step 3: Verify Xcode build**

Run: `cd ios && xcodebuild -scheme Zerox1 -configuration Debug -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -5`
Expected: BUILD SUCCEEDED (or verify manually in Xcode)

- [ ] **Step 4: Commit**

```bash
git add ios/Zerox1/NodeService.swift
git commit -m "feat: add podcast production skill (iOS)"
```

---

## Task 4: Add podcast to marketplace listing

**Files:**
- Modify: `src/hooks/useNodeApi.ts` — `BUILTIN_LISTINGS` array

- [ ] **Step 1: Add podcast listing entry**

Add to the `BUILTIN_LISTINGS` array after the `elevenlabs` entry:

```typescript
  { name: 'podcast', label: 'Podcast Producer', description: 'Turn a voice conversation with your agent into a produced podcast episode. Free: real audio + AI jingle. Premium: full two-voice production. Clips for TikTok, publish to Telegram + RSS.', icon: 'POD', tags: ['podcast', 'audio', 'content', 'social'], version: '1.0.0', requires_node: true, pre_installed: true, url: 'https://skills.0x01.world/podcast/SKILL.toml' },
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no output (clean)

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useNodeApi.ts
git commit -m "feat: add podcast skill to marketplace listing"
```

---

## Task 5: Add podcast to locales

**Files:**
- Modify: `src/locales/en.json`
- Modify: `src/locales/zh-CN.json`

- [ ] **Step 1: Add English locale keys**

Add to the `"chat"` section of `en.json`:

```json
    "podcastHint": "Say \"make a podcast\" to turn this conversation into an episode.",
    "podcastProducing": "Producing your episode...",
    "podcastReady": "Episode ready!"
```

- [ ] **Step 2: Add Chinese locale keys**

Add matching keys to the `"chat"` section of `zh-CN.json`:

```json
    "podcastHint": "说"制作播客"将这段对话变成一期节目。",
    "podcastProducing": "正在制作您的节目...",
    "podcastReady": "节目已就绪！"
```

- [ ] **Step 3: Verify JSON validity**

Run: `node -e "require('./src/locales/en.json'); require('./src/locales/zh-CN.json'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add src/locales/en.json src/locales/zh-CN.json
git commit -m "feat: add podcast locale keys (en + zh-CN)"
```

---

## Notes for Aggregator Implementation (separate repo)

The following aggregator work is required before the skill is functional end-to-end. This is documented here as a contract, not implemented in this plan:

1. **`POST /podcast/produce`** — accepts transcript JSON, calls ElevenLabs Music API for jingle (free tier) or ElevenLabs TTS + Music + voice clone (premium tier), mixes audio with FFmpeg, stores result in blob storage, returns URL. Gate premium tier on $01PL balance (same check as `/llm/chat`).

2. **`POST /podcast/clip`** — extracts audio segment, generates SRT captions from transcript timestamps, burns captions onto waveform video using FFmpeg, stores in blob storage.

3. **`POST /podcast/publish`** — appends episode to agent's RSS feed XML (stored in blob storage), posts MP3 + show notes to agent's Telegram channel via Telegram Bot API.

4. **`GET /podcast/episodes`** — reads episode index from blob storage.

5. **`GET /agent/conversation/export`** (node API, not aggregator) — exports the current zeroclaw session as a JSON transcript with audio CIDs. This may require a small addition to the zeroclaw gateway API.

ElevenLabs API calls used:
- `client.music.compose()` — jingle generation (~$0.05 per 10s clip)
- `client.text_to_speech.convert()` — agent voice narration (premium only, ~$0.18/1000 chars)
- `client.text_to_speech.convert()` with cloned voice — owner recreation (premium only)
