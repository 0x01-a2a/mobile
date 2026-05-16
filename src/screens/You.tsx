import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput,
  Switch, Alert, Modal, FlatList, Image, Linking, ActivityIndicator,
  AppState, AppStateStatus, Platform, Share,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { launchImageLibrary } from 'react-native-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useNode } from '../hooks/useNode';
import { NodeModule } from '../native/NodeModule';
import { useAgentBrain, saveLlmApiKey, clearLlmApiKey, saveFalApiKey, saveReplicateApiKey, saveMoltbookApiKey, clearMoltbookApiKey, saveNeynarApiKey, saveFarcasterSignerUuid, saveFarcasterFid, ALL_CAPABILITIES } from '../hooks/useAgentBrain';
import {
  useHotKeyBalance, useHotWalletRegistration, useIdentity, useTaskLog, sweepSol,
  useSkills, useSkillMarketplace, skillInstallUrl, skillInstallFromMarketplace, skillRemove,
  useSolPrice, useDexPrices,
  AGGREGATOR_API,
  type Skill, type SkillListing,
} from '../hooks/useNodeApi';
import { useSignOut } from '../../App';
import { DEFAULT_AGENT_ICON_URI } from '../assets/defaultAgentIcon';
import { setLanguage } from '../i18n';
import {
  buildConnectUrl, buildSignMessageUrl,
  setPendingConnectCb, setPendingSignMessageCb,
  handleIncomingUrl,
} from '../utils/phantomDeepLink';
import { use01PLGate, PRESENCE_THRESHOLD, PILOT_TOKEN_MINT } from '../hooks/use01PLGate';
import { useTheme, PILOT_ACCENT, ThemeColors } from '../theme/ThemeContext';
import { useLayout } from '../hooks/useLayout';
import { useRegionGate } from '../hooks/useRegionGate';

const COLD_WALLET_KEY = 'zerox1:cold_wallet';
const COLD_WALLET_REGISTERED_KEY = 'zerox1:cold_wallet_registered';
const PRESENCE_ENABLED_KEY = 'zerox1:presence_enabled';
const EMERGENCY_CONTACTS_KEY = 'zerox1:emergency_contacts';
const SAFETY_ENABLED_KEY = 'zerox1:safety_enabled';

interface EmergencyContact {
  name: string;
  phone: string;
}
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Minimum sweepable SOL — must cover fee reserve (0.01 SOL)
const SOL_SWEEP_MIN = 0.011;

type SubTab = 'Wallet' | 'Brain' | 'Advanced';

function fmt(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function isToday(tsSeconds: number): boolean {
  const d = new Date(tsSeconds * 1000);
  return d.toDateString() === new Date().toDateString();
}

export default function YouScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const { brainAvailable } = useRegionGate();
  const availableTabs = brainAvailable
    ? (['Wallet', 'Brain', 'Advanced'] as SubTab[])
    : (['Wallet', 'Advanced'] as SubTab[]);
  const [tab, setTab] = useState<SubTab>('Wallet');
  const { t } = useTranslation();
  const { status } = useNode();
  const isRunning = status === 'running';
  const { contentMaxWidth } = useLayout();

  const centerStyle = contentMaxWidth
    ? { flex: 1, maxWidth: contentMaxWidth, alignSelf: 'center' as const, width: '100%' as const }
    : { flex: 1 };

  return (
    <View style={[s.root, { backgroundColor: colors.bg }]}>
      <View style={centerStyle}>
        {/* Header */}
        <View style={[s.header, { paddingTop: insets.top + 14, borderBottomColor: colors.border }]}>
          <View style={s.titleRow}>
            <Text style={[s.title, { color: colors.text }]}>{t('you.title')}</Text>
            <View style={[s.statusDot, { backgroundColor: isRunning ? colors.green : colors.dim }]} />
          </View>
          <View style={s.segmented}>
            {availableTabs.map(tabKey => (
              <TouchableOpacity
                key={tabKey}
                style={[s.segment, tab === tabKey && s.segmentActive]}
                onPress={() => setTab(tabKey)}
              >
                <Text style={[s.segmentText, tab === tabKey && s.segmentTextActive]}>
                  {tabKey}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {tab === 'Wallet' && <WalletTab />}
        {tab === 'Brain' && brainAvailable && <BrainTab />}
        {tab === 'Advanced' && <AdvancedTab />}
      </View>
    </View>
  );
}

// ── Wallet Tab ─────────────────────────────────────────────────────────────────

function WalletTab() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const { tokens, solanaAddress, loading } = useHotKeyBalance();
  useHotWalletRegistration();
  const identity = useIdentity();
  const { entries: taskEntries } = useTaskLog();
  const [coldWallet, setColdWallet] = useState<string | null>(null);
  const [coldWalletRegistered, setColdWalletRegistered] = useState<string | null>(null);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [linkWalletVisible, setLinkWalletVisible] = useState(false);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(COLD_WALLET_KEY),
      AsyncStorage.getItem(COLD_WALLET_REGISTERED_KEY),
    ]).then(([wallet, registered]) => {
      setColdWallet(wallet);
      setColdWalletRegistered(registered);
    });
  }, []);

  // Direct Phantom deeplink — app↔app, no browser hop.
  // Step 1: connect (get pubKey + session).
  // Step 2: signMessage (wallet signs agent_id bytes to prove ownership).
  // Step 3: register with aggregator, then save locally.
  const handleOpenPhantom = useCallback(() => {
    const agentIdHex = identity?.agent_id ?? null;
    const connectUrl = buildConnectUrl('phantom-connect');

    const connectSub = Linking.addEventListener('url', ({ url: incoming }: { url: string }) => {
      if (!incoming.includes('phantom-connect')) return;
      connectSub.remove();
      handleIncomingUrl(incoming);
    });

    setPendingConnectCb(async (pubKey) => {
      if (!pubKey) return;

      // Save the wallet address immediately so the UI updates.
      await AsyncStorage.setItem(COLD_WALLET_KEY, pubKey);
      setColdWallet(pubKey);
      setLinkWalletVisible(false);

      // Step 2: if we have the agent_id, ask Phantom to sign it to prove ownership.
      if (!agentIdHex) return;
      try {
        const agentIdBytes = Uint8Array.from(
          (agentIdHex.match(/.{1,2}/g) ?? []).map((b: string) => parseInt(b, 16))
        );
        const signUrl = buildSignMessageUrl(agentIdBytes, 'phantom-sign-message');

        const signSub = Linking.addEventListener('url', ({ url: incoming }: { url: string }) => {
          if (!incoming.includes('phantom-sign-message')) return;
          signSub.remove();
          handleIncomingUrl(incoming);
        });

        setPendingSignMessageCb(async (sigBytes) => {
          if (!sigBytes) return;
          try {
            // Convert signature bytes to base64.
            const sigB64 = btoa(String.fromCharCode(...sigBytes));
            const res = await fetch(`${AGGREGATOR_API}/wallets/register`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agent_id: agentIdHex, wallet_address: pubKey, signature: sigB64 }),
            });
            if (res.ok) {
              await AsyncStorage.setItem(COLD_WALLET_REGISTERED_KEY, pubKey).catch(() => {});
              setColdWalletRegistered(pubKey);
            }
          } catch { /* non-fatal */ }
        });

        Linking.openURL(signUrl);
      } catch { /* non-fatal — Phantom session may not be ready */ }
    });

    Linking.openURL(connectUrl);
  }, [identity?.agent_id]);

  const handleUnlinkWallet = useCallback(() => {
    Alert.alert(t('you.unlinkColdWallet'), t('you.unlinkConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('you.unlinkColdWalletBtn'), style: 'destructive', onPress: async () => {
        await AsyncStorage.removeItem(COLD_WALLET_KEY);
        setColdWallet(null);
      }},
    ]);
  }, [t]);

  const solPrice = useSolPrice();
  const otherMints = useMemo(
    () => tokens.filter(t => t.mint !== SOL_MINT).map(t => t.mint),
    [tokens],
  );
  const dexPrices = useDexPrices(otherMints);

  const solBalance = useMemo(() => {
    const t = tokens.find(t => t.mint === SOL_MINT);
    return t ? t.amount / Math.pow(10, t.decimals) : 0;
  }, [tokens]);

  const totalUsd = useMemo(() => {
    let total = solPrice ? solBalance * solPrice : 0;
    for (const t of tokens) {
      if (t.mint === SOL_MINT) continue;
      const p = dexPrices.get(t.mint);
      if (p) total += (t.amount / Math.pow(10, t.decimals)) * p.priceUsd;
    }
    return total;
  }, [solBalance, solPrice, tokens, dexPrices]);

  const earnedToday = useMemo(() => {
    return taskEntries
      .filter(e => e.outcome === 'success' && isToday(e.timestamp))
      .reduce((acc, e) => acc + (e.amount_usd ?? 0), 0);
  }, [taskEntries]);

  const recentHistory = useMemo(
    () => taskEntries.filter(e => e.outcome === 'success').slice(0, 5),
    [taskEntries],
  );

  const doSweep = useCallback(async () => {
    if (!coldWallet) return;
    setSweeping(true);
    try {
      const result = await sweepSol(coldWallet, solBalance);
      Alert.alert(t('you.swept'), t('you.sweptBody', { amount: result.amount_sol.toFixed(4) }));
    } catch (e: any) {
      Alert.alert(t('common.error'), e?.message ?? t('you.sweepError'));
    } finally {
      setSweeping(false);
    }
  }, [coldWallet, solBalance]);

  const handleSweep = useCallback(() => {
    if (!coldWallet) return;
    Alert.alert(
      'Sweep to cold wallet',
      'Keep ~0.01 SOL for transaction fees.\n\nSweep remaining SOL to your personal wallet?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sweep', onPress: doSweep },
      ],
    );
  }, [coldWallet, doSweep]);

  return (
    <ScrollView style={s.tabContent}>
      {/* Balance hero */}
      <View style={s.balanceHero}>
        <Text style={s.balanceLabel}>{t('you.holdings')}</Text>
        {loading
          ? <ActivityIndicator size="small" color="#111" style={{ marginVertical: 6 }} />
          : <Text style={s.balanceAmount}>{fmt(totalUsd)}</Text>}
        {earnedToday > 0 && (
          <Text style={s.balanceDelta}>↑ {fmt(earnedToday)} {t('you.earnedToday')}</Text>
        )}
        {!loading && tokens.length === 0 && (
          <Text style={s.balanceEmpty}>{t('you.noTokensYet')}</Text>
        )}
        {!loading && tokens.length > 0 && (
          <View style={s.holdingsRow}>
            {solBalance > 0 && (
              <Text style={s.holdingsPill}>
                {solBalance < 0.001 ? '<0.001' : solBalance.toFixed(3)} SOL
              </Text>
            )}
            {tokens.filter(t => t.mint !== SOL_MINT).map(t => {
              const p = dexPrices.get(t.mint);
              const symbol = p?.symbol ?? t.mint.slice(0, 4) + '…';
              const amt = t.amount / Math.pow(10, t.decimals);
              return (
                <Text key={t.mint} style={s.holdingsPill}>
                  {amt < 0.001 ? '<0.001' : amt.toFixed(3)} {symbol}
                </Text>
              );
            })}
          </View>
        )}
      </View>

      {/* Address card */}
      <View style={s.addressCard}>
        {/* Agent Earnings */}
        <TouchableOpacity
          style={s.addressRow}
          disabled={!solanaAddress}
          onPress={() => {
            if (!solanaAddress) return;
            Alert.alert(
              'Hot Wallet',
              `${solanaAddress.slice(0, 6)}…${solanaAddress.slice(-6)}`,
              [
                { text: 'Copy Address', onPress: () => Share.share({ message: solanaAddress }) },
                { text: 'View on Solscan', onPress: () => Linking.openURL(`https://solscan.io/account/${solanaAddress}`) },
                { text: 'Cancel', style: 'cancel' },
              ],
            );
          }}
        >
          <View>
            <Text style={s.addressLabel}>{t('you.agentEarningsTitle')}</Text>
            <Text style={s.walletDescText}>{t('you.agentEarningsDesc')}</Text>
          </View>
          <Text style={s.addressValue} numberOfLines={1}>
            {solanaAddress ? `${solanaAddress.slice(0, 4)}…${solanaAddress.slice(-4)}` : '—'}
          </Text>
        </TouchableOpacity>
        <View style={s.addressDivider} />
        {/* Your Personal Wallet */}
        <TouchableOpacity
          style={s.addressRow}
          onPress={coldWallet
            ? (coldWalletRegistered === coldWallet ? handleUnlinkWallet : () => setLinkWalletVisible(true))
            : () => setLinkWalletVisible(true)}
        >
          <View>
            <Text style={s.addressLabel}>{t('you.personalWalletTitle')}</Text>
            <Text style={s.walletDescText}>{t('you.personalWalletDesc')}</Text>
          </View>
          {coldWallet ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View style={coldWalletRegistered === coldWallet ? s.greenDot : s.amberDot} />
              <Text style={s.addressValue}>
                {`${coldWallet.slice(0, 4)}…${coldWallet.slice(-4)}`}
              </Text>
              {coldWalletRegistered !== coldWallet && (
                <Text style={{ fontSize: 10, color: '#d97706' }}>verify</Text>
              )}
            </View>
          ) : (
            <Text style={[s.addressValueMuted, { color: '#374151' }]}>{t('you.linkWallet')}</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* How earnings work */}
      <View style={s.howItWorksCard}>
        <Text style={s.howItWorksTitle}>HOW YOU EARN</Text>
        <Text style={s.howItWorksBody}>
          Requesters browse the 01 mesh and buy your agent token to hire you. Every token purchase sends trading fees to this hot wallet. Link a personal wallet below to sweep earnings to cold storage.
        </Text>
      </View>

      {/* Actions */}
      <View style={s.walletActions}>
        <TouchableOpacity
          style={[s.sweepBtn, (!coldWallet || solBalance <= SOL_SWEEP_MIN || sweeping) && s.btnDisabled]}
          onPress={handleSweep}
          disabled={!coldWallet || solBalance <= SOL_SWEEP_MIN || sweeping}
        >
          <Text style={s.sweepBtnText}>{sweeping ? t('you.sweeping') : t('you.sweepSol')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={s.historyBtn}
          onPress={() => setHistoryVisible(true)}
        >
          <Text style={s.historyBtnText}>{t('you.history')}</Text>
        </TouchableOpacity>
      </View>

      {/* Recent */}
      <Text style={[s.sectionLabel, { paddingHorizontal: 16, paddingTop: 16 }]}>{t('you.recent')}</Text>
      {recentHistory.length === 0 && (
        <Text style={s.emptyText}>{t('you.noTransactions')}</Text>
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

      {/* Pilot Mode — 01PL exclusive: gold accent + Live Activity (iOS) or floating bubble (Android) */}
      {Platform.OS === 'ios' && (
        <PilotModeCard hotWallet={solanaAddress ?? null} coldWallet={coldWallet} onLinkWallet={() => setLinkWalletVisible(true)} />
      )}
      {Platform.OS === 'android' && (
        <PresenceCard hotWallet={solanaAddress ?? null} coldWallet={coldWallet} onLinkWallet={() => setLinkWalletVisible(true)} />
      )}

      {/* Link wallet modal — opens connect.html in browser; address returned via deeplink */}
      <Modal visible={linkWalletVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setLinkWalletVisible(false)}>
        <View style={s.modalRoot}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>{t('you.linkColdWallet')}</Text>
            <TouchableOpacity onPress={() => setLinkWalletVisible(false)}>
              <Text style={s.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <View style={{ padding: 16, gap: 12 }}>
            <Text style={s.settingsHint}>{t('you.coldWalletHint')}</Text>
            <TouchableOpacity style={s.walletOptionBtn} onPress={handleOpenPhantom}>
              <View>
                <Text style={s.walletOptionLabel}>Phantom</Text>
                <Text style={s.settingsHint}>{t('you.connectHint')}</Text>
              </View>
              <Text style={s.settingsValue}>↗</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* History modal */}
      <Modal visible={historyVisible} animationType="slide" onRequestClose={() => setHistoryVisible(false)}>
        <View style={s.modalRoot}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>{t('you.transactionHistory')}</Text>
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
            ListEmptyComponent={<Text style={s.emptyText}>{t('you.noHistory')}</Text>}
            contentContainerStyle={{ padding: 16 }}
          />
        </View>
      </Modal>
    </ScrollView>
  );
}

// ── Pilot Mode Row (inside Android PresenceCard) ───────────────────────────────

function PilotModeRow() {
  const { pilotMode, setPilotMode, colors } = useTheme();
  const s = makeStyles(colors);
  return (
    <View style={s.pilotModeRow}>
      <View style={{ flex: 1 }}>
        <Text style={s.pilotModeLabel}>◈ Pilot Mode</Text>
        <Text style={s.pilotModeHint}>Gold accent · Dynamic Island</Text>
      </View>
      <Switch
        value={pilotMode}
        onValueChange={setPilotMode}
        trackColor={{ true: PILOT_ACCENT, false: '#d1d5db' }}
        thumbColor="#fff"
      />
    </View>
  );
}

// ── Pilot Mode Card (iOS — replaces PresenceCard) ──────────────────────────────

function PilotModeCard({
  hotWallet,
  coldWallet,
  onLinkWallet,
}: {
  hotWallet: string | null;
  coldWallet: string | null;
  onLinkWallet: () => void;
}) {
  const { eligible, balance, loading, error, refresh } = use01PLGate([hotWallet, coldWallet]);
  const { pilotMode, setPilotMode, colors } = useTheme();
  const s = makeStyles(colors);

  const fmtBalance = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k`
    : n.toFixed(0);

  return (
    <View style={s.presenceSection}>
      <Text style={[s.sectionLabel, { paddingHorizontal: 0, marginBottom: 8 }]}>
        PILOT MODE · 01PL
      </Text>

      <View style={[s.presenceCard, eligible && s.presenceCardEligible]}>
        {/* Header row */}
        <View style={s.presenceTopRow}>
          {eligible ? (
            <View style={s.presenceBadge}>
              <Text style={s.presenceBadgeText}>★ HOLDER</Text>
            </View>
          ) : (
            <View style={[s.presenceBadge, s.presenceBadgeLocked]}>
              <Text style={s.presenceBadgeText}>🔒 01PL EXCLUSIVE</Text>
            </View>
          )}
          {eligible ? (
            <Switch
              value={pilotMode}
              onValueChange={setPilotMode}
              trackColor={{ true: PILOT_ACCENT, false: '#d1d5db' }}
              thumbColor="#fff"
            />
          ) : error ? (
            <TouchableOpacity onPress={refresh} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={[s.presenceLockText, { color: '#dc2626' }]}>RPC error · retry ↺</Text>
            </TouchableOpacity>
          ) : (
            <Text style={s.presenceLockText}>
              {loading ? '…' : `${fmtBalance(balance)} / ${fmtBalance(PRESENCE_THRESHOLD)}`}
            </Text>
          )}
        </View>

        {/* Description */}
        <View style={s.presenceHeroRow}>
          <View style={[s.presenceBubblePreview, { backgroundColor: pilotMode && eligible ? '#fef3c7' : '#f3f4f6' }]}>
            <Text style={{ fontSize: 18 }}>◈</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.presenceTitle}>
              {eligible ? (pilotMode ? 'Pilot Mode active' : 'Pilot Mode') : 'Pilot Mode'}
            </Text>
            <Text style={s.presenceDesc}>
              {eligible
                ? pilotMode
                  ? 'Gold accent is live across the app. Dynamic Island shows your agent status.'
                  : 'Enable to unlock gold accent and Live Activity on Dynamic Island.'
                : `Hold ${fmtBalance(PRESENCE_THRESHOLD)} 01PL to unlock Pilot Mode.`}
            </Text>
          </View>
        </View>

        {/* Feature list — eligible */}
        {eligible && (
          <View style={s.presenceFeatureList}>
            <Text style={s.presenceFeatureItem}>◈ Gold accent across app</Text>
            <Text style={s.presenceFeatureItem}>⬡ Dynamic Island agent status</Text>
            <Text style={s.presenceFeatureItem}>◈ PILOT badge on mesh</Text>
            <Text style={s.presenceFeatureItem}>◈ Unlimited Gemini usage</Text>
          </View>
        )}

        {/* Action — not eligible */}
        {!eligible && (
          <View style={s.presenceActionRow}>
            {!coldWallet ? (
              <TouchableOpacity style={s.presenceLinkBtn} onPress={onLinkWallet}>
                <Text style={s.presenceLinkBtnText}>Link wallet to check balance</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={s.presenceLinkBtn}
                onPress={() => Linking.openURL(`https://jup.ag/swap/SOL-${PILOT_TOKEN_MINT}`)}
              >
                <Text style={s.presenceLinkBtnText}>Buy 01PL on Jupiter →</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

// ── Agent Presence Card ────────────────────────────────────────────────────────

function PresenceCard({
  hotWallet,
  coldWallet,
  onLinkWallet,
}: {
  hotWallet: string | null;
  coldWallet: string | null;
  onLinkWallet: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const { eligible, balance, loading, error, refresh } = use01PLGate([hotWallet, coldWallet]);
  const [presenceEnabled, setPresenceEnabled] = useState(false);
  const [hasOverlay, setHasOverlay] = useState(false);
  const [toggling, setToggling] = useState(false);
  const togglingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  // Load saved state + overlay permission on mount and when returning from settings
  const refreshState = useCallback(async () => {
    const [saved, overlay] = await Promise.all([
      AsyncStorage.getItem(PRESENCE_ENABLED_KEY),
      Platform.OS === 'android' ? NodeModule.hasOverlayPermission() : Promise.resolve(false),
    ]);
    if (!mountedRef.current) return;
    setPresenceEnabled(saved === 'true');
    setHasOverlay(overlay as boolean);
  }, []);

  useEffect(() => { refreshState(); }, [refreshState]);

  useEffect(() => {
    // Re-check overlay permission when app comes back from Settings
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') refreshState();
    });
    return () => sub.remove();
  }, [refreshState]);

  const handleToggle = useCallback(async (val: boolean) => {
    if (!eligible) return;
    if (togglingRef.current) return;
    togglingRef.current = true;

    // If enabling and overlay not yet granted, open settings first
    if (val && !hasOverlay) {
      Alert.alert(
        'Allow Overlay',
        'To show your agent bubble on the home screen, grant "Display over other apps" in the next screen.',
        [
          { text: 'Not now', style: 'cancel' },
          {
            text: 'Open settings',
            onPress: async () => {
              await NodeModule.requestOverlayPermission();
              // Permission check happens when AppState returns to 'active'
            },
          },
        ],
      );
      togglingRef.current = false;
      return;
    }

    setToggling(true);
    try {
      await AsyncStorage.setItem(PRESENCE_ENABLED_KEY, val ? 'true' : 'false');
      await NodeModule.setPresenceMode(val);
      setPresenceEnabled(val);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not update presence settings.');
    } finally {
      togglingRef.current = false;
      setToggling(false);
    }
  }, [eligible, hasOverlay]);

  const fmtBalance = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k`
    : n.toFixed(0);

  return (
    <View style={s.presenceSection}>
      <Text style={[s.sectionLabel, { paddingHorizontal: 0, marginBottom: 8 }]}>
        AGENT PRESENCE · 01PL
      </Text>

      <View style={[s.presenceCard, eligible && s.presenceCardEligible]}>
        {/* Header row */}
        <View style={s.presenceTopRow}>
          {eligible ? (
            <View style={s.presenceBadge}>
              <Text style={s.presenceBadgeText}>★ HOLDER</Text>
            </View>
          ) : (
            <View style={[s.presenceBadge, s.presenceBadgeLocked]}>
              <Text style={s.presenceBadgeText}>🔒 01PL EXCLUSIVE</Text>
            </View>
          )}
          {eligible ? (
            <Switch
              value={presenceEnabled}
              onValueChange={handleToggle}
              disabled={toggling}
              trackColor={{ true: colors.green, false: colors.dim }}
              thumbColor="#fff"
            />
          ) : error ? (
            <TouchableOpacity onPress={refresh} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={[s.presenceLockText, { color: '#dc2626' }]}>RPC error · retry ↺</Text>
            </TouchableOpacity>
          ) : (
            <Text style={s.presenceLockText}>
              {loading ? '…' : `${fmtBalance(balance)} / ${fmtBalance(PRESENCE_THRESHOLD)}`}
            </Text>
          )}
        </View>

        {/* Bubble preview + title */}
        <View style={s.presenceHeroRow}>
          {/* Simulated bubble preview */}
          <View style={s.presenceBubblePreview}>
            <View style={s.presenceBubbleRing} />
            <View style={[s.presenceBubbleDot, presenceEnabled && eligible && s.presenceBubbleDotActive]} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.presenceTitle}>
              {eligible ? (presenceEnabled ? 'Companion is live' : 'Digital Companion') : 'Digital Companion'}
            </Text>
            <Text style={s.presenceDesc}>
              {eligible
                ? presenceEnabled
                  ? 'Your agent floats on screen as a bubble — always there, always aware.'
                  : 'Enable to summon your agent avatar anywhere on your device, even when the app is closed.'
                : `Hold ${fmtBalance(PRESENCE_THRESHOLD)} 01PL to unlock your agent as a persistent floating companion.`}
            </Text>
          </View>
        </View>

        {/* What's included — eligible */}
        {eligible && (
          <View style={s.presenceFeatureList}>
            <Text style={s.presenceFeatureItem}>◉ Floating avatar</Text>
            <Text style={s.presenceFeatureItem}>→ Tap to chat</Text>
            <Text style={s.presenceFeatureItem}>✦ Notification actions</Text>
            <Text style={s.presenceFeatureItem}>◈ Unlimited Gemini usage</Text>
          </View>
        )}

        {/* Pilot Mode row — eligible holders only */}
        {eligible && <PilotModeRow />}

        {/* Permission hint */}
        {eligible && presenceEnabled && !hasOverlay && Platform.OS === 'android' && (
          <TouchableOpacity
            style={s.presencePermHint}
            onPress={() => NodeModule.requestOverlayPermission()}
          >
            <Text style={s.presencePermHintText}>
              ⚠ Grant "Display over other apps" to show the bubble →
            </Text>
          </TouchableOpacity>
        )}

        {/* Action row — not eligible */}
        {!eligible && (
          <View style={s.presenceActionRow}>
            {!coldWallet ? (
              <TouchableOpacity style={s.presenceLinkBtn} onPress={onLinkWallet}>
                <Text style={s.presenceLinkBtnText}>{t('you.linkWalletCheck')}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={s.presenceLinkBtn}
                onPress={() => Linking.openURL(
                  `https://jup.ag/swap/SOL-${PILOT_TOKEN_MINT}`,
                )}
              >
                <Text style={s.presenceLinkBtnText}>Buy 01PL on Jupiter →</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>

    </View>
  );
}

import type { Capability, LlmProvider } from '../hooks/useAgentBrain';
import { PROVIDERS as PROVIDER_INFOS } from '../hooks/useAgentBrain';

const PROVIDERS: LlmProvider[] = PROVIDER_INFOS.map(p => p.key);
const PRESET_CAPS: Capability[] = ['summarization', 'qa', 'translation', 'code_review', 'data_analysis'];

const CAPABILITY_DESCRIPTIONS: Record<Capability, string> = {
  summarization: 'Condense long text',
  qa: 'Answer questions accurately',
  translation: 'Translate between languages',
  code_review: 'Review code and suggest improvements',
  data_analysis: 'Analyze datasets and extract insights',
};

// ── Brain Tab ──────────────────────────────────────────────────────────────────

function BrainTab() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const { status, config: nodeConfig, saveConfig, stop, start } = useNode();
  const { config, save, loading } = useAgentBrain();
  const isRunning = status === 'running';

  const [minFee, setMinFee] = useState(String(config?.minFeeUsdc ?? 1.0));
  const [minRep, setMinRep] = useState(String(config?.minReputation ?? 50));
  const [caps, setCaps] = useState<Capability[]>(config?.capabilities ?? []);
  const [autoAccept, setAutoAccept] = useState(config?.autoAccept ?? false);
  const [saving, setSaving] = useState(false);
  const [capModalVisible, setCapModalVisible] = useState(false);
  const [draftCaps, setDraftCaps] = useState<Capability[]>([]);

  useEffect(() => {
    setMinFee(String(config?.minFeeUsdc ?? 1.0));
    setMinRep(String(config?.minReputation ?? 50));
    setCaps(config?.capabilities ?? []);
    setAutoAccept(config?.autoAccept ?? false);
  }, [config?.minFeeUsdc, config?.minReputation, config?.capabilities, config?.autoAccept]);

  const isDirty =
    minFee !== String(config?.minFeeUsdc ?? 1.0) ||
    minRep !== String(config?.minReputation ?? 50) ||
    JSON.stringify(caps) !== JSON.stringify(config?.capabilities ?? []) ||
    autoAccept !== (config?.autoAccept ?? false);

  if (loading) {
    return <View style={s.tabContent}><Text style={s.emptyText}>{t('you.loading')}</Text></View>;
  }

  const handleOpenCapModal = () => {
    setDraftCaps([...caps]);
    setCapModalVisible(true);
  };

  const handleDraftToggle = (cap: Capability) => {
    setDraftCaps(prev =>
      prev.includes(cap) ? prev.filter(c => c !== cap) : [...prev, cap],
    );
  };

  const handleSaveCaps = () => {
    setCaps(draftCaps);
    setCapModalVisible(false);
  };

  const handleSave = async () => {
    if (!config || !save) return;
    setSaving(true);
    try {
      const next = {
        ...config,
        minFeeUsdc: parseFloat(minFee) || 1.0,
        minReputation: parseInt(minRep, 10) || 0,
        capabilities: caps,
        autoAccept,
      };
      await save(next);

      if (isRunning && nodeConfig) {
        try { await stop(); } catch { /* ignore */ }
        try { await start(nodeConfig); } catch { /* ignore */ }
      }
    } catch (e: any) {
      Alert.alert(t('common.error'), e?.message ?? t('you.saveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView style={s.tabContent} contentContainerStyle={{ paddingBottom: 32 }}>
      {/* Rules */}
      <View style={s.ruleRows}>
        <View style={s.ruleRow}>
          <View>
            <Text style={s.ruleLabel}>{t('you.autoAcceptAbove')}</Text>
            <Text style={s.ruleHint}>{t('you.autoAcceptHint')}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ fontSize: 14, color: '#374151', marginRight: 2 }}>$</Text>
            <TextInput
              style={s.ruleInput}
              value={minFee}
              onChangeText={setMinFee}
              keyboardType="decimal-pad"
              selectTextOnFocus
            />
          </View>
        </View>
        <View style={[s.ruleRow, s.ruleRowBorder]}>
          <Text style={s.ruleLabel}>{t('you.minReputation')}</Text>
          <TextInput
            style={s.ruleInput}
            value={minRep}
            onChangeText={setMinRep}
            keyboardType="number-pad"
            selectTextOnFocus
          />
        </View>
        <View style={[s.ruleRow, s.ruleRowBorder]}>
          <View>
            <Text style={s.ruleLabel}>{t('you.autoAcceptJobs')}</Text>
            <Text style={s.ruleHint}>{t('you.autoAcceptJobsDesc')}</Text>
          </View>
          <Switch
            value={autoAccept}
            onValueChange={setAutoAccept}
            trackColor={{ true: colors.green, false: colors.dim }}
            thumbColor="#fff"
          />
        </View>
        <View style={[s.ruleRow, s.ruleRowBorder, { flexDirection: 'column', alignItems: 'flex-start', gap: 8 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
            <Text style={s.ruleLabel}>{t('you.capabilities')}</Text>
            <TouchableOpacity style={s.capPillAdd} onPress={handleOpenCapModal}>
              <Text style={s.capPillAddText}>edit</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {caps.length === 0 && (
              <Text style={s.capPillAddText}>{t('you.noneSelected')}</Text>
            )}
            {caps.map(cap => (
              <View key={cap} style={s.capPill}>
                <Text style={s.capPillText}>{cap}</Text>
              </View>
            ))}
          </View>
        </View>
      </View>

      {/* Save button */}
      <View style={{ paddingHorizontal: 16, marginTop: 20 }}>
        <TouchableOpacity
          style={[s.saveBtn, (!isDirty || saving) && s.btnDisabled]}
          onPress={handleSave}
          disabled={!isDirty || saving}
        >
          <Text style={s.saveBtnText}>{saving ? t('you.saving') : t('you.save')}</Text>
        </TouchableOpacity>
      </View>

      {/* Capability picker modal */}
      <Modal
        visible={capModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setCapModalVisible(false)}
      >
        <View style={s.modalRoot}>
          {/* Handle bar */}
          <View style={s.modalHandleBar} />
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>{t('you.capabilitiesTitle')}</Text>
            <TouchableOpacity onPress={() => setCapModalVisible(false)}>
              <Text style={s.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}>
            <Text style={[s.settingsHint, { marginBottom: 14, marginTop: 8 }]}>
              Toggle the skills your agent will advertise to the mesh.
            </Text>
            {ALL_CAPABILITIES.map((cap, i) => (
              <View key={cap}>
                {i > 0 && <View style={s.settingsCardDivider} />}
                <View style={s.capModalRow}>
                  <View style={{ flex: 1, marginRight: 12 }}>
                    <Text style={s.settingsLabel}>{cap}</Text>
                    <Text style={s.settingsHint}>{CAPABILITY_DESCRIPTIONS[cap]}</Text>
                  </View>
                  <Switch
                    value={draftCaps.includes(cap)}
                    onValueChange={() => handleDraftToggle(cap)}
                    trackColor={{ true: colors.green, false: colors.dim }}
                    thumbColor="#fff"
                  />
                </View>
              </View>
            ))}
          </ScrollView>
          <View style={{ padding: 16, paddingBottom: 32 }}>
            <TouchableOpacity style={s.saveBtn} onPress={handleSaveCaps}>
              <Text style={s.saveBtnText}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

// ── Skills Section ─────────────────────────────────────────────────────────────

function SkillsSection() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const { skills, loading, refresh } = useSkills();
  const { listings, loading: marketplaceLoading } = useSkillMarketplace();
  const [marketplaceVisible, setMarketplaceVisible] = useState(false);
  const [customVisible, setCustomVisible] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const installedNames = useMemo(() => new Set(skills.map(s => s.name)), [skills]);

  const reloadAgent = useCallback(async () => {
    try { await NodeModule.reloadAgent(); } catch { /* agent not running — no-op */ }
  }, []);

  const handleInstallListing = useCallback(async (listing: SkillListing) => {
    if (!listing.url) return;
    setInstalling(listing.name);
    try {
      await skillInstallFromMarketplace(listing);
      await refresh();
      await reloadAgent();
    } catch (e: any) {
      Alert.alert('Install failed', e?.message ?? 'Could not install skill.');
    } finally {
      setInstalling(null);
    }
  }, [refresh, reloadAgent]);

  const handleInstallCustom = useCallback(async () => {
    const name = customName.trim();
    const url = customUrl.trim();
    if (!name || !url) return;
    setInstalling(name);
    try {
      await skillInstallUrl(name, url);
      await refresh();
      await reloadAgent();
      setCustomName('');
      setCustomUrl('');
      setCustomVisible(false);
    } catch (e: any) {
      Alert.alert('Install failed', e?.message ?? 'Could not install skill.');
    } finally {
      setInstalling(null);
    }
  }, [customName, customUrl, refresh, reloadAgent]);

  const handleRemove = useCallback(async (skill: Skill) => {
    Alert.alert(`Remove "${skill.label}"`, t('you.removeCapabilityBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('you.removeCapabilityBtn'), style: 'destructive', onPress: async () => {
          setRemoving(skill.name);
          try {
            await skillRemove(skill.name);
            await refresh();
            await reloadAgent();
          } catch (e: any) {
            Alert.alert('Error', e?.message ?? 'Could not remove skill.');
          } finally {
            setRemoving(null);
          }
        },
      },
    ]);
  }, [refresh, reloadAgent, t]);

  return (
    <>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, marginTop: 18, marginBottom: 6 }}>
        <Text style={[s.settingsSectionLabel, { marginTop: 0, marginBottom: 0 }]}>SKILLS</Text>
        <TouchableOpacity onPress={() => setMarketplaceVisible(true)}>
          <Text style={{ fontSize: 10, color: '#374151', fontWeight: '600' }}>+ Browse</Text>
        </TouchableOpacity>
      </View>

      <View style={s.settingsCard}>
        {loading && <Text style={[s.settingsHint, { padding: 12 }]}>{t('you.loading')}</Text>}
        {!loading && skills.length === 0 && (
          <View style={s.settingsRow}>
            <Text style={s.settingsLabelMuted}>No skills installed</Text>
          </View>
        )}
        {skills.map((skill, i) => (
          <View key={skill.name}>
            {i > 0 && <View style={s.settingsCardDivider} />}
            <View style={[s.settingsRow, { gap: 10 }]}>
              <View style={s.skillIconBox}>
                <Text style={s.skillIconText}>{skill.icon.slice(0, 4)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.settingsLabel}>{skill.label}</Text>
                {skill.description ? (
                  <Text style={s.settingsHint} numberOfLines={2}>{skill.description}</Text>
                ) : null}
              </View>
              <TouchableOpacity
                onPress={() => handleRemove(skill)}
                disabled={removing === skill.name}
                style={{ padding: 4 }}
              >
                <Text style={{ fontSize: 10, color: removing === skill.name ? '#d1d5db' : '#ef4444' }}>
                  {removing === skill.name ? '…' : 'Remove'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </View>

      {/* Marketplace modal */}
      <Modal visible={marketplaceVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setMarketplaceVisible(false)}>
        <View style={s.modalRoot}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>Skill Marketplace</Text>
            <TouchableOpacity onPress={() => setMarketplaceVisible(false)}>
              <Text style={s.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>

          {marketplaceLoading ? (
            <ActivityIndicator style={{ marginTop: 40 }} color="#374151" />
          ) : (
            <FlatList
              data={listings}
              keyExtractor={item => item.name}
              contentContainerStyle={{ padding: 16, gap: 10 }}
              ListFooterComponent={
                <TouchableOpacity
                  style={{ marginTop: 8, paddingVertical: 12, alignItems: 'center' }}
                  onPress={() => { setMarketplaceVisible(false); setCustomVisible(true); }}
                >
                  <Text style={{ fontSize: 12, color: '#9ca3af' }}>Install from URL</Text>
                </TouchableOpacity>
              }
              renderItem={({ item }) => {
                const isInstalled = installedNames.has(item.name);
                const isInstalling = installing === item.name;
                return (
                  <View style={[s.settingsCard, { marginBottom: 0 }]}>
                    <View style={[s.settingsRow, { gap: 10, alignItems: 'flex-start' }]}>
                      <View style={[s.skillIconBox, { marginTop: 2 }]}>
                        <Text style={s.skillIconText}>{item.icon.slice(0, 4)}</Text>
                      </View>
                      <View style={{ flex: 1, gap: 3 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Text style={s.settingsLabel}>{item.label}</Text>
                          <Text style={{ fontSize: 9, color: '#9ca3af', fontFamily: 'monospace' }}>v{item.version}</Text>
                        </View>
                        <Text style={[s.settingsHint, { marginBottom: 6 }]}>{item.description}</Text>
                        <View style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap' }}>
                          {item.tags.slice(0, 3).map(tag => (
                            <View key={tag} style={{ backgroundColor: '#f3f4f6', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1 }}>
                              <Text style={{ fontSize: 9, color: '#6b7280' }}>{tag}</Text>
                            </View>
                          ))}
                        </View>
                      </View>
                      <View style={{ alignItems: 'flex-end', gap: 4, marginTop: 2 }}>
                        {isInstalled ? (
                          <View style={{ backgroundColor: 'rgba(0,230,118,0.08)', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: 'rgba(0,230,118,0.3)' }}>
                            <Text style={{ fontSize: 9, color: '#00e676', fontWeight: '600' }}>INSTALLED</Text>
                          </View>
                        ) : item.url ? (
                          <TouchableOpacity
                            onPress={() => handleInstallListing(item)}
                            disabled={isInstalling}
                            style={{ backgroundColor: isInstalling ? '#f3f4f6' : '#111827', borderRadius: 4, paddingHorizontal: 10, paddingVertical: 4 }}
                          >
                            <Text style={{ fontSize: 10, color: isInstalling ? '#9ca3af' : '#ffffff', fontWeight: '600' }}>
                              {isInstalling ? '…' : 'Install'}
                            </Text>
                          </TouchableOpacity>
                        ) : (
                          <View style={{ backgroundColor: '#f9fafb', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 }}>
                            <Text style={{ fontSize: 9, color: '#9ca3af' }}>built-in</Text>
                          </View>
                        )}
                      </View>
                    </View>
                  </View>
                );
              }}
            />
          )}
        </View>
      </Modal>

      {/* Custom URL install modal */}
      <Modal visible={customVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setCustomVisible(false)}>
        <View style={s.modalRoot}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>Install from URL</Text>
            <TouchableOpacity onPress={() => setCustomVisible(false)}>
              <Text style={s.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <View style={{ padding: 16, gap: 14 }}>
            <Text style={s.settingsHint}>
              Install a custom skill from a SKILL.toml URL. The node downloads and activates it immediately.
            </Text>
            <View style={{ gap: 6 }}>
              <Text style={s.settingsLabel}>{t('you.skillName')}</Text>
              <TextInput
                style={s.advancedInput}
                value={customName}
                onChangeText={setCustomName}
                placeholder="e.g. my-skill"
                placeholderTextColor="#d1d5db"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <View style={{ gap: 6 }}>
              <Text style={s.settingsLabel}>URL</Text>
              <TextInput
                style={s.advancedInput}
                value={customUrl}
                onChangeText={setCustomUrl}
                placeholder="https://example.com/SKILL.toml"
                placeholderTextColor="#d1d5db"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </View>
            <TouchableOpacity
              style={[s.saveBtn, (!customName.trim() || !customUrl.trim() || !!installing) && s.btnDisabled]}
              onPress={handleInstallCustom}
              disabled={!customName.trim() || !customUrl.trim() || !!installing}
            >
              <Text style={s.saveBtnText}>{installing ? 'Installing…' : 'Install'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

// ── Advanced Tab ───────────────────────────────────────────────────────────────

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
  'zerox1:cold_wallet_registered',
  'zerox1:task_log',
];

function PermissionsSection() {
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const [caps, setCaps] = useState<Record<string, boolean>>({});
  const [perms, setPerms] = useState<Record<string, boolean>>({});

  useEffect(() => {
    NodeModule.getBridgeCapabilities().then(setCaps).catch(() => {});
    NodeModule.checkPermissions().then(setPerms).catch(() => {});
  }, []);

  const groupEnabled = useCallback((def: CapDef) =>
    def.caps.every(c => caps[c] !== false), [caps]);

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
    const denied = def.permKeys.filter(k => !perms[k]);
    if (denied.length === 0) { Linking.openSettings(); return; }
    try {
      await NodeModule.requestPermission(denied[0]);
      NodeModule.checkPermissions().then(setPerms).catch(() => {});
    } catch { Linking.openSettings(); }
  }, [perms]);

  return (
    <>
      <Text style={s.settingsSectionLabel}>DATA ACCESS</Text>
      <Text style={s.permSectionHint}>
        Control what your agent can access on this device. Toggle off to revoke access without changing OS permissions.
      </Text>
      <View style={s.settingsCard}>
        {CAP_GROUPS.map((def, i) => {
          const enabled = groupEnabled(def);
          const status = groupPermStatus(def);
          const dotColor = status === 'granted' ? colors.green
            : status === 'partial' ? '#f59e0b'
            : status === 'special' ? colors.sub
            : colors.red;
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
                  trackColor={{ true: colors.green, false: colors.dim }}
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
    </>
  );
}

function AdvancedTab() {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const currentLang = i18n.language;
  const signOut = useSignOut();
  const { config, saveConfig, autoStart, setAutoStart, backgroundNode, setBackgroundNode, status, stop, start } = useNode();
  const [advancedVisible, setAdvancedVisible] = useState(false);

  // ── Identity ──────────────────────────────────────────────────────────────
  const [nameInput, setNameInput] = useState(config?.agentName ?? '');
  const [bioInput, setBioInput] = useState(config?.agentBio ?? '');
  const [avatarUri, setAvatarUri] = useState(config?.agentAvatar ?? '');
  const [identitySaving, setIdentitySaving] = useState(false);

  useEffect(() => {
    setNameInput(config?.agentName ?? '');
    setBioInput(config?.agentBio ?? '');
    setAvatarUri(config?.agentAvatar ?? '');
  }, [config?.agentName, config?.agentBio, config?.agentAvatar]);

  const identityDirty =
    nameInput.trim() !== (config?.agentName ?? '') ||
    bioInput !== (config?.agentBio ?? '') ||
    avatarUri !== (config?.agentAvatar ?? '');

  const handlePickAvatar = async () => {
    const result = await launchImageLibrary({ mediaType: 'photo', quality: 0.8 });
    const uri = result.assets?.[0]?.uri;
    if (uri) setAvatarUri(uri);
  };

  const handleSaveIdentity = async () => {
    if (!config) return;
    setIdentitySaving(true);
    try {
      const updated = {
        ...config,
        ...(nameInput.trim() ? { agentName: nameInput.trim() } : {}),
        agentBio: bioInput.trim(),
        agentAvatar: avatarUri,
      };
      await saveConfig(updated);
      if (status === 'running') {
        try { await stop(); } catch { /* ignore */ }
        try { await start(updated); } catch { /* ignore */ }
      }
    } catch (e: any) {
      Alert.alert(t('common.error'), e?.message ?? t('you.saveError'));
    } finally {
      setIdentitySaving(false);
    }
  };

  const handleLanguageChange = useCallback(async (lang: 'en' | 'zh-CN') => {
    await setLanguage(lang);
  }, []);

  // ── Safety / Emergency contacts ───────────────────────────────────────────
  const [safetyEnabled, setSafetyEnabled] = useState(false);
  const [emergencyContacts, setEmergencyContacts] = useState<EmergencyContact[]>([
    { name: '', phone: '' },
    { name: '', phone: '' },
    { name: '', phone: '' },
  ]);
  const [safetySaving, setSafetySaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [enabledRaw, contactsRaw] = await AsyncStorage.multiGet([
          SAFETY_ENABLED_KEY, EMERGENCY_CONTACTS_KEY,
        ]);
        setSafetyEnabled(enabledRaw[1] === 'true');
        if (contactsRaw[1]) {
          const parsed: EmergencyContact[] = JSON.parse(contactsRaw[1]);
          const padded = [...parsed];
          while (padded.length < 3) padded.push({ name: '', phone: '' });
          setEmergencyContacts(padded.slice(0, 3));
        }
      } catch { /* ignore */ }
    })();
  }, []);

  const handleSaveSafety = useCallback(async () => {
    setSafetySaving(true);
    try {
      const filled = emergencyContacts.filter(c => c.phone.trim().length > 0);
      // Validate phone numbers: must be E.164 format (+<country><number>, 8-15 digits).
      const e164 = /^\+[1-9]\d{6,14}$/;
      const invalid = filled.filter(c => !e164.test(c.phone.trim()));
      if (invalid.length > 0) {
        Alert.alert(
          'Invalid phone number',
          `Phone numbers must be in E.164 format (e.g. +12125551234). Fix: ${invalid.map(c => c.name || c.phone).join(', ')}`,
        );
        return;
      }
      await AsyncStorage.multiSet([
        [SAFETY_ENABLED_KEY, String(safetyEnabled)],
        [EMERGENCY_CONTACTS_KEY, JSON.stringify(filled)],
      ]);
      await NodeModule.saveEmergencyContacts(JSON.stringify(filled));
      await NodeModule.setSafetyEnabled(safetyEnabled);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Failed to save');
    } finally {
      setSafetySaving(false);
    }
  }, [safetyEnabled, emergencyContacts]);

  const updateContact = useCallback((idx: number, field: keyof EmergencyContact, val: string) => {
    setEmergencyContacts(prev => prev.map((c, i) => i === idx ? { ...c, [field]: val } : c));
  }, []);

  const applyAndRestart = useCallback(async (updated: typeof config) => {
    await saveConfig(updated!);
    if (status === 'running') {
      try { await stop(); } catch { /* ignore */ }
      try { await start(updated!); } catch { /* ignore */ }
    }
  }, [saveConfig, status, stop, start, config]);

  const handleAutoStart = useCallback(async (val: boolean) => {
    try { await setAutoStart(val); } catch { /* ignore */ }
  }, [setAutoStart]);

  const handleBackgroundNode = useCallback(async (val: boolean) => {
    try { await setBackgroundNode(val); } catch { /* ignore */ }
  }, [setBackgroundNode]);

  const handleSignOut = useCallback(() => {
    Alert.alert(t('you.signOut'), t('you.signOutBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('you.signOut'), style: 'destructive', onPress: async () => {
          await AsyncStorage.multiRemove(SIGN_OUT_KEYS);
          signOut();
        },
      },
    ]);
  }, [signOut, t]);

  return (
    <ScrollView style={s.tabContent}>
      {/* Identity */}
      <Text style={s.settingsSectionLabel}>IDENTITY</Text>
      <View style={s.settingsCard}>
        <View style={[s.settingsRow, { gap: 12 }]}>
          <TouchableOpacity onPress={handlePickAvatar} activeOpacity={0.8}>
            <View style={s.agentAvatarCircle}>
              <Image source={{ uri: avatarUri || DEFAULT_AGENT_ICON_URI }} style={s.agentAvatarImage} />
            </View>
            <Text style={s.agentAvatarHint}>tap</Text>
          </TouchableOpacity>
          <View style={{ flex: 1, gap: 6 }}>
            <TextInput
              style={s.agentNameInput}
              value={nameInput}
              onChangeText={setNameInput}
              placeholder={t('you.agentNamePlaceholder')}
              placeholderTextColor="#d1d5db"
              maxLength={32}
              returnKeyType="next"
            />
            <TextInput
              style={s.agentBioInput}
              value={bioInput}
              onChangeText={setBioInput}
              placeholder="Short bio…"
              placeholderTextColor="#d1d5db"
              maxLength={120}
              multiline
              numberOfLines={2}
              returnKeyType="done"
            />
            {config?.nodeApiUrl ? (
              <Text style={s.hostedBadge}>HOSTED @ {config.nodeApiUrl}</Text>
            ) : null}
          </View>
        </View>
        {identityDirty && (
          <>
            <View style={s.settingsCardDivider} />
            <TouchableOpacity
              style={[s.settingsRow, { justifyContent: 'center' }]}
              onPress={handleSaveIdentity}
              disabled={identitySaving}
            >
              <Text style={[s.settingsLabel, { color: colors.green }]}>
                {identitySaving ? t('you.saving') : t('you.save')}
              </Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Language */}
      <Text style={s.settingsSectionLabel}>{t('you.language').toUpperCase()}</Text>
      <View style={s.settingsCard}>
        <View style={s.settingsRow}>
          <View style={s.langPills}>
            {(['en', 'zh-CN'] as const).map(lang => (
              <TouchableOpacity
                key={lang}
                style={[s.langPill, currentLang === lang && s.langPillActive]}
                onPress={() => handleLanguageChange(lang)}
              >
                <Text style={[s.langPillText, currentLang === lang && s.langPillTextActive]}>
                  {lang === 'en' ? t('you.langEnglish') : t('you.langChinese')}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>

      {/* Preferences */}
      <Text style={s.settingsSectionLabel}>PREFERENCES</Text>
      <View style={s.settingsCard}>
        <View style={s.settingsRow}>
          <View>
            <Text style={s.settingsLabel}>{t('you.autoStartBoot')}</Text>
            <Text style={s.settingsHint}>{t('you.autoStartBootDesc')}</Text>
          </View>
          <Switch
            value={autoStart}
            onValueChange={handleAutoStart}
            trackColor={{ true: colors.green, false: colors.dim }}
            thumbColor="#fff"
          />
        </View>
        <View style={s.settingsCardDivider} />
        <View style={s.settingsRow}>
          <View>
            <Text style={s.settingsLabel}>Run in background</Text>
            <Text style={s.settingsHint}>{t('you.stayActiveMinimized')}</Text>
          </View>
          <Switch
            value={backgroundNode}
            onValueChange={handleBackgroundNode}
            trackColor={{ true: colors.green, false: colors.dim }}
            thumbColor="#fff"
          />
        </View>
        <View style={s.settingsCardDivider} />
        <View style={[s.settingsRow, s.settingsRowMuted]}>
          <Text style={s.settingsLabelMuted}>{t('you.notifications')}</Text>
          <Text style={s.settingsValueMuted}>coming soon</Text>
        </View>
      </View>

      {/* Safety */}
      <Text style={s.settingsSectionLabel}>SAFETY</Text>
      <View style={s.settingsCard}>
        <View style={s.settingsRow}>
          <View>
            <Text style={s.settingsLabel}>Fall detection</Text>
            <Text style={s.settingsHint}>Agent monitors for falls and alerts contacts</Text>
          </View>
          <Switch
            value={safetyEnabled}
            onValueChange={setSafetyEnabled}
            trackColor={{ true: colors.green, false: colors.dim }}
            thumbColor="#fff"
          />
        </View>
        <View style={s.settingsCardDivider} />
        <View style={[s.settingsRow, { flexDirection: 'column', alignItems: 'flex-start', gap: 2 }]}>
          <Text style={[s.settingsLabel, { marginBottom: 8 }]}>Emergency contacts</Text>
          {emergencyContacts.map((contact, idx) => (
            <View key={idx} style={s.emergencyContactRow}>
              <TextInput
                style={s.emergencyContactName}
                value={contact.name}
                onChangeText={v => updateContact(idx, 'name', v)}
                placeholder={`Contact ${idx + 1} name`}
                placeholderTextColor="#9ca3af"
                maxLength={40}
                returnKeyType="next"
              />
              <TextInput
                style={s.emergencyContactPhone}
                value={contact.phone}
                onChangeText={v => updateContact(idx, 'phone', v)}
                placeholder="+1 555 000 0000"
                placeholderTextColor="#9ca3af"
                keyboardType="phone-pad"
                maxLength={20}
                returnKeyType="done"
              />
            </View>
          ))}
          <Text style={s.settingsHint}>
            30-second confirmation window before alert fires.
            {'\n'}Contacts receive SMS even if they don't have 01 Pilot.
          </Text>
        </View>
        <View style={s.settingsCardDivider} />
        <TouchableOpacity
          style={[s.settingsRow, { justifyContent: 'center' }]}
          onPress={handleSaveSafety}
          disabled={safetySaving}
        >
          <Text style={[s.settingsLabel, { color: colors.green }]}>
            {safetySaving ? 'Saving…' : 'Save safety settings'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Data access / permissions */}
      <PermissionsSection />

      {/* Skills */}
      <SkillsSection />

      {/* More */}
      <Text style={s.settingsSectionLabel}>MORE</Text>
      <View style={s.settingsCard}>
        <TouchableOpacity style={s.settingsRow} onPress={() => setAdvancedVisible(true)}>
          <Text style={s.settingsLabel}>{t('you.advancedSettings')}</Text>
          <Text style={s.settingsValue}>›</Text>
        </TouchableOpacity>
        <View style={s.settingsCardDivider} />
        <TouchableOpacity style={s.settingsRow} onPress={handleSignOut}>
          <Text style={s.signOutText}>{t('you.signOutBtn')}</Text>
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

const CAP_GROUPS_ANDROID: CapDef[] = [
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

const CAP_GROUPS_IOS: CapDef[] = [
  { label: 'Contacts',          hint: 'Read & write address book',                    caps: ['contacts'],                               permKeys: ['contacts'] },
  { label: 'Location',          hint: 'GPS coordinates for context',                  caps: ['location'],                               permKeys: ['location'] },
  { label: 'Calendar',          hint: 'Read & create calendar events',                caps: ['calendar'],                               permKeys: ['calendar'] },
  { label: 'Camera',            hint: 'Take photos on your behalf',                   caps: ['camera'],                                 permKeys: ['camera'] },
  { label: 'Microphone',        hint: 'Record audio for tasks',                       caps: ['microphone'],                             permKeys: ['microphone'] },
  { label: 'Photos',            hint: 'Access photo library',                         caps: ['media'],                                  permKeys: ['photos'] },
  { label: 'Motion & activity', hint: 'Accelerometer, gyro, step detection',          caps: ['motion'],                                 permKeys: ['motion'] },
  { label: 'Health data',       hint: 'Steps, heart rate, sleep, workouts via HealthKit', caps: ['health'],                             permKeys: ['health'] },
  { label: 'Barometer',         hint: 'Atmospheric pressure for environment context', caps: ['motion'],                                 permKeys: [] },
  { label: 'Wearables (BLE)',   hint: 'Connect to Bluetooth health devices',          caps: ['wearables'],                              permKeys: ['bluetooth'] },
  { label: 'Speech synthesis',  hint: 'Speak responses aloud via TTS',               caps: ['tts'],                                    permKeys: [] },
];

const CAP_GROUPS: CapDef[] = Platform.OS === 'ios' ? CAP_GROUPS_IOS : CAP_GROUPS_ANDROID;

// ── About Section (used inside AdvancedModal) ──────────────────────────────────

function AboutSection() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [updateInfo, setUpdateInfo] = useState<import('../native/NodeModule').UpdateInfo | null>(null);
  const [sharingLogs, setSharingLogs] = useState(false);

  const handleShareLogs = useCallback(async () => {
    setSharingLogs(true);
    try {
      const path = await NodeModule.getLogFilePath();
      await Share.share({ url: `file://${path}`, title: '01 Pilot Diagnostic Logs' });
    } catch (e: any) {
      Alert.alert('Logs unavailable', e?.message ?? 'Could not find log file. Start the node first.');
    } finally {
      setSharingLogs(false);
    }
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    setChecking(true);
    setUpdateInfo(null);
    try {
      const info = await NodeModule.checkForUpdate();
      setUpdateInfo(info);
      if (!info.hasUpdate) Alert.alert('Up to date', `You're on the latest version (${info.currentVersion}).`);
    } catch {
      Alert.alert('Error', 'Could not check for updates. Try again later.');
    } finally {
      setChecking(false);
    }
  }, []);

  const handleDownload = useCallback(async () => {
    if (!updateInfo?.downloadUrl) return;
    setDownloading(true);
    setProgress(0);
    const unsub = (require('../native/NodeModule') as typeof import('../native/NodeModule'))
      .onUpdateProgress(({ progress: p }) => setProgress(p));
    try {
      await NodeModule.downloadAndInstall(updateInfo.downloadUrl);
    } catch (e: any) {
      Alert.alert('Download failed', e?.message ?? 'Could not download update.');
    } finally {
      unsub();
      setDownloading(false);
    }
  }, [updateInfo]);

  return (
    <View style={s.settingsCard}>
      <View style={[s.settingsRow, { opacity: 0.6 }]}>
        <Text style={s.settingsLabelMuted}>App</Text>
        <Text style={s.settingsValueMuted}>0x01 Pilot</Text>
      </View>
      <View style={s.settingsCardDivider} />
      <View style={[s.settingsRow, { opacity: 0.6 }]}>
        <Text style={s.settingsLabelMuted}>{t('you.nodeVersion')}</Text>
        <Text style={s.settingsValueMuted}>v0.4.0</Text>
      </View>
      <View style={s.settingsCardDivider} />

      {/* Update checker */}
      {updateInfo?.hasUpdate ? (
        <View style={{ paddingVertical: 12, gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View>
              <Text style={s.settingsLabel}>{t('you.updateAvailable')}</Text>
              <Text style={s.settingsHint}>v{updateInfo.latestVersion} · {new Date(updateInfo.publishedAt).toLocaleDateString()}</Text>
            </View>
            <TouchableOpacity
              style={[s.updateBtn, downloading && s.btnDisabled]}
              onPress={handleDownload}
              disabled={downloading}
            >
              <Text style={s.updateBtnText}>{downloading ? `${progress}%` : 'Install'}</Text>
            </TouchableOpacity>
          </View>
          {downloading && (
            <View style={s.progressTrack}>
              <View style={[s.progressFill, { width: `${progress}%` as any }]} />
            </View>
          )}
          {updateInfo.releaseNotes ? (
            <Text style={s.settingsHint} numberOfLines={3}>{updateInfo.releaseNotes.replace(/#+\s/g, '').slice(0, 200)}</Text>
          ) : null}
        </View>
      ) : (
        <TouchableOpacity style={s.settingsRow} onPress={handleCheckUpdate} disabled={checking}>
          <Text style={s.settingsLabel}>{t('you.checkForUpdate')}</Text>
          <Text style={[s.settingsValue, checking && { color: '#9ca3af' }]}>{checking ? 'Checking…' : '↻'}</Text>
        </TouchableOpacity>
      )}

      {Platform.OS === 'ios' && (
        <>
          <View style={s.settingsCardDivider} />
          <TouchableOpacity style={s.settingsRow} onPress={handleShareLogs} disabled={sharingLogs}>
            <Text style={s.settingsLabel}>Share Diagnostic Logs</Text>
            <Text style={[s.settingsValue, sharingLogs && { color: '#9ca3af' }]}>{sharingLogs ? '…' : '↑'}</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

function AdvancedModal({ visible, onClose, config, applyAndRestart }: {
  visible: boolean;
  onClose: () => void;
  config: any;
  applyAndRestart: (cfg: any) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const { config: brain, save: saveBrain } = useAgentBrain();
  const [relayAddr, setRelayAddr] = useState(config?.relayAddr ?? '');
  const [rpcUrl, setRpcUrl] = useState(config?.rpcUrl ?? '');
  const [brainEnabled, setBrainEnabled] = useState(brain?.enabled ?? false);

  // LLM config state
  const [llmProvider, setLlmProvider] = useState<LlmProvider>(brain?.provider ?? 'default');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmBaseUrl, setLlmBaseUrl] = useState(brain?.customBaseUrl ?? '');
  const [llmModel, setLlmModel] = useState(brain?.customModel ?? '');
  const [llmSaving, setLlmSaving] = useState(false);

  // Video generation API key state
  const [falApiKey, setFalApiKey] = useState('');
  const [falSaving, setFalSaving] = useState(false);
  const [replicateApiKey, setReplicateApiKey] = useState('');
  const [replicateSaving, setReplicateSaving] = useState(false);
  const [moltbookSaving, setMoltbookSaving] = useState(false);
  const [moltbookError, setMoltbookError] = useState('');
  const [neynarApiKey, setNeynarApiKey] = useState('');
  const [farcasterSignerUuid, setFarcasterSignerUuid] = useState('');
  const [farcasterFid, setFarcasterFid] = useState(brain?.farcasterFid ?? '');
  const [farcasterSaving, setFarcasterSaving] = useState(false);

  // Skill env vars
  const [skillEnvVarKeys, setSkillEnvVarKeys] = useState<string[]>(brain?.skillEnvVarKeys ?? []);
  const [envVarKey, setEnvVarKey] = useState('');
  const [envVarValue, setEnvVarValue] = useState('');
  const [envVarSaving, setEnvVarSaving] = useState(false);

  // Load bridge capabilities and permission statuses when modal opens
  useEffect(() => {
    if (!visible) return;
    setRelayAddr(config?.relayAddr ?? '');
    setRpcUrl(config?.rpcUrl ?? '');
    setBrainEnabled(brain?.enabled ?? false);
    setLlmProvider(brain?.provider ?? 'default');
    setLlmApiKey('');
    setFalApiKey('');
    setReplicateApiKey('');
    setLlmBaseUrl(brain?.customBaseUrl ?? '');
    setLlmModel(brain?.customModel ?? '');
  }, [visible, config?.relayAddr, config?.rpcUrl, brain?.enabled, brain?.provider, brain?.customBaseUrl, brain?.customModel]);

  const handleSaveLlm = useCallback(async () => {
    if (!brain || !saveBrain) return;
    setLlmSaving(true);
    try {
      if (llmProvider === 'default') {
        await clearLlmApiKey();
        await saveBrain({
          ...brain,
          provider: llmProvider,
          customBaseUrl: '',
          customModel: '',
          apiKeySet: false,
        });
      } else {
        if (llmApiKey.trim()) await saveLlmApiKey(llmApiKey.trim());
        await saveBrain({
          ...brain,
          provider: llmProvider,
          customBaseUrl: llmBaseUrl.trim(),
          customModel: llmModel.trim(),
          apiKeySet: llmApiKey.trim() ? true : brain.apiKeySet,
        });
      }
      await applyAndRestart({ ...config, agentBrainProvider: llmProvider });
      setLlmApiKey('');
      Alert.alert('Saved', 'LLM settings updated. Agent restarting.');
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Failed to save LLM settings.');
    } finally {
      setLlmSaving(false);
    }
  }, [brain, saveBrain, llmProvider, llmApiKey, llmBaseUrl, llmModel, config, applyAndRestart]);

  const handleSaveFal = useCallback(async () => {
    if (!falApiKey.trim()) return;
    if (!brain || !saveBrain) return;
    setFalSaving(true);
    try {
      await saveFalApiKey(falApiKey.trim());
      await saveBrain({ ...brain, falApiKeySet: true });
      setFalApiKey('');
      Alert.alert('Saved', 'fal.ai API key stored. Agent restarting.');
      await applyAndRestart(config);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Failed to save fal.ai API key.');
    } finally {
      setFalSaving(false);
    }
  }, [brain, saveBrain, falApiKey, config, applyAndRestart]);

  const handleSaveReplicate = useCallback(async () => {
    if (!replicateApiKey.trim()) return;
    if (!brain || !saveBrain) return;
    setReplicateSaving(true);
    try {
      await saveReplicateApiKey(replicateApiKey.trim());
      await saveBrain({ ...brain, replicateApiKeySet: true });
      setReplicateApiKey('');
      Alert.alert('Saved', 'Replicate API key stored. Agent restarting.');
      await applyAndRestart(config);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Failed to save Replicate API key.');
    } finally {
      setReplicateSaving(false);
    }
  }, [brain, saveBrain, replicateApiKey, config, applyAndRestart]);

  const handleConnectMoltbook = useCallback(async () => {
    if (!brain || !saveBrain) return;
    setMoltbookSaving(true);
    setMoltbookError('');
    try {
      const rawName = config?.agentName ?? 'agent';
      // Sanitize to MoltBook-safe username: lowercase, alphanumeric + underscores, max 30 chars.
      const moltName = rawName
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/, '')
        .slice(0, 30) || 'agent';

      const resp = await fetch('https://www.moltbook.com/api/v1/agents/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: moltName,
          description: config?.agentBio || 'Autonomous AI agent on the 0x01 network.',
          capabilities: ['text_generation', 'conversation'],
          model_provider: 'custom',
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error ?? `Registration failed (${resp.status})`);
      }
      // API returns the key under one of these fields depending on version.
      const apiKey = data.api_key ?? data.token ?? data.key ?? data.data?.api_key;
      if (!apiKey) throw new Error('No API key returned — try again');
      await saveMoltbookApiKey(apiKey);
      await saveBrain({
        ...brain,
        moltbookApiKeySet: true,
        moltbookRegisteredName: moltName,
        moltbookPendingClaim: {
          claimUrl: data.agent?.claim_url ?? '',
          tweetTemplate: data.tweet_template ?? '',
          registeredName: moltName,
          apiKey,
        },
      });
    } catch (e: any) {
      setMoltbookError(e.message ?? 'Connection failed — check your internet and try again');
    } finally {
      setMoltbookSaving(false);
    }
  }, [brain, saveBrain, config]);

  const handleDisconnectMoltbook = useCallback(async () => {
    if (!brain || !saveBrain) return;
    await clearMoltbookApiKey();
    await saveBrain({
      ...brain,
      moltbookApiKeySet: false,
      moltbookRegisteredName: undefined,
      moltbookPendingClaim: undefined,
    });
  }, [brain, saveBrain]);

  const handleSaveFarcaster = useCallback(async () => {
    if (!brain || !saveBrain) return;
    setFarcasterSaving(true);
    try {
      const updates: Record<string, unknown> = {};
      if (neynarApiKey.trim()) {
        await saveNeynarApiKey(neynarApiKey.trim());
        updates.neynarApiKeySet = true;
        setNeynarApiKey('');
      }
      if (farcasterSignerUuid.trim()) {
        await saveFarcasterSignerUuid(farcasterSignerUuid.trim());
        updates.farcasterSignerSet = true;
        setFarcasterSignerUuid('');
      }
      if (farcasterFid.trim()) {
        await saveFarcasterFid(farcasterFid.trim());
        updates.farcasterFid = farcasterFid.trim();
      }
      if (Object.keys(updates).length > 0) {
        await saveBrain({ ...brain, ...updates });
        Alert.alert('Saved', 'Farcaster settings stored. Agent restarting.');
        await applyAndRestart(config);
      }
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Failed to save Farcaster settings.');
    } finally {
      setFarcasterSaving(false);
    }
  }, [brain, saveBrain, neynarApiKey, farcasterSignerUuid, farcasterFid, config, applyAndRestart]);

  const handleAddEnvVar = useCallback(async () => {
    const k = envVarKey.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const v = envVarValue.trim();
    if (!k || !v || !brain || !saveBrain) return;
    setEnvVarSaving(true);
    try {
      await NodeModule.saveSkillEnvVar(k, v);
      const updated = skillEnvVarKeys.includes(k) ? skillEnvVarKeys : [...skillEnvVarKeys, k];
      setSkillEnvVarKeys(updated);
      await saveBrain({ ...brain, skillEnvVarKeys: updated });
      setEnvVarKey('');
      setEnvVarValue('');
      Alert.alert('Saved', `${k} stored. Agent restarting.`);
      await applyAndRestart(config);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Failed to save env var.');
    } finally {
      setEnvVarSaving(false);
    }
  }, [envVarKey, envVarValue, brain, saveBrain, skillEnvVarKeys, config, applyAndRestart]);

  const handleRemoveEnvVar = useCallback(async (key: string) => {
    if (!brain || !saveBrain) return;
    try {
      await NodeModule.removeSkillEnvVar(key);
      const updated = skillEnvVarKeys.filter(k => k !== key);
      setSkillEnvVarKeys(updated);
      await saveBrain({ ...brain, skillEnvVarKeys: updated });
      await applyAndRestart(config);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Failed to remove env var.');
    }
  }, [brain, saveBrain, skillEnvVarKeys, config, applyAndRestart]);

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
          <Text style={s.modalTitle}>{t('you.advanced')}</Text>
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
                <Text style={s.settingsLabel}>{t('you.enableBrain')}</Text>
                <Text style={s.settingsHint}>AI autonomously takes and completes jobs</Text>
              </View>
              <Switch value={brainEnabled} onValueChange={handleBrainToggle}
                trackColor={{ true: colors.green, false: colors.dim }} thumbColor="#fff" />
            </View>
          </View>

          {/* LLM credentials */}
          <Text style={s.settingsSectionLabel}>LLM PROVIDER & CREDENTIALS</Text>
          <View style={s.settingsCard}>
            {/* Provider pills */}
            <View style={[s.settingsRow, { flexDirection: 'column', alignItems: 'flex-start', gap: 8, paddingBottom: 14 }]}>
              <Text style={s.settingsLabel}>{t('you.provider')}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {PROVIDERS.map(p => {
                  const active = llmProvider === p;
                  const label = PROVIDER_INFOS.find(info => info.key === p)?.label ?? p;
                  return (
                    <TouchableOpacity
                      key={p}
                      style={[s.providerPill, active && s.providerPillActive]}
                      onPress={() => setLlmProvider(p)}
                    >
                      <Text style={[s.providerPillText, active && s.providerPillTextActive]}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            <View style={s.settingsCardDivider} />
            {llmProvider === 'default' ? (
              /* Default — no API key needed */
              <View style={[s.settingsRow, { paddingBottom: 14 }]}>
                <Text style={[s.settingsHint, { flex: 1 }]}>
                  No API key needed. Your agent uses the built-in AI — just launch your token and start earning jobs.
                </Text>
              </View>
            ) : (
              <>
                {/* API key */}
                <View style={[s.settingsRow, { flexDirection: 'column', alignItems: 'flex-start', gap: 6, paddingBottom: 14 }]}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%' }}>
                    <Text style={s.settingsLabel}>API key</Text>
                    <Text style={s.settingsHint}>{brain?.apiKeySet ? 'key stored ●●●●' : 'not set'}</Text>
                  </View>
                  <TextInput
                    style={s.advancedInput}
                    value={llmApiKey}
                    onChangeText={setLlmApiKey}
                    placeholder={brain?.apiKeySet ? 'Enter new key to replace…' : 'sk-…'}
                    placeholderTextColor="#d1d5db"
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
                {/* Model override */}
                <View style={s.settingsCardDivider} />
                <View style={[s.settingsRow, { flexDirection: 'column', alignItems: 'flex-start', gap: 6, paddingBottom: 14 }]}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%' }}>
                    <Text style={s.settingsLabel}>{t('you.model')}</Text>
                    <Text style={s.settingsHint}>
                      default: {PROVIDER_INFOS.find(p => p.key === llmProvider)?.model ?? '—'}
                    </Text>
                  </View>
                  <TextInput
                    style={s.advancedInput}
                    value={llmModel}
                    onChangeText={setLlmModel}
                    placeholder={PROVIDER_INFOS.find(p => p.key === llmProvider)?.model ?? 'model name'}
                    placeholderTextColor="#d1d5db"
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                  />
                </View>
              </>
            )}
            {/* Base URL — only for custom provider */}
            {llmProvider === 'custom' && (
              <>
                <View style={s.settingsCardDivider} />
                <View style={[s.settingsRow, { flexDirection: 'column', alignItems: 'flex-start', gap: 6, paddingBottom: 14 }]}>
                  <Text style={s.settingsLabel}>{t('you.baseUrl')}</Text>
                  <TextInput
                    style={s.advancedInput}
                    value={llmBaseUrl}
                    onChangeText={setLlmBaseUrl}
                    placeholder="https://api.openai.com/v1"
                    placeholderTextColor="#d1d5db"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              </>
            )}
          </View>
          <TouchableOpacity
            style={[s.saveBtn, llmSaving && s.btnDisabled]}
            onPress={handleSaveLlm}
            disabled={llmSaving}
          >
            <Text style={s.saveBtnText}>{llmSaving ? 'Saving…' : 'Save LLM settings'}</Text>
          </TouchableOpacity>

          {/* Video generation keys */}
          <Text style={s.settingsSectionLabel}>VIDEO GENERATION</Text>
          <View style={s.settingsCard}>
            {/* fal.ai */}
            <View style={[s.settingsRow, { flexDirection: 'column', alignItems: 'flex-start', gap: 6, paddingBottom: 14 }]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%' }}>
                <Text style={s.settingsLabel}>fal.ai API key</Text>
                <Text style={s.settingsHint}>{brain?.falApiKeySet ? 'key stored ●●●●' : 'not set'}</Text>
              </View>
              <TextInput
                style={s.advancedInput}
                value={falApiKey}
                onChangeText={setFalApiKey}
                placeholder={brain?.falApiKeySet ? 'Enter new key to replace…' : 'fal-…'}
                placeholderTextColor="#d1d5db"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <View style={s.settingsCardDivider} />
            {/* Replicate */}
            <View style={[s.settingsRow, { flexDirection: 'column', alignItems: 'flex-start', gap: 6, paddingBottom: 14 }]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%' }}>
                <Text style={s.settingsLabel}>{t('you.replicateApiKey')}</Text>
                <Text style={s.settingsHint}>{brain?.replicateApiKeySet ? 'key stored ●●●●' : 'not set'}</Text>
              </View>
              <TextInput
                style={s.advancedInput}
                value={replicateApiKey}
                onChangeText={setReplicateApiKey}
                placeholder={brain?.replicateApiKeySet ? 'Enter new key to replace…' : 'r8_…'}
                placeholderTextColor="#d1d5db"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 0 }}>
            <TouchableOpacity
              style={[s.saveBtn, { flex: 1 }, (falSaving || !falApiKey.trim()) && s.btnDisabled]}
              onPress={handleSaveFal}
              disabled={falSaving || !falApiKey.trim()}
            >
              <Text style={s.saveBtnText}>{falSaving ? 'Saving…' : 'Save fal.ai'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.saveBtn, { flex: 1 }, (replicateSaving || !replicateApiKey.trim()) && s.btnDisabled]}
              onPress={handleSaveReplicate}
              disabled={replicateSaving || !replicateApiKey.trim()}
            >
              <Text style={s.saveBtnText}>{replicateSaving ? 'Saving…' : 'Save Replicate'}</Text>
            </TouchableOpacity>
          </View>

          {/* MoltBook */}
          <Text style={s.settingsSectionLabel}>MOLTBOOK</Text>
          {brain?.moltbookApiKeySet ? (
            <>
              <View style={s.settingsCard}>
                <View style={s.settingsRow}>
                  <Text style={s.settingsLabel}>Connected as</Text>
                  <Text style={s.settingsHint}>{brain.moltbookRegisteredName ?? config?.agentName ?? 'Agent'}</Text>
                </View>
              </View>
              <Text style={[s.settingsHint, { marginBottom: 8 }]}>
                {brain?.moltbookPendingClaim
                  ? 'Registered but not yet active — follow the steps in Chat to complete setup.'
                  : 'Your agent is active on MoltBook and can post in communities like m/ai and m/solana.'}
              </Text>
              <TouchableOpacity
                style={[s.saveBtn, { backgroundColor: '#374151' }]}
                onPress={handleDisconnectMoltbook}
              >
                <Text style={s.saveBtnText}>Disconnect</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={[s.settingsHint, { marginBottom: 12 }]}>
                MoltBook is a social network built for AI agents. Connect to let your agent post, comment, and build a presence in communities like m/ai and m/solana.
              </Text>
              <TouchableOpacity
                style={[s.saveBtn, moltbookSaving && s.btnDisabled]}
                onPress={handleConnectMoltbook}
                disabled={moltbookSaving}
              >
                <Text style={s.saveBtnText}>{moltbookSaving ? 'Connecting…' : 'Connect to MoltBook'}</Text>
              </TouchableOpacity>
              {moltbookError ? (
                <Text style={{ color: '#ef4444', fontSize: 12, marginTop: 6 }}>{moltbookError}</Text>
              ) : null}
            </>
          )}

          {/* Farcaster */}
          <Text style={s.settingsSectionLabel}>FARCASTER</Text>
          <View style={s.settingsCard}>
            <View style={[s.settingsRow, { flexDirection: 'column', alignItems: 'flex-start', gap: 6, paddingBottom: 14 }]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%' }}>
                <Text style={s.settingsLabel}>Neynar API key</Text>
                <Text style={s.settingsHint}>{brain?.neynarApiKeySet ? 'key stored ●●●●' : 'not set'}</Text>
              </View>
              <TextInput
                style={s.advancedInput}
                value={neynarApiKey}
                onChangeText={setNeynarApiKey}
                placeholder={brain?.neynarApiKeySet ? 'Enter new key to replace…' : 'NEYNAR_…'}
                placeholderTextColor="#d1d5db"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <View style={s.settingsCardDivider} />
            <View style={[s.settingsRow, { flexDirection: 'column', alignItems: 'flex-start', gap: 6, paddingBottom: 14 }]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%' }}>
                <Text style={s.settingsLabel}>Managed signer UUID</Text>
                <Text style={s.settingsHint}>{brain?.farcasterSignerSet ? 'stored ●●●●' : 'not set'}</Text>
              </View>
              <TextInput
                style={s.advancedInput}
                value={farcasterSignerUuid}
                onChangeText={setFarcasterSignerUuid}
                placeholder={brain?.farcasterSignerSet ? 'Enter new UUID to replace…' : 'xxxxxxxx-xxxx-…'}
                placeholderTextColor="#d1d5db"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <View style={s.settingsCardDivider} />
            <View style={[s.settingsRow, { flexDirection: 'column', alignItems: 'flex-start', gap: 6 }]}>
              <Text style={s.settingsLabel}>FID (Farcaster ID)</Text>
              <TextInput
                style={s.advancedInput}
                value={farcasterFid}
                onChangeText={setFarcasterFid}
                placeholder="e.g. 123456"
                placeholderTextColor="#d1d5db"
                keyboardType="numeric"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </View>
          <Text style={[s.settingsHint, { marginBottom: 8 }]}>
            Get your API key and signer UUID from neynar.com. Your FID is your numeric Farcaster identity.
          </Text>
          <TouchableOpacity
            style={[s.saveBtn, farcasterSaving && s.btnDisabled]}
            onPress={handleSaveFarcaster}
            disabled={farcasterSaving}
          >
            <Text style={s.saveBtnText}>{farcasterSaving ? 'Saving…' : 'Save Farcaster'}</Text>
          </TouchableOpacity>

          {/* Skill environment variables */}
          <Text style={s.settingsSectionLabel}>SKILL ENV VARS</Text>
          {skillEnvVarKeys.length > 0 && (
            <View style={[s.settingsCard, { marginBottom: 8 }]}>
              {skillEnvVarKeys.map((k, i) => (
                <View key={k}>
                  {i > 0 && <View style={s.settingsCardDivider} />}
                  <View style={[s.settingsRow, { paddingVertical: 10 }]}>
                    <Text style={[s.settingsLabel, { flex: 1, fontFamily: 'monospace', fontSize: 11 }]}>{k}</Text>
                    <Text style={[s.settingsHint, { marginRight: 12 }]}>●●●●</Text>
                    <TouchableOpacity onPress={() => handleRemoveEnvVar(k)}>
                      <Text style={{ fontSize: 12, color: '#ef4444' }}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          )}
          <View style={s.settingsCard}>
            <View style={[s.settingsRow, { flexDirection: 'column', alignItems: 'flex-start', gap: 6, paddingBottom: 10 }]}>
              <Text style={s.settingsLabel}>Variable name</Text>
              <TextInput
                style={s.advancedInput}
                value={envVarKey}
                onChangeText={t => setEnvVarKey(t.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                placeholder="MY_API_KEY"
                placeholderTextColor="#d1d5db"
                autoCapitalize="characters"
                autoCorrect={false}
              />
            </View>
            <View style={s.settingsCardDivider} />
            <View style={[s.settingsRow, { flexDirection: 'column', alignItems: 'flex-start', gap: 6 }]}>
              <Text style={s.settingsLabel}>Value</Text>
              <TextInput
                style={s.advancedInput}
                value={envVarValue}
                onChangeText={setEnvVarValue}
                placeholder="sk-…"
                placeholderTextColor="#d1d5db"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </View>
          <Text style={[s.settingsHint, { marginBottom: 8 }]}>
            Any skill that uses ${'{VAR_NAME}'} in its curl commands will receive the value. Stored in the device keychain — never leaves the device.
          </Text>
          <TouchableOpacity
            style={[s.saveBtn, (envVarSaving || !envVarKey.trim() || !envVarValue.trim()) && s.btnDisabled]}
            onPress={handleAddEnvVar}
            disabled={envVarSaving || !envVarKey.trim() || !envVarValue.trim()}
          >
            <Text style={s.saveBtnText}>{envVarSaving ? 'Saving…' : 'Add variable'}</Text>
          </TouchableOpacity>

          {/* Network */}
          <Text style={s.settingsSectionLabel}>NETWORK</Text>
          <View style={s.settingsCard}>
            <View style={[s.settingsRow, { flexDirection: 'column', alignItems: 'flex-start', gap: 6 }]}>
              <Text style={s.settingsLabel}>{t('you.relayAddress')}</Text>
              <TextInput style={s.advancedInput} value={relayAddr} onChangeText={setRelayAddr}
                placeholder="/ip4/…/p2p/…" placeholderTextColor="#d1d5db"
                autoCapitalize="none" autoCorrect={false} />
            </View>
            <View style={s.settingsCardDivider} />
            <View style={[s.settingsRow, { flexDirection: 'column', alignItems: 'flex-start', gap: 6 }]}>
              <Text style={s.settingsLabel}>{t('you.solanaRpcUrl')}</Text>
              <TextInput style={s.advancedInput} value={rpcUrl} onChangeText={setRpcUrl}
                placeholder="https://api.mainnet-beta.solana.com" placeholderTextColor="#d1d5db"
                autoCapitalize="none" autoCorrect={false} />
            </View>
          </View>

          {/* About */}
          <Text style={s.settingsSectionLabel}>ABOUT</Text>
          <AboutSection />

          {/* Legal */}
          <Text style={s.settingsSectionLabel}>LEGAL</Text>
          <View style={s.settingsCard}>
            {[
              { label: 'Terms of Service',       url: 'https://0x01.world/terms' },
              { label: 'Privacy Policy',          url: 'https://0x01.world/privacy' },
              { label: 'Open-Source Licenses',   url: 'https://0x01.world/licenses' },
              { label: 'Cookie Policy',           url: 'https://0x01.world/cookies' },
              { label: 'Risk Disclosure',         url: 'https://0x01.world/risk' },
              { label: 'Regulatory Notice',       url: 'https://0x01.world/regulatory' },
            ].map(({ label, url }, i) => (
              <View key={label}>
                {i > 0 && <View style={s.settingsCardDivider} />}
                <TouchableOpacity style={s.settingsRow} onPress={() => Linking.openURL(url)}>
                  <Text style={s.settingsLabel}>{label}</Text>
                  <Text style={s.settingsValue}>↗</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>

          <TouchableOpacity
            style={[s.saveBtn, { backgroundColor: '#374151', marginBottom: 0 }]}
            onPress={() => applyAndRestart(config!)}
          >
            <Text style={s.saveBtnText}>↺  Restart Node</Text>
          </TouchableOpacity>

          <TouchableOpacity style={s.saveBtn} onPress={handleSaveNetwork}>
            <Text style={s.saveBtnText}>{t('you.saveApply')}</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    header: { paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
    statusDot: { width: 7, height: 7, borderRadius: 3.5 },
    title: { fontSize: 16, fontWeight: '700', color: colors.text },
    segmented: { flexDirection: 'row', borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: 'hidden' },
    segment: { flex: 1, padding: 6, alignItems: 'center' },
    segmentActive: { backgroundColor: colors.text },
    segmentText: { fontSize: 10, color: colors.sub },
    segmentTextActive: { color: colors.bg, fontWeight: '600' },

    tabContent: { flex: 1 },

    // Node tab — Start/Stop button
    startStopWrapper: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
    startStopBtn: {
      width: '100%',
      height: 44,
      borderRadius: 10,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
    },
    startStopBtnStart: { backgroundColor: colors.green },
    startStopBtnStop: { backgroundColor: colors.red + '18', borderWidth: 1, borderColor: colors.red + '60' },
    startStopBtnStarting: { backgroundColor: colors.input },
    startStopTextStart: { fontSize: 13, fontWeight: '700', color: colors.bg, letterSpacing: 0.5 },
    startStopTextStop: { fontSize: 13, fontWeight: '700', color: colors.red, letterSpacing: 0.5 },
    startStopTextStarting: { fontSize: 13, fontWeight: '600', color: colors.dim, letterSpacing: 0.5 },

    nodeStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
    nodeStatusDot: { width: 7, height: 7, borderRadius: 4 },
    nodeStatusText: { fontSize: 10, color: colors.sub },

    hostedBadge: { fontSize: 9, color: colors.sub, marginTop: 2 },

    // Wallet
    balanceHero: { alignItems: 'center', paddingTop: 24, paddingBottom: 16 },
    balanceLabel: { fontSize: 10, color: colors.dim, letterSpacing: 0.5, marginBottom: 6 },
    balanceAmount: { fontSize: 34, fontWeight: '700', color: colors.text, letterSpacing: -1 },
    balanceDelta: { fontSize: 10, color: colors.green, marginTop: 4 },
    balanceEmpty: { fontSize: 11, color: colors.dim, marginTop: 6 },

    addressCard: {
      marginHorizontal: 16, backgroundColor: colors.card,
      borderRadius: 10, padding: 10, marginBottom: 12,
    },
    addressRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5 },
    addressDivider: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
    addressLabel: { fontSize: 10, color: colors.sub, fontWeight: '600' },
    addressValue: { fontSize: 9, color: colors.sub, fontFamily: 'monospace' },
    addressValueMuted: { fontSize: 9, color: colors.dim },
    greenDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.green },
    amberDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.amber },
    walletDescText: { fontSize: 11, color: colors.dim, marginTop: 2 },

    walletActions: { flexDirection: 'row', gap: 6, paddingHorizontal: 16, marginBottom: 4 },
    howItWorksCard: { marginHorizontal: 16, marginBottom: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12 },
    howItWorksTitle: { fontSize: 9, color: colors.dim, letterSpacing: 0.5, marginBottom: 4 },
    howItWorksBody: { fontSize: 12, color: colors.sub, lineHeight: 18 },
    sweepBtn: { flex: 1, backgroundColor: colors.text, borderRadius: 9, padding: 10, alignItems: 'center' },
    sweepBtnText: { fontSize: 11, color: colors.bg, fontWeight: '600' },
    historyBtn: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 9, padding: 10, alignItems: 'center' },
    historyBtnText: { fontSize: 11, color: colors.sub, fontWeight: '500' },
    btnDisabled: { opacity: 0.4 },

    sectionLabel: { fontSize: 10, color: colors.dim, letterSpacing: 0.5, marginBottom: 8 },
    emptyText: { fontSize: 14, color: colors.dim, textAlign: 'center', paddingVertical: 24, paddingHorizontal: 16 },

    txRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 16 },
    txRowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
    txTitle: { fontSize: 11, color: colors.text },
    txTime: { fontSize: 9, color: colors.dim, marginTop: 1 },
    txAmountPos: { fontSize: 12, color: colors.green, fontWeight: '600' },
    txAmountNeg: { fontSize: 12, color: colors.sub, fontWeight: '600' },

    modalRoot: { flex: 1, backgroundColor: colors.bg },
    modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
    modalTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
    modalClose: { fontSize: 16, color: colors.dim },
    modalHandleBar: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginTop: 10, marginBottom: 4 },

    // Capability modal row
    capModalRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },

    // Agent
    agentIdentitySection: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, paddingBottom: 8 },
    agentAvatarCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.green + '18', borderWidth: 2, borderColor: colors.green + '50', overflow: 'hidden' },
    agentAvatarImage: { width: 56, height: 56 },
    agentAvatarHint: { fontSize: 9, color: colors.dim, textAlign: 'center', marginTop: 3 },
    agentIdentityInfo: { flex: 1 },
    agentNameInput: { fontSize: 16, fontWeight: '700', color: colors.text, padding: 0 },
    agentBioInput: { fontSize: 12, color: colors.sub, padding: 0, lineHeight: 18 },
    agentStatusText: { fontSize: 10, color: colors.green },

    ruleRows: { paddingHorizontal: 16 },
    ruleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 },
    ruleRowBorder: { borderTopWidth: 1, borderTopColor: colors.border },
    ruleLabel: { fontSize: 11, color: colors.text, fontWeight: '500' },
    ruleHint: { fontSize: 10, color: colors.dim, marginTop: 1 },
    ruleInput: { fontSize: 13, fontWeight: '700', color: colors.text, textAlign: 'right', minWidth: 60 },
    ruleValue: { fontSize: 11, color: colors.dim },

    capPill: { backgroundColor: colors.input, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 3 },
    capPillText: { fontSize: 9, color: colors.sub, fontWeight: '500' },
    capPillAdd: { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 3 },
    capPillAddText: { fontSize: 9, color: colors.dim },
    walletOptionBtn: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12 },
    walletOptionLabel: { fontSize: 12, fontWeight: '600', color: colors.text, marginBottom: 2 },
    providerPill: { borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
    providerPillActive: { backgroundColor: colors.text, borderColor: colors.text },
    providerPillText: { fontSize: 10, color: colors.sub, fontWeight: '500' },
    providerPillTextActive: { color: colors.bg },

    // Settings / Advanced tab
    settingsSectionLabel: { fontSize: 10, color: colors.dim, letterSpacing: 0.5, marginBottom: 6, marginTop: 18, paddingHorizontal: 16 },
    settingsCard: { marginHorizontal: 16, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14 },
    settingsCardDivider: { height: 1, backgroundColor: colors.border },
    settingsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 },
    settingsRowMuted: { opacity: 0.5 },
    settingsLabel: { fontSize: 11, color: colors.text, fontWeight: '500' },
    settingsHint: { fontSize: 9, color: colors.dim, marginTop: 1 },
    settingsLabelMuted: { fontSize: 11, color: colors.dim },
    settingsValue: { fontSize: 11, color: colors.dim },
    settingsValueMuted: { fontSize: 11, color: colors.dim },
    signOutText: { fontSize: 11, color: colors.red, fontWeight: '500' },
    emergencyContactRow: { flexDirection: 'row', gap: 8, width: '100%', marginBottom: 6 },
    emergencyContactName: { flex: 1, fontSize: 11, color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 7 },
    emergencyContactPhone: { flex: 1, fontSize: 11, color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 7 },

    avatarPickerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
    settingsAvatarCircle: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.green + '18', borderWidth: 1, borderColor: colors.green + '50', overflow: 'hidden' },
    settingsAvatarImage: { width: 44, height: 44 },
    avatarPickerInfo: { flex: 1 },
    nameInput: { fontSize: 11, color: colors.text, textAlign: 'right', flex: 1, marginLeft: 16 },
    advancedInput: { fontSize: 11, color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 7, paddingHorizontal: 10, paddingVertical: 7, width: '100%' },
    permRight: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    permDot: { width: 6, height: 6, borderRadius: 3 },
    permLabel: { fontSize: 9, color: colors.dim, fontWeight: '500' },
    permSectionHint: { fontSize: 10, color: colors.dim, marginHorizontal: 16, marginTop: -4, marginBottom: 8, lineHeight: 14 },
    capRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 10 },
    capSwitch: { transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] },
    capInfo: { flex: 1 },
    capLabelOff: { color: colors.dim },
    saveBtn: { backgroundColor: colors.text, borderRadius: 10, padding: 13, alignItems: 'center', marginTop: 24, marginBottom: 8 },
    saveBtnText: { fontSize: 12, color: colors.bg, fontWeight: '600' },

    skillIconBox: { width: 34, height: 34, borderRadius: 8, backgroundColor: colors.input, alignItems: 'center', justifyContent: 'center' },
    skillIconText: { fontSize: 7, fontWeight: '700', color: colors.sub, letterSpacing: 0.2 },

    holdingsRow: { flexDirection: 'row', gap: 6, marginTop: 6, flexWrap: 'wrap' },
    holdingsPill: { fontSize: 10, color: colors.sub, backgroundColor: colors.input, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },

    updateBtn: { backgroundColor: colors.text, borderRadius: 7, paddingHorizontal: 12, paddingVertical: 6 },
    updateBtnText: { fontSize: 10, color: colors.bg, fontWeight: '600' },
    progressTrack: { height: 3, backgroundColor: colors.input, borderRadius: 2, overflow: 'hidden' },
    progressFill: { height: 3, backgroundColor: colors.green, borderRadius: 2 },

    langPills: { flexDirection: 'row', gap: 6 },
    langPill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, backgroundColor: colors.input },
    langPillActive: { backgroundColor: colors.text },
    langPillText: { fontSize: 11, color: colors.sub, fontWeight: '600' },
    langPillTextActive: { color: colors.bg },

    // ── Agent Presence card ───────────────────────────────────────────────────
    presenceSection: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8 },
    presenceCard: {
      borderRadius: 14, borderWidth: 1, borderColor: colors.border,
      backgroundColor: colors.card, padding: 14,
    },
    presenceCardEligible: {
      backgroundColor: colors.green + '18', borderColor: colors.green + '50',
    },
    presenceTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
    presenceBadge: {
      backgroundColor: colors.text, borderRadius: 5,
      paddingHorizontal: 7, paddingVertical: 3,
    },
    presenceBadgeLocked: { backgroundColor: colors.sub },
    presenceBadgeText: { fontSize: 8, color: colors.bg, fontWeight: '700', letterSpacing: 0.8 },
    presenceLockText: { fontSize: 11, color: colors.dim, fontWeight: '600' },

    presenceHeroRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 2 },
    presenceBubblePreview: {
      width: 44, height: 44, borderRadius: 22,
      backgroundColor: colors.card, borderWidth: 2, borderColor: colors.green + '50',
      alignItems: 'center', justifyContent: 'center',
      shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 6,
      elevation: 3,
    },
    presenceBubbleRing: {
      width: 24, height: 24, borderRadius: 12,
      backgroundColor: colors.green + '30', borderWidth: 1.5, borderColor: colors.green + '70',
    },
    presenceBubbleDot: {
      position: 'absolute', bottom: 2, right: 2,
      width: 10, height: 10, borderRadius: 5,
      backgroundColor: colors.border, borderWidth: 1.5, borderColor: colors.card,
    },
    presenceBubbleDotActive: { backgroundColor: colors.green },

    presenceTitle: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: 4 },
    presenceDesc: { fontSize: 12, color: colors.sub, lineHeight: 17 },
    presenceActionRow: { marginTop: 12 },
    presenceLinkBtn: {
      borderWidth: 1, borderColor: colors.border, borderRadius: 8,
      paddingVertical: 8, paddingHorizontal: 12, alignSelf: 'flex-start',
    },
    presenceLinkBtnText: { fontSize: 11, color: colors.sub, fontWeight: '600' },
    presenceFeatureList: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
    presenceFeatureItem: {
      fontSize: 10, color: colors.green, fontWeight: '600',
      backgroundColor: colors.green + '20', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3,
    },
    pilotModeRow: {
      flexDirection: 'row', alignItems: 'center', marginTop: 14,
      paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border,
    },
    pilotModeLabel: { fontSize: 12, fontWeight: '700', color: colors.text },
    pilotModeHint: { fontSize: 10, color: colors.sub, marginTop: 1 },
    presencePermHint: {
      marginTop: 10, backgroundColor: colors.amber + '18', borderRadius: 8,
      paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderColor: colors.amber + '60',
    },
    presencePermHintText: { fontSize: 11, color: colors.amber },
  });
}
