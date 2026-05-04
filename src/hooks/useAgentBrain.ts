/**
 * useAgentBrain — manages ZeroClaw agent brain config.
 *
 * Non-sensitive config (provider, capabilities, rules) is persisted in
 * AsyncStorage. The LLM API key is stored exclusively in the OS Keychain
 * (Android Keystore / iOS Secure Enclave) — never in AsyncStorage.
 */
import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import { NodeModule } from '../native/NodeModule';
import { readAgentProfile, writeAgentProfile } from './useNodeApi';

// ============================================================================
// Types
// ============================================================================

export type LlmProvider = 'default' | 'anthropic' | 'openai' | 'gemini' | 'zai' | 'minimax' | 'custom';

export type Capability =
  | 'summarization'
  | 'qa'
  | 'translation'
  | 'code_review'
  | 'data_analysis';

export const CAPABILITY_LABEL_KEYS: Record<Capability, string> = {
  summarization: 'common.capSummarization',
  qa: 'common.capQa',
  translation: 'common.capTranslation',
  code_review: 'common.capCodeReview',
  data_analysis: 'common.capDataAnalysis',
};

// Kept for backwards compat — prefer using CAPABILITY_LABEL_KEYS + t()
export const CAPABILITY_LABELS: Record<Capability, string> = {
  summarization: 'Summarization',
  qa: 'Q & A',
  translation: 'Translation',
  code_review: 'Code Review',
  data_analysis: 'Data Analysis',
};

export const ALL_CAPABILITIES: Capability[] = [
  'summarization', 'qa', 'translation', 'code_review', 'data_analysis',
];

export interface ProviderInfo {
  key: LlmProvider;
  label: string;
  model: string;
  hint: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { key: 'default', label: 'Default', model: 'gemini-3-flash-preview', hint: 'No API key needed' },
  { key: 'gemini', label: 'Gemini', model: 'gemini-2.5-flash', hint: 'aistudio.google.com' },
  { key: 'anthropic', label: 'Claude', model: 'claude-haiku-4-5-20251001', hint: 'console.anthropic.com' },
  { key: 'openai', label: 'OpenAI', model: 'gpt-4o-mini', hint: 'platform.openai.com' },
  { key: 'zai', label: 'Z.AI (GLM)', model: 'glm-5.1', hint: 'api.z.ai' },
  { key: 'minimax', label: 'MiniMax', model: 'MiniMax-M2.7', hint: 'api.minimax.io' },
  { key: 'custom', label: 'Custom', model: 'Any supported SDK model', hint: 'Your custom endpoint URL' },
];

export interface AgentBrainConfig {
  enabled: boolean;
  provider: LlmProvider;
  capabilities: Capability[];
  minFeeUsdc: number;
  minReputation: number;
  autoAccept: boolean;
  /** Maximum agent tool invocations per hour. */
  maxActionsPerHour: number;
  /** Maximum LLM spend per day in US cents (e.g. 1000 = $10). */
  maxCostPerDayCents: number;
  /** True when an API key is stored in the keychain. Never store the key here. */
  apiKeySet: boolean;
  /** True when a fal.ai API key is stored in the keychain. */
  falApiKeySet?: boolean;
  /** True when a Replicate API key is stored in the keychain. */
  replicateApiKeySet?: boolean;
  /** True when a MoltBook API key is stored in the keychain. */
  moltbookApiKeySet?: boolean;
  /** MoltBook username the agent was registered under. */
  moltbookRegisteredName?: string;
  /**
   * Populated after registration while the account is pending human claim.
   * Cleared once the account is confirmed claimed.
   */
  moltbookPendingClaim?: {
    claimUrl: string;
    tweetTemplate: string;
    registeredName: string;
    /** API key stored here only for status polling — not shown in UI. */
    apiKey: string;
  };
  /** True when a Neynar API key is stored in the keychain. */
  neynarApiKeySet?: boolean;
  /** True when a Farcaster managed signer UUID is stored in the keychain. */
  farcasterSignerSet?: boolean;
  /** Farcaster numeric FID (non-sensitive, stored in AsyncStorage). */
  farcasterFid?: string;
  /** Names of custom env vars set for skills (values stored in native secure storage only). */
  skillEnvVarKeys?: string[];
  customModel?: string;
  customBaseUrl?: string;
  /** Bags.fm token mint address launched at onboarding. */
  tokenAddress?: string;
}

const DEFAULT_CONFIG: AgentBrainConfig = {
  enabled: false,
  provider: 'default',
  capabilities: ['summarization', 'qa'],
  minFeeUsdc: 5,
  minReputation: 50,
  autoAccept: false,
  maxActionsPerHour: 100,
  maxCostPerDayCents: 1000,
  apiKeySet: false,
  customModel: '',
  customBaseUrl: '',
};

// ============================================================================
// Constants
// ============================================================================

const BRAIN_STORAGE_KEY = 'zerox1:agent_brain';
// Key used to namespace brain config inside the node's profile.json, which
// may also contain other operator profile fields.
const BRAIN_PROFILE_KEY = 'agent_brain';
const KEYCHAIN_SERVICE = 'zerox1.llm_api_key';
const FAL_KEYCHAIN_SERVICE = 'zerox1.fal_api_key';
const REPLICATE_KEYCHAIN_SERVICE = 'zerox1.replicate_api_key';
const NEYNAR_KEYCHAIN_SERVICE = 'zerox1.neynar_api_key';
const FARCASTER_SIGNER_KEYCHAIN_SERVICE = 'zerox1.farcaster_signer_uuid';
const MOLTBOOK_KEYCHAIN_SERVICE = 'zerox1.moltbook_api_key';

// ============================================================================
// Keychain helpers (exported for use in Onboarding + Settings)
// ============================================================================

export async function saveLlmApiKey(key: string): Promise<void> {
  // 1. Store in platform keychain (standard RN practice)
  await Keychain.setGenericPassword('llm_api_key', key, {
    service: KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });

  // 2. Push to native keychain so NodeService can read it directly at agent launch.
  // Android: EncryptedSharedPreferences (CRIT-4); iOS: native Keychain via KeychainHelper.
  await NodeModule.saveLlmApiKey(key);
}

export async function loadLlmApiKey(): Promise<string | null> {
  try {
    const creds = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
    return creds ? creds.password : null;
  } catch {
    return null;
  }
}

export async function clearLlmApiKey(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
  } catch { /* already clear */ }
}

// ── fal.ai API key helpers ────────────────────────────────────────────────────

export async function saveFalApiKey(key: string): Promise<void> {
  await Keychain.setGenericPassword('fal_api_key', key, {
    service: FAL_KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await NodeModule.saveFalApiKey(key);
}

export async function loadFalApiKey(): Promise<string | null> {
  try {
    const creds = await Keychain.getGenericPassword({ service: FAL_KEYCHAIN_SERVICE });
    return creds ? creds.password : null;
  } catch {
    return null;
  }
}

export async function clearFalApiKey(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: FAL_KEYCHAIN_SERVICE });
  } catch { /* already clear */ }
}

// ── Replicate API key helpers ─────────────────────────────────────────────────

export async function saveReplicateApiKey(key: string): Promise<void> {
  await Keychain.setGenericPassword('replicate_api_key', key, {
    service: REPLICATE_KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await NodeModule.saveReplicateApiKey(key);
}

export async function loadReplicateApiKey(): Promise<string | null> {
  try {
    const creds = await Keychain.getGenericPassword({ service: REPLICATE_KEYCHAIN_SERVICE });
    return creds ? creds.password : null;
  } catch {
    return null;
  }
}

export async function clearReplicateApiKey(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: REPLICATE_KEYCHAIN_SERVICE });
  } catch { /* already clear */ }
}

// ── MoltBook API key helpers ──────────────────────────────────────────────────

export async function saveMoltbookApiKey(key: string): Promise<void> {
  await Keychain.setGenericPassword('moltbook_api_key', key, {
    service: MOLTBOOK_KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await NodeModule.saveMoltbookApiKey(key);
}

export async function clearMoltbookApiKey(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: MOLTBOOK_KEYCHAIN_SERVICE });
  } catch { /* already clear */ }
}

// ── Neynar API key helpers ────────────────────────────────────────────────────

export async function saveNeynarApiKey(key: string): Promise<void> {
  await Keychain.setGenericPassword('neynar_api_key', key, {
    service: NEYNAR_KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await NodeModule.saveNeynarApiKey(key);
}

export async function loadNeynarApiKey(): Promise<string | null> {
  try {
    const creds = await Keychain.getGenericPassword({ service: NEYNAR_KEYCHAIN_SERVICE });
    return creds ? creds.password : null;
  } catch {
    return null;
  }
}

export async function clearNeynarApiKey(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: NEYNAR_KEYCHAIN_SERVICE });
  } catch { /* already clear */ }
}

// ── Farcaster signer UUID helpers ─────────────────────────────────────────────

export async function saveFarcasterSignerUuid(uuid: string): Promise<void> {
  await Keychain.setGenericPassword('farcaster_signer_uuid', uuid, {
    service: FARCASTER_SIGNER_KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await NodeModule.saveFarcasterSignerUuid(uuid);
}

export async function clearFarcasterSignerUuid(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: FARCASTER_SIGNER_KEYCHAIN_SERVICE });
  } catch { /* already clear */ }
}

export async function saveFarcasterFid(fid: string): Promise<void> {
  await NodeModule.saveFarcasterFid(fid);
}

// ============================================================================
// Node profile sync helpers
// ============================================================================

/**
 * Strip fields that must never leave the device keychain before writing to
 * the node's profile store (profile.json on the node filesystem).
 */
function sanitizeForNodeProfile(cfg: AgentBrainConfig): Omit<AgentBrainConfig, 'moltbookPendingClaim'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { moltbookPendingClaim: _drop, ...safe } = cfg;
  return safe;
}

/**
 * Write brain config into the node's profile.json under the `agent_brain` key.
 * Fire-and-forget — caller does not need to await.
 */
async function syncBrainToNodeProfile(cfg: AgentBrainConfig): Promise<void> {
  try {
    const existing = await readAgentProfile<Record<string, unknown>>();
    const merged = { ...(existing ?? {}), [BRAIN_PROFILE_KEY]: sanitizeForNodeProfile(cfg) };
    await writeAgentProfile(merged);
  } catch {
    // Non-fatal — node may be stopped.
  }
}

// ============================================================================
// Hook
// ============================================================================

export function useAgentBrain() {
  const [config, setConfig] = useState<AgentBrainConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // 1. Load from AsyncStorage immediately (fast, always available).
    AsyncStorage.getItem(BRAIN_STORAGE_KEY)
      .then(v => { if (!cancelled && v) setConfig(JSON.parse(v)); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });

    // 2. In the background, try the node's profile store. Node-side config
    //    wins when both exist (it was written more recently by this hook's save()).
    readAgentProfile<Record<string, unknown>>().then(profile => {
      if (cancelled || !profile) return;
      const nodeBrain = profile[BRAIN_PROFILE_KEY];
      if (!nodeBrain || typeof nodeBrain !== 'object') return;
      // Merge: node config is authoritative for fields it contains;
      // local AsyncStorage may have keychain-only fields (moltbookPendingClaim)
      // that are never written to the node.
      AsyncStorage.getItem(BRAIN_STORAGE_KEY).then(raw => {
        if (cancelled) return;
        const local: Partial<AgentBrainConfig> = raw ? JSON.parse(raw) : {};
        const merged: AgentBrainConfig = { ...DEFAULT_CONFIG, ...local, ...(nodeBrain as Partial<AgentBrainConfig>) };
        setConfig(merged);
        // Keep AsyncStorage in sync so next cold-start is fast.
        AsyncStorage.setItem(BRAIN_STORAGE_KEY, JSON.stringify(merged)).catch(() => {});
      }).catch(() => {});
    }).catch(() => {});

    return () => { cancelled = true; };
  }, []);

  const save = useCallback(async (next: AgentBrainConfig) => {
    setConfig(next);
    // Preserve any extra fields (e.g. tokenAddress written by onboarding) by merging.
    const existing = await AsyncStorage.getItem(BRAIN_STORAGE_KEY).catch(() => null);
    const merged = existing ? { ...JSON.parse(existing), ...next } : next;
    await AsyncStorage.setItem(BRAIN_STORAGE_KEY, JSON.stringify(merged));
    // Mirror to the node's profile store so zeroclaw can observe config
    // and config survives JS bundle reloads without AsyncStorage.
    syncBrainToNodeProfile(merged).catch(() => {});
  }, []);

  const reload = useCallback(() => {
    AsyncStorage.getItem(BRAIN_STORAGE_KEY)
      .then(v => { if (v) setConfig(JSON.parse(v)); })
      .catch(() => {});
  }, []);

  return { config, loading, save, reload };
}
