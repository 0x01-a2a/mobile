/**
 * useScreenActions — subscribes to 'screenActionPending' RN events emitted by
 * PhoneBridgeServer when POLICY_MODE = "ASSISTED" and the agent requests a UI action.
 *
 * Maintains a queue of pending actions that the ScreenActionConfirmModal renders.
 * Resolves each action by calling NodeModule.confirmScreenAction().
 */
import { useEffect, useCallback } from 'react';
import { NativeEventEmitter, NativeModules } from 'react-native';
import { create } from 'zustand';
import { NodeModule } from '../native/NodeModule';

export interface PendingScreenAction {
  id: string;
  endpoint: string;
  description: string;
}

interface ScreenActionStore {
  queue: PendingScreenAction[];
  enqueue: (action: PendingScreenAction) => void;
  remove: (id: string) => void;
}

export const useScreenActionStore = create<ScreenActionStore>((set) => ({
  queue: [],
  enqueue: (action) =>
    set((s) => ({ queue: [...s.queue, action] })),
  remove: (id) =>
    set((s) => ({ queue: s.queue.filter((a) => a.id !== id) })),
}));

const emitter = new NativeEventEmitter(NativeModules.ZeroxNodeModule);

/**
 * Mount once at the top of the component tree (App.tsx).
 * Subscribes to native events and populates the store.
 */
export function useScreenActionListener() {
  const enqueue = useScreenActionStore((s) => s.enqueue);

  useEffect(() => {
    const sub = emitter.addListener(
      'screenActionPending',
      (event: PendingScreenAction) => enqueue(event),
    );
    return () => sub.remove();
  }, [enqueue]);
}

/**
 * Returns a handler for approving / rejecting a pending screen action.
 * Removes the action from the queue and notifies the native layer.
 */
export function useConfirmScreenAction() {
  const remove = useScreenActionStore((s) => s.remove);

  return useCallback(
    async (id: string, approved: boolean) => {
      remove(id);
      await NodeModule.confirmScreenAction(id, approved);
    },
    [remove],
  );
}
