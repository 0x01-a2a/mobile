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
