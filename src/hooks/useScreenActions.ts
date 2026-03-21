/**
 * useScreenActions — subscribes to 'screenActionPending' RN events emitted by
 * PhoneBridgeServer when POLICY_MODE = "ASSISTED" and the agent requests a UI action.
 *
 * Uses React's built-in useSyncExternalStore for a zero-dependency global store.
 */
import { useEffect, useCallback, useSyncExternalStore } from 'react';
import { NativeEventEmitter, NativeModules } from 'react-native';
import { NodeModule } from '../native/NodeModule';

export interface PendingScreenAction {
  id: string;
  endpoint: string;
  description: string;
}

// ── Minimal external store (no zustand needed) ──────────────────────────────

type Listener = () => void;

let _queue: PendingScreenAction[] = [];
const _listeners = new Set<Listener>();

function notifyListeners() {
  _listeners.forEach((l) => l());
}

const screenActionStore = {
  subscribe: (listener: Listener) => {
    _listeners.add(listener);
    return () => _listeners.delete(listener);
  },
  getSnapshot: () => _queue,
  enqueue: (action: PendingScreenAction) => {
    _queue = [..._queue, action];
    notifyListeners();
  },
  remove: (id: string) => {
    _queue = _queue.filter((a) => a.id !== id);
    notifyListeners();
  },
};

// ── Hook: read the queue ─────────────────────────────────────────────────────

export function usePendingScreenActions(): PendingScreenAction[] {
  return useSyncExternalStore(
    screenActionStore.subscribe,
    screenActionStore.getSnapshot,
  );
}

// ── Hook: mount the native event listener (call once in App.tsx) ─────────────

const emitter = new NativeEventEmitter(NativeModules.ZeroxNodeModule);

export function useScreenActionListener() {
  useEffect(() => {
    const sub = emitter.addListener(
      'screenActionPending',
      (event: PendingScreenAction) => screenActionStore.enqueue(event),
    );
    return () => sub.remove();
  }, []);
}

// ── Hook: approve / reject a pending action ───────────────────────────────────

export function useConfirmScreenAction() {
  return useCallback(async (id: string, approved: boolean) => {
    try {
      // Notify native side FIRST; only remove from queue on success.
      await NodeModule.confirmScreenAction(id, approved);
      screenActionStore.remove(id);
    } catch (e) {
      // Native call failed — keep the item in queue so user can retry,
      // but also call decide(false) to unblock any still-waiting native thread.
      NodeModule.confirmScreenAction(id, false).catch(() => {});
    }
  }, []);
}
