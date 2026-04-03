/**
 * useLiveActivity — manages the iOS Dynamic Island / Lock Screen Live Activity
 * for the agent's running state.
 *
 * Lifecycle:
 *   - Starts a Live Activity when the node transitions to 'running'.
 *   - Pushes state updates every 30 seconds (earned today, status).
 *   - Ends the activity when the node stops.
 *
 * On Android this hook is a no-op (all NodeModule live activity calls resolve
 * immediately with null / void on non-iOS platforms).
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useNode } from './useNode';
import { useIdentity, fetchTaskLog } from './useNodeApi';
import { NodeModule } from '../native/NodeModule';
import type { TaskLogEntry } from './useNodeApi';

const UPDATE_INTERVAL_MS = 30_000;

function isToday(tsSeconds: number): boolean {
  const d = new Date(tsSeconds * 1000);
  return d.toDateString() === new Date().toDateString();
}

function formatEarnedToday(entries: TaskLogEntry[]): string {
  const total = entries
    .filter(e => e.outcome === 'success' && isToday(e.timestamp))
    .reduce((acc, e) => acc + (e.amount_usd ?? 0), 0);
  return `$${total.toFixed(2)}`;
}

export function useLiveActivity(): void {
  const { status } = useNode();
  const identity = useIdentity();

  // Refs so async callbacks always see current values without stale closures.
  const activityIdRef = useRef<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusRef = useRef(status);

  // Keep statusRef current so the interval callback sees the latest value.
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    // Live Activities are iOS-only. The native bridge is a no-op on Android,
    // but skip all the fetches and timers to keep things clean.
    if (Platform.OS !== 'ios') return;

    async function pushUpdate(): Promise<void> {
      if (!activityIdRef.current) return;
      try {
        const entries = await fetchTaskLog(50);
        await NodeModule.updateLiveActivity(activityIdRef.current, {
          status: statusRef.current === 'running' ? 'Running' : 'Stopped',
          earnedToday: formatEarnedToday(entries),
          isActive: statusRef.current === 'running',
        });
      } catch {
        // Network may be briefly unavailable — next tick will retry.
      }
    }

    if (status === 'running' && identity) {
      // Start the activity the first time we see the node running with a
      // resolved identity. Guard with the ref to prevent double-starts if
      // the effect re-fires (e.g. identity object reference changes).
      if (!activityIdRef.current) {
        (async () => {
          try {
            const entries = await fetchTaskLog(50);
            const id = await NodeModule.startLiveActivity({
              agentName: identity.name || 'Agent',
              status: 'Running',
              earnedToday: formatEarnedToday(entries),
              isActive: true,
            });
            activityIdRef.current = id;
          } catch {
            // Live Activities may not be authorised by the user — ignore.
          }
        })();
      }

      // Set up the periodic update ticker if not already running.
      if (!intervalRef.current) {
        intervalRef.current = setInterval(pushUpdate, UPDATE_INTERVAL_MS);
      }
    } else {
      // Node stopped — tear down.
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }

      if (activityIdRef.current) {
        const idToEnd = activityIdRef.current;
        activityIdRef.current = null;
        NodeModule.endLiveActivity(idToEnd).catch(() => {});
      }
    }

    return () => {
      // Cleanup: clear the ticker so it doesn't fire after the next render
      // has already set up a fresh one (or torn down on stop).
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [status, identity]);
}
