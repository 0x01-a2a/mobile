/**
 * useLiveActivity — manages the iOS Dynamic Island / Lock Screen Live Activity.
 *
 * The island reflects the agent's real-time presence:
 *   - "Standing by"   — online, no pending items
 *   - "New proposal"  — incoming PROPOSE waiting for user
 *   - "Work ready"    — DELIVER arrived, waiting for user to review
 *   - "Working…"      — agent is actively processing
 *   - "Deal accepted" — ACCEPT just landed
 *   - etc.
 *
 * Updates happen:
 *   1. Immediately on inbox events (WebSocket subscription inside this hook).
 *   2. On a 30s poll for earned-today refresh.
 *   3. On node status changes.
 *
 * Gating: iOS only, Pilot Mode enabled, node running.
 * On Android this hook is a no-op.
 */

import { useEffect, useRef, useCallback } from 'react';
import { Platform } from 'react-native';
import { useNode } from './useNode';
import { useIdentity, fetchTaskLog, getInboxWsParams } from './useNodeApi';
import { useTheme } from '../theme/ThemeContext';
import { NodeModule } from '../native/NodeModule';
import { useAudioMute } from './useAudioMute.tsx';
import type { TaskLogEntry } from './useNodeApi';

const EARNINGS_POLL_MS = 30_000;

// ── Status phrase map ────────────────────────────────────────────────────────

const PHRASE_FROM_MSG_TYPE: Record<string, string> = {
  PROPOSE:   'New proposal',
  COUNTER:   'Counteroffer',
  ACCEPT:    'Deal accepted',
  REJECT:    'Offer declined',
  DELIVER:   'Work ready',
  FEEDBACK:  'Got feedback',
  BEACON:    'Online',
  ADVERTISE: 'Broadcasting',
  DISPUTE:   'Dispute opened',
  VERDICT:   'Verdict in',
};

/** Msg types that require explicit user action — increment pendingCount. */
const USER_ACTION_TYPES = new Set(['PROPOSE', 'DELIVER', 'COUNTER']);

function isToday(tsSeconds: number): boolean {
  return new Date(tsSeconds * 1000).toDateString() === new Date().toDateString();
}

function formatEarned(entries: TaskLogEntry[]): string {
  const total = entries
    .filter(e => e.outcome === 'success' && isToday(e.timestamp))
    .reduce((s, e) => s + (e.amount_usd ?? 0), 0);
  return `$${total.toFixed(2)}`;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useLiveActivity(): void {
  const { status } = useNode();
  const identity = useIdentity();
  const { pilotMode } = useTheme();
  const { muted } = useAudioMute();

  const activityIdRef   = useRef<string | null>(null);
  const statusRef       = useRef(status);
  const earnedRef       = useRef('$0.00');
  const pendingRef      = useRef(0);
  const phraseRef       = useRef('Standing by');
  const currentTaskRef  = useRef('');
  const mutedRef        = useRef(muted);
  const pollTimerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef           = useRef<WebSocket | null>(null);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  // ── Push a state snapshot to the active island ────────────────────────────
  const pushState = useCallback(async (overrides?: {
    statusPhrase?: string;
    currentTask?: string;
    pendingCount?: number;
    isActive?: boolean;
  }) => {
    if (!activityIdRef.current) return;
    if (overrides?.statusPhrase !== undefined) phraseRef.current = overrides.statusPhrase;
    if (overrides?.currentTask  !== undefined) currentTaskRef.current = overrides.currentTask;
    if (overrides?.pendingCount !== undefined) pendingRef.current = overrides.pendingCount;
    try {
      await NodeModule.updateLiveActivity(activityIdRef.current, {
        statusPhrase: phraseRef.current,
        currentTask:  currentTaskRef.current,
        earnedToday:  earnedRef.current,
        isActive:     overrides?.isActive ?? (statusRef.current === 'running'),
        pendingCount: pendingRef.current,
        audioMuted:   mutedRef.current,
      });
    } catch {
      // Island may have been dismissed by the user — ignore.
    }
  }, []);

  // ── Refresh earnings from task log ────────────────────────────────────────
  const refreshEarnings = useCallback(async () => {
    if (!activityIdRef.current) return;
    try {
      const entries = await fetchTaskLog(50);
      earnedRef.current = formatEarned(entries);
      await pushState();
    } catch {
      // Network briefly unavailable — next tick will retry.
    }
  }, [pushState]);

  // ── Inbox WebSocket for event-driven island updates ───────────────────────
  const openInboxWs = useCallback(() => {
    if (wsRef.current) return; // already open
    try {
      const { wsBase, token, isHosted } = getInboxWsParams();
      let ws: WebSocket;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const WS = WebSocket as any;
      if (isHosted && token) {
        ws = new WS(`${wsBase}/ws/hosted/inbox`, undefined, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } else {
        ws = new WS(`${wsBase}/ws/inbox`);
      }

      ws.onmessage = (e: MessageEvent) => {
        try {
          const env = JSON.parse(e.data as string) as { msg_type: string; conversation_id?: string };
          const phrase = PHRASE_FROM_MSG_TYPE[env.msg_type];
          if (!phrase) return;
          const isPending = USER_ACTION_TYPES.has(env.msg_type);
          if (isPending) pendingRef.current += 1;
          pushState({
            statusPhrase: phrase,
            pendingCount: pendingRef.current,
          });
        } catch { /* malformed */ }
      };

      ws.onerror = () => {
        ws.close();
        wsRef.current = null;
      };
      ws.onclose = () => {
        wsRef.current = null;
      };

      wsRef.current = ws;
    } catch { /* WebSocket not available */ }
  }, [pushState]);

  const closeInboxWs = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  // ── Android notification status ──────────────────────────────────────────
  const androidWsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'android') return;

    if (status !== 'running') {
      androidWsRef.current?.close();
      androidWsRef.current = null;
      NodeModule.setAgentStatus('Running — connected to 0x01 mesh').catch(() => {});
      return;
    }

    if (androidWsRef.current) return; // already connected

    try {
      const { wsBase, token, isHosted } = getInboxWsParams();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const WS = WebSocket as any;
      const ws: WebSocket = isHosted && token
        ? new WS(`${wsBase}/ws/hosted/inbox`, undefined, { headers: { Authorization: `Bearer ${token}` } })
        : new WS(`${wsBase}/ws/inbox`);

      ws.onmessage = (e: MessageEvent) => {
        try {
          const env = JSON.parse(e.data as string) as { msg_type: string };
          const phrase = PHRASE_FROM_MSG_TYPE[env.msg_type];
          if (phrase) NodeModule.setAgentStatus(phrase).catch(() => {});
        } catch { /* malformed */ }
      };
      ws.onerror = () => { ws.close(); androidWsRef.current = null; };
      ws.onclose = () => { androidWsRef.current = null; };
      androidWsRef.current = ws;
    } catch { /* WS unavailable */ }

    return () => {
      androidWsRef.current?.close();
      androidWsRef.current = null;
    };
  }, [status]);

  // ── Main lifecycle effect (iOS) ───────────────────────────────────────────
  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    const shouldRun = status === 'running' && pilotMode && !!identity;

    if (shouldRun) {
      // Start Live Activity if not already running.
      if (!activityIdRef.current) {
        (async () => {
          try {
            const entries = await fetchTaskLog(50);
            earnedRef.current = formatEarned(entries);
            const id = await NodeModule.startLiveActivity({
              agentName:    identity!.name || 'Agent',
              statusPhrase: 'Standing by',
              currentTask:  '',
              earnedToday:  earnedRef.current,
              isActive:     true,
              pendingCount: 0,
            });
            activityIdRef.current = id ?? null;
          } catch { /* Live Activities not authorised */ }
        })();
      }

      // Open inbox WS for event-driven updates.
      openInboxWs();

      // Start earnings poll.
      if (!pollTimerRef.current) {
        pollTimerRef.current = setInterval(refreshEarnings, EARNINGS_POLL_MS);
      }
    } else {
      // Tear down.
      closeInboxWs();
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (activityIdRef.current) {
        const id = activityIdRef.current;
        activityIdRef.current = null;
        pendingRef.current = 0;
        NodeModule.endLiveActivity(id).catch(() => {});
      }
    }

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [status, identity, pilotMode, openInboxWs, closeInboxWs, refreshEarnings]);

  // ── Reflect node status changes immediately ───────────────────────────────
  useEffect(() => {
    if (Platform.OS !== 'ios' || !activityIdRef.current) return;
    const isActive = status === 'running';
    pushState({
      statusPhrase: isActive ? phraseRef.current : 'Offline',
      isActive,
    });
  }, [status, pushState]);

  // ── Reflect mute toggle immediately ──────────────────────────────────────
  useEffect(() => {
    if (Platform.OS !== 'ios' || !activityIdRef.current) return;
    pushState();
  }, [muted, pushState]);
}
