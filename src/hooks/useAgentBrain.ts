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
import { Platform } from 'react-native';

// ============================================================================
// Types
// ============================================================================

export type LlmProvider = 'anthropic' | 'openai' | 'gemini' | 'zai' | 'minimax' | 'custom' | 'local';

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
  { key: 'local', label: 'Private 🔒', model: 'gemma-4-1b', hint: 'On-device · no API key · no data leaves phone' },
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
  customModel?: string;
  customBaseUrl?: string;
  /** Bags.fm token mint address launched at onboarding. */
  tokenAddress?: string;
  /** GGUF model key to use when provider === 'local' (e.g. 'gemma-4-1b'). */
  localModelKey?: string;
}

const DEFAULT_CONFIG: AgentBrainConfig = {
  enabled: false,
  provider: 'anthropic',
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
const KEYCHAIN_SERVICE = 'zerox1.llm_api_key';
const FAL_KEYCHAIN_SERVICE = 'zerox1.fal_api_key';
const REPLICATE_KEYCHAIN_SERVICE = 'zerox1.replicate_api_key';

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
  if (Platform.OS === 'android') {
    await NodeModule.saveFalApiKey(key);
  }
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
  if (Platform.OS === 'android') {
    await NodeModule.saveReplicateApiKey(key);
  }
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

// ============================================================================
// Hook
// ============================================================================

export function useAgentBrain() {
  const [config, setConfig] = useState<AgentBrainConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(BRAIN_STORAGE_KEY)
      .then(v => { if (v) setConfig(JSON.parse(v)); })
      .catch(() => { /* AsyncStorage read failed — using defaults */ })
      .finally(() => setLoading(false));
  }, []);

  const save = useCallback(async (next: AgentBrainConfig) => {
    setConfig(next);
    // Preserve any extra fields (e.g. tokenAddress written by onboarding) by merging.
    const existing = await AsyncStorage.getItem(BRAIN_STORAGE_KEY).catch(() => null);
    const merged = existing ? { ...JSON.parse(existing), ...next } : next;
    await AsyncStorage.setItem(BRAIN_STORAGE_KEY, JSON.stringify(merged));
  }, []);

  const reload = useCallback(() => {
    AsyncStorage.getItem(BRAIN_STORAGE_KEY)
      .then(v => { if (v) setConfig(JSON.parse(v)); })
      .catch(() => {});
  }, []);

  return { config, loading, save, reload };
}
