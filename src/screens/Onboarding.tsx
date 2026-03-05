/**
 * Onboarding — first-launch setup for the ZeroClaw agent brain.
 *
 * Steps:
 *   0 — Welcome (enable or skip)
 *   1 — Agent name
 *   2 — LLM provider selection
 *   3 — API key entry
 *   4 — Capability selection
 *   5 — Auto-accept rules + finish
 *
 * On completion calls onDone(config) with the saved config,
 * or onDone(null) if the user skipped.
 */
import React, { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AgentBrainConfig,
  ALL_CAPABILITIES,
  Capability,
  CAPABILITY_LABELS,
  LlmProvider,
  ProviderInfo,
  PROVIDERS,
  saveLlmApiKey,
} from '../hooks/useAgentBrain';

export const ONBOARDING_KEY = 'zerox1:onboarding_done';

export async function markOnboardingDone(): Promise<void> {
  await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
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
  total = 5,
}: {
  children: React.ReactNode;
  step: number;
  total?: number;
}) {
  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        {step > 0 && (
          <View style={s.progressRow}>
            {Array.from({ length: total }, (_, i) => (
              <View
                key={i}
                style={[s.pip, i < step && s.pipDone]}
              />
            ))}
          </View>
        )}
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Heading({ label }: { label: string }) {
  return <Text style={s.heading}>{label}</Text>;
}

function Sub({ children }: { children: React.ReactNode }) {
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
  return (
    <TouchableOpacity style={s.ghostBtn} onPress={onPress} activeOpacity={0.7}>
      <Text style={s.ghostBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

function BackBtn({ onPress }: { onPress: () => void }) {
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
  onEnable,
  onSkip,
}: {
  onEnable: () => void;
  onSkip: () => void;
}) {
  return (
    <StepShell step={0}>
      <Text style={s.logo}>[*]</Text>
      <Heading label="AGENT BRAIN" />
      <Sub>
        Your 0x01 agent can make decisions on its own — accept tasks, earn USDC, build
        reputation — while your phone is locked.{'\n\n'}
        It needs an LLM provider to reason with. You bring your own API key; it never
        leaves this device.
      </Sub>

      <View style={s.featureList}>
        {[
          'Accepts tasks from the mesh automatically',
          'Earns USDC for completed work',
          'Builds on-chain reputation over time',
          'Runs while you sleep',
        ].map(f => (
          <View key={f} style={s.featureRow}>
            <Text style={s.featureDot}>·</Text>
            <Text style={s.featureText}>{f}</Text>
          </View>
        ))}
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
  onChange,
  onNext,
  onSkip,
}: {
  agentName: string;
  onChange: (v: string) => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  return (
    <StepShell step={1}>
      <Heading label="NAME YOUR AGENT" />
      <Sub>
        This is how your agent appears on the mesh — in the discovery feed, reputation
        leaderboard, and task threads. You can change it anytime in Settings.
      </Sub>

      <View style={s.keyCard}>
        <Text style={s.keyLabel}>AGENT NAME</Text>
        <TextInput
          style={s.keyInput}
          value={agentName}
          onChangeText={onChange}
          placeholder="e.g. fast-eddie, databot-9"
          placeholderTextColor={C.sub}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={32}
        />
      </View>
      <Text style={s.keyHint}>Max 32 characters. Leave blank to use your agent ID prefix.</Text>

      <PrimaryBtn label="CONTINUE →" onPress={onNext} />
      <GhostBtn label="skip" onPress={onSkip} />
    </StepShell>
  );
}

// ============================================================================
// Step 2 — Provider selection
// ============================================================================

function ProviderStep({
  provider,
  onSelect,
}: {
  provider: LlmProvider;
  onSelect: (p: LlmProvider) => void;
}) {
  return (
    <StepShell step={2}>
      <Heading label="CHOOSE LLM PROVIDER" />
      <Sub>
        Your agent uses a fast, low-cost model for decisions. All inference calls go
        directly from your device to the provider — not through 0x01 servers.
      </Sub>

      <View style={s.providerGrid}>
        {PROVIDERS.map((p: ProviderInfo) => (
          <TouchableOpacity
            key={p.key}
            style={[s.providerCard, provider === p.key && s.providerCardActive]}
            onPress={() => onSelect(p.key)}
            activeOpacity={0.8}
          >
            <Text style={[s.providerLabel, provider === p.key && s.providerLabelActive]}>
              {p.label}
            </Text>
            <Text style={s.providerModel}>{p.model}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Sub>Get a key at {PROVIDERS.find(p => p.key === provider)?.hint}</Sub>
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
}) {
  const providerInfo = PROVIDERS.find(p => p.key === provider)!;

  const handleNext = () => {
    if (!apiKey.trim()) {
      Alert.alert('Key required', `Paste your ${providerInfo.label} API key to continue.`);
      return;
    }
    onNext();
  };

  return (
    <StepShell step={3}>
      <BackBtn onPress={onBack} />
      <Heading label={`${providerInfo.label.toUpperCase()} API KEY`} />
      <Sub>
        Stored in your device keychain — hardware-protected on supported devices.
        Never uploaded to 0x01 servers.
      </Sub>

      <View style={s.keyCard}>
        <Text style={s.keyLabel}>API KEY</Text>
        <TextInput
          style={s.keyInput}
          value={apiKey}
          onChangeText={onChangeKey}
          placeholder={`sk-...`}
          placeholderTextColor={C.sub}
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
              placeholderTextColor={C.sub}
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
              placeholderTextColor={C.sub}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
            />
          </View>
        </>
      )}

      <Text style={s.keyHint}>
        Get yours at {providerInfo.hint}
      </Text>

      <PrimaryBtn label="CONTINUE →" onPress={handleNext} disabled={!apiKey.trim()} />
    </StepShell>
  );
}

// ============================================================================
// Step 4 — Capabilities
// ============================================================================

function CapabilitiesStep({
  capabilities,
  onToggle,
  onBack,
  onNext,
}: {
  capabilities: Capability[];
  onToggle: (c: Capability) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <StepShell step={4}>
      <BackBtn onPress={onBack} />
      <Heading label="CAPABILITIES" />
      <Sub>
        Enabled capabilities are advertised to the mesh. Other agents will send tasks
        that match what you offer.
      </Sub>

      <View style={s.capList}>
        {ALL_CAPABILITIES.map(cap => {
          const active = capabilities.includes(cap);
          return (
            <TouchableOpacity
              key={cap}
              style={[s.capRow, active && s.capRowActive]}
              onPress={() => onToggle(cap)}
              activeOpacity={0.8}
            >
              <View style={[s.capCheck, active && s.capCheckActive]}>
                {active && <Text style={s.capCheckMark}>✓</Text>}
              </View>
              <Text style={[s.capLabel, active && s.capLabelActive]}>
                {CAPABILITY_LABELS[cap]}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <PrimaryBtn
        label="CONTINUE →"
        onPress={onNext}
        disabled={capabilities.length === 0}
      />
    </StepShell>
  );
}

// ============================================================================
// Step 5 — Rules
// ============================================================================

function RulesStep({
  minFeeUsdc,
  minRep,
  autoAccept,
  onMinFee,
  onMinRep,
  onAutoAccept,
  onBack,
  onFinish,
  saving,
}: {
  minFeeUsdc: string;
  minRep: string;
  autoAccept: boolean;
  onMinFee: (v: string) => void;
  onMinRep: (v: string) => void;
  onAutoAccept: (v: boolean) => void;
  onBack: () => void;
  onFinish: () => void;
  saving: boolean;
}) {
  return (
    <StepShell step={5}>
      <BackBtn onPress={onBack} />
      <Heading label="AUTO-ACCEPT RULES" />
      <Sub>
        Your agent uses these rules to decide whether to take a task without asking you.
        You can change them anytime in Settings.
      </Sub>

      <View style={s.ruleCard}>
        <View style={s.ruleRow}>
          <View style={s.ruleLeft}>
            <Text style={s.ruleLabel}>MIN FEE (USDC)</Text>
            <Text style={s.ruleSub}>Reject tasks paying less than this</Text>
          </View>
          <TextInput
            style={s.ruleInput}
            value={minFeeUsdc}
            onChangeText={onMinFee}
            keyboardType="decimal-pad"
            placeholder="0.01"
            placeholderTextColor={C.sub}
          />
        </View>

        <View style={[s.ruleRow, { borderBottomWidth: 0 }]}>
          <View style={s.ruleLeft}>
            <Text style={s.ruleLabel}>MIN REPUTATION</Text>
            <Text style={s.ruleSub}>Only work with agents above this score</Text>
          </View>
          <TextInput
            style={s.ruleInput}
            value={minRep}
            onChangeText={onMinRep}
            keyboardType="number-pad"
            placeholder="50"
            placeholderTextColor={C.sub}
          />
        </View>
      </View>

      <View style={s.toggleCard}>
        <View style={s.toggleLeft}>
          <Text style={s.ruleLabel}>AUTO-ACCEPT</Text>
          <Text style={s.ruleSub}>
            {autoAccept
              ? 'Agent accepts qualifying tasks without your approval'
              : 'Agent asks you before accepting any task'}
          </Text>
        </View>
        <Switch
          value={autoAccept}
          onValueChange={onAutoAccept}
          trackColor={{ false: C.border, true: C.green + '66' }}
          thumbColor={autoAccept ? C.green : '#333'}
        />
      </View>

      <PrimaryBtn
        label={saving ? 'SAVING…' : 'FINISH SETUP'}
        onPress={onFinish}
        disabled={saving}
      />
    </StepShell>
  );
}

// ============================================================================
// Root
// ============================================================================

const NODE_CONFIG_KEY = 'zerox1:node_config';

export function OnboardingScreen({ onDone }: { onDone: (config: AgentBrainConfig | null) => void }) {
  const [step, setStep] = useState(0);
  const [agentName, setAgentName] = useState('');
  const [provider, setProvider] = useState<LlmProvider>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [capabilities, setCapabilities] = useState<Capability[]>(['summarization', 'qa']);
  const [minFeeUsdc, setMinFeeUsdc] = useState('0.01');
  const [minRep, setMinRep] = useState('50');
  const [autoAccept, setAutoAccept] = useState(true);
  const [saving, setSaving] = useState(false);

  const toggleCapability = (cap: Capability) => {
    setCapabilities(prev =>
      prev.includes(cap) ? prev.filter(c => c !== cap) : [...prev, cap]
    );
  };

  const handleSkip = async () => {
    await markOnboardingDone();
    onDone(null);
  };

  const handleFinish = async () => {
    setSaving(true);
    try {
      // Persist agent name into the node config so the node binary picks it up.
      if (agentName.trim()) {
        const raw = await AsyncStorage.getItem(NODE_CONFIG_KEY);
        let existing: Record<string, unknown> = {};
        try { existing = raw ? JSON.parse(raw) : {}; } catch { /* corrupted — start fresh */ }
        await AsyncStorage.setItem(
          NODE_CONFIG_KEY,
          JSON.stringify({ ...existing, agentName: agentName.trim() }),
        );
      }

      await saveLlmApiKey(apiKey.trim());
      const config: AgentBrainConfig = {
        enabled: true,
        provider,
        capabilities,
        minFeeUsdc: parseFloat(minFeeUsdc) || 0.01,
        minReputation: parseInt(minRep, 10) || 50,
        autoAccept,
        apiKeySet: true,
        customBaseUrl: customBaseUrl.trim() || '',
        customModel: customModel.trim() || '',
      };
      await markOnboardingDone();
      onDone(config);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Failed to save config.');
    } finally {
      setSaving(false);
    }
  };

  switch (step) {
    case 0:
      return <WelcomeStep onEnable={() => setStep(1)} onSkip={handleSkip} />;
    case 1:
      return (
        <NameStep
          agentName={agentName}
          onChange={setAgentName}
          onNext={() => setStep(2)}
          onSkip={() => setStep(2)}
        />
      );
    case 2:
      return (
        <ProviderStep
          provider={provider}
          onSelect={p => { setProvider(p); setStep(3); }}
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
          onNext={() => setStep(4)}
        />
      );
    case 4:
      return (
        <CapabilitiesStep
          capabilities={capabilities}
          onToggle={toggleCapability}
          onBack={() => setStep(3)}
          onNext={() => setStep(5)}
        />
      );
    default:
      return (
        <RulesStep
          minFeeUsdc={minFeeUsdc}
          minRep={minRep}
          autoAccept={autoAccept}
          onMinFee={setMinFeeUsdc}
          onMinRep={setMinRep}
          onAutoAccept={setAutoAccept}
          onBack={() => setStep(4)}
          onFinish={handleFinish}
          saving={saving}
        />
      );
  }
}

// ============================================================================
// Styles
// ============================================================================

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  content: { padding: 28, paddingTop: 56, paddingBottom: 48 },
  progressRow: { flexDirection: 'row', gap: 6, marginBottom: 36 },
  pip: { height: 3, flex: 1, backgroundColor: C.border, borderRadius: 2 },
  pipDone: { backgroundColor: C.green },
  logo: { fontSize: 32, color: C.green, fontFamily: 'monospace', fontWeight: '700', marginBottom: 20 },
  heading: { fontSize: 18, fontWeight: '700', color: C.text, letterSpacing: 3, fontFamily: 'monospace', marginBottom: 16 },
  sub: { fontSize: 13, color: C.sub, lineHeight: 20, marginBottom: 28 },
  featureList: { marginBottom: 32 },
  featureRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 },
  featureDot: { color: C.green, fontSize: 16, marginRight: 10, lineHeight: 20 },
  featureText: { color: C.text, fontSize: 13, lineHeight: 20, flex: 1 },
  primaryBtn: { backgroundColor: C.green, borderRadius: 4, paddingVertical: 16, alignItems: 'center', marginBottom: 12 },
  primaryBtnDisabled: { backgroundColor: C.border },
  primaryBtnText: { fontSize: 13, fontWeight: '700', letterSpacing: 3, color: '#000' },
  primaryBtnTextDisabled: { color: C.sub },
  ghostBtn: { alignItems: 'center', paddingVertical: 12 },
  ghostBtnText: { fontSize: 12, color: C.sub, letterSpacing: 1 },
  backBtn: { marginBottom: 24 },
  backBtnText: { fontSize: 11, color: C.sub, letterSpacing: 2, fontFamily: 'monospace' },
  // Provider grid
  providerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  providerCard: { width: '47%', backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 16 },
  providerCardActive: { borderColor: C.green, backgroundColor: C.green + '12' },
  providerLabel: { fontSize: 15, fontWeight: '700', color: C.sub, fontFamily: 'monospace', marginBottom: 4 },
  providerLabelActive: { color: C.green },
  providerModel: { fontSize: 10, color: C.sub, fontFamily: 'monospace' },
  // API key
  keyCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 16, marginBottom: 12 },
  keyLabel: { fontSize: 10, color: C.sub, letterSpacing: 2, marginBottom: 8 },
  keyInput: { color: C.text, fontFamily: 'monospace', fontSize: 14 },
  keyHint: { fontSize: 11, color: C.sub, marginBottom: 28 },
  // Capabilities
  capList: { marginBottom: 28 },
  capRow: { flexDirection: 'row', alignItems: 'center', padding: 14, borderWidth: 1, borderColor: C.border, borderRadius: 4, marginBottom: 8 },
  capRowActive: { borderColor: C.green + '60', backgroundColor: C.green + '08' },
  capCheck: { width: 20, height: 20, borderRadius: 3, borderWidth: 1, borderColor: C.sub, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  capCheckActive: { borderColor: C.green, backgroundColor: C.green },
  capCheckMark: { fontSize: 12, color: '#000', fontWeight: '700' },
  capLabel: { fontSize: 14, color: C.sub, fontFamily: 'monospace' },
  capLabelActive: { color: C.text },
  // Rules
  ruleCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 4, marginBottom: 12, overflow: 'hidden' },
  ruleRow: { flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: C.border },
  ruleLeft: { flex: 1 },
  ruleLabel: { fontSize: 11, color: C.text, letterSpacing: 2, fontWeight: '600' },
  ruleSub: { fontSize: 11, color: C.sub, marginTop: 3 },
  ruleInput: { color: C.green, fontFamily: 'monospace', fontSize: 16, fontWeight: '700', width: 60, textAlign: 'right' },
  toggleCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 16, marginBottom: 28 },
  toggleLeft: { flex: 1, marginRight: 12 },
});
