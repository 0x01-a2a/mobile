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
        const val ASSET_VERSION    = "0.3.4"   // bump when binary changes

        // ZeroClaw agent brain binary
        const val AGENT_BINARY_NAME    = "zeroclaw"
        const val AGENT_ASSET_VERSION  = "0.1.13"   // bump when zeroclaw binary changes
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

        // Intent extras — ZeroClaw brain
        const val EXTRA_BRAIN_ENABLED  = "brain_enabled"
        const val EXTRA_LLM_PROVIDER   = "llm_provider"
        const val EXTRA_LLM_MODEL      = "llm_model"         // custom model override
        const val EXTRA_LLM_BASE_URL   = "llm_base_url"     // custom base URL (OpenAI-compat)
        const val EXTRA_CAPABILITIES   = "capabilities"      // JSON array string
        const val EXTRA_MIN_FEE        = "min_fee_usdc"
        const val EXTRA_MIN_REP        = "min_reputation"
        const val EXTRA_AUTO_ACCEPT    = "auto_accept"

        // Broadcast action so NodeModule can observe state changes
        const val ACTION_STATUS     = "world.zerox1.01pilot.STATUS"
        const val STATUS_RUNNING    = "running"
        const val STATUS_STOPPED    = "stopped"
        const val STATUS_ERROR      = "error"

        // ── Bundled zeroclaw skill definitions ──────────────────────────────
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
version     = "1.0.0"
description = "Trade any token on Solana via Jupiter — swap, price check, token search, limit orders, and DCA."
author      = "0x01 World"
tags        = ["jupiter", "swap", "trading", "defi", "solana", "limit-orders", "dca"]

prompts = [${'$'}TOML_TQ
# Jupiter Trading

You can trade any Solana token directly from this agent using Jupiter's routing.

## Capabilities

1. **Swap** — trade_swap executes a market swap instantly. One-shot: quote + sign + broadcast.
2. **Quote** — trade_quote checks the expected output before committing.
3. **Price** — trade_price looks up current USD price for any token by mint address.
4. **Token search** — trade_tokens finds a token mint by name or symbol.
5. **Limit orders** — trade_limit_create places a buy/sell at a target price.
   trade_limit_orders lists open orders. trade_limit_cancel cancels them.
6. **DCA** — trade_dca_create sets up recurring buys at a fixed interval.

## Amount conventions

- SOL amounts: lamports (1 SOL = 1_000_000_000)
- USDC amounts: micro-USDC (1 USDC = 1_000_000)
- Use trade_price or trade_quote to calculate amounts before swapping.

## Rules

- Always confirm trade details (token, amount, expected output) with the user before executing.
- Use trade_quote or trade_price first so the user knows what they're getting.
- For limit orders, confirm the target price and expiry before placing.
- For DCA, confirm total amount, per-cycle amount, and interval before creating.
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
        val bagsFeeBps   = if (intent?.hasExtra(EXTRA_BAGS_FEE_BPS) == true)
                               intent.getIntExtra(EXTRA_BAGS_FEE_BPS, 0) else 0
        val bagsWallet   = intent?.getStringExtra(EXTRA_BAGS_WALLET)
        val bagsApiKey   = intent?.getStringExtra(EXTRA_BAGS_API_KEY)
            ?.takeIf { it.isNotBlank() }
            ?: BuildConfig.DEFAULT_BAGS_API_KEY.takeIf { it.isNotBlank() }
        val bagsPartnerKey = intent?.getStringExtra(EXTRA_BAGS_PARTNER_KEY)
            ?.takeIf { it.isNotBlank() }
            ?: BuildConfig.DEFAULT_BAGS_PARTNER_KEY.takeIf { it.isNotBlank() }
        val brainEnabled   = intent?.getBooleanExtra(EXTRA_BRAIN_ENABLED, false) ?: false
        val llmProvider    = intent?.getStringExtra(EXTRA_LLM_PROVIDER) ?: "gemini"
        val llmModel       = intent?.getStringExtra(EXTRA_LLM_MODEL) ?: ""
        val llmBaseUrl     = intent?.getStringExtra(EXTRA_LLM_BASE_URL) ?: ""
        Log.i(TAG, "Brain config: enabled=$brainEnabled provider=$llmProvider model=$llmModel baseUrl=${if (llmBaseUrl.isNotBlank()) "[set]" else "[empty]"}")
        val capabilities   = intent?.getStringExtra(EXTRA_CAPABILITIES) ?: "[]"
        val minFee       = intent?.getDoubleExtra(EXTRA_MIN_FEE, 0.01) ?: 0.01
        val minRep       = intent?.getIntExtra(EXTRA_MIN_REP, 50) ?: 50
        val autoAccept   = intent?.getBooleanExtra(EXTRA_AUTO_ACCEPT, true) ?: true

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
                launchNodeIterative(binary, relayAddr, fcmToken, agentName, rpcUrl, bagsFeeBps, bagsWallet, bagsApiKey, bagsPartnerKey)
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
                    writeAgentConfig(llmProvider, llmModel, llmBaseUrl, capabilities, minFee, minRep, autoAccept)
                    writeIdentityFile(File(filesDir, "zw"), rpcUrl)
                    // Restart loop — zeroclaw is SIGTERM'd by /agent/reload to pick up new skills.
                    // After exit it must restart so the new skills are active.
                    while (isActive) {
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
        bagsFeeBps:  Int,
        bagsWallet:  String?,
        bagsApiKey:  String?,
        bagsPartnerKey: String?,
    ) {
        while (coroutineContext.isActive) {
            launchNode(binary, relayAddr, fcmToken, agentName, rpcUrl, bagsFeeBps, bagsWallet, bagsApiKey, bagsPartnerKey)
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
        bagsFeeBps:  Int,
        bagsWallet:  String?,
        bagsApiKey:  String?,
        bagsPartnerKey: String?,
    ) = withContext(Dispatchers.IO) {
        val logDir      = File(filesDir, "logs").also { it.mkdirs() }
        File(filesDir, "zw").mkdirs()   // skill workspace must exist before node starts
        val keypairPath = File(filesDir, "zerox1-identity.key")
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
            "--aggregator-url", aggregatorUrl,
            // --relay-server is a boolean flag; omit it (default is false)
        )

        relayAddr?.let { cmd += listOf("--relay-addr", it) }
        fcmToken?.let  { cmd += listOf("--fcm-token",  it) }
        if (bagsFeeBps > 0) {
            cmd += listOf("--bags-fee-bps", bagsFeeBps.toString())
            bagsWallet?.let { cmd += listOf("--bags-wallet", it) }
        }
        bagsApiKey?.let { cmd += listOf("--bags-api-key", it) }
        bagsPartnerKey?.let { cmd += listOf("--bags-partner-key", it) }

        // Skill workspace — enables the skill manager REST endpoints on the node.
        cmd += listOf("--skill-workspace", File(filesDir, "zw").absolutePath)

        // Redact sensitive flags before logging.
        val safeCmd = cmd.toMutableList().also { list ->
            for (flag in listOf("--bags-api-key", "--bags-partner-key", "--api-secret", "--fcm-token")) {
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
        provider:     String,
        customModel:  String,
        customBaseUrl: String,
        capabilities: String,
        minFee:       Double,
        minRep:       Int,
        autoAccept:   Boolean,
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
token           = "$escapedNodeApiSecret"
min_fee_usdc    = $minFee
min_reputation  = $minRep
auto_accept     = $autoAccept
capabilities    = $tomlCaps

[autonomy]
level                  = "supervised"
workspace_only         = false
allowed_commands       = ["curl", "jq", "sh", "bash"]
forbidden_paths        = []
max_actions_per_hour   = 100
max_cost_per_day_cents = 1000
shell_env_passthrough  = ["ZX01_NODE", "ZX01_TOKEN"]

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

        // ── Bags token launch skill ─────────────────────────────────────────
        val bagsSkillDir = File(skillsRoot, "bags")
        bagsSkillDir.mkdirs()
        File(bagsSkillDir, "SKILL.toml").writeText(BAGS_SKILL_TOML)

        // ── Jupiter trading skill ───────────────────────────────────────────
        val tradeSkillDir = File(skillsRoot, "trade")
        tradeSkillDir.mkdirs()
        File(tradeSkillDir, "SKILL.toml").writeText(TRADE_SKILL_TOML)

        // ── Skill manager (dynamic installer) ──────────────────────────────
        val smSkillDir = File(skillsRoot, "skill_manager")
        smSkillDir.mkdirs()
        File(smSkillDir, "SKILL.toml").writeText(SKILL_MANAGER_TOML)

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
            val allBridgeCaps = listOf("messaging","contacts","location","camera","microphone","screen","calls","calendar","media")
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
     */
    private fun applyDistributionCapabilityDefaults() {
        val prefs = applicationContext.getSharedPreferences("zerox1_bridge", android.content.Context.MODE_PRIVATE)
        val dist  = BuildConfig.DISTRIBUTION
        if (prefs.getString("bridge_dist_initialized", "") == dist) return

        val editor = prefs.edit()
        when (dist) {
            "googleplay" -> {
                editor.putBoolean("bridge_cap_camera",      false)
                editor.putBoolean("bridge_cap_microphone",  false)
                editor.putBoolean("bridge_cap_calls",       false)
                editor.putBoolean("bridge_cap_screen",      false)
                // messaging/contacts/location/calendar/media: leave at default (true)
            }
            "dappstore" -> {
                editor.putBoolean("bridge_cap_calls",       false)
                editor.putBoolean("bridge_cap_screen",      false)
                // camera/microphone/messaging/contacts/location/calendar/media: leave at default (true)
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
