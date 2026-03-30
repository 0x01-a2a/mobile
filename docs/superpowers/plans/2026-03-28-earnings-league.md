# Earnings League Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the SKR balance gate from the aggregator league endpoint and add an Earnings League leaderboard section (+ bottom-sheet modal) to Today.tsx.

**Architecture:** Two tasks in sequence — backend patch first (aggregator, Rust), then mobile UI (Today.tsx, React Native). The `useSkrLeague` hook already exists and requires no changes. No new files.

**Tech Stack:** Rust/Axum (`zerox1-aggregator`), React Native 0.84.1 (`Today.tsx`), Jest/RNTL (`Today.test.tsx`).

---

### Task 1: Remove SKR gate from aggregator `get_skr_league`

**Files:**
- Modify: `node/crates/zerox1-aggregator/src/api.rs`

The SKR balance gate lives in two places: the outer `get_skr_league` handler and the inner `compute_wallet_league_entry` helper. Both must be patched.

- [ ] **Step 1: Update the `wallet_view` initialiser in `get_skr_league`**

Find (inside `get_skr_league`, after `load_or_compute_league`):

```rust
    let mut wallet_view = SkrLeagueWalletView {
        wallet: params.wallet.clone(),
        skr_balance: 0.0,
        has_access: false,
        rank: None,
        earn_rate_pct: 0.0,
        bags_fee_score: 0.0,
        points: 0,
        trade_count: 0,
        active_days: 0,
        access_message: "Link a Phantom wallet to enter the SKR League.".to_string(),
    };
```

Replace with:

```rust
    let mut wallet_view = SkrLeagueWalletView {
        wallet: params.wallet.clone(),
        skr_balance: 0.0,
        has_access: true,
        rank: None,
        earn_rate_pct: 0.0,
        bags_fee_score: 0.0,
        points: 0,
        trade_count: 0,
        active_days: 0,
        access_message: "Link a wallet in You → Wallet to see your rank.".to_string(),
    };
```

- [ ] **Step 2: Replace the wallet branch in `get_skr_league` — remove outer SKR balance check**

Find the entire `if let Some(wallet) = params.wallet.as_deref() { match fetch_skr_balance(...) ... }` block and replace it with:

```rust
    if let Some(wallet) = params.wallet.as_deref() {
        let cached_entry = {
            state
                .skr_league_cache
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|cache| {
                    cache
                        .rows
                        .iter()
                        .find(|entry| entry.wallet.eq_ignore_ascii_case(wallet))
                        .cloned()
                })
        };
        if let Some(entry) = cached_entry {
            wallet_view.rank = Some(entry.rank);
            wallet_view.earn_rate_pct = entry.earn_rate_pct;
            wallet_view.bags_fee_score = entry.bags_fee_score;
            wallet_view.points = entry.points;
            wallet_view.trade_count = entry.trade_count;
            wallet_view.active_days = entry.active_days;
            wallet_view.access_message = format!(
                "{:+.2}% swap earn rate and {:.4} SOL in claimed Bags fees this season across {} eligible trade{} on {} active day{}.",
                wallet_view.earn_rate_pct,
                wallet_view.bags_fee_score,
                wallet_view.trade_count,
                if wallet_view.trade_count == 1 { "" } else { "s" },
                wallet_view.active_days,
                if wallet_view.active_days == 1 { "" } else { "s" },
            );
        } else if let Ok(Some(entry)) = compute_wallet_league_entry(&state, wallet).await {
            // rank stays None — compute_wallet_league_entry does not scan the full leaderboard
            wallet_view.earn_rate_pct = entry.earn_rate_pct;
            wallet_view.bags_fee_score = entry.bags_fee_score;
            wallet_view.points = entry.points;
            wallet_view.trade_count = entry.trade_count;
            wallet_view.active_days = entry.active_days;
            wallet_view.access_message = format!(
                "{:+.2}% swap earn rate this season across {} eligible trade{}.",
                wallet_view.earn_rate_pct,
                wallet_view.trade_count,
                if wallet_view.trade_count == 1 { "" } else { "s" },
            );
        } else {
            wallet_view.access_message =
                "Your agent hasn't completed any eligible trades this season yet.".to_string();
        }
    }
```

- [ ] **Step 3: Remove inner SKR gate from `compute_wallet_league_entry`**

`compute_wallet_league_entry` also calls `fetch_skr_balance` and returns `Ok(None)` early if the balance is below `SKR_MIN_ACCESS`. The `balance` variable is still needed for the earn-rate calculation, so only remove the early-return guard.

Find (inside `compute_wallet_league_entry`, after `let balance = fetch_skr_balance(...)`):

```rust
    let balance = fetch_skr_balance(&state.http_client, wallet).await?;
    if balance < SKR_MIN_ACCESS {
        return Ok(None);
    }
```

Replace with:

```rust
    let balance = fetch_skr_balance(&state.http_client, wallet).await?;
```

- [ ] **Step 4: Update `title` and `scoring` in `SkrLeagueResponse`**

Find:

```rust
    let response = SkrLeagueResponse {
        title: "SKR League".to_string(),
```

Replace with:

```rust
    let response = SkrLeagueResponse {
        title: "Earnings League".to_string(),
```

Then find the `scoring: vec![...]` block:

```rust
        scoring: vec![
            "Ranked by seasonal SKR earn rate percentage, not raw profit".to_string(),
            "Bags contributes via claimed launch fees only, not wallet PnL".to_string(),
            "Eligible activity is limited to embedded trade rails: Jupiter, Raydium, and Bags".to_string(),
            "Claimed Bags fees and activity score are tiebreakers after earn rate".to_string(),
        ],
```

Replace with:

```rust
        scoring: vec![
            "Ranked by seasonal fee earn rate — SOL income from swaps your agent executed".to_string(),
            "Eligible activity: Jupiter, Raydium, and Bags swaps only".to_string(),
            "Earn rate = fee income ÷ total volume traded this season".to_string(),
            "Bags launch fees count as tiebreaker after earn rate".to_string(),
        ],
```

- [ ] **Step 5: Verify it compiles**

```bash
cd /Users/tobiasd/Desktop/zerox1/node
cargo check -p zerox1-aggregator
```

Expected: no errors. Rust may warn about unused imports if `SKR_MIN_ACCESS` is now only referenced inside `load_or_compute_league` — that is fine.

- [ ] **Step 6: Commit**

```bash
cd /Users/tobiasd/Desktop/zerox1/node
git add crates/zerox1-aggregator/src/api.rs
git commit -m "feat: earnings league — remove SKR gate, update copy"
```

---

### Task 2: Update Today.test.tsx — extend mock and add league tests

**Files:**
- Modify: `mobile/src/screens/__tests__/Today.test.tsx`

**Important:** `jest.mock` is hoisted before any user code runs. That means a `let mockLeagueData` declaration would be in a temporal dead zone when the factory executes. The fix is to capture the data on a plain object (`mockLeagueState`) instead — the factory closes over the object reference (always available), not the property value.

- [ ] **Step 1: Replace the entire test file**

```typescript
// src/screens/__tests__/Today.test.tsx
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import TodayScreen from '../Today';

jest.mock('../../hooks/useNode', () => ({
  useNode: () => ({ status: 'running', config: { agentName: 'Aria' } }),
}));

// Use an object so the jest.mock factory captures the reference, not the binding.
// (jest.mock is hoisted — `let` declarations would be in TDZ when factory runs.)
const mockLeagueState = { data: null as any };

jest.mock('../../hooks/useNodeApi', () => ({
  useTaskLog: () => ({
    entries: [
      { id: 1, timestamp: Math.floor(Date.now() / 1000), category: 'bounty', outcome: 'success', amount_usd: 1.70, duration_min: 5, summary: 'Code review', shared: false },
      { id: 2, timestamp: Math.floor(Date.now() / 1000) - 3600, category: 'bounty', outcome: 'success', amount_usd: 0.80, duration_min: 3, summary: 'Translation', shared: false },
    ],
    loading: false,
    reload: jest.fn(),
  }),
  useSkrLeague: () => ({ data: mockLeagueState.data, loading: false, error: null, refresh: jest.fn() }),
}));

function wrap(ui: React.ReactElement) {
  return render(<NavigationContainer>{ui}</NavigationContainer>);
}

// ── League fixture ───────────────────────────────────────────────────────────

const LEAGUE_ENTRIES = [
  { rank: 1, wallet: 'w1', label: 'Aria',         earn_rate_pct: 8.4, bags_fee_score: 0, points: 100, trade_count: 5, active_days: 3, skr_balance: 0 },
  { rank: 2, wallet: 'w2', label: 'Nexus',        earn_rate_pct: 6.1, bags_fee_score: 0, points: 80,  trade_count: 4, active_days: 2, skr_balance: 0 },
  { rank: 3, wallet: 'w3', label: 'Bolt',         earn_rate_pct: 5.2, bags_fee_score: 0, points: 60,  trade_count: 3, active_days: 2, skr_balance: 0 },
  { rank: 4, wallet: 'w4', label: 'ZeroAgent',    earn_rate_pct: 4.8, bags_fee_score: 0, points: 50,  trade_count: 2, active_days: 1, skr_balance: 0 },
  { rank: 5, wallet: 'w5', label: 'Owner a1b2c3', earn_rate_pct: 3.9, bags_fee_score: 0, points: 40,  trade_count: 2, active_days: 1, skr_balance: 0 },
  { rank: 6, wallet: 'w6', label: 'Ranger',       earn_rate_pct: 3.1, bags_fee_score: 0, points: 30,  trade_count: 1, active_days: 1, skr_balance: 0 },
];

function makeLeagueData(walletRank: number | null = null, walletEarnRate = 0) {
  return {
    title: 'Earnings League',
    season: 'Mar 2026',
    ends_at: Math.floor(Date.now() / 1000) + 10 * 86400,
    min_skr: 1000,
    reward_pool_skr: 10000,
    scoring: ['Ranked by seasonal fee earn rate'],
    rewards: ['1st: 1,500 SKR'],
    wallet: {
      wallet: walletRank !== null ? 'mywallet' : null,
      skr_balance: 0,
      has_access: true,
      rank: walletRank,
      earn_rate_pct: walletEarnRate,
      bags_fee_score: 0,
      points: 0,
      trade_count: walletRank !== null ? 3 : 0,
      active_days: walletRank !== null ? 2 : 0,
      access_message: '',
    },
    leaderboard: LEAGUE_ENTRIES,
  };
}

// ── Existing tests (unchanged) ───────────────────────────────────────────────

describe('TodayScreen', () => {
  beforeEach(() => { mockLeagueState.data = null; });

  it('shows agent name', () => {
    const { getByText } = wrap(<TodayScreen />);
    expect(getByText('Aria')).toBeTruthy();
  });

  it('shows summed earned today', () => {
    const { getAllByText } = wrap(<TodayScreen />);
    expect(getAllByText('$2.50').length).toBeGreaterThanOrEqual(1);
  });

  it('shows recent job summaries', () => {
    const { getByText } = wrap(<TodayScreen />);
    expect(getByText('Code review')).toBeTruthy();
    expect(getByText('Translation')).toBeTruthy();
  });
});

// ── Earnings League tests ────────────────────────────────────────────────────

describe('TodayScreen — Earnings League', () => {
  beforeEach(() => { mockLeagueState.data = null; });

  it('hides league section when data is null', () => {
    const { queryByText } = wrap(<TodayScreen />);
    expect(queryByText('EARNINGS LEAGUE')).toBeNull();
  });

  it('renders top-5 rows with name and rate when data is present', () => {
    mockLeagueState.data = makeLeagueData();
    const { getByText } = wrap(<TodayScreen />);
    expect(getByText('EARNINGS LEAGUE')).toBeTruthy();
    expect(getByText('Nexus')).toBeTruthy();
    expect(getByText('+8.4%')).toBeTruthy();
  });

  it('does not append "You" row when rank is 1-5', () => {
    mockLeagueState.data = makeLeagueData(2, 6.1);
    const { queryByText } = wrap(<TodayScreen />);
    expect(queryByText(/You · #/)).toBeNull();
  });

  it('appends "You · #N" row when rank is 6+', () => {
    mockLeagueState.data = makeLeagueData(6, 3.1);
    const { getByText } = wrap(<TodayScreen />);
    expect(getByText(/You · #6/)).toBeTruthy();
  });

  it('shows no "You" row when rank is null', () => {
    mockLeagueState.data = makeLeagueData(null);
    const { queryByText } = wrap(<TodayScreen />);
    expect(queryByText(/You · #/)).toBeNull();
  });

  it('opens modal with full leaderboard on "See all" tap', () => {
    mockLeagueState.data = makeLeagueData();
    const { getByText } = wrap(<TodayScreen />);
    fireEvent.press(getByText('→ See all agents'));
    expect(getByText('REWARDS')).toBeTruthy();
    expect(getByText('HOW IT WORKS')).toBeTruthy();
    expect(getByText('Ranger')).toBeTruthy(); // rank 6 — only in modal, not preview
  });
});
```

- [ ] **Step 2: Run the tests — expect failures on the league describe block**

```bash
cd /Users/tobiasd/Desktop/zerox1/mobile
yarn jest src/screens/__tests__/Today.test.tsx --no-coverage 2>&1 | tail -20
```

Expected: the 3 existing tests pass; the 6 new league tests fail with messages like `Unable to find an element with the text: 'EARNINGS LEAGUE'`. If instead you see a `ReferenceError` about `mockLeagueState`, the object pattern was not applied correctly — check that `const mockLeagueState` appears before `jest.mock`.

---

### Task 3: Add Earnings League section to Today.tsx

**Files:**
- Modify: `mobile/src/screens/Today.tsx`

- [ ] **Step 1: Update imports**

Change:
```typescript
import React, { useMemo } from 'react';
```
to:
```typescript
import React, { useMemo, useState } from 'react';
```

Change:
```typescript
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Image,
} from 'react-native';
```
to:
```typescript
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Image, Modal,
} from 'react-native';
```

Change:
```typescript
import { useTaskLog } from '../hooks/useNodeApi';
```
to:
```typescript
import { useTaskLog, useSkrLeague } from '../hooks/useNodeApi';
```

- [ ] **Step 2: Add helper functions after `relativeTime` (before `export default function TodayScreen`)**

```typescript
function fmtRate(pct: number): string {
  return `+${pct.toFixed(1)}%`;
}

function seasonCountdown(endsAt: number): string {
  const days = Math.ceil((endsAt * 1000 - Date.now()) / 86_400_000);
  if (days >= 2) return `Season ends in ${days}d`;
  if (days === 1) return 'Season ends tomorrow';
  if (days === 0) return 'Season ends today';
  return 'Season ended';
}
```

- [ ] **Step 3: Add hook calls inside `TodayScreen`**

After `const { entries, loading } = useTaskLog();`, add:

```typescript
  const { data: leagueData } = useSkrLeague();
  const [leagueModalVisible, setLeagueModalVisible] = useState(false);
```

- [ ] **Step 4: Add league JSX after the Recent Jobs closing `</View>`, before `</ScrollView>`**

```tsx
      {/* Section divider */}
      <View style={s.sectionDivider} />

      {/* Earnings League */}
      {leagueData && (
        <View style={s.section}>
          <View style={s.leagueHeader}>
            <Text style={s.sectionLabel}>EARNINGS LEAGUE</Text>
            <Text style={s.leagueCountdown}>{seasonCountdown(leagueData.ends_at)}</Text>
          </View>
          {leagueData.leaderboard.slice(0, 5).map((entry) => {
            const isYou =
              leagueData.wallet.rank !== null &&
              leagueData.wallet.rank >= 1 &&
              leagueData.wallet.rank === entry.rank;
            return (
              <View key={entry.rank} style={[s.leagueRow, isYou && s.leagueRowHighlight]}>
                <Text style={s.leagueRank}>#{entry.rank}</Text>
                <Text style={[s.leagueName, isYou && s.leagueNameYou]}>{entry.label}</Text>
                <Text style={s.leagueRate}>{fmtRate(entry.earn_rate_pct)}</Text>
              </View>
            );
          })}
          {leagueData.wallet.rank !== null && leagueData.wallet.rank >= 6 && (
            <View style={[s.leagueRow, s.leagueRowYouAppended]}>
              <View style={{ width: 28 }} />
              <Text style={s.leagueNameYou}>You · #{leagueData.wallet.rank}</Text>
              <Text style={s.leagueRate}>{fmtRate(leagueData.wallet.earn_rate_pct)}</Text>
            </View>
          )}
          <TouchableOpacity style={s.leagueSeeAll} onPress={() => setLeagueModalVisible(true)}>
            <Text style={s.leagueSeeAllText}>→ See all agents</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* League bottom-sheet modal */}
      <Modal
        visible={leagueModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setLeagueModalVisible(false)}
      >
        {leagueData && (
          <View style={s.modalRoot}>
            <View style={s.modalHandle} />
            <View style={s.modalHeaderRow}>
              <Text style={s.modalTitle}>EARNINGS LEAGUE · {leagueData.season}</Text>
              <TouchableOpacity onPress={() => setLeagueModalVisible(false)}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={s.modalScroll} contentContainerStyle={s.modalScrollContent}>
              <Text style={s.modalSectionLabel}>REWARDS</Text>
              {leagueData.rewards.map((r, i) => (
                <Text key={i} style={s.modalInfoRow}>{r}</Text>
              ))}
              <Text style={[s.modalSectionLabel, { marginTop: 16 }]}>HOW IT WORKS</Text>
              {leagueData.scoring.map((r, i) => (
                <Text key={i} style={s.modalInfoRow}>{r}</Text>
              ))}
              <View style={s.sectionDivider} />
              {leagueData.leaderboard.map((entry) => {
                const isYou =
                  leagueData.wallet.rank !== null &&
                  leagueData.wallet.rank >= 1 &&
                  leagueData.wallet.rank === entry.rank;
                return (
                  <View key={entry.rank} style={[s.leagueRow, isYou && s.leagueRowHighlight]}>
                    <Text style={s.leagueRank}>#{entry.rank}</Text>
                    <Text style={[s.leagueName, isYou && s.leagueNameYou]}>{entry.label}</Text>
                    <Text style={s.leagueRate}>{fmtRate(entry.earn_rate_pct)}</Text>
                  </View>
                );
              })}
              {leagueData.wallet.rank !== null && leagueData.wallet.rank >= 1 && (
                <View style={s.modalFooter}>
                  <View style={s.modalStatCol}>
                    <Text style={s.modalStatLabel}>EARN RATE</Text>
                    <Text style={s.modalStatValue}>{fmtRate(leagueData.wallet.earn_rate_pct)}</Text>
                  </View>
                  <View style={s.modalStatCol}>
                    <Text style={s.modalStatLabel}>TRADES</Text>
                    <Text style={s.modalStatValue}>{leagueData.wallet.trade_count}</Text>
                  </View>
                  <View style={s.modalStatCol}>
                    <Text style={s.modalStatLabel}>ACTIVE DAYS</Text>
                    <Text style={s.modalStatValue}>{leagueData.wallet.active_days}</Text>
                  </View>
                </View>
              )}
            </ScrollView>
          </View>
        )}
      </Modal>
```

- [ ] **Step 5: Add StyleSheet entries inside `StyleSheet.create({})`**

Add after the last existing entry (`workingBadgeText`):

```typescript
  // ── Earnings League ──────────────────────────────────────────────────────
  leagueHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  leagueCountdown: { fontSize: 10, color: '#9ca3af' },
  leagueRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  leagueRowHighlight: { backgroundColor: '#f0fdf4', borderRadius: 6, marginHorizontal: -4, paddingHorizontal: 4 },
  leagueRowYouAppended: { borderTopWidth: 1, borderTopColor: '#e5e7eb', borderBottomWidth: 0 },
  leagueRank: { fontSize: 11, color: '#9ca3af', width: 28 },
  leagueName: { flex: 1, fontSize: 12, color: '#111', fontWeight: '500' },
  leagueNameYou: { color: '#22c55e' },
  leagueRate: { fontSize: 12, color: '#22c55e', fontWeight: '600' },
  leagueSeeAll: { paddingVertical: 10 },
  leagueSeeAllText: { fontSize: 11, color: '#6b7280' },
  // ── League modal ─────────────────────────────────────────────────────────
  modalRoot: { flex: 1, backgroundColor: '#fff' },
  modalHandle: { width: 32, height: 4, backgroundColor: '#e5e7eb', borderRadius: 2, alignSelf: 'center', marginTop: 8, marginBottom: 16 },
  modalHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, marginBottom: 12 },
  modalTitle: { fontSize: 11, fontWeight: '700', color: '#111', letterSpacing: 0.5 },
  modalClose: { fontSize: 16, color: '#6b7280', padding: 4 },
  modalScroll: { flex: 1 },
  modalScrollContent: { paddingHorizontal: 16, paddingBottom: 32 },
  modalSectionLabel: { fontSize: 10, color: '#9ca3af', letterSpacing: 0.5, marginBottom: 8 },
  modalInfoRow: { fontSize: 12, color: '#374151', marginBottom: 6 },
  modalFooter: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 16, borderTopWidth: 1, borderTopColor: '#f3f4f6', marginTop: 8 },
  modalStatCol: { alignItems: 'center' as const },
  modalStatLabel: { fontSize: 9, color: '#9ca3af', letterSpacing: 0.3, marginBottom: 4 },
  modalStatValue: { fontSize: 15, fontWeight: '700', color: '#111' },
```

- [ ] **Step 6: Run all tests — expect 9 passing**

```bash
cd /Users/tobiasd/Desktop/zerox1/mobile
yarn jest src/screens/__tests__/Today.test.tsx --no-coverage 2>&1 | tail -20
```

Expected: `9 passed, 9 total`.

- [ ] **Step 7: TypeScript check**

```bash
cd /Users/tobiasd/Desktop/zerox1/mobile
yarn tsc --noEmit 2>&1 | grep -E "error TS|Today" | head -20
```

Expected: no errors in Today.tsx.

- [ ] **Step 8: Commit**

```bash
cd /Users/tobiasd/Desktop/zerox1/mobile
git add src/screens/Today.tsx src/screens/__tests__/Today.test.tsx
git commit -m "feat: earnings league section in Today — top-5 preview + modal"
```
