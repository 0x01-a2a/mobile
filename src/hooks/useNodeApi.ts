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
import { NodeModule } from '../native/NodeModule';

let _apiBase = 'http://127.0.0.1:9090';
let _wsBase = 'ws://127.0.0.1:9090';
let _hostedToken: string | null = null;

// Skip HTTP polls while the screen is off — saves CPU and radio wakeups.
let _appActive = AppState.currentState === 'active';
// Note: module-level AppState listener. The subscription returned by addEventListener
// is intentionally not removed — this module lives for the lifetime of the app process
// and we always want to track the active state. This is a known React Native pattern
// at module scope where cleanup is not applicable.
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

// ── Negotiation payload decode helpers ────────────────────────────────────────
// Mirror the structured payload format used by the SDK:
//   [bytes 0-15]  LE i128 amount in USDC microunits
//   [bytes 16..]  JSON body

function _readBidAmount(raw: Uint8Array): number {
  // Read low 32 bits + next 32 bits as unsigned LE integers.
  // Covers all realistic USDC amounts (< $9 trillion = 9e18 microunits < 2^53).
  const lo = raw[0] | (raw[1] << 8) | (raw[2] << 16) | (raw[3] << 24);
  const hi = raw[4] | (raw[5] << 8) | (raw[6] << 16) | (raw[7] << 24);
  return (lo >>> 0) + (hi >>> 0) * 4294967296;
}

function _decodeBidPayload(
  payloadB64: string,
): { amount: number; body: Record<string, unknown> } | null {
  try {
    const raw = Uint8Array.from(atob(payloadB64), c => c.charCodeAt(0));
    if (raw.length < 17 || raw[16] !== 0x7b) return null; // 0x7b = '{'
    const body = JSON.parse(
      String.fromCharCode(...raw.slice(16)),
    ) as Record<string, unknown>;
    return { amount: _readBidAmount(raw), body };
  } catch {
    return null;
  }
}

export interface NegotiationMsg {
  msg_type: string;
  sender: string;
  slot: number;
  amount?: number;       // USDC microunits
  round?: number;
  maxRounds?: number;
  message?: string;
}

export interface NegotiationThread {
  conversationId: string;
  counterparty: string;  // sender of the first message in this thread
  messages: NegotiationMsg[];
  latestStatus: string;  // msg_type of the most recent message
  latestAmount?: number; // amount from latest COUNTER or ACCEPT
}

const NEGOTIATION_TYPES = new Set(['PROPOSE', 'COUNTER', 'ACCEPT', 'REJECT', 'DELIVER']);

function _parseNegotiationMsg(env: InboundEnvelope): NegotiationMsg {
  const base: NegotiationMsg = {
    msg_type: env.msg_type,
    sender: env.sender,
    slot: env.slot,
  };
  const decoded = _decodeBidPayload(env.payload_b64);
  if (!decoded) return base;
  const { amount, body } = decoded;
  return {
    ...base,
    amount,
    round: body['round'] !== undefined ? Number(body['round']) : undefined,
    maxRounds: body['max_rounds'] !== undefined ? Number(body['max_rounds']) : undefined,
    message: body['message'] !== undefined ? String(body['message']) : undefined,
  };
}

/** Group an inbox array into negotiation threads keyed by conversation_id. */
export function groupNegotiations(inbox: InboundEnvelope[]): NegotiationThread[] {
  const map = new Map<string, NegotiationThread>();
  // inbox is newest-first; iterate reversed to process oldest first
  for (let i = inbox.length - 1; i >= 0; i--) {
    const env = inbox[i];
    if (!NEGOTIATION_TYPES.has(env.msg_type)) continue;
    const msg = _parseNegotiationMsg(env);
    if (!map.has(env.conversation_id)) {
      map.set(env.conversation_id, {
        conversationId: env.conversation_id,
        counterparty: env.sender,
        messages: [],
        latestStatus: env.msg_type,
      });
    }
    const thread = map.get(env.conversation_id)!;
    thread.messages.push(msg);
    thread.latestStatus = env.msg_type;
    if (msg.amount !== undefined && (env.msg_type === 'COUNTER' || env.msg_type === 'ACCEPT')) {
      thread.latestAmount = msg.amount;
    }
  }
  // Return most-recently-updated first
  return Array.from(map.values()).reverse();
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

export type PortfolioEvent =
  | { type: 'swap'; input_mint: string; output_mint: string; input_amount: number; output_amount: number; txid: string; timestamp: number }
  | { type: 'bounty'; amount_usdc: number; from_agent: string; conversation_id: string; timestamp: number }
  | { type: 'bags_fee'; amount_usdc: number; txid: string; timestamp: number }
  | { type: 'bags_launch'; token_mint: string; name: string; symbol: string; txid: string; timestamp: number }
  | { type: 'bags_claim'; token_mint: string; claimed_txs: number; timestamp: number };

export interface TokenBalance {
  mint: string;
  amount: number;
  decimals: number;
}

export interface PortfolioBalances {
  tokens: TokenBalance[];
}

export interface PortfolioHistory {
  events: PortfolioEvent[];
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

/** Polls GET /identity every `intervalMs` ms to check if the node API is reachable.
 *  - `reachable`: true when the API responds successfully
 *  - `offline`: true when the fetch threw a network error (no internet / unreachable host)
 */
export function useNodeHealth(intervalMs = 10_000): { reachable: boolean; offline: boolean } {
  const [reachable, setReachable] = useState(false);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (!_appActive) return;
      try {
        const headers: Record<string, string> = {};
        if (_hostedToken) headers['Authorization'] = `Bearer ${_hostedToken}`;
        const res = await fetch(`${_apiBase}/identity`, { headers });
        if (cancelled) return;
        setOffline(false);
        setReachable(res.ok);
      } catch {
        if (cancelled) return;
        // fetch() throws on network errors (no connectivity, DNS failure, etc.)
        setOffline(true);
        setReachable(false);
      }
    };
    check();
    const id = setInterval(check, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [intervalMs]);

  return { reachable, offline };
}

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

/**
 * Register the local agent on-chain in the 8004 registry.
 * Uses the local node's /registry/8004/register-local endpoint.
 */
export async function registerLocal8004(agentUri: string = ''): Promise<{ signature: string, asset_pubkey: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (_hostedToken) {
    headers.Authorization = `Bearer ${_hostedToken}`;
  } else {
    // Local mode: get the node's local API secret from the native module.
    try {
      const auth = await NodeModule.getLocalAuthConfig();
      if (auth?.nodeApiToken) headers.Authorization = `Bearer ${auth.nodeApiToken}`;
    } catch { /* node may not be ready yet — proceed without token */ }
  }

  const res = await fetch(`${_apiBase}/registry/8004/register-local`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agent_uri: agentUri }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg: string = err.error || `Registration failed: ${res.status}`;
    // Translate the low-level Solana fee error into something actionable.
    if (msg.includes('no record of a prior credit') || msg.includes('Attempt to debit')) {
      throw new Error(
        'Your agent wallet has no SOL.\n\nSend a small amount of SOL (devnet or mainnet, matching your RPC) to your agent wallet to cover the registration fee (~0.01 SOL), then try again.\n\nYour wallet address is shown under My Agent → Hot Wallet.',
      );
    }
    throw new Error(msg);
  }

  return res.json();
}

// ============================================================================
// Hot wallet balance + sweep
// ============================================================================

export interface HotKeyBalanceResult {
  tokens: TokenBalance[];
  loading: boolean;
  solanaAddress: string | null;
  error: string | null;
}
/**
 * Polls the unified balances (SOL, USDC) of the node's wallet from the node API.
 *
 * Works in both local and hosted mode (the node handles it).
 */
export function useHotKeyBalance(): HotKeyBalanceResult {
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [solanaAddress, setSolanaAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const identity = useIdentity();

  useEffect(() => {
    if (!identity) return;

    // Local derivation of address for visibility
    try {
      const { PublicKey } = require('@solana/web3.js');
      const bytes = Uint8Array.from(
        (identity.agent_id.match(/.{1,2}/g) ?? []).map((b: string) => parseInt(b, 16))
      );
      setSolanaAddress(new PublicKey(bytes).toBase58());
    } catch { }

    let cancelled = false;
    const poll = async () => {
      if (!_appActive || cancelled) return;
      setLoading(true);
      try {
        const data = await apiFetch<PortfolioBalances>('/portfolio/balances');
        if (!cancelled) {
          if (data) {
            setTokens(Array.isArray(data.tokens) ? data.tokens : []);
            setError(null);
          } else {
            setError('Failed to fetch wallet balance.');
          }
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Balance fetch failed.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    poll();
    const id = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [identity]);

  return { tokens, loading, solanaAddress, error };
}



/** Polls the portfolio history from the Node API. */
export function usePortfolioHistory(intervalMs = 30_000): PortfolioEvent[] {
  const [events, setEvents] = useState<PortfolioEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (!_appActive) return;
      const data = await apiFetch<PortfolioHistory>('/portfolio/history');
      if (!cancelled && data) setEvents(Array.isArray(data.events) ? data.events : []);
    };
    poll();
    const id = setInterval(poll, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [intervalMs]);

  return events;
}

export interface SweepResult {
  signature?: string; // omitted when routed via Kora (check `via` field)
  amount_usdc: number;
  destination: string;
  via?: 'kora';
}

/**
 * Transfer USDC from the node's hot wallet to `destination` (base58 wallet).
 * Calls POST /wallet/sweep on the local node API.
 */
export async function sweepUsdc(destination: string, amount?: number): Promise<SweepResult> {
  const res = await fetch(`${_apiBase}/wallet/sweep`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destination, amount }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface QuotePreview {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct?: number;
}

/** Fetches a swap quote from the node API. */
export function useTradeQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippageBps?: number;
}) {
  const [quote, setQuote] = useState<QuotePreview | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!params.inputMint || !params.outputMint || !params.amount) {
      setQuote(null);
      return;
    }

    let cancelled = false;
    const fetchQuote = async () => {
      setLoading(true);
      const url = `/trade/quote?inputMint=${params.inputMint}&outputMint=${params.outputMint}&amount=${params.amount}${params.slippageBps ? `&slippageBps=${params.slippageBps}` : ''}`;
      const data = await apiFetch<any>(url);
      if (!cancelled && data) {
        setQuote({
          inputMint: data.inputMint,
          outputMint: data.outputMint,
          inAmount: data.inAmount,
          outAmount: data.outAmount,
          priceImpactPct: parseFloat(data.priceImpactPct)
        });
      }
      setLoading(false);
    };

    const timer = setTimeout(fetchQuote, 500); // Debounce
    return () => { cancelled = true; clearTimeout(timer); };
  }, [params.inputMint, params.outputMint, params.amount, params.slippageBps]);

  return { quote, loading };
}

// ============================================================================
// Bridge capabilities + activity log
// ============================================================================

export interface BridgeLogEntry {
  time: string;
  timestamp: number;
  capability: string;
  action: string;
  outcome: 'ok' | 'denied' | 'disabled' | 'rate_limited' | 'error';
}

export const CAPABILITY_KEYS = [
  'messaging', 'contacts', 'location', 'camera',
  'microphone', 'screen', 'calls', 'calendar', 'media', 'motion',
] as const;

export type BridgeCapabilityKey = typeof CAPABILITY_KEYS[number];

const DEFAULT_CAPABILITIES: Record<BridgeCapabilityKey, boolean> = {
  messaging: true, contacts: true, location: true, camera: true,
  microphone: true, screen: true, calls: true, calendar: true, media: true,
  motion: true,
};

/** Read + write bridge capability toggles (persisted via SharedPreferences). */
export function useBridgeCapabilities(): {
  caps: Record<BridgeCapabilityKey, boolean>;
  loading: boolean;
  toggle: (key: BridgeCapabilityKey, value: boolean) => Promise<void>;
} {
  const [caps, setCaps] = useState<Record<BridgeCapabilityKey, boolean>>(DEFAULT_CAPABILITIES);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    NodeModule.getBridgeCapabilities()
      .then(raw => {
        setCaps(c => ({ ...c, ...raw } as Record<BridgeCapabilityKey, boolean>));
      })
      .catch(() => { })
      .finally(() => setLoading(false));
  }, []);

  const toggle = useCallback(async (key: BridgeCapabilityKey, value: boolean) => {
    await NodeModule.setBridgeCapability(key, value);
    setCaps(c => ({ ...c, [key]: value }));
  }, []);

  return { caps, loading, toggle };
}

/** Poll the bridge activity log every 10 seconds while screen is active. */
export async function fetchBridgeActivityLog(limit = 100): Promise<BridgeLogEntry[]> {
  const data = await apiFetch<BridgeLogEntry[]>(`/bridge/log?limit=${limit}`);
  return data ?? [];
}

/**
 * Executes a token swap via the node's internal Jupiter integration.
 */
export async function executeJupiterSwap(params: {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippageBps?: number;
}): Promise<{
  outAmount: number;
  txid: string;
} | null> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (_hostedToken) headers['Authorization'] = `Bearer ${_hostedToken}`;
    const res = await fetch(`${_apiBase}/trade/swap`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params)
    });
    if (!res.ok) {
      console.warn(`[nodeApi] /trade/swap failed: HTTP ${res.status}`);
      return null;
    }
    return res.json();
  } catch (e) {
    console.warn(`[nodeApi] executeJupiterSwap failed:`, e);
    return null;
  }
}

/** Poll the bridge activity log every 10 seconds while screen is active. */
export function useBridgeActivityLog(limit: number = 50): BridgeLogEntry[] {
  const [entries, setEntries] = useState<BridgeLogEntry[]>([]);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      if (!_appActive || cancelled) return;
      try {
        const raw = await NodeModule.getBridgeActivityLog(limit);
        const parsed = JSON.parse(raw);
        if (!cancelled && Array.isArray(parsed)) setEntries(parsed);
      } catch { /* native module not ready */ }
    };

    poll();
    const id = setInterval(poll, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [limit]);

  return entries;
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

// ============================================================================
// Bags fee-sharing config
// ============================================================================

export interface BagsConfigInfo {
  enabled: boolean;
  fee_bps: number;
  distribution_wallet: string | null;
  min_fee_micro: number;
}

/** Polls GET /bags/config every 60 seconds. Returns null while loading or when unavailable. */
export function useBagsConfig(intervalMs = 60_000): BagsConfigInfo | null {
  const [info, setInfo] = useState<BagsConfigInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (!_appActive) return;
      const data = await apiFetch<BagsConfigInfo>('/bags/config');
      if (!cancelled && data) setInfo(data);
    };
    poll();
    const id = setInterval(poll, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [intervalMs]);

  return info;
}

// ============================================================================
// Bags API key — Keychain storage
// ============================================================================

const BAGS_KEYCHAIN_SERVICE = 'zerox1.bags_api_key';

/** Save the Bags.fm API key to the OS Keychain (hardware-protected). */
export async function saveBagsApiKey(key: string): Promise<void> {
  await Keychain.setGenericPassword('bags_api_key', key, {
    service: BAGS_KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/** Load the Bags.fm API key from the OS Keychain. Returns null if not set. */
export async function loadBagsApiKey(): Promise<string | null> {
  try {
    const creds = await Keychain.getGenericPassword({ service: BAGS_KEYCHAIN_SERVICE });
    return creds ? creds.password : null;
  } catch {
    return null;
  }
}

/** Remove the Bags.fm API key from the OS Keychain. */
export async function clearBagsApiKey(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: BAGS_KEYCHAIN_SERVICE });
  } catch { /* already clear */ }
}

// ============================================================================
// Bags token launch + claim
// ============================================================================

export interface BagsToken {
  token_mint: string;
  name: string;
  symbol: string;
  txid: string;
  launched_at: number;
}

export interface BagsLaunchParams {
  name: string;
  symbol: string;
  description: string;
  /** Raw image as base64 string. Mutually exclusive with image_url. */
  image_bytes?: string;
  /** HTTPS URL to an already-hosted image. Mutually exclusive with image_bytes. */
  image_url?: string;
  website_url?: string;
  twitter_url?: string;
  telegram_url?: string;
  initial_buy_lamports?: number;
}

export interface BagsLaunchResult {
  token_mint: string;
  txid: string;
}

export interface BagsClaimResult {
  claimed_txs: number;
  total_claimed_usdc: number;
}

/** POST /bags/launch — create and launch a new token on Bags.fm. */
export async function bagsLaunch(params: BagsLaunchParams): Promise<BagsLaunchResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (_hostedToken) headers['Authorization'] = `Bearer ${_hostedToken}`;
  const res = await fetch(`${_apiBase}/bags/launch`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || `Launch failed: ${res.status}`);
  }
  return res.json();
}

/** POST /bags/claim — claim accumulated Bags pool fees for a launched token. */
export async function bagsClaim(token_mint: string): Promise<BagsClaimResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (_hostedToken) headers['Authorization'] = `Bearer ${_hostedToken}`;
  const res = await fetch(`${_apiBase}/bags/claim`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ token_mint }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || `Claim failed: ${res.status}`);
  }
  return res.json();
}

/** POST /bags/set-api-key — replace the Bags API key in-memory without restart. */
export async function setBagsApiKey(apiKey: string): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (_hostedToken) headers['Authorization'] = `Bearer ${_hostedToken}`;
  const res = await fetch(`${_apiBase}/bags/set-api-key`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || `set-api-key failed: ${res.status}`);
  }
}

/** Polls GET /bags/positions — agent's launched tokens. */
export function useBagsPositions(intervalMs = 60_000): BagsToken[] {
  const [tokens, setTokens] = useState<BagsToken[]>([]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (!_appActive) return;
      const data = await apiFetch<BagsToken[]>('/bags/positions');
      if (!cancelled && data) setTokens(Array.isArray(data) ? data : []);
    };
    poll();
    const id = setInterval(poll, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [intervalMs]);

  return tokens;
}

// ============================================================================
// DataBounty campaigns
// ============================================================================

export interface Campaign {
  id: string;
  data_type: 'imu' | 'gps' | 'audio' | 'camera' | string;
  title: string;
  description: string;
  collection_params: string; // JSON string
  payout_usdc_micro: number;
  max_samples_per_node: number;
  max_total_samples: number;
  samples_collected: number;
  expires_at: number;       // Unix seconds
  privacy_level: 'anonymized' | 'pseudonymized' | 'raw';
  data_retention_days: number;
  purpose: string;
  active: boolean;
  created_at: number;       // Unix seconds
}

export function useCampaigns(includeExpired = false): Campaign[] {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const reconnectDelay = useRef(1_000);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial fetch
  useEffect(() => {
    let cancelled = false;
    const url = `${AGGREGATOR_API}/campaigns${includeExpired ? '?include_expired=true' : ''}`;
    fetch(url)
      .then(r => r.ok ? r.json() : null)
      .then((data: Campaign[] | null) => {
        if (!cancelled && Array.isArray(data)) setCampaigns(data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [includeExpired]);

  // WS for real-time new campaigns
  useEffect(() => {
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(`${AGGREGATOR_WS}/ws/campaigns`);
      wsRef.current = ws;
      ws.onopen = () => { reconnectDelay.current = 1_000; };
      ws.onmessage = (e) => {
        try {
          const c: Campaign = JSON.parse(e.data);
          setCampaigns(prev => [c, ...prev]);
        } catch { /* malformed */ }
      };
      ws.onclose = () => {
        if (!stopped) {
          reconnectTimer.current = setTimeout(connect, reconnectDelay.current);
          reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30_000);
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      if (reconnectTimer.current !== null) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);

  return campaigns;
}

// ============================================================================
// Skill Manager
// ============================================================================

export interface Skill {
  name: string;
}

export function useSkills(): { skills: Skill[]; loading: boolean; refresh: () => void } {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const data = await apiFetch<{ skills: string[] }>('/skill/list');
    if (data?.skills) {
      setSkills(data.skills.map(name => ({ name })));
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { skills, loading, refresh };
}

export async function skillInstallUrl(name: string, url: string): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (_hostedToken) headers['Authorization'] = `Bearer ${_hostedToken}`;
  const res = await fetch(`${_apiBase}/skill/install-url`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, url }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
}

export async function skillRemove(name: string): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (_hostedToken) headers['Authorization'] = `Bearer ${_hostedToken}`;
  const res = await fetch(`${_apiBase}/skill/remove`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
}

// ============================================================================
// SOL price (Jupiter price API v2)
// ============================================================================

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export function useSolPrice(): number | null {
  const [price, setPrice] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetch_ = async () => {
      try {
        const res = await fetch(
          `https://api.jup.ag/price/v2?ids=${SOL_MINT}`,
        );
        const data = await res.json();
        const p = data?.data?.[SOL_MINT]?.price;
        if (!cancelled && p) setPrice(parseFloat(p));
      } catch {}
    };
    fetch_();
    const id = setInterval(fetch_, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return price;
}
