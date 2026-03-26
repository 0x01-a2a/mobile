/**
 * Onboarding — first-launch setup for the 01 Pilot agent runtime (ZeroClaw).
 *
 * Steps:
 *   0 — Welcome (wallet + enable or skip)
 *   1 — Agent name
 *   2 — LLM provider selection
 *   3 — API key entry → finish (capabilities and rules use defaults)
 *   6 — Launch success (Bags token launch + secret key backup)
 *
 * On completion calls onDone(config) with the saved config,
 * or onDone(null) if the user skipped.
 */
import { useTheme, ThemeColors } from '../theme/ThemeContext';
import { ThemeToggle } from '../components/ThemeToggle';
import { useLayout } from '../hooks/useLayout';
import React, { useState, useEffect } from 'react';
import {
  Alert,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Image,
} from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AgentBrainConfig,
  ALL_CAPABILITIES,
  LlmProvider,
  ProviderInfo,
  PROVIDERS,
  saveLlmApiKey,
} from '../hooks/useAgentBrain';
import { AGGREGATOR_API } from '../hooks/useNodeApi';

export const ONBOARDING_KEY = 'zerox1:onboarding_done';
const ONBOARDING_STATE_KEY = 'zerox1:onboarding_partial_state';

/**
 * Decodes a base64 string to Uint8Array without relying on global atob()
 * which can be missing or flaky in some React Native environments.
 */
function decodeBase64(base64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;

  const len = base64.length;
  let bufferLength = len * 0.75;
  if (base64[len - 1] === '=') {
    bufferLength--;
    if (base64[len - 2] === '=') bufferLength--;
  }

  const bytes = new Uint8Array(bufferLength);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const encoded1 = lookup[base64.charCodeAt(i)];
    const encoded2 = lookup[base64.charCodeAt(i + 1)];
    const encoded3 = lookup[base64.charCodeAt(i + 2)];
    const encoded4 = lookup[base64.charCodeAt(i + 3)];

    bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
    if (p < bufferLength) bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
    if (p < bufferLength) bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
  }
  return bytes;
}

export async function markOnboardingDone(): Promise<void> {
  try {
    await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
  } catch (e) {
    console.warn('markOnboardingDone: failed to persist onboarding flag', e);
  }
}

export async function checkOnboardingDone(): Promise<boolean> {
  return (await AsyncStorage.getItem(ONBOARDING_KEY)) === 'true';
}

const C = {
  bg: '#050505',
  card: '#0f0f0f',
  border: '#1a1a1a',
  green: '#00e676',
  text: '#ffffff',
  sub: '#555555',
  amber: '#ffc107',
  input: '#111111',
};

// ============================================================================
// Shared layout helpers
// ============================================================================

function StepShell({
  children,
  step,
  total = 3,
}: {
  children: React.ReactNode;
  step: number;
  total?: number;
}) {
  const { colors } = useTheme();
  const { isTablet, isWide, contentHPad, width: screenWidth } = useLayout();
  const s = useStyles(colors, isTablet, isWide, screenWidth);
  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ paddingHorizontal: contentHPad }}>
        {step > 0 && (
          <View style={s.progressRow}>
            {Array.from({ length: total }, (_, i) => (
              <View key={i} style={[s.pip, i < step && s.pipDone]} />
            ))}
          </View>
        )}
        {children}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Heading({ label }: { label: string }) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  return <Text style={s.heading}>{label}</Text>;
}

function Sub({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  return <Text style={s.sub}>{children}</Text>;
}

function PrimaryBtn({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  return (
    <TouchableOpacity
      style={[s.primaryBtn, disabled && s.primaryBtnDisabled]}
      onPress={onPress}
      activeOpacity={0.8}
      disabled={disabled}
    >
      <Text style={[s.primaryBtnText, disabled && s.primaryBtnTextDisabled]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function GhostBtn({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  return (
    <TouchableOpacity style={s.ghostBtn} onPress={onPress} activeOpacity={0.7}>
      <Text style={s.ghostBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

function BackBtn({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  return (
    <TouchableOpacity style={s.backBtn} onPress={onPress} activeOpacity={0.7}>
      <Text style={s.backBtnText}>← BACK</Text>
    </TouchableOpacity>
  );
}

// ============================================================================
// Step 0 — Welcome
// ============================================================================

function WelcomeStep({
  phantomWallet,
  onChangePhantomWallet,
  onEnable,
  onSkip,
}: {
  phantomWallet: string;
  onChangePhantomWallet: (v: string) => void;
  onEnable: () => void;
  onSkip: () => void;
}) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  const walletValid = phantomWallet.trim().length >= 32;
  return (
    <StepShell step={0}>
      <Text style={s.logo}>[*]</Text>
      <Heading label="AGENT BRAIN" />
      <Sub>
        Your 01 Pilot agent earns on your behalf — accepting tasks, building
        reputation, and settling payments on Solana — while your phone is
        locked.
      </Sub>

      <View style={s.featureList}>
        {[
          'Accepts tasks from the mesh automatically',
          'Earns in your agent token, sweepable to your wallet',
          'Builds on-chain reputation over time',
          'Runs while you sleep',
        ].map(f => (
          <View key={f} style={s.featureRow}>
            <Text style={s.featureDot}>·</Text>
            <Text style={s.featureText}>{f}</Text>
          </View>
        ))}
      </View>

      {/* Phantom wallet — optional but unlocks sweep + portfolio view */}
      <View style={{ marginTop: 24, marginBottom: 8 }}>
        <Text style={{ fontSize: 9, color: colors.sub, fontFamily: 'monospace', letterSpacing: 2, marginBottom: 8 }}>
          CONNECT OWNER WALLET (OPTIONAL)
        </Text>
        <TextInput
          style={[s.keyInput, { borderWidth: 1, borderColor: walletValid ? colors.green + '80' : colors.border, borderRadius: 4, padding: 12, marginBottom: 0 }]}
          value={phantomWallet}
          onChangeText={onChangePhantomWallet}
          placeholder="Paste your Phantom wallet address"
          placeholderTextColor={colors.sub}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
        />
        <Text style={{ fontSize: 10, color: colors.sub, fontFamily: 'monospace', marginTop: 6, lineHeight: 15 }}>
          {walletValid
            ? '✓ Earnings sweep and portfolio tracking enabled'
            : 'Your Solana base58 address — enables earnings sweep and portfolio view. You can add this later in Settings.'}
        </Text>
      </View>

      <PrimaryBtn label="ENABLE AGENT BRAIN →" onPress={onEnable} />
      <GhostBtn label="skip for now" onPress={onSkip} />
    </StepShell>
  );
}

// ============================================================================
// Step 1 — Agent name
// ============================================================================

function NameStep({
  agentName,
  agentAvatar,
  onChangeName,
  onChangeAvatar,
  onNext,
  onSkip,
}: {
  agentName: string;
  agentAvatar: string;
  onChangeName: (v: string) => void;
  onChangeAvatar: (v: string) => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  return (
    <StepShell step={1}>
      <Heading label="NAME & AVATAR" />
      <Sub>
        This is how your agent appears on the mesh — in the discovery feed,
        reputation leaderboard, and task threads. You can change it anytime in
        Settings.
      </Sub>

      <View style={{ alignItems: 'center', marginBottom: 24 }}>
        <TouchableOpacity
          onPress={async () => {
            const res = await launchImageLibrary({
              mediaType: 'photo',
              selectionLimit: 1,
            });
            if (res?.assets?.[0]?.uri) onChangeAvatar(res.assets[0].uri);
          }}
          style={{
            width: 80,
            height: 80,
            borderRadius: 40,
            backgroundColor: colors.card,
            borderWidth: 1,
            borderColor: colors.border,
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          <Image
            source={agentAvatar
              ? { uri: agentAvatar }
              : require('../../android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png')}
            style={{ width: 80, height: 80 }}
          />
        </TouchableOpacity>
        <Text style={[s.keyLabel, { marginTop: 12 }]}>TAP TO CUSTOMIZE</Text>
      </View>

      <View style={s.keyCard}>
        <Text style={s.keyLabel}>AGENT NAME</Text>
        <TextInput
          style={s.keyInput}
          value={agentName}
          onChangeText={onChangeName}
          placeholder="e.g. fast-eddie, databot-9"
          placeholderTextColor={colors.sub}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={32}
        />
      </View>
      {agentName.trim().length === 1 && (
        <Text style={[s.keyHint, { color: '#ff8800' }]}>
          Name must be at least 2 characters.
        </Text>
      )}
      <Text style={s.keyHint}>
        Max 32 characters. Leave blank to use your agent ID prefix.
      </Text>

      <PrimaryBtn
        label="CONTINUE →"
        onPress={onNext}
        disabled={agentName.trim().length === 1}
      />
      <GhostBtn label="skip" onPress={onSkip} />
    </StepShell>
  );
}

// ============================================================================
// Step 2 — Provider selection
// ============================================================================

function ProviderStep({
  provider,
  customModel,
  onSelect,
  onChangeModel,
  onNext,
}: {
  provider: LlmProvider;
  customModel: string;
  onSelect: (p: LlmProvider) => void;
  onChangeModel: (v: string) => void;
  onNext: () => void;
}) {
  const { colors } = useTheme();
  const { isTablet, isWide, width: screenWidth } = useLayout();
  const s = useStyles(colors, isTablet, isWide, screenWidth);
  const providerInfo = PROVIDERS.find(p => p.key === provider)!;
  return (
    <StepShell step={2}>
      <Heading label="CHOOSE LLM PROVIDER" />
      <Sub>
        Your agent uses a fast, low-cost model for decisions. All inference
        calls go directly from your device to the provider — not through 0x01
        servers.
      </Sub>

      <View style={s.providerGrid}>
        {PROVIDERS.map((p: ProviderInfo) => (
          <TouchableOpacity
            key={p.key}
            style={[s.providerCard, provider === p.key && s.providerCardActive]}
            onPress={() => onSelect(p.key)}
            activeOpacity={0.8}
          >
            <Text
              style={[
                s.providerLabel,
                provider === p.key && s.providerLabelActive,
              ]}
            >
              {p.label}
            </Text>
            <Text style={s.providerModel}>{p.model}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={s.keyCard}>
        <Text style={s.keyLabel}>MODEL OVERRIDE (optional)</Text>
        <TextInput
          style={s.keyInput}
          value={customModel}
          onChangeText={onChangeModel}
          placeholder={providerInfo.model}
          placeholderTextColor={colors.sub}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
      </View>
      <Text style={s.keyHint}>
        Leave blank to use the default. Get a key at {providerInfo.hint}
      </Text>

      <PrimaryBtn label="CONTINUE →" onPress={onNext} />
    </StepShell>
  );
}

// ============================================================================
// Step 3 — API key
// ============================================================================

function KeyStep({
  provider,
  apiKey,
  customBaseUrl,
  customModel,
  onChangeKey,
  onChangeUrl,
  onChangeModel,
  onBack,
  onNext,
  saving,
}: {
  provider: LlmProvider;
  apiKey: string;
  customBaseUrl: string;
  customModel: string;
  onChangeKey: (v: string) => void;
  onChangeUrl: (v: string) => void;
  onChangeModel: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
  saving?: boolean;
}) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  const providerInfo = PROVIDERS.find(p => p.key === provider)!;

  const handleNext = () => {
    if (!apiKey.trim()) {
      Alert.alert(
        'Key required',
        `Paste your ${providerInfo.label} API key to continue.`,
      );
      return;
    }
    onNext();
  };

  return (
    <StepShell step={3}>
      <BackBtn onPress={onBack} />
      <Heading label={`${providerInfo.label.toUpperCase()} API KEY`} />
      <Sub>
        Stored in your device keychain — hardware-protected on supported
        devices. Never uploaded to 0x01 servers.
      </Sub>

      <View style={s.keyCard}>
        <Text style={s.keyLabel}>API KEY</Text>
        <TextInput
          style={s.keyInput}
          value={apiKey}
          onChangeText={onChangeKey}
          placeholder={`sk-...`}
          placeholderTextColor={colors.sub}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
      </View>

      {provider === 'custom' && (
        <>
          <View style={s.keyCard}>
            <Text style={s.keyLabel}>BASE URL</Text>
            <TextInput
              style={s.keyInput}
              value={customBaseUrl}
              onChangeText={onChangeUrl}
              placeholder="e.g. https://api.openai.com/v1"
              placeholderTextColor={colors.sub}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
            />
          </View>
          <View style={s.keyCard}>
            <Text style={s.keyLabel}>MODEL (optional)</Text>
            <TextInput
              style={s.keyInput}
              value={customModel}
              onChangeText={onChangeModel}
              placeholder="e.g. gpt-4, my-custom-model"
              placeholderTextColor={colors.sub}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
            />
          </View>
        </>
      )}

      <Text style={s.keyHint}>Get yours at {providerInfo.hint}</Text>

      <PrimaryBtn
        label={saving ? 'SETTING UP…' : 'FINISH SETUP'}
        onPress={handleNext}
        disabled={!apiKey.trim() || saving}
      />
    </StepShell>
  );
}

// ============================================================================
// Root
// ============================================================================

const NODE_CONFIG_KEY = 'zerox1:node_config';

export function OnboardingScreen({
  onDone,
}: {
  onDone: (config: AgentBrainConfig | null) => void;
}) {
  const { colors } = useTheme();
  const { isTablet, isWide, contentHPad, width: screenWidth } = useLayout();
  const s = useStyles(colors, isTablet, isWide, screenWidth);
  const [step, setStep] = useState(0);
  const [phantomWallet, setPhantomWallet] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agentAvatar, setAgentAvatar] = useState('');
  const [provider, setProvider] = useState<LlmProvider>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedConfig, setSavedConfig] = useState<AgentBrainConfig | null>(null);

  // Load partial onboarding state on mount
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(ONBOARDING_STATE_KEY);
        if (raw) {
          const s = JSON.parse(raw);
          if (typeof s.step === 'number') setStep(s.step);
          if (s.agentName) setAgentName(s.agentName);
          if (s.agentAvatar) setAgentAvatar(s.agentAvatar);
          if (s.provider) setProvider(s.provider);
          if (s.customBaseUrl) setCustomBaseUrl(s.customBaseUrl);
          if (s.customModel) setCustomModel(s.customModel);
        }
      } catch (e) {
        console.warn('Failed to load onboarding state:', e);
      }
    })();
  }, []);

  // Persist partial state on every change
  useEffect(() => {
    const state = { step, agentName, agentAvatar, provider, customBaseUrl, customModel };
    AsyncStorage.setItem(ONBOARDING_STATE_KEY, JSON.stringify(state))
      .catch(e => console.warn('Failed to save onboarding state:', e));
  }, [step, agentName, agentAvatar, provider, customBaseUrl, customModel]);

  const handleSkip = async () => {
    await AsyncStorage.removeItem(ONBOARDING_STATE_KEY);
    await markOnboardingDone();
    onDone(null);
  };

  const handleFinish = async () => {
    setSaving(true);
    try {
      // Persist agent name into the node config so the node binary picks it up.
      if (agentName.trim() || agentAvatar) {
        const raw = await AsyncStorage.getItem(NODE_CONFIG_KEY);
        let existing: Record<string, unknown> = {};
        try {
          existing = raw ? JSON.parse(raw) : {};
        } catch {
          /* corrupted — start fresh */
        }
        await AsyncStorage.setItem(
          NODE_CONFIG_KEY,
          JSON.stringify({
            ...existing,
            ...(agentName.trim() ? { agentName: agentName.trim() } : {}),
            ...(agentAvatar ? { agentAvatar } : {}),
          }),
        );
      }

      // Enable auto-start so the node launches on every subsequent app open.
      await AsyncStorage.setItem('zerox1:auto_start', 'true');

      await saveLlmApiKey(apiKey.trim());
      const config: AgentBrainConfig = {
        enabled: true,
        provider,
        capabilities: ALL_CAPABILITIES,
        minFeeUsdc: 5,
        minReputation: 50,
        autoAccept: false,
        maxActionsPerHour: 100,
        maxCostPerDayCents: 1000,
        apiKeySet: true,
        customBaseUrl: customBaseUrl.trim() || '',
        customModel: customModel.trim() || '',
      };
      // Persist brain config NOW so that step 6 can merge it into startNode,
      // ensuring ZeroClaw starts with the node and chat works immediately.
      await AsyncStorage.setItem('zerox1:agent_brain', JSON.stringify(config));
      setSavedConfig(config);
      setStep(6);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Failed to save config.');
    } finally {
      setSaving(false);
    }
  };

  switch (step) {
    case 0:
      return (
        <WelcomeStep
          phantomWallet={phantomWallet}
          onChangePhantomWallet={setPhantomWallet}
          onEnable={async () => {
            const addr = phantomWallet.trim();
            if (addr) {
              await AsyncStorage.setItem('zerox1:linked_wallet', addr).catch(() => {});
            }
            setStep(1);
          }}
          onSkip={async () => {
            const addr = phantomWallet.trim();
            if (addr) {
              await AsyncStorage.setItem('zerox1:linked_wallet', addr).catch(() => {});
            }
            handleSkip();
          }}
        />
      );
    case 1:
      return (
        <NameStep
          agentName={agentName}
          agentAvatar={agentAvatar}
          onChangeName={setAgentName}
          onChangeAvatar={setAgentAvatar}
          onNext={() => setStep(2)}
          onSkip={() => setStep(2)}
        />
      );
    case 2:
      return (
        <ProviderStep
          provider={provider}
          customModel={customModel}
          onSelect={setProvider}
          onChangeModel={setCustomModel}
          onNext={() => setStep(3)}
        />
      );
    case 3:
      return (
        <KeyStep
          provider={provider}
          apiKey={apiKey}
          customBaseUrl={customBaseUrl}
          customModel={customModel}
          onChangeKey={setApiKey}
          onChangeUrl={setCustomBaseUrl}
          onChangeModel={setCustomModel}
          onBack={() => setStep(2)}
          onNext={handleFinish}
          saving={saving}
        />
      );
    case 6:
      return (
        <LaunchSuccessStep
          agentName={agentName}
          agentAvatar={agentAvatar}
          config={savedConfig!}
          onFinish={onDone}
        />
      );
    default:
      return null;
  }
}

// ============================================================================
// Step 6 — Launch Success
// ============================================================================

/** Derive a short ticker symbol from the agent name. */
function deriveSymbol(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return clean.slice(0, 6) || 'AGENT';
}

function LaunchSuccessStep({
  agentName,
  agentAvatar,
  config,
  onFinish,
}: {
  agentName: string;
  agentAvatar: string;
  config: AgentBrainConfig;
  onFinish: (config: AgentBrainConfig | null) => void;
}) {
  const { colors } = useTheme();
  const s = useStyles(colors);

  const [phase, setPhase] = useState<'starting' | 'launching' | 'done' | 'error'>('starting');
  const [hotWalletAddress, setHotWalletAddress] = useState<string | null>(null);
  const [secretKeyB58, setSecretKeyB58] = useState<string | null>(null);
  const [tokenMint, setTokenMint] = useState<string | null>(null);
  const [secretRevealed, setSecretRevealed] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [tokenLaunchError, setTokenLaunchError] = useState<string | null>(null);
  const [tokenRateLimited, setTokenRateLimited] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { NodeModule } = require('../native/NodeModule');
        const raw = await AsyncStorage.getItem(NODE_CONFIG_KEY);
        const nodeConfig = raw ? JSON.parse(raw) : {};

        // Merge brain config so ZeroClaw starts alongside the node.
        let fullConfig = nodeConfig;
        try {
          const brainRaw = await AsyncStorage.getItem('zerox1:agent_brain');
          const brain = brainRaw ? JSON.parse(brainRaw) : null;
          if (brain?.enabled && brain?.apiKeySet) {
            fullConfig = {
              ...nodeConfig,
              agentBrainEnabled: true,
              llmProvider: brain.provider ?? 'gemini',
              llmModel: brain.customModel ?? '',
              llmBaseUrl: brain.customBaseUrl ?? '',
              capabilities: JSON.stringify(brain.capabilities ?? []),
              minFeeUsdc: brain.minFeeUsdc ?? 5,
              minReputation: brain.minReputation ?? 50,
              autoAccept: brain.autoAccept ?? true,
            };
          }
        } catch { /* proceed without brain */ }

        await NodeModule.startNode(fullConfig);
        if (cancelled) return;

        // Wait for node REST API to be ready (up to 30s).
        let auth: { nodeApiToken?: string } = {};
        try { auth = await NodeModule.getLocalAuthConfig(); } catch { /* ok */ }
        const apiToken: string = auth?.nodeApiToken ?? '';
        const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiToken) authHeaders.Authorization = `Bearer ${apiToken}`;

        let walletAddr: string | null = null;
        let agentIdHex: string | null = null;
        for (let i = 0; i < 30; i++) {
          await new Promise<void>(r => setTimeout(r, 1000));
          if (cancelled) return;
          try {
            const res = await fetch('http://127.0.0.1:9090/identity', { headers: authHeaders });
            if (res.ok) {
              const data: { agent_id: string } = await res.json();
              agentIdHex = data.agent_id;
              const hexId: string = data.agent_id ?? '';
              if (hexId.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hexId)) {
                // Skip wallet address derivation if agent_id format is unexpected
              } else {
                const { PublicKey } = require('@solana/web3.js');
                const bytes = Uint8Array.from(
                  (hexId.match(/.{1,2}/g)!).map((b: string) => parseInt(b, 16)),
                );
                try {
                  walletAddr = new PublicKey(bytes).toBase58();
                } catch { /* invalid key bytes */ }
              }
              if (!cancelled) setHotWalletAddress(walletAddr);
              break;
            }
          } catch { /* not ready yet */ }
        }
        if (cancelled) return;

        // Fetch secret key — master-only endpoint.
        try {
          const keyRes = await fetch('http://127.0.0.1:9090/identity/export-key', {
            headers: authHeaders,
          });
          if (keyRes.ok) {
            const keyData: { secret_key_b58: string } = await keyRes.json();
            if (!cancelled) setSecretKeyB58(keyData.secret_key_b58);
          }
        } catch { /* non-fatal */ }

        if (cancelled) return;
        setPhase('launching');

        // Launch Bags token via aggregator sponsor endpoint (operator wallet pays SOL fees;
        // agent wallet is fee_claimer for 100% of trading fees).
        const symbol = deriveSymbol(agentName || 'Agent');
        const displayName = agentName.trim() || 'My Agent';
        const launchBody: Record<string, unknown> = {
          agent_id_hex: agentIdHex ?? '',
          name: displayName,
          symbol,
          description: `${displayName} is an autonomous AI agent on the 01 mesh network. Hire me at 0x01.world.`,
        };
        if (agentAvatar?.startsWith('data:')) {
          launchBody.image_b64 = agentAvatar.split(',')[1] ?? '';
        }

        try {
          const launchRes = await fetch(`${AGGREGATOR_API}/sponsor/launch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(launchBody),
          });
          if (launchRes.ok) {
            const lj: { token_mint?: string } = await launchRes.json().catch(() => ({}));
            const mint = lj.token_mint ?? null;
            if (!cancelled && mint) {
              setTokenMint(mint);
              // Store token address for zeroclaw config.
              const brainRaw = await AsyncStorage.getItem('zerox1:agent_brain');
              const brain = brainRaw ? JSON.parse(brainRaw) : {};
              await AsyncStorage.setItem(
                'zerox1:agent_brain',
                JSON.stringify({ ...brain, tokenAddress: mint }),
              );
            }
          } else {
            const errText = await launchRes.text().catch(() => '');
            if (!cancelled) setTokenLaunchError(errText || `HTTP ${launchRes.status}`);
          }
          // Non-fatal: token launch might fail if Bags API is down; user can launch later.
        } catch (e: any) {
          if (!cancelled) setTokenLaunchError(e?.message ?? 'Unknown error');
        }

        if (!cancelled) setPhase('done');
      } catch (e: any) {
        if (!cancelled) {
          setErrorMsg(e?.message ?? 'Failed to start node.');
          setPhase('error');
        }
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCopyKey = async () => {
    if (!secretKeyB58) return;
    await Share.share({ message: secretKeyB58 });
    setKeyCopied(true);
  };

  const handleDone = async () => {
    await AsyncStorage.removeItem(ONBOARDING_STATE_KEY);
    await markOnboardingDone();
    onFinish(config);
  };

  const isLoading = phase === 'starting' || phase === 'launching';

  return (
    <StepShell step={6} total={6}>
      <Heading label="AGENT LAUNCHED" />

      {/* Status line */}
      {isLoading && (
        <Sub>
          {phase === 'starting' ? 'Starting node…' : 'Launching your token on Bags.fm…'}
        </Sub>
      )}

      {phase === 'error' && (
        <Text style={{ color: '#ff4444', fontSize: 12, fontFamily: 'monospace', marginBottom: 20 }}>
          {errorMsg}
        </Text>
      )}

      {/* Token launch result */}
      {tokenMint ? (
        <View style={s.walletCard}>
          <Text style={s.walletLabel}>YOUR AGENT TOKEN</Text>
          <Text style={[s.walletHint, { marginBottom: 8 }]}>
            Your token is live on Bags.fm. Requesters buy it to hire you — trading fees go straight to your hot wallet.
          </Text>
          <Text style={s.walletAddress} selectable>{tokenMint}</Text>
          <TouchableOpacity
            style={s.walletCopyBtn}
            onPress={() => Share.share({ message: tokenMint })}
            activeOpacity={0.7}
          >
            <Text style={s.walletCopyText}>[ COPY MINT ADDRESS ]</Text>
          </TouchableOpacity>
        </View>
      ) : phase === 'done' && (
        <View style={[s.walletCard, { borderColor: colors.border }]}>
          <Text style={s.walletLabel}>TOKEN LAUNCH</Text>
          {tokenRateLimited ? (
            <>
              <Text style={s.walletHint}>
                The shared Bags API key is rate-limited right now. Your token was not launched yet — you can retry later.
              </Text>
              <Text style={[s.walletHint, { color: '#ffc107', marginTop: 6 }]}>
                To launch without limits: go to Settings → Bags Fee Sharing → set your own Bags API key from bags.fm.
              </Text>
            </>
          ) : (
            <>
              <Text style={s.walletHint}>
                Token launch skipped or pending. You can launch manually later from Settings.
              </Text>
              {tokenLaunchError && (
                <Text style={{ fontSize: 10, color: '#ff4444', fontFamily: 'monospace', marginTop: 4 }}>
                  {tokenLaunchError.slice(0, 120)}
                </Text>
              )}
            </>
          )}
        </View>
      )}

      {/* Hot wallet + secret key */}
      <View style={[s.walletCard, { marginTop: 12, borderColor: '#ff8800' }]}>
        <Text style={[s.walletLabel, { color: '#ff8800' }]}>HOT WALLET — BACK UP NOW</Text>
        <Text style={s.walletHint}>
          This is your agent's identity and earning wallet. Back up the secret key before closing this screen — it cannot be recovered if lost.
        </Text>

        {hotWalletAddress && (
          <>
            <Text style={{ fontSize: 10, color: colors.sub, fontFamily: 'monospace', marginTop: 8, marginBottom: 2 }}>
              ADDRESS
            </Text>
            <Text style={s.walletAddress} selectable>{hotWalletAddress}</Text>
          </>
        )}

        <Text style={{ fontSize: 10, color: '#ff8800', fontFamily: 'monospace', marginTop: 12, marginBottom: 4 }}>
          SECRET KEY (64-byte Solana keypair)
        </Text>

        {secretKeyB58 ? (
          <>
            {secretRevealed ? (
              <>
                <Text style={{ fontSize: 10, color: '#ffc107', fontFamily: 'monospace', marginBottom: 4 }}>
                  Do not screenshot. Use the copy button.
                </Text>
                <Text
                  style={[s.walletAddress, { fontSize: 10, letterSpacing: 0.5 }]}
                >
                  {secretKeyB58}
                </Text>
              </>

            ) : (
              <TouchableOpacity
                style={[s.walletCopyBtn, { borderColor: '#ff8800' }]}
                onPress={() => setSecretRevealed(true)}
                activeOpacity={0.7}
              >
                <Text style={[s.walletCopyText, { color: '#ff8800' }]}>[ TAP TO REVEAL ]</Text>
              </TouchableOpacity>
            )}
            {secretRevealed && (
              <TouchableOpacity
                style={[s.walletCopyBtn, { borderColor: keyCopied ? colors.green : '#ff8800', marginTop: 8 }]}
                onPress={handleCopyKey}
                activeOpacity={0.7}
              >
                <Text style={[s.walletCopyText, { color: keyCopied ? colors.green : '#ff8800' }]}>
                  {keyCopied ? '[ COPIED ]' : '[ COPY SECRET KEY ]'}
                </Text>
              </TouchableOpacity>
            )}
          </>
        ) : (
          <Text style={{ fontSize: 11, color: colors.sub, fontFamily: 'monospace' }}>
            {isLoading ? 'Loading…' : 'Key unavailable — export from Settings after setup.'}
          </Text>
        )}
      </View>

      <PrimaryBtn
        label="ENTER THE MESH →"
        onPress={handleDone}
        disabled={isLoading}
      />
    </StepShell>
  );
}

// ============================================================================
// Styles
// ============================================================================

function useStyles(colors: ThemeColors, isTablet = false, isWide = false, screenWidth = 0) {
  return React.useMemo(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: isTablet ? 48 : 28, paddingTop: 56, paddingBottom: 48 },
  progressRow: { flexDirection: 'row', gap: 6, marginBottom: 36 },
  pip: { height: 3, flex: 1, backgroundColor: colors.border, borderRadius: 2 },
  pipDone: { backgroundColor: colors.green },
  logo: {
    fontSize: 32,
    color: colors.green,
    fontFamily: 'monospace',
    fontWeight: '700',
    marginBottom: 20,
  },
  heading: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: 3,
    fontFamily: 'monospace',
    marginBottom: 16,
  },
  sub: { fontSize: 13, color: colors.sub, lineHeight: 20, marginBottom: 28 },
  featureList: { marginBottom: 32 },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  featureDot: { color: colors.green, fontSize: 16, marginRight: 10, lineHeight: 20 },
  featureText: { color: colors.text, fontSize: 13, lineHeight: 20, flex: 1 },
  primaryBtn: {
    backgroundColor: colors.green,
    borderRadius: 4,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  primaryBtnDisabled: { backgroundColor: colors.border },
  primaryBtnText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 3,
    color: '#000',
  },
  primaryBtnTextDisabled: { color: colors.sub },
  ghostBtn: { alignItems: 'center', paddingVertical: 12 },
  ghostBtnText: { fontSize: 12, color: colors.sub, letterSpacing: 1 },
  backBtn: { marginBottom: 24 },
  backBtnText: {
    fontSize: 11,
    color: colors.sub,
    letterSpacing: 2,
    fontFamily: 'monospace',
  },
  // Provider grid
  providerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 20,
  },
  providerCard: {
    width: isWide ? '30%' : isTablet ? '47%' : screenWidth < 360 ? '100%' : '47%',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    padding: 16,
  },
  providerCardActive: { borderColor: colors.green, backgroundColor: colors.green + '12' },
  providerLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.sub,
    fontFamily: 'monospace',
    marginBottom: 4,
  },
  providerLabelActive: { color: colors.green },
  providerModel: { fontSize: 10, color: colors.sub, fontFamily: 'monospace' },
  // API key
  keyCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    padding: 16,
    marginBottom: 12,
  },
  keyLabel: { fontSize: 10, color: colors.sub, letterSpacing: 2, marginBottom: 8 },
  keyInput: { color: colors.text, fontFamily: 'monospace', fontSize: 14 },
  keyHint: { fontSize: 11, color: colors.sub, marginBottom: 28 },
  // Capabilities
  capList: { marginBottom: 28 },
  capRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    marginBottom: 8,
  },
  capRowActive: {
    borderColor: colors.green + '60',
    backgroundColor: colors.green + '08',
  },
  capCheck: {
    width: 20,
    height: 20,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: colors.sub,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  capCheckActive: { borderColor: colors.green, backgroundColor: colors.green },
  capCheckMark: { fontSize: 12, color: '#000', fontWeight: '700' },
  capLabel: { fontSize: 14, color: colors.sub, fontFamily: 'monospace' },
  capLabelActive: { color: colors.text },
  // Rules
  ruleCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    marginBottom: 12,
    overflow: 'hidden',
  },
  ruleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  ruleLeft: { flex: 1 },
  ruleLabel: {
    fontSize: 11,
    color: colors.text,
    letterSpacing: 2,
    fontWeight: '600',
  },
  ruleSub: { fontSize: 11, color: colors.sub, marginTop: 3 },
  ruleInput: {
    color: colors.green,
    fontFamily: 'monospace',
    fontSize: 16,
    fontWeight: '700',
    width: 60,
    textAlign: 'right',
  },
  toggleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    padding: 16,
    marginBottom: 28,
  },
  toggleLeft: { flex: 1, marginRight: 12 },
  // Wallet card (step 6)
  walletCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.green + '40',
    borderRadius: 4,
    padding: 16,
    marginBottom: 24,
  },
  walletLabel: {
    fontSize: 10,
    color: colors.green,
    letterSpacing: 2,
    fontFamily: 'monospace',
    marginBottom: 10,
  },
  walletAddress: {
    fontSize: 12,
    color: colors.text,
    fontFamily: 'monospace',
    lineHeight: 18,
    marginBottom: 10,
  },
  walletCopyBtn: { alignSelf: 'flex-start', marginBottom: 12, minWidth: 44, minHeight: 44, justifyContent: 'center' },
  walletCopyText: {
    fontSize: 10,
    color: colors.green,
    fontFamily: 'monospace',
    letterSpacing: 1,
  },
  walletLoading: {
    fontSize: 12,
    color: colors.sub,
    fontFamily: 'monospace',
    marginBottom: 12,
  },
  walletHint: {
    fontSize: 11,
    color: colors.sub,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
  }), [colors]);
}
