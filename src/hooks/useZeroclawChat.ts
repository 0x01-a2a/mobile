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
const REQUEST_TIMEOUT = 60_000;   // ms — LLM can be slow on first token

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
  send: (text: string, image?: { uri: string; cid: string; mime: string }) => Promise<void>;
  resetSession: () => Promise<void>;
  injectSystemMessage: (text: string) => void;
}

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sessionKey(agentId?: string): string {
  return agentId ? `${SESSION_KEY_PREFIX}_${agentId}` : SESSION_KEY_PREFIX;
}

export function useZeroclawChat(agentId?: string): UseZeroclawChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const gatewayTokenRef = useRef<string | null>(null);
  const systemContextRef = useRef<string[]>([]);

  // Track the current key so async callbacks always write to the right slot.
  const sessionKeyRef = useRef(sessionKey(agentId));

  // When agentId changes: reset in-memory state and load the persisted session
  // for the new agent (or start fresh if none exists).
  useEffect(() => {
    const key = sessionKey(agentId);
    sessionKeyRef.current = key;

    // Clear state synchronously so the UI empties immediately.
    sessionRef.current = null;
    setMessages([]);
    setError(null);

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
            if (!data?.tokens || sessionKeyRef.current !== key) return;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sol  = data.tokens.find((t: any) =>
              t.mint === 'So11111111111111111111111111111111111111112');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const usdc = data.tokens.find((t: any) =>
              t.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ||
              t.mint === '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
            const solAmt  = (sol?.amount  ?? 0) as number;
            const usdcAmt = (usdc?.amount ?? 0) as number;
            systemContextRef.current = [
              ...baseContext,
              `Current hot wallet balance: ${solAmt.toFixed(6)} SOL, ${usdcAmt.toFixed(2)} USDC (Solana devnet).`,
            ];
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
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const getOrCreateSession = useCallback(async (): Promise<string> => {
    if (sessionRef.current) return sessionRef.current;
    const id = genId();
    sessionRef.current = id;
    await AsyncStorage.setItem(sessionKeyRef.current, id);
    return id;
  }, []);

  const send = useCallback(async (
    text: string,
    image?: { uri: string; cid: string; mime: string },
  ) => {
    const trimmed = text.trim();
    if (!trimmed && !image || loading) return;

    // Build the message text sent to zeroclaw. If an image is attached, include
    // the CID so the agent can reference it (e.g. for bags_launch image_url).
    const messageText = image
      ? `${trimmed ? trimmed + '\n' : ''}[User attached image — CID: ${image.cid}, mime: ${image.mime}. Accessible at https://api.0x01.world/blobs/${image.cid}]`
      : trimmed;

    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      text: trimmed,
      ts: Date.now(),
      imageUri: image?.uri,
      imageCid: image?.cid,
    };
    setMessages(prev => [...prev, userMsg]);
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
      setMessages(prev => [...prev, assistantMsg]);

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
    await AsyncStorage.removeItem(sessionKeyRef.current);
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
