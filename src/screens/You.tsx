import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput,
  Switch, Alert, Modal, FlatList,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNode } from '../hooks/useNode';
import { useAgentBrain } from '../hooks/useAgentBrain';
import {
  useHotKeyBalance, useTaskLog, sweepUsdc,
} from '../hooks/useNodeApi';
import { useSignOut } from '../../App';

const COLD_WALLET_KEY = 'zerox1:cold_wallet';
const AUTO_START_KEY = 'zerox1:auto_start';

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

  useEffect(() => {
    AsyncStorage.getItem(COLD_WALLET_KEY).then(v => setColdWallet(v));
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
        <View style={s.addressRow}>
          <Text style={s.addressLabel}>Cold wallet</Text>
          {coldWallet ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View style={s.greenDot} />
              <Text style={s.addressValue}>
                {`${coldWallet.slice(0, 4)}…${coldWallet.slice(-4)}`}
              </Text>
            </View>
          ) : (
            <Text style={s.addressValueMuted}>Link cold wallet</Text>
          )}
        </View>
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

// ── Agent Tab ──────────────────────────────────────────────────────────────────

function AgentTab() {
  const { status, config: nodeConfig } = useNode();
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
    await save({ ...config, ...updates });
  };

  return (
    <ScrollView style={s.tabContent}>
      {/* Agent header */}
      <View style={s.agentHeader}>
        <View style={s.agentAvatarCircle}>
          <Text style={s.agentAvatarIcon}>◉</Text>
        </View>
        <View style={s.agentInfo}>
          <Text style={s.agentNameText}>{agentName}</Text>
          <Text style={s.agentStatusText}>
            {isRunning ? '● Active' : '○ Offline'}
          </Text>
        </View>
      </View>

      {isRunning && (
        <View style={s.restartBanner}>
          <Text style={s.restartBannerText}>Restart node to apply changes</Text>
        </View>
      )}

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
              <View key={cap} style={s.capPill}>
                <Text style={s.capPillText}>{cap}</Text>
              </View>
            ))}
            <TouchableOpacity style={s.capPillAdd}>
              <Text style={s.capPillAddText}>+ add</Text>
            </TouchableOpacity>
          </View>
        </View>
        <View style={[s.ruleRow, s.ruleRowBorder]}>
          <Text style={s.ruleLabel}>LLM provider</Text>
          <Text style={s.ruleValue}>{config?.provider ?? 'openai'} ›</Text>
        </View>
      </View>
    </ScrollView>
  );
}

// ── Settings Tab ───────────────────────────────────────────────────────────────

function SettingsTab() {
  const signOut = useSignOut();
  const [autoStart, setAutoStartLocal] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(AUTO_START_KEY).then(v => setAutoStartLocal(v === 'true'));
  }, []);

  const handleAutoStartToggle = async (val: boolean) => {
    setAutoStartLocal(val);
    try {
      await AsyncStorage.setItem(AUTO_START_KEY, val ? 'true' : 'false');
    } catch {
      setAutoStartLocal(!val);
    }
  };

  return (
    <ScrollView style={s.tabContent}>
      <View style={s.settingsRows}>
        {/* Toggle rows */}
        <View style={s.settingsRow}>
          <Text style={s.settingsLabel}>Auto-start on boot</Text>
          <Switch
            value={autoStart}
            onValueChange={handleAutoStartToggle}
            trackColor={{ true: '#22c55e', false: '#d1d5db' }}
            thumbColor="#fff"
          />
        </View>
        <View style={[s.settingsRow, s.settingsRowBorder, s.settingsRowMuted]}>
          <Text style={s.settingsLabelMuted}>Notifications</Text>
          <Text style={s.settingsValueMuted}>coming soon</Text>
        </View>

        {/* Nav rows */}
        <View style={[s.settingsRow, s.settingsRowBorder]}>
          <Text style={s.settingsLabel}>Node mode</Text>
          <Text style={s.settingsValue}>Local ›</Text>
        </View>
        <View style={[s.settingsRow, s.settingsRowBorder]}>
          <Text style={s.settingsLabel}>API keys</Text>
          <Text style={s.settingsValue}>›</Text>
        </View>
        <View style={[s.settingsRow, s.settingsRowBorder]}>
          <Text style={s.settingsLabel}>About</Text>
          <Text style={s.settingsValue}>›</Text>
        </View>

        {/* Destructive */}
        <View style={[s.settingsRow, s.settingsRowBorder]}>
          <TouchableOpacity onPress={() => Alert.alert('Sign out', 'Clear all data and return to onboarding?', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Sign out', style: 'destructive', onPress: async () => {
            // Clear all user data from AsyncStorage
            const keys = [
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
            await AsyncStorage.multiRemove(keys);
            signOut();
          } },
          ])}>
            <Text style={s.signOutText}>Sign out</Text>
          </TouchableOpacity>
        </View>
      </View>
    </ScrollView>
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
  agentAvatarCircle: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#f0fdf4', borderWidth: 1, borderColor: '#bbf7d0', alignItems: 'center', justifyContent: 'center' },
  agentAvatarIcon: { fontSize: 18, color: '#374151' },
  agentInfo: { flex: 1 },
  agentNameText: { fontSize: 13, fontWeight: '600', color: '#111' },
  agentStatusText: { fontSize: 10, color: '#22c55e', marginTop: 2 },

  restartBanner: { marginHorizontal: 16, backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fbbf24', borderRadius: 8, padding: 10, marginBottom: 8 },
  restartBannerText: { fontSize: 11, color: '#b45309' },

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

  // Settings
  settingsRows: { paddingHorizontal: 16 },
  settingsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 },
  settingsRowBorder: { borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  settingsRowMuted: { opacity: 0.5 },
  settingsLabel: { fontSize: 11, color: '#111' },
  settingsLabelMuted: { fontSize: 11, color: '#9ca3af' },
  settingsValue: { fontSize: 11, color: '#9ca3af' },
  settingsValueMuted: { fontSize: 11, color: '#d1d5db' },
  signOutText: { fontSize: 11, color: '#ef4444' },
});
