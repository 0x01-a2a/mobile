/**
 * useZeroclawChat — hook for chatting with the local ZeroClaw agent brain.
 *
 * ZeroClaw exposes a gateway HTTP server on 127.0.0.1:42617. The endpoint
 * POST /api/chat takes { message, session_id } and returns { reply, model, session_id }.
 *
 * A session_id is persisted in AsyncStorage so conversations survive screen
 * unmounts. Call resetSession() to start a fresh conversation.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const GATEWAY_URL      = 'http://127.0.0.1:42617';
const SESSION_KEY      = 'zerox1:zeroclaw_session_id';
const REQUEST_TIMEOUT  = 60_000;   // ms — LLM can be slow on first token

export interface ChatMessage {
  id:      string;
  role:    'user' | 'assistant';
  text:    string;
  ts:      number;
}

export interface UseCeroclawChatResult {
  messages:     ChatMessage[];
  loading:      boolean;
  error:        string | null;
  send:         (text: string) => Promise<void>;
  resetSession: () => Promise<void>;
}

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useZeroclawChat(): UseCeroclawChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);

  // Restore session_id on mount.
  useEffect(() => {
    AsyncStorage.getItem(SESSION_KEY).then(id => {
      if (id) sessionRef.current = id;
    });
  }, []);

  const getOrCreateSession = useCallback(async (): Promise<string> => {
    if (sessionRef.current) return sessionRef.current;
    const id = genId();
    sessionRef.current = id;
    await AsyncStorage.setItem(SESSION_KEY, id);
    return id;
  }, []);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMsg: ChatMessage = {
      id:   genId(),
      role: 'user',
      text: trimmed,
      ts:   Date.now(),
    };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);
    setError(null);

    try {
      const sessionId = await getOrCreateSession();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      const resp = await fetch(`${GATEWAY_URL}/api/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: trimmed, session_id: sessionId }),
        signal:  controller.signal,
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
        await AsyncStorage.setItem(SESSION_KEY, data.session_id);
      }

      const assistantMsg: ChatMessage = {
        id:   genId(),
        role: 'assistant',
        text: data.reply,
        ts:   Date.now(),
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
    await AsyncStorage.removeItem(SESSION_KEY);
    setMessages([]);
    setError(null);
  }, []);

  return { messages, loading, error, send, resetSession };
}
