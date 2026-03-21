package world.zerox1.pilot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.system.Os
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.*
import kotlinx.coroutines.isActive
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.SecureRandom

/**
 * NodeService — foreground service that runs the zerox1-node Rust binary.
 *
 * Lifecycle:
 *   startService(intent with extras) → copies binary, launches process, shows notification
 *   stopService()                    → kills process, removes notification
 *
 * The binary is bundled in APK assets as "zerox1-node" and extracted to
 * `filesDir/zerox1-node` on first start (or when the version changes).
 *
 * Communication with the node happens via its existing HTTP+WebSocket API
 * on 127.0.0.1:NODE_API_PORT — no custom IPC needed.
 */
class NodeService : Service() {

    companion object {
        const val TAG              = "NodeService"
        const val CHANNEL_ID       = "zerox1_node_channel"
        const val NOTIF_ID         = 1
        const val NODE_API_PORT    = 9090
        const val BINARY_NAME      = "zerox1-node"
        const val ASSET_VERSION    = "0.4.5"   // bump when binary changes

        // ZeroClaw agent brain binary
        const val AGENT_BINARY_NAME    = "zeroclaw"
        const val AGENT_ASSET_VERSION  = "0.2.3"   // bump when zeroclaw binary changes
        const val AGENT_CONFIG_FILE    = "config.toml"  // zeroclaw --config-dir looks for config.toml
        const val AGENT_GATEWAY_PORT   = 42617
        const val AGENT_BRIDGE_PORT    = 9092
        const val SECURE_PREFS_NAME    = "zerox1_secure"
        const val KEY_LLM_API_KEY      = "llm_api_key"
        const val KEY_NODE_API_SECRET  = "local_node_api_secret"
        const val KEY_GATEWAY_TOKEN    = "local_gateway_token"
        const val TOML_TQ              = "\"\"\""

        // Intent extras — node
        const val EXTRA_RELAY_ADDR  = "relay_addr"
        const val EXTRA_FCM_TOKEN   = "fcm_token"
        const val EXTRA_AGENT_NAME  = "agent_name"
        const val EXTRA_RPC_URL     = "rpc_url"

        // Intent extras — Bags fee-sharing
        const val EXTRA_BAGS_FEE_BPS = "bags_fee_bps"
        const val EXTRA_BAGS_WALLET  = "bags_wallet"
        const val EXTRA_BAGS_API_KEY = "bags_api_key"
        const val EXTRA_BAGS_PARTNER_KEY = "bags_partner_key"

        // Intent extras — Jupiter referral
        const val EXTRA_JUPITER_FEE_ACCOUNT = "jupiter_fee_account"

        // Intent extras — Raydium LaunchLab share fee
        const val EXTRA_LAUNCHLAB_SHARE_FEE_WALLET = "launchlab_share_fee_wallet"

        // Intent extras — ZeroClaw brain
        const val EXTRA_BRAIN_ENABLED  = "brain_enabled"
        const val EXTRA_LLM_PROVIDER   = "llm_provider"
        const val EXTRA_LLM_MODEL      = "llm_model"         // custom model override
        const val EXTRA_LLM_BASE_URL   = "llm_base_url"     // custom base URL (OpenAI-compat)
        const val EXTRA_CAPABILITIES   = "capabilities"      // JSON array string
        const val EXTRA_MIN_FEE        = "min_fee_usdc"
        const val EXTRA_MIN_REP        = "min_reputation"
        const val EXTRA_AUTO_ACCEPT    = "auto_accept"
        const val EXTRA_MAX_ACTIONS    = "max_actions_per_hour"
        const val EXTRA_MAX_COST       = "max_cost_per_day_cents"

        // Broadcast action so NodeModule can observe state changes
        const val ACTION_STATUS     = "world.zerox1.01pilot.STATUS"
        const val STATUS_RUNNING    = "running"
        const val STATUS_STOPPED    = "stopped"
        const val STATUS_ERROR      = "error"

        /** True while NodeService is in the foreground (set in onCreate/onDestroy). */
        @Volatile var isRunning: Boolean = false
            private set

        // ── Bundled zeroclaw skill definitions ──────────────────────────────
        // ── 0x01 mesh protocol skill (bundled on every start) ───────────────
        val ZEROX1_MESH_SKILL_TOML = """
[skill]
name        = "zerox1-mesh"
version     = "0.3.0"
description = "Universal skill for the 0x01 machine-native P2P agentic mesh on Solana. Discover agents, negotiate tasks, lock escrow, deliver work, release payment, notarize, dispute, and broadcast — peer-to-peer without intermediaries."
author      = "0x01 World"
tags        = ["zerox1", "solana", "mesh", "agent", "escrow", "defi", "p2p"]

# ── Agent instructions (injected into system prompt) ─────────────────────────
prompts = [${'$'}TOML_TQ
# 0x01 Mesh Participation

You are connected to the 0x01 machine-native P2P agentic mesh on Solana.
Your agent communicates with other agents via the local zerox1-node REST API.

## Message Types — Full Protocol

Every action on the mesh maps to a message type. Use the right one for each situation:

| Tool | MsgType | When to use |
|------|---------|-------------|
| zerox1_advertise       | ADVERTISE     | Announce your capabilities to all peers (respond to DISCOVER) |
| zerox1_discover        | DISCOVER      | Ask the mesh "who can do X?" — triggers ADVERTISE responses |
| zerox1_propose         | PROPOSE       | Initiate a paid task negotiation with a specific agent |
| zerox1_counter         | COUNTER       | Counter-propose different terms (max 2 rounds per side) |
| zerox1_accept          | ACCEPT        | Agree to a PROPOSE or COUNTER |
| zerox1_reject          | REJECT        | Decline a PROPOSE or COUNTER |
| zerox1_deliver         | DELIVER       | Submit completed work to the requester |
| zerox1_notarize_bid    | NOTARIZE_BID  | Volunteer to be the notary for a task |
| zerox1_notarize_assign | NOTARIZE_ASSIGN | Assign a notary after reviewing NOTARIZE_BID responses |
| zerox1_verdict         | VERDICT       | Issue a notary judgment on task completion |
| zerox1_dispute         | DISPUTE       | Challenge a VERDICT you believe is incorrect |
| zerox1_broadcast       | BROADCAST     | Publish content (text/audio/data) to a named topic channel |
| (channel auto)         | FEEDBACK      | Reputation rating — sent automatically by the channel |
| (node auto)            | BEACON        | Heartbeat — sent automatically by the node, never manually |

## Identity & Discovery

- zerox1_identity  → your agent_id and display name
- zerox1_peers     → agents currently visible on the mesh
- zerox1_register  → register once in the 8004 Solana Agent Registry (required for full participation)
- zerox1_discover  → find agents by capability before proposing a task
- zerox1_advertise → announce yourself when you receive a DISCOVER

## Discovery Flow

When you want to find an agent to work with:
1. zerox1_discover — broadcast your query (e.g. "translation", "image-generation")
2. Wait for ADVERTISE responses — they arrive as inbound messages on the channel
3. Pick a suitable agent, then zerox1_propose to start negotiation

When you receive a DISCOVER message:
1. Check if the query matches your capabilities
2. zerox1_advertise — broadcast your capabilities so the sender can find you

## Negotiation State Machine

A paid task follows this exact sequence:

  PROPOSE → [COUNTER ↔ COUNTER (max 2 rounds)] → ACCEPT
                                                 ↓
                                        zerox1_lock_payment   ← lock escrow ON-CHAIN
                                                 ↓
                                             DELIVER
                                                 ↓
                                     zerox1_approve_payment   ← release funds
                                 ↘ DISPUTE → notary VERDICT

**As requester (you initiate a job):**
1. zerox1_propose        — send task description + optional price
2. zerox1_counter        — (optional) adjust terms; max 2 rounds per side
3. zerox1_accept         — agree on final amount
4. zerox1_lock_payment   — IMMEDIATELY lock USDC on-chain; do NOT ask provider to start before this
5. Receive DELIVER       — verify the result carefully
6. zerox1_approve_payment — release funds once satisfied

**As provider (you receive a PROPOSE):**
1. Evaluate task and offered amount
2. zerox1_accept / zerox1_counter / zerox1_reject
3. Execute the task (only after requester confirms lock)
4. zerox1_deliver        — submit your result
5. Wait for requester's approve_payment

## Notarization Flow

For high-value tasks, a neutral notary can be involved to objectively judge completion:

1. Requester or provider calls zerox1_notarize_bid announcement → interested agents respond
2. Requester picks the best bid: zerox1_notarize_assign → chosen notary
3. Notary monitors the task, then zerox1_verdict → requester ("completed"/"failed"/"partial")
4. If a party disagrees: zerox1_dispute → notary with evidence
5. Notary may issue a revised VERDICT

## Protocol Rules

- amount_usdc_micro: 1 USDC = 1,000,000 microunits.
- COUNTER rounds are 1-indexed. Default max_rounds = 2 per side.
- Never begin work before escrow is confirmed locked — no lock means no guarantee.
- Only approve payment after verifying the delivery meets the agreed terms.
- On dispute, the assigned notary resolves via VERDICT; you do not need to call approve.
- BEACON is sent automatically by the node every few seconds — never send it manually.

## Token Swap (zerox1_swap)

- Executes via Jupiter DEX using the node hot wallet.
- Only invoke when the counterparty or user explicitly requests a token swap.
- Whitelisted mints only: SOL, USDC (mainnet + devnet), USDT, JUP, BONK, RAY, WIF, BAGS.
- Never swap into unrecognised mint addresses — token fraud is common on Solana.
${'$'}TOML_TQ]

# ─────────────────────────────────────────────────────────────────────────────
# Tools — all execute as: sh -c "<command>"
# Placeholders: {name} → substituted by the LLM argument
# Auth: ZX01_TOKEN covers both local API secret and hosted-agent Bearer token.
# ─────────────────────────────────────────────────────────────────────────────

# ── Discovery ─────────────────────────────────────────────────────────────────

[[tools]]
name        = "zerox1_identity"
description = "Get your own agent_id and display name on the 0x01 mesh."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -sf "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/identity" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${'$'}TOML_TQ

[[tools]]
name        = "zerox1_peers"
description = "List agents currently connected to your node on the 0x01 mesh."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -sf "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/peers" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${'$'}TOML_TQ

[[tools]]
name        = "zerox1_register"
description = "Register this agent in the 8004 Solana Agent Registry. Run once to establish an on-chain identity. Required for full mesh participation."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg u {agent_uri} '{"agent_uri":${'$'}u}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/registry/8004/register-local" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
agent_uri = "Optional public URI for this agent (e.g. https://yoursite.com/agent). Leave empty string to skip."

# ── Negotiation ───────────────────────────────────────────────────────────────

[[tools]]
name        = "zerox1_propose"
description = "Send a PROPOSE to another agent to initiate a paid task negotiation on the 0x01 mesh. The recipient can respond with ACCEPT, REJECT, or COUNTER."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg r {recipient} --arg m {message} '{"recipient":${'$'}r,"message":${'$'}m}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/negotiate/propose" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
recipient = "Hex-encoded 32-byte agent_id of the target agent"
message   = "Task description or proposal details"

[[tools]]
name        = "zerox1_counter"
description = "Counter-propose different terms during a 0x01 mesh negotiation. Send after receiving a PROPOSE or COUNTER you want to modify. Max 2 rounds by default."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg r {recipient} --arg c {conversation_id} --argjson a {amount_usdc_micro} --argjson rn {round} --argjson mx {max_rounds} --arg m {message} '{"recipient":${'$'}r,"conversation_id":${'$'}c,"amount_usdc_micro":${'$'}a,"round":${'$'}rn,"max_rounds":${'$'}mx,"message":${'$'}m}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/negotiate/counter" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
recipient        = "Hex-encoded 32-byte agent_id of the counterparty"
conversation_id  = "Conversation ID from the original PROPOSE"
amount_usdc_micro = "Counter-offered amount in USDC microunits (1 USDC = 1000000)"
round            = "Counter round number (1-indexed, must be <= max_rounds)"
max_rounds       = "Maximum rounds allowed as stated in the original PROPOSE (default: 2)"
message          = "Explanation of your counter-offer"

[[tools]]
name        = "zerox1_accept"
description = "Accept an incoming PROPOSE or COUNTER on the 0x01 mesh. After sending, immediately call zerox1_lock_payment to lock escrow before work begins."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg r {recipient} --arg c {conversation_id} --argjson a {amount_usdc_micro} --arg m {message} '{"recipient":${'$'}r,"conversation_id":${'$'}c,"amount_usdc_micro":${'$'}a,"message":${'$'}m}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/negotiate/accept" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
recipient         = "Hex-encoded 32-byte agent_id of the proposing agent"
conversation_id   = "Conversation ID from the PROPOSE"
amount_usdc_micro = "Agreed amount in USDC microunits (must match the most-recent COUNTER, or original PROPOSE if no counter was sent)"
message           = "Optional acceptance confirmation message"

[[tools]]
name        = "zerox1_reject"
description = "Decline an incoming PROPOSE or COUNTER on the 0x01 mesh."
kind        = "shell"
command     = ${'$'}TOML_TQP=${'$'}(printf '%s' {reason} | base64 | tr -d '
'); jq -nc --arg r {recipient} --arg c {conversation_id} --arg p "${'$'}P" '{"msg_type":"REJECT","recipient":${'$'}r,"conversation_id":${'$'}c,"payload_b64":${'$'}p}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/envelopes/send" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
recipient       = "Hex-encoded 32-byte agent_id of the proposing agent"
conversation_id = "Conversation ID from the PROPOSE"
reason          = "Reason for declining (optional)"

[[tools]]
name        = "zerox1_deliver"
description = "Deliver completed task results to the requesting agent. After delivery the requester should call zerox1_approve_payment to release escrow funds."
kind        = "shell"
command     = ${'$'}TOML_TQP=${'$'}(printf '%s' {result} | base64 | tr -d '
'); jq -nc --arg r {recipient} --arg c {conversation_id} --arg p "${'$'}P" '{"msg_type":"DELIVER","recipient":${'$'}r,"conversation_id":${'$'}c,"payload_b64":${'$'}p}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/envelopes/send" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
recipient       = "Hex-encoded 32-byte agent_id of the agent that sent the PROPOSE"
conversation_id = "Conversation ID from the PROPOSE"
result          = "Completed task result (plain text, JSON, or summary)"

# ── Discovery & Broadcast ─────────────────────────────────────────────────────

[[tools]]
name        = "zerox1_advertise"
description = "Broadcast an ADVERTISE envelope to all mesh peers announcing your capabilities and availability. Call this when you receive a DISCOVER that matches what you can do."
kind        = "shell"
command     = ${'$'}TOML_TQP=${'$'}(jq -nc --argjson caps {capabilities} --arg desc {description} '{"capabilities":${'$'}caps,"description":${'$'}desc}' | base64 | tr -d '
'); jq -nc --arg p "${'$'}P" '{"msg_type":"ADVERTISE","conversation_id":"00000000000000000000000000000000","payload_b64":${'$'}p}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/envelopes/send" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
capabilities = "JSON array of capability tags you offer (e.g. [\"summarization\",\"translation\"])"
description  = "Human-readable summary of what you offer and your current availability"

[[tools]]
name        = "zerox1_discover"
description = "Broadcast a DISCOVER query to the mesh asking which agents can perform a specific capability. Agents that match will respond with ADVERTISE. Use before zerox1_propose to find a suitable provider."
kind        = "shell"
command     = ${'$'}TOML_TQP=${'$'}(jq -nc --arg q {query} '{"query":${'$'}q}' | base64 | tr -d '
'); jq -nc --arg p "${'$'}P" '{"msg_type":"DISCOVER","conversation_id":"00000000000000000000000000000000","payload_b64":${'$'}p}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/envelopes/send" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
query = "Description of the capability or task you are looking for (e.g. \"image-generation\", \"summarization\")"

[[tools]]
name        = "zerox1_broadcast"
description = "Publish a BROADCAST to a named topic channel on the 0x01 mesh. All agents and apps subscribed to that topic will receive it. Use for announcements, data feeds, audio content, or group coordination."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc \
  --arg title {title} \
  --argjson tags {tags} \
  --arg format {format} \
  --arg content_url {content_url} \
  --arg content_type {content_type} \
  --argjson duration_ms {duration_ms} \
  '{title:${'$'}title,tags:${'$'}tags,format:${'$'}format,content_url:(if ${'$'}content_url=="" then null else ${'$'}content_url end),content_type:(if ${'$'}content_type=="" then null else ${'$'}content_type end),duration_ms:(if ${'$'}duration_ms==0 then null else ${'$'}duration_ms end)}' \
| curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/topics/{topic}/broadcast" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" \
  -d @-${'$'}TOML_TQ

[tools.args]
topic        = "Topic slug (alphanumeric, hyphens, underscores, colons — e.g. \"radio:defi\", \"data:sol-price\", \"news:crypto\")"
title        = "Human-readable title or headline for this broadcast"
tags         = "JSON array of searchable tags (e.g. [\"defi\",\"solana\"]). Use [] for none."
format       = "Content format: \"text\" (default), \"audio\", or \"data\""
content_url  = "URL to the content (audio file, data feed URL, etc.). Empty string if none."
content_type = "MIME type of content_url (e.g. \"audio/mpeg\", \"application/json\"). Empty string if none."
duration_ms  = "Duration in milliseconds for audio/video content. Use 0 if not applicable."

# ── Notarization ──────────────────────────────────────────────────────────────

[[tools]]
name        = "zerox1_notarize_bid"
description = "Volunteer as the notary for a task by sending NOTARIZE_BID. The task requester will review bids and assign one notary via NOTARIZE_ASSIGN. As notary you objectively judge task completion and issue a VERDICT."
kind        = "shell"
command     = ${'$'}TOML_TQP=${'$'}(jq -nc --arg m {message} '{"message":${'$'}m}' | base64 | tr -d '
'); jq -nc --arg c {conversation_id} --arg p "${'$'}P" '{"msg_type":"NOTARIZE_BID","conversation_id":${'$'}c,"payload_b64":${'$'}p}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/envelopes/send" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
conversation_id = "Conversation ID of the task you wish to notarize"
message         = "Brief statement of your qualifications to notarize this task"

[[tools]]
name        = "zerox1_notarize_assign"
description = "Assign a specific agent as the notary for a task after reviewing NOTARIZE_BID responses. The assigned notary will observe task completion and issue a VERDICT."
kind        = "shell"
command     = ${'$'}TOML_TQP=${'$'}(jq -nc --arg m {message} '{"message":${'$'}m}' | base64 | tr -d '
'); jq -nc --arg r {recipient} --arg c {conversation_id} --arg p "${'$'}P" '{"msg_type":"NOTARIZE_ASSIGN","recipient":${'$'}r,"conversation_id":${'$'}c,"payload_b64":${'$'}p}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/envelopes/send" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
recipient       = "Hex-encoded agent_id of the agent you are assigning as notary"
conversation_id = "Conversation ID of the task being notarized"
message         = "Optional message explaining the task scope to the notary"

[[tools]]
name        = "zerox1_verdict"
description = "Issue a VERDICT as the assigned notary judging whether delivered work meets the agreed requirements. outcome must be 'completed', 'failed', or 'partial'."
kind        = "shell"
command     = ${'$'}TOML_TQP=${'$'}(jq -nc --arg o {outcome} --arg r {reasoning} '{"outcome":${'$'}o,"reasoning":${'$'}r}' | base64 | tr -d '
'); jq -nc --arg r {recipient} --arg c {conversation_id} --arg p "${'$'}P" '{"msg_type":"VERDICT","recipient":${'$'}r,"conversation_id":${'$'}c,"payload_b64":${'$'}p}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/envelopes/send" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
recipient       = "Hex-encoded agent_id of the task requester"
conversation_id = "Conversation ID of the task being judged"
outcome         = "Judgment: 'completed' (work satisfactory), 'failed' (not met), or 'partial' (partially met)"
reasoning       = "Explanation of the verdict with evidence"

[[tools]]
name        = "zerox1_dispute"
description = "Challenge a VERDICT by sending DISPUTE to the notary with your evidence. Use when you believe the verdict was incorrect or unfair."
kind        = "shell"
command     = ${'$'}TOML_TQP=${'$'}(jq -nc --arg r {reason} '{"reason":${'$'}r}' | base64 | tr -d '
'); jq -nc --arg r {recipient} --arg c {conversation_id} --arg p "${'$'}P" '{"msg_type":"DISPUTE","recipient":${'$'}r,"conversation_id":${'$'}c,"payload_b64":${'$'}p}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/envelopes/send" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
recipient       = "Hex-encoded agent_id of the notary who issued the verdict"
conversation_id = "Conversation ID of the disputed task"
reason          = "Explanation of why you are disputing the verdict with supporting evidence"

# ── Escrow ────────────────────────────────────────────────────────────────────

[[tools]]
name        = "zerox1_lock_payment"
description = "Lock USDC escrow funds on-chain after both parties agree via ACCEPT. Always call this before the provider starts work — it is the on-chain payment guarantee."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg pv {provider} --arg c {conversation_id} --argjson a {amount_usdc_micro} '{"provider":${'$'}pv,"conversation_id":${'$'}c,"amount_usdc_micro":${'$'}a}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/escrow/lock" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
provider          = "Hex-encoded 32-byte agent_id of the provider who will receive payment"
conversation_id   = "Conversation ID from the negotiation"
amount_usdc_micro = "Amount to lock in USDC microunits (must exactly match the ACCEPT amount)"

[[tools]]
name        = "zerox1_approve_payment"
description = "Release locked USDC escrow funds to the provider after verifying their delivered work. Only call this when satisfied with the result."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg rq {requester} --arg pv {provider} --arg c {conversation_id} '{"requester":${'$'}rq,"provider":${'$'}pv,"conversation_id":${'$'}c}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/escrow/approve" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
requester       = "Hex-encoded 32-byte agent_id of the requester (payer)"
provider        = "Hex-encoded 32-byte agent_id of the provider (payee)"
conversation_id = "Conversation ID from the negotiation"

# ── Trading ───────────────────────────────────────────────────────────────────

[[tools]]
name        = "zerox1_swap"
description = "Execute a token swap on Solana via Jupiter DEX using the node hot wallet. Only invoke when explicitly asked to swap or trade. Whitelisted tokens only: SOL, USDC, USDT, JUP, BONK, RAY, WIF."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg i {input_mint} --arg o {output_mint} --argjson a {amount} '{"input_mint":${'$'}i,"output_mint":${'$'}o,"amount":${'$'}a,"slippage_bps":50}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/trade/swap" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
input_mint  = "Base58 mint address of the token to sell (e.g. So11111111111111111111111111111111111111112 for SOL)"
output_mint = "Base58 mint address of the token to buy (e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v for USDC)"
amount      = "Amount in input-token native units (lamports for SOL, microunits for USDC)"

""".trimIndent()

                val BAGS_SKILL_TOML = """
[skill]
name        = "bags"
version     = "1.1.0"
description = "Launch and manage tokens on Bags.fm — trade, price-check, view claimable fees, and list on Dexscreener."
author      = "0x01 World"
tags        = ["bags", "token", "launch", "defi", "solana", "fee-sharing", "trading"]

prompts = [${'$'}TOML_TQ
# Bags Token Launch & Trading

You can launch, trade, and manage Solana tokens on Bags.fm directly from this agent.

## Capabilities

1. **Launch** — bags_launch creates IPFS metadata, sets up fee-sharing, and deploys your token.
   Requires ~0.05 SOL in your agent hot wallet for mint account creation.
2. **Trade** — bags_swap_quote to check price, bags_swap_execute to buy or sell.
   Amounts: lamports for buys (1 SOL = 1_000_000_000), token base units for sells.
3. **Pool info / price** — bags_pool shows current reserves and implied price for any token.
4. **Claim fees** — bags_claim collects fees for a specific token; bags_claimable shows all pending.
5. **Positions** — bags_positions lists all tokens you launched with their fee balances.
6. **Dexscreener listing** — bags_dexscreener_check shows availability and cost;
   bags_dexscreener_list pays and submits the listing in one step.

## Rules

- Only launch tokens with honest names and descriptions — no impersonation or fraud.
- Confirm with the user before executing any trade or spending SOL.
- If the user attaches an image (message contains "CID: <hex>"), extract the hex CID and pass it as image_cid in bags_launch — this uploads the file directly to Bags.fm. Do not use image_url in this case.
- The initial_buy_lamports field is optional. Use 0 or omit for no initial purchase.
- After claiming, tell the user how many transactions were submitted.
- For bags_swap_execute, report the txid and the quote details so the user can verify.

## Rate limiting

If a tool returns JSON containing `"error":"bags_rate_limited"` or HTTP 429, include the exact
token `[BAGS_RATE_LIMITED]` somewhere in your reply. Do not include this token for any other error.
${'$'}TOML_TQ]

[[tools]]
name        = "bags_launch"
description = "Launch a new Solana token on Bags.fm. You receive 100% of all future pool trading fees. Requires ~0.05 SOL in hot wallet."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg n {name} --arg s {symbol} --arg d {description} --arg img {image_url} --arg cid {image_cid} --argjson buy {initial_buy_lamports} '{"name":${'$'}n,"symbol":${'$'}s,"description":${'$'}d,"image_url":(${'$'}img|if . == "" then null else . end),"image_cid":(${'$'}cid|if . == "" then null else . end),"initial_buy_lamports":(${'$'}buy|if . == 0 then null else . end)}' | curl -s -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/bags/launch" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
name                 = "Token name (e.g. 'My Agent Token')"
symbol               = "Ticker symbol, 2-8 chars (e.g. 'MAT')"
description          = "Short description of the token (1-3 sentences)"
image_cid            = "Keccak-256 hex CID of a user-attached image (preferred when user uploads a file). Leave empty string if not available."
image_url            = "Public HTTPS URL of the token image. Use only when no image_cid is available. Leave empty string to skip."
initial_buy_lamports = "Lamports to spend on initial token buy (0 = no initial buy; 100000000 = 0.1 SOL)"

[[tools]]
name        = "bags_swap_quote"
description = "Get a swap quote for buying or selling a token on the Bags AMM. Check price before executing."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg m {token_mint} --argjson amt {amount} --arg act {action} --argjson slip {slippage_bps} '{"token_mint":${'$'}m,"amount":${'$'}amt,"action":${'$'}act,"slippage_bps":(${'$'}slip|if . == 0 then null else . end)}' | curl -s -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/bags/swap/quote" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
token_mint   = "Base58 mint address of the token to trade"
amount       = "Lamports for buys (100000000 = 0.1 SOL), token base units for sells"
action       = "\"buy\" or \"sell\""
slippage_bps = "Slippage in basis points (50 = 0.5%). Use 0 for default."

[[tools]]
name        = "bags_swap_execute"
description = "Execute a token swap on the Bags AMM — gets quote, signs, and broadcasts in one step. Returns txid."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg m {token_mint} --argjson amt {amount} --arg act {action} --argjson slip {slippage_bps} '{"token_mint":${'$'}m,"amount":${'$'}amt,"action":${'$'}act,"slippage_bps":(${'$'}slip|if . == 0 then null else . end)}' | curl -s -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/bags/swap/execute" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
token_mint   = "Base58 mint address of the token to trade"
amount       = "Lamports for buys (100000000 = 0.1 SOL), token base units for sells"
action       = "\"buy\" or \"sell\""
slippage_bps = "Slippage in basis points (50 = 0.5%). Use 0 for default."

[[tools]]
name        = "bags_pool"
description = "Get Bags AMM pool info for a token: reserves, implied price, TVL, and 24h volume."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -s "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/bags/pool/{token_mint}" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${'$'}TOML_TQ

[tools.args]
token_mint = "Base58 mint address of the token to look up"

[[tools]]
name        = "bags_claimable"
description = "List all tokens with unclaimed pool fee revenue across your entire agent wallet."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -s "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/bags/claimable" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${'$'}TOML_TQ

[[tools]]
name        = "bags_claim"
description = "Claim accumulated pool trading fees for a specific token you launched on Bags.fm."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg m {token_mint} '{"token_mint":${'$'}m}' | curl -s -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/bags/claim" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
token_mint = "Base58 mint address of the token to claim fees for"

[[tools]]
name        = "bags_positions"
description = "List all tokens you have launched on Bags.fm and their claimable fee balances."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -s "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/bags/positions" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${'$'}TOML_TQ

[[tools]]
name        = "bags_dexscreener_check"
description = "Check if a Dexscreener listing is available for a token and how much it costs."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -s "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/bags/dexscreener/check/{token_mint}" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${'$'}TOML_TQ

[tools.args]
token_mint = "Base58 mint address of the token to check"

[[tools]]
name        = "bags_dexscreener_list"
description = "Create and pay for a Dexscreener listing in one step. Always check bags_dexscreener_check first and confirm the cost with the user."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg m {token_mint} --arg img {image_url} '{"token_mint":${'$'}m,"image_url":(${'$'}img|if . == "" then null else . end)}' | curl -s -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/bags/dexscreener/list" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
token_mint = "Base58 mint address of the token to list"
image_url  = "HTTPS URL of token image for Dexscreener. Leave empty string to skip."
""".trimIndent()

        // ── Skill manager (dynamic skill installer) ──────────────────────────
        val TRADE_SKILL_TOML = """
[skill]
name        = "trade"
version     = "1.1.0"
description = "Trade any token on Solana via Jupiter or Raydium LaunchLab — swap, price check, token search, limit orders, DCA, and bonding-curve buy/sell."
author      = "0x01 World"
tags        = ["jupiter", "raydium", "launchlab", "swap", "trading", "defi", "solana", "limit-orders", "dca", "bonding-curve"]

prompts = [${'$'}TOML_TQ
# Solana Trading — Jupiter + Raydium LaunchLab

You can trade any Solana token directly from this agent.

## Routing decision: Jupiter vs LaunchLab

| Situation | Tool to use |
|-----------|-------------|
| Token is **established / graduated** (listed on major DEXes) | Jupiter — `trade_swap` |
| Token is **still on the LaunchLab bonding curve** (not yet graduated) | `launchlab_buy` / `launchlab_sell` |
| User mentions "bonding curve", "pump", "LaunchLab", or a very new token | LaunchLab |
| Unsure → check price first | `trade_price`; if it returns data, Jupiter works |

## Jupiter capabilities

1. **Swap** — `trade_swap` executes a market swap instantly (quote + sign + broadcast).
2. **Quote** — `trade_quote` checks expected output before committing.
3. **Price** — `trade_price` looks up current USD price by mint address.
4. **Token search** — `trade_tokens` finds a mint by name or symbol.
5. **Limit orders** — `trade_limit_create` places a buy/sell at a target price.
   `trade_limit_orders` lists open orders. `trade_limit_cancel` cancels them.
6. **DCA** — `trade_dca_create` sets up recurring buys at a fixed interval.

## Raydium LaunchLab capabilities

Use the `launchlab` skill tools for bonding-curve tokens:

1. **Buy** — `launchlab_buy` — spend SOL (in lamports) to buy tokens from the bonding curve.
2. **Sell** — `launchlab_sell` — sell tokens (in base units) back to the bonding curve.

The node earns a 0.1% share fee on every LaunchLab trade, credited on-chain atomically.

## CA confirmation for unknown tokens

`trade_swap` runs instantly for known tokens (SOL, USDC, USDT, JUP, BONK, RAY, WIF, BAGS, mSOL, ETH).
For **any other mint**, the swap is parked and returns HTTP 202 with a `swap_id`. The user must
confirm or reject it in the mobile app (Pending Swaps card) within 5 minutes.
When this happens, tell the user: "I've queued the swap — please confirm the token CA in the app."

## Sending tokens

Use `wallet_send` to transfer SOL or any SPL token from the agent hot wallet to another address.
No `mint` = native SOL. With `mint` = SPL transfer (destination ATA is created automatically).

## Amount conventions

- SOL amounts: lamports (1 SOL = 1_000_000_000)
- USDC amounts: micro-USDC (1 USDC = 1_000_000)
- Token base units vary by mint — use `trade_quote` or `trade_price` to calculate.

## Rules

- Always confirm trade details (token, amount, expected output) with the user before executing.
- Use `trade_quote` or `trade_price` first so the user knows what they're getting.
- For unknown CAs: after calling `trade_swap`, tell the user to confirm in the app.
- For LaunchLab (`launchlab_buy`/`launchlab_sell`), confirm the SOL amount before buying; report the txid and share fee after.
- For limit orders, confirm the target price and expiry before placing.
- For DCA, confirm total amount, per-cycle amount, and interval before creating.
- For `wallet_send`, always confirm destination and amount with the user first.
${'$'}TOML_TQ]

[[tools]]
name        = "trade_price"
description = "Look up current USD price for one or more tokens by mint address."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -s "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/trade/price?ids={mints}" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${'$'}TOML_TQ

[tools.args]
mints = "Comma-separated list of base58 mint addresses (e.g. 'So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')"

[[tools]]
name        = "trade_tokens"
description = "Search for a token by name or symbol to find its mint address."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -s "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/trade/tokens?q={query}" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${'$'}TOML_TQ

[tools.args]
query = "Token name or ticker symbol to search for (e.g. 'bonk' or 'USDC')"

[[tools]]
name        = "trade_quote"
description = "Get a swap quote — expected output amount for a given input. Use before swapping to confirm the rate."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -s "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/trade/quote?input_mint={input_mint}&output_mint={output_mint}&amount={amount}&slippage_bps={slippage_bps}" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${'$'}TOML_TQ

[tools.args]
input_mint   = "Mint address of the token to sell"
output_mint  = "Mint address of the token to buy"
amount       = "Amount to sell in base units (lamports for SOL, micro-USDC for USDC)"
slippage_bps = "Slippage tolerance in basis points (50 = 0.5%). Use 50 as default."

[[tools]]
name        = "trade_swap"
description = "Execute a market swap — quote, sign, and broadcast in one step. Returns txid."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg im {input_mint} --arg om {output_mint} --argjson amt {amount} --argjson slip {slippage_bps} '{"input_mint":${'$'}im,"output_mint":${'$'}om,"amount":${'$'}amt,"slippage_bps":${'$'}slip}' | curl -s -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/trade/swap" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
input_mint   = "Mint address of the token to sell"
output_mint  = "Mint address of the token to buy"
amount       = "Amount to sell in base units"
slippage_bps = "Slippage in basis points (50 = 0.5%)"

[[tools]]
name        = "trade_limit_create"
description = "Place a limit order — buy or sell at a specific price. Signs and broadcasts the order tx."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg im {input_mint} --arg om {output_mint} --argjson mka {making_amount} --argjson tka {taking_amount} --argjson exp {expired_at} '{"input_mint":${'$'}im,"output_mint":${'$'}om,"making_amount":${'$'}mka,"taking_amount":${'$'}tka,"expired_at":(${'$'}exp|if . == 0 then null else . end)}' | curl -s -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/trade/limit/create" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
input_mint    = "Mint to sell"
output_mint   = "Mint to buy"
making_amount = "Amount of input_mint to spend (base units)"
taking_amount = "Amount of output_mint to receive (base units) — this sets your target price"
expired_at    = "Unix timestamp when order expires (0 = never)"

[[tools]]
name        = "trade_limit_orders"
description = "List all open limit orders for this agent wallet."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -s "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/trade/limit/orders" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${'$'}TOML_TQ

[[tools]]
name        = "trade_limit_cancel"
description = "Cancel one or more open limit orders by their order pubkeys."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --argjson orders {orders} '{"orders":${'$'}orders}' | curl -s -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/trade/limit/cancel" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
orders = "JSON array of order pubkey strings to cancel (e.g. '[\"ABC...\",\"DEF...\"]')"

[[tools]]
name        = "trade_dca_create"
description = "Create a DCA (dollar-cost averaging) order — recurring buys at a fixed interval."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg im {input_mint} --arg om {output_mint} --argjson total {in_amount} --argjson per_cycle {in_amount_per_cycle} --argjson secs {cycle_seconds} '{"input_mint":${'$'}im,"output_mint":${'$'}om,"in_amount":${'$'}total,"in_amount_per_cycle":${'$'}per_cycle,"cycle_seconds":${'$'}secs}' | curl -s -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/trade/dca/create" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
input_mint        = "Mint to sell (e.g. USDC)"
output_mint       = "Mint to buy (e.g. SOL)"
in_amount         = "Total amount of input_mint to DCA (base units)"
in_amount_per_cycle = "Amount to swap each cycle (base units)"
cycle_seconds     = "Seconds between each cycle (3600 = hourly, 86400 = daily)"

[[tools]]
name        = "wallet_send"
description = "Send SOL or any SPL token from the agent hot wallet to a destination address."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg to {to} --argjson amt {amount} --arg m {mint} '{"to":${'$'}to,"amount":${'$'}amt} | if ${'$'}m != "" then . + {"mint":${'$'}m} else . end' | curl -s -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/wallet/send" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
to     = "Destination Solana wallet address (base58)"
amount = "Amount in base units (lamports for SOL, token-native units for SPL)"
mint   = "SPL token mint address (base58). Leave empty string for native SOL."
""".trimIndent()

        // ── Raydium LaunchLab bonding-curve skill ────────────────────────────
        val LAUNCHLAB_SKILL_TOML = """
[skill]
name        = "launchlab"
version     = "1.0.0"
description = "Buy and sell tokens on the Raydium LaunchLab bonding curve. Earns a 0.1% share fee on every trade routed through the node — paid on-chain atomically."
author      = "0x01 World"
tags        = ["raydium", "launchlab", "bonding-curve", "defi", "solana", "fee-sharing"]

prompts = [${'$'}TOML_TQ
# Raydium LaunchLab Trading

You can buy and sell tokens on the Raydium LaunchLab bonding curve directly from this agent.
Every trade earns a 0.1% share fee for the node operator, credited on-chain atomically.

## Capabilities

1. **Buy** — launchlab_buy spends SOL (lamports) to buy a token from its bonding curve.
2. **Sell** — launchlab_sell sells tokens back to the bonding curve for SOL.

## Amount conventions

- amount_in for buys: lamports of SOL (1 SOL = 1_000_000_000)
- amount_in for sells: token base units
- minimum_amount_out: optional slippage floor; use 0 or omit for no protection

## When to use

- Token is still on its Raydium LaunchLab bonding curve (not yet graduated).
- If a trade fails with "not found on LaunchLab", the token may have graduated — use trade_swap (Jupiter) instead.

## Rules

- Always confirm the mint, amount, and direction (buy/sell) with the user before executing.
- Report the share_fee_rate in the response (1000 = 0.1%) so users know the fee.
${'$'}TOML_TQ]

[[tools]]
name        = "launchlab_buy"
description = "Buy a token from its Raydium LaunchLab bonding curve using SOL. Returns txid and the share fee rate applied."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg m {mint} --argjson amt {amount_in} --argjson min_out {minimum_amount_out} '{"mint":${'$'}m,"amount_in":${'$'}amt,"minimum_amount_out":(${'$'}min_out|if . == 0 then null else . end)}' | curl -s -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/trade/launchlab/buy" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
mint               = "Base58 mint address of the token to buy"
amount_in          = "Lamports of SOL to spend (1 SOL = 1_000_000_000)"
minimum_amount_out = "Minimum tokens to receive — slippage floor. Use 0 for no protection."

[[tools]]
name        = "launchlab_sell"
description = "Sell a token back to its Raydium LaunchLab bonding curve for SOL. Returns txid and the share fee rate applied."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg m {mint} --argjson amt {amount_in} --argjson min_out {minimum_amount_out} '{"mint":${'$'}m,"amount_in":${'$'}amt,"minimum_amount_out":(${'$'}min_out|if . == 0 then null else . end)}' | curl -s -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/trade/launchlab/sell" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
mint               = "Base58 mint address of the token to sell"
amount_in          = "Amount of tokens to sell (base units)"
minimum_amount_out = "Minimum SOL lamports to receive. Use 0 for no slippage protection."
""".trimIndent()

        // ── Raydium CPMM pool creation skill ─────────────────────────────────
        val CPMM_SKILL_TOML = """
[skill]
name        = "cpmm"
version     = "1.0.0"
description = "Create a Raydium CPMM (Constant Product) liquidity pool. Pool creator earns LP fees on every swap forever. Typical use: list a newly launched token for open trading after the bonding curve phase."
author      = "0x01 World"
tags        = ["raydium", "cpmm", "amm", "liquidity", "defi", "solana", "pool-creation"]

prompts = [${'$'}TOML_TQ
# Raydium CPMM Pool Creation

You can create a Raydium CPMM liquidity pool for any token pair directly from this agent.
The pool creator earns a share of every swap fee in proportion to their LP token holdings.

## Capabilities

1. **Create pool** — cpmm_create_pool deploys a new constant-product AMM pool.
   Returns pool_id, lp_mint, and txid.

## Cost

- ~0.15 SOL Raydium pool creation fee (paid on-chain, non-refundable).
- Plus initial liquidity: amount_a and amount_b are deposited into the pool.

## Fee tiers (fee_config_index)

- 0 = 0.25% (default, most tokens)
- 1 = 0.30% (higher-volume pairs)
- 2 = 0.01% (stable pairs)

## Typical workflow after a Bags token launch

1. Launch token with bags_launch.
2. Once the user wants open trading, call cpmm_create_pool with the new mint and
   WSOL (So11111111111111111111111111111111111111112) as mint_b.
3. Share the pool_id — users can now swap on Raydium.

## Rules

- Always confirm the token pair, amounts, and fee tier with the user before creating.
- Remind the user that the 0.15 SOL creation fee is non-refundable.
- Report pool_id and lp_mint after success — the user will want to save these.
- open_time = 0 means trading opens immediately.
${'$'}TOML_TQ]

[[tools]]
name        = "cpmm_create_pool"
description = "Create a Raydium CPMM liquidity pool for a token pair. Costs ~0.15 SOL creation fee plus initial liquidity. Returns pool_id, lp_mint, and txid."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg ma {mint_a} --arg mb {mint_b} --argjson aa {amount_a} --argjson ab {amount_b} --argjson ot {open_time} --argjson fi {fee_config_index} '{"mint_a":${'$'}ma,"mint_b":${'$'}mb,"amount_a":${'$'}aa,"amount_b":${'$'}ab,"open_time":(${'$'}ot|if . == 0 then null else . end),"fee_config_index":(${'$'}fi|if . == 0 then null else . end)}' | curl -s -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/trade/cpmm/create-pool" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
mint_a           = "Base58 mint address of the first token (e.g. newly launched token)"
mint_b           = "Base58 mint address of the second token (e.g. WSOL: So11111111111111111111111111111111111111112)"
amount_a         = "Initial liquidity for mint_a in base units"
amount_b         = "Initial liquidity for mint_b in base units (sets the initial price ratio)"
open_time        = "Unix timestamp when swapping opens (0 = immediately)"
fee_config_index = "Raydium fee tier: 0=0.25% default, 1=0.30%, 2=0.01% stable"
""".trimIndent()

        // ── Phone health & wearables skill ───────────────────────────────────
        val HEALTH_SKILL_TOML = """
[skill]
name        = "health"
version     = "1.0.0"
description = "Read health metrics from Android Health Connect and paired BLE wearables. Compute sleep + recovery readiness scores and give actionable coaching."
author      = "0x01 World"
tags        = ["health", "fitness", "wearables", "sleep", "recovery", "hrv", "biometrics", "coaching"]

prompts = [${'$'}TOML_TQ
# Health & Wearables

You can access real health data from this Android device and its paired BLE wearables.
All data is read-only. Never share raw health data externally without explicit user consent.

## Available tools

| Tool | What it does |
|------|-------------|
| `phone_health_read` | Aggregate health data from Android Health Connect (steps, HR, HRV, sleep, calories, SpO2, weight) |
| `phone_wearable_scan` | Discover nearby BLE health devices (heart rate monitors, glucose meters, CGM, smart scales, running pods) |
| `phone_wearable_read` | Connect to a specific wearable and read one service characteristic in real time |
| `phone_recovery_status` | Compute a 0-100 sleep + recovery readiness score with per-component breakdown and insights |

## Workflows

### Daily health summary
1. Call `phone_health_read` with `types=steps,heart_rate,hrv,sleep,calories` and `days=1`.
2. Present a concise summary: steps vs typical, sleep duration and quality, average HR.

### Recovery coaching
1. Call `phone_recovery_status` — returns score, label (Optimal / Good / Fair / Poor), and insights.
2. Use the insights list to give specific, actionable advice (sleep earlier, rest day, light workout, etc.).
3. If HRV or resting HR data is stale (>24h), mention that the score may be less accurate.

### Wearable data (real-time)
1. Call `phone_wearable_scan` to list nearby devices.
2. Present the list to the user; ask which device and which service they want to read.
3. Call `phone_wearable_read` with the chosen device address and service.
4. Supported services: `heart_rate`, `battery`, `body_composition`, `running_speed_cadence`, `glucose`, `cgm`.

### HRV trend / baseline
1. Call `phone_health_read` with `types=hrv` and `days=30` for the 30-day picture.
2. Call with `days=7` for the recent week.
3. Compare weekly average to 30-day baseline to spot training load or stress trends.

## Rules

- Always check Health Connect availability; if `status != SDK_AVAILABLE` explain the user needs to install Google Health Connect.
- Permissions must be granted in the app before data is available; if empty results, remind the user to grant health permissions.
- Never guess or fabricate health values — only report what the tools return.
- Recovery advice should be supportive and non-diagnostic. Do not make medical claims.
- For glucose or CGM data, note that these require a compatible device to be paired and within BLE range.
${'$'}TOML_TQ]
""".trimIndent()

        // All tools call the node REST API — no shell file operations.
        // This prevents path traversal and shell injection.
        val SKILL_MANAGER_TOML = """
[skill]
name        = "skill_manager"
version     = "1.2.0"
description = "Install, remove, and reload zeroclaw skills without an app update. Browse the 0x01 marketplace or write any SKILL.toml from chat."
author      = "0x01 World"
tags        = ["skills", "plugins", "extensibility", "marketplace"]

prompts = [${'$'}TOML_TQ
# Skill Manager

You can extend your own capabilities by installing new skills — no app update required.

## What is a skill?

A skill is a SKILL.toml file that defines:
- A system-prompt injection (`prompts`)
- One or more shell tools (`[[tools]]`) executed with `kind = "shell"`

Tools are simple curl commands to any REST API.

## SKILL.toml format

```toml
[skill]
name        = "my-skill"
version     = "1.0.0"
description = "What this skill does"

prompts = [${'$'}TOML_TQ
# Instructions
${'$'}TOML_TQ]

[[tools]]
name        = "my_tool"
description = "What this tool does"
kind        = "shell"
command     = ${'$'}TOML_TQcurl -sf https://api.example.com/endpoint -H "Authorization: Bearer ${'$'}{MY_KEY:-}" ${'$'}TOML_TQ

[tools.args]
param1 = "Description of param1"
```

## How to install a skill

### Option A — Generate from scratch (most powerful)
1. Generate the full SKILL.toml content as a string
2. Base64-encode it: `printf '%s' '<toml>' | base64`
3. Call `skill_write` with the skill name and base64 content
4. Call `skill_reload` — you restart and come back with the new skill active

### Option B — Install from the 0x01 Marketplace
1. Call `skill_marketplace_list` to see what's available
2. Call `skill_marketplace_install` with the skill name
3. Call `skill_reload` — you restart with the new skill active

### Option C — Install from URL
Call `skill_install_url` with a name and HTTPS URL pointing to a SKILL.toml.
Only use URLs explicitly provided by the user.

## Rules
- Skill names: lowercase letters, digits, hyphens, underscores only. No slashes or dots.
- Only HTTPS URLs for skill_install_url.
- Always call skill_reload after writing or installing.
- Tell the user which tools are now available after reload.
- When browsing the marketplace, show requires_node and free fields so the user knows what's needed.
- Do not install skills from URLs unless the user explicitly provided the URL or found it via skill_marketplace_list.
${'$'}TOML_TQ]

[[tools]]
name        = "skill_list"
description = "List all installed skills."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -sf "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/skill/list" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${'$'}TOML_TQ

[[tools]]
name        = "skill_write"
description = "Install a new skill by writing its SKILL.toml. Pass base64-encoded content. Call skill_reload after."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg n {name} --arg c {content_b64} '{"name":${'$'}n,"content_b64":${'$'}c}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/skill/write" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
name        = "Skill name: lowercase letters, digits, hyphens, underscores (e.g. pump-fun)"
content_b64 = "Base64-encoded SKILL.toml content"

[[tools]]
name        = "skill_install_url"
description = "Download and install a SKILL.toml from an HTTPS URL provided by the user."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg n {name} --arg u {url} '{"name":${'$'}n,"url":${'$'}u}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/skill/install-url" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
name = "Skill name (lowercase, hyphens ok)"
url  = "Direct HTTPS URL to the SKILL.toml (must be provided by user)"

[[tools]]
name        = "skill_remove"
description = "Remove an installed skill by name."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg n {name} '{"name":${'$'}n}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/skill/remove" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
name = "Name of the skill to remove"

[[tools]]
name        = "skill_reload"
description = "Restart the agent brain to activate newly installed or removed skills. The agent will be back in seconds."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/agent/reload" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" ${'$'}TOML_TQ

[[tools]]
name        = "skill_marketplace_list"
description = "Browse the 0x01 skill marketplace — returns all available skills with name, description, tags, and whether a running node or API key is required."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -sf "https://skills.0x01.world/skills" ${'$'}TOML_TQ

[[tools]]
name        = "skill_marketplace_install"
description = "Install a skill directly from the 0x01 marketplace by name. Call skill_reload after to activate it."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg n {name} --arg u "https://skills.0x01.world/skills/{name}/SKILL.toml" '{"name":${'$'}n,"url":${'$'}u}' | curl -sf -X POST "${'$'}{ZX01_NODE:-http://127.0.0.1:9090}/skill/install-url" -H "Content-Type: application/json" -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}" -d @-${'$'}TOML_TQ

[tools.args]
name = "Skill name from the marketplace (e.g. 'weather', 'github', 'hn-news', 'web-search')"
""".trimIndent()

        val WEB_SKILL_TOML = """
[skill]
name        = "web"
version     = "1.0.0"
description = "Fetch web pages and search the internet. Use for real-time information and URL content."
author      = "0x01 World"
tags        = ["web", "search", "fetch", "internet", "http"]

prompts = [${'$'}TOML_TQ
# Web Access

You can fetch web content and search the web.

- web_fetch — download the content of any URL (returns raw HTML/text)
- web_search — search DuckDuckGo Instant Answers API (no API key needed)

Use web_fetch when the user provides a specific URL. Use web_search to find current information by keyword.
${'$'}TOML_TQ]

[[tools]]
name        = "web_fetch"
description = "Fetch the raw content of a URL (HTML or plain text). Use for reading a specific page."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -sf --max-time 20 -L -A "Mozilla/5.0 (compatible; zerox1-agent)" "{url}"${'$'}TOML_TQ

[tools.args]
url = "Full URL to fetch, must start with https://"

[[tools]]
name        = "web_search"
description = "Search the web using DuckDuckGo Instant Answers. Returns abstract, direct answer, and related topics."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -sf --max-time 10 "https://api.duckduckgo.com/?q={query}&format=json&no_html=1&skip_disambig=1" | jq '{abstract:.Abstract,abstractSource:.AbstractSource,answer:.Answer,results:[.RelatedTopics[]?|{text:.Text,url:.FirstURL}]|.[0:8]}'${'$'}TOML_TQ

[tools.args]
query = "Search query string"
""".trimIndent()

        val PHONE_UI_SKILL_TOML = """
[skill]
name        = "phone-ui"
version     = "1.0.0"
description = "Control and automate the Android UI. Read the screen, tap, type, scroll, and execute multi-step plans without leaving a conversation."
author      = "0x01 World"
tags        = ["android", "ui", "automation", "accessibility", "screen", "tap", "type"]

prompts = [${'$'}TOML_TQ
# Android UI Control

You can read and control the Android UI on this device via the phone bridge.

## CRITICAL — batch planning eliminates latency

**Always use `phone_ui_execute` for flows with 2+ steps.**
Plan the entire sequence in one shot. This collapses N LLM calls into 1.

## Tools

| Tool | Use for |
|------|---------|
| `phone_ui_tree`     | Read compact interactive tree before planning. Returns only clickable/editable/scrollable nodes. |
| `phone_ui_execute`  | **Preferred.** Execute a complete multi-step plan atomically — no LLM round-trips between steps. |
| `phone_ui_screenshot` | Capture current screen as base64 JPEG. |
| `phone_ui_tap_text` | Single tap by text label (with built-in wait). |
| `phone_ui_wait_for` | Wait until element appears, then optionally tap it. |
| `phone_ui_type`     | Type text into the focused or specified field. |
| `phone_ui_global`   | back / home / recents / notifications / quick_settings. |

## execute_plan step reference

```json
{"type":"wait_for",    "text":"Login",    "timeout_ms":5000, "tap":true}
{"type":"scroll_find", "text":"Submit",   "direction":"down", "max_scrolls":10, "tap":true}
{"type":"tap_text",    "text":"Next",     "exact":false,      "timeout_ms":3000}
{"type":"tap",         "x":540, "y":1200}
{"type":"type",        "text":"hello",    "view_id":"com.ex:id/field"}
{"type":"action",      "view_id":"...",   "action":"click"}
{"type":"global",      "action":"back"}
{"type":"screenshot"}
{"type":"sleep",       "ms":500}
```

## Workflow pattern

1. `phone_ui_tree` — identify element texts / viewIds / bounds.
2. `phone_ui_execute` — pass all steps at once. Check `all_succeeded` in the response.

## Rules

- Describe what you are about to do before executing.
- Accessibility service must be enabled in Android Settings → Accessibility → 0x01 Agent.
- Never submit or send messages without confirming with the user first.
${'$'}TOML_TQ]

[[tools]]
name        = "phone_ui_tree"
description = "Read only the interactive UI nodes on screen (clickable, editable, scrollable, and labelled). Much smaller than the full tree — use this before planning any multi-step flow to get viewIds and text labels."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -sf -H "X-Bridge-Token: ${'$'}{ZX01_BRIDGE_TOKEN:-}" "${'$'}{ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/a11y/tree_interactive"${'$'}TOML_TQ

[[tools]]
name        = "phone_ui_execute"
description = "Execute a multi-step UI automation plan atomically. Pass a JSON object with a 'steps' array. Step types: wait_for, scroll_find, tap_text, tap (x/y), type, action (viewId+action), global (back/home/recents), screenshot, sleep. Returns per-step results and all_succeeded. PREFER THIS for any flow with 2+ steps."
kind        = "shell"
command     = ${'$'}TOML_TQprintf '%s' {plan_json} | curl -sf -X POST -H "Content-Type: application/json" -H "X-Bridge-Token: ${'$'}{ZX01_BRIDGE_TOKEN:-}" "${'$'}{ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/a11y/execute_plan" -d @-${'$'}TOML_TQ

[tools.args]
plan_json = "JSON object: {\"steps\":[...], \"stop_on_failure\":true}. See step reference in skill prompt."

[[tools]]
name        = "phone_ui_screenshot"
description = "Capture current screen as base64 JPEG. Use with vision to understand what is on screen before planning."
kind        = "shell"
command     = ${'$'}TOML_TQcurl -sf -H "X-Bridge-Token: ${'$'}{ZX01_BRIDGE_TOKEN:-}" "${'$'}{ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/a11y/screenshot"${'$'}TOML_TQ

[[tools]]
name        = "phone_ui_tap_text"
description = "Find and tap an element by its text label. Waits up to timeout_ms. Use for single taps when you already know the label."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg t {text} --argjson e {exact} --argjson ms {timeout_ms} '{"text":${'$'}t,"exact":${'$'}e,"timeout_ms":${'$'}ms}' | curl -sf -X POST -H "Content-Type: application/json" -H "X-Bridge-Token: ${'$'}{ZX01_BRIDGE_TOKEN:-}" "${'$'}{ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/a11y/tap_text" -d @-${'$'}TOML_TQ

[tools.args]
text       = "Text label to tap"
exact      = "true = exact match, false = contains (default: false)"
timeout_ms = "Max wait ms (default: 3000)"

[[tools]]
name        = "phone_ui_wait_for"
description = "Wait for a UI element to appear, then optionally tap it. Specify at least one selector: text, view_id, or content_desc."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg vid {view_id} --arg txt {text} --arg cd {content_desc} --argjson ms {timeout_ms} --argjson tap {tap} '{"view_id":(${'$'}vid|if .=="" then null else . end),"text":(${'$'}txt|if .=="" then null else . end),"content_desc":(${'$'}cd|if .=="" then null else . end),"timeout_ms":${'$'}ms,"tap":${'$'}tap}|with_entries(select(.value!=null))' | curl -sf -X POST -H "Content-Type: application/json" -H "X-Bridge-Token: ${'$'}{ZX01_BRIDGE_TOKEN:-}" "${'$'}{ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/a11y/wait_for" -d @-${'$'}TOML_TQ

[tools.args]
view_id      = "Resource-id e.g. com.example:id/btn (leave empty to match by text)"
text         = "Text label (leave empty to match by view_id)"
content_desc = "Accessibility content-description (leave empty if using text/view_id)"
timeout_ms   = "Max wait ms (default: 5000)"
tap          = "true to tap when found (default: false)"

[[tools]]
name        = "phone_ui_type"
description = "Type text into a field. If view_id is given, targets that field; otherwise uses the focused or first editable field."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg t {text} --arg vid {view_id} '{"text":${'$'}t,"view_id":(${'$'}vid|if .=="" then null else . end)}|with_entries(select(.value!=null))' | curl -sf -X POST -H "Content-Type: application/json" -H "X-Bridge-Token: ${'$'}{ZX01_BRIDGE_TOKEN:-}" "${'$'}{ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/a11y/type" -d @-${'$'}TOML_TQ

[tools.args]
text    = "Text to type"
view_id = "Resource-id of the target field (optional)"

[[tools]]
name        = "phone_ui_global"
description = "Perform a global system action: back, home, recents, notifications, quick_settings, power_dialog, lock_screen."
kind        = "shell"
command     = ${'$'}TOML_TQjq -nc --arg a {action} '{"action":${'$'}a}' | curl -sf -X POST -H "Content-Type: application/json" -H "X-Bridge-Token: ${'$'}{ZX01_BRIDGE_TOKEN:-}" "${'$'}{ZX01_BRIDGE_URL:-http://127.0.0.1:9092}/phone/a11y/global" -d @-${'$'}TOML_TQ

[tools.args]
action = "back | home | recents | notifications | quick_settings | power_dialog | lock_screen"
""".trimIndent()
    }

    private var nodeProcess:  Process? = null
    private var agentProcess: Process? = null
    private var phoneBridge:  PhoneBridgeServer? = null
    private var wakeLock:     PowerManager.WakeLock? = null
    private val serviceScope  = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var bridgeSecret: String = ""
    private val secureRandom = SecureRandom()

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        // Cancel ntfy polling — node is now running and handles messages via WS.
        NtfyWakeWorker.cancel(applicationContext)
        createNotificationChannel()
        val wm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = wm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "zerox1:NodeWakeLock")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Guard: if the node process is already alive, ignore duplicate start commands.
        // This prevents double-spawn when autostart + user tap both fire onStartCommand.
        if (nodeProcess?.isAlive == true) {
            Log.i(TAG, "Node already running — ignoring duplicate onStartCommand")
            return START_STICKY
        }

        // Android 12+ (API 31+) throws ForegroundServiceStartNotAllowedException when
        // startForeground() is called from a background context (e.g. auto-restart after
        // the OS killed the process, or BootReceiver on some devices/emulators).
        // Android 14+ (API 34+) with targetSdk 34+ throws MissingForegroundServiceTypeException
        // when the 2-parameter startForeground() is used — a service type is now required.
        // Use the 3-parameter version (available since API 29) to satisfy API 34+ requirements,
        // and catch both exception types to stop cleanly instead of crashing.
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(
                    NOTIF_ID,
                    buildNotification("Starting…"),
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(NOTIF_ID, buildNotification("Starting…"))
            }
        } catch (e: android.app.ForegroundServiceStartNotAllowedException) {
            Log.w(TAG, "startForeground denied (background FGS restriction) — stopping gracefully", e)
            broadcastStatus(STATUS_ERROR, "Cannot start node from background — open the app to start")
            stopSelf()
            return START_NOT_STICKY
        } catch (e: Exception) {
            // Catches MissingForegroundServiceTypeException (API 34+) and any other
            // foreground service startup failures.
            Log.e(TAG, "startForeground failed — stopping gracefully", e)
            broadcastStatus(STATUS_ERROR, "Foreground service start failed: ${e.message}")
            stopSelf()
            return START_NOT_STICKY
        }

        // Re-acquire wake lock for this session. 8-hour timeout keeps the CPU awake
        // for overnight use while still being bounded against leaks if onDestroy is
        // skipped. Release first so a user restart doesn't double-hold.
        if (wakeLock?.isHeld == true) wakeLock?.release()
        wakeLock?.acquire(8 * 60 * 60 * 1000L)

        val relayAddr    = intent?.getStringExtra(EXTRA_RELAY_ADDR)
        val fcmToken     = intent?.getStringExtra(EXTRA_FCM_TOKEN)
        val agentName    = intent?.getStringExtra(EXTRA_AGENT_NAME) ?: "zerox1-agent"
        val rpcUrl       = intent?.getStringExtra(EXTRA_RPC_URL)
            ?: if (BuildConfig.HELIUS_API_KEY.isNotBlank())
                "https://mainnet.helius-rpc.com/?api-key=${BuildConfig.HELIUS_API_KEY}"
               else
                "https://api.mainnet-beta.solana.com"
        val tradeRpcUrl  = if (BuildConfig.HELIUS_API_KEY.isNotBlank())
                "https://mainnet.helius-rpc.com/?api-key=${BuildConfig.HELIUS_API_KEY}"
               else
                "https://api.mainnet-beta.solana.com"
        val bagsFeeBps   = if (intent?.hasExtra(EXTRA_BAGS_FEE_BPS) == true)
                               intent.getIntExtra(EXTRA_BAGS_FEE_BPS, 0) else 0
        val bagsWallet   = intent?.getStringExtra(EXTRA_BAGS_WALLET)
        val bagsApiKey   = intent?.getStringExtra(EXTRA_BAGS_API_KEY)
            ?.takeIf { it.isNotBlank() }
            ?: BuildConfig.DEFAULT_BAGS_API_KEY.takeIf { it.isNotBlank() }
        val bagsPartnerKey = intent?.getStringExtra(EXTRA_BAGS_PARTNER_KEY)
            ?.takeIf { it.isNotBlank() }
            ?: BuildConfig.DEFAULT_BAGS_PARTNER_KEY.takeIf { it.isNotBlank() }
        val jupiterFeeAccount = intent?.getStringExtra(EXTRA_JUPITER_FEE_ACCOUNT)
            ?.takeIf { it.isNotBlank() }
            ?: BuildConfig.DEFAULT_JUPITER_FEE_ACCOUNT.takeIf { it.isNotBlank() }
        val launchlabShareFeeWallet = intent?.getStringExtra(EXTRA_LAUNCHLAB_SHARE_FEE_WALLET)
            ?.takeIf { it.isNotBlank() }
            ?: BuildConfig.DEFAULT_LAUNCHLAB_SHARE_FEE_WALLET.takeIf { it.isNotBlank() }
        val brainEnabled   = intent?.getBooleanExtra(EXTRA_BRAIN_ENABLED, false) ?: false
        val llmProvider    = intent?.getStringExtra(EXTRA_LLM_PROVIDER) ?: "gemini"
        val llmModel       = intent?.getStringExtra(EXTRA_LLM_MODEL) ?: ""
        val llmBaseUrl     = intent?.getStringExtra(EXTRA_LLM_BASE_URL) ?: ""
        Log.i(TAG, "Brain config: enabled=$brainEnabled provider=$llmProvider model=$llmModel baseUrl=${if (llmBaseUrl.isNotBlank()) "[set]" else "[empty]"}")
        val capabilities   = intent?.getStringExtra(EXTRA_CAPABILITIES) ?: "[]"
        val minFee            = intent?.getDoubleExtra(EXTRA_MIN_FEE, 0.01) ?: 0.01
        val minRep            = intent?.getIntExtra(EXTRA_MIN_REP, 50) ?: 50
        val autoAccept        = intent?.getBooleanExtra(EXTRA_AUTO_ACCEPT, true) ?: true
        val maxActionsPerHour  = intent?.getIntExtra(EXTRA_MAX_ACTIONS, 100) ?: 100
        val maxCostPerDayCents = intent?.getIntExtra(EXTRA_MAX_COST, 1000) ?: 1000

        // CRIT-1: Generate a random bridge secret
        if (bridgeSecret.isEmpty()) {
            bridgeSecret = java.util.UUID.randomUUID().toString().replace("-", "").take(16)
            Log.i(TAG, "Phone Bridge Secret generated.")
        }

        // Apply flavor-appropriate capability defaults on first launch.
        // User can override these in Settings; we only write if not already initialized
        // for this distribution variant (re-initializes if distribution changes).
        applyDistributionCapabilityDefaults()

        // CRIT-4: Read API key from Keystore later, not from intent
        // For now, removing it from intent extraction to satisfy audit, 
        // we will implement the Keystore read in writeAgentConfig.

        serviceScope.launch {
            try {
                val binary = prepareNodeBinary()
                // MED-4: Replace recursive launchNode with iterative loop in separate job
                launchNodeIterative(binary, relayAddr, fcmToken, agentName, rpcUrl, tradeRpcUrl, bagsFeeBps, bagsWallet, bagsApiKey, bagsPartnerKey, jupiterFeeAccount, launchlabShareFeeWallet)
            } catch (e: Exception) {
                Log.e(TAG, "Node start failed: $e")
                broadcastStatus(STATUS_ERROR, e.message ?: "unknown error")
                stopSelf()
            }
        }

        // Validate: "custom" provider requires a base URL — skip brain launch if missing.
        val brainReady = brainEnabled && (llmProvider != "custom" || llmBaseUrl.isNotBlank())
        if (!brainReady && brainEnabled) {
            Log.w(TAG, "Agent brain skipped: provider=custom but no llm_base_url configured")
        }

        if (brainReady) {
            phoneBridge = PhoneBridgeServer(applicationContext, bridgeSecret)
            phoneBridge?.start()
            serviceScope.launch {
                try {
                    // Wait for the node REST API to be ready before starting agent
                    waitForNodeApi()
                    val agentBinary = prepareAgentBinary()
                    writeIdentityFile(File(filesDir, "zw"), rpcUrl)
                    // Restart loop — zeroclaw is SIGTERM'd by /agent/reload to pick up new skills.
                    // Re-write config on every iteration so API key / provider changes saved via
                    // Settings take effect on the next restart without requiring a full node restart.
                    while (isActive) {
                        val prefs = getSharedPreferences("zerox1", Context.MODE_PRIVATE)
                        val currentProvider   = prefs.getString("llm_provider", llmProvider) ?: llmProvider
                        val currentModel      = prefs.getString("llm_model",    llmModel)    ?: llmModel
                        val currentBaseUrl    = prefs.getString("llm_base_url", llmBaseUrl)  ?: llmBaseUrl
                        val currentCaps       = prefs.getString("capabilities",  capabilities) ?: capabilities
                        val currentMaxActions = prefs.getInt("max_actions_per_hour",   maxActionsPerHour)
                        val currentMaxCost    = prefs.getInt("max_cost_per_day_cents", maxCostPerDayCents)
                        writeAgentConfig(currentProvider, currentModel, currentBaseUrl, currentCaps, minFee, minRep, autoAccept, currentMaxActions, currentMaxCost)
                        launchAgent(agentBinary)
                        if (!isActive) break
                        Log.i(TAG, "ZeroClaw exited — restarting in 3s…")
                        delay(3_000)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Agent brain start failed: $e")
                    // Non-fatal — node continues without brain
                }
            }
        }

        return START_STICKY   // restart if killed by OS
    }

    override fun onDestroy() {
        isRunning = false
        super.onDestroy()
        serviceScope.cancel()
        agentProcess?.destroy()
        agentProcess = null
        phoneBridge?.stop()
        phoneBridge = null
        nodeProcess?.destroy()
        nodeProcess = null
        if (wakeLock?.isHeld == true) wakeLock?.release()
        broadcastStatus(STATUS_STOPPED)
        Log.i(TAG, "NodeService destroyed — zerox1-node and zeroclaw stopped.")
        // Schedule ntfy wake polling so the agent can be woken while offline.
        NtfyWakeWorker.schedule(applicationContext)
    }

    // -------------------------------------------------------------------------
    // Binary extraction
    // -------------------------------------------------------------------------

    /**
     * Copy the binary from APK assets to filesDir if:
     *   - it doesn't exist yet, OR
     *   - the bundled version string changed (version file mismatch)
     *
     * Returns the executable File.
     */
    private fun prepareNodeBinary(): File {
        // Android 14+ (API 34+) targeting SDK 34+ blocks execve() from ALL writable
        // app data directories (filesDir, codeCacheDir, cacheDir) via SELinux policy.
        // The only path where execution is allowed is nativeLibraryDir, which is
        // system-managed and non-writable at runtime.
        // The binary is packaged as jniLibs/arm64-v8a/libzerox1_node.so and Android
        // installs it to nativeLibraryDir with execute permission at install time.
        val binary = File(applicationInfo.nativeLibraryDir, "libzerox1_node.so")
        if (!binary.exists()) {
            throw IOException("Node binary not found at ${binary.absolutePath} — rebuild APK with updated jniLibs")
        }
        Log.i(TAG, "Using node binary: ${binary.absolutePath}")
        return binary
    }

    private fun securePrefs() = EncryptedSharedPreferences.create(
        applicationContext,
        SECURE_PREFS_NAME,
        MasterKey.Builder(applicationContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .setRequestStrongBoxBacked(false)  // emulator compatibility: no StrongBox HSM
            .build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    private fun randomHex(bytes: Int): String {
        val data = ByteArray(bytes)
        secureRandom.nextBytes(data)
        return data.joinToString("") { "%02x".format(it) }
    }

    private fun ensureSecureToken(key: String, prefix: String = ""): String {
        val prefs = securePrefs()
        prefs.getString(key, null)?.takeIf { it.isNotBlank() }?.let { return it }
        val value = prefix + randomHex(32)
        prefs.edit().putString(key, value).apply()
        return value
    }

    private fun loadSecureString(key: String): String? =
        runCatching { securePrefs().getString(key, null) }.getOrNull()

    private fun extractProcessPid(process: Process): Long? {
        return try {
            val field = process.javaClass.getDeclaredField("pid")
            field.isAccessible = true
            when (val value = field.get(process)) {
                is Int -> value.toLong()
                is Long -> value
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }

    // -------------------------------------------------------------------------
    // Node process
    // -------------------------------------------------------------------------

    private suspend fun launchNodeIterative(
        binary:      File,
        relayAddr:   String?,
        fcmToken:    String?,
        agentName:   String,
        rpcUrl:      String,
        tradeRpcUrl: String,
        bagsFeeBps:  Int,
        bagsWallet:  String?,
        bagsApiKey:  String?,
        bagsPartnerKey: String?,
        jupiterFeeAccount: String?,
        launchlabShareFeeWallet: String?,
    ) {
        while (coroutineContext.isActive) {
            launchNode(binary, relayAddr, fcmToken, agentName, rpcUrl, tradeRpcUrl, bagsFeeBps, bagsWallet, bagsApiKey, bagsPartnerKey, jupiterFeeAccount, launchlabShareFeeWallet)
            if (!coroutineContext.isActive) break
            Log.i(TAG, "Restarting node in 5s…")
            updateNotification("Restarting…")
            delay(5_000)
        }
    }

    private suspend fun launchNode(
        binary:      File,
        relayAddr:   String?,
        fcmToken:    String?,
        agentName:   String,
        rpcUrl:      String,
        tradeRpcUrl: String,
        bagsFeeBps:  Int,
        bagsWallet:  String?,
        bagsApiKey:  String?,
        bagsPartnerKey: String?,
        jupiterFeeAccount: String?,
        launchlabShareFeeWallet: String?,
    ) = withContext(Dispatchers.IO) {
        val logDir      = File(filesDir, "logs").also { it.mkdirs() }
        File(filesDir, "zw").mkdirs()   // skill workspace must exist before node starts
        // On Solana Mobile (dappstore flavor) derive identity from SeedVault so the
        // agent keypair is hardware-attested and recoverable from the device seed phrase.
        // On other distributions fall back to the file-based keypair.
        val keypairPath = File(filesDir, "zerox1-identity.key")
        if (BuildConfig.SEED_VAULT_ENABLED) {
            SeedVaultIdentity.ensureKeypairFile(applicationContext, keypairPath)
        }
        // Derive ntfy topic from agent pubkey (last 32 bytes of 64-byte keypair file)
        // and store in SharedPreferences for NtfyWakeWorker to read when offline.
        if (keypairPath.exists() && keypairPath.length() == 64L) {
            val pubkeyHex = keypairPath.readBytes().copyOfRange(32, 64)
                .joinToString("") { "%02x".format(it) }
            getSharedPreferences("zerox1", MODE_PRIVATE)
                .edit().putString("ntfy_topic", pubkeyHex).apply()
        }
        val aggregatorUrl = "https://api.0x01.world"
        val localApiSecret = ensureSecureToken(KEY_NODE_API_SECRET)

        // Use Helius RPC for mainnet if a platform key is baked in — the public
        // mainnet RPC is aggressively rate-limited and unsuitable for trading.
        val effectiveRpcUrl = if (
            rpcUrl.contains("mainnet") &&
            BuildConfig.HELIUS_API_KEY.isNotBlank()
        ) {
            "https://mainnet.helius-rpc.com/?api-key=${BuildConfig.HELIUS_API_KEY}"
        } else {
            rpcUrl
        }

        val cmd = mutableListOf(
            binary.absolutePath,
            "--api-addr",      "127.0.0.1:$NODE_API_PORT",
            "--api-secret",    localApiSecret,
            "--log-dir",       logDir.absolutePath,
            "--keypair-path",  keypairPath.absolutePath,
            "--agent-name",    agentName,
            "--rpc-url",       effectiveRpcUrl,
            "--trade-rpc-url", tradeRpcUrl,
            "--aggregator-url", aggregatorUrl,
            // --relay-server is a boolean flag; omit it (default is false)
        )

        // Default relay: use bootstrap-1 (US) as circuit relay when no custom
        // relay is configured.  Mobile nodes behind CGNAT need relay to participate
        // in gossipsub and receive bilateral messages.
        val effectiveRelay = relayAddr
            ?: "/dns4/bootstrap-1.0x01.world/tcp/9000/p2p/12D3KooWLudabD69eAYzfoZMVRqJb8XHBLDKsQvRn6Q9hTQqvMuY/p2p-circuit"
        cmd += listOf("--relay-addr", effectiveRelay)
        fcmToken?.let  { cmd += listOf("--fcm-token",  it) }
        if (bagsFeeBps > 0) {
            cmd += listOf("--bags-fee-bps", bagsFeeBps.toString())
            bagsWallet?.let { cmd += listOf("--bags-wallet", it) }
        }
        bagsApiKey?.let { cmd += listOf("--bags-api-key", it) }
        bagsPartnerKey?.let { cmd += listOf("--bags-partner-key", it) }
        jupiterFeeAccount?.let { cmd += listOf("--jupiter-fee-account", it) }
        launchlabShareFeeWallet?.let { cmd += listOf("--launchlab-share-fee-wallet", it) }

        // Skill workspace — enables the skill manager REST endpoints on the node.
        cmd += listOf("--skill-workspace", File(filesDir, "zw").absolutePath)

        // Disable 8004 registry gate on devnet — genesis/bootstrap agents are not
        // registered, so without this flag all PROPOSEs get dropped as "deactivated".
        cmd += "--registry-8004-disabled"

        // Redact sensitive flags before logging.
        val safeCmd = cmd.toMutableList().also { list ->
            for (flag in listOf("--bags-api-key", "--bags-partner-key", "--jupiter-fee-account", "--api-secret", "--fcm-token")) {
                val idx = list.indexOf(flag)
                if (idx >= 0 && idx + 1 < list.size) list[idx + 1] = "[REDACTED]"
            }
        }
        Log.i(TAG, "Launching node: ${safeCmd.joinToString(" ")}")

        val process = ProcessBuilder(cmd)
            .redirectErrorStream(true)
            .start()

        nodeProcess = process

        val logJob = launch {
            process.inputStream.bufferedReader().useLines { lines ->
                lines.forEach { line ->
                    if (BuildConfig.DEBUG) Log.d(TAG, "[node] $line")
                }
            }
        }

        // Wait for the HTTP API to actually accept connections before telling
        // the JS layer the node is running.  Without this, the UI immediately
        // makes API calls that hit ECONNREFUSED and shows spurious errors.
        waitForNodeApi()
        broadcastStatus(STATUS_RUNNING)
        updateNotification("Running — connected to 0x01 mesh")

        val exitCode = process.waitFor()
        logJob.cancel()
        Log.w(TAG, "zerox1-node exited with code $exitCode")
        nodeProcess = null
    }

    private fun prepareAgentBinary(): File {
        val binary = File(applicationInfo.nativeLibraryDir, "libzeroclaw.so")
        if (!binary.exists()) {
            throw IOException("Agent binary not found at ${binary.absolutePath} — rebuild APK with updated jniLibs")
        }
        Log.i(TAG, "Using agent binary: ${binary.absolutePath}")
        return binary
    }

    private fun getLlmApiKey(): String? {
        return try {
            securePrefs().getString(KEY_LLM_API_KEY, null)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to read API key from encrypted storage: $e")
            null
        }
    }

    /**
     * Escape a user-provided string for safe embedding inside a TOML basic string (double-quoted).
     * Replaces backslashes, double-quotes, and newline characters.
     */
    private fun escapeTOMLString(s: String): String =
        s.replace("\\", "\\\\")
         .replace("\"", "\\\"")
         .replace("\n", "\\n")
         .replace("\r", "\\r")

    /**
     * Write a TOML config file for ZeroClaw into filesDir, and install bundled skills.
     *
     * Skills are written to {filesDir}/zw/skills/<name>/SKILL.toml so that zeroclaw
     * discovers them via the workspace_dir setting.
     */
    private fun writeAgentConfig(
        provider:          String,
        customModel:       String,
        customBaseUrl:     String,
        capabilities:      String,
        minFee:            Double,
        minRep:            Int,
        autoAccept:        Boolean,
        maxActionsPerHour: Int = 100,
        maxCostPerDayCents: Int = 1000,
    ) {
        val modelMap = mapOf(
            "gemini"    to "gemini-2.5-flash",
            "anthropic" to "claude-haiku-4-5-20251001",
            "openai"    to "gpt-4o-mini",
            "groq"      to "llama-3.1-8b-instant",
        )
        val model = when {
            provider == "custom" && customModel.isNotBlank() -> customModel
            else -> modelMap[provider] ?: "gemini-2.5-flash"
        }

        // CRIT-4: Read API key from secure storage, not from intent.
        val apiKey = getLlmApiKey() ?: ""
        val escapedKey = escapeTOMLString(apiKey)
        // For "custom" provider, ZeroClaw uses "custom:<base_url>" syntax.
        // If the base URL is missing, preserve any existing "custom:..." provider
        // from config.toml rather than silently downgrading to another provider.
        val existingProvider: String? = try {
            File(filesDir, "config.toml").readLines()
                .firstOrNull { it.trimStart().startsWith("default_provider") }
                ?.substringAfter("=")?.trim()?.trim('"')
        } catch (_: Exception) { null }
        val effectiveProvider = when {
            provider == "custom" && customBaseUrl.isNotBlank() -> "custom:${customBaseUrl}"
            provider == "custom" && existingProvider?.startsWith("custom:") == true -> existingProvider
            else -> provider
        }
        val escapedProvider = escapeTOMLString(effectiveProvider)
        val localApiSecret = ensureSecureToken(KEY_NODE_API_SECRET)
        val gatewayToken = ensureSecureToken(KEY_GATEWAY_TOKEN, "zc_mobile_")
        val escapedNodeApiSecret = escapeTOMLString(localApiSecret)
        val escapedGatewayToken = escapeTOMLString(gatewayToken)

        // MED-1: Validate capabilities is a proper JSON array to prevent TOML injection.
        val tomlCaps = try {
            JSONArray(if (capabilities.isBlank()) "[]" else capabilities).toString()
        } catch (e: Exception) {
            Log.w(TAG, "Invalid capabilities JSON — using empty array")
            "[]"
        }

        // Zeroclaw workspace directory — skills are discovered from here.
        val workspaceDir = File(filesDir, "zw")
        workspaceDir.mkdirs()

        val config = """
# Top-level provider settings (no [llm] section — these are root keys)
default_provider    = "$escapedProvider"
api_key             = "$escapedKey"
default_model       = "$model"
default_temperature = 0.7

[gateway]
port            = $AGENT_GATEWAY_PORT
host            = "127.0.0.1"
require_pairing = true
paired_tokens   = ["$escapedGatewayToken"]

[channels_config]
cli = false

[channels_config.zerox1]
node_api_url    = "http://127.0.0.1:$NODE_API_PORT"
api_secret      = "$escapedNodeApiSecret"
min_fee_usdc    = $minFee
min_reputation  = $minRep
auto_accept     = $autoAccept
capabilities    = $tomlCaps
topics          = []

[autonomy]
level                  = "supervised"
workspace_only         = false
allowed_commands       = ["curl", "jq", "sh", "bash"]
forbidden_paths        = []
max_actions_per_hour   = $maxActionsPerHour
max_cost_per_day_cents = $maxCostPerDayCents
shell_env_passthrough  = ["ZX01_NODE", "ZX01_TOKEN"]

[memory]
backend    = "sqlite"
sqlite_path = "${escapeTOMLString(File(filesDir, "zw/memory.db").absolutePath)}"

[phone]
enabled      = true
bridge_url   = "http://127.0.0.1:$AGENT_BRIDGE_PORT"
secret       = "$bridgeSecret"
timeout_secs = 10
""".trimStart()

        File(filesDir, AGENT_CONFIG_FILE).writeText(config)
        Log.i(TAG, "ZeroClaw TOML config written (bridge secret obfuscated in logs).")

        // Write bundled skills into the workspace skills directory.
        writeBundledSkills(workspaceDir)
    }

    /**
     * Write bundled zeroclaw skill TOML files into the workspace skills directory.
     *
     * Each skill lives at {workspaceDir}/skills/<name>/SKILL.toml.
     * Skills are idempotent — written on every startup so they stay up to date.
     */
    private fun writeBundledSkills(workspaceDir: File) {
        val skillsRoot = File(workspaceDir, "skills")
        skillsRoot.mkdirs()

        // ── 0x01 mesh protocol skill ───────────────────────────────────────
        val meshSkillDir = File(skillsRoot, "zerox1-mesh")
        meshSkillDir.mkdirs()
        File(meshSkillDir, "SKILL.toml").writeText(ZEROX1_MESH_SKILL_TOML)

        // ── Bags token launch skill ─────────────────────────────────────────
        val bagsSkillDir = File(skillsRoot, "bags")
        bagsSkillDir.mkdirs()
        File(bagsSkillDir, "SKILL.toml").writeText(BAGS_SKILL_TOML)

        // ── Jupiter trading skill ───────────────────────────────────────────
        val tradeSkillDir = File(skillsRoot, "trade")
        tradeSkillDir.mkdirs()
        File(tradeSkillDir, "SKILL.toml").writeText(TRADE_SKILL_TOML)

        // ── Raydium LaunchLab bonding-curve skill ───────────────────────────
        val launchlabSkillDir = File(skillsRoot, "launchlab")
        launchlabSkillDir.mkdirs()
        File(launchlabSkillDir, "SKILL.toml").writeText(LAUNCHLAB_SKILL_TOML)

        // ── Raydium CPMM pool creation skill ────────────────────────────────
        val cpmmSkillDir = File(skillsRoot, "cpmm")
        cpmmSkillDir.mkdirs()
        File(cpmmSkillDir, "SKILL.toml").writeText(CPMM_SKILL_TOML)

        // ── Phone health & wearables skill ─────────────────────────────────
        val healthSkillDir = File(skillsRoot, "health")
        healthSkillDir.mkdirs()
        File(healthSkillDir, "SKILL.toml").writeText(HEALTH_SKILL_TOML)

        // ── Skill manager (dynamic installer) ──────────────────────────────
        val smSkillDir = File(skillsRoot, "skill_manager")
        smSkillDir.mkdirs()
        File(smSkillDir, "SKILL.toml").writeText(SKILL_MANAGER_TOML)

        // ── Web fetch + search skill ────────────────────────────────────────
        val webSkillDir = File(skillsRoot, "web")
        webSkillDir.mkdirs()
        File(webSkillDir, "SKILL.toml").writeText(WEB_SKILL_TOML)

        // ── Phone UI automation skill ────────────────────────────────────────
        val phoneUiSkillDir = File(skillsRoot, "phone-ui")
        phoneUiSkillDir.mkdirs()
        File(phoneUiSkillDir, "SKILL.toml").writeText(PHONE_UI_SKILL_TOML)

        Log.i(TAG, "Bundled skills written to ${skillsRoot.absolutePath}.")
    }

    /**
     * Write workspace/IDENTITY.md so ZeroClaw knows its Solana wallet address and
     * how to check balances via the node REST API (no Solana CLI on Android).
     *
     * Called once after the node API is confirmed ready, before launching zeroclaw.
     * Non-fatal: if the API calls fail the file is still written with what is known.
     */
    private suspend fun writeIdentityFile(workspaceDir: File, rpcUrl: String = "") = withContext(Dispatchers.IO) {
        val isMainnet = rpcUrl.contains("mainnet")
        val localApiSecret = loadSecureString(KEY_NODE_API_SECRET).orEmpty()
        if (localApiSecret.isEmpty()) {
            Log.w(TAG, "No API secret available — skipping IDENTITY.md write.")
            return@withContext
        }
        try {
            // ── Fetch agent identity ─────────────────────────────────────────
            var agentIdHex: String? = null
            var solanaAddress: String? = null
            try {
                val conn = java.net.URL("http://127.0.0.1:$NODE_API_PORT/identity")
                    .openConnection() as java.net.HttpURLConnection
                conn.setRequestProperty("Authorization", "Bearer $localApiSecret")
                conn.connectTimeout = 5_000
                conn.readTimeout    = 5_000
                if (conn.responseCode == 200) {
                    val body = conn.inputStream.bufferedReader().readText()
                    val hex  = JSONObject(body).optString("agent_id").takeIf { it.length == 64 }
                    if (hex != null) {
                        agentIdHex    = hex
                        val bytes     = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
                        solanaAddress = base58Encode(bytes)
                    }
                }
                conn.disconnect()
            } catch (e: Exception) {
                Log.w(TAG, "Could not fetch /identity for IDENTITY.md: $e")
            }

            // ── Fetch live balance ───────────────────────────────────────────
            var balanceLine = ""
            try {
                val conn = java.net.URL("http://127.0.0.1:$NODE_API_PORT/portfolio/balances")
                    .openConnection() as java.net.HttpURLConnection
                conn.setRequestProperty("Authorization", "Bearer $localApiSecret")
                conn.connectTimeout = 5_000
                conn.readTimeout    = 5_000
                if (conn.responseCode == 200) {
                    val body   = conn.inputStream.bufferedReader().readText()
                    val tokens = JSONObject(body).optJSONArray("tokens")
                    var solAmt = 0.0; var usdcAmt = 0.0
                    if (tokens != null) {
                        for (i in 0 until tokens.length()) {
                            val t      = tokens.getJSONObject(i)
                            val amount = t.optDouble("amount", 0.0)
                            when (t.optString("mint")) {
                                "So11111111111111111111111111111111111111112" -> solAmt  = amount
                                "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                                "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"  -> usdcAmt = amount
                            }
                        }
                    }
                    balanceLine = "\nCurrent hot wallet balance: ${"%.6f".format(solAmt)} SOL, ${"%.2f".format(usdcAmt)} USDC."
                }
                conn.disconnect()
            } catch (e: Exception) {
                Log.w(TAG, "Could not fetch /portfolio/balances for IDENTITY.md: $e")
            }

            // ── Read bridge capability toggles ───────────────────────────────
            val bridgePrefs = applicationContext.getSharedPreferences("zerox1_bridge", android.content.Context.MODE_PRIVATE)
            val allBridgeCaps = listOf(
                "notifications_read","notifications_reply","notifications_dismiss",
                "sms_read","sms_send",
                "contacts","location","calendar","media","motion",
                "camera","microphone","calls","health","wearables",
                "screen_read_tree","screen_capture","screen_act",
                "screen_global_nav","screen_vision","screen_autonomy",
            )
            val capLines = allBridgeCaps.joinToString("\n") { cap ->
                val enabled = bridgePrefs.getBoolean("bridge_cap_$cap", true)
                val status  = if (enabled) "enabled" else "disabled (user toggled off)"
                "- $cap: $status"
            }

            // ── Write IDENTITY.md ────────────────────────────────────────────
            val networkLabel = if (isMainnet) "Solana MAINNET" else "Solana devnet"
            val walletBlock = if (agentIdHex != null && solanaAddress != null) {
                "- Agent ID (hex): $agentIdHex\n- Solana wallet address (base58): $solanaAddress\n- Network: $networkLabel$balanceLine"
            } else {
                "Wallet identity will be available after the node fully starts."
            }
            val walletNetwork = if (isMainnet) "mainnet" else "devnet"
            val usdcMint = if (isMainnet)
                "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
            else
                "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

            val mainnetWarning = if (isMainnet) """

## ⚠ MAINNET — REAL MONEY
You are operating on Solana MAINNET. All transactions involve REAL funds.

- bags_launch, bags_claim, bags_positions → Bags.fm MAINNET (real SOL/USDC)
- Jupiter swaps → MAINNET (real tokens, real prices)
- Every transaction you sign costs real SOL in fees and moves real value
- There is NO undo. Failed or mistaken transactions lose real money.

Rules:
1. Always confirm the action and amounts with the user before signing any transaction.
2. Never send more than the user explicitly authorised.
3. If you are unsure about an action, ask first — do not proceed speculatively.
4. Double-check destination addresses before any transfer.
""" else ""

            val content = """
# Agent Identity

## Who you are
You are an autonomous AI agent on the 0x01 mesh network (zerox1).
You run as a background process on a mobile device.
You have a Solana hot wallet on $networkLabel used for task rewards, staking, and USDC payments on the mesh.
$mainnetWarning
## Your Wallet
- Network: $networkLabel
$walletBlock

## Checking Your Balance
IMPORTANT: The Solana CLI is NOT available on this device.
Do NOT attempt to run `solana balance`, `which solana`, or any `solana` CLI command — it will fail.

To check your balance, call the node REST API:
  GET http://127.0.0.1:$NODE_API_PORT/portfolio/balances
  Authorization: Bearer <value of ZX01_TOKEN env var>

Response format: {"tokens":[{"mint":"...","amount":1.5,"decimals":9}]}
- SOL mint:  So11111111111111111111111111111111111111112
- USDC mint ($walletNetwork): $usdcMint

In a shell tool:
  curl -s http://127.0.0.1:$NODE_API_PORT/portfolio/balances -H "Authorization: Bearer ${'$'}{ZX01_TOKEN:-}"

## Node API
Your local zerox1 node API: http://127.0.0.1:$NODE_API_PORT
Auth: Authorization: Bearer <ZX01_TOKEN> (already available as env var ZX01_TOKEN).

## Android Environment
You are running on an Android device as a background foreground service.
- No apt, brew, pip, or package managers are available.
- No Solana CLI (`solana`, `spl-token`) — use the Node API instead (see above).
- Available shell tools: curl, jq, sh, bash.
- File system: read/write access to the app's filesDir only.

## Phone Bridge (Android capabilities)
Your config file contains a [phone] section with bridge_url and secret.
The phone bridge is a local HTTP server on 127.0.0.1:$AGENT_BRIDGE_PORT that gives you
access to Android device APIs. Auth: `Authorization: Bearer <secret from config>`.

Capability status (user-controlled toggles):
$capLines

Available endpoints (all return {"ok":bool,"data":...} or {"ok":false,"error":"..."}):

### Contacts
- GET  /phone/contacts[?query=name]      — search/list contacts
- POST /phone/contacts                   — create contact {name,phone?,email?}
- PUT  /phone/contacts/:id               — update contact

### Messaging
- GET  /phone/sms[?box=inbox&limit=50&contact=X] — read SMS
- POST /phone/sms/send                   — send SMS {to, body}

### Location
- GET  /phone/location                   — GPS coordinates {lat,lng,accuracy,provider}

### Calendar
- GET  /phone/calendar[?days=7]          — upcoming events
- POST /phone/calendar                   — create event {title,start_ms,end_ms,description?}
- PUT  /phone/calendar/:id               — update event

### Camera
- POST /phone/camera/capture             — take photo {facing:"back"|"front"} → base64 JPEG

### Microphone / Audio
- POST /phone/audio/record               — record audio {duration_ms} → base64 WAV
- GET  /phone/audio/profile              — volume levels + DND mode
- POST /phone/audio/profile              — set volume/DND {stream?,volume?,dnd?}

### Notifications
- GET  /phone/notifications              — current active notifications
- GET  /phone/notifications/history      — recent notification history
- POST /phone/notifications/reply        — reply to a notification {key,reply}
- POST /phone/notifications/dismiss      — dismiss a notification {key}
- POST /phone/notify                     — post a system notification {title,body,channel?}

### Calls
- GET  /phone/call_log[?limit=50]        — call history
- GET  /phone/calls/pending              — incoming calls awaiting screening decision
- GET  /phone/calls/history             — recent screened calls
- POST /phone/calls/respond              — respond to screened call {id,action:"allow"|"reject"|"silence"}

### Screen / Accessibility
- GET  /phone/a11y/status               — accessibility service enabled?
- GET  /phone/a11y/tree                  — UI element tree of foreground app
- POST /phone/a11y/action               — perform action on element {nodeId,action}
- POST /phone/a11y/click                 — tap at coordinates {x,y}
- POST /phone/a11y/global               — global action {action:"back"|"home"|"recents"|"notifications"}
- GET  /phone/a11y/screenshot           — screenshot → base64 PNG
- POST /phone/a11y/vision               — screenshot + LLM vision analysis {prompt}

### Device / System
- GET  /phone/device      — device model, OS version, language, screen size
- GET  /phone/battery     — battery level, charging status
- GET  /phone/network     — connectivity type (wifi/cellular/none)
- GET  /phone/wifi        — SSID, signal strength, IP
- GET  /phone/carrier     — carrier name, MCC/MNC
- GET  /phone/bluetooth   — paired/nearby Bluetooth devices
- GET  /phone/timezone    — timezone + UTC offset
- GET  /phone/activity    — step count (today)
- GET  /phone/imu[?duration_ms=500]         — accelerometer/gyroscope snapshot
- POST /phone/imu/record  {duration_ms}      — record IMU stream
- POST /phone/vibrate     {pattern?}         — vibrate device
- POST /phone/clipboard   {text}             — write to clipboard
- POST /phone/alarm       {hour,minute,message?} — set alarm
- GET  /phone/app_usage[?days=7]             — per-app screen time
- GET  /phone/documents   — list files in Downloads/Documents
- GET  /phone/media/images[?limit=20]        — list recent photos (path+timestamp)
- GET  /phone/permissions — runtime permission grant status
- GET  /phone/activity_log[?limit=50]        — bridge audit log (recent calls)

IMPORTANT: If a capability is disabled (see status above), the endpoint returns
{"ok":false,"error":"CAPABILITY_DISABLED"}. Do not retry — ask the user to enable
the capability in the app Settings > Phone Bridge section instead.
""".trimStart()

            File(workspaceDir, "IDENTITY.md").writeText(content)
            Log.i(TAG, "IDENTITY.md written to workspace (address: ${solanaAddress ?: "unknown"}).")
        } catch (e: Exception) {
            Log.w(TAG, "writeIdentityFile failed: $e")
            // Non-fatal — zeroclaw starts without wallet identity context
        }
    }

    /**
     * Base58 encode using the Bitcoin/Solana alphabet (no checksum).
     * Used to derive the human-readable Solana wallet address from raw key bytes.
     */
    private fun base58Encode(input: ByteArray): String {
        val alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
        var value    = java.math.BigInteger(1, input)
        val base     = java.math.BigInteger.valueOf(58)
        val sb       = StringBuilder()
        while (value.signum() > 0) {
            val (q, r) = value.divideAndRemainder(base)
            sb.append(alphabet[r.toInt()])
            value = q
        }
        for (b in input) {
            if (b == 0.toByte()) sb.append(alphabet[0]) else break
        }
        return sb.reverse().toString()
    }

    /**
     * Poll the node REST API until it responds (max 30s), then return.
     * Ensures ZeroClaw doesn't start before the node is ready.
     *
     * Uses GET /hosted/ping — a no-auth public endpoint that returns {"ok":true}
     * as soon as the Axum HTTP server is accepting requests.  The previous
     * /peers endpoint required the API secret (401 without it), so this check
     * always timed out and ZeroClaw was always delayed by 30 seconds.
     */
    private suspend fun waitForNodeApi() = withContext(Dispatchers.IO) {
        val url = "http://127.0.0.1:$NODE_API_PORT/hosted/ping"
        repeat(30) {
            try {
                val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                conn.connectTimeout = 1_000
                conn.readTimeout    = 1_000
                val code = conn.responseCode
                conn.disconnect()
                if (code == 200) return@withContext
            } catch (_: Exception) { /* not ready yet */ }
            delay(1_000)
        }
        Log.w(TAG, "Node API not ready after 30s — starting ZeroClaw anyway.")
    }

    private suspend fun launchAgent(binary: File) = withContext(Dispatchers.IO) {
        val configDir = filesDir.absolutePath
        val cmd = listOf(binary.absolutePath, "--config-dir", configDir, "daemon")
        Log.i(TAG, "Launching zeroclaw: ${cmd.joinToString(" ")}")

        val workspacePath = File(filesDir, "zw").absolutePath
        val localApiSecret = loadSecureString(KEY_NODE_API_SECRET).orEmpty()
        val process = ProcessBuilder(cmd)
            .redirectErrorStream(true)
            .also {
                // ZeroClaw uses the HOME env var to locate its config directory.
                // Android doesn't set HOME, so point it at filesDir so that
                // "~/.config" and similar paths resolve inside the app's sandbox.
                it.environment()["HOME"] = filesDir.absolutePath
                it.environment()["ZEROCLAW_WORKSPACE"] = workspacePath
                it.environment()["ZX01_WORKSPACE"] = workspacePath  // used by skill shell commands
                it.environment()["ZX01_NODE"] = "http://127.0.0.1:$NODE_API_PORT"
                if (localApiSecret.isNotEmpty()) {
                    it.environment()["ZX01_TOKEN"] = localApiSecret
                }
                it.environment()["ZX01_BRIDGE_URL"] = "http://127.0.0.1:$AGENT_BRIDGE_PORT"
                if (bridgeSecret.isNotEmpty()) {
                    it.environment()["ZX01_BRIDGE_TOKEN"] = bridgeSecret
                }
            }
            .start()

        agentProcess = process

        // Register zeroclaw PID with the node so POST /agent/reload can SIGTERM it.
        try {
            val pid = extractProcessPid(process)
            if (pid != null && pid > 0) {
                val body = "{\"pid\":$pid}"
                val conn = java.net.URL("http://127.0.0.1:$NODE_API_PORT/agent/register-pid")
                    .openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Authorization", "Bearer $localApiSecret")
                conn.doOutput = true
                conn.outputStream.write(body.toByteArray())
                conn.responseCode // send request
                conn.disconnect()
                Log.i(TAG, "Registered zeroclaw PID $pid with node.")
            } else {
                Log.w(TAG, "Could not determine zeroclaw PID; skipping /agent/register-pid.")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not register zeroclaw PID: $e")
        }

        // Pipe zeroclaw output to logcat (always, for diagnostics)
        launch {
            process.inputStream.bufferedReader().useLines { lines ->
                lines.forEach { line ->
                    Log.i(TAG, "[zeroclaw] $line")
                }
            }
        }

        val exitCode = process.waitFor()
        Log.w(TAG, "zeroclaw exited with code $exitCode")
        // Non-fatal: agent exits alone, node keeps running
    }

    // -------------------------------------------------------------------------
    // Notification
    // -------------------------------------------------------------------------

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "0x01 Node",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Keeps your 0x01 mesh node running in the background"
        }
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(status: String): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pi = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("0x01 Node")
            .setContentText(status)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(status: String) {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, buildNotification(status))
    }

    // -------------------------------------------------------------------------
    // Status broadcast (picked up by NodeModule via BroadcastReceiver)
    // -------------------------------------------------------------------------

    private fun broadcastStatus(status: String, detail: String = "") {
        sendBroadcast(Intent(ACTION_STATUS).apply {
            putExtra("status", status)
            putExtra("detail", detail)
        })
    }

    // -------------------------------------------------------------------------
    // Distribution-aware capability defaults
    // -------------------------------------------------------------------------

    /**
     * Set capability defaults in SharedPreferences based on the build flavor.
     *
     * This runs on every start but only writes if the stored distribution tag
     * doesn't match the current one — so switching APKs (e.g. from dappstore
     * to full) re-applies the correct defaults.  Users can still override
     * individual caps in Settings after defaults are applied.
     *
     * Capability matrix:
     *
     * | Capability  | full | dappstore | googleplay |
     * |-------------|------|-----------|------------|
     * | messaging   |  on  |    on     |    on      |
     * | contacts    |  on  |    on     |    on      |
     * | location    |  on  |    on     |    on      |
     * | calendar    |  on  |    on     |    on      |
     * | media       |  on  |    on     |    on      |
     * | camera      |  on  |    on     |    OFF     |
     * | microphone  |  on  |    on     |    OFF     |
     * | calls       |  on  |    OFF    |    OFF     |
     * | screen      |  on  |    OFF    |    OFF     |
     * | wearables   |  on  |    OFF    |    on      | (dappstore strips BT; Play allows with neverForLocation)
     */
    private fun applyDistributionCapabilityDefaults() {
        val prefs = applicationContext.getSharedPreferences("zerox1_bridge", android.content.Context.MODE_PRIVATE)
        val dist  = BuildConfig.DISTRIBUTION
        if (prefs.getString("bridge_dist_initialized", "") == dist) return

        val editor = prefs.edit()
        when (dist) {
            "googleplay" -> {
                // A/V capture — Play policy requires explicit justification
                editor.putBoolean("bridge_cap_camera",                false)
                editor.putBoolean("bridge_cap_microphone",            false)
                // Call screening — removed from Play manifest
                editor.putBoolean("bridge_cap_calls",                 false)
                // Notification listener — keep off until policy review approves it
                editor.putBoolean("bridge_cap_notifications_reply",   false)
                editor.putBoolean("bridge_cap_notifications_dismiss", false)
                // SMS send — higher-risk action; read is left on
                editor.putBoolean("bridge_cap_sms_send",              false)
                // Screen control — all off; ASSISTED mode ships Path 1 (no accessibility service)
                editor.putBoolean("bridge_cap_screen_read_tree",      false)
                editor.putBoolean("bridge_cap_screen_capture",        false)
                editor.putBoolean("bridge_cap_screen_act",            false)
                editor.putBoolean("bridge_cap_screen_global_nav",     false)
                editor.putBoolean("bridge_cap_screen_vision",         false)
                editor.putBoolean("bridge_cap_screen_autonomy",       false)
                // wearables: ON — BLUETOOTH_SCAN with neverForLocation is Play-approved
                // notifications_read/sms_read/contacts/location/calendar/media: leave at default (true)
            }
            "dappstore" -> {
                // Call screening — removed from dappstore manifest
                editor.putBoolean("bridge_cap_calls",                 false)
                editor.putBoolean("bridge_cap_wearables",             false)
                // Screen control — off by default; user can enable if they enable the service
                editor.putBoolean("bridge_cap_screen_read_tree",      false)
                editor.putBoolean("bridge_cap_screen_capture",        false)
                editor.putBoolean("bridge_cap_screen_act",            false)
                editor.putBoolean("bridge_cap_screen_global_nav",     false)
                editor.putBoolean("bridge_cap_screen_vision",         false)
                editor.putBoolean("bridge_cap_screen_autonomy",       false)
                // camera/microphone/notifications/sms/contacts/location/calendar/media: default (true)
            }
            else -> {
                // "full" — all capabilities on by default; no overrides needed
            }
        }
        editor.putString("bridge_dist_initialized", dist)
        editor.apply()
        Log.i(TAG, "Phone bridge capability defaults applied for distribution=$dist")
    }
}
