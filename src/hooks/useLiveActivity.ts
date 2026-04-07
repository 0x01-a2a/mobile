/**
 * useLiveActivity — manages the iOS Dynamic Island / Lock Screen Live Activity
 * for the agent's running state.
 *
 * Gating: Live Activity is a 01PL Pilot Mode exclusive. The activity only
 * starts when the user has enabled Pilot Mode in You > Wallet. Non-holders
 * see no island. Holders who disable Pilot Mode also see no island.
 *
 * Lifecycle:
 *   - Starts a Live Activity when node is 'running' AND pilotMode is on.
 *   - Pushes state updates every 30 seconds (earned today, status).
 *   - Ends the activity when the node stops or pilotMode is disabled.
 *
 * On Android this hook is a no-op (all NodeModule live activity calls resolve
 * immediately with null / void on non-iOS platforms).
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useNode } from './useNode';
import { useIdentity, fetchTaskLog } from './useNodeApi';
import { useTheme } from '../theme/ThemeContext';
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
  const { pilotMode } = useTheme();

  const activityIdRef = useRef<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusRef = useRef(status);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    // Live Activities are iOS-only.
    if (Platform.OS !== 'ios') return;

    const shouldRun = status === 'running' && pilotMode && !!identity;

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

    if (shouldRun) {
      if (!activityIdRef.current) {
        (async () => {
          try {
            const entries = await fetchTaskLog(50);
            const id = await NodeModule.startLiveActivity({
              agentName: identity!.name || 'Agent',
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

      if (!intervalRef.current) {
        intervalRef.current = setInterval(pushUpdate, UPDATE_INTERVAL_MS);
      }
    } else {
      // Node stopped or pilot mode disabled — tear down.
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
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [status, identity, pilotMode]);
}
