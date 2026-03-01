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

// ============================================================================
// Types
// ============================================================================

export type LlmProvider = 'anthropic' | 'openai' | 'gemini' | 'groq';

export type Capability =
  | 'summarization'
  | 'qa'
  | 'translation'
  | 'code_review'
  | 'data_analysis';

export const CAPABILITY_LABELS: Record<Capability, string> = {
  summarization: 'Summarization',
  qa:            'Q & A',
  translation:   'Translation',
  code_review:   'Code Review',
  data_analysis: 'Data Analysis',
};

export const ALL_CAPABILITIES: Capability[] = [
  'summarization', 'qa', 'translation', 'code_review', 'data_analysis',
];

export interface ProviderInfo {
  key:   LlmProvider;
  label: string;
  model: string;
  hint:  string;
}

export const PROVIDERS: ProviderInfo[] = [
  { key: 'anthropic', label: 'Claude',  model: 'claude-haiku-4-5-20251001', hint: 'console.anthropic.com' },
  { key: 'openai',    label: 'OpenAI',  model: 'gpt-4o-mini',               hint: 'platform.openai.com'   },
  { key: 'gemini',    label: 'Gemini',  model: 'gemini-2.0-flash',          hint: 'aistudio.google.com'   },
  { key: 'groq',      label: 'Groq',    model: 'llama-3.1-8b-instant',      hint: 'console.groq.com'      },
];

export interface AgentBrainConfig {
  enabled:       boolean;
  provider:      LlmProvider;
  capabilities:  Capability[];
  minFeeUsdc:    number;
  minReputation: number;
  autoAccept:    boolean;
  /** True when an API key is stored in the keychain. Never store the key here. */
  apiKeySet:     boolean;
}

const DEFAULT_CONFIG: AgentBrainConfig = {
  enabled:       false,
  provider:      'anthropic',
  capabilities:  ['summarization', 'qa'],
  minFeeUsdc:    0.01,
  minReputation: 50,
  autoAccept:    true,
  apiKeySet:     false,
};

// ============================================================================
// Constants
// ============================================================================

const BRAIN_STORAGE_KEY = 'zerox1:agent_brain';
const KEYCHAIN_SERVICE  = 'zerox1.llm_api_key';

// ============================================================================
// Keychain helpers (exported for use in Onboarding + Settings)
// ============================================================================

export async function saveLlmApiKey(key: string): Promise<void> {
  await Keychain.setGenericPassword('llm_api_key', key, {
    service:    KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
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

// ============================================================================
// Hook
// ============================================================================

export function useAgentBrain() {
  const [config, setConfig] = useState<AgentBrainConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(BRAIN_STORAGE_KEY)
      .then(v => { if (v) setConfig(JSON.parse(v)); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const save = useCallback(async (next: AgentBrainConfig) => {
    setConfig(next);
    await AsyncStorage.setItem(BRAIN_STORAGE_KEY, JSON.stringify(next));
  }, []);

  return { config, loading, save };
}
