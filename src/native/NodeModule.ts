/**
 * NodeModule — TypeScript wrapper around the ZeroxNodeModule native module.
 *
 * The native module (NodeModule.kt) manages the Android foreground service
 * that runs the zerox1-node Rust binary. This file provides typed wrappers
 * and a typed event subscription.
 */
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { ZeroxNodeModule } = NativeModules;

if (!ZeroxNodeModule && Platform.OS === 'android') {
  throw new Error(
    'ZeroxNodeModule not found. ' +
    'Ensure NodePackage is registered in MainApplication.kt.',
  );
}

export interface NodeConfig {
  /** Circuit relay multiaddr — required for CGNAT traversal on mobile. */
  relayAddr?: string;
  /** Firebase Cloud Messaging device token for wake-on-PROPOSE. */
  fcmToken?: string;
  /** Human-readable agent name shown on the mesh dashboard. */
  agentName?: string;
  /** Solana RPC endpoint. Defaults to devnet. */
  rpcUrl?: string;
  /**
   * When set, the app runs in hosted mode: no local node is started.
   * All API calls are directed to this URL (e.g. "https://host.example.com:9091").
   */
  nodeApiUrl?: string;
}

export type NodeStatus = 'running' | 'stopped' | 'error';

export interface NodeStatusEvent {
  status: NodeStatus;
  detail: string;
}

// ============================================================================
// Module methods
// ============================================================================

export const NodeModule = {
  /** Start the node foreground service with the given config. */
  startNode: (config: NodeConfig = {}): Promise<void> =>
    ZeroxNodeModule.startNode(config),

  /** Stop the node and remove the foreground notification. */
  stopNode: (): Promise<void> =>
    ZeroxNodeModule.stopNode(),

  /** Returns true if the foreground service is currently running. */
  isRunning: (): Promise<boolean> =>
    ZeroxNodeModule.isRunning(),
};

// ============================================================================
// Events
// ============================================================================

const emitter = new NativeEventEmitter(ZeroxNodeModule);

/** Subscribe to node status changes. Returns an unsubscribe function. */
export function onNodeStatus(
  handler: (event: NodeStatusEvent) => void,
): () => void {
  const sub = emitter.addListener('nodeStatus', handler);
  return () => sub.remove();
}
