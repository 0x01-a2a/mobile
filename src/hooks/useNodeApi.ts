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
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

let _apiBase = 'http://127.0.0.1:9090';
let _wsBase = 'ws://127.0.0.1:9090';
let _hostedToken: string | null = null;

// Skip HTTP polls while the screen is off — saves CPU and radio wakeups.
let _appActive = AppState.currentState === 'active';
AppState.addEventListener('change', (state) => { _appActive = state === 'active'; });

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
  wsBase?: string;
  token?: string;
}) {
  if (opts.apiBase) _apiBase = opts.apiBase;
  if (opts.wsBase) _wsBase = opts.wsBase;
  if (opts.token !== undefined) _hostedToken = opts.token;
}

const AGGREGATOR_API = 'https://api.0x01.world';
const AGGREGATOR_WS = 'wss://api.0x01.world';

// ============================================================================
// Types (mirrors node API responses)
// ============================================================================

export interface PeerSnapshot {
  agent_id: string;
  name: string;
  last_seen: number;
  lease_ok: boolean;
}

export interface ReputationSnapshot {
  agent_id: string;
  feedback_count: number;
  total_score: number;
  positive_count: number;
  negative_count: number;
  verdict_count: number;
  trend: string;
}

export interface InboundEnvelope {
  sender: string;
  msg_type: string;
  slot: number;
  payload_b64: string;
  conversation_id: string;
}

export interface NetworkStats {
  agent_count: number;
  interaction_count: number;
  beacon_count: number;
  beacon_bpm: number;
}

export interface IdentityInfo {
  /** Hex-encoded libp2p PeerId — used as agent_id on the mesh. */
  agent_id: string;
  /** Human-readable agent name from config. */
  name: string;
}

export interface ActivityEvent {
  id: number;
  ts: number;
  event_type: 'JOIN' | 'FEEDBACK' | 'DISPUTE' | 'VERDICT';
  agent_id: string;
  target_id?: string;
  score?: number;
  name?: string;
  target_name?: string;
  slot?: number;
  conversation_id?: string;
}

export interface AgentSummary {
  agent_id: string;
  name: string;
  feedback_count: number;
  total_score: number;
  average_score: number;
  positive_count: number;
  negative_count: number;
  verdict_count: number;
  trend: string;
  last_seen: number;
}

// ============================================================================
// Generic fetch helper
// ============================================================================

async function apiFetch<T>(path: string): Promise<T | null> {
  try {
    const headers: Record<string, string> = {};
    if (_hostedToken) headers['Authorization'] = `Bearer ${_hostedToken}`;
    const res = await fetch(`${_apiBase}${path}`, { headers });
    if (!res.ok) {
      console.warn(`[nodeApi] ${path} → HTTP ${res.status}`);
      return null;
    }
    return res.json() as Promise<T>;
  } catch (e) {
    console.warn(`[nodeApi] ${path} failed:`, e);
    return null;
  }
}

// ============================================================================
// Hooks
// ============================================================================

/** Polls GET /peers every `intervalMs` ms. */
export function usePeers(intervalMs = 15_000) {
  const [peers, setPeers] = useState<PeerSnapshot[]>([]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (!_appActive) return;
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
      if (!_appActive) return;
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
      if (!_appActive) return;
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
  const wsRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onEnvelope);
  const reconnectDelay = useRef(1_000);
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
      ws.onopen = () => { reconnectDelay.current = 1_000; };
      ws.onmessage = (e) => {
        try {
          const env: InboundEnvelope = JSON.parse(e.data);
          handlerRef.current(env);
        } catch { /* malformed */ }
      };
      ws.onerror = (e: WebSocketErrorEvent) => {
        // HTTP 401/403 surfaces here in React Native. Stop reconnecting so
        // we don't spin forever with a bad hosted token.
        const msg = (e as any)?.message ?? '';
        if (msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized') || msg.includes('Forbidden')) {
          reconnectDelay.current = -1; // sentinel: do not reconnect
        }
      };
      ws.onclose = () => {
        if (reconnectDelay.current < 0) return; // auth failure — stop
        const delay = reconnectDelay.current;
        reconnectDelay.current = Math.min(delay * 2, 30_000);
        setTimeout(reconnect, delay);
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
      if (!_appActive) return;
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
      if (!_appActive) return;
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
  const reconnectDelay = useRef(1_000);

  const fetchInitial = useCallback(async () => {
    try {
      const res = await fetch(`${AGGREGATOR_API}/activity?limit=${limit}`);
      if (res.ok) setEvents(await res.json());
    } catch { /* offline */ }
  }, [limit]);

  const reconnect = useCallback(() => {
    try {
      const ws = new WebSocket(`${AGGREGATOR_WS}/ws/activity`);
      ws.onopen = () => { reconnectDelay.current = 1_000; };
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
        const delay = reconnectDelay.current;
        reconnectDelay.current = Math.min(delay * 2, 30_000);
        setTimeout(reconnect, delay);
      };
      wsRef.current = ws;
    } catch { /* network not ready */ }
  }, []);

  useEffect(() => {
    fetchInitial();
    reconnect();
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [limit, reconnect, fetchInitial]);

  return { events, refresh: fetchInitial };
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
      .catch(() => { });
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
    const auth = apiSecret || _hostedToken;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (auth) {
      headers['Authorization'] = `Bearer ${auth}`;
    }

    const res = await fetch(`${_apiBase}/envelopes/send`, {
      method: 'POST',
      headers,
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
  node_id: string;
  name: string;
  fee_bps: number;
  api_url: string;
  first_seen: number;
  last_seen: number;
  hosted_count: number;
  /** RTT in ms — added client-side after probing. */
  rtt_ms?: number;
}

/**
 * Ping a host node's /hosted/ping endpoint and return RTT in ms,
 * or null on failure.
 */
export async function probeRtt(apiUrl: string): Promise<number | null> {
  const start = Date.now();
  try {
    const res = await fetch(`${apiUrl}/hosted/ping`);
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
    service: KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
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
    ['zerox1:hosted_mode', 'true'],
    ['zerox1:host_url', hostApiUrl],
    ['zerox1:hosted_agent_id', data.agent_id],
  ]);

  configureNodeApi({
    apiBase: hostApiUrl,
    wsBase: hostApiUrl.replace(/^https/, 'wss').replace(/^http/, 'ws'),
    token: data.token,
  });

  return { agent_id: data.agent_id };
}

// ============================================================================
// Hot wallet balance + sweep
// ============================================================================

const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export interface HotKeyBalanceResult {
  /** USDC balance (6-decimal float), or null while loading / not available. */
  balance: number | null;
  loading: boolean;
  /** Agent hot wallet address in Solana base58, or null when node is not running. */
  solanaAddress: string | null;
}

/**
 * Polls the USDC balance of the node's hot wallet every 30 seconds.
 *
 * Only works in local mode (node running on 127.0.0.1:9090).
 * In hosted mode this returns `{ balance: null, loading: false, solanaAddress: null }`.
 */
export function useHotKeyBalance(): HotKeyBalanceResult {
  const identity = useIdentity();
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [solanaAddress, setSolanaAddress] = useState<string | null>(null);

  useEffect(() => {
    // Only poll in local mode and when the node is running.
    if (_hostedToken || !identity) {
      setBalance(null);
      setSolanaAddress(null);
      return;
    }

    // Convert hex agent_id → Solana base58 address.
    let addr: string;
    try {
      const { PublicKey } = require('@solana/web3.js');
      const bytes = Uint8Array.from(
        (identity.agent_id.match(/.{1,2}/g) ?? []).map((b: string) => parseInt(b, 16))
      );
      addr = new PublicKey(bytes).toBase58();
    } catch {
      return;
    }
    setSolanaAddress(addr);

    let cancelled = false;

    const poll = async () => {
      if (!_appActive || cancelled) return;
      setLoading(true);
      try {
        // Read rpcUrl from node config stored in AsyncStorage (falls back to devnet).
        let rpcUrl = 'https://api.devnet.solana.com';
        try {
          const raw = await AsyncStorage.getItem('zerox1:node_config');
          if (raw) {
            const cfg = JSON.parse(raw);
            if (cfg.rpcUrl) rpcUrl = cfg.rpcUrl;
          }
        } catch { /* use default */ }

        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTokenAccountsByOwner',
            params: [
              addr,
              { mint: USDC_MINT_DEVNET },
              { encoding: 'jsonParsed' },
            ],
          }),
        });
        const data = await res.json();
        const accounts = data?.result?.value ?? [];
        if (accounts.length === 0) {
          if (!cancelled) setBalance(0);
        } else {
          const raw = accounts[0]?.account?.data?.parsed?.info?.tokenAmount?.amount;
          if (!cancelled) setBalance(raw != null ? Number(raw) / 1_000_000 : 0);
        }
      } catch {
        // Network error — leave previous balance
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    poll();
    const id = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [identity]);

  return { balance, loading, solanaAddress };
}

export interface SweepResult {
  signature: string;
  amount_usdc: number;
  destination: string;
}

/**
 * Transfer all USDC from the node's hot wallet to `destination` (base58 wallet).
 * Calls POST /wallet/sweep on the local node API.
 */
export async function sweepUsdc(destination: string): Promise<SweepResult> {
  const res = await fetch(`${_apiBase}/wallet/sweep`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destination }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

// ============================================================================
// Watchlist
// ============================================================================

const WATCHLIST_KEY = 'zerox1:watchlist';

/**
 * Persist a personal watchlist of agent IDs in AsyncStorage.
 * Watch agents from the Agents screen; filter the Feed to watched agents.
 */
export function useWatchlist() {
  const [list, setList] = useState<string[]>([]);

  useEffect(() => {
    AsyncStorage.getItem(WATCHLIST_KEY)
      .then(v => {
        if (!v) return;
        try {
          const parsed = JSON.parse(v);
          if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) {
            setList(parsed);
          }
        } catch { /* corrupt storage — start fresh */ }
      })
      .catch(() => { });
  }, []);

  const persist = useCallback((next: string[]) => {
    AsyncStorage.setItem(WATCHLIST_KEY, JSON.stringify(next)).catch(() => { });
  }, []);

  const watch = useCallback((id: string) => {
    setList(prev => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      persist(next);
      return next;
    });
  }, [persist]);

  const unwatch = useCallback((id: string) => {
    setList(prev => {
      const next = prev.filter(x => x !== id);
      persist(next);
      return next;
    });
  }, [persist]);

  const isWatched = useCallback((id: string) => list.includes(id), [list]);

  return { watchlist: list, watch, unwatch, isWatched };
}
