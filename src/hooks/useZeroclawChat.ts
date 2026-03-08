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
}

export interface UseZeroclawChatResult {
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  send: (text: string) => Promise<void>;
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

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      text: trimmed,
      ts: Date.now(),
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
        body: JSON.stringify({ message: trimmed, session_id: sessionId }),
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
