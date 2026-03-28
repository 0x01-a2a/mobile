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
let _isHostedMode = false;
let _heliusRpcUrl: string | null = null;

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

/** Configure the API base URLs and optional auth token at runtime. */
export function configureNodeApi(opts: {
  apiBase?: string;
  wsBase?: string;
  token?: string;
  hosted?: boolean;
  heliusApiKey?: string | null;
}) {
  if (opts.apiBase) _apiBase = opts.apiBase;
  if (opts.wsBase) _wsBase = opts.wsBase;
  if (opts.token !== undefined) _hostedToken = opts.token;
  if (opts.hosted !== undefined) _isHostedMode = opts.hosted;
  if (opts.heliusApiKey) {
    _heliusRpcUrl = `https://mainnet.helius-rpc.com/?api-key=${opts.heliusApiKey}`;
  }
}

export const AGGREGATOR_API = 'https://api.0x01.world';
export const AGGREGATOR_WS = 'wss://api.0x01.world';

// ============================================================================
// Types (mirrors node API responses)
// ============================================================================

export interface PeerSnapshot {
  agent_id: string;
  peer_id?: string;
  last_active_epoch: number;
  lease_ok?: boolean;
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

export function decodeBidPayload(
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
  const decoded = decodeBidPayload(env.payload_b64);
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
  token_address?: string;             // base58 mint; present when agent has launched a token
  downpayment_bps?: number;           // basis points required upfront; 0 or absent = none
  price_range_usd?: [number, number]; // [min, max] job price in USD
}

export interface SentOffer {
  conversation_id: string;
  agent_id: string;
  agent_name: string;
  token_address: string;
  description: string;
  price_range_usd?: [number, number];
  status: 'pending' | 'accepted' | 'delivered' | 'rejected' | 'completed';
  sent_at: number;             // unix ms
  delivered_payload?: string;  // populated when DELIVER arrives
  rejected_at?: number;        // unix ms; used for 24h auto-prune
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
): { authError: boolean } {
  const wsRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onEnvelope);
  const reconnectDelay = useRef(1_000);
  // M-1: Store the reconnect timer so we can cancel it on unmount.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const reconnectAttemptsRef = useRef(0);
  const [authError, setAuthError] = useState<boolean>(false);
  handlerRef.current = onEnvelope;

  const reconnect = useCallback(() => {
    if (!enabled || !mountedRef.current) return;
    try {
      let ws: WebSocket;
      if (_isHostedMode && _hostedToken) {
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
      } else if (_hostedToken) {
        // Local mode with auth: connect to /ws/inbox with the API secret.
        ws = new WebSocket(
          `${_wsBase}/ws/inbox`,
          undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { headers: { Authorization: `Bearer ${_hostedToken}` } } as any,
        );
      } else {
        ws = new WebSocket(`${_wsBase}/ws/inbox`);
      }
      ws.onopen = () => {
        reconnectDelay.current = 1_000;
        reconnectAttemptsRef.current = 0;
      };
      ws.onmessage = (e) => {
        try {
          const env: InboundEnvelope = JSON.parse(e.data);
          handlerRef.current(env);
        } catch { /* malformed */ }
      };
      ws.onerror = (e: WebSocketErrorEvent) => {
        const msg = (e as any)?.message ?? '';
        // HTTP 401/403 surfaces here in React Native. Stop reconnecting so
        // we don't spin forever with a bad hosted token (local mode retries).
        if (_isHostedMode && (msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized') || msg.includes('Forbidden'))) {
          reconnectDelay.current = -1; // sentinel: do not reconnect (hosted mode only)
          setAuthError(true);
        }
      };
      ws.onclose = () => {
        if (reconnectDelay.current < 0 || !mountedRef.current) return; // auth failure or unmounted — stop
        reconnectAttemptsRef.current += 1;
        if (reconnectAttemptsRef.current > 20) {
          reconnectDelay.current = -1; // give up after ~20 attempts
          return;
        }
        const delay = reconnectDelay.current;
        reconnectDelay.current = Math.min(delay * 2, 30_000);
        reconnectTimerRef.current = setTimeout(reconnect, delay);
      };
      wsRef.current = ws;
    } catch { /* node not running */ }
  }, [enabled]);

  useEffect(() => {
    mountedRef.current = true;
    reconnectDelay.current = 1_000; // reset backoff on enabled change
    reconnectAttemptsRef.current = 0;
    reconnect();
    return () => {
      mountedRef.current = false;
      // M-1: Cancel any pending reconnect timer before closing the socket.
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [reconnect]);

  return { authError };
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
  // M-5: Validate the URL before fetching to prevent SSRF via malicious aggregator data.
  try { assertValidHostUrl(apiUrl); } catch { return null; }
  const start = Date.now();
  try {
    const res = await fetch(`${apiUrl}/hosted/ping`, { signal: AbortSignal.timeout(5_000) });
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

  const res = await fetch(`${hostApiUrl}/hosted/register`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Registration failed: ${res.status}`);
  const data: { agent_id: string; token: string } = await res.json();

  // H-3: Validate the response fields before trusting them.
  if (typeof data.agent_id !== 'string' || !/^[0-9a-f]{64}$/.test(data.agent_id)) {
    throw new Error('Registration response contained an invalid agent_id');
  }
  if (typeof data.token !== 'string' || data.token.length < 8) {
    throw new Error('Registration response contained an invalid token');
  }

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
    hosted: true,
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
        'Your agent wallet has no SOL.\n\nSend a small amount of SOL to your agent wallet to cover the registration fee (~0.01 SOL), then try again.\n\nYour wallet address is shown under My Agent → Hot Wallet.',
      );
    }
    throw new Error(msg);
  }

  return res.json();
}

// ============================================================================
// 8004 registration badge
// ============================================================================

const REGISTRY_8004_URL = 'https://8004-indexer-production.up.railway.app/v2/graphql';
const _8004Cache = new Map<string, boolean>(); // hex pubkey → registered

/** Convert hex agent_id to base58 Solana pubkey string. */
function hexToBase58(hex: string): string | null {
  try {
    const { PublicKey } = require('@solana/web3.js');
    const bytes = Uint8Array.from((hex.match(/.{1,2}/g) ?? []).map((b: string) => parseInt(b, 16)));
    return new PublicKey(bytes).toBase58();
  } catch { return null; }
}

/** Query 8004 registry. Returns true if `hexPubkey` owner has ≥1 registered agent. */
async function fetch8004Status(hexPubkey: string): Promise<boolean> {
  const b58 = hexToBase58(hexPubkey);
  if (!b58) return false;
  try {
    const res = await fetch(REGISTRY_8004_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query($o:String!){agents(first:1,where:{owner:$o}){id}}',
        variables: { o: b58 },
      }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const agents = data?.data?.agents;
    return Array.isArray(agents) && agents.length > 0;
  } catch { return false; }
}

/**
 * Hook: returns whether `hexPubkey` is registered on the 8004 Solana Agent Registry.
 * Results are cached in-memory for the session.
 */
export function use8004Badge(hexPubkey: string | null | undefined): boolean {
  const [registered, setRegistered] = useState(
    hexPubkey ? (_8004Cache.get(hexPubkey) ?? false) : false,
  );

  useEffect(() => {
    if (!hexPubkey) return;
    if (_8004Cache.has(hexPubkey)) {
      setRegistered(_8004Cache.get(hexPubkey)!);
      return;
    }
    let cancelled = false;
    fetch8004Status(hexPubkey).then(ok => {
      if (cancelled) return;
      _8004Cache.set(hexPubkey, ok);
      setRegistered(ok);
    });
    return () => { cancelled = true; };
  }, [hexPubkey]);

  return registered;
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



export interface PhantomSplToken {
  mint: string;
  amount: number;
}

export interface PhantomBalance {
  address: string | null;
  sol: number | null;
  usdc: number | null;
  /** All SPL tokens with non-zero balance in the Phantom wallet. */
  splTokens: PhantomSplToken[];
  loading: boolean;
}

const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/**
 * Reads the linked Phantom owner wallet from AsyncStorage and fetches its
 * SOL balance + all SPL token holdings directly from Solana mainnet RPC.
 * Polls every 60s. Returns nulls/empty if no wallet is linked.
 */
export function usePhantomBalance(): PhantomBalance {
  const [address, setAddress] = useState<string | null>(null);
  const [sol, setSol] = useState<number | null>(null);
  const [usdc, setUsdc] = useState<number | null>(null);
  const [splTokens, setSplTokens] = useState<PhantomSplToken[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('zerox1:linked_wallet').then(a => setAddress(a ?? null)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    // RPC endpoints — Helius first when available (set via configureNodeApi).
    const RPCS = _heliusRpcUrl
      ? [_heliusRpcUrl, 'https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com']
      : ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];

    const rpcPost = async (rpc: string, body: object) => {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message ?? 'rpc error');
      return json;
    };

    const rpcWithFallback = async (body: object) => {
      for (const rpc of RPCS) {
        try { return await rpcPost(rpc, body); } catch { /* try next */ }
      }
      throw new Error('all RPCs failed');
    };

    let retryTimeout: ReturnType<typeof setTimeout> | null = null;

    const fetchAll = async () => {
      if (!_appActive || cancelled) return;
      setLoading(true);
      try {
        const [solData, tokenData] = await Promise.all([
          rpcWithFallback({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }),
          rpcWithFallback({ jsonrpc: '2.0', id: 2, method: 'getTokenAccountsByOwner', params: [address, { programId: TOKEN_PROGRAM_ID }, { encoding: 'jsonParsed' }] }),
        ]);
        if (!cancelled) {
          if (solData.result?.value !== undefined) setSol(solData.result.value / 1e9);
          const accounts: any[] = tokenData.result?.value ?? [];
          const tokens: PhantomSplToken[] = [];
          let usdcTotal = 0;
          for (const acc of accounts) {
            const info = acc.account?.data?.parsed?.info;
            const mint: string = info?.mint ?? '';
            const uiAmount: number = info?.tokenAmount?.uiAmount ?? 0;
            if (!mint || uiAmount <= 0) continue;
            tokens.push({ mint, amount: uiAmount });
            if (mint === USDC_MINT_MAINNET) usdcTotal += uiAmount;
          }
          setSplTokens(tokens);
          setUsdc(usdcTotal > 0 ? usdcTotal : null);
        }
      } catch {
        // Retry after 8s if we have no data yet, otherwise wait for next poll.
        if (!cancelled) {
          retryTimeout = setTimeout(() => { if (!cancelled) fetchAll(); }, 8_000);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchAll();
    const id = setInterval(fetchAll, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
      if (retryTimeout) clearTimeout(retryTimeout);
    };
  }, [address]);

  return { address, sol, usdc, splTokens, loading };
}

export interface SkrLeagueEntry {
  rank: number;
  wallet: string;
  label: string;
  earn_rate_pct: number;
  bags_fee_score: number;
  points: number;
  trade_count: number;
  active_days: number;
  skr_balance: number;
}

export interface SkrLeagueWalletView {
  wallet: string | null;
  skr_balance: number;
  has_access: boolean;
  rank: number | null;
  earn_rate_pct: number;
  bags_fee_score: number;
  points: number;
  trade_count: number;
  active_days: number;
  access_message: string;
}

export interface SkrLeagueSnapshot {
  title: string;
  season: string;
  ends_at: number;
  min_skr: number;
  reward_pool_skr: number;
  scoring: string[];
  rewards: string[];
  wallet: SkrLeagueWalletView;
  leaderboard: SkrLeagueEntry[];
}

export function useSkrLeague(intervalMs = 60_000): {
  data: SkrLeagueSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [wallet, setWallet] = useState<string | null>(null);
  const [data, setData] = useState<SkrLeagueSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem('zerox1:linked_wallet')
      .then(a => setWallet(a ?? null))
      .catch(() => setWallet(null));
  }, []);

  const refresh = useCallback(async () => {
    if (!_appActive) return;
    setLoading(true);
    setError(null);
    try {
      const linkedWallet = await AsyncStorage.getItem('zerox1:linked_wallet');
      const activeWallet = linkedWallet ?? null;
      if (activeWallet !== wallet) setWallet(activeWallet);
      const qs = activeWallet ? `?wallet=${encodeURIComponent(activeWallet)}` : '';
      const res = await fetch(`${AGGREGATOR_API}/league/current${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load SKR League');
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  return { data, loading, error, refresh };
}

export interface DexPrice {
  symbol: string;
  name: string;
  priceUsd: number;
}

/**
 * Fetches token metadata + USD price from DexScreener for the given mints.
 * Re-fetches when `mints` identity changes. Returns a Map<mint, DexPrice>.
 */
export function useDexPrices(mints: string[]): Map<string, DexPrice> {
  const [prices, setPrices] = useState<Map<string, DexPrice>>(new Map());
  const mintsKey = mints.slice().sort().join(',');

  useEffect(() => {
    if (mints.length === 0) { setPrices(new Map()); return; }
    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;

    const fetchPrices = async (attempt = 0) => {
      try {
        const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(',')}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: any[] = await res.json();
        if (cancelled || !Array.isArray(data)) return;
        const map = new Map<string, DexPrice>();
        for (const pair of data) {
          const mint: string = pair.baseToken?.address ?? '';
          if (!mint || map.has(mint)) continue;
          const price = parseFloat(pair.priceUsd ?? '0') || 0;
          if (price > 0) map.set(mint, { symbol: pair.baseToken?.symbol ?? '', name: pair.baseToken?.name ?? '', priceUsd: price });
        }
        if (!cancelled) setPrices(map);
      } catch {
        if (!cancelled && attempt < 3) {
          retryTimeout = setTimeout(() => fetchPrices(attempt + 1), (attempt + 1) * 3_000);
        }
      }
    };

    fetchPrices();
    return () => {
      cancelled = true;
      if (retryTimeout) clearTimeout(retryTimeout);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mintsKey]);

  return prices;
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

// ============================================================================
// SOL sweep
// ============================================================================

export interface SweepSolResult {
  signature: string;
  amount_lamports: number;
  amount_sol: number;
  destination: string;
}

/** Minimum SOL to keep in the hot wallet for transaction fees (~10 txs). */
const SOL_SWEEP_RESERVE_LAMPORTS = 10_000_000; // 0.01 SOL

/**
 * Sweep SOL from the node's hot wallet to `destination`, leaving 0.01 SOL
 * as a fee reserve. Uses POST /wallet/send with no mint (native SOL).
 *
 * `solBalance` is the human-readable SOL amount (e.g. 1.5 for 1.5 SOL).
 */
export async function sweepSol(
  destination: string,
  solBalance: number,
): Promise<SweepSolResult> {
  const totalLamports = Math.round(solBalance * 1e9);
  const sweepLamports = totalLamports - SOL_SWEEP_RESERVE_LAMPORTS;
  if (sweepLamports <= 0) {
    throw new Error('Insufficient SOL balance to sweep (minimum 0.01 SOL reserve required)');
  }
  const res = await fetch(`${_apiBase}/wallet/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: destination, amount: sweepLamports }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return {
    signature: data.signature ?? data.txid ?? '',
    amount_lamports: sweepLamports,
    amount_sol: sweepLamports / 1e9,
    destination,
  };
}

// ============================================================================
// Wallet send (SOL / any SPL)
// ============================================================================

export interface WalletSendResult {
  signature: string;
  amount: number;
  to: string;
}

/**
 * Send SOL or any SPL token from the node's hot wallet.
 * - No `mint`: native SOL transfer.
 * - `mint` present: SPL token transfer (destination ATA created automatically).
 */
export async function walletSend(
  to: string,
  amount: number,
  mint?: string,
): Promise<WalletSendResult> {
  const res = await fetch(`${_apiBase}/wallet/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, amount, mint }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

// ============================================================================
// Pending swap CA confirmation
// ============================================================================

export interface PendingSwap {
  swap_id: string;
  input_mint: string;
  output_mint: string;
  amount: number;
  slippage_bps: number;
  created_at: number;
  expires_at: number;
}

/** Poll GET /trade/swap/pending every 10 s. Returns [] when node is not local. */
export function usePendingSwaps(): {
  swaps: PendingSwap[];
  refresh: () => void;
  confirm: (swapId: string) => Promise<{ out_amount: number; txid: string }>;
  reject: (swapId: string) => Promise<void>;
} {
  const [swaps, setSwaps] = useState<PendingSwap[]>([]);

  const fetch_ = useCallback(async () => {
    if (_isHostedMode) return; // pending swaps only exist on the local node
    try {
      const res = await fetch(`${_apiBase}/trade/swap/pending`);
      if (res.ok) {
        const data = await res.json();
        setSwaps(data.pending ?? []);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, 10_000);
    return () => clearInterval(id);
  }, [fetch_]);

  const confirm = useCallback(async (swapId: string) => {
    const headers: Record<string, string> = {};
    if (_hostedToken) headers['Authorization'] = `Bearer ${_hostedToken}`;
    const res = await fetch(`${_apiBase}/trade/swap/confirm/${swapId}`, { method: 'POST', headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    await fetch_();
    return res.json();
  }, [fetch_]);

  const reject = useCallback(async (swapId: string) => {
    const headers: Record<string, string> = {};
    if (_hostedToken) headers['Authorization'] = `Bearer ${_hostedToken}`;
    await fetch(`${_apiBase}/trade/swap/reject/${swapId}`, { method: 'POST', headers });
    await fetch_();
  }, [fetch_]);

  return { swaps, refresh: fetch_, confirm, reject };
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
  // Notifications (requires Notification Listener permission)
  'notifications_read', 'notifications_reply', 'notifications_dismiss',
  // SMS
  'sms_read', 'sms_send',
  // Contacts / location / calendar / storage / sensors
  'contacts', 'location', 'calendar', 'media', 'motion',
  // A/V capture
  'camera', 'microphone',
  // Calls
  'calls',
  // Health
  'health', 'wearables',
  // Screen control (Accessibility Service)
  'screen_read_tree', 'screen_capture', 'screen_act',
  'screen_global_nav', 'screen_vision', 'screen_autonomy',
] as const;

export type BridgeCapabilityKey = typeof CAPABILITY_KEYS[number];

const DEFAULT_CAPABILITIES: Record<BridgeCapabilityKey, boolean> = {
  notifications_read: true, notifications_reply: true, notifications_dismiss: true,
  sms_read: true, sms_send: true,
  contacts: true, location: true, calendar: true, media: true, motion: true,
  camera: true, microphone: true,
  calls: true,
  health: true, wearables: true,
  screen_read_tree: true, screen_capture: true, screen_act: true,
  screen_global_nav: true, screen_vision: true, screen_autonomy: true,
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
  /** Claimable SOL from Bags pool trading fees (totalClaimableLamportsUserShare / 1e9). */
  claimable_sol: number;
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
  txids: string[];
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
      if (!cancelled && Array.isArray(data)) setTokens(data);
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
  label: string;
  description: string;
  icon: string;
}

const SKILL_CATALOG: Record<string, { label: string; description: string; icon: string }> = {
  bags: {
    label: 'Bags Token Launcher',
    description: 'Launch tokens on Bags.fm, execute swaps, check positions and claimable fees.',
    icon: 'BAGS',
  },
  launchlab: {
    label: 'Raydium LaunchLab',
    description: 'Buy and sell tokens on the Raydium bonding curve. Earns 0.1% share fee on every trade.',
    icon: 'RAY-LC',
  },
  cpmm: {
    label: 'Raydium CPMM Pool',
    description: 'Create constant-product liquidity pools on Raydium. Earn LP fees on every swap.',
    icon: 'RAY-LP',
  },
  health: {
    label: 'Health & Wearables',
    description: 'Read on-device health sensors — steps, heart rate, sleep, recovery — privately.',
    icon: 'HLTH',
  },
  skill_manager: {
    label: 'Skill Manager',
    description: 'Install new skills from a URL or let your agent write and self-install capabilities.',
    icon: 'MGR',
  },
  trade: {
    label: 'Jupiter + LaunchLab Trader',
    description: 'Full DeFi toolkit: Jupiter swaps aggregator and Raydium LaunchLab in one skill.',
    icon: 'JUP',
  },
};

export function useSkills(): { skills: Skill[]; loading: boolean; refresh: () => void } {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const data = await apiFetch<{ skills: string[] }>('/skill/list');
    if (data?.skills) {
      setSkills(data.skills.map(name => ({ name, ...(SKILL_CATALOG[name] ?? { label: name, description: '', icon: 'EXT' }) })));
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

// ============================================================================
// MPP — Machine Payment Protocol helpers
// ============================================================================

const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/**
 * Build a raw SPL Token Transfer instruction buffer.
 *   instruction[0] = 3  (Transfer discriminant)
 *   instruction[1..9]   = amount as little-endian u64
 */
function buildSplTransferData(amount: bigint): Uint8Array {
  const buf = new Uint8Array(9);
  buf[0] = 3; // Transfer
  // Write amount as 8-byte little-endian
  let remaining = amount;
  for (let i = 1; i <= 8; i++) {
    buf[i] = Number(remaining & BigInt(0xff));
    remaining >>= BigInt(8);
  }
  return buf;
}

interface MppChallenge {
  recipient: string;
  amount: number;
  mint: string;
  reference: string;
  expires_at: number;
}

/**
 * Pay the hosting fee for a hosted agent.
 *
 * Flow:
 *   1. GET <nodeApiUrl>/mpp/challenge          → challenge JSON
 *   2. Build SPL Token Transfer tx with reference pubkey in accounts
 *   3. Sign + sendTransaction via connection
 *   4. POST <nodeApiUrl>/mpp/verify            → { paid_until }
 *
 * @param nodeApiUrl   Base URL of the host node API (e.g. "https://host.example.com:9091")
 * @param authToken    Hosted session bearer token
 * @param payerPublicKey   Agent's Solana public key
 * @param payerSecretKey   Agent's Solana secret key bytes (64 bytes)
 * @param connection   Solana web3.js Connection
 * @param agentIdHex   Hex-encoded agent_id (64 hex chars)
 */
export async function payHostingFee(
  nodeApiUrl: string,
  authToken: string,
  payerPublicKey: string,
  payerSecretKey: Uint8Array,
  connection: {
    getRecentBlockhash: () => Promise<{ blockhash: string }>;
    sendRawTransaction: (tx: Uint8Array) => Promise<string>;
  },
  agentIdHex: string,
): Promise<{ paid_until: number }> {
  // Step 1: Get challenge
  const challengeRes = await fetch(`${nodeApiUrl}/mpp/challenge`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!challengeRes.ok) {
    throw new Error(`MPP challenge failed: ${challengeRes.status}`);
  }
  const challenge: MppChallenge = await challengeRes.json();

  if (Date.now() / 1000 > challenge.expires_at) {
    throw new Error('MPP challenge already expired');
  }

  // Step 2+3: Build, sign, and send
  const { blockhash } = await connection.getRecentBlockhash();
  const signedTx = await signTransaction(
    null,
    blockhash,
    payerPublicKey,
    payerSecretKey,
    challenge.reference,
    challenge.recipient,
    BigInt(challenge.amount),
  );
  const txSig = await connection.sendRawTransaction(signedTx);

  // Step 4: Verify
  const verifyRes = await fetch(`${nodeApiUrl}/mpp/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ tx_sig: txSig, reference: challenge.reference, agent_id: agentIdHex }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!verifyRes.ok) {
    const err = await verifyRes.json().catch(() => ({}));
    throw new Error(err?.error ?? `MPP verify failed: ${verifyRes.status}`);
  }
  return verifyRes.json();
}

/**
 * Pay the protocol fee to the 0x01 aggregator.
 *
 * Flow:
 *   1. GET <aggregatorUrl>/mpp/protocol-fee/challenge?kind=hosted  → challenge JSON
 *   2. Build SPL Token Transfer tx with reference pubkey in accounts
 *   3. Sign + sendTransaction via connection
 *   4. POST <aggregatorUrl>/mpp/protocol-fee/verify               → { paid_until }
 *
 * @param aggregatorUrl    Aggregator base URL (e.g. "https://api.0x01.world")
 * @param agentId          Agent ID (hex or base58)
 * @param payerPublicKey   Agent's Solana public key (base58)
 * @param payerSecretKey   Agent's Solana secret key bytes
 * @param connection       Solana connection
 * @param kind             'hosted' | 'self_hosted'
 */
export async function payProtocolFee(
  aggregatorUrl: string,
  agentId: string,
  payerPublicKey: string,
  payerSecretKey: Uint8Array,
  connection: {
    getRecentBlockhash: () => Promise<{ blockhash: string }>;
    sendRawTransaction: (tx: Uint8Array) => Promise<string>;
  },
  kind: 'hosted' | 'self_hosted' = 'hosted',
): Promise<{ paid_until: number }> {
  // Step 1: Get challenge
  const challengeRes = await fetch(
    `${aggregatorUrl}/mpp/protocol-fee/challenge?kind=${kind}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!challengeRes.ok) {
    throw new Error(`MPP protocol-fee challenge failed: ${challengeRes.status}`);
  }
  const challenge: MppChallenge = await challengeRes.json();

  if (Date.now() / 1000 > challenge.expires_at) {
    throw new Error('MPP protocol-fee challenge already expired');
  }

  // Step 2: Build + sign + send tx
  const { blockhash } = await connection.getRecentBlockhash();
  const signedTx = await signTransaction(
    null,
    blockhash,
    payerPublicKey,
    payerSecretKey,
    challenge.reference,
    challenge.recipient,
    BigInt(challenge.amount),
  );
  const txSig = await connection.sendRawTransaction(signedTx);

  // Step 3: Verify
  const verifyRes = await fetch(`${aggregatorUrl}/mpp/protocol-fee/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx_sig: txSig, reference: challenge.reference, agent_id: agentId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!verifyRes.ok) {
    const err = await verifyRes.json().catch(() => ({}));
    throw new Error(err?.error ?? `MPP protocol-fee verify failed: ${verifyRes.status}`);
  }
  return verifyRes.json();
}

/**
 * Build and sign a Solana SPL Token Transfer transaction.
 *
 * The transaction includes:
 *   - One SPL Token Transfer instruction (from payer's USDC ATA → recipient ATA)
 *   - The reference pubkey as a read-only non-signer account
 *     (this is how MPP makes transactions findable on-chain)
 *
 * Returns the serialised transaction bytes ready to send via sendRawTransaction.
 */
async function signTransaction(
  _unusedTx: null,
  blockhash: string,
  payerPublicKey: string,
  payerSecretKey: Uint8Array,
  referencePubkey: string,
  recipientAta?: string,
  amount?: bigint,
): Promise<Uint8Array> {
  // Dynamically import @solana/web3.js to avoid bundling it unconditionally.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const web3 = require('@solana/web3.js');
  const { Transaction, TransactionInstruction, PublicKey, AccountMeta } = web3;

  const payer = new PublicKey(payerPublicKey);
  const refKey = new PublicKey(referencePubkey);
  const tokenProgram = new PublicKey(SPL_TOKEN_PROGRAM_ID);

  if (!recipientAta || amount === undefined) {
    throw new Error('recipient and amount required for MPP transaction');
  }

  const recipient = new PublicKey(recipientAta);

  // Derive payer's USDC ATA (same formula as on-chain ATA derivation).
  // For simplicity, the caller must ensure the payer ATA exists.
  const payerAta = await deriveAta(payer, tokenProgram);

  const data = buildSplTransferData(amount);

  const keys: typeof AccountMeta[] = [
    { pubkey: payerAta,    isSigner: false, isWritable: true },
    { pubkey: recipient,   isSigner: false, isWritable: true },
    { pubkey: payer,       isSigner: true,  isWritable: false },
    // Reference pubkey — read-only, non-signer; makes this tx uniquely findable
    { pubkey: refKey,      isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({ keys, programId: tokenProgram, data });

  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer;
  tx.add(ix);

  // Sign with payer secret key.
  const keypair = web3.Keypair.fromSecretKey(payerSecretKey);
  tx.sign(keypair);

  return tx.serialize();
}

/**
 * Derive the Associated Token Account for a given owner and the USDC mint.
 * Returns the ATA PublicKey.
 */
async function deriveAta(owner: unknown, _tokenProgram: unknown): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const web3 = require('@solana/web3.js');
  const { PublicKey } = web3;
  const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJo');
  const SPL_TOKEN = new PublicKey(SPL_TOKEN_PROGRAM_ID);
  const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const [ata] = PublicKey.findProgramAddressSync(
    [
      (owner as { toBuffer: () => Uint8Array }).toBuffer(),
      SPL_TOKEN.toBuffer(),
      USDC_MINT.toBuffer(),
    ],
    ATA_PROGRAM_ID,
  );
  return ata;
}

/** @internal — exported for tests only */
export function _buildSplTransferData(amount: bigint): Uint8Array {
  return buildSplTransferData(amount);
}

// ============================================================================
// Task audit log
// ============================================================================

export interface TaskLogEntry {
  id: number;
  timestamp: number;
  category: string;
  outcome: string;
  amount_usd: number;
  duration_min: number;
  summary: string;
  shared: boolean;
}

/** Fetch task log entries from the node. Returns [] if node is unreachable or log not configured. */
export async function fetchTaskLog(limit = 50, before_id?: number): Promise<TaskLogEntry[]> {
  try {
    const headers: Record<string, string> = {};
    if (_hostedToken) headers['Authorization'] = `Bearer ${_hostedToken}`;
    const qs = before_id != null ? `?limit=${limit}&before_id=${before_id}` : `?limit=${limit}`;
    const res = await fetch(`${_apiBase}/tasks/log${qs}`, { headers });
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

/** Mark a task log entry as shared. */
export async function markTaskShared(id: number): Promise<boolean> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (_hostedToken) headers['Authorization'] = `Bearer ${_hostedToken}`;
    const res = await fetch(`${_apiBase}/tasks/log/${id}/shared`, { method: 'PATCH', headers });
    return res.ok;
  } catch { return false; }
}

/** Delete a task log entry. */
export async function deleteTaskEntry(id: number, apiSecret: string | null): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (apiSecret) headers['Authorization'] = `Bearer ${apiSecret}`;
    else if (_hostedToken) headers['Authorization'] = `Bearer ${_hostedToken}`;
    const res = await fetch(`${_apiBase}/tasks/log/${id}`, { method: 'DELETE', headers });
    return res.ok;
  } catch { return false; }
}

/** Poll the task audit log. Re-fetches on mount and when refreshTick changes. */
export function useTaskLog(refreshTick = 0) {
  const [entries, setEntries] = useState<TaskLogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await fetchTaskLog(50);
    setEntries(data);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load, refreshTick]);

  return { entries, loading, reload: load };
}

// ============================================================================
// Bounty feed + capability search (aggregator-backed)
// ============================================================================

export interface BountyEntry {
  id: number;
  sender: string;               // hex agent_id
  required_capability: string;
  max_budget_usd: number;
  deadline_at: number;          // unix epoch seconds, 0 = no deadline
  task_summary: string;
  conversation_id: string;
  ts: number;
}

export function useBountyFeed(capability?: string, refreshTick = 0): {
  bounties: BountyEntry[];
  loading: boolean;
  reload: () => void;
} {
  const [bounties, setBounties] = useState<BountyEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const url = capability
      ? `${AGGREGATOR_API}/bounties?capability=${encodeURIComponent(capability)}&limit=50`
      : `${AGGREGATOR_API}/bounties?limit=50`;
    fetch(url)
      .then(r => r.ok ? r.json() : [])
      .then((data: BountyEntry[]) => { if (!cancelled) setBounties(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setBounties([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [capability, tick, refreshTick]);

  return { bounties, loading, reload };
}

// ── Sent offers (outbound job tracker) ──────────────────────────────────────

const SENT_OFFERS_KEY = 'zerox1:sent_offers';

function filterDisplayOffers(all: SentOffer[]): SentOffer[] {
  const now = Date.now();
  return all.filter(o => {
    if (o.status === 'completed') return false;
    if (o.status === 'rejected' && o.rejected_at && now - o.rejected_at > 86_400_000) return false;
    return true;
  });
}

export function useSentOffers(): {
  offers: SentOffer[];
  addOffer: (offer: SentOffer) => void;
  updateStatus: (conversation_id: string, status: SentOffer['status'], extra?: Partial<SentOffer>) => void;
} {
  const [offers, setOffers] = useState<SentOffer[]>([]);

  useEffect(() => {
    AsyncStorage.getItem(SENT_OFFERS_KEY).then(raw => {
      if (!raw) return;
      setOffers(filterDisplayOffers(JSON.parse(raw)));
    }).catch(() => {});
  }, []);

  const addOffer = useCallback((offer: SentOffer) => {
    AsyncStorage.getItem(SENT_OFFERS_KEY).then(raw => {
      const all: SentOffer[] = raw ? JSON.parse(raw) : [];
      const next = [offer, ...all].slice(0, 100);
      AsyncStorage.setItem(SENT_OFFERS_KEY, JSON.stringify(next)).catch(() => {});
      setOffers(filterDisplayOffers(next));
    }).catch(() => {});
  }, []);

  const updateStatus = useCallback((
    conversation_id: string,
    status: SentOffer['status'],
    extra?: Partial<SentOffer>,
  ) => {
    AsyncStorage.getItem(SENT_OFFERS_KEY).then(raw => {
      const all: SentOffer[] = raw ? JSON.parse(raw) : [];
      const next = all.map(o =>
        o.conversation_id === conversation_id ? { ...o, status, ...extra } : o,
      );
      AsyncStorage.setItem(SENT_OFFERS_KEY, JSON.stringify(next)).catch(() => {});
      setOffers(filterDisplayOffers(next));
    }).catch(() => {});
  }, []);

  return { offers, addOffer, updateStatus };
}

/** Attempt to buy an agent's token via the node wallet API.
 *  Returns 'ok' | 'not_implemented' | 'error'.
 *  'not_implemented' means the endpoint doesn't exist yet — caller shows a manual-payment toast. */
export async function buyAgentToken(
  tokenAddress: string,
  amountUsd: number,
): Promise<'ok' | 'not_implemented' | 'error'> {
  try {
    const res = await fetch(`${_apiBase}/wallet/bags-buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token_address: tokenAddress, amount_usd: amountUsd }),
    });
    if (res.ok) return 'ok';
    if (res.status === 404) return 'not_implemented';
    return 'error';
  } catch {
    return 'error';
  }
}

export function useAgentSearch(capability: string): {
  results: AgentSummary[];
  loading: boolean;
} {
  const [results, setResults] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!capability.trim()) { setResults([]); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`${AGGREGATOR_API}/agents/search?capability=${encodeURIComponent(capability.trim())}&limit=30`)
      .then(r => r.ok ? r.json() : [])
      .then((data: AgentSummary[]) => { if (!cancelled) setResults(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setResults([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [capability]);

  return { results, loading };
}
