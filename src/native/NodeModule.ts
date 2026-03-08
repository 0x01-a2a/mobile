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
  /** Local URI of the agent avatar image. */
  agentAvatar?: string;
  /** Solana RPC endpoint. Defaults to devnet. */
  rpcUrl?: string;
  /**
   * When set, the app runs in hosted mode: no local node is started.
   * All API calls are directed to this URL (e.g. "https://host.example.com:9091").
   */
  nodeApiUrl?: string;

  // ── ZeroClaw agent brain ──────────────────────────────────────────────────
  // NOTE: The LLM API key is NEVER passed through this bridge.
  //       NodeService.kt loads it directly from EncryptedSharedPreferences.
  /** Enable the ZeroClaw agent brain sidecar. */
  agentBrainEnabled?: boolean;
  /** LLM provider key: 'anthropic' | 'openai' | 'gemini' | 'groq' */
  llmProvider?: string;
  /** JSON array string of enabled capabilities e.g. '["summarization","qa"]' */
  capabilities?: string;
  /** Minimum task fee in USDC — reject tasks below this. */
  minFeeUsdc?: number;
  /** Minimum counterparty reputation score. */
  minReputation?: number;
  /** Auto-accept qualifying tasks without user approval. */
  autoAccept?: boolean;

  // ── Bags fee-sharing ──────────────────────────────────────────────────────
  /** Fee in basis points to route to the Bags distribution contract (0 = off, max 500). */
  bagsFeesBps?: number;
  /** Base58 Solana pubkey of the Bags distribution wallet. Omit to auto-resolve from bags.fm. */
  bagsWallet?: string;
  /** Bags.fm API key — enables POST /bags/launch, POST /bags/claim, GET /bags/positions. */
  bagsApiKey?: string;
}

export type NodeStatus = 'running' | 'stopped' | 'error';

export interface NodeStatusEvent {
  status: NodeStatus;
  detail: string;
}

export interface LocalAuthConfig {
  nodeApiToken: string | null;
  gatewayToken: string | null;
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

  /** Returns the locally provisioned bearer tokens for the node API and ZeroClaw gateway. */
  getLocalAuthConfig: (): Promise<LocalAuthConfig> =>
    ZeroxNodeModule.getLocalAuthConfig(),

  /** Returns a map of permission name → granted status for all phone bridge permissions. */
  checkPermissions: (): Promise<Record<string, boolean>> =>
    ZeroxNodeModule.checkPermissions(),

  /**
   * Request a single Android runtime permission by name (e.g. "READ_CONTACTS").
   * Returns false immediately after showing the system dialog; call checkPermissions()
   * afterward to read the actual grant result.
   */
  requestPermission: (permission: string): Promise<boolean> =>
    ZeroxNodeModule.requestPermission(permission),

  /**
   * Securely store the LLM API key in the Android Keystore (EncryptedSharedPreferences).
   * This is hardware-backed on most modern devices (CRIT-4).
   */
  saveLlmApiKey: (key: string): Promise<void> =>
    ZeroxNodeModule.saveLlmApiKey(key),

  /**
   * Upload a blob to the aggregator, signing the request with the agent's
   * Ed25519 identity key. Only works in local node mode (key is on device).
   *
   * @param dataBase64  Base64-encoded bytes of the file to upload.
   * @param mimeType    MIME type string, e.g. "image/jpeg".
   * @returns           CID (Keccak-256 hex string) of the uploaded blob.
   */
  uploadBlob: (dataBase64: string, mimeType: string): Promise<string> =>
    ZeroxNodeModule.uploadBlob(dataBase64, mimeType),

  /**
   * Enable or disable a bridge capability.
   * Keys: "messaging" | "contacts" | "location" | "camera" | "microphone"
   *      | "screen" | "calls" | "calendar" | "media"
   */
  setBridgeCapability: (capability: string, enabled: boolean): Promise<void> =>
    ZeroxNodeModule.setBridgeCapability(capability, enabled),

  /** Read all bridge capability toggles. Returns { [key]: boolean }. */
  getBridgeCapabilities: (): Promise<Record<string, boolean>> =>
    ZeroxNodeModule.getBridgeCapabilities(),

  /**
   * Fetch the human-readable bridge activity log from the native layer.
   * Returns a JSON string (array of {time, capability, action, outcome}).
   */
  getBridgeActivityLog: (limit: number = 50): Promise<string> =>
    ZeroxNodeModule.getBridgeActivityLog(limit),
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
