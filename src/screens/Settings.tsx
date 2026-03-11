/**
 * Settings — node config (agent name, relay addr, RPC URL, host node URL)
 * and auto-start toggle.
 */
import React, { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Image,
} from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import { useNode } from '../hooks/useNode';
import { NodeModule } from '../native/NodeModule';
import {
  BridgeCapabilityKey,
  HostingNode,
  assertValidHostUrl,
  probeRtt,
  registerAsHosted,
  useBridgeCapabilities,
  useHostingNodes,
  useBagsConfig,
  saveBagsApiKey,
  clearBagsApiKey,
  loadBagsApiKey,
} from '../hooks/useNodeApi';
import {
  ALL_CAPABILITIES,
  CAPABILITY_LABELS,
  Capability,
  PROVIDERS,
  clearLlmApiKey,
  saveLlmApiKey,
  useAgentBrain,
} from '../hooks/useAgentBrain';
import { PermissionName, usePermissions } from '../hooks/usePermissions';

const C = {
  bg: '#050505',
  card: '#0f0f0f',
  border: '#1a1a1a',
  green: '#00e676',
  red: '#ff1744',
  text: '#ffffff',
  sub: '#555555',
  amber: '#ffc107',
  input: '#111111',
  inputBorder: '#2a2a2a',
};

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.sub}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
      />
    </View>
  );
}

// ── Signal bars ──────────────────────────────────────────────────────────────

function signalLevel(rtt: number | undefined): number {
  if (rtt === undefined) return 0;
  if (rtt <= 50) return 5;
  if (rtt <= 100) return 4;
  if (rtt <= 200) return 3;
  if (rtt <= 500) return 2;
  return 1;
}

function SignalBars({ rtt }: { rtt: number | undefined }) {
  if (rtt === undefined) {
    return <Text style={s.signalNull}>—</Text>;
  }
  const level = signalLevel(rtt);
  return (
    <View style={s.barsRow}>
      {[1, 2, 3, 4, 5].map(i => (
        <View
          key={i}
          style={[
            s.bar,
            { height: 4 + i * 3, backgroundColor: i <= level ? C.green : C.border },
          ]}
        />
      ))}
    </View>
  );
}

// ── Host Browser Sheet ───────────────────────────────────────────────────────

function HostBrowserSheet({
  visible,
  onClose,
  onConnect,
}: {
  visible: boolean;
  onClose: () => void;
  onConnect: (nodeApiUrl: string) => void;
}) {
  const nodes = useHostingNodes();
  const [connecting, setConnecting] = useState<string | null>(null);

  const handleConnect = (node: HostingNode) => {
    Alert.alert(
      'Connect to Host',
      `Connect to "${node.name || node.node_id.slice(0, 12)}"?\nFee: ${node.fee_bps} bps`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Connect',
          onPress: async () => {
            setConnecting(node.node_id);
            try {
              await registerAsHosted(node.api_url);
              onConnect(node.api_url);
              onClose();
            } catch (e: any) {
              Alert.alert('Connection Failed', e?.message ?? 'Unknown error');
            } finally {
              setConnecting(null);
            }
          },
        },
      ],
    );
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.sheetOverlay}>
        <View style={s.sheet}>
          <View style={s.sheetHeader}>
            <Text style={s.sheetTitle}>AVAILABLE HOSTS</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={s.sheetClose}>CLOSE</Text>
            </TouchableOpacity>
          </View>

          {nodes.length === 0 ? (
            <Text style={s.sheetEmpty}>no hosts online</Text>
          ) : (
            nodes.map(node => (
              <TouchableOpacity
                key={node.node_id}
                style={s.hostRow}
                onPress={() => handleConnect(node)}
                disabled={connecting === node.node_id}
                activeOpacity={0.7}
              >
                <View style={s.hostInfo}>
                  <Text style={s.hostName}>
                    {node.name || node.node_id.slice(0, 16)}
                  </Text>
                  <Text style={s.hostMeta}>
                    {node.hosted_count} hosted
                  </Text>
                </View>
                <View style={s.hostRight}>
                  <View style={s.feeBadge}>
                    <Text style={s.feeBadgeText}>{node.fee_bps} bps</Text>
                  </View>
                  <SignalBars rtt={node.rtt_ms} />
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>
      </View>
    </Modal>
  );
}

// ── Main screen ──────────────────────────────────────────────────────────────

// ── Agent Brain section ───────────────────────────────────────────────────────

function AgentBrainSection() {
  const { config, save } = useAgentBrain();
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [dirty, setDirty] = useState(false);

  const saveAndDirty = (cfg: typeof config) => { save(cfg); setDirty(true); };

  const toggleEnabled = () => saveAndDirty({ ...config, enabled: !config.enabled });

  const toggleCapability = (cap: Capability) => {
    const next = config.capabilities.includes(cap)
      ? config.capabilities.filter(c => c !== cap)
      : [...config.capabilities, cap];
    saveAndDirty({ ...config, capabilities: next });
  };

  const handleSaveKey = async () => {
    if (!newKey.trim()) return;
    await saveLlmApiKey(newKey.trim());
    await save({ ...config, apiKeySet: true });
    setNewKey('');
    setShowKeyInput(false);
    setDirty(true);
    Alert.alert('Saved', 'API key updated in device keychain.');
  };

  const handleClearKey = () => {
    Alert.alert('Remove API key', 'This will disable the agent brain.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await clearLlmApiKey();
          await save({ ...config, enabled: false, apiKeySet: false });
        },
      },
    ]);
  };

  const providerInfo = PROVIDERS.find(p => p.key === config.provider);

  return (
    <View style={bs.section}>
      {/* Restart-required banner */}
      {dirty && (
        <View style={bs.restartBanner}>
          <Text style={bs.restartBannerText}>Changes apply after node restart.</Text>
          <TouchableOpacity onPress={() => setDirty(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={bs.restartBannerDismiss}>[×]</Text>
          </TouchableOpacity>
        </View>
      )}
      {/* Header row */}
      <View style={bs.headerRow}>
        <View>
          <Text style={bs.sectionTitle}>AGENT BRAIN</Text>
          <Text style={bs.sectionSub}>01 Pilot (ZeroClaw runtime) · {providerInfo?.label ?? '—'}</Text>
        </View>
        <Switch
          value={config.enabled && config.apiKeySet}
          onValueChange={toggleEnabled}
          disabled={!config.apiKeySet}
          trackColor={{ false: C.border, true: C.green + '66' }}
          thumbColor={config.enabled && config.apiKeySet ? C.green : '#333'}
        />
      </View>

      {/* API key status */}
      <View style={bs.row}>
        <View style={bs.rowLeft}>
          <Text style={bs.rowLabel}>API KEY</Text>
          <Text style={bs.rowSub}>
            {config.apiKeySet ? '●●●●●●●● (keychain)' : 'not set'}
          </Text>
        </View>
        <View style={bs.rowBtns}>
          {config.apiKeySet && (
            <TouchableOpacity style={bs.miniBtn} onPress={handleClearKey} activeOpacity={0.8}>
              <Text style={[bs.miniBtnText, { color: C.red }]}>CLEAR</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={bs.miniBtn}
            onPress={() => setShowKeyInput(v => !v)}
            activeOpacity={0.8}
          >
            <Text style={bs.miniBtnText}>{config.apiKeySet ? 'CHANGE' : 'SET'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {showKeyInput && (
        <View style={bs.keyInputWrap}>
          <TextInput
            style={bs.keyInput}
            value={newKey}
            onChangeText={setNewKey}
            placeholder="paste API key…"
            placeholderTextColor={C.sub}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={bs.saveKeyBtn} onPress={handleSaveKey} activeOpacity={0.8}>
            <Text style={bs.saveKeyBtnText}>SAVE</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Provider */}
      <View style={bs.row}>
        <Text style={bs.rowLabel}>PROVIDER</Text>
        <View style={bs.providerRow}>
          {PROVIDERS.map(p => (
            <TouchableOpacity
              key={p.key}
              style={[bs.providerChip, config.provider === p.key && bs.providerChipActive]}
              onPress={() => saveAndDirty({ ...config, provider: p.key })}
              activeOpacity={0.8}
            >
              <Text style={[bs.providerChipText, config.provider === p.key && bs.providerChipTextActive]}>
                {p.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {config.provider === 'custom' && (
        <View style={[bs.row, { flexDirection: 'column', gap: 12 }]}>
          <View style={bs.customField}>
            <Text style={bs.customFieldLabel}>BASE URL</Text>
            <TextInput
              style={bs.customFieldInput}
              value={config.customBaseUrl || ''}
              onChangeText={v => saveAndDirty({ ...config, customBaseUrl: v })}
              placeholder="e.g. https://api.openai.com/v1"
              placeholderTextColor={C.sub}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
            />
          </View>
          <View style={bs.customField}>
            <Text style={bs.customFieldLabel}>MODEL (optional)</Text>
            <TextInput
              style={bs.customFieldInput}
              value={config.customModel || ''}
              onChangeText={v => saveAndDirty({ ...config, customModel: v })}
              placeholder="e.g. gpt-4, my-custom-model"
              placeholderTextColor={C.sub}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
            />
          </View>
        </View>
      )}

      {/* Capabilities */}
      <View style={[bs.row, { flexDirection: 'column', alignItems: 'flex-start' }]}>
        <Text style={[bs.rowLabel, { marginBottom: 10 }]}>CAPABILITIES</Text>
        <View style={bs.capWrap}>
          {ALL_CAPABILITIES.map(cap => {
            const active = config.capabilities.includes(cap);
            return (
              <TouchableOpacity
                key={cap}
                style={[bs.capChip, active && bs.capChipActive]}
                onPress={() => toggleCapability(cap)}
                activeOpacity={0.8}
              >
                <Text style={[bs.capChipText, active && bs.capChipTextActive]}>
                  {CAPABILITY_LABELS[cap]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Rules */}
      <View style={bs.row}>
        <View style={bs.rowLeft}>
          <Text style={bs.rowLabel}>MIN FEE</Text>
          <Text style={bs.rowSub}>Reject tasks below this USDC amount</Text>
        </View>
        <TextInput
          style={bs.ruleInput}
          value={String(config.minFeeUsdc)}
          onChangeText={v => saveAndDirty({ ...config, minFeeUsdc: parseFloat(v) || 0 })}
          keyboardType="decimal-pad"
          placeholderTextColor={C.sub}
        />
      </View>

      <View style={bs.row}>
        <View style={bs.rowLeft}>
          <Text style={bs.rowLabel}>MIN REPUTATION</Text>
          <Text style={bs.rowSub}>Only accept from agents above this score</Text>
        </View>
        <TextInput
          style={bs.ruleInput}
          value={String(config.minReputation)}
          onChangeText={v => saveAndDirty({ ...config, minReputation: parseInt(v, 10) || 0 })}
          keyboardType="number-pad"
          placeholderTextColor={C.sub}
        />
      </View>

      <View style={[bs.row, { borderBottomWidth: 0 }]}>
        <View style={bs.rowLeft}>
          <Text style={bs.rowLabel}>AUTO-ACCEPT</Text>
          <Text style={bs.rowSub}>Accept qualifying tasks without approval</Text>
        </View>
        <Switch
          value={config.autoAccept}
          onValueChange={v => saveAndDirty({ ...config, autoAccept: v })}
          trackColor={{ false: C.border, true: C.green + '66' }}
          thumbColor={config.autoAccept ? C.green : '#333'}
        />
      </View>
    </View>
  );
}

// ── Phone Capabilities section ────────────────────────────────────────────────

const CAPABILITY_GROUPS: { label: string; perms: PermissionName[] }[] = [
  { label: 'Contacts', perms: ['READ_CONTACTS', 'WRITE_CONTACTS'] },
  { label: 'SMS', perms: ['READ_SMS', 'SEND_SMS'] },
  { label: 'Location', perms: ['ACCESS_FINE_LOCATION'] },
  { label: 'Calendar', perms: ['READ_CALENDAR', 'WRITE_CALENDAR'] },
  { label: 'Call Log', perms: ['READ_CALL_LOG'] },
  { label: 'Camera', perms: ['CAMERA'] },
  { label: 'Microphone', perms: ['RECORD_AUDIO'] },
  { label: 'Files', perms: ['READ_MEDIA_IMAGES'] },
];

function PhoneCapabilitiesSection() {
  const { perms, request } = usePermissions();

  const handlePress = async (needed: PermissionName[]) => {
    for (const p of needed) {
      if (!perms?.[p]) await request(p);
    }
  };

  return (
    <View style={ps.section}>
      <View style={ps.headerRow}>
        <View>
          <Text style={ps.sectionTitle}>PHONE CAPABILITIES</Text>
          <Text style={ps.sectionSub}>Grant to let your agent act on your phone.</Text>
        </View>
      </View>
      <View style={ps.chipGrid}>
        {CAPABILITY_GROUPS.map(({ label, perms: needed }) => {
          const granted = needed.every(p => perms?.[p]);
          return (
            <TouchableOpacity
              key={label}
              style={[ps.chip, granted && ps.chipActive]}
              onPress={() => handlePress(needed)}
              activeOpacity={0.8}
            >
              <Text style={[ps.chipText, granted && ps.chipTextActive]}>
                {granted ? '[x]' : '[ ]'} {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// ── Agent Capabilities Section ────────────────────────────────────────────────

const CAPABILITY_INFO: Record<BridgeCapabilityKey, { label: string; desc: string }> = {
  messaging: { label: 'MESSAGING', desc: 'Read SMS, read & reply to notifications (WhatsApp, email, etc.)' },
  contacts: { label: 'CONTACTS', desc: 'Read and create contacts in your address book' },
  location: { label: 'LOCATION', desc: 'Read your last known GPS coordinates' },
  camera: { label: 'CAMERA', desc: 'Capture a photo from front or rear camera in the background' },
  microphone: { label: 'MICROPHONE', desc: 'Record short audio clips (up to 30 seconds)' },
  screen: { label: 'SCREEN', desc: 'Read UI of any open app, tap buttons, take silent screenshots (requires Accessibility setup)' },
  calls: { label: 'CALLS', desc: 'Read call history and screen incoming calls (allow / reject / silence)' },
  calendar: { label: 'CALENDAR', desc: 'Read upcoming events and create new calendar entries' },
  media: { label: 'MEDIA', desc: 'Browse photos and documents on device storage' },
  motion: { label: 'MOTION', desc: 'Read accelerometer and gyroscope for movement and activity data collection' },
};

function AgentCapabilitiesSection() {
  const { caps, loading, toggle } = useBridgeCapabilities();

  if (loading) return null;

  const keys = Object.keys(CAPABILITY_INFO) as BridgeCapabilityKey[];

  function openAccessibility() {
    if (Platform.OS === 'android') {
      Linking.sendIntent('android.settings.ACCESSIBILITY_SETTINGS').catch(() =>
        Linking.openSettings(),
      );
    }
  }

  function openNotificationAccess() {
    if (Platform.OS === 'android') {
      Linking.sendIntent(
        'android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS',
      ).catch(() => Linking.openSettings());
    }
  }

  return (
    <View style={cs.section}>
      <View style={cs.header}>
        <Text style={cs.title}>AGENT CAPABILITIES</Text>
        <Text style={cs.subtitle}>
          Choose what your AI agent can access on this device.
          Changes take effect immediately — no restart needed.
        </Text>
      </View>
      {keys.map((key, idx) => {
        const info = CAPABILITY_INFO[key];
        const enabled = caps[key] ?? true;
        const isLast = idx === keys.length - 1;
        return (
          <View key={key} style={[cs.row, !isLast && cs.rowBorder]}>
            <View style={cs.rowText}>
              <Text style={cs.capLabel}>{info.label}</Text>
              <Text style={cs.capDesc}>{info.desc}</Text>
            </View>
            <Switch
              value={enabled}
              onValueChange={(v) => toggle(key, v)}
              trackColor={{ false: C.border, true: C.amber + '66' }}
              thumbColor={enabled ? C.amber : '#333'}
            />
          </View>
        );
      })}
      {Platform.OS === 'android' && (
        <View style={cs.permButtons}>
          <Text style={cs.permHint}>
            Some capabilities require manual system permission:
          </Text>
          <TouchableOpacity style={cs.permBtn} onPress={openAccessibility}>
            <Text style={cs.permBtnText}>↗ Accessibility Settings</Text>
            <Text style={cs.permBtnSub}>Required for SCREEN capability</Text>
          </TouchableOpacity>
          <TouchableOpacity style={cs.permBtn} onPress={openNotificationAccess}>
            <Text style={cs.permBtnText}>↗ Notification Access</Text>
            <Text style={cs.permBtnSub}>Required for MESSAGING capability</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ── Data Collection section ────────────────────────────────────────────────────

type BudgetLevel = 0 | 25 | 50 | 100;
const BUDGET_LEVELS: { label: string; pct: BudgetLevel; desc: string }[] = [
  { label: 'OFF',  pct: 0,   desc: 'disabled' },
  { label: 'LOW',  pct: 25,  desc: '>25%' },
  { label: 'MED',  pct: 50,  desc: '>50%' },
  { label: 'FULL', pct: 100, desc: '>100%' },
];

function DataCollectionSection() {
  const [budget, setBudget] = useState<BudgetLevel>(100);

  useEffect(() => {
    NodeModule.getDataBudget().then(pct => {
      const snapped: BudgetLevel = pct === 0 ? 0 : pct <= 25 ? 25 : pct <= 50 ? 50 : 100;
      setBudget(snapped);
    }).catch(() => {});
  }, []);

  const handleSelect = (pct: BudgetLevel) => {
    setBudget(pct);
    NodeModule.setDataBudget(pct).catch(() => {});
  };

  return (
    <View style={dcs.section}>
      <View style={dcs.header}>
        <Text style={dcs.title}>DATA COLLECTION</Text>
        <Text style={dcs.subtitle}>
          Minimum battery % to serve sensor requests (IMU, audio, camera).
        </Text>
      </View>
      <View style={dcs.levels}>
        {BUDGET_LEVELS.map(({ label, pct, desc }) => (
          <TouchableOpacity
            key={label}
            style={[dcs.levelBtn, budget === pct && dcs.levelBtnActive]}
            onPress={() => handleSelect(pct)}
            activeOpacity={0.8}
          >
            <Text style={[dcs.levelLabel, budget === pct && dcs.levelLabelActive]}>{label}</Text>
            <Text style={dcs.levelDesc}>{desc}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const dcs = StyleSheet.create({
  section: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: '#00bcd430',
    borderRadius: 4,
    marginBottom: 16,
    overflow: 'hidden',
  },
  header: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: '#00080a',
  },
  title: { fontSize: 11, color: '#00bcd4', letterSpacing: 3, fontWeight: '700', fontFamily: 'monospace' },
  subtitle: { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginTop: 4, lineHeight: 14 },
  levels: { flexDirection: 'row', padding: 12, gap: 8 },
  levelBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 3,
    paddingVertical: 10,
    alignItems: 'center',
  },
  levelBtnActive: { borderColor: '#00bcd4', backgroundColor: '#00bcd418' },
  levelLabel: { fontSize: 10, fontWeight: '700', color: C.sub, letterSpacing: 1, fontFamily: 'monospace' },
  levelLabelActive: { color: '#00bcd4' },
  levelDesc: { fontSize: 9, color: C.sub, fontFamily: 'monospace', marginTop: 3 },
});

// ── Bags Fee Sharing section ──────────────────────────────────────────────────

function BagsFeeSection({
  isLocalMode,
  bagsFeePercent,
  onBagsFeePercentChange,
  bagsWallet,
  onBagsWalletChange,
  bagsEnabled,
  onBagsEnabledChange,
  bagsApiKeySet,
  onBagsApiKeySave,
  onBagsApiKeyClear,
}: {
  isLocalMode: boolean;
  bagsFeePercent: string;
  onBagsFeePercentChange: (v: string) => void;
  bagsWallet: string;
  onBagsWalletChange: (v: string) => void;
  bagsEnabled: boolean;
  onBagsEnabledChange: (v: boolean) => void;
  bagsApiKeySet: boolean;
  onBagsApiKeySave: (key: string) => Promise<void>;
  onBagsApiKeyClear: () => Promise<void>;
}) {
  const liveConfig = useBagsConfig();
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');

  if (!isLocalMode) return null;

  return (
    <View style={bfs.section}>
      <View style={bfs.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={bfs.sectionTitle}>BAGS FEE SHARING</Text>
          <Text style={bfs.sectionSub}>
            Route a % of swap + escrow revenue to BAGS holders
          </Text>
        </View>
        <Switch
          value={bagsEnabled}
          onValueChange={onBagsEnabledChange}
          trackColor={{ false: C.border, true: '#9c27b0' + '66' }}
          thumbColor={bagsEnabled ? '#9c27b0' : '#333'}
        />
      </View>

      {bagsEnabled && (
        <>
          <View style={bfs.row}>
            <View style={bfs.rowLeft}>
              <Text style={bfs.rowLabel}>FEE %</Text>
              <Text style={bfs.rowSub}>% of each swap output / escrow to share (max 5%)</Text>
            </View>
            <TextInput
              style={bfs.feeInput}
              value={bagsFeePercent}
              onChangeText={onBagsFeePercentChange}
              keyboardType="decimal-pad"
              placeholder="0.5"
              placeholderTextColor={C.sub}
            />
          </View>
          <View style={[bfs.row, { borderBottomWidth: 0 }]}>
            <View style={bfs.rowLeft}>
              <Text style={bfs.rowLabel}>DISTRIBUTION WALLET</Text>
              <Text style={bfs.rowSub}>
                Base58 Solana pubkey. Leave empty to resolve from Bags API.
              </Text>
            </View>
          </View>
          <View style={[bfs.row, { borderBottomWidth: 0, paddingTop: 0 }]}>
            <TextInput
              style={[bfs.feeInput, { flex: 1, fontFamily: 'monospace', fontSize: 11 }]}
              value={bagsWallet}
              onChangeText={onBagsWalletChange}
              placeholder="auto (from bags.fm)"
              placeholderTextColor={C.sub}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          {liveConfig?.enabled && (
            <View style={bfs.liveRow}>
              <Text style={bfs.liveDot}>●</Text>
              <Text style={bfs.liveText}>
                live: {(liveConfig.fee_bps / 100).toFixed(2)}% → {liveConfig.distribution_wallet ? `${liveConfig.distribution_wallet.slice(0, 8)}…${liveConfig.distribution_wallet.slice(-6)}` : 'auto'}
              </Text>
            </View>
          )}
        </>
      )}

      {/* Bags API Key — Keychain-protected */}
      <View style={[bfs.row, { borderBottomWidth: 0, paddingTop: 12 }]}>
        <View style={bfs.rowLeft}>
          <Text style={bfs.rowLabel}>BAGS API KEY</Text>
          <Text style={bfs.rowSub}>
            Required to launch tokens via Bags.fm. Stored in OS Keychain.
          </Text>
        </View>
      </View>
      {showKeyInput ? (
        <View style={[bfs.row, { borderBottomWidth: 0, paddingTop: 0, gap: 8 }]}>
          <TextInput
            style={[bfs.feeInput, { flex: 1, fontFamily: 'monospace', fontSize: 11 }]}
            value={keyDraft}
            onChangeText={setKeyDraft}
            placeholder="sk-bags-…"
            placeholderTextColor={C.sub}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            autoFocus
          />
          <TouchableOpacity
            style={bfs.miniBtn}
            onPress={async () => {
              const trimmed = keyDraft.trim();
              if (!trimmed) return;
              await onBagsApiKeySave(trimmed);
              setShowKeyInput(false);
              setKeyDraft('');
            }}
          >
            <Text style={bfs.miniBtnText}>SAVE</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[bfs.miniBtn, { backgroundColor: C.border }]}
            onPress={() => { setShowKeyInput(false); setKeyDraft(''); }}
          >
            <Text style={bfs.miniBtnText}>CANCEL</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={[bfs.row, { borderBottomWidth: 0, paddingTop: 0 }]}>
          <Text style={[bfs.rowSub, { flex: 1, color: bagsApiKeySet ? C.text : C.sub }]}>
            {bagsApiKeySet ? '●●●●●●●● (keychain)' : 'not set'}
          </Text>
          <TouchableOpacity style={bfs.miniBtn} onPress={() => setShowKeyInput(true)}>
            <Text style={bfs.miniBtnText}>{bagsApiKeySet ? 'CHANGE' : 'SET'}</Text>
          </TouchableOpacity>
          {bagsApiKeySet && (
            <TouchableOpacity
              style={[bfs.miniBtn, { backgroundColor: '#1a0000', borderColor: C.red + '60', marginLeft: 6 }]}
              onPress={onBagsApiKeyClear}
            >
              <Text style={[bfs.miniBtnText, { color: C.red }]}>CLEAR</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

const bfs = StyleSheet.create({
  section: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: '#9c27b030',
    borderRadius: 4,
    marginBottom: 16,
    overflow: 'hidden',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: '#0d000d',
  },
  sectionTitle: {
    fontSize: 11,
    color: '#9c27b0',
    letterSpacing: 3,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  sectionSub: {
    fontSize: 10,
    color: C.sub,
    fontFamily: 'monospace',
    marginTop: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  rowLeft: { flex: 1, marginRight: 12 },
  rowLabel: {
    fontSize: 10,
    color: C.text,
    letterSpacing: 2,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  rowSub: { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginTop: 3, lineHeight: 14 },
  feeInput: {
    color: C.text,
    fontFamily: 'monospace',
    fontSize: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#9c27b060',
    minWidth: 60,
    textAlign: 'right',
    paddingVertical: 2,
  },
  liveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  liveDot: { fontSize: 8, color: '#9c27b0', marginRight: 6 },
  liveText: { fontSize: 10, color: C.sub, fontFamily: 'monospace' },
  miniBtn: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 3,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  miniBtnText: { fontSize: 9, fontWeight: '700', color: C.text, letterSpacing: 1, fontFamily: 'monospace' },
});

// ── Main screen ───────────────────────────────────────────────────────────────

export function SettingsScreen() {
  const { config, autoStart, saveConfig, setAutoStart, status, start, stop } = useNode();

  const [agentName, setAgentName] = useState(config.agentName ?? '');
  const [agentAvatar, setAgentAvatar] = useState(config.agentAvatar ?? '');
  const [relayAddr, setRelayAddr] = useState(config.relayAddr ?? '');
  const [nodeApiUrl, setNodeApiUrl] = useState(config.nodeApiUrl ?? '');

  // MESH NETWORK: derive selected network from current rpcUrl
  const rpcToNetwork = (url: string): 'devnet' | 'mainnet' =>
    url.includes('devnet') ? 'devnet' : 'mainnet';
  const [meshNetwork, setMeshNetwork] = useState<'devnet' | 'mainnet'>(
    rpcToNetwork(config.rpcUrl ?? 'https://api.mainnet-beta.solana.com'),
  );
  const networkToRpc = (net: 'devnet' | 'mainnet'): string =>
    net === 'devnet'
      ? 'https://api.devnet.solana.com'
      : 'https://api.mainnet-beta.solana.com';
  const [showBrowser, setShowBrowser] = useState(false);

  // Bags fee-sharing state
  const [bagsEnabled, setBagsEnabled] = useState(false);
  const [bagsFeePercent, setBagsFeePercent] = useState('0.5');
  const [bagsWallet, setBagsWallet] = useState('');
  const [bagsApiKeySet, setBagsApiKeySet] = useState(false);

  // Load bags settings on mount; migrate plaintext key from AsyncStorage → Keychain
  useEffect(() => {
    (async () => {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      const [enabled, feeRaw, wallet, legacyKey] = await Promise.all([
        AsyncStorage.getItem('zerox1:bags_enabled'),
        AsyncStorage.getItem('zerox1:bags_fee_percent'),
        AsyncStorage.getItem('zerox1:bags_wallet'),
        AsyncStorage.getItem('zerox1:bags_api_key'),
      ]);
      if (enabled !== null) setBagsEnabled(enabled === 'true');
      if (feeRaw !== null) setBagsFeePercent(feeRaw);
      if (wallet !== null) setBagsWallet(wallet);

      // Migrate plaintext key to Keychain if present
      if (legacyKey) {
        await saveBagsApiKey(legacyKey);
        await AsyncStorage.removeItem('zerox1:bags_api_key');
        setBagsApiKeySet(true);
      } else {
        const existing = await loadBagsApiKey();
        setBagsApiKeySet(!!existing);
      }
    })();
  }, []);

  // Sync local state if config changes from outside (e.g. on mount)
  useEffect(() => {
    setAgentName(config.agentName ?? '');
    setAgentAvatar(config.agentAvatar ?? '');
    setRelayAddr(config.relayAddr ?? '');
    setMeshNetwork(rpcToNetwork(config.rpcUrl ?? 'https://api.devnet.solana.com'));
    setNodeApiUrl(config.nodeApiUrl ?? '');
  }, [config]);

  const handleBagsEnabledChange = (v: boolean) => {
    setBagsEnabled(v);
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    AsyncStorage.setItem('zerox1:bags_enabled', String(v)).catch((e: any) =>
      console.error('Failed to persist bags_enabled:', e),
    );
  };

  const handleBagsFeePercentChange = (v: string) => {
    setBagsFeePercent(v);
    // Only persist valid values (0–5 %) to avoid storing garbage in AsyncStorage.
    const pct = parseFloat(v);
    if (!isNaN(pct) && pct >= 0 && pct <= 5) {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      AsyncStorage.setItem('zerox1:bags_fee_percent', v).catch((e: any) =>
        console.error('Failed to persist bags_fee_percent:', e),
      );
    }
  };

  const handleBagsWalletChange = (v: string) => {
    setBagsWallet(v);
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    AsyncStorage.setItem('zerox1:bags_wallet', v).catch((e: any) =>
      console.error('Failed to persist bags_wallet:', e),
    );
  };

  const handleBagsApiKeySave = async (key: string) => {
    await saveBagsApiKey(key);
    setBagsApiKeySet(true);
  };

  const handleBagsApiKeyClear = async () => {
    await clearBagsApiKey();
    setBagsApiKeySet(false);
  };

  const handleSave = async () => {
    const trimmedNodeApiUrl = nodeApiUrl.trim() || undefined;
    if (trimmedNodeApiUrl) {
      try {
        assertValidHostUrl(trimmedNodeApiUrl);
      } catch (e: any) {
        Alert.alert('Invalid Host URL', e?.message ?? 'URL must use HTTPS.');
        return;
      }
    }
    // Validate bags fee percent
    if (bagsEnabled) {
      const feePct = parseFloat(bagsFeePercent);
      if (isNaN(feePct) || feePct < 0 || feePct > 5) {
        Alert.alert('Invalid Bags Fee', 'Fee must be between 0 and 5%.');
        return;
      }
    }
    const bagsFeesBps = bagsEnabled ? Math.round(parseFloat(bagsFeePercent || '0') * 100) : 0;
    const newConfig = {
      ...config,
      agentName: agentName.trim() || undefined,
      agentAvatar: agentAvatar || undefined,
      relayAddr: relayAddr.trim() || undefined,
      rpcUrl: networkToRpc(meshNetwork),
      nodeApiUrl: trimmedNodeApiUrl,
      bagsFeesBps,
      bagsWallet: bagsWallet.trim() || undefined,
      // bagsApiKey is in Keychain; merged into config at startNode time via withBagsConfig
    };
    await saveConfig(newConfig);
    Alert.alert('Saved', 'Config saved. Restart the node to apply changes.');
  };

  const running = status === 'running';

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Text style={s.heading}>SETTINGS</Text>

        {/* Agent Brain */}
        <AgentBrainSection />

        {/* Phone capabilities (only relevant when brain is enabled) */}
        <PhoneCapabilitiesSection />

        {/* Agent capability toggles */}
        <AgentCapabilitiesSection />

        {/* Data collection battery budget */}
        <DataCollectionSection />

        {/* Bags fee-sharing (local node only) */}
        <BagsFeeSection
          isLocalMode={!nodeApiUrl.trim()}
          bagsFeePercent={bagsFeePercent}
          onBagsFeePercentChange={handleBagsFeePercentChange}
          bagsWallet={bagsWallet}
          onBagsWalletChange={handleBagsWalletChange}
          bagsEnabled={bagsEnabled}
          onBagsEnabledChange={handleBagsEnabledChange}
          bagsApiKeySet={bagsApiKeySet}
          onBagsApiKeySave={handleBagsApiKeySave}
          onBagsApiKeyClear={handleBagsApiKeyClear}
        />

        {/* Node config fields */}
        <View style={s.section}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 24 }}>
            <TouchableOpacity
              onPress={async () => {
                const res = await launchImageLibrary({ mediaType: 'photo', selectionLimit: 1 });
                if (res?.assets?.[0]?.uri) setAgentAvatar(res.assets[0].uri);
              }}
              style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginRight: 16 }}
            >
              {agentAvatar ? (
                <Image source={{ uri: agentAvatar }} style={{ width: 64, height: 64 }} />
              ) : (
                <Text style={{ color: C.sub, fontSize: 20 }}>+</Text>
              )}
            </TouchableOpacity>
            <Text style={{ fontSize: 11, color: C.sub, letterSpacing: 2 }}>PROFILE PICTURE</Text>
          </View>
          <Field
            label="AGENT NAME"
            value={agentName}
            onChange={setAgentName}
            placeholder="my-node"
          />
          <Field
            label="RELAY ADDR"
            value={relayAddr}
            onChange={setRelayAddr}
            placeholder="/ip4/0.0.0.0/tcp/4001/p2p/12D3..."
          />
          {/* Mesh network toggle */}
          <View style={s.field}>
            <Text style={s.fieldLabel}>MESH NETWORK</Text>
            <View style={s.netToggleRow}>
              {(['devnet', 'mainnet'] as const).map(net => (
                <TouchableOpacity
                  key={net}
                  style={[s.netBtn, meshNetwork === net && s.netBtnActive]}
                  onPress={() => setMeshNetwork(net)}
                  activeOpacity={0.8}
                >
                  <Text style={[s.netBtnText, meshNetwork === net && s.netBtnTextActive]}>
                    {net.toUpperCase()}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          {/* Trading always on mainnet — informational badge */}
          <View style={s.tradingBadge}>
            <Text style={s.tradingBadgeText}>TRADING · MAINNET · Jupiter · Bags</Text>
          </View>
          {/* Host node URL — leave empty to run local node */}
          <View style={[s.field, { borderBottomWidth: 0 }]}>
            <Text style={s.fieldLabel}>HOST NODE URL</Text>
            <View style={s.hostFieldRow}>
              <TextInput
                style={[s.input, s.hostUrlInput]}
                value={nodeApiUrl}
                onChangeText={setNodeApiUrl}
                placeholder="leave empty to run local node"
                placeholderTextColor={C.sub}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
              />
              <TouchableOpacity
                style={s.browseBtn}
                onPress={() => setShowBrowser(true)}
                activeOpacity={0.8}
              >
                <Text style={s.browseBtnText}>BROWSE</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <TouchableOpacity style={s.saveBtn} onPress={handleSave} activeOpacity={0.8}>
          <Text style={s.saveBtnText}>SAVE CONFIG</Text>
        </TouchableOpacity>

        {/* On-Chain Registration */}
        <View style={s.section}>
          <View style={s.toggleRow}>
            <View style={{ flex: 1, marginRight: 16 }}>
              <Text style={s.toggleLabel}>ON-CHAIN REGISTRATION</Text>
              <Text style={s.toggleSub}>Register on Solana 8004 to enable tasks. Gas paid by Kora relay.</Text>
            </View>
            <TouchableOpacity
              style={[s.nodeBtn, { margin: 0, paddingVertical: 10, paddingHorizontal: 14, borderColor: C.green + '60' }]}
              onPress={async () => {
                const AsyncStorage = require('@react-native-async-storage/async-storage').default;
                if (!running) {
                  Alert.alert('Node Stopped', 'Start the node first to register on-chain.');
                  return;
                }
                if (nodeApiUrl.trim()) {
                  Alert.alert('Hosted Mode', 'Registration is only supported when running a local node.');
                  return;
                }
                try {
                  const { registerLocal8004 } = require('../hooks/useNodeApi');
                  const res = await registerLocal8004(agentName.trim());
                  await AsyncStorage.setItem('zerox1:8004_registered', 'true');
                  Alert.alert('Success', `Registered on-chain!\nAsset Pubkey:\n${res.asset_pubkey}`);
                } catch (e: any) {
                  Alert.alert('Registration Failed', e.message);
                }
              }}
              activeOpacity={0.8}
            >
              <Text style={[s.nodeBtnText, { fontSize: 11, color: C.green }]}>REGISTER</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Auto-start toggle */}
        <View style={s.section}>
          <View style={s.toggleRow}>
            <View>
              <Text style={s.toggleLabel}>AUTO-START</Text>
              <Text style={s.toggleSub}>Start node automatically on device boot</Text>
            </View>
            <Switch
              value={autoStart}
              onValueChange={setAutoStart}
              trackColor={{ false: C.border, true: C.green + '66' }}
              thumbColor={autoStart ? C.green : '#333'}
            />
          </View>
        </View>

        {/* Quick start/stop */}
        <View style={s.section}>
          <TouchableOpacity
            style={[s.nodeBtn, { borderColor: running ? '#ff174440' : C.green + '40' }]}
            onPress={running ? stop : () => start()}
            activeOpacity={0.8}
          >
            <Text style={[s.nodeBtnText, { color: running ? '#ff1744' : C.green }]}>
              {running ? 'STOP NODE' : 'START NODE'}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <HostBrowserSheet
        visible={showBrowser}
        onClose={() => setShowBrowser(false)}
        onConnect={(url) => setNodeApiUrl(url)}
      />
    </KeyboardAvoidingView>
  );
}

// Agent capabilities stylesheet
const cs = StyleSheet.create({
  section: { backgroundColor: C.card, borderWidth: 1, borderColor: C.amber + '30', borderRadius: 4, marginBottom: 16, overflow: 'hidden' },
  header: { padding: 16, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: '#1a1000' },
  title: { fontSize: 11, color: C.amber, letterSpacing: 3, fontWeight: '700', fontFamily: 'monospace' },
  subtitle: { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginTop: 6, lineHeight: 15 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: C.border },
  rowText: { flex: 1, marginRight: 12 },
  capLabel: { fontSize: 10, color: C.text, letterSpacing: 2, fontWeight: '700', fontFamily: 'monospace' },
  capDesc: { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginTop: 3, lineHeight: 15 },
  permButtons: { paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: C.border, gap: 8 },
  permHint: { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginBottom: 4 },
  permBtn: { backgroundColor: '#0a0a0a', borderWidth: 1, borderColor: C.border, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 8 },
  permBtnText: { fontSize: 10, color: C.amber, fontFamily: 'monospace', fontWeight: '700', letterSpacing: 1 },
  permBtnSub: { fontSize: 9, color: C.sub, fontFamily: 'monospace', marginTop: 2 },
});

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  content: { padding: 24 },
  heading: { fontSize: 11, color: C.sub, letterSpacing: 4, marginBottom: 24 },
  section: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    marginBottom: 16,
    overflow: 'hidden',
  },
  field: { padding: 16, borderBottomWidth: 1, borderBottomColor: C.border },
  fieldLabel: { fontSize: 10, color: C.sub, letterSpacing: 2, marginBottom: 8 },
  input: {
    color: C.text,
    fontFamily: 'monospace',
    fontSize: 14,
    paddingVertical: 0,
  },
  netToggleRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  netBtn: { flex: 1, borderWidth: 1, borderColor: C.border, borderRadius: 3, paddingVertical: 8, alignItems: 'center' },
  netBtnActive: { borderColor: C.green, backgroundColor: C.green + '18' },
  netBtnText: { fontSize: 11, color: C.sub, letterSpacing: 2, fontWeight: '700', fontFamily: 'monospace' },
  netBtnTextActive: { color: C.green },
  tradingBadge: { marginHorizontal: 16, marginBottom: 12, borderWidth: 1, borderColor: '#ffc10730', borderRadius: 3, paddingVertical: 6, alignItems: 'center' },
  tradingBadgeText: { fontSize: 9, color: C.amber, letterSpacing: 2, fontFamily: 'monospace' },
  hostFieldRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hostUrlInput: { flex: 1 },
  browseBtn: {
    borderWidth: 1,
    borderColor: C.green + '60',
    borderRadius: 3,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  browseBtnText: { fontSize: 9, color: C.green, letterSpacing: 2, fontWeight: '700' },
  saveBtn: {
    backgroundColor: C.green,
    borderRadius: 4,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 16,
  },
  saveBtnText: { fontSize: 13, fontWeight: '700', letterSpacing: 3, color: '#000' },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  toggleLabel: { fontSize: 11, color: C.text, letterSpacing: 2, fontWeight: '600' },
  toggleSub: { fontSize: 12, color: C.sub, marginTop: 4 },
  nodeBtn: {
    margin: 16,
    borderWidth: 1,
    borderRadius: 4,
    paddingVertical: 14,
    alignItems: 'center',
  },
  nodeBtnText: { fontSize: 13, fontWeight: '700', letterSpacing: 3 },
  // Host browser sheet
  sheetOverlay: {
    flex: 1,
    backgroundColor: '#000000aa',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: C.card,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    maxHeight: '70%',
    paddingBottom: 32,
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  sheetTitle: { fontSize: 11, color: C.sub, letterSpacing: 3 },
  sheetClose: { fontSize: 11, color: C.green, letterSpacing: 2 },
  sheetEmpty: { padding: 24, color: C.sub, fontFamily: 'monospace', textAlign: 'center' },
  hostRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  hostInfo: { flex: 1 },
  hostName: { fontSize: 14, color: C.text, fontFamily: 'monospace', fontWeight: '600' },
  hostMeta: { fontSize: 11, color: C.sub, marginTop: 2 },
  hostRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  feeBadge: {
    borderWidth: 1,
    borderColor: C.amber + '60',
    borderRadius: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  feeBadgeText: { fontSize: 10, color: C.amber, letterSpacing: 1 },
  barsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  bar: { width: 4, borderRadius: 1 },
  signalNull: { fontSize: 14, color: C.sub },
});

// Phone Capabilities stylesheet
const ps = StyleSheet.create({
  section: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 4, marginBottom: 16, overflow: 'hidden' },
  headerRow: { padding: 16, borderBottomWidth: 1, borderBottomColor: C.border },
  sectionTitle: { fontSize: 11, color: C.text, letterSpacing: 3, fontWeight: '700' },
  sectionSub: { fontSize: 10, color: C.sub, letterSpacing: 1, marginTop: 2 },
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 14 },
  chip: { borderWidth: 1, borderColor: C.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 6 },
  chipActive: { borderColor: C.green, backgroundColor: C.green + '18' },
  chipText: { fontSize: 10, color: C.sub, fontFamily: 'monospace', letterSpacing: 1 },
  chipTextActive: { color: C.green },
});

// Agent Brain stylesheet
const bs = StyleSheet.create({
  section: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 4, marginBottom: 16, overflow: 'hidden' },
  restartBanner: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1a1000', borderBottomWidth: 1, borderBottomColor: C.amber + '50', paddingHorizontal: 14, paddingVertical: 8 },
  restartBannerText: { fontSize: 10, color: C.amber, fontFamily: 'monospace', letterSpacing: 1 },
  restartBannerDismiss: { fontSize: 12, color: C.amber, fontFamily: 'monospace', paddingLeft: 12 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: C.border },
  sectionTitle: { fontSize: 11, color: C.text, letterSpacing: 3, fontWeight: '700' },
  sectionSub: { fontSize: 10, color: C.sub, letterSpacing: 1, marginTop: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: C.border },
  rowLeft: { flex: 1, marginRight: 12 },
  rowLabel: { fontSize: 10, color: C.sub, letterSpacing: 2 },
  rowSub: { fontSize: 11, color: C.sub, marginTop: 3, opacity: 0.7 },
  rowBtns: { flexDirection: 'row', gap: 6 },
  miniBtn: { borderWidth: 1, borderColor: C.border, borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4 },
  miniBtnText: { fontSize: 9, color: C.green, letterSpacing: 2, fontWeight: '700' },
  keyInputWrap: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingBottom: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  keyInput: { flex: 1, color: C.text, fontFamily: 'monospace', fontSize: 13, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 6 },
  saveKeyBtn: { backgroundColor: C.green, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 6 },
  saveKeyBtnText: { fontSize: 10, fontWeight: '700', color: '#000', letterSpacing: 1 },
  providerRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  providerChip: { borderWidth: 1, borderColor: C.border, borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4 },
  providerChipActive: { borderColor: C.green, backgroundColor: C.green + '18' },
  providerChipText: { fontSize: 10, color: C.sub, fontFamily: 'monospace', letterSpacing: 1 },
  providerChipTextActive: { color: C.green },
  capWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  capChip: { borderWidth: 1, borderColor: C.border, borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4 },
  capChipActive: { borderColor: C.green + '80', backgroundColor: C.green + '12' },
  capChipText: { fontSize: 10, color: C.sub, fontFamily: 'monospace' },
  capChipTextActive: { color: C.green },
  ruleInput: { color: C.green, fontFamily: 'monospace', fontSize: 15, fontWeight: '700', width: 56, textAlign: 'right' },
  customField: { flex: 1, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 10 },
  customFieldLabel: { fontSize: 9, color: C.sub, letterSpacing: 1, marginBottom: 8, fontFamily: 'monospace' },
  customFieldInput: { color: C.text, fontFamily: 'monospace', fontSize: 12, paddingVertical: 0 },
});
