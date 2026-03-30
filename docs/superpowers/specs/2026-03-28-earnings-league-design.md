# Earnings League Design

**Goal:** Surface agent trading-fee earnings as a leaderboard in Today.tsx to encourage mesh activity, reusing the existing `/league/current` backend with SKR gating removed.

**Architecture:** One backend patch (remove SKR gate, update copy) + one UI addition (Today.tsx section + bottom-sheet modal). No new endpoints, no new hooks, no new files.

**Tech Stack:** Rust/Axum (aggregator), React Native (Today.tsx), existing `useSkrLeague` hook.

---

## Backend (`zerox1-aggregator/src/api.rs`)

### Changes to `get_skr_league`

Remove the SKR balance access gate entirely. The leaderboard is always public — no minimum balance required, no `has_access` check, no SKR-specific messaging.

The `wallet` view (your own position) still works without the gate: it shows your rank, earn rate, trade count, and active days. The `access_message` field is repurposed:
- If wallet linked and ranked: show earnings summary (existing format string, already correct)
- If wallet linked but not ranked: `"Your agent hasn't completed any eligible trades this season yet."`
- If no wallet linked: `"Link a wallet in You → Wallet to see your rank."`

Fields to update in `SkrLeagueResponse`:
- `title`: `"SKR League"` → `"Earnings League"`
- `scoring`: replace with:
  ```
  ["Ranked by seasonal fee earn rate — SOL income from swaps your agent executed",
   "Eligible activity: Jupiter, Raydium, and Bags swaps only",
   "Earn rate = fee income ÷ total volume traded this season",
   "Bags launch fees count as tiebreaker after earn rate"]
  ```
- `rewards`: keep existing tier structure unchanged (prizes are still valid)
- `min_skr`, `reward_pool_skr`: keep fields in response (harmless); UI ignores them

The `SkrLeagueEntry.label` field is already populated with the agent name via `get_agents_by_owner` — no change needed.

### What does NOT change

- The fee-income computation (`compute_wallet_league_entry`) — unchanged
- The caching logic (`load_or_compute_league`) — unchanged
- The wallet→agent name join — unchanged
- The `SkrLeagueWalletView` struct — unchanged
- The `?wallet=` query param — unchanged

---

## Mobile (`src/screens/Today.tsx`)

### Data format note

`SkrLeagueEntry.earn_rate_pct` is stored as a plain percentage value (e.g. `8.4` means 8.4%). Display format: prefix with `+`, suffix with `%`, one decimal place. Example: `earn_rate_pct = 8.4` → `"+8.4%"`.

### Season countdown

`data.ends_at` is a Unix timestamp (seconds). Compute days remaining as `Math.ceil((ends_at * 1000 - Date.now()) / 86_400_000)`. Display:
- ≥ 2 days: `"Season ends in Xd"`
- 1 day: `"Season ends tomorrow"`
- < 1 day (same day): `"Season ends today"`
- Past: `"Season ended"` (hide countdown)

### New "EARNINGS LEAGUE" section

Added below the existing "RECENT JOBS" section, separated by a `sectionDivider`. Only renders when `data !== null` (silently absent while loading or on error with no stale data).

**Section header row:**
```
EARNINGS LEAGUE          Season ends in 12d
```
Label (`sectionLabel` style) left-aligned; countdown subtitle right-aligned (`fontSize: 10, color: '#9ca3af'`).

**Top-5 preview rows:**
```
#1  Aria          +8.4%
#2  Nexus         +6.1%
#3  Bolt          +5.2%
#4  ZeroAgent     +4.8%
#5  Owner a1b2c3  +3.9%
```
Each row:
- Rank: `fontSize: 11, color: '#9ca3af', width: 20` (left)
- Agent name (`entry.label`): `fontSize: 12, color: '#111', fontWeight: '500'` (flex: 1)
- Earn rate: `fontSize: 12, color: '#22c55e', fontWeight: '600'` (right)

**Your rank highlight logic (three cases):**
1. `data.wallet.rank` is 1–5: highlight that row with `backgroundColor: '#f0fdf4'` and green name text
2. `data.wallet.rank` is 6+: append a separate `"You · #N  +X.X%"` row below the top-5, with `color: '#22c55e'` and a top border
3. `data.wallet.rank` is `null` OR no wallet linked: no highlight, no extra row

**"See all" tap target:**
A dedicated full-width `TouchableOpacity` row directly below the top-5 (or your rank row if shown), above the next `sectionDivider`. Styled as: `fontSize: 11, color: '#6b7280'`, text `"→ See all agents"`, `paddingVertical: 10`. Tapping opens the bottom-sheet modal.

**Stale data behaviour:** If `error` fires on a refresh but `data` is non-null from a previous successful load, continue showing the existing data. No error state shown.

### Bottom-sheet modal

`<Modal animationType="slide" presentationStyle="pageSheet">` — this renders as a bottom sheet on iOS and a slide-up modal on Android. NOT full-screen.

Contents (top to bottom):
1. Handle bar: 32×4 rounded rect, `backgroundColor: '#e5e7eb'`, centered, `marginTop: 8, marginBottom: 16`
2. Header: `"EARNINGS LEAGUE · {data.season}"` + close `✕` button (right-aligned)
3. Rewards section (`REWARDS` label + `data.rewards` strings as plain rows)
4. Scoring section (`HOW IT WORKS` label + `data.scoring` strings as plain rows)
5. Divider
6. Full leaderboard: all `data.leaderboard` entries in a `ScrollView`, same row format as preview. Highlight rule in the modal is simpler than in the preview — since all entries are present, always highlight the matching row in-list (no appended row needed): if `data.wallet.rank` is a non-null integer ≥ 1 and matches `entry.rank`, apply `backgroundColor: '#f0fdf4'` and green name text to that row. No appended "You" row in the modal.
7. Footer (if wallet linked and `data.wallet.rank !== null && data.wallet.rank >= 1`): your stats from `data.wallet` — earn rate, trade count, active days in a 3-column stat row

---

## Testing (`src/screens/__tests__/Today.test.tsx`)

The existing `Today.test.tsx` mocks `useNodeApi` but only stubs `useTaskLog`. After this change, Today.tsx will also import `useSkrLeague`, so the mock must be extended:

```typescript
jest.mock('../../hooks/useNodeApi', () => ({
  useTaskLog: () => ({ entries: [], loading: false, reload: jest.fn() }),
  useSkrLeague: () => ({
    data: null,
    loading: false,
    error: null,
    refresh: jest.fn(),
  }),
}));
```

Add a describe block `'TodayScreen — Earnings League'`:
- Renders without league section when `data` is null (default mock above)
- Renders top-5 rows when `data` has leaderboard entries
- Highlights own rank row when `data.wallet.rank` is 1–5
- Appends "You · #N" row when `data.wallet.rank` is 6+
- No highlight when `data.wallet.rank` is null
- "See all" row is present and tapping it shows the modal
