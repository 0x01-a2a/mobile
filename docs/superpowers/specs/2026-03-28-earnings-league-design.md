# Earnings League Design

**Goal:** Surface agent trading-fee earnings as a leaderboard in Today.tsx to encourage mesh activity, reusing the existing `/league/current` backend with SKR gating removed.

**Architecture:** One backend patch (remove SKR gate, update copy) + one UI addition (Today.tsx section + modal). No new endpoints, no new hooks, no new files.

**Tech Stack:** Rust/Axum (aggregator), React Native (Today.tsx), existing `useSkrLeague` hook.

---

## Backend (`zerox1-aggregator/src/api.rs`)

### Changes to `get_skr_league`

Remove the SKR balance access gate entirely. The leaderboard is always public — no minimum balance required, no `has_access` check, no SKR-specific messaging.

The `wallet` view (your own position) still works without the gate: it shows your rank, earn rate, trade count, and active days. The `access_message` field is repurposed to show your earnings summary if ranked, or "Link a wallet in You → Settings to see your rank." if no wallet is linked.

Fields to update in `SkrLeagueResponse`:
- `title`: `"SKR League"` → `"Earnings League"`
- `scoring`: rewrite to describe fee-income ranking (earn rate from Jupiter/Raydium/Bags swaps executed by your agent)
- `rewards`: keep the tier structure (1st/2nd/3rd/Top 10) but update prize copy to be SKR-agnostic if needed — or keep SKR prizes as-is (they're still valid incentive)
- `min_skr`, `reward_pool_skr`: keep fields in response (harmless), UI ignores them

The `SkrLeagueEntry.label` field is already populated with the agent name via `get_agents_by_owner` — no change needed there.

### What does NOT change

- The fee-income computation (`compute_wallet_league_entry`) — unchanged
- The caching logic (`load_or_compute_league`) — unchanged
- The wallet→agent name join — unchanged
- The `SkrLeagueWalletView` struct — unchanged
- The `?wallet=` query param — unchanged

---

## Mobile (`src/screens/Today.tsx`)

### New "EARNINGS LEAGUE" section

Added below the existing "RECENT JOBS" section, separated by a `sectionDivider`. Only renders when `data` is non-null (silently absent on error or loading).

**Preview row (inline, always visible):**
```
EARNINGS LEAGUE                        Season ends in 12d
#1  Aria          +8.4%
#2  Nexus         +6.1%
#3  Bolt          +5.2%
#4  ZeroAgent     +4.8%
#5  Owner a1b2c3  +3.9%        ← fallback label if no agent name
[→ See all 25 agents]
```

- Each row: rank number + agent name (from `entry.label`) + earn rate (`+X.X%`)
- Your agent's row highlighted with green text if `data.wallet.rank` is in 1–5, otherwise a separate "You: #N" row appended below the top-5
- Season countdown: `ends_at` (unix timestamp) → days remaining, shown as subtitle next to section label
- "→ See all" is a tappable row that opens the detail modal

**Detail modal (bottom sheet):**

Full-screen modal (`animationType="slide"`) showing:
1. Header: "EARNINGS LEAGUE · {data.season}" + close button
2. Rewards section: the `data.rewards` strings (e.g. "1st: 1,500 SKR")
3. Scoring section: the `data.scoring` strings
4. Full leaderboard: all `data.leaderboard` entries, same row format as preview, your rank highlighted
5. Your stats footer (if wallet linked): earn rate, trade count, active days from `data.wallet`

**Error/loading behaviour:**
- If `loading` and `data` is null: section not rendered
- If `error` and `data` is null: section not rendered (silent, matches Today.tsx pattern)
- If `data` is stale (error on refresh but previous data exists): show stale data — user sees last known leaderboard

---

## Styling

Follows existing Today.tsx conventions:
- Section label: `fontSize: 10, color: '#9ca3af', letterSpacing: 0.5`
- Row text: `fontSize: 12, color: '#111', fontWeight: '500'`
- Earn rate: `fontSize: 12, color: '#22c55e', fontWeight: '600'` (green, same as job earnings)
- Your row highlight: green text + subtle `backgroundColor: '#f0fdf4'`
- Rank number: `fontSize: 11, color: '#9ca3af', width: 20`
- Modal background: `#fff`, handle bar at top

---

## Testing

The existing `You.test.tsx` mock already stubs `useSkrLeague` if needed. A focused test for the league section:
- Renders top-5 entries from mock data
- Hides section when data is null
- Highlights own rank row when `data.wallet.rank` matches an entry
- "See all" opens modal with full leaderboard
