/**
 * NodeModule — TypeScript wrapper around the ZeroxNodeModule native module.
 *
 * The native module (NodeModule.kt) manages the Android foreground service
 * that runs the zerox1-node Rust binary. This file provides typed wrappers
 * and a typed event subscription.
 */
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { ZeroxNodeModule } = NativeModules;

if (!ZeroxNodeModule) {
  if (Platform.OS === 'android') {
    throw new Error(
      'ZeroxNodeModule not found. ' +
      'Ensure NodePackage is registered in MainApplication.kt.',
    );
  } else if (Platform.OS === 'ios') {
    console.warn('ZeroxNodeModule not found on iOS. Native features unavailable.');
  }
}

export interface NodeConfig {
  /** Circuit relay multiaddr — required for CGNAT traversal on mobile. */
  relayAddr?: string;
  /** Firebase Cloud Messaging device token for wake-on-PROPOSE. */
  fcmToken?: string;
  /** Human-readable agent name shown on the mesh dashboard. */
  agentName?: string;
  /** Short bio / description shown on the agent's mesh profile. */
  agentBio?: string;
  /** Local URI of the agent avatar image. */
  agentAvatar?: string;
  /** Solana RPC endpoint. Defaults to mainnet-beta. */
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
  /** LLM provider key: 'anthropic' | 'openai' | 'gemini' | 'groq' | 'custom' */
  llmProvider?: string;
  /** Custom model name (used when llmProvider = 'custom') */
  llmModel?: string;
  /** Custom OpenAI-compatible base URL (used when llmProvider = 'custom') */
  llmBaseUrl?: string;
  /** JSON array string of enabled capabilities e.g. '["summarization","qa"]' */
  capabilities?: string;
  /** Minimum task fee in USDC — reject tasks below this. */
  minFeeUsdc?: number;
  /** Minimum counterparty reputation score. */
  minReputation?: number;
  /** Auto-accept qualifying tasks without user approval. */
  autoAccept?: boolean;
  /** Maximum agent tool invocations per hour (default 100). */
  maxActionsPerHour?: number;
  /** Maximum LLM spend per day in US cents (default 1000 = $10). */
  maxCostPerDayCents?: number;

  /** Bags.fm API key — enables POST /bags/launch, POST /bags/claim, GET /bags/positions. */
  bagsApiKey?: string;
  /** Optional Bags partner wallet for partner-attributed launches. */
  bagsPartnerWallet?: string;
  /** Optional Bags partner key for partner-attributed launches. */
  bagsPartnerKey?: string;
}

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
  releaseNotes: string;
  /** ISO-8601 UTC timestamp of the latest release, e.g. "2025-03-14T18:00:00Z" */
  publishedAt: string;
}

export type NodeStatus = 'running' | 'stopped' | 'error';

export interface NodeStatusEvent {
  status: NodeStatus;
  detail: string;
}

export interface LocalAuthConfig {
  nodeApiToken: string | null;
  gatewayToken: string | null;
  heliusApiKey: string | null;
  agentRunning: boolean;
}

// ============================================================================
// Module methods
// ============================================================================

export const NodeModule = {
  /** Start the node foreground service with the given config. */
  startNode: (config: NodeConfig = {}): Promise<void> =>
    ZeroxNodeModule.startNode({
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      ...config,
    }),

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
   * Securely store the fal.ai API key in the Android Keystore (EncryptedSharedPreferences).
   * NodeService reads it at agent launch and sets FAL_API_KEY env var on the zeroclaw process.
   */
  saveFalApiKey: (key: string): Promise<void> =>
    ZeroxNodeModule.saveFalApiKey(key),

  /**
   * Securely store the Replicate API key in the Android Keystore.
   * NodeService reads it at agent launch and sets REPLICATE_API_KEY env var on zeroclaw.
   */
  saveReplicateApiKey: (key: string): Promise<void> =>
    ZeroxNodeModule.saveReplicateApiKey(key),

  /**
   * Update the LLM provider/model/baseUrl in SharedPreferences so the next
   * zeroclaw restart (including after reloadAgent) picks up the new values.
   */
  updateBrainConfig: (provider: string, model: string, baseUrl: string): Promise<void> =>
    ZeroxNodeModule.updateBrainConfig(provider, model, baseUrl),

  /**
   * Reload the agent brain without a full node restart.
   * Calls POST /agent/reload — the node SIGTERMs zeroclaw, then the restart
   * loop rewrites config.toml with the latest key/provider from SharedPreferences.
   */
  reloadAgent: (): Promise<void> =>
    ZeroxNodeModule.reloadAgent(),

  /**
   * Start zeroclaw directly when the node is already running but the brain is not.
   * iOS-only; no-op on Android (Android manages zeroclaw within the foreground service).
   * Pass the same brain config keys as startNode.
   */
  startBrainIfNeeded: (config: NodeConfig): Promise<void> =>
    ZeroxNodeModule.startBrainIfNeeded ? ZeroxNodeModule.startBrainIfNeeded(config) : Promise.resolve(),

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
   * Notification: "notifications_read" | "notifications_reply" | "notifications_dismiss"
   * SMS:          "sms_read" | "sms_send"
   * Other:        "contacts" | "location" | "calendar" | "media" | "motion"
   *               "camera" | "microphone" | "calls" | "health" | "wearables"
   * Screen:       "screen_read_tree" | "screen_capture" | "screen_act"
   *               "screen_global_nav" | "screen_vision" | "screen_autonomy"
   */
  setBridgeCapability: (capability: string, enabled: boolean): Promise<void> =>
    ZeroxNodeModule.setBridgeCapability(capability, enabled),

  /** Read all bridge capability toggles. Returns { [key]: boolean }. */
  getBridgeCapabilities: (): Promise<Record<string, boolean>> =>
    ZeroxNodeModule.getBridgeCapabilities(),

  /**
   * Set the minimum battery % required to serve sensor data-collection requests.
   * 0 = disabled, 25 = low, 50 = medium, 100 = full charge required.
   */
  setDataBudget: (levelPct: number): Promise<void> =>
    ZeroxNodeModule.setDataBudget(levelPct),

  /** Read the current data-collection battery budget threshold (0–100). Default 100. */
  getDataBudget: (): Promise<number> =>
    ZeroxNodeModule.getDataBudget(),

  /**
   * Fetch the human-readable bridge activity log from the native layer.
   * Returns a JSON string (array of {time, capability, action, outcome}).
   */
  getBridgeActivityLog: (limit: number = 50): Promise<string> =>
    ZeroxNodeModule.getBridgeActivityLog(limit),

  /**
   * Request that Android exempt the app from Doze / battery optimization.
   * Shows the system "Allow unrestricted battery usage?" dialog.
   * No-op if already exempted or on API < 23.
   */
  requestBatteryOptExemption: (): Promise<void> =>
    ZeroxNodeModule.requestBatteryOptExemption(),

  /** Prevent screenshots and screen recording on the Activity window. Call with true before showing sensitive UI, false after. */
  setWindowSecure: (enabled: boolean): Promise<void> =>
    ZeroxNodeModule.setWindowSecure(enabled),

  /**
   * Export the agent's Ed25519 identity key as a base58-encoded 64-byte string
   * (Phantom-compatible format: seed || pubkey).
   * Only works in local node mode (key is stored on device).
   */
  exportIdentityKey: (): Promise<string> =>
    ZeroxNodeModule.exportIdentityKey(),

  /**
   * Import a Phantom/Solana CLI private key (base58, 64 bytes).
   * Replaces the current agent identity — takes effect on next node start.
   * WARNING: the old identity cannot be recovered after this call.
   */
  importIdentityKey: (base58Key: string): Promise<void> =>
    ZeroxNodeModule.importIdentityKey(base58Key),

  /**
   * Show a local notification — used when ZeroClaw replies while the app is
   * in the background. Tapping the notification reopens the app.
   */
  showChatNotification: (body: string): Promise<void> =>
    ZeroxNodeModule.showChatNotification(body),

  /**
   * Check GitHub releases for a newer version of the app.
   *
   * Returns:
   *   hasUpdate        — true if a newer version is available
   *   currentVersion   — installed app version (BuildConfig.VERSION_NAME)
   *   latestVersion    — latest release tag (without "v" prefix)
   *   downloadUrl      — direct APK download URL, or "" if not found
   *   releaseNotes     — markdown release notes from the GitHub release body
   */
  checkForUpdate: (): Promise<UpdateInfo> =>
    ZeroxNodeModule.checkForUpdate(),

  /**
   * Download the APK at `downloadUrl` and launch the Android package installer.
   * Progress is emitted as 'updateProgress' events: { progress: 0–100 }.
   * Resolves when the install dialog has been launched.
   */
  downloadAndInstall: (downloadUrl: string): Promise<void> =>
    ZeroxNodeModule.downloadAndInstall(downloadUrl),

  /**
   * Enable or disable "Agent Presence" for eligible 01PL holders.
   * When enabled, the foreground notification gains rich content (agent name,
   * status) and three quick-action buttons: Chat, Brief, Inbox.
   * Requires node to be running; no-op otherwise.
   */
  setPresenceMode: (enabled: boolean): Promise<void> =>
    ZeroxNodeModule.setPresenceMode(enabled),

  /** Returns whether Agent Presence is currently enabled. */
  getPresenceMode: (): Promise<boolean> =>
    ZeroxNodeModule.getPresenceMode(),

  /**
   * Returns true if the "Draw over other apps" (SYSTEM_ALERT_WINDOW)
   * permission is granted — required for the floating avatar bubble.
   */
  hasOverlayPermission: (): Promise<boolean> =>
    ZeroxNodeModule.hasOverlayPermission(),

  /**
   * Open Android system settings to let the user grant the overlay
   * permission. Resolves immediately; check hasOverlayPermission() after
   * the user returns to the app.
   */
  requestOverlayPermission: (): Promise<void> =>
    ZeroxNodeModule.requestOverlayPermission(),

  /**
   * Resolve a pending ASSISTED-mode screen action confirmation.
   * Called from the ScreenActionConfirmModal after the user taps APPROVE or REJECT.
   * @param id       The action UUID from the 'screenActionPending' event.
   * @param approved true = approve, false = reject.
   */
  confirmScreenAction: (id: string, approved: boolean): Promise<void> =>
    ZeroxNodeModule.confirmScreenAction(id, approved),

  /**
   * Prompt the user to grant screen capture permission for highlight reel recording.
   * Shows the Android system "Start recording?" dialog once. The grant is stored
   * on-device and used by POST /phone/highlight/start until the process restarts.
   *
   * Resolves (null) on approval. Rejects with CANCELLED if the user denies.
   */
  requestScreenCapture: (): Promise<void> =>
    ZeroxNodeModule.requestScreenCapture(),

  /**
   * Returns true if the agent already has a valid screen capture grant.
   * If true, highlight recording can start immediately without re-prompting.
   */
  hasScreenCaptureGrant: (): Promise<boolean> =>
    ZeroxNodeModule.hasScreenCaptureGrant(),

  /**
   * Start a Live Activity showing agent status on Lock Screen + Dynamic Island (iOS 16.1+).
   * Returns the activity ID string, or null if Live Activities are not supported.
   * On Android this resolves immediately with null (floating bubble is used instead).
   */
  startLiveActivity: (config: {
    agentName: string;
    statusPhrase?: string;
    currentTask?: string;
    earnedToday?: string;
    isActive?: boolean;
    pendingCount?: number;
  }): Promise<string | null> =>
    ZeroxNodeModule.startLiveActivity(config),

  /**
   * Update a running Live Activity's content state.
   * On Android this is a no-op (resolves immediately).
   */
  updateLiveActivity: (activityId: string, state: {
    statusPhrase?: string;
    currentTask?: string;
    earnedToday?: string;
    isActive?: boolean;
    pendingCount?: number;
  }): Promise<void> =>
    ZeroxNodeModule.updateLiveActivity(activityId, state),

  /**
   * End and dismiss a Live Activity immediately.
   * On Android this is a no-op (resolves immediately).
   */
  endLiveActivity: (activityId: string): Promise<void> =>
    ZeroxNodeModule.endLiveActivity(activityId),

  /**
   * Returns the APNs device token hex string, or null if not registered yet.
   * iOS only — call after node start and register with the aggregator so it can
   * send background wake pushes (bounty, trading opportunity, etc.).
   */
  getApnsToken: (): Promise<string | null> =>
    Platform.OS === 'ios'
      ? ZeroxNodeModule.getApnsToken()
      : Promise.resolve(null),

  /**
   * Register HealthKit background delivery observers.
   * Call once after HealthKit permission is granted.
   * iOS only — no-op on Android.
   */
  registerHealthWake: (): Promise<void> =>
    Platform.OS === 'ios'
      ? ZeroxNodeModule.registerHealthWake()
      : Promise.resolve(),

  /**
   * Report the agent's sleep state to the aggregator.
   *
   * Call with `true` when the app transitions to background/inactive so the
   * aggregator knows to queue inbound messages and fire APNs wake pushes.
   * Call with `false` when the app returns to active so senders know the
   * agent is reachable via P2P again.
   *
   * iOS only (signs with Keychain identity key + POSTs to aggregator).
   * No-op on Android — Android's NodeService.kt handles FCM sleep state
   * directly when the foreground service stops.
   */
  setAggregatorSleepState: (sleeping: boolean): Promise<void> =>
    Platform.OS === 'ios'
      ? ZeroxNodeModule.setAggregatorSleepState(sleeping)
      : Promise.resolve(),
};

// Temporary iOS bridge instrumentation to diagnose stale native module builds.
if (__DEV__ && Platform.OS === 'ios' && ZeroxNodeModule) {
  try {
    console.log('[NodeModule] bridge keys', Object.keys(ZeroxNodeModule).sort());
    console.log('[NodeModule] typeof getLocalAuthConfig', typeof ZeroxNodeModule.getLocalAuthConfig);
    console.log('[NodeModule] typeof startBrainIfNeeded', typeof ZeroxNodeModule.startBrainIfNeeded);
    console.log('[NodeModule] typeof reloadAgent', typeof ZeroxNodeModule.reloadAgent);
  } catch (e) {
    console.log('[NodeModule] bridge introspection failed', String(e));
  }
}

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

/** Subscribe to APK download progress (0–100). Returns an unsubscribe function. */
export function onUpdateProgress(
  handler: (event: { progress: number }) => void,
): () => void {
  const sub = emitter.addListener('updateProgress', handler);
  return () => sub.remove();
}
