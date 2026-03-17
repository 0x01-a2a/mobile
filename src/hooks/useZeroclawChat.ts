/**
 * useZeroclawChat — hook for chatting with the local ZeroClaw agent brain.
 *
 * ZeroClaw exposes a gateway HTTP server on 127.0.0.1:42617. The endpoint
 * POST /api/chat takes { message, session_id } and returns { reply, model, session_id }.
 *
 * Sessions are scoped per agent ID so switching agents always starts a fresh
 * ZeroClaw conversation. Call resetSession() to manually clear within one agent.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NodeModule } from '../native/NodeModule';

const GATEWAY_URL = 'http://127.0.0.1:42617';
const SESSION_KEY_PREFIX = 'zerox1:zeroclaw_session';
const MESSAGES_KEY_PREFIX = 'zerox1:zeroclaw_messages';
const REQUEST_TIMEOUT = 60_000;   // ms — LLM can be slow on first token
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
          `You have an on-chain hot wallet on Solana devnet used for task rewards, staking, and USDC payments on the mesh.`,
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
      if (!gatewayTokenRef.current) {
        const auth = await NodeModule.getLocalAuthConfig();
        gatewayTokenRef.current = auth.gatewayToken;
      }
      if (!gatewayTokenRef.current) {
        throw new Error('Agent gateway auth is unavailable');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      const resp = await fetch(`${GATEWAY_URL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${gatewayTokenRef.current}`,
        },
        body: JSON.stringify({
          message: messageText,
          session_id: sessionId,
          context: systemContextRef.current,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
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
      const msg =
        err instanceof Error
          ? err.name === 'AbortError'
            ? 'Request timed out. Is the agent brain enabled?'
            : err.message
          : 'Unknown error';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [loading, getOrCreateSession]);

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

  return { messages, loading, error, send, resetSession, injectSystemMessage };
}
