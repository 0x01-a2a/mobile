/**
 * Settings — node config (agent name, relay addr, RPC URL, host node URL)
 * and auto-start toggle.
 */
import { useTheme, ThemeColors } from '../theme/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Clipboard,
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
import { NodeModule, UpdateInfo, onUpdateProgress } from '../native/NodeModule';
import {
  BridgeCapabilityKey,
  HostingNode,
  assertValidHostUrl,
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
import { useLayout } from '../hooks/useLayout';



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
  const { colors } = useTheme();
  const s = useStyles(colors);
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.sub}
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
  const { colors } = useTheme();
  const s = useStyles(colors);
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
            { height: 4 + i * 3, backgroundColor: i <= level ? colors.green : colors.border },
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
  const { colors } = useTheme();
  const s = useStyles(colors);
  const { width: screenWidth } = useLayout();
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
        <View style={[s.sheet, { alignSelf: 'center', width: '100%', maxWidth: Math.min(screenWidth, 560) }]}>
          <View style={s.sheetHeader}>
            <Text style={s.sheetTitle}>AVAILABLE HOSTS</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={s.sheetClose}>CLOSE</Text>
            </TouchableOpacity>
          </View>

          {nodes.length === 0 ? (
            <Text style={s.sheetEmpty}>no hosts online</Text>
          ) : (
            <ScrollView>
              {nodes.map(node => (
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
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ── Main screen ──────────────────────────────────────────────────────────────

// ── Agent Brain section ───────────────────────────────────────────────────────

function AgentBrainSection() {
  const { colors } = useTheme();
  const bs = useBs(colors);
  const s = useStyles(colors);
  const { config, loading, save } = useAgentBrain();
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [dirty, setDirty] = useState(false);

  if (loading) return null;

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
          trackColor={{ false: colors.border, true: colors.green + '66' }}
          thumbColor={config.enabled && config.apiKeySet ? colors.green : colors.border}
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
              <Text style={[bs.miniBtnText, { color: colors.red }]}>CLEAR</Text>
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
            placeholderTextColor={colors.sub}
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
              placeholderTextColor={colors.sub}
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
              placeholderTextColor={colors.sub}
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
          placeholderTextColor={colors.sub}
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
          placeholderTextColor={colors.sub}
        />
      </View>

      <View style={bs.row}>
        <View style={bs.rowLeft}>
          <Text style={bs.rowLabel}>MAX ACTIONS / HR</Text>
          <Text style={bs.rowSub}>Tool calls per hour before the agent pauses</Text>
        </View>
        <TextInput
          style={bs.ruleInput}
          value={String(config.maxActionsPerHour ?? 100)}
          onChangeText={v => saveAndDirty({ ...config, maxActionsPerHour: parseInt(v, 10) || 0 })}
          keyboardType="number-pad"
          placeholderTextColor={colors.sub}
        />
      </View>

      <View style={bs.row}>
        <View style={bs.rowLeft}>
          <Text style={bs.rowLabel}>MAX SPEND / DAY</Text>
          <Text style={bs.rowSub}>LLM spend cap in US cents (1000 = $10)</Text>
        </View>
        <TextInput
          style={bs.ruleInput}
          value={String(config.maxCostPerDayCents ?? 1000)}
          onChangeText={v => saveAndDirty({ ...config, maxCostPerDayCents: parseInt(v, 10) || 0 })}
          keyboardType="number-pad"
          placeholderTextColor={colors.sub}
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
          trackColor={{ false: colors.border, true: colors.green + '66' }}
          thumbColor={config.autoAccept ? colors.green : colors.border}
        />
      </View>

      {Platform.OS === 'android' && (
        <TouchableOpacity
          style={[bs.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}
          onPress={() => NodeModule.requestBatteryOptExemption().catch(() => {})}
        >
          <View style={bs.rowLeft}>
            <Text style={bs.rowLabel}>BATTERY OPTIMIZATION</Text>
            <Text style={bs.rowSub}>Exempt from Doze so the node runs without interruption</Text>
          </View>
          <Text style={{ color: colors.accent, fontSize: 13 }}>Exempt →</Text>
        </TouchableOpacity>
      )}
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
  const { colors } = useTheme();
  const ps = usePs(colors);
  const s = useStyles(colors);
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
  // Notifications
  notifications_read:    { label: 'NOTIF — READ',    desc: 'Read active and historical notifications from all apps (requires Notification Access)' },
  notifications_reply:   { label: 'NOTIF — REPLY',   desc: 'Reply to notifications inline (WhatsApp, Messages, email, etc.)' },
  notifications_dismiss: { label: 'NOTIF — DISMISS', desc: 'Dismiss notifications on your behalf' },
  // SMS
  sms_read: { label: 'SMS — READ',  desc: 'Read SMS inbox and message history' },
  sms_send: { label: 'SMS — SEND',  desc: 'Send SMS messages' },
  // Standard phone bridge
  contacts:   { label: 'CONTACTS',   desc: 'Read and create contacts in your address book' },
  location:   { label: 'LOCATION',   desc: 'Read your last known GPS coordinates' },
  calendar:   { label: 'CALENDAR',   desc: 'Read upcoming events and create new calendar entries' },
  media:      { label: 'MEDIA',      desc: 'Browse photos and documents on device storage' },
  motion:     { label: 'MOTION',     desc: 'Read accelerometer and gyroscope for movement and activity data' },
  camera:     { label: 'CAMERA',     desc: 'Capture a photo from front or rear camera in the background' },
  microphone: { label: 'MICROPHONE', desc: 'Record short audio clips (up to 30 seconds)' },
  calls:      { label: 'CALLS',      desc: 'Read call history and screen incoming calls (allow / reject / silence)' },
  health:     { label: 'HEALTH',     desc: 'Read on-device health data — steps, heart rate, sleep, calories' },
  wearables:  { label: 'WEARABLES',  desc: 'Scan and read data from paired BLE health devices' },
  // Screen control (Accessibility Service)
  screen_read_tree:  { label: 'SCREEN — READ',     desc: 'Read the UI tree of any foreground app (requires Accessibility setup)' },
  screen_capture:    { label: 'SCREEN — CAPTURE',  desc: 'Take silent screenshots of the current screen' },
  screen_act:        { label: 'SCREEN — ACT',       desc: 'Tap buttons, enter text, and scroll in any app' },
  screen_global_nav: { label: 'SCREEN — NAV',       desc: 'Trigger Back, Home, Recents, and system navigation' },
  screen_vision:     { label: 'SCREEN — VISION',    desc: 'Pass screenshots to the vision model for screen understanding' },
  screen_autonomy:   { label: 'SCREEN — AUTONOMY',  desc: 'Allow multi-step autonomous UI workflows without per-step confirmation' },
};

function AgentCapabilitiesSection() {
  const { colors } = useTheme();
  const cs = useCs(colors);
  const s = useStyles(colors);
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
              trackColor={{ false: colors.border, true: colors.amber + '66' }}
              thumbColor={enabled ? colors.amber : colors.border}
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
            <Text style={cs.permBtnSub}>Required for SCREEN — READ / ACT / NAV / VISION</Text>
          </TouchableOpacity>
          <TouchableOpacity style={cs.permBtn} onPress={openNotificationAccess}>
            <Text style={cs.permBtnText}>↗ Notification Access</Text>
            <Text style={cs.permBtnSub}>Required for NOTIF — READ / REPLY / DISMISS</Text>
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
  const { colors } = useTheme();
  const dcs = useDcs(colors);
  const cs = useCs(colors);
  const s = useStyles(colors);
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

function useDcs(colors: ThemeColors) {
  return React.useMemo(() => StyleSheet.create({
  section: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.blue + '30',
    borderRadius: 4,
    marginBottom: 16,
    overflow: 'hidden',
  },
  header: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  title: { fontSize: 11, color: colors.blue, letterSpacing: 3, fontWeight: '700', fontFamily: 'monospace' },
  subtitle: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', marginTop: 4, lineHeight: 14 },
  levels: { flexDirection: 'row', padding: 12, gap: 8 },
  levelBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 3,
    paddingVertical: 10,
    alignItems: 'center',
  },
  levelBtnActive: { borderColor: colors.blue, backgroundColor: colors.blue + '18' },
  levelLabel: { fontSize: 10, fontWeight: '700', color: colors.sub, letterSpacing: 1, fontFamily: 'monospace' },
  levelLabelActive: { color: colors.blue },
  levelDesc: { fontSize: 9, color: colors.sub, fontFamily: 'monospace', marginTop: 3 },
  }), [colors]);
}

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
  onBagsApiKeyClear: () => void;
}) {
  const { colors } = useTheme();
  const bfs = useBfs(colors);
  const s = useStyles(colors);
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
          trackColor={{ false: colors.border, true: '#9c27b0' + '66' }}
          thumbColor={bagsEnabled ? '#9c27b0' : colors.border}
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
              placeholderTextColor={colors.sub}
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
              placeholderTextColor={colors.sub}
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
            placeholderTextColor={colors.sub}
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
            style={[bfs.miniBtn, { backgroundColor: colors.border }]}
            onPress={() => { setShowKeyInput(false); setKeyDraft(''); }}
          >
            <Text style={bfs.miniBtnText}>CANCEL</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={[bfs.row, { borderBottomWidth: 0, paddingTop: 0 }]}>
          <Text style={[bfs.rowSub, { flex: 1, color: bagsApiKeySet ? colors.text : colors.sub }]}>
            {bagsApiKeySet ? '●●●●●●●● (keychain)' : 'not set'}
          </Text>
          <TouchableOpacity style={bfs.miniBtn} onPress={() => setShowKeyInput(true)}>
            <Text style={bfs.miniBtnText}>{bagsApiKeySet ? 'CHANGE' : 'SET'}</Text>
          </TouchableOpacity>
          {bagsApiKeySet && (
            <TouchableOpacity
              style={[bfs.miniBtn, { backgroundColor: colors.card, borderColor: colors.red + '60', marginLeft: 6 }]}
              onPress={onBagsApiKeyClear}
            >
              <Text style={[bfs.miniBtnText, { color: colors.red }]}>CLEAR</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

function useBfs(colors: ThemeColors) {
  return React.useMemo(() => StyleSheet.create({
  section: {
    backgroundColor: colors.card,
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
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
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
    color: colors.sub,
    fontFamily: 'monospace',
    marginTop: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowLeft: { flex: 1, marginRight: 12 },
  rowLabel: {
    fontSize: 10,
    color: colors.text,
    letterSpacing: 2,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  rowSub: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', marginTop: 3, lineHeight: 14 },
  feeInput: {
    color: colors.text,
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
  liveText: { fontSize: 10, color: colors.sub, fontFamily: 'monospace' },
  miniBtn: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 3,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  miniBtnText: { fontSize: 9, fontWeight: '700', color: colors.text, letterSpacing: 1, fontFamily: 'monospace' },
  }), [colors]);
}

// ── Wallet section ────────────────────────────────────────────────────────────

function WalletSection() {
  const { colors } = useTheme();
  const wS = useWS(colors);
  const s = useStyles(colors);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [exportedKey, setExportedKey] = useState('');
  const [importKey, setImportKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const clipboardClearTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeExportModal = () => {
    // Re-enable screenshots, clear clipboard, wipe key from state
    NodeModule.setWindowSecure(false).catch(() => {});
    Clipboard.setString('');
    if (clipboardClearTimer.current) clearTimeout(clipboardClearTimer.current);
    setShowExportModal(false);
    setExportedKey('');
    setCopied(false);
  };

  const handleExport = async () => {
    Alert.alert(
      'Show Private Key?',
      'Your private key grants full control of your agent and wallet. Make sure no one can see your screen.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Show Key',
          style: 'destructive',
          onPress: async () => {
            setLoading(true);
            try {
              await NodeModule.setWindowSecure(true); // block screenshots
              const key = await NodeModule.exportIdentityKey();
              setExportedKey(key);
              setShowExportModal(true);
            } catch (e: any) {
              NodeModule.setWindowSecure(false).catch(() => {});
              Alert.alert('Export Failed', e.message ?? 'Could not read identity key. Start the node first.');
            } finally {
              setLoading(false);
            }
          },
        },
      ],
    );
  };

  const handleCopy = () => {
    Clipboard.setString(exportedKey);
    setCopied(true);
    // Clear clipboard after 60 seconds
    if (clipboardClearTimer.current) clearTimeout(clipboardClearTimer.current);
    clipboardClearTimer.current = setTimeout(() => {
      Clipboard.setString('');
      setCopied(false);
    }, 60_000);
  };

  const handleImport = async () => {
    const key = importKey.trim();
    if (!key) return;
    Alert.alert(
      'Replace Identity?',
      'This will stop the node and permanently replace your current agent identity. Your old identity cannot be recovered. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Replace',
          style: 'destructive',
          onPress: async () => {
            setLoading(true);
            try {
              await NodeModule.importIdentityKey(key);
              setShowImportModal(false);
              setImportKey('');
              Alert.alert('Imported', 'Identity key replaced. Start the node to apply.');
            } catch (e: any) {
              Alert.alert('Import Failed', e.message ?? 'Invalid key format.');
            } finally {
              setLoading(false);
            }
          },
        },
      ],
    );
  };

  return (
    <View style={s.section}>
      <Text style={[s.sectionTitle, { color: colors.amber }]}>WALLET</Text>
      <Text style={[s.toggleSub, { paddingHorizontal: 16, paddingBottom: 12 }]}>
        Your agent identity key. Export to back up or import to a new device.
      </Text>

      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 16 }}>
        <TouchableOpacity
          style={[s.miniBtn, { flex: 1 }]}
          onPress={handleExport}
          disabled={loading}
          activeOpacity={0.8}
        >
          <Text style={s.miniBtnText}>EXPORT KEY</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.miniBtn, { flex: 1 }]}
          onPress={() => setShowImportModal(true)}
          disabled={loading}
          activeOpacity={0.8}
        >
          <Text style={s.miniBtnText}>IMPORT KEY</Text>
        </TouchableOpacity>
      </View>

      {/* Export modal */}
      <Modal visible={showExportModal} transparent animationType="fade">
        <View style={wS.overlay}>
          <View style={wS.modal}>
            <Text style={wS.title}>PRIVATE KEY</Text>
            <Text style={wS.warning}>
              ⚠ Never share this key. Anyone with it controls your agent and wallet.
            </Text>
            <View style={wS.keyBox}>
              <Text style={wS.keyText}>{exportedKey ? '••••••••••••••••••••••••••••••••••••••' : ''}</Text>
            </View>
            <TouchableOpacity style={wS.copyBtn} onPress={handleCopy} activeOpacity={0.8}>
              <Text style={wS.copyBtnText}>{copied ? 'COPIED ✓ (clears in 60s)' : 'COPY TO CLIPBOARD'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={wS.closeBtn} onPress={closeExportModal} activeOpacity={0.8}>
              <Text style={wS.closeBtnText}>CLOSE & CLEAR CLIPBOARD</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Import modal */}
      <Modal visible={showImportModal} transparent animationType="fade">
        <View style={wS.overlay}>
          <View style={wS.modal}>
            <Text style={wS.title}>IMPORT WALLET</Text>
            <Text style={wS.warning}>
              Paste your Phantom private key (base58). Your current identity will be replaced and the node stopped.
            </Text>
            <TextInput
              style={wS.importInput}
              value={importKey}
              onChangeText={setImportKey}
              placeholder="base58 private key..."
              placeholderTextColor={colors.sub}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={true}
            />
            <TouchableOpacity style={[wS.copyBtn, { backgroundColor: colors.red + '22', borderColor: colors.red + '60' }]} onPress={handleImport} disabled={loading || !importKey.trim()} activeOpacity={0.8}>
              <Text style={[wS.copyBtnText, { color: colors.red }]}>IMPORT & REPLACE</Text>
            </TouchableOpacity>
            <TouchableOpacity style={wS.closeBtn} onPress={() => { setShowImportModal(false); setImportKey(''); }} activeOpacity={0.8}>
              <Text style={wS.closeBtnText}>CANCEL</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function useWS(colors: ThemeColors) {
  return React.useMemo(() => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: '#000000cc', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modal:   { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 4, padding: 20, width: '100%' },
  title:   { fontSize: 11, color: colors.amber, letterSpacing: 3, fontWeight: '700', fontFamily: 'monospace', marginBottom: 12 },
  warning: { fontSize: 10, color: colors.red, fontFamily: 'monospace', lineHeight: 15, marginBottom: 16 },
  keyBox:  { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 12, marginBottom: 12 },
  keyText: { fontSize: 10, color: colors.text, fontFamily: 'monospace', lineHeight: 16 },
  copyBtn: { backgroundColor: colors.green + '20', borderWidth: 1, borderColor: colors.green + '40', borderRadius: 3, padding: 12, alignItems: 'center', marginBottom: 8 },
  copyBtnText: { fontSize: 11, color: colors.green, fontFamily: 'monospace', letterSpacing: 2, fontWeight: '700' },
  closeBtn: { padding: 12, alignItems: 'center' },
  closeBtnText: { fontSize: 11, color: colors.sub, fontFamily: 'monospace', letterSpacing: 2 },
  importInput: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 3, padding: 12, color: colors.text, fontFamily: 'monospace', fontSize: 10, minHeight: 80, marginBottom: 12, textAlignVertical: 'top' },
  }), [colors]);
}

// ── Main screen ───────────────────────────────────────────────────────────────

// ============================================================================
// Update section
// ============================================================================

function UpdateSection() {
  const { colors } = useTheme();
  const us = useUs(colors);
  const s = useStyles(colors);
  const [checking, setChecking]     = useState(false);
  const [info, setInfo]             = useState<UpdateInfo | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress]     = useState(0);

  useEffect(() => {
    if (!downloading) return;
    const unsub = onUpdateProgress(ev => setProgress(ev.progress));
    return unsub;
  }, [downloading]);

  const check = async () => {
    setChecking(true);
    setError(null);
    setInfo(null);
    try {
      const result = await NodeModule.checkForUpdate();
      setInfo(result);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to check for updates');
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    if (!info?.downloadUrl) return;
    setDownloading(true);
    setProgress(0);
    try {
      await NodeModule.downloadAndInstall(info.downloadUrl);
      // Install dialog launched — reset state
      setDownloading(false);
      setProgress(0);
    } catch (e: any) {
      setError(e?.message ?? 'Download failed');
      setDownloading(false);
    }
  };

  return (
    <View style={us.section}>
      <View style={us.header}>
        <Text style={us.title}>APP UPDATE</Text>
        {info && (
          <Text style={us.sub}>
            current: {info.currentVersion}
            {info.hasUpdate ? `  →  latest: ${info.latestVersion}` : '  (up to date)'}
            {info.publishedAt ? `\nreleased: ${info.publishedAt.slice(0, 10)}` : ''}
          </Text>
        )}
      </View>

      {error && (
        <Text style={us.error}>{error}</Text>
      )}

      {downloading ? (
        <View style={us.progressWrap}>
          <View style={us.progressTrack}>
            <View style={[us.progressBar, { width: `${progress}%` as any }]} />
          </View>
          <Text style={us.progressLabel}>{progress}%  DOWNLOADING…</Text>
        </View>
      ) : (
        <View style={us.actions}>
          <TouchableOpacity
            style={us.btn}
            onPress={check}
            disabled={checking}
            activeOpacity={0.7}
          >
            <Text style={us.btnText}>{checking ? 'CHECKING…' : 'CHECK FOR UPDATE'}</Text>
          </TouchableOpacity>

          {info?.hasUpdate && info.downloadUrl ? (
            <TouchableOpacity
              style={[us.btn, us.btnGreen]}
              onPress={install}
              activeOpacity={0.7}
            >
              <Text style={[us.btnText, { color: colors.green }]}>
                DOWNLOAD {info.latestVersion}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      )}

      {info?.hasUpdate && info.releaseNotes ? (
        <ScrollView style={us.notes} nestedScrollEnabled>
          <Text style={us.notesText}>{info.releaseNotes}</Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

function useUs(colors: ThemeColors) {
  return React.useMemo(() => StyleSheet.create({
  section:       { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 4, marginBottom: 16, overflow: 'hidden' },
  header:        { padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
  title:         { fontSize: 11, color: colors.text, letterSpacing: 3, fontWeight: '700', fontFamily: 'monospace' },
  sub:           { fontSize: 10, color: colors.sub, fontFamily: 'monospace', marginTop: 4, letterSpacing: 1 },
  error:         { fontSize: 10, color: colors.red, fontFamily: 'monospace', margin: 14, letterSpacing: 1 },
  actions:       { flexDirection: 'row', gap: 8, padding: 14, flexWrap: 'wrap' },
  btn:           { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 12, paddingVertical: 7 },
  btnGreen:      { borderColor: colors.green + '60' },
  btnText:       { fontSize: 10, color: colors.sub, fontFamily: 'monospace', fontWeight: '700', letterSpacing: 1 },
  progressWrap:  { padding: 14 },
  progressTrack: { height: 3, backgroundColor: colors.border, borderRadius: 2, overflow: 'hidden' },
  progressBar:   { height: 3, backgroundColor: colors.green, borderRadius: 2 },
  progressLabel: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', marginTop: 8, letterSpacing: 1 },
  notes:         { maxHeight: 120, borderTopWidth: 1, borderTopColor: colors.border },
  notesText:     { fontSize: 10, color: colors.sub, fontFamily: 'monospace', padding: 12, lineHeight: 16 },
  }), [colors]);
}

// ============================================================================
// Main Settings screen
// ============================================================================

export function SettingsScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const s = useStyles(colors);
  const { contentHPad } = useLayout();
  const { config, autoStart, backgroundNode, saveConfig, setAutoStart, setBackgroundNode, status, start, stop } = useNode();

  const [agentName, setAgentName] = useState(config.agentName ?? '');
  const [agentAvatar, setAgentAvatar] = useState(config.agentAvatar ?? '');
  const [relayAddr, setRelayAddr] = useState(config.relayAddr ?? '');
  const [nodeApiUrl, setNodeApiUrl] = useState(config.nodeApiUrl ?? '');
  const [savedBanner, setSavedBanner] = useState(false);

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
    setMeshNetwork(rpcToNetwork(config.rpcUrl ?? 'https://api.mainnet-beta.solana.com'));
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

  const handleBagsApiKeyClear = () => {
    Alert.alert('Remove Bags API key', 'This will clear your Bags API key from the keychain.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await clearBagsApiKey();
          setBagsApiKeySet(false);
        },
      },
    ]);
  };

  const handleSave = async () => {
    const trimmedName = agentName.trim();
    if (trimmedName && trimmedName.length < 2) {
      Alert.alert('Invalid Name', 'Agent name must be at least 2 characters.');
      return;
    }
    if (trimmedName && trimmedName.length > 32) {
      Alert.alert('Invalid Name', 'Agent name must be 32 characters or less.');
      return;
    }
    const trimmedRelay = relayAddr.trim();
    if (trimmedRelay && !trimmedRelay.startsWith('/')) {
      Alert.alert('Invalid Relay Address', 'Relay address must be a multiaddr starting with / (e.g. /dns4/relay.example.com/tcp/443/wss/p2p/…).');
      return;
    }
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
    setSavedBanner(true);
    setTimeout(() => setSavedBanner(false), 2000);
  };

  const running = status === 'running';

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <View style={{ paddingHorizontal: contentHPad }}>
        <Text style={[s.heading, { paddingTop: insets.top + 16 }]}>SETTINGS</Text>

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
              style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginRight: 16 }}
            >
              {agentAvatar ? (
                <Image source={{ uri: agentAvatar }} style={{ width: 64, height: 64 }} />
              ) : (
                <Text style={{ color: colors.sub, fontSize: 20 }}>+</Text>
              )}
            </TouchableOpacity>
            <Text style={{ fontSize: 11, color: colors.sub, letterSpacing: 2 }}>PROFILE PICTURE</Text>
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
          {/* Devnet warning */}
          {meshNetwork === 'devnet' && (
            <Text style={s.devnetWarn}>
              Devnet is for testing only. Agent registration (8004 registry) requires mainnet — your node will not appear on the live mesh.
            </Text>
          )}
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
                placeholderTextColor={colors.sub}
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

        {savedBanner && (
          <View style={{ backgroundColor: colors.green + '20', borderWidth: 1, borderColor: colors.green + '40', borderRadius: 4, padding: 10, marginBottom: 8, alignItems: 'center' }}>
            <Text style={{ color: colors.green, fontFamily: 'monospace', fontSize: 11, letterSpacing: 2 }}>SAVED</Text>
          </View>
        )}

        {/* Wallet key management */}
        <WalletSection />

        {/* On-Chain Registration */}
        <View style={s.section}>
          <View style={s.toggleRow}>
            <View style={{ flex: 1, marginRight: 16 }}>
              <Text style={s.toggleLabel}>ON-CHAIN REGISTRATION</Text>
              <Text style={s.toggleSub}>Register on Solana 8004 to enable tasks. Gas paid by Kora relay.</Text>
            </View>
            <TouchableOpacity
              style={[s.nodeBtn, { margin: 0, paddingVertical: 10, paddingHorizontal: 14, borderColor: colors.green + '60' }]}
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
              <Text style={[s.nodeBtnText, { fontSize: 11, color: colors.green }]}>REGISTER</Text>
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
              trackColor={{ false: colors.border, true: colors.green + '66' }}
              thumbColor={autoStart ? colors.green : colors.border}
            />
          </View>
          <View style={s.toggleRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={s.toggleLabel}>KEEP NODE RUNNING IN BACKGROUND</Text>
              <Text style={s.toggleSub}>Off: node stops after 60s when app is in background (battery saving). ZeroClaw restarts when you reopen the app.</Text>
            </View>
            <Switch
              value={backgroundNode}
              onValueChange={setBackgroundNode}
              trackColor={{ false: colors.border, true: colors.green + '66' }}
              thumbColor={backgroundNode ? colors.green : colors.border}
            />
          </View>
        </View>

        {/* Quick start/stop */}
        <View style={s.section}>
          <TouchableOpacity
            style={[s.nodeBtn, { borderColor: running ? colors.red + '40' : colors.green + '40' }]}
            onPress={running ? stop : () => start()}
            activeOpacity={0.8}
          >
            <Text style={[s.nodeBtnText, { color: running ? colors.red : colors.green }]}>
              {running ? 'STOP NODE' : 'START NODE'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* OTA update */}
        <UpdateSection />
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
function useCs(colors: ThemeColors) {
  return React.useMemo(() => StyleSheet.create({
  section: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.amber + '30', borderRadius: 4, marginBottom: 16, overflow: 'hidden' },
  header: { padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.card },
  title: { fontSize: 11, color: colors.amber, letterSpacing: 3, fontWeight: '700', fontFamily: 'monospace' },
  subtitle: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', marginTop: 6, lineHeight: 15 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  rowText: { flex: 1, marginRight: 12 },
  capLabel: { fontSize: 10, color: colors.text, letterSpacing: 2, fontWeight: '700', fontFamily: 'monospace' },
  capDesc: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', marginTop: 3, lineHeight: 15 },
  permButtons: { paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border, gap: 8 },
  permHint: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', marginBottom: 4 },
  permBtn: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 8 },
  permBtnText: { fontSize: 10, color: colors.amber, fontFamily: 'monospace', fontWeight: '700', letterSpacing: 1 },
  permBtnSub: { fontSize: 9, color: colors.sub, fontFamily: 'monospace', marginTop: 2 },
  }), [colors]);
}

function useStyles(colors: ThemeColors) {
  return React.useMemo(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 24 },
  heading: { fontSize: 11, color: colors.sub, letterSpacing: 4, marginBottom: 24 },
  section: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 4,
    marginBottom: 16,
    overflow: 'hidden',
  },
  field: { padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
  fieldLabel: { fontSize: 10, color: colors.sub, letterSpacing: 2, marginBottom: 8 },
  input: {
    color: colors.text,
    fontFamily: 'monospace',
    fontSize: 14,
    paddingVertical: 0,
  },
  netToggleRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  netBtn: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingVertical: 8, alignItems: 'center' },
  netBtnActive: { borderColor: colors.green, backgroundColor: colors.green + '18' },
  netBtnText: { fontSize: 11, color: colors.sub, letterSpacing: 2, fontWeight: '700', fontFamily: 'monospace' },
  netBtnTextActive: { color: colors.green },
  devnetWarn: { marginHorizontal: 16, marginBottom: 8, fontSize: 11, color: colors.amber, fontFamily: 'monospace', lineHeight: 16 },
  tradingBadge: { marginHorizontal: 16, marginBottom: 12, borderWidth: 1, borderColor: colors.amber + '30', borderRadius: 3, paddingVertical: 6, alignItems: 'center' },
  tradingBadgeText: { fontSize: 9, color: colors.amber, letterSpacing: 2, fontFamily: 'monospace' },
  hostFieldRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hostUrlInput: { flex: 1 },
  browseBtn: {
    borderWidth: 1,
    borderColor: colors.green + '60',
    borderRadius: 3,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  browseBtnText: { fontSize: 9, color: colors.green, letterSpacing: 2, fontWeight: '700' },
  saveBtn: {
    backgroundColor: colors.green,
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
  toggleLabel: { fontSize: 11, color: colors.text, letterSpacing: 2, fontWeight: '600' },
  toggleSub: { fontSize: 12, color: colors.sub, marginTop: 4 },
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
    backgroundColor: colors.card,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: '70%',
    paddingBottom: 32,
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sheetTitle: { fontSize: 11, color: colors.sub, letterSpacing: 3 },
  sheetClose: { fontSize: 11, color: colors.green, letterSpacing: 2 },
  sheetEmpty: { padding: 24, color: colors.sub, fontFamily: 'monospace', textAlign: 'center' },
  hostRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  hostInfo: { flex: 1 },
  hostName: { fontSize: 14, color: colors.text, fontFamily: 'monospace', fontWeight: '600' },
  hostMeta: { fontSize: 11, color: colors.sub, marginTop: 2 },
  hostRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  feeBadge: {
    borderWidth: 1,
    borderColor: colors.amber + '60',
    borderRadius: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  feeBadgeText: { fontSize: 10, color: colors.amber, letterSpacing: 1 },
  barsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  bar: { width: 4, borderRadius: 1 },
  signalNull: { fontSize: 14, color: colors.sub },
  miniBtn: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 5, alignItems: 'center' },
  miniBtnText: { fontSize: 9, fontWeight: '700', color: colors.text, letterSpacing: 1, fontFamily: 'monospace' },
  sectionTitle: { fontSize: 11, fontWeight: '700', letterSpacing: 3, fontFamily: 'monospace', padding: 16, paddingBottom: 4 },
  }), [colors]);
}

// Phone Capabilities stylesheet
function usePs(colors: ThemeColors) {
  return React.useMemo(() => StyleSheet.create({
  section: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 4, marginBottom: 16, overflow: 'hidden' },
  headerRow: { padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
  sectionTitle: { fontSize: 11, color: colors.text, letterSpacing: 3, fontWeight: '700' },
  sectionSub: { fontSize: 10, color: colors.sub, letterSpacing: 1, marginTop: 2 },
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 14 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 6 },
  chipActive: { borderColor: colors.green, backgroundColor: colors.green + '18' },
  chipText: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', letterSpacing: 1 },
  chipTextActive: { color: colors.green },
  }), [colors]);
}

// Agent Brain stylesheet
function useBs(colors: ThemeColors) {
  return React.useMemo(() => StyleSheet.create({
  section: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 4, marginBottom: 16, overflow: 'hidden' },
  restartBanner: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.amber + '50', paddingHorizontal: 14, paddingVertical: 8 },
  restartBannerText: { fontSize: 10, color: colors.amber, fontFamily: 'monospace', letterSpacing: 1 },
  restartBannerDismiss: { fontSize: 12, color: colors.amber, fontFamily: 'monospace', paddingLeft: 12 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
  sectionTitle: { fontSize: 11, color: colors.text, letterSpacing: 3, fontWeight: '700' },
  sectionSub: { fontSize: 10, color: colors.sub, letterSpacing: 1, marginTop: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowLeft: { flex: 1, marginRight: 12 },
  rowLabel: { fontSize: 10, color: colors.sub, letterSpacing: 2 },
  rowSub: { fontSize: 11, color: colors.sub, marginTop: 3, opacity: 0.7 },
  rowBtns: { flexDirection: 'row', gap: 6 },
  miniBtn: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4 },
  miniBtnText: { fontSize: 9, color: colors.green, letterSpacing: 2, fontWeight: '700' },
  keyInputWrap: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingBottom: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  keyInput: { flex: 1, color: colors.text, fontFamily: 'monospace', fontSize: 13, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 6 },
  saveKeyBtn: { backgroundColor: colors.green, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 6 },
  saveKeyBtnText: { fontSize: 10, fontWeight: '700', color: '#000', letterSpacing: 1 },
  providerRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  providerChip: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4 },
  providerChipActive: { borderColor: colors.green, backgroundColor: colors.green + '18' },
  providerChipText: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', letterSpacing: 1 },
  providerChipTextActive: { color: colors.green },
  capWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  capChip: { borderWidth: 1, borderColor: colors.border, borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4 },
  capChipActive: { borderColor: colors.green + '80', backgroundColor: colors.green + '12' },
  capChipText: { fontSize: 10, color: colors.sub, fontFamily: 'monospace' },
  capChipTextActive: { color: colors.green },
  ruleInput: { color: colors.green, fontFamily: 'monospace', fontSize: 15, fontWeight: '700', width: 56, textAlign: 'right' },
  customField: { flex: 1, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 4, padding: 10 },
  customFieldLabel: { fontSize: 9, color: colors.sub, letterSpacing: 1, marginBottom: 8, fontFamily: 'monospace' },
  customFieldInput: { color: colors.text, fontFamily: 'monospace', fontSize: 12, paddingVertical: 0 },
  }), [colors]);
}
