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
import { useAgentBrain, saveLlmApiKey, saveFalApiKey, saveReplicateApiKey, ALL_CAPABILITIES } from '../hooks/useAgentBrain';
import {
  useHotKeyBalance, useTaskLog, sweepSol,
  useSkills, skillInstallUrl, skillRemove, useSolPrice, useDexPrices,
  type Skill,
} from '../hooks/useNodeApi';
import { useSignOut } from '../../App';
import { DEFAULT_AGENT_ICON_URI } from '../assets/defaultAgentIcon';
import { setLanguage } from '../i18n';
import { use01PLGate, PRESENCE_THRESHOLD, PILOT_TOKEN_MINT } from '../hooks/use01PLGate';
import { useTheme, PILOT_ACCENT } from '../theme/ThemeContext';

const COLD_WALLET_KEY = 'zerox1:cold_wallet';
const PRESENCE_ENABLED_KEY = 'zerox1:presence_enabled';
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
  const [tab, setTab] = useState<SubTab>('Wallet');
  const { t } = useTranslation();
  const { status } = useNode();
  const isRunning = status === 'running';

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + 14 }]}>
        <View style={s.titleRow}>
          <Text style={s.title}>{t('you.title')}</Text>
          <View style={[s.statusDot, { backgroundColor: isRunning ? '#22c55e' : '#d1d5db' }]} />
        </View>
        <View style={s.segmented}>
          {(['Wallet', 'Brain', 'Advanced'] as SubTab[]).map(tabKey => (
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
      {tab === 'Brain' && <BrainTab />}
      {tab === 'Advanced' && <AdvancedTab />}
    </View>
  );
}

// ── Wallet Tab ─────────────────────────────────────────────────────────────────

function WalletTab() {
  const { t } = useTranslation();
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



  // Two-step wallet linking: 'address' → enter address, 'verify' → sign challenge
  const [linkStep, setLinkStep] = useState<'address' | 'verify'>('address');
  const [verifyChallenge, setVerifyChallenge] = useState('');
  const [sigInput, setSigInput] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [copiedChallenge, setCopiedChallenge] = useState(false);

  const handleNextStep = useCallback(() => {
    const addr = walletInput.trim();
    if (!addr) return;
    const { PublicKey } = require('@solana/web3.js');
    try { new PublicKey(addr); } catch {
      Alert.alert('Invalid address', 'Please enter a valid Solana wallet address.');
      return;
    }
    const nonce = Array.from({ length: 8 }, () =>
      Math.floor(Math.random() * 256).toString(16).padStart(2, '0'),
    ).join('');
    setVerifyChallenge(`01pilot wallet verification: ${nonce}`);
    setSigInput('');
    setLinkStep('verify');
  }, [walletInput]);

  const handleCopyChallenge = useCallback(() => {
    require('react-native').Clipboard.setString(verifyChallenge);
    setCopiedChallenge(true);
    setTimeout(() => setCopiedChallenge(false), 2000);
  }, [verifyChallenge]);

  const handleVerifyAndLink = useCallback(async () => {
    if (!walletInput.trim() || !sigInput.trim() || !verifyChallenge) return;
    setVerifying(true);
    try {
      const { ed25519 } = require('@noble/curves/ed25519');
      const bs58 = require('bs58');
      const pubKeyBytes: Uint8Array = bs58.decode(walletInput.trim());
      const sigBytes: Uint8Array = bs58.decode(sigInput.trim());
      const msgBytes = new TextEncoder().encode(verifyChallenge);
      const valid = ed25519.verify(sigBytes, msgBytes, pubKeyBytes);
      if (!valid) {
        Alert.alert(t('you.verifyFailed'), t('you.verifyFailedBody'));
        return;
      }
      await AsyncStorage.setItem(COLD_WALLET_KEY, walletInput.trim());
      setColdWallet(walletInput.trim());
      setWalletInput('');
      setSigInput('');
      setVerifyChallenge('');
      setLinkStep('address');
      setLinkWalletVisible(false);
    } catch (e: any) {
      Alert.alert(t('you.verifyFailed'), e?.message ?? t('you.verifyFailedBody'));
    } finally {
      setVerifying(false);
    }
  }, [walletInput, sigInput, verifyChallenge, t]);

  const [phantomConnecting, setPhantomConnecting] = useState(false);

  const handleOpenPhantom = useCallback(async () => {
    setPhantomConnecting(true);
    try {
      const { transact } = require('@solana-mobile/mobile-wallet-adapter-protocol-web3js');
      // MWA authorize requires the user to physically unlock their wallet — that IS ownership proof.
      // Save directly; no additional challenge-signing needed for MWA path.
      const address: string = await transact(async (wallet: any) => {
        const { accounts } = await wallet.authorize({
          cluster: 'mainnet-beta',
          identity: { name: '01 Pilot', uri: 'https://0x01.world' },
        });
        const { PublicKey } = require('@solana/web3.js');
        const addrBytes = new Uint8Array([...atob(accounts[0].address)].map(c => c.charCodeAt(0)));
        return new PublicKey(addrBytes).toBase58();
      });
      await AsyncStorage.setItem(COLD_WALLET_KEY, address);
      setColdWallet(address);
      setLinkWalletVisible(false);
    } catch (e: any) {
      const msg: string = e?.message ?? '';
      if (msg.includes('No wallet') || msg.includes('not found') || msg.includes('SolanaMobileWalletAdapterWalletNotInstalledError')) {
        Alert.alert(t('you.phantomNotInstalled'), t('you.phantomInstallHint'));
      }
    } finally {
      setPhantomConnecting(false);
    }
  }, [t]);

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
          onPress={coldWallet ? handleUnlinkWallet : () => setLinkWalletVisible(true)}
        >
          <View>
            <Text style={s.addressLabel}>{t('you.personalWalletTitle')}</Text>
            <Text style={s.walletDescText}>{t('you.personalWalletDesc')}</Text>
          </View>
          {coldWallet ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View style={s.greenDot} />
              <Text style={s.addressValue}>
                {`${coldWallet.slice(0, 4)}…${coldWallet.slice(-4)}`}
              </Text>
            </View>
          ) : (
            <Text style={[s.addressValueMuted, { color: '#374151' }]}>{t('you.linkWallet')}</Text>
          )}
        </TouchableOpacity>
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

      {/* Link wallet modal */}
      <Modal visible={linkWalletVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { setLinkWalletVisible(false); setLinkStep('address'); setWalletInput(''); setSigInput(''); }}>
        <View style={s.modalRoot}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>
              {linkStep === 'address' ? t('you.linkColdWallet') : t('you.verifyOwnershipTitle')}
            </Text>
            <TouchableOpacity onPress={() => { setLinkWalletVisible(false); setLinkStep('address'); setWalletInput(''); setSigInput(''); }}>
              <Text style={s.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>

          {linkStep === 'address' ? (
            <View style={{ padding: 16, gap: 14 }}>
              <Text style={s.settingsHint}>{t('you.coldWalletHint')}</Text>

              {/* Wallet app option — MWA authorize proves ownership; save directly */}
              {Platform.OS === 'android' && (
                <>
                  <TouchableOpacity
                    style={[s.walletOptionBtn, phantomConnecting && s.btnDisabled]}
                    onPress={handleOpenPhantom}
                    disabled={phantomConnecting}
                  >
                    <View>
                      <Text style={s.walletOptionLabel}>
                        {phantomConnecting ? t('you.connecting') : t('you.openPhantom')}
                      </Text>
                      <Text style={s.settingsHint}>{t('you.connectHint')}</Text>
                    </View>
                    <Text style={s.settingsValue}>{phantomConnecting ? '…' : '↗'}</Text>
                  </TouchableOpacity>

                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={{ flex: 1, height: 1, backgroundColor: '#f3f4f6' }} />
                    <Text style={{ fontSize: 9, color: '#9ca3af' }}>OR</Text>
                    <View style={{ flex: 1, height: 1, backgroundColor: '#f3f4f6' }} />
                  </View>
                </>
              )}

              {/* Address input */}
              <View style={{ gap: 8 }}>
                <Text style={s.settingsLabel}>{t('you.pasteAddress')}</Text>
                <TextInput
                  style={s.advancedInput}
                  value={walletInput}
                  onChangeText={setWalletInput}
                  placeholder={t('you.walletInputPlaceholder')}
                  placeholderTextColor="#d1d5db"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              <TouchableOpacity
                style={[s.saveBtn, !walletInput.trim() && s.btnDisabled]}
                onPress={handleNextStep}
                disabled={!walletInput.trim()}
              >
                <Text style={s.saveBtnText}>{t('you.nextBtn')}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={{ padding: 16, gap: 14 }}>
              <Text style={s.settingsHint}>{t('you.verifyOwnershipHint')}</Text>

              {/* Challenge box */}
              <View style={{ backgroundColor: '#f9fafb', borderRadius: 8, padding: 12, gap: 8 }}>
                <Text style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }} selectable>
                  {verifyChallenge}
                </Text>
                <TouchableOpacity onPress={handleCopyChallenge}>
                  <Text style={{ fontSize: 12, color: copiedChallenge ? '#10b981' : '#6366f1' }}>
                    {copiedChallenge ? t('you.copied') : t('you.copyChallenge')}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Signature input */}
              <View style={{ gap: 8 }}>
                <Text style={s.settingsLabel}>Signature</Text>
                <TextInput
                  style={s.advancedInput}
                  value={sigInput}
                  onChangeText={setSigInput}
                  placeholder={t('you.signaturePlaceholder')}
                  placeholderTextColor="#d1d5db"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              <TouchableOpacity
                style={[s.saveBtn, (!sigInput.trim() || verifying) && s.btnDisabled]}
                onPress={handleVerifyAndLink}
                disabled={!sigInput.trim() || verifying}
              >
                <Text style={s.saveBtnText}>
                  {verifying ? t('you.verifying') : t('you.verifyAndLink')}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={() => { setLinkStep('address'); setSigInput(''); }}>
                <Text style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>
                  {t('you.backToAddress')}
                </Text>
              </TouchableOpacity>
            </View>
          )}
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
  const { pilotMode, setPilotMode } = useTheme();
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
  const { pilotMode, setPilotMode } = useTheme();

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
              trackColor={{ true: '#22c55e', false: '#d1d5db' }}
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

      if (isRunning) {
        try { await stop(); } catch { /* ignore */ }
        try { await start(nodeConfig!); } catch { /* ignore */ }
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
          <TextInput
            style={s.ruleInput}
            value={minFee}
            onChangeText={setMinFee}
            keyboardType="decimal-pad"
            selectTextOnFocus
          />
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
            trackColor={{ true: '#22c55e', false: '#d1d5db' }}
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
                    trackColor={{ true: '#22c55e', false: '#d1d5db' }}
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
  const { skills, loading, refresh } = useSkills();
  const [installVisible, setInstallVisible] = useState(false);
  const [skillName, setSkillName] = useState('');
  const [skillUrl, setSkillUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const handleInstall = useCallback(async () => {
    const name = skillName.trim();
    const url = skillUrl.trim();
    if (!name || !url) return;
    setInstalling(true);
    try {
      await skillInstallUrl(name, url);
      await refresh();
      setSkillName('');
      setSkillUrl('');
      setInstallVisible(false);
    } catch (e: any) {
      Alert.alert('Install failed', e?.message ?? 'Could not install skill.');
    } finally {
      setInstalling(false);
    }
  }, [skillName, skillUrl, refresh]);

  const handleRemove = useCallback(async (skill: Skill) => {
    Alert.alert(`Remove "${skill.label}"`, t('you.removeCapabilityBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('you.removeCapabilityBtn'), style: 'destructive', onPress: async () => {
          setRemoving(skill.name);
          try {
            await skillRemove(skill.name);
            await refresh();
          } catch (e: any) {
            Alert.alert('Error', e?.message ?? 'Could not remove skill.');
          } finally {
            setRemoving(null);
          }
        },
      },
    ]);
  }, [refresh, t]);

  return (
    <>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, marginTop: 18, marginBottom: 6 }}>
        <Text style={[s.settingsSectionLabel, { marginTop: 0, marginBottom: 0 }]}>SKILLS</Text>
        <TouchableOpacity onPress={() => setInstallVisible(true)}>
          <Text style={{ fontSize: 10, color: '#374151', fontWeight: '600' }}>+ Install</Text>
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

      {/* Install modal */}
      <Modal visible={installVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setInstallVisible(false)}>
        <View style={s.modalRoot}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>{t('you.installSkill')}</Text>
            <TouchableOpacity onPress={() => setInstallVisible(false)}>
              <Text style={s.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <View style={{ padding: 16, gap: 14 }}>
            <Text style={s.settingsHint}>
              Install a custom skill from a URL. The node downloads and sandboxes it — your agent gains the new capability immediately.
            </Text>
            <View style={{ gap: 6 }}>
              <Text style={s.settingsLabel}>{t('you.skillName')}</Text>
              <TextInput
                style={s.advancedInput}
                value={skillName}
                onChangeText={setSkillName}
                placeholder="e.g. my-skill"
                placeholderTextColor="#d1d5db"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <View style={{ gap: 6 }}>
              <Text style={s.settingsLabel}>{t('you.skillUrl')}</Text>
              <TextInput
                style={s.advancedInput}
                value={skillUrl}
                onChangeText={setSkillUrl}
                placeholder="https://example.com/my-skill.wasm"
                placeholderTextColor="#d1d5db"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </View>
            <TouchableOpacity
              style={[s.saveBtn, (!skillName.trim() || !skillUrl.trim() || installing) && s.btnDisabled]}
              onPress={handleInstall}
              disabled={!skillName.trim() || !skillUrl.trim() || installing}
            >
              <Text style={s.saveBtnText}>{installing ? 'Installing…' : t('you.installSkill')}</Text>
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
  'zerox1:task_log',
];

function AdvancedTab() {
  const { t, i18n } = useTranslation();
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
              <Text style={[s.settingsLabel, { color: '#22c55e' }]}>
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
            trackColor={{ true: '#22c55e', false: '#d1d5db' }}
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
            trackColor={{ true: '#22c55e', false: '#d1d5db' }}
            thumbColor="#fff"
          />
        </View>
        <View style={s.settingsCardDivider} />
        <View style={[s.settingsRow, s.settingsRowMuted]}>
          <Text style={s.settingsLabelMuted}>{t('you.notifications')}</Text>
          <Text style={s.settingsValueMuted}>coming soon</Text>
        </View>
      </View>

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
  { label: 'Notifications',     hint: 'Deliver & categorise notifications',           caps: ['notifications_read'],                     permKeys: ['notifications_read'] },
  { label: 'Contacts',          hint: 'Read & write address book',                    caps: ['contacts'],                               permKeys: ['contacts'] },
  { label: 'Location',          hint: 'GPS coordinates for context',                  caps: ['location'],                               permKeys: ['location'] },
  { label: 'Calendar',          hint: 'Read & create calendar events',                caps: ['calendar'],                               permKeys: ['calendar'] },
  { label: 'Camera',            hint: 'Take photos on your behalf',                   caps: ['camera'],                                 permKeys: ['camera'] },
  { label: 'Microphone',        hint: 'Record audio for tasks',                       caps: ['microphone'],                             permKeys: ['microphone'] },
  { label: 'Photos',            hint: 'Access photo library',                         caps: ['media'],                                  permKeys: ['photos'] },
  { label: 'Motion & activity', hint: 'Accelerometer, gyro, step detection',          caps: ['motion'],                                 permKeys: ['motion'] },
  { label: 'Health data',       hint: 'Steps, heart rate, sleep, workouts via HealthKit', caps: ['health'],                             permKeys: ['health'] },
  { label: 'Clinical records',  hint: 'Read medical records from Health app',         caps: ['health','clinical_records'],              permKeys: ['health'] },
  { label: 'Barometer',         hint: 'Atmospheric pressure for environment context', caps: ['motion'],                                 permKeys: [] },
  { label: 'Wearables (BLE)',   hint: 'Connect to Bluetooth health devices',          caps: ['wearables'],                              permKeys: ['bluetooth'] },
  { label: 'Speech synthesis',  hint: 'Speak responses aloud via TTS',               caps: ['tts'],                                    permKeys: [] },
  { label: 'Live Activities',   hint: 'Show agent status on Lock Screen & Dynamic Island', caps: ['live_activity'],                     permKeys: [] },
];

const CAP_GROUPS: CapDef[] = Platform.OS === 'ios' ? CAP_GROUPS_IOS : CAP_GROUPS_ANDROID;

// ── About Section (used inside AdvancedModal) ──────────────────────────────────

function AboutSection() {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [updateInfo, setUpdateInfo] = useState<import('../native/NodeModule').UpdateInfo | null>(null);

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
  const { config: brain, save: saveBrain } = useAgentBrain();
  const [relayAddr, setRelayAddr] = useState(config?.relayAddr ?? '');
  const [rpcUrl, setRpcUrl] = useState(config?.rpcUrl ?? '');
  const [brainEnabled, setBrainEnabled] = useState(brain?.enabled ?? false);
  const [caps, setCaps] = useState<Record<string, boolean>>({});
  const [perms, setPerms] = useState<Record<string, boolean>>({});

  // LLM config state
  const [llmProvider, setLlmProvider] = useState<LlmProvider>(brain?.provider ?? 'openai');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmBaseUrl, setLlmBaseUrl] = useState(brain?.customBaseUrl ?? '');
  const [llmModel, setLlmModel] = useState(brain?.customModel ?? '');
  const [llmSaving, setLlmSaving] = useState(false);

  // Video generation API key state
  const [falApiKey, setFalApiKey] = useState('');
  const [falSaving, setFalSaving] = useState(false);
  const [replicateApiKey, setReplicateApiKey] = useState('');
  const [replicateSaving, setReplicateSaving] = useState(false);

  // Load bridge capabilities and permission statuses when modal opens
  useEffect(() => {
    if (!visible) return;
    setRelayAddr(config?.relayAddr ?? '');
    setRpcUrl(config?.rpcUrl ?? '');
    setBrainEnabled(brain?.enabled ?? false);
    setLlmProvider(brain?.provider ?? 'openai');
    setLlmApiKey('');
    setFalApiKey('');
    setReplicateApiKey('');
    setLlmBaseUrl(brain?.customBaseUrl ?? '');
    setLlmModel(brain?.customModel ?? '');
    NodeModule.getBridgeCapabilities().then(setCaps).catch(() => {});
    NodeModule.checkPermissions().then(setPerms).catch(() => {});
  }, [visible, config?.relayAddr, config?.rpcUrl, brain?.enabled, brain?.provider, brain?.customBaseUrl, brain?.customModel]);

  const handleSaveLlm = useCallback(async () => {
    if (!brain || !saveBrain) return;
    setLlmSaving(true);
    try {
      if (llmApiKey.trim()) await saveLlmApiKey(llmApiKey.trim());
      await saveBrain({
        ...brain,
        provider: llmProvider,
        customBaseUrl: llmBaseUrl.trim(),
        customModel: llmModel.trim(),
        apiKeySet: llmApiKey.trim() ? true : brain.apiKeySet,
      });
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
                trackColor={{ true: '#22c55e', false: '#d1d5db' }} thumbColor="#fff" />
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
                  return (
                    <TouchableOpacity
                      key={p}
                      style={[s.providerPill, active && s.providerPillActive]}
                      onPress={() => setLlmProvider(p)}
                    >
                      <Text style={[s.providerPillText, active && s.providerPillTextActive]}>{p}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            <View style={s.settingsCardDivider} />
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
            {/* Model override — available for all providers */}
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

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  header: { paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  statusDot: { width: 7, height: 7, borderRadius: 3.5 },
  title: { fontSize: 16, fontWeight: '700', color: '#111' },
  segmented: { flexDirection: 'row', borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 8, overflow: 'hidden' },
  segment: { flex: 1, padding: 6, alignItems: 'center' },
  segmentActive: { backgroundColor: '#111' },
  segmentText: { fontSize: 10, color: '#6b7280' },
  segmentTextActive: { color: '#fff', fontWeight: '600' },

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
  startStopBtnStart: { backgroundColor: '#22c55e' },
  startStopBtnStop: { backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#fca5a5' },
  startStopBtnStarting: { backgroundColor: '#f3f4f6' },
  startStopTextStart: { fontSize: 13, fontWeight: '700', color: '#fff', letterSpacing: 0.5 },
  startStopTextStop: { fontSize: 13, fontWeight: '700', color: '#dc2626', letterSpacing: 0.5 },
  startStopTextStarting: { fontSize: 13, fontWeight: '600', color: '#9ca3af' },

  nodeStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  nodeStatusDot: { width: 7, height: 7, borderRadius: 4 },
  nodeStatusText: { fontSize: 10, color: '#6b7280' },

  hostedBadge: { fontSize: 9, color: '#6b7280', marginTop: 2 },

  // Wallet
  balanceHero: { alignItems: 'center', paddingTop: 24, paddingBottom: 16 },
  balanceLabel: { fontSize: 10, color: '#9ca3af', letterSpacing: 0.5, marginBottom: 6 },
  balanceAmount: { fontSize: 34, fontWeight: '700', color: '#111', letterSpacing: -1 },
  balanceDelta: { fontSize: 10, color: '#22c55e', marginTop: 4 },
  balanceEmpty: { fontSize: 11, color: '#9ca3af', marginTop: 6 },

  addressCard: {
    marginHorizontal: 16, backgroundColor: '#f9fafb',
    borderRadius: 10, padding: 10, marginBottom: 12,
  },
  addressRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5 },
  addressDivider: { height: 1, backgroundColor: '#e5e7eb', marginVertical: 4 },
  addressLabel: { fontSize: 10, color: '#6b7280', fontWeight: '600' },
  addressValue: { fontSize: 9, color: '#374151', fontFamily: 'monospace' },
  addressValueMuted: { fontSize: 9, color: '#9ca3af' },
  greenDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#22c55e' },
  walletDescText: { fontSize: 11, color: '#9ca3af', marginTop: 2 },

  walletActions: { flexDirection: 'row', gap: 6, paddingHorizontal: 16, marginBottom: 4 },
  sweepBtn: { flex: 1, backgroundColor: '#111', borderRadius: 9, padding: 10, alignItems: 'center' },
  sweepBtnText: { fontSize: 11, color: '#fff', fontWeight: '600' },
  historyBtn: { flex: 1, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 9, padding: 10, alignItems: 'center' },
  historyBtnText: { fontSize: 11, color: '#374151', fontWeight: '500' },
  btnDisabled: { opacity: 0.4 },

  sectionLabel: { fontSize: 10, color: '#9ca3af', letterSpacing: 0.5, marginBottom: 8 },
  emptyText: { fontSize: 14, color: '#9ca3af', textAlign: 'center', paddingVertical: 24, paddingHorizontal: 16 },

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
  modalHandleBar: { width: 36, height: 4, borderRadius: 2, backgroundColor: '#e5e7eb', alignSelf: 'center', marginTop: 10, marginBottom: 4 },

  // Capability modal row
  capModalRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },

  // Agent
  agentIdentitySection: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, paddingBottom: 8 },
  agentAvatarCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#f0fdf4', borderWidth: 2, borderColor: '#bbf7d0', overflow: 'hidden' },
  agentAvatarImage: { width: 56, height: 56 },
  agentAvatarHint: { fontSize: 9, color: '#9ca3af', textAlign: 'center', marginTop: 3 },
  agentIdentityInfo: { flex: 1 },
  agentNameInput: { fontSize: 16, fontWeight: '700', color: '#111', padding: 0 },
  agentBioInput: { fontSize: 12, color: '#374151', padding: 0, lineHeight: 18 },
  agentStatusText: { fontSize: 10, color: '#22c55e' },

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

  // Settings / Advanced tab
  settingsSectionLabel: { fontSize: 10, color: '#9ca3af', letterSpacing: 0.5, marginBottom: 6, marginTop: 18, paddingHorizontal: 16 },
  settingsCard: { marginHorizontal: 16, backgroundColor: '#fff', borderWidth: 1, borderColor: '#f3f4f6', borderRadius: 12, paddingHorizontal: 14 },
  settingsCardDivider: { height: 1, backgroundColor: '#f3f4f6' },
  settingsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 },
  settingsRowMuted: { opacity: 0.5 },
  settingsLabel: { fontSize: 11, color: '#111', fontWeight: '500' },
  settingsHint: { fontSize: 9, color: '#9ca3af', marginTop: 1 },
  settingsLabelMuted: { fontSize: 11, color: '#9ca3af' },
  settingsValue: { fontSize: 11, color: '#9ca3af' },
  settingsValueMuted: { fontSize: 11, color: '#9ca3af' },
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

  skillIconBox: { width: 34, height: 34, borderRadius: 8, backgroundColor: '#f3f4f6', alignItems: 'center', justifyContent: 'center' },
  skillIconText: { fontSize: 7, fontWeight: '700', color: '#374151', letterSpacing: 0.2 },

  holdingsRow: { flexDirection: 'row', gap: 6, marginTop: 6, flexWrap: 'wrap' },
  holdingsPill: { fontSize: 10, color: '#6b7280', backgroundColor: '#f3f4f6', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },

  updateBtn: { backgroundColor: '#111', borderRadius: 7, paddingHorizontal: 12, paddingVertical: 6 },
  updateBtnText: { fontSize: 10, color: '#fff', fontWeight: '600' },
  progressTrack: { height: 3, backgroundColor: '#f3f4f6', borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: 3, backgroundColor: '#22c55e', borderRadius: 2 },

  langPills: { flexDirection: 'row', gap: 6 },
  langPill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, backgroundColor: '#f3f4f6' },
  langPillActive: { backgroundColor: '#111' },
  langPillText: { fontSize: 11, color: '#6b7280', fontWeight: '600' },
  langPillTextActive: { color: '#fff' },

  // ── Agent Presence card ───────────────────────────────────────────────────
  presenceSection: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8 },
  presenceCard: {
    borderRadius: 14, borderWidth: 1, borderColor: '#e5e7eb',
    backgroundColor: '#f9fafb', padding: 14,
  },
  presenceCardEligible: {
    backgroundColor: '#f0fdf4', borderColor: '#bbf7d0',
  },
  presenceTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  presenceBadge: {
    backgroundColor: '#111', borderRadius: 5,
    paddingHorizontal: 7, paddingVertical: 3,
  },
  presenceBadgeLocked: { backgroundColor: '#6b7280' },
  presenceBadgeText: { fontSize: 8, color: '#fff', fontWeight: '700', letterSpacing: 0.8 },
  presenceLockText: { fontSize: 11, color: '#9ca3af', fontWeight: '600' },

  presenceHeroRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 2 },
  presenceBubblePreview: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: '#fff', borderWidth: 2, borderColor: '#bbf7d0',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 6,
    elevation: 3,
  },
  presenceBubbleRing: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: '#dcfce7', borderWidth: 1.5, borderColor: '#86efac',
  },
  presenceBubbleDot: {
    position: 'absolute', bottom: 2, right: 2,
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: '#d1d5db', borderWidth: 1.5, borderColor: '#fff',
  },
  presenceBubbleDotActive: { backgroundColor: '#22c55e' },

  presenceTitle: { fontSize: 14, fontWeight: '700', color: '#111', marginBottom: 4 },
  presenceDesc: { fontSize: 12, color: '#6b7280', lineHeight: 17 },
  presenceActionRow: { marginTop: 12 },
  presenceLinkBtn: {
    borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8,
    paddingVertical: 8, paddingHorizontal: 12, alignSelf: 'flex-start',
  },
  presenceLinkBtnText: { fontSize: 11, color: '#374151', fontWeight: '600' },
  presenceFeatureList: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  presenceFeatureItem: {
    fontSize: 10, color: '#16a34a', fontWeight: '600',
    backgroundColor: '#dcfce7', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3,
  },
  pilotModeRow: {
    flexDirection: 'row', alignItems: 'center', marginTop: 14,
    paddingTop: 12, borderTopWidth: 1, borderTopColor: '#e5e7eb',
  },
  pilotModeLabel: { fontSize: 12, fontWeight: '700', color: '#111827' },
  pilotModeHint: { fontSize: 10, color: '#6b7280', marginTop: 1 },
  presencePermHint: {
    marginTop: 10, backgroundColor: '#fffbeb', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderColor: '#fde68a',
  },
  presencePermHintText: { fontSize: 11, color: '#92400e' },
});
