/**
 * useNodeApi — hooks for the zerox1-node REST + WebSocket API.
 *
 * The node listens on 127.0.0.1:9090 (NodeService.NODE_API_PORT).
 * All hooks gracefully return empty/default state when the node is stopped.
 */
import { useState, useEffect, useRef, useCallback } from 'react';

const API_BASE       = 'http://127.0.0.1:9090';
const WS_BASE        = 'ws://127.0.0.1:9090';
const AGGREGATOR_API = 'https://api.0x01.world';
const AGGREGATOR_WS  = 'wss://api.0x01.world';

// ============================================================================
// Types (mirrors node API responses)
// ============================================================================

export interface PeerSnapshot {
  agent_id:  string;
  name:      string;
  last_seen: number;
  sati_ok:   boolean;
  lease_ok:  boolean;
}

export interface ReputationSnapshot {
  agent_id:         string;
  feedback_count:   number;
  total_score:      number;
  positive_count:   number;
  negative_count:   number;
  verdict_count:    number;
  trend:            string;
}

export interface InboundEnvelope {
  sender:      string;
  msg_type:    string;
  slot:        number;
  payload_b64: string;
  conversation_id: string;
}

export interface NetworkStats {
  agent_count:       number;
  interaction_count: number;
  beacon_count:      number;
  beacon_bpm:        number;
}

export interface IdentityInfo {
  /** Hex-encoded libp2p PeerId — used as agent_id on the mesh. */
  agent_id: string;
  /** Human-readable agent name from config. */
  name: string;
}

export interface ActivityEvent {
  id:               number;
  ts:               number;
  event_type:       'JOIN' | 'FEEDBACK' | 'DISPUTE' | 'VERDICT';
  agent_id:         string;
  target_id?:       string;
  score?:           number;
  name?:            string;
  target_name?:     string;
  slot?:            number;
  conversation_id?: string;
}

export interface AgentSummary {
  agent_id:       string;
  name:           string;
  feedback_count: number;
  total_score:    number;
  average_score:  number;
  positive_count: number;
  negative_count: number;
  verdict_count:  number;
  trend:          string;
  last_seen:      number;
}

// ============================================================================
// Generic fetch helper
// ============================================================================

async function apiFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

// ============================================================================
// Hooks
// ============================================================================

/** Polls GET /peers every `intervalMs` ms. */
export function usePeers(intervalMs = 5000) {
  const [peers, setPeers] = useState<PeerSnapshot[]>([]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const data = await apiFetch<PeerSnapshot[]>('/peers');
      if (!cancelled && data) setPeers(data);
    };
    poll();
    const id = setInterval(poll, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [intervalMs]);

  return peers;
}

/** Fetches own reputation from the aggregator-facing API. */
export function useOwnReputation(agentId: string | null, intervalMs = 30_000) {
  const [rep, setRep] = useState<ReputationSnapshot | null>(null);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    const poll = async () => {
      const data = await apiFetch<ReputationSnapshot>(`/reputation/${agentId}`);
      if (!cancelled && data) setRep(data);
    };
    poll();
    const id = setInterval(poll, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [agentId, intervalMs]);

  return rep;
}

/** Polls GET /stats/network from the aggregator. */
export function useNetworkStats(intervalMs = 15_000) {
  const [stats, setStats] = useState<NetworkStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      // Node proxies or we hit aggregator directly — fall back gracefully.
      try {
        const res = await fetch('https://api.0x01.world/stats/network');
        if (res.ok && !cancelled) setStats(await res.json());
      } catch { /* offline */ }
    };
    poll();
    const id = setInterval(poll, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [intervalMs]);

  return stats;
}

/** Opens WS /ws/inbox and streams inbound envelopes. */
export function useInbox(
  onEnvelope: (env: InboundEnvelope) => void,
  enabled = true,
) {
  const wsRef      = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onEnvelope);
  handlerRef.current = onEnvelope;

  const reconnect = useCallback(() => {
    if (!enabled) return;
    try {
      const ws = new WebSocket(`${WS_BASE}/ws/inbox`);
      ws.onmessage = (e) => {
        try {
          const env: InboundEnvelope = JSON.parse(e.data);
          handlerRef.current(env);
        } catch { /* malformed */ }
      };
      ws.onclose = () => {
        // Reconnect after 3s if still enabled
        setTimeout(reconnect, 3000);
      };
      wsRef.current = ws;
    } catch { /* node not running */ }
  }, [enabled]);

  useEffect(() => {
    reconnect();
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [reconnect]);
}

/** Polls GET /identity — returns own agent_id and name. */
export function useIdentity() {
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const data = await apiFetch<IdentityInfo>('/identity');
      if (!cancelled && data) setIdentity(data);
    };
    poll();
    const id = setInterval(poll, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return identity;
}

/** Polls GET /agents on the aggregator. */
export function useAgents(
  sort: 'reputation' | 'active' | 'new' = 'reputation',
  limit = 100,
) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${AGGREGATOR_API}/agents?limit=${limit}&sort=${sort}`);
        if (res.ok && !cancelled) setAgents(await res.json());
      } catch { /* offline */ }
    };
    poll();
    const id = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [sort, limit]);

  return agents;
}

const MAX_FEED = 200;

/**
 * Fetches the initial activity feed then subscribes to live events via
 * the aggregator WebSocket.
 */
export function useActivityFeed(limit = 50) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const reconnect = useCallback(() => {
    try {
      const ws = new WebSocket(`${AGGREGATOR_WS}/ws/activity`);
      ws.onmessage = (e) => {
        try {
          const ev: ActivityEvent = JSON.parse(e.data);
          setEvents(prev => {
            const next = [ev, ...prev];
            return next.length > MAX_FEED ? next.slice(0, MAX_FEED) : next;
          });
        } catch { /* malformed */ }
      };
      ws.onclose = () => {
        setTimeout(reconnect, 3000);
      };
      wsRef.current = ws;
    } catch { /* network not ready */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Initial fetch.
    fetch(`${AGGREGATOR_API}/activity?limit=${limit}`)
      .then(r => r.ok ? r.json() : [])
      .then((data: ActivityEvent[]) => {
        if (!cancelled) setEvents(data);
      })
      .catch(() => {});
    // Live stream.
    reconnect();
    return () => {
      cancelled = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [limit, reconnect]);

  return events;
}

/** Fetch profile for a single agent (reputation + capabilities + disputes). */
export function useAgentProfile(agentId: string | null) {
  const [profile, setProfile] = useState<any | null>(null);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    fetch(`${AGGREGATOR_API}/agents/${agentId}/profile`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled) setProfile(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [agentId]);

  return profile;
}

/** Send an envelope via POST /envelopes/send (requires api_secret). */
export async function sendEnvelope(
  payload: object,
  apiSecret?: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/envelopes/send`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiSecret ? { Authorization: `Bearer ${apiSecret}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}
