import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput,
  Switch, Alert, Modal, FlatList, Image, Linking,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { launchImageLibrary } from 'react-native-image-picker';
import { useNode } from '../hooks/useNode';
import { NodeModule } from '../native/NodeModule';
import { useAgentBrain } from '../hooks/useAgentBrain';
import {
  useHotKeyBalance, useTaskLog, sweepUsdc,
} from '../hooks/useNodeApi';
import { useSignOut } from '../../App';
import { DEFAULT_AGENT_ICON_URI } from '../assets/defaultAgentIcon';

const COLD_WALLET_KEY = 'zerox1:cold_wallet';

const USDC_MINTS = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
];

type SubTab = 'Wallet' | 'Agent' | 'Settings';

function fmt(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function isToday(tsSeconds: number): boolean {
  const d = new Date(tsSeconds * 1000);
  return d.toDateString() === new Date().toDateString();
}

export default function YouScreen() {
  const [tab, setTab] = useState<SubTab>('Wallet');

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.title}>You</Text>
        <View style={s.segmented}>
          {(['Wallet', 'Agent', 'Settings'] as SubTab[]).map(t => (
            <TouchableOpacity
              key={t}
              style={[s.segment, tab === t && s.segmentActive]}
              onPress={() => setTab(t)}
            >
              <Text style={[s.segmentText, tab === t && s.segmentTextActive]}>{t}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {tab === 'Wallet' && <WalletTab />}
      {tab === 'Agent' && <AgentTab />}
      {tab === 'Settings' && <SettingsTab />}
    </View>
  );
}

// ── Wallet Tab ─────────────────────────────────────────────────────────────────

function WalletTab() {
  const { tokens, solanaAddress, loading } = useHotKeyBalance();
  const { entries: taskEntries } = useTaskLog();
  const [coldWallet, setColdWallet] = useState<string | null>(null);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [linkWalletVisible, setLinkWalletVisible] = useState(false);
  const [walletInput, setWalletInput] = useState('');

  useEffect(() => {
    AsyncStorage.getItem(COLD_WALLET_KEY).then(v => setColdWallet(v));
  }, []);

  const handleLinkWallet = useCallback(async () => {
    const addr = walletInput.trim();
    if (!addr) return;
    await AsyncStorage.setItem(COLD_WALLET_KEY, addr);
    setColdWallet(addr);
    setWalletInput('');
    setLinkWalletVisible(false);
  }, [walletInput]);


  const [phantomConnecting, setPhantomConnecting] = useState(false);

  const handleOpenPhantom = useCallback(async () => {
    setPhantomConnecting(true);
    try {
      const { transact } = require('@solana-mobile/mobile-wallet-adapter-protocol-web3js');
      const address: string = await transact(async (wallet: any) => {
        const { accounts } = await wallet.authorize({
          cluster: 'mainnet-beta',
          identity: { name: '01 Pilot', uri: 'https://0x01.world' },
        });
        const { PublicKey } = require('@solana/web3.js');
        const addrBytes = new Uint8Array([...atob(accounts[0].address)].map(c => c.charCodeAt(0)));
        return new PublicKey(addrBytes).toBase58();
      });
      setWalletInput(address);
    } catch (e: any) {
      const msg: string = e?.message ?? '';
      if (msg.includes('No wallet') || msg.includes('not found') || msg.includes('SolanaMobileWalletAdapterWalletNotInstalledError')) {
        Alert.alert('Phantom not installed', 'Install Phantom from the Play Store, then try again.');
      }
    } finally {
      setPhantomConnecting(false);
    }
  }, []);

  const handleUnlinkWallet = useCallback(() => {
    Alert.alert('Unlink cold wallet', 'Remove linked cold wallet?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unlink', style: 'destructive', onPress: async () => {
        await AsyncStorage.removeItem(COLD_WALLET_KEY);
        setColdWallet(null);
      }},
    ]);
  }, []);

  const balance = useMemo(() => {
    const usdcToken = tokens.find(t => USDC_MINTS.includes(t.mint));
    return usdcToken ? usdcToken.amount / Math.pow(10, usdcToken.decimals) : 0;
  }, [tokens]);

  const earnedToday = useMemo(() => {
    return taskEntries
      .filter(e => e.outcome === 'success' && isToday(e.timestamp))
      .reduce((acc, e) => acc + (e.amount_usd ?? 0), 0);
  }, [taskEntries]);

  const recentHistory = useMemo(
    () => taskEntries.filter(e => e.outcome === 'success').slice(0, 5),
    [taskEntries],
  );

  const handleSweep = useCallback(async () => {
    if (!coldWallet) return;
    Alert.alert('Sweep to cold wallet', `Send ${fmt(balance)} USDC to ${coldWallet.slice(0, 8)}…?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sweep', style: 'destructive', onPress: async () => {
          setSweeping(true);
          try {
            const result = await sweepUsdc(coldWallet);
            Alert.alert('Swept', `${fmt(result.amount_usdc)} USDC sent.`);
          } catch {
            Alert.alert('Error', 'Sweep failed. Check node connection.');
          } finally {
            setSweeping(false);
          }
        },
      },
    ]);
  }, [coldWallet, balance]);

  return (
    <ScrollView style={s.tabContent}>
      {/* Balance hero */}
      <View style={s.balanceHero}>
        <Text style={s.balanceLabel}>TOTAL USDC</Text>
        <Text style={s.balanceAmount}>{loading ? '—' : fmt(balance)}</Text>
        {earnedToday > 0 && (
          <Text style={s.balanceDelta}>↑ {fmt(earnedToday)} earned today</Text>
        )}
      </View>

      {/* Address card */}
      <View style={s.addressCard}>
        <View style={s.addressRow}>
          <Text style={s.addressLabel}>Hot wallet</Text>
          <Text style={s.addressValue} numberOfLines={1}>
            {solanaAddress ? `${solanaAddress.slice(0, 4)}…${solanaAddress.slice(-4)}` : '—'}
          </Text>
        </View>
        <View style={s.addressDivider} />
        <TouchableOpacity
          style={s.addressRow}
          onPress={coldWallet ? handleUnlinkWallet : () => setLinkWalletVisible(true)}
        >
          <Text style={s.addressLabel}>Cold wallet</Text>
          {coldWallet ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View style={s.greenDot} />
              <Text style={s.addressValue}>
                {`${coldWallet.slice(0, 4)}…${coldWallet.slice(-4)}`}
              </Text>
            </View>
          ) : (
            <Text style={[s.addressValueMuted, { color: '#374151' }]}>Link ›</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Actions */}
      <View style={s.walletActions}>
        <TouchableOpacity
          style={[s.sweepBtn, (!coldWallet || balance === 0 || sweeping) && s.btnDisabled]}
          onPress={handleSweep}
          disabled={!coldWallet || balance === 0 || sweeping}
        >
          <Text style={s.sweepBtnText}>{sweeping ? 'Sweeping…' : '→ Sweep'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={s.historyBtn}
          onPress={() => setHistoryVisible(true)}
        >
          <Text style={s.historyBtnText}>History</Text>
        </TouchableOpacity>
      </View>

      {/* Recent */}
      <Text style={[s.sectionLabel, { paddingHorizontal: 16, paddingTop: 16 }]}>RECENT</Text>
      {recentHistory.length === 0 && (
        <Text style={s.emptyText}>No transactions yet</Text>
      )}
      {recentHistory.map((entry, i) => (
        <View key={entry.id} style={[s.txRow, i < recentHistory.length - 1 && s.txRowBorder]}>
          <View>
            <Text style={s.txTitle}>{entry.summary || 'Task'}</Text>
            <Text style={s.txTime}>
              {new Date(entry.timestamp * 1000).toLocaleString()}
            </Text>
          </View>
          <Text style={s.txAmountPos}>+{fmt(entry.amount_usd ?? 0)}</Text>
        </View>
      ))}

      {/* Link wallet modal */}
      <Modal visible={linkWalletVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setLinkWalletVisible(false)}>
        <View style={s.modalRoot}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>Link cold wallet</Text>
            <TouchableOpacity onPress={() => setLinkWalletVisible(false)}>
              <Text style={s.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <View style={{ padding: 16, gap: 14 }}>
            <Text style={s.settingsHint}>
              Your cold wallet is receive-only — earnings are swept here. No signing required, just the public address.
            </Text>

            {/* Wallet app option */}
            <TouchableOpacity
              style={[s.walletOptionBtn, phantomConnecting && s.btnDisabled]}
              onPress={handleOpenPhantom}
              disabled={phantomConnecting}
            >
              <View>
                <Text style={s.walletOptionLabel}>
                  {phantomConnecting ? 'Connecting…' : 'Open Phantom'}
                </Text>
                <Text style={s.settingsHint}>Connect your wallet and import your address</Text>
              </View>
              <Text style={s.settingsValue}>{phantomConnecting ? '…' : '↗'}</Text>
            </TouchableOpacity>

            {/* Divider */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ flex: 1, height: 1, backgroundColor: '#f3f4f6' }} />
              <Text style={{ fontSize: 9, color: '#d1d5db' }}>OR</Text>
              <View style={{ flex: 1, height: 1, backgroundColor: '#f3f4f6' }} />
            </View>

            {/* Manual entry */}
            <View style={{ gap: 8 }}>
              <Text style={s.settingsLabel}>Paste address</Text>
              <TextInput
                style={s.advancedInput}
                value={walletInput}
                onChangeText={setWalletInput}
                placeholder="Solana address or .sol domain"
                placeholderTextColor="#d1d5db"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <TouchableOpacity
              style={[s.saveBtn, !walletInput.trim() && s.btnDisabled]}
              onPress={handleLinkWallet}
              disabled={!walletInput.trim()}
            >
              <Text style={s.saveBtnText}>Link wallet</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* History modal */}
      <Modal visible={historyVisible} animationType="slide" onRequestClose={() => setHistoryVisible(false)}>
        <View style={s.modalRoot}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>Transaction History</Text>
            <TouchableOpacity onPress={() => setHistoryVisible(false)}>
              <Text style={s.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={taskEntries}
            keyExtractor={e => String(e.id)}
            renderItem={({ item: entry, index }) => (
              <View style={[s.txRow, index < taskEntries.length - 1 && s.txRowBorder]}>
                <View>
                  <Text style={s.txTitle}>{entry.summary || 'Task'}</Text>
                  <Text style={s.txTime}>
                    {new Date(entry.timestamp * 1000).toLocaleDateString()}
                  </Text>
                </View>
                <Text style={entry.outcome === 'success' ? s.txAmountPos : s.txAmountNeg}>
                  {entry.outcome === 'success' ? '+' : ''}{fmt(entry.amount_usd ?? 0)}
                </Text>
              </View>
            )}
            ListEmptyComponent={<Text style={s.emptyText}>No history yet</Text>}
            contentContainerStyle={{ padding: 16 }}
          />
        </View>
      </Modal>
    </ScrollView>
  );
}

import type { Capability, LlmProvider } from '../hooks/useAgentBrain';

const PROVIDERS: LlmProvider[] = ['anthropic', 'openai', 'gemini', 'zai', 'minimax', 'custom'];
const PRESET_CAPS: Capability[] = ['summarization', 'qa', 'translation', 'code_review', 'data_analysis'];

// ── Agent Tab ──────────────────────────────────────────────────────────────────

function AgentTab() {
  const { status, config: nodeConfig, stop, start } = useNode();
  const { config, save, loading } = useAgentBrain();
  const isRunning = status === 'running';
  const agentName = nodeConfig?.agentName ?? 'Aria';

  const [minFee, setMinFee] = useState(String(config?.minFeeUsdc ?? 1.0));
  const [minRep, setMinRep] = useState(String(config?.minReputation ?? 50));

  useEffect(() => {
    setMinFee(String(config?.minFeeUsdc ?? 1.0));
    setMinRep(String(config?.minReputation ?? 50));
  }, [config?.minFeeUsdc, config?.minReputation]);

  if (loading) {
    return <View style={s.tabContent}><Text style={s.emptyText}>Loading…</Text></View>;
  }

  const handleSave = async (updates: Partial<typeof config>) => {
    if (!config || !save) return;
    const next = { ...config, ...updates };
    await save(next);
    // Auto-restart node to apply brain config changes
    if (isRunning) {
      try { await stop(); } catch { /* ignore */ }
      try { await start(); } catch { /* ignore */ }
    }
  };

  const handleAddCap = () => {
    const existing = config?.capabilities ?? [];
    const available = PRESET_CAPS.filter(c => !existing.includes(c));
    if (available.length === 0) {
      Alert.alert('All capabilities added');
      return;
    }
    Alert.alert('Add capability', 'Choose a capability to add:', [
      ...available.map(cap => ({
        text: cap,
        onPress: () => handleSave({ capabilities: [...existing, cap] }),
      })),
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const handleRemoveCap = (cap: string) => {
    const next = (config?.capabilities ?? []).filter(c => c !== cap);
    handleSave({ capabilities: next });
  };

  return (
    <ScrollView style={s.tabContent}>
      {/* Agent header */}
      <View style={s.agentHeader}>
        <View style={s.agentAvatarCircle}>
          <Image
            source={{ uri: nodeConfig?.agentAvatar || DEFAULT_AGENT_ICON_URI }}
            style={s.agentAvatarImage}
          />
        </View>
        <View style={s.agentInfo}>
          <Text style={s.agentNameText}>{agentName}</Text>
          <Text style={s.agentStatusText}>
            {isRunning ? '● Active' : '○ Offline'}
          </Text>
        </View>
      </View>

      {/* Rule rows */}
      <View style={s.ruleRows}>
        <View style={s.ruleRow}>
          <View>
            <Text style={s.ruleLabel}>Auto-accept above</Text>
            <Text style={s.ruleHint}>Jobs under threshold need approval</Text>
          </View>
          <TextInput
            style={s.ruleInput}
            value={minFee}
            onChangeText={setMinFee}
            onBlur={() => handleSave({ minFeeUsdc: parseFloat(minFee) || 1.0 })}
            keyboardType="decimal-pad"
            selectTextOnFocus
          />
        </View>
        <View style={[s.ruleRow, s.ruleRowBorder]}>
          <Text style={s.ruleLabel}>Min reputation</Text>
          <TextInput
            style={s.ruleInput}
            value={minRep}
            onChangeText={setMinRep}
            onBlur={() => handleSave({ minReputation: parseInt(minRep, 10) || 0 })}
            keyboardType="number-pad"
            selectTextOnFocus
          />
        </View>
        <View style={[s.ruleRow, s.ruleRowBorder, { flexDirection: 'column', alignItems: 'flex-start', gap: 8 }]}>
          <Text style={s.ruleLabel}>Capabilities</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {(config?.capabilities ?? []).map(cap => (
              <TouchableOpacity key={cap} style={s.capPill} onPress={() => handleRemoveCap(cap)}>
                <Text style={s.capPillText}>{cap} ×</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={s.capPillAdd} onPress={handleAddCap}>
              <Text style={s.capPillAddText}>+ add</Text>
            </TouchableOpacity>
          </View>
        </View>
        <View style={[s.ruleRow, s.ruleRowBorder, { flexDirection: 'column', alignItems: 'flex-start', gap: 8 }]}>
          <Text style={s.ruleLabel}>LLM provider</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {PROVIDERS.map(p => {
              const active = (config?.provider ?? 'openai') === p;
              return (
                <TouchableOpacity
                  key={p}
                  style={[s.providerPill, active && s.providerPillActive]}
                  onPress={() => handleSave({ provider: p })}
                >
                  <Text style={[s.providerPillText, active && s.providerPillTextActive]}>{p}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

// ── Settings Tab ───────────────────────────────────────────────────────────────

const SIGN_OUT_KEYS = [
  'zerox1:node_config',
  'zerox1:auto_start',
  'zerox1:onboarding_done',
  'zerox1:onboarding_partial_state',
  'zerox1:agent_brain',
  'zerox1:hosted_mode',
  'zerox1:host_url',
  'zerox1:hosted_token',
  'zerox1:hosted_agent_id',
  'zerox1:cold_wallet',
  'zerox1:task_log',
];

function SettingsTab() {
  const signOut = useSignOut();
  const { config, saveConfig, autoStart, setAutoStart, backgroundNode, setBackgroundNode, status, stop, start } = useNode();
  const [nameInput, setNameInput] = useState(config?.agentName ?? '');
  const [advancedVisible, setAdvancedVisible] = useState(false);

  useEffect(() => {
    setNameInput(config?.agentName ?? '');
  }, [config?.agentName]);

  const applyAndRestart = useCallback(async (updated: typeof config) => {
    await saveConfig(updated!);
    if (status === 'running') {
      try { await stop(); } catch { /* ignore */ }
      try { await start(updated!); } catch { /* ignore */ }
    }
  }, [saveConfig, status, stop, start, config]);

  const handleNameBlur = useCallback(async () => {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === config?.agentName) return;
    await applyAndRestart({ ...config, agentName: trimmed });
  }, [nameInput, config, applyAndRestart]);

  const handlePickAvatar = useCallback(async () => {
    const result = await launchImageLibrary({ mediaType: 'photo', quality: 0.8 });
    const uri = result.assets?.[0]?.uri;
    if (!uri) return;
    // Avatar is display-only — no restart needed
    await saveConfig({ ...config, agentAvatar: uri });
  }, [config, saveConfig]);

  const handleAutoStart = useCallback(async (val: boolean) => {
    try { await setAutoStart(val); } catch { /* ignore */ }
  }, [setAutoStart]);

  const handleBackgroundNode = useCallback(async (val: boolean) => {
    try { await setBackgroundNode(val); } catch { /* ignore */ }
  }, [setBackgroundNode]);

  const handleSignOut = useCallback(() => {
    Alert.alert('Sign out', 'Clear all data and return to onboarding?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out', style: 'destructive', onPress: async () => {
          await AsyncStorage.multiRemove(SIGN_OUT_KEYS);
          signOut();
        },
      },
    ]);
  }, [signOut]);

  return (
    <ScrollView style={s.tabContent}>
      {/* Identity */}
      <Text style={s.settingsSectionLabel}>IDENTITY</Text>
      <View style={s.settingsCard}>
        <TouchableOpacity style={s.avatarPickerRow} onPress={handlePickAvatar} activeOpacity={0.8}>
          <View style={s.settingsAvatarCircle}>
            <Image
              source={{ uri: config?.agentAvatar || DEFAULT_AGENT_ICON_URI }}
              style={s.settingsAvatarImage}
            />
          </View>
          <View style={s.avatarPickerInfo}>
            <Text style={s.settingsLabel}>Agent avatar</Text>
            <Text style={s.settingsHint}>Tap to change photo</Text>
          </View>
          <Text style={s.settingsValue}>›</Text>
        </TouchableOpacity>
        <View style={s.settingsCardDivider} />
        <View style={s.settingsRow}>
          <Text style={s.settingsLabel}>Agent name</Text>
          <TextInput
            style={s.nameInput}
            value={nameInput}
            onChangeText={setNameInput}
            onBlur={handleNameBlur}
            placeholder="e.g. Aria"
            placeholderTextColor="#d1d5db"
            returnKeyType="done"
            maxLength={32}
          />
        </View>
      </View>

      {/* Preferences */}
      <Text style={s.settingsSectionLabel}>PREFERENCES</Text>
      <View style={s.settingsCard}>
        <View style={s.settingsRow}>
          <View>
            <Text style={s.settingsLabel}>Auto-start on boot</Text>
            <Text style={s.settingsHint}>Start when device powers on</Text>
          </View>
          <Switch
            value={autoStart}
            onValueChange={handleAutoStart}
            trackColor={{ true: '#22c55e', false: '#d1d5db' }}
            thumbColor="#fff"
          />
        </View>
        <View style={s.settingsCardDivider} />
        <View style={s.settingsRow}>
          <View>
            <Text style={s.settingsLabel}>Run in background</Text>
            <Text style={s.settingsHint}>Stay active when app is minimized</Text>
          </View>
          <Switch
            value={backgroundNode}
            onValueChange={handleBackgroundNode}
            trackColor={{ true: '#22c55e', false: '#d1d5db' }}
            thumbColor="#fff"
          />
        </View>
        <View style={s.settingsCardDivider} />
        <View style={[s.settingsRow, s.settingsRowMuted]}>
          <Text style={s.settingsLabelMuted}>Notifications</Text>
          <Text style={s.settingsValueMuted}>coming soon</Text>
        </View>
      </View>

      {/* Advanced + Account */}
      <Text style={s.settingsSectionLabel}>MORE</Text>
      <View style={s.settingsCard}>
        <TouchableOpacity style={s.settingsRow} onPress={() => setAdvancedVisible(true)}>
          <Text style={s.settingsLabel}>Advanced settings</Text>
          <Text style={s.settingsValue}>›</Text>
        </TouchableOpacity>
        <View style={s.settingsCardDivider} />
        <TouchableOpacity style={s.settingsRow} onPress={handleSignOut}>
          <Text style={s.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </View>

      <View style={{ height: 32 }} />

      {/* Advanced modal */}
      <AdvancedModal
        visible={advancedVisible}
        onClose={() => setAdvancedVisible(false)}
        config={config}
        applyAndRestart={applyAndRestart}
      />
    </ScrollView>
  );
}

// ── Advanced Settings Modal ────────────────────────────────────────────────────

/** Each row in the permissions list. `caps` are bridge capability keys toggled together. */
interface CapDef {
  label: string;
  hint: string;
  caps: string[];
  permKeys: string[];          // keys from NodeModule.checkPermissions()
  special?: 'accessibility' | 'media_projection';
}

const CAP_GROUPS: CapDef[] = [
  { label: 'Notifications',     hint: 'Read, reply to & dismiss notifications',       caps: ['notifications_read','notifications_reply','notifications_dismiss'], permKeys: ['POST_NOTIFICATIONS'] },
  { label: 'SMS',               hint: 'Read & send text messages',                    caps: ['sms_read','sms_send'],                    permKeys: ['READ_SMS','SEND_SMS'] },
  { label: 'Contacts',          hint: 'Read & write address book',                    caps: ['contacts'],                               permKeys: ['READ_CONTACTS','WRITE_CONTACTS'] },
  { label: 'Phone calls',       hint: 'Screen & log incoming calls',                  caps: ['calls'],                                  permKeys: ['READ_CALL_LOG','READ_PHONE_STATE'] },
  { label: 'Location',          hint: 'GPS coordinates for context',                  caps: ['location'],                               permKeys: ['ACCESS_FINE_LOCATION'] },
  { label: 'Calendar',          hint: 'Read & create calendar events',                caps: ['calendar'],                               permKeys: ['READ_CALENDAR','WRITE_CALENDAR'] },
  { label: 'Camera',            hint: 'Take photos on your behalf',                   caps: ['camera'],                                 permKeys: ['CAMERA'] },
  { label: 'Microphone',        hint: 'Record audio for tasks',                       caps: ['microphone'],                             permKeys: ['RECORD_AUDIO'] },
  { label: 'Photos & storage',  hint: 'Access media library',                         caps: ['media'],                                  permKeys: ['READ_MEDIA_IMAGES'] },
  { label: 'Motion & activity', hint: 'Accelerometer, gyro, step detection',          caps: ['motion'],                                 permKeys: ['ACTIVITY_RECOGNITION'] },
  { label: 'Health data',       hint: 'Steps, heart rate, sleep via Health Connect',  caps: ['health'],                                 permKeys: ['health.READ_STEPS','health.READ_HEART_RATE'] },
  { label: 'Wearables (BLE)',   hint: 'Connect to Bluetooth health devices',          caps: ['wearables'],                              permKeys: ['BLUETOOTH_CONNECT','BLUETOOTH_SCAN'] },
  { label: 'Screen reading',    hint: 'Read UI elements via Accessibility Service',   caps: ['screen_read_tree','screen_vision'],        permKeys: [], special: 'accessibility' },
  { label: 'Screen actions',    hint: 'Tap & type on screen (ASSISTED mode)',         caps: ['screen_act','screen_global_nav','screen_autonomy'], permKeys: [], special: 'accessibility' },
  { label: 'Screen capture',    hint: 'Record screen for highlight reels',            caps: ['screen_capture'],                         permKeys: [], special: 'media_projection' },
];

function AdvancedModal({ visible, onClose, config, applyAndRestart }: {
  visible: boolean;
  onClose: () => void;
  config: any;
  applyAndRestart: (cfg: any) => Promise<void>;
}) {
  const { config: brain, save: saveBrain } = useAgentBrain();
  const [relayAddr, setRelayAddr] = useState(config?.relayAddr ?? '');
  const [rpcUrl, setRpcUrl] = useState(config?.rpcUrl ?? '');
  const [brainEnabled, setBrainEnabled] = useState(brain?.enabled ?? false);
  const [caps, setCaps] = useState<Record<string, boolean>>({});
  const [perms, setPerms] = useState<Record<string, boolean>>({});

  // Load bridge capabilities and permission statuses when modal opens
  useEffect(() => {
    if (!visible) return;
    setRelayAddr(config?.relayAddr ?? '');
    setRpcUrl(config?.rpcUrl ?? '');
    setBrainEnabled(brain?.enabled ?? false);
    NodeModule.getBridgeCapabilities().then(setCaps).catch(() => {});
    NodeModule.checkPermissions().then(setPerms).catch(() => {});
  }, [visible, config?.relayAddr, config?.rpcUrl, brain?.enabled]);

  /** Returns true if ALL caps in the group are enabled */
  const groupEnabled = useCallback((def: CapDef) =>
    def.caps.every(c => caps[c] !== false), [caps]);

  /** Returns 'granted' | 'denied' | 'partial' | 'special' for a group */
  const groupPermStatus = useCallback((def: CapDef): 'granted' | 'denied' | 'partial' | 'special' => {
    if (def.special) return 'special';
    if (def.permKeys.length === 0) return 'granted';
    const granted = def.permKeys.filter(k => perms[k]);
    if (granted.length === def.permKeys.length) return 'granted';
    if (granted.length === 0) return 'denied';
    return 'partial';
  }, [perms]);

  const handleCapToggle = useCallback(async (def: CapDef, val: boolean) => {
    const next = { ...caps };
    for (const c of def.caps) {
      next[c] = val;
      try { await NodeModule.setBridgeCapability(c, val); } catch { /* ignore */ }
    }
    setCaps(next);
  }, [caps]);

  const handlePermTap = useCallback(async (def: CapDef) => {
    if (def.special) { Linking.openSettings(); return; }
    // Try to request the first ungranted permission
    const denied = def.permKeys.filter(k => !perms[k]);
    if (denied.length === 0) { Linking.openSettings(); return; }
    try {
      await NodeModule.requestPermission(denied[0]);
      // Re-check after request
      NodeModule.checkPermissions().then(setPerms).catch(() => {});
    } catch { Linking.openSettings(); }
  }, [perms]);

  const handleBrainToggle = useCallback(async (val: boolean) => {
    setBrainEnabled(val);
    if (brain && saveBrain) await saveBrain({ ...brain, enabled: val });
    await applyAndRestart({ ...config, agentBrainEnabled: val });
  }, [brain, saveBrain, config, applyAndRestart]);

  const handleSaveNetwork = useCallback(async () => {
    await applyAndRestart({
      ...config,
      relayAddr: relayAddr.trim() || undefined,
      rpcUrl: rpcUrl.trim() || undefined,
    });
    onClose();
  }, [config, relayAddr, rpcUrl, applyAndRestart, onClose]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={s.modalRoot}>
        <View style={s.modalHeader}>
          <Text style={s.modalTitle}>Advanced</Text>
          <TouchableOpacity onPress={onClose}>
            <Text style={s.modalClose}>✕</Text>
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

          {/* Agent brain */}
          <Text style={s.settingsSectionLabel}>AGENT BRAIN</Text>
          <View style={s.settingsCard}>
            <View style={s.settingsRow}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={s.settingsLabel}>Enable agent brain</Text>
                <Text style={s.settingsHint}>AI autonomously takes and completes jobs</Text>
              </View>
              <Switch value={brainEnabled} onValueChange={handleBrainToggle}
                trackColor={{ true: '#22c55e', false: '#d1d5db' }} thumbColor="#fff" />
            </View>
            <View style={s.settingsCardDivider} />
            <View style={[s.settingsRow, s.settingsRowMuted]}>
              <Text style={s.settingsLabelMuted}>Provider</Text>
              <Text style={s.settingsValueMuted}>{brain?.provider ?? 'not set'}</Text>
            </View>
            <View style={s.settingsCardDivider} />
            <View style={[s.settingsRow, s.settingsRowMuted]}>
              <Text style={s.settingsLabelMuted}>API key</Text>
              <Text style={s.settingsValueMuted}>{brain?.apiKeySet ? '●●●●●●●●' : 'not set'}</Text>
            </View>
          </View>

          {/* Phone access — all bridge capabilities */}
          <Text style={s.settingsSectionLabel}>PHONE ACCESS</Text>
          <Text style={s.permSectionHint}>
            Control exactly what your agent can access on this device. Toggle off to revoke access without changing OS permissions.
          </Text>
          <View style={s.settingsCard}>
            {CAP_GROUPS.map((def, i) => {
              const enabled = groupEnabled(def);
              const status = groupPermStatus(def);
              const dotColor = status === 'granted' ? '#22c55e'
                : status === 'partial' ? '#f59e0b'
                : status === 'special' ? '#9ca3af'
                : '#ef4444';
              const statusLabel = status === 'granted' ? 'Allowed'
                : status === 'partial' ? 'Partial'
                : status === 'special' ? 'System'
                : 'Denied';

              return (
                <View key={def.label}>
                  {i > 0 && <View style={s.settingsCardDivider} />}
                  <View style={s.capRow}>
                    <Switch
                      value={enabled}
                      onValueChange={val => handleCapToggle(def, val)}
                      trackColor={{ true: '#22c55e', false: '#d1d5db' }}
                      thumbColor="#fff"
                      style={s.capSwitch}
                    />
                    <View style={s.capInfo}>
                      <Text style={[s.settingsLabel, !enabled && s.capLabelOff]}>{def.label}</Text>
                      <Text style={s.settingsHint}>{def.hint}</Text>
                    </View>
                    <TouchableOpacity style={s.permRight} onPress={() => handlePermTap(def)}>
                      <View style={[s.permDot, { backgroundColor: dotColor }]} />
                      <Text style={s.permLabel}>{statusLabel}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </View>

          {/* Network */}
          <Text style={s.settingsSectionLabel}>NETWORK</Text>
          <View style={s.settingsCard}>
            <View style={[s.settingsRow, { flexDirection: 'column', alignItems: 'flex-start', gap: 6 }]}>
              <Text style={s.settingsLabel}>Relay address</Text>
              <TextInput style={s.advancedInput} value={relayAddr} onChangeText={setRelayAddr}
                placeholder="/ip4/…/p2p/…" placeholderTextColor="#d1d5db"
                autoCapitalize="none" autoCorrect={false} />
            </View>
            <View style={s.settingsCardDivider} />
            <View style={[s.settingsRow, { flexDirection: 'column', alignItems: 'flex-start', gap: 6 }]}>
              <Text style={s.settingsLabel}>Solana RPC URL</Text>
              <TextInput style={s.advancedInput} value={rpcUrl} onChangeText={setRpcUrl}
                placeholder="https://api.mainnet-beta.solana.com" placeholderTextColor="#d1d5db"
                autoCapitalize="none" autoCorrect={false} />
            </View>
          </View>

          {/* About */}
          <Text style={s.settingsSectionLabel}>ABOUT</Text>
          <View style={s.settingsCard}>
            <View style={[s.settingsRow, s.settingsRowMuted]}>
              <Text style={s.settingsLabelMuted}>App</Text>
              <Text style={s.settingsValueMuted}>0x01 Pilot</Text>
            </View>
            <View style={s.settingsCardDivider} />
            <View style={[s.settingsRow, s.settingsRowMuted]}>
              <Text style={s.settingsLabelMuted}>Node version</Text>
              <Text style={s.settingsValueMuted}>v0.4.0</Text>
            </View>
          </View>

          <TouchableOpacity style={s.saveBtn} onPress={handleSaveNetwork}>
            <Text style={s.saveBtnText}>Save &amp; apply</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  header: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  title: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 10 },
  segmented: { flexDirection: 'row', borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 8, overflow: 'hidden' },
  segment: { flex: 1, padding: 6, alignItems: 'center' },
  segmentActive: { backgroundColor: '#111' },
  segmentText: { fontSize: 10, color: '#6b7280' },
  segmentTextActive: { color: '#fff', fontWeight: '600' },

  tabContent: { flex: 1 },

  // Wallet
  balanceHero: { alignItems: 'center', paddingTop: 24, paddingBottom: 16 },
  balanceLabel: { fontSize: 10, color: '#9ca3af', letterSpacing: 0.5, marginBottom: 6 },
  balanceAmount: { fontSize: 34, fontWeight: '700', color: '#111', letterSpacing: -1 },
  balanceDelta: { fontSize: 10, color: '#22c55e', marginTop: 4 },

  addressCard: {
    marginHorizontal: 16, backgroundColor: '#f9fafb',
    borderRadius: 10, padding: 10, marginBottom: 12,
  },
  addressRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5 },
  addressDivider: { height: 1, backgroundColor: '#e5e7eb', marginVertical: 4 },
  addressLabel: { fontSize: 10, color: '#6b7280' },
  addressValue: { fontSize: 9, color: '#374151', fontFamily: 'monospace' },
  addressValueMuted: { fontSize: 9, color: '#9ca3af' },
  greenDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#22c55e' },

  walletActions: { flexDirection: 'row', gap: 6, paddingHorizontal: 16, marginBottom: 4 },
  sweepBtn: { flex: 1, backgroundColor: '#111', borderRadius: 9, padding: 10, alignItems: 'center' },
  sweepBtnText: { fontSize: 11, color: '#fff', fontWeight: '600' },
  historyBtn: { flex: 1, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 9, padding: 10, alignItems: 'center' },
  historyBtnText: { fontSize: 11, color: '#374151', fontWeight: '500' },
  btnDisabled: { opacity: 0.4 },

  sectionLabel: { fontSize: 10, color: '#9ca3af', letterSpacing: 0.5, marginBottom: 8 },
  emptyText: { fontSize: 14, color: '#d1d5db', textAlign: 'center', paddingVertical: 24, paddingHorizontal: 16 },

  txRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 16 },
  txRowBorder: { borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  txTitle: { fontSize: 11, color: '#111' },
  txTime: { fontSize: 9, color: '#9ca3af', marginTop: 1 },
  txAmountPos: { fontSize: 12, color: '#22c55e', fontWeight: '600' },
  txAmountNeg: { fontSize: 12, color: '#6b7280', fontWeight: '600' },

  modalRoot: { flex: 1, backgroundColor: '#fff' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#111' },
  modalClose: { fontSize: 16, color: '#9ca3af' },

  // Agent
  agentHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 16 },
  agentAvatarCircle: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#f0fdf4', borderWidth: 1, borderColor: '#bbf7d0', overflow: 'hidden' },
  agentAvatarImage: { width: 40, height: 40 },
  agentInfo: { flex: 1 },
  agentNameText: { fontSize: 13, fontWeight: '600', color: '#111' },
  agentStatusText: { fontSize: 10, color: '#22c55e', marginTop: 2 },

  ruleRows: { paddingHorizontal: 16 },
  ruleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 },
  ruleRowBorder: { borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  ruleLabel: { fontSize: 11, color: '#111', fontWeight: '500' },
  ruleHint: { fontSize: 10, color: '#9ca3af', marginTop: 1 },
  ruleInput: { fontSize: 13, fontWeight: '700', color: '#111', textAlign: 'right', minWidth: 60 },
  ruleValue: { fontSize: 11, color: '#9ca3af' },

  capPill: { backgroundColor: '#f3f4f6', borderRadius: 20, paddingHorizontal: 9, paddingVertical: 3 },
  capPillText: { fontSize: 9, color: '#374151', fontWeight: '500' },
  capPillAdd: { borderWidth: 1, borderStyle: 'dashed', borderColor: '#d1d5db', borderRadius: 20, paddingHorizontal: 9, paddingVertical: 3 },
  capPillAddText: { fontSize: 9, color: '#9ca3af' },
  walletOptionBtn: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, padding: 12 },
  walletOptionLabel: { fontSize: 12, fontWeight: '600', color: '#111', marginBottom: 2 },
  providerPill: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  providerPillActive: { backgroundColor: '#111', borderColor: '#111' },
  providerPillText: { fontSize: 10, color: '#374151', fontWeight: '500' },
  providerPillTextActive: { color: '#fff' },

  // Settings
  settingsSectionLabel: { fontSize: 10, color: '#9ca3af', letterSpacing: 0.5, marginBottom: 6, marginTop: 18, paddingHorizontal: 16 },
  settingsCard: { marginHorizontal: 16, backgroundColor: '#fff', borderWidth: 1, borderColor: '#f3f4f6', borderRadius: 12, paddingHorizontal: 14 },
  settingsCardDivider: { height: 1, backgroundColor: '#f3f4f6' },
  settingsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 },
  settingsRowMuted: { opacity: 0.5 },
  settingsLabel: { fontSize: 11, color: '#111', fontWeight: '500' },
  settingsHint: { fontSize: 9, color: '#9ca3af', marginTop: 1 },
  settingsLabelMuted: { fontSize: 11, color: '#9ca3af' },
  settingsValue: { fontSize: 11, color: '#9ca3af' },
  settingsValueMuted: { fontSize: 11, color: '#d1d5db' },
  signOutText: { fontSize: 11, color: '#ef4444', fontWeight: '500' },

  avatarPickerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  settingsAvatarCircle: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#f0fdf4', borderWidth: 1, borderColor: '#bbf7d0', overflow: 'hidden' },
  settingsAvatarImage: { width: 44, height: 44 },
  avatarPickerInfo: { flex: 1 },
  nameInput: { fontSize: 11, color: '#111', textAlign: 'right', flex: 1, marginLeft: 16 },
  advancedInput: { fontSize: 11, color: '#111', borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 7, paddingHorizontal: 10, paddingVertical: 7, width: '100%' },
  permRight: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  permDot: { width: 6, height: 6, borderRadius: 3 },
  permLabel: { fontSize: 9, color: '#9ca3af', fontWeight: '500' },
  permSectionHint: { fontSize: 10, color: '#9ca3af', marginHorizontal: 16, marginTop: -4, marginBottom: 8, lineHeight: 14 },
  capRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 10 },
  capSwitch: { transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] },
  capInfo: { flex: 1 },
  capLabelOff: { color: '#9ca3af' },
  saveBtn: { backgroundColor: '#111', borderRadius: 10, padding: 13, alignItems: 'center', marginTop: 24, marginBottom: 8 },
  saveBtnText: { fontSize: 12, color: '#fff', fontWeight: '600' },
});
