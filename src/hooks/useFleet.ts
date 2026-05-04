/**
 * useFleet — data source for the 01fi Fleet management + analytics tab.
 *
 * Currently returns deterministic mock data so the UI can be developed and
 * demoed before the daemon is deployed. The shapes here are the source-of-
 * truth contract for the future zerox1-defi-daemon HTTP responses:
 *
 *   GET  /fleet/overview      → FleetOverview
 *   GET  /fleet/legs          → LegStatus[]
 *   GET  /fleet/agents        → AgentStatus[]
 *   GET  /fleet/activity      → ActivityEvent[]
 *   GET  /fleet/alerts        → RiskAlert[]
 *   GET  /fleet/briefs        → ResearcherBrief[]
 *   POST /fleet/legs/:id/pause
 *   POST /fleet/legs/:id/resume
 *   POST /fleet/rebalance
 *
 * When the daemon ships, replace `mockFleet()` with HTTP fetchers; keep the
 * types unchanged so the UI does not need updating.
 */
import { useEffect, useState } from 'react';

export type LegId = 'multiply' | 'hedgedJlp' | 'stableFloor';
export type AgentRole =
  | 'orchestrator'
  | 'multiply'
  | 'hedgedJlp'
  | 'stableFloor'
  | 'riskWatcher'
  | 'researcher'
  | 'speculator';
export type AgentStatusKind = 'running' | 'idle' | 'error' | 'offline' | 'paused';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface FleetOverview {
  deployed_usd: number;
  blended_apr_pct: number;
  earned_today_usd: number;
  earned_week_usd: number;
  earned_month_usd: number;
  sharpe_30d: number | null;
  max_dd_30d_pct: number | null;
  fleet_online: boolean;
}

export interface LegStatus {
  id: LegId;
  position_usd: number;
  current_apr_pct: number;
  pnl_24h_usd: number;
  health_factor: number | null;
  paused: boolean;
  last_action_iso: string | null;
}

export interface AgentStatus {
  agent_id: string;
  role: AgentRole;
  status: AgentStatusKind;
  last_message_iso: string | null;
  current_task: string | null;
}

export interface ActivityEvent {
  id: string;
  ts_iso: string;
  from_role: AgentRole;
  to_role: AgentRole | null;
  kind: 'PROPOSE' | 'ACCEPT' | 'DELIVER' | 'REJECT' | 'COUNTER';
  summary: string;
  txid: string | null;
}

export interface RiskAlert {
  id: string;
  ts_iso: string;
  severity: AlertSeverity;
  source: AgentRole;
  message: string;
}

export interface ResearcherBrief {
  id: string;
  ts_iso: string;
  kind: 'risk_update' | 'opportunity' | 'weekly_review';
  headline: string;
  conviction: number | null;
}

export interface FleetSnapshot {
  overview: FleetOverview;
  legs: LegStatus[];
  agents: AgentStatus[];
  activity: ActivityEvent[];
  alerts: RiskAlert[];
  briefs: ResearcherBrief[];
}

export interface UseFleetResult {
  data: FleetSnapshot;
  refreshing: boolean;
  refresh: () => Promise<void>;
}

// ── Mock generator ──────────────────────────────────────────────────────────

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

function mockFleet(): FleetSnapshot {
  return {
    overview: {
      deployed_usd: 167.42,
      blended_apr_pct: 14.8,
      earned_today_usd: 0.07,
      earned_week_usd: 0.42,
      earned_month_usd: 1.83,
      sharpe_30d: 1.78,
      max_dd_30d_pct: 4.2,
      fleet_online: true,
    },
    legs: [
      {
        id: 'multiply',
        position_usd: 75.20,
        current_apr_pct: 16.4,
        pnl_24h_usd: 0.034,
        health_factor: 1.42,
        paused: false,
        last_action_iso: isoMinutesAgo(38),
      },
      {
        id: 'hedgedJlp',
        position_usd: 67.10,
        current_apr_pct: 11.2,
        pnl_24h_usd: 0.021,
        health_factor: null,
        paused: false,
        last_action_iso: isoMinutesAgo(184),
      },
      {
        id: 'stableFloor',
        position_usd: 25.12,
        current_apr_pct: 5.7,
        pnl_24h_usd: 0.004,
        health_factor: null,
        paused: false,
        last_action_iso: isoMinutesAgo(720),
      },
    ],
    agents: [
      { agent_id: 'orch_a1b2', role: 'orchestrator', status: 'running', last_message_iso: isoMinutesAgo(2), current_task: 'monitoring fleet' },
      { agent_id: 'mul_3c4d', role: 'multiply', status: 'running', last_message_iso: isoMinutesAgo(38), current_task: 'leverage at 2.5x' },
      { agent_id: 'jlp_5e6f', role: 'hedgedJlp', status: 'running', last_message_iso: isoMinutesAgo(184), current_task: 'hedge ratio 47%' },
      { agent_id: 'stb_7g8h', role: 'stableFloor', status: 'idle', last_message_iso: isoMinutesAgo(720), current_task: null },
      { agent_id: 'rsk_9i0j', role: 'riskWatcher', status: 'running', last_message_iso: isoMinutesAgo(1), current_task: 'health checks ok' },
      { agent_id: 'rsr_kl12', role: 'researcher', status: 'running', last_message_iso: isoMinutesAgo(14), current_task: 'scanning Kamino governance' },
    ],
    activity: [
      { id: 'a1', ts_iso: isoMinutesAgo(2),  from_role: 'riskWatcher', to_role: 'orchestrator', kind: 'DELIVER', summary: 'Health check: all positions within bounds', txid: null },
      { id: 'a2', ts_iso: isoMinutesAgo(14), from_role: 'researcher',  to_role: 'orchestrator', kind: 'DELIVER', summary: 'Brief: Kamino governance proposal #142 (parameter tweak, no impact)', txid: null },
      { id: 'a3', ts_iso: isoMinutesAgo(38), from_role: 'multiply',    to_role: 'orchestrator', kind: 'DELIVER', summary: 'Multiply position resized 2.3x → 2.5x', txid: '5KqNm…aT9w' },
      { id: 'a4', ts_iso: isoMinutesAgo(40), from_role: 'orchestrator', to_role: 'multiply',     kind: 'PROPOSE', summary: 'Increase leverage on lower borrow cost ($12 budget)', txid: null },
      { id: 'a5', ts_iso: isoMinutesAgo(184), from_role: 'hedgedJlp',  to_role: 'orchestrator', kind: 'DELIVER', summary: 'Hedge ratio rebalanced 49% → 47%', txid: '3Hp7L…ZxRk' },
    ],
    alerts: [],
    briefs: [
      { id: 'b1', ts_iso: isoMinutesAgo(14),  kind: 'risk_update',  headline: 'Kamino governance #142 — parameter tweak, no impact on Multiply', conviction: null },
      { id: 'b2', ts_iso: isoMinutesAgo(380), kind: 'opportunity',  headline: 'New Kamino kVault USDS at 18.5% APY (tier 2) — consider 5% allocation', conviction: 72 },
      { id: 'b3', ts_iso: isoMinutesAgo(1440), kind: 'weekly_review', headline: 'Week 17: 0.32% gross yield. Borrow rates eased on Kamino mid-week.', conviction: null },
    ],
  };
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useFleet(): UseFleetResult {
  const [data, setData] = useState<FleetSnapshot>(() => mockFleet());
  const [refreshing, setRefreshing] = useState(false);

  // TODO(daemon): poll /fleet/overview etc. when daemon URL is configured.
  useEffect(() => {
    const t = setInterval(() => {
      setData(mockFleet());
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    await new Promise(r => setTimeout(r, 400));
    setData(mockFleet());
    setRefreshing(false);
  };

  return { data, refreshing, refresh };
}
