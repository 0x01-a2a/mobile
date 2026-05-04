/**
 * useZeroclawChat — hook for chatting with the local ZeroClaw agent brain.
 *
 * ZeroClaw exposes a gateway HTTP server on localhost. The endpoint
 * POST /api/chat takes { message, session_id } and returns { reply, model, session_id }.
 *
 * Sessions are scoped per agent ID so switching agents always starts a fresh
 * ZeroClaw conversation. Call resetSession() to manually clear within one agent.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NodeModule } from '../native/NodeModule';

// Gateway ports differ by platform:
// - iOS in-process FFI binds zeroclaw on 9093 to avoid clashing with
//   zerox1-node (9090) and the phone bridge (9092).
// - Android uses the regular gateway port 42617.
// Keep a legacy iOS fallback to 42617 so stale local static libs do not
// strand chat if the app source and bundled binary drift.
const GATEWAY_CANDIDATES = Platform.OS === 'ios'
  ? ['http://127.0.0.1:9093', 'http://127.0.0.1:42617']
  : ['http://127.0.0.1:42617'];
const SESSION_KEY_PREFIX = 'zerox1:zeroclaw_session';
const MESSAGES_KEY_PREFIX = 'zerox1:zeroclaw_messages';
const REQUEST_TIMEOUT = Platform.OS === 'ios' ? 90_000 : 60_000;   // ms
const IOS_BRAIN_START_TIMEOUT = 95_000; // ms — matches Swift waitForGatewayReady (90s) + margin
const IOS_GATEWAY_PROBE_TIMEOUT = 1_000; // ms
const MAX_STORED_MESSAGES = 200;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts: number;
  imageUri?: string;  // local file URI for display thumbnail
  imageCid?: string;  // blob store CID (hex)
}

export interface UseZeroclawChatResult {
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  send: (text: string, image?: { uri: string; base64: string; mime: string; cid?: string }) => Promise<void>;
  resetSession: () => Promise<void>;
  injectSystemMessage: (text: string) => void;
  prewarm: () => void;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatBridgeDebug(auth: any): string {
  if (!auth) return 'bridge=null';
  return [
    `nodeRunning=${auth.nodeRunning ?? 'undefined'}`,
    `agentRunning=${auth.agentRunning ?? 'undefined'}`,
    `brainError=${auth.brainError ?? 'null'}`,
    `brainCfg=${auth._dbg_brainCfgEnabled ?? 'undefined'}`,
    `llmKey=${auth._dbg_llmKeyInChain ?? 'undefined'}`,
    `token=${auth.nodeApiToken ? 'yes' : 'no'}`,
    `raw=${safeStringify(auth)}`,
  ].join(', ');
}

function genId(): string {
  // Use crypto.getRandomValues when available (Hermes release builds, M-7).
  // Fall back to Math.random for dev/Metro environments where global crypto
  // may not be polyfilled.
  if (typeof crypto !== 'undefined' && crypto?.getRandomValues) {
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    return `${Date.now()}-${buf[0].toString(36)}${buf[1].toString(36)}`;
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function sessionKey(agentId?: string, conversationId?: string): string {
  const base = agentId ? `${SESSION_KEY_PREFIX}_${agentId}` : SESSION_KEY_PREFIX;
  return conversationId ? `${base}_${conversationId}` : base;
}

function messagesKey(agentId?: string, conversationId?: string): string {
  const base = agentId ? `${MESSAGES_KEY_PREFIX}_${agentId}` : MESSAGES_KEY_PREFIX;
  return conversationId ? `${base}_${conversationId}` : base;
}

export function useZeroclawChat(agentId?: string, conversationId?: string): UseZeroclawChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const gatewayTokenRef = useRef<string | null>(null);
  const gatewayUrlRef = useRef<string>(GATEWAY_CANDIDATES[0]);
  const systemContextRef = useRef<string[]>([]);

  // Track the current key so async callbacks always write to the right slot.
  const sessionKeyRef = useRef(sessionKey(agentId, conversationId));
  const messagesKeyRef = useRef(messagesKey(agentId, conversationId));

  // When agentId or conversationId changes: reset in-memory state and load the persisted session.
  useEffect(() => {
    const key = sessionKey(agentId, conversationId);
    const mKey = messagesKey(agentId, conversationId);
    sessionKeyRef.current = key;
    messagesKeyRef.current = mKey;

    // Clear state synchronously so the UI empties immediately before async load.
    sessionRef.current = null;
    setMessages([]);
    setError(null);

    // Restore persisted messages for this session.
    AsyncStorage.getItem(mKey).then(raw => {
      if (messagesKeyRef.current !== mKey || !raw) return;
      try {
        const saved: ChatMessage[] = JSON.parse(raw);
        if (Array.isArray(saved) && saved.length > 0) setMessages(saved);
      } catch {}
    });

    // Build wallet identity context so ZeroClaw knows about its Solana wallet.
    if (agentId && agentId.length === 64) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PublicKey } = require('@solana/web3.js');
        const bytes = Uint8Array.from(
          (agentId.match(/.{1,2}/g) ?? []).map((b: string) => parseInt(b, 16))
        );
        const solanaAddress = new PublicKey(bytes).toBase58();
        const baseContext = [
          `You are an autonomous agent on the 0x01 mesh network (zerox1).`,
          `Your agent ID (hex): ${agentId}`,
          `Your Solana wallet address (base58): ${solanaAddress}`,
          `You have an on-chain hot wallet on Solana mainnet used for task rewards, staking, and USDC payments on the mesh.`,
          `IMPORTANT: The Solana CLI is not available on this device. Never run "solana", "which solana", or similar CLI commands.`,
          `To check your wallet balance, call: GET http://127.0.0.1:9090/portfolio/balances with header "Authorization: Bearer <nodeApiToken>". The nodeApiToken is the same token configured in your zerox1 channel.`,
        ];
        systemContextRef.current = baseContext;

        // Fetch live balance and append it to context once resolved.
        NodeModule.getLocalAuthConfig()
          .then(auth => {
            if (!auth.nodeApiToken || sessionKeyRef.current !== key) return null;
            return fetch('http://127.0.0.1:9090/portfolio/balances', {
              headers: { Authorization: `Bearer ${auth.nodeApiToken}` },
            }).then(r => r.ok ? r.json() : null);
          })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .then((data: any) => {
            // M-3: Do NOT include wallet balance in the LLM context to prevent
            // social engineering via crafted task descriptions. The agent can
            // query the balance itself via the API if needed.
            if (!data?.tokens || sessionKeyRef.current !== key) return;
            // Balance fetched successfully — context stays as baseContext (no balance line).
          })
          .catch(() => { /* balance fetch failed — context stays without balance line */ });
      } catch {
        systemContextRef.current = [];
      }
    } else {
      systemContextRef.current = [];
    }

    // Attempt to restore a previously saved session for this agent.
    AsyncStorage.getItem(key).then(id => {
      // Guard: agentId may have changed again by the time the promise resolves.
      if (sessionKeyRef.current === key && id) {
        sessionRef.current = id;
      }
    });

    NodeModule.getLocalAuthConfig()
      .then(auth => {
        if (sessionKeyRef.current === key) {
          gatewayTokenRef.current = auth.gatewayToken;
        }
      })
      .catch(() => {
        if (sessionKeyRef.current === key) {
          gatewayTokenRef.current = null;
        }
      });
  }, [agentId, conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const getOrCreateSession = useCallback(async (): Promise<string> => {
    if (sessionRef.current) return sessionRef.current;
    const id = genId();
    sessionRef.current = id;
    await AsyncStorage.setItem(sessionKeyRef.current, id);
    return id;
  }, []);

  const resolveGatewayUrl = useCallback(async (forceProbe = false): Promise<string | null> => {
    const candidates = forceProbe
      ? GATEWAY_CANDIDATES
      : [gatewayUrlRef.current, ...GATEWAY_CANDIDATES.filter(url => url !== gatewayUrlRef.current)];

    for (const url of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IOS_GATEWAY_PROBE_TIMEOUT);
      try {
        const resp = await fetch(`${url}/health`, { signal: controller.signal });
        clearTimeout(timer);
        if (__DEV__ && Platform.OS === 'ios') {
          console.log('[ZeroClawChat] gateway health', url, resp.status);
        }
        if (resp.ok) {
          gatewayUrlRef.current = url;
          return url;
        }
      } catch {
        clearTimeout(timer);
        if (__DEV__ && Platform.OS === 'ios') {
          console.log('[ZeroClawChat] gateway health failed', url);
        }
      }
    }

    return null;
  }, []);

  const send = useCallback(async (
    text: string,
    image?: { uri: string; base64: string; mime: string; cid?: string },
  ) => {
    const trimmed = text.trim();
    if (!trimmed && !image || loading) return;

    // Build the message text sent to zeroclaw.
    // Images are embedded inline using the [IMAGE:data:<mime>;base64,<data>] marker
    // so the LLM receives actual image bytes regardless of blob-store availability.
    // If a CID is also available (local-mode upload succeeded), append it as a URL
    // reference so the agent can use it for tasks like bags_launch image_url.
    let messageText: string;
    if (image) {
      const imageMarker = `[IMAGE:data:${image.mime};base64,${image.base64}]`;
      const cidRef = image.cid
        ? ` (also available at https://api.0x01.world/blobs/${image.cid})`
        : '';
      messageText = trimmed
        ? `${trimmed}\n${imageMarker}${cidRef}`
        : `${imageMarker}${cidRef}`;
    } else {
      messageText = trimmed;
    }

    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      text: trimmed,
      ts: Date.now(),
      imageUri: image?.uri,
      imageCid: image?.cid,
    };
    setMessages(prev => {
      const next = [...prev, userMsg];
      AsyncStorage.setItem(messagesKeyRef.current, JSON.stringify(next.slice(-MAX_STORED_MESSAGES))).catch(() => {});
      return next;
    });
    setLoading(true);
    setError(null);

    try {
      const sessionId = await getOrCreateSession();
      const auth = await NodeModule.getLocalAuthConfig();
      if (__DEV__ && Platform.OS === 'ios') {
        console.log('[ZeroClawChat] getLocalAuthConfig raw', JSON.stringify(auth));
      }
      gatewayTokenRef.current = auth.gatewayToken;
      if (!auth.agentRunning) {
        // On iOS, brain might not have started if the node was already running
        // when startNode was called (the early-return path). Try to start it now.
        if (Platform.OS === 'ios') {
          try {
            const brainRaw = await AsyncStorage.getItem('zerox1:agent_brain');
            const brain = brainRaw ? JSON.parse(brainRaw) : null;
            if (brain?.enabled && brain?.apiKeySet) {
              // Load saved node config so we can restart with full params if needed.
              const savedCfgRaw = await AsyncStorage.getItem('zerox1:node_config');
              const savedCfg = savedCfgRaw ? JSON.parse(savedCfgRaw) : {};
              const startConfig = {
                ...savedCfg,
                agentBrainEnabled: true,
                llmProvider: brain.provider ?? 'default',
                llmModel: brain.customModel ?? '',
                llmBaseUrl: brain.customBaseUrl ?? '',
                capabilities: JSON.stringify(brain.capabilities ?? []),
                minFeeUsdc: brain.minFeeUsdc ?? 5,
                minReputation: brain.minReputation ?? 50,
                autoAccept: brain.autoAccept ?? false,
              };
              if ((auth as any).nodeRunning === false) {
                setError('Starting local agent node...');
                await NodeModule.startNode(startConfig);
              } else {
                setError('Starting agent brain...');
                // Use the dedicated iOS bridge call: when the node is already
                // running we only need to start zeroclaw, not re-enter the full
                // node startup path.
                await NodeModule.startBrainIfNeeded(startConfig);
              }
              // Poll for brain to start — node may need up to 60s to become ready,
              // then zeroclaw starts. Also probe gateway directly (GET /health is
              // always public) to bypass any Swift isAgentRunning flag race.
              const pollDeadline = Date.now() + IOS_BRAIN_START_TIMEOUT;
              let auth2 = await NodeModule.getLocalAuthConfig();
              let gatewayResponded = false;
              while (!auth2.agentRunning && !gatewayResponded && Date.now() < pollDeadline) {
                await new Promise<void>(resolve => setTimeout(() => resolve(), 2000));
                auth2 = await NodeModule.getLocalAuthConfig();
                if (!auth2.agentRunning) {
                  gatewayResponded = !!(await resolveGatewayUrl(true));
                }
              }
              if (auth2.agentRunning || gatewayResponded) {
                if (__DEV__ && Platform.OS === 'ios') {
                  console.log('[ZeroClawChat] post-start auth', JSON.stringify(auth2));
                }
                gatewayTokenRef.current = auth2.gatewayToken;
                setError(null);
                // Brain started — continue with the request below.
              } else {
                throw new Error(`Agent brain did not start in time. ${formatBridgeDebug(auth2)}`);
              }
            } else {
              throw new Error('Agent brain is not enabled. Enable it in You → Brain and add your API key.');
            }
          } catch (e: any) {
            if (e.message?.includes('Brain') || e.message?.includes('brain')) throw e;
            throw new Error('Agent brain is not running. Enable it in You → Brain and restart the node.');
          }
        } else {
          throw new Error('Agent brain is not running. Enable it in You → Brain and restart the node.');
        }
      }

      let gatewayUrl = await resolveGatewayUrl();
      if (!gatewayUrl && Platform.OS === 'ios') {
        try {
          await NodeModule.reloadAgent();
          await new Promise<void>(resolve => setTimeout(() => resolve(), 2500));
          gatewayUrl = await resolveGatewayUrl(true);
        } catch {
          // Fall through to the debug error below.
        }
      }
      if (!gatewayUrl) {
        const dbg = await NodeModule.getLocalAuthConfig().catch(() => null as any);
        if (__DEV__ && Platform.OS === 'ios') {
          console.log('[ZeroClawChat] unreachable gateway debug', JSON.stringify(dbg));
        }
        throw new Error(`Local chat gateway is unreachable on ports ${GATEWAY_CANDIDATES.map(url => url.split(':').pop()).join('/')}. ${formatBridgeDebug(dbg)}`);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (gatewayTokenRef.current) {
        headers.Authorization = `Bearer ${gatewayTokenRef.current}`;
      }

      const resp = await fetch(`${gatewayUrl}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: messageText,
          session_id: sessionId,
          context: systemContextRef.current,
        }),
        signal: controller.signal,
      });
      if (__DEV__ && Platform.OS === 'ios') {
        console.log('[ZeroClawChat] chat response status', resp.status);
      }
      clearTimeout(timer);

      if (!resp.ok) {
        // If the session is invalid (server restarted), clear it and retry once without a session.
        if ((resp.status === 401 || resp.status === 404) && sessionRef.current) {
          sessionRef.current = null;
          await AsyncStorage.removeItem(sessionKeyRef.current).catch(() => {});
          const retryController = new AbortController();
          const retryTimer = setTimeout(() => retryController.abort(), REQUEST_TIMEOUT);
          const retryHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
          if (gatewayTokenRef.current) {
            retryHeaders.Authorization = `Bearer ${gatewayTokenRef.current}`;
          }
          const retryGatewayUrl = await resolveGatewayUrl(true);
          if (!retryGatewayUrl) {
            throw new Error('Local chat gateway is unreachable after session reset.');
          }
          const retryResp = await fetch(`${retryGatewayUrl}/api/chat`, {
            method: 'POST',
            headers: retryHeaders,
            body: JSON.stringify({
              message: messageText,
              context: systemContextRef.current,
            }),
            signal: retryController.signal,
          });
          clearTimeout(retryTimer);
          if (!retryResp.ok) {
            const retryBody = await retryResp.text().catch(() => '');
            throw new Error(`Gateway error ${retryResp.status}${retryBody ? ': ' + retryBody : ''}`);
          }
          const retryData: { reply: string; model?: string; session_id?: string } =
            await retryResp.json();
          if (retryData.session_id) {
            sessionRef.current = retryData.session_id;
            await AsyncStorage.setItem(sessionKeyRef.current, retryData.session_id);
          }
          const retryMsg: ChatMessage = {
            id: genId(),
            role: 'assistant',
            text: retryData.reply,
            ts: Date.now(),
          };
          setMessages(prev => {
            const next = [...prev, retryMsg];
            AsyncStorage.setItem(messagesKeyRef.current, JSON.stringify(next.slice(-MAX_STORED_MESSAGES))).catch(() => {});
            return next;
          });
          if (AppState.currentState !== 'active') {
            const preview = retryData.reply.replace(/\s+/g, ' ').slice(0, 120);
            NodeModule.showChatNotification(preview).catch(() => {});
          }
          return;
        }
        const body = await resp.text().catch(() => '');
        throw new Error(`Gateway error ${resp.status}${body ? ': ' + body : ''}`);
      }

      const data: { reply: string; model?: string; session_id?: string } =
        await resp.json();

      // Server may echo back a new session_id; keep it in sync.
      if (data.session_id && data.session_id !== sessionRef.current) {
        sessionRef.current = data.session_id;
        await AsyncStorage.setItem(sessionKeyRef.current, data.session_id);
      }

      const assistantMsg: ChatMessage = {
        id: genId(),
        role: 'assistant',
        text: data.reply,
        ts: Date.now(),
      };
      setMessages(prev => {
        const next = [...prev, assistantMsg];
        AsyncStorage.setItem(messagesKeyRef.current, JSON.stringify(next.slice(-MAX_STORED_MESSAGES))).catch(() => {});
        return next;
      });

      // Notify user if app is in the background
      if (AppState.currentState !== 'active') {
        const preview = data.reply.replace(/\s+/g, ' ').slice(0, 120);
        NodeModule.showChatNotification(preview).catch(() => {});
      }
    } catch (err: unknown) {
      if (__DEV__ && Platform.OS === 'ios') {
        console.log('[ZeroClawChat] send error', err instanceof Error ? err.message : String(err));
      }
      const msg =
        err instanceof Error
          ? err.name === 'AbortError'
            ? `Chat request timed out after ${Math.round(REQUEST_TIMEOUT / 1000)}s.`
            : err.message
          : 'Unknown error';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [loading, getOrCreateSession, resolveGatewayUrl]);

  const resetSession = useCallback(async () => {
    sessionRef.current = null;
    await Promise.all([
      AsyncStorage.removeItem(sessionKeyRef.current),
      AsyncStorage.removeItem(messagesKeyRef.current),
    ]);
    setMessages([]);
    setError(null);
  }, []);

  const injectSystemMessage = useCallback((text: string) => {
    const sysMsg: ChatMessage = {
      id: genId(),
      role: 'system',
      text,
      ts: Date.now(),
    };
    setMessages(prev => [...prev, sysMsg]);
  }, []);

  // Probe the gateway in the background so the URL is cached before the first
  // message. Call this as soon as the node is known to be running.
  const prewarm = useCallback(() => {
    resolveGatewayUrl(true).catch(() => {});
  }, [resolveGatewayUrl]);

  return { messages, loading, error, send, resetSession, injectSystemMessage, prewarm };
}
