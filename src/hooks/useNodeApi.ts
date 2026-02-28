/**
 * useNodeApi — hooks for the zerox1-node REST + WebSocket API.
 *
 * Supports both local mode (node on 127.0.0.1:9090) and hosted mode
 * (node on a remote host). Call configureNodeApi() on app start when
 * using a remote host.
 *
 * All hooks gracefully return empty/default state when the node is stopped.
 *
 * Security:
 *   - Hosted session tokens are stored in the OS Keychain (react-native-keychain),
 *     not AsyncStorage, so they are hardware-protected on supported devices.
 *   - Remote host URLs must use HTTPS; HTTP is only allowed for localhost.
 *   - The hosted-inbox WebSocket passes the token via the Authorization header,
 *     not a query parameter, to prevent log leakage.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

let _apiBase      = 'http://127.0.0.1:9090';
let _wsBase       = 'ws://127.0.0.1:9090';
let _hostedToken: string | null = null;

// ============================================================================
// URL validation
// ============================================================================

/** Keychain service name for the hosted session token. */
const KEYCHAIN_SERVICE = 'zerox1.hosted_token';

/**
 * Validate a host node URL before use.
 *
 * Allows:
 *   - https:// for all remote hosts
 *   - http:// only for loopback (127.x.x.x / localhost) — dev only
 *
 * Throws if the URL is invalid or disallowed.
 */
export function assertValidHostUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }

  const isLoopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname.startsWith('127.');

  if (parsed.protocol === 'https:') return;   // always allowed
  if (parsed.protocol === 'http:' && isLoopback) return;  // dev only

  throw new Error(
    'Host node URL must use HTTPS. ' +
    'HTTP is only permitted for local development (127.x.x.x / localhost).'
  );
}

// ============================================================================
// Module-level API configuration
// ============================================================================

/** Configure the API base URLs and optional hosted-agent token at runtime. */
export function configureNodeApi(opts: {
  apiBase?: string;
  wsBase?:  string;
  token?:   string;
}) {
  if (opts.apiBase) _apiBase = opts.apiBase;
  if (opts.wsBase)  _wsBase  = opts.wsBase;
  if (opts.token !== undefined) _hostedToken = opts.token;
}

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
  sender:          string;
  msg_type:        string;
  slot:            number;
  payload_b64:     string;
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
    const headers: Record<string, string> = {};
    if (_hostedToken) headers['Authorization'] = `Bearer ${_hostedToken}`;
    const res = await fetch(`${_apiBase}${path}`, { headers });
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

/** Opens WS /ws/inbox (local) or WS /ws/hosted/inbox (hosted mode) and streams inbound envelopes. */
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
      let ws: WebSocket;
      if (_hostedToken) {
        // Hosted mode: connect to the filtered hosted-inbox endpoint and pass
        // the token via Authorization header (never in the query string to
        // prevent log leakage). React Native's WebSocket supports headers via
        // the third constructor argument.
        ws = new WebSocket(
          `${_wsBase}/ws/hosted/inbox`,
          undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { headers: { Authorization: `Bearer ${_hostedToken}` } } as any,
        );
      } else {
        ws = new WebSocket(`${_wsBase}/ws/inbox`);
      }
      ws.onmessage = (e) => {
        try {
          const env: InboundEnvelope = JSON.parse(e.data);
          handlerRef.current(env);
        } catch { /* malformed */ }
      };
      ws.onclose = () => {
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
    fetch(`${AGGREGATOR_API}/activity?limit=${limit}`)
      .then(r => r.ok ? r.json() : [])
      .then((data: ActivityEvent[]) => {
        if (!cancelled) setEvents(data);
      })
      .catch(() => {});
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    const res = await fetch(`${_apiBase}/envelopes/send`, {
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

// ============================================================================
// Hosting node discovery and registration
// ============================================================================

export interface HostingNode {
  node_id:      string;
  name:         string;
  fee_bps:      number;
  api_url:      string;
  first_seen:   number;
  last_seen:    number;
  hosted_count: number;
  /** RTT in ms — added client-side after probing. */
  rtt_ms?:      number;
}

/**
 * Ping a host node's /hosted/ping endpoint and return RTT in ms,
 * or null on failure.
 */
export async function probeRtt(apiUrl: string): Promise<number | null> {
  const start = Date.now();
  try {
    const res = await fetch(`${apiUrl}/hosted/ping`, { cache: 'no-store' });
    if (!res.ok) return null;
    return Date.now() - start;
  } catch {
    return null;
  }
}

/**
 * Fetch the hosting node list from the aggregator, then probe RTT for each
 * candidate in parallel.
 */
export function useHostingNodes(): HostingNode[] {
  const [nodes, setNodes] = useState<HostingNode[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${AGGREGATOR_API}/hosting/nodes`);
        if (!res.ok || cancelled) return;
        const list: HostingNode[] = await res.json();
        if (cancelled) return;
        setNodes(list);
        // Probe RTT for each node in parallel.
        const probed = await Promise.all(
          list.map(async (n) => ({
            ...n,
            rtt_ms: (await probeRtt(n.api_url)) ?? undefined,
          }))
        );
        if (!cancelled) setNodes(probed);
      } catch { /* offline */ }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  return nodes;
}

/**
 * Store the hosted session token in the OS Keychain (hardware-protected
 * on devices with a secure enclave / Android Keystore).
 */
async function saveTokenToKeychain(token: string): Promise<void> {
  await Keychain.setGenericPassword('hosted_token', token, {
    service:     KEYCHAIN_SERVICE,
    accessible:  Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/**
 * Load the hosted session token from the OS Keychain.
 * Returns null if not found or if Keychain access fails.
 */
export async function loadTokenFromKeychain(): Promise<string | null> {
  try {
    const creds = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
    return creds ? creds.password : null;
  } catch {
    return null;
  }
}

/**
 * Delete the hosted session token from the OS Keychain.
 */
export async function clearTokenFromKeychain(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
  } catch { /* already clear */ }
}

/**
 * Register as a hosted agent on a remote node.
 *
 * - Validates that `hostApiUrl` uses HTTPS (or loopback HTTP for dev).
 * - POSTs /hosted/register to obtain a session token.
 * - Stores the token in the OS Keychain (not AsyncStorage).
 * - Persists non-sensitive metadata (host URL, agent_id) in AsyncStorage.
 * - Calls configureNodeApi() so all subsequent API calls go to the host.
 */
export async function registerAsHosted(
  hostApiUrl: string,
): Promise<{ agent_id: string }> {
  // Enforce HTTPS before sending any credentials to the remote host.
  assertValidHostUrl(hostApiUrl);

  const res = await fetch(`${hostApiUrl}/hosted/register`, { method: 'POST' });
  if (!res.ok) throw new Error(`Registration failed: ${res.status}`);
  const data: { agent_id: string; token: string } = await res.json();

  // Store the session token in the OS Keychain (hardware-protected).
  await saveTokenToKeychain(data.token);

  // Store non-sensitive metadata in AsyncStorage.
  await AsyncStorage.multiSet([
    ['zerox1:hosted_mode',     'true'],
    ['zerox1:host_url',        hostApiUrl],
    ['zerox1:hosted_agent_id', data.agent_id],
  ]);

  configureNodeApi({
    apiBase: hostApiUrl,
    wsBase:  hostApiUrl.replace(/^https/, 'wss').replace(/^http/, 'ws'),
    token:   data.token,
  });

  return { agent_id: data.agent_id };
}
