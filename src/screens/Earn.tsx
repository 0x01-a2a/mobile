/**
 * Earn — bounty feed.
 *
 * Listens for incoming PROPOSE envelopes, shows them as actionable bounty
 * cards. User picks which agent handles the task, ACCEPT is sent, then
 * the app routes to Chat with the task loaded as context.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ScrollView,
  TextInput,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { launchImageLibrary, type ImagePickerResponse } from 'react-native-image-picker';
import {
  useInbox, InboundEnvelope, sendEnvelope, executeJupiterSwap, useTradeQuote,
  bagsLaunch, bagsClaim, useBagsPositions, useBagsConfig,
  usePortfolioHistory, usePeers, PortfolioEvent,
  BagsLaunchParams, BagsToken, use8004Badge, useSkrLeague,
  useAgents,
} from '../hooks/useNodeApi';
import { useOwnedAgents, OwnedAgent } from '../hooks/useOwnedAgents';
import { useNode } from '../hooks/useNode';
import { useZeroclawChat } from '../hooks/useZeroclawChat';
import { useAgentBrain } from '../hooks/useAgentBrain';
import { NodeStatusBanner } from '../components/NodeStatusBanner';
import { useTheme, ThemeColors } from '../theme/ThemeContext';
import { ThemeToggle } from '../components/ThemeToggle';
import { useLayout } from '../hooks/useLayout';

// ── Task tracking (AsyncStorage-backed) ──────────────────────────────────

const TASK_LOG_KEY = 'zerox1:task_log';

interface TaskEntry {
  conversationId: string;
  description: string;
  reward: string;
  fromAgent: string;
  status: 'active' | 'completed' | 'delivered';
  acceptedAt: number;
  completedAt?: number;
}

async function loadTaskLog(): Promise<TaskEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(TASK_LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function saveTaskLog(entries: TaskEntry[]): Promise<void> {
  await AsyncStorage.setItem(TASK_LOG_KEY, JSON.stringify(entries.slice(0, 100)));
}

// ── Types ─────────────────────────────────────────────────────────────────

interface ProposalTerms {
  description?: string;
  reward?: string;
  escrow_amount_usdc?: number;
  message?: string;
  quest?: string;
  from?: string;
  terms?: ProposalTerms;
  max_rounds?: number;
  round?: number;
  deadline_secs?: number;
  [key: string]: unknown;
}

export interface BountyTask {
  description: string;
  reward: string;
  fromAgent: string;
}

interface Bounty {
  conversationId: string;
  sender: string;
  slot: number;
  terms: ProposalTerms;
  receivedAt: number;
  deadlineAt?: number; // ms epoch; undefined = no deadline
}

// ── Token list (well-known tokens + user-added CAs) ───────────────────────

interface SwapToken { label: string; mint: string; decimals: number }

const SWAP_TOKENS: SwapToken[] = [
  { label: 'SOL',  mint: 'So11111111111111111111111111111111111111112',   decimals: 9 },
  { label: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  { label: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
  { label: 'JUP',  mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  decimals: 6 },
  { label: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 },
  { label: 'RAY',  mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',  decimals: 6 },
  { label: 'WIF',  mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',  decimals: 6 },
];

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ── Helpers ───────────────────────────────────────────────────────────────

function readBidAmountMicro(raw: Uint8Array): number {
  if (raw.length < 8) return 0;
  const lo = raw[0] | (raw[1] << 8) | (raw[2] << 16) | (raw[3] << 24);
  const hi = raw[4] | (raw[5] << 8) | (raw[6] << 16) | (raw[7] << 24);
  return (lo >>> 0) + (hi >>> 0) * 4294967296;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function decodeTerms(payloadB64: string): ProposalTerms | null {
  try {
    if (payloadB64.length > 65536) return null; // ~48KB decoded max
    const raw = Uint8Array.from(atob(payloadB64), c => c.charCodeAt(0));

    // Backward-compat format: payload is plain JSON.
    const plain = parseJsonRecord(String.fromCharCode(...raw));
    if (plain) {
      const nested = plain.terms;
      const base =
        nested && typeof nested === 'object' && !Array.isArray(nested)
          ? (nested as ProposalTerms)
          : (plain as ProposalTerms);
      return {
        ...base,
        description: base.description ?? base.message,
      };
    }

    // Current negotiate wire format:
    // [16-byte LE i128 amount_usdc_micro][JSON body]
    if (raw.length < 17 || raw[16] !== 0x7b) return null; // 0x7b = '{'
    const body = parseJsonRecord(String.fromCharCode(...raw.slice(16)));
    if (!body) return null;
    const terms = body.terms && typeof body.terms === 'object' && !Array.isArray(body.terms)
      ? (body.terms as ProposalTerms)
      : (body as ProposalTerms);
    const amountUsdc = readBidAmountMicro(raw) / 1_000_000;

    return {
      ...terms,
      description: terms.description ?? terms.message,
      escrow_amount_usdc:
        terms.escrow_amount_usdc !== undefined
          ? terms.escrow_amount_usdc
          : amountUsdc > 0
          ? amountUsdc
          : undefined,
    };
  } catch {
    return null;
  }
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function rewardLabel(terms: ProposalTerms): string {
  if (terms.escrow_amount_usdc) return `${terms.escrow_amount_usdc} USDC`;
  if (terms.reward) return String(terms.reward);
  return 'reputation';
}

// ── Agent picker ──────────────────────────────────────────────────────────

function AgentPicker({
  agents,
  onSelect,
  onClose,
}: {
  agents: OwnedAgent[];
  onSelect: (a: OwnedAgent) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const s = useStyles(colors);
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.overlay} onPress={onClose} />
      <View style={s.sheet}>
        <Text style={s.sheetTitle}>{t('earn.assignToAgent')}</Text>
        {agents.map(a => (
          <TouchableOpacity
            key={a.id || a.mode}
            style={s.agentRow}
            onPress={() => onSelect(a)}
            activeOpacity={0.7}
          >
            <View>
              <Text style={s.agentName}>{a.name}</Text>
              <Text style={s.agentId}>{a.id ? shortId(a.id) : t('earn.starting')}</Text>
            </View>
            <View style={[s.badge, a.mode === 'local' ? s.badgeLocal : s.badgeHosted]}>
              <Text style={s.badgeText}>
                {a.mode === 'local' ? t('earn.phoneLabel') : t('earn.hostedLabel')}
              </Text>
            </View>
          </TouchableOpacity>
        ))}
      </View>
    </Modal>
  );
}

// ── Bounty card ───────────────────────────────────────────────────────────

function BountyCard({
  bounty,
  onAccept,
  onSkip,
  onReject,
}: {
  bounty: Bounty;
  onAccept: () => void;
  onSkip: () => void;
  onReject: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const s = useStyles(colors);
  const senderRegistered = use8004Badge(bounty.sender);
  const [remaining, setRemaining] = useState<number | null>(
    bounty.deadlineAt ? Math.max(0, Math.floor((bounty.deadlineAt - Date.now()) / 1000)) : null,
  );

  useEffect(() => {
    if (!bounty.deadlineAt) return;
    const id = setInterval(() => {
      setRemaining(Math.max(0, Math.floor((bounty.deadlineAt! - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [bounty.deadlineAt]);

  const urgent = remaining !== null && remaining <= 30;
  const remainStr = remaining === null ? null
    : remaining >= 60 ? `${Math.floor(remaining / 60)}m ${remaining % 60}s`
    : `${remaining}s`;

  return (
    <View style={[s.card, urgent && { borderColor: colors.red }]}>
      <Text style={s.desc} numberOfLines={4}>
        {bounty.terms.description ?? t('earn.noDescription')}
      </Text>
      <View style={s.meta}>
        <Text style={s.reward}>{rewardLabel(bounty.terms)}</Text>
        <Text style={s.dot}> · </Text>
        <Text style={s.from}>
          {t('earn.from')} {shortId(bounty.terms.from ?? bounty.sender)}
        </Text>
        {senderRegistered && (
          <View style={s.badge8004}>
            <Text style={s.badge8004Text}>[8004]</Text>
          </View>
        )}
        <Text style={s.dot}> · </Text>
        <Text style={s.time}>{timeAgo(bounty.receivedAt)}</Text>
        {remainStr !== null && (
          <>
            <Text style={s.dot}> · </Text>
            <Text style={[s.time, urgent && { color: colors.red }]}>{remainStr}</Text>
          </>
        )}
      </View>
      <View style={s.actions}>
        <TouchableOpacity style={s.skipBtn} onPress={onSkip} activeOpacity={0.7}>
          <Text style={s.skipText}>{t('earn.skip')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.rejectBountyBtn} onPress={onReject} activeOpacity={0.7}>
          <Text style={s.rejectBountyText}>{t('earn.reject')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.acceptBtn} onPress={onAccept} activeOpacity={0.8}>
          <Text style={s.acceptText}>{t('earn.accept')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Bags form field ───────────────────────────────────────────────────────

function BagsField({
  label,
  value,
  onChange,
  placeholder,
  optional,
  multiline,
  maxLength,
  keyboardType,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  optional?: boolean;
  multiline?: boolean;
  maxLength?: number;
  keyboardType?: 'default' | 'decimal-pad';
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={{ fontSize: 9, color: colors.sub, letterSpacing: 2, fontFamily: 'monospace', marginBottom: 4 }}>
        {label}{optional ? ` ${t('earn.fieldOptional')}` : ''}
      </Text>
      <TextInput
        style={{
          backgroundColor: colors.bg,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 3,
          color: colors.text,
          fontFamily: 'monospace',
          fontSize: 13,
          paddingHorizontal: 10,
          paddingVertical: multiline ? 8 : 6,
          minHeight: multiline ? 64 : undefined,
          textAlignVertical: multiline ? 'top' : undefined,
        }}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.sub}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        maxLength={maxLength}
        keyboardType={keyboardType ?? 'default'}
      />
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────

export function EarnScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const agents = useOwnedAgents().filter(a => a.mode !== 'linked');
  const { status, start } = useNode();
  const [bounties, setBounties] = useState<Bounty[]>([]);
  const [pickerTarget, setPickerTarget] = useState<Bounty | null>(null);
  const [activeTab, setActiveTab] = useState<'earn' | 'trade' | 'leaderboard'>('earn');
  const [bagsExpanded, setBagsExpanded] = useState(false);
  const { colors } = useTheme();
  const { isTablet, isWide, contentHPad, numColumns } = useLayout();
  const s = useStyles(colors, isTablet, isWide);

  const { injectSystemMessage } = useZeroclawChat(agents[0]?.id);

  // ── Auto-accept ──────────────────────────────────────────────────────────────
  const { config: brainConfig, save: saveBrain } = useAgentBrain();
  const autoAcceptOn = brainConfig.autoAccept;
  const toggleAutoAccept = useCallback(async () => {
    const next = { ...brainConfig, autoAccept: !brainConfig.autoAccept };
    await saveBrain(next);
  }, [brainConfig, saveBrain]);

  // ── Earnings summary from portfolio history ────────────────────────────────
  const portfolioHistory = usePortfolioHistory();
  const peers = usePeers();

  const earningsSummary = useMemo(() => {
    let totalUsdc = 0;
    let bountyCount = 0;
    for (const ev of portfolioHistory) {
      if (ev.type === 'bounty') {
        totalUsdc += ev.amount_usdc;
        bountyCount++;
      }
    }
    return { totalUsdc, bountyCount };
  }, [portfolioHistory]);

  // ── Task log (active + completed) ──────────────────────────────────────────
  const [taskLog, setTaskLog] = useState<TaskEntry[]>([]);
  const activeTasks = useMemo(() => taskLog.filter(t => t.status === 'active' || t.status === 'delivered'), [taskLog]);
  const completedTasks = useMemo(() => taskLog.filter(t => t.status === 'completed').slice(0, 20), [taskLog]);

  useEffect(() => {
    loadTaskLog().then(setTaskLog);
  }, []);

  // Mark tasks complete when a matching bounty portfolio event appears.
  // Uses functional setState to avoid taskLog as a dependency (prevents extra render cycle).
  useEffect(() => {
    if (portfolioHistory.length === 0) return;
    const bountyConvIds = new Set(
      portfolioHistory.filter((e): e is Extract<PortfolioEvent, { type: 'bounty' }> => e.type === 'bounty')
        .map(e => e.conversation_id),
    );
    if (bountyConvIds.size === 0) return;
    setTaskLog(prev => {
      let changed = false;
      const updated = prev.map(t => {
        if (t.status === 'active' && bountyConvIds.has(t.conversationId)) {
          changed = true;
          return { ...t, status: 'completed' as const, completedAt: Date.now() };
        }
        return t;
      });
      if (changed) {
        saveTaskLog(updated);
        return updated;
      }
      return prev;
    });
  }, [portfolioHistory]);

  // ── Trade tab ──────────────────────────────────────────────────────────────
  const [swapAmount, setSwapAmount] = useState('0.1');
  const [swapping, setSwapping] = useState(false);
  const [inputToken,  setInputToken]  = useState<SwapToken>(SWAP_TOKENS[1]); // USDC
  const [outputToken, setOutputToken] = useState<SwapToken>(SWAP_TOKENS[0]); // SOL
  const [pickerFor, setPickerFor] = useState<'input' | 'output' | null>(null);
  const [customTokens, setCustomTokens] = useState<SwapToken[]>([]);
  const [caInput, setCaInput] = useState('');
  const [caDecimals, setCaDecimals] = useState('6');

  // ── Bags tab ───────────────────────────────────────────────────────────────
  const bagsConfig = useBagsConfig();
  const bagsPositions = useBagsPositions();
  const [launching, setLaunching] = useState(false);
  const [claiming, setClaiming] = useState<string | null>(null); // token_mint being claimed
  const [launchName, setLaunchName] = useState('');
  const [launchSymbol, setLaunchSymbol] = useState('');
  const [launchDesc, setLaunchDesc] = useState('');
  const [launchImageBytes, setLaunchImageBytes] = useState<string | null>(null);
  const [launchImageName, setLaunchImageName] = useState<string | null>(null);
  const [launchWebUrl, setLaunchWebUrl] = useState('');
  const [launchTwitter, setLaunchTwitter] = useState('');
  const [launchTelegram, setLaunchTelegram] = useState('');
  const [launchInitialBuy, setLaunchInitialBuy] = useState('');
  const bagsApiConfigured = bagsConfig !== null;

  // ── Agent leaderboard ──────────────────────────────────────────────────────
  const allMeshAgents = useAgents('reputation', 50);

  // ── SKR League ─────────────────────────────────────────────────────────────
  const skrLeague = useSkrLeague();
  const [bountyRefreshing, setBountyRefreshing] = useState(false);

  const handlePickImage = useCallback(() => {
    launchImageLibrary(
      { mediaType: 'photo', includeBase64: true, quality: 0.8, maxWidth: 1024, maxHeight: 1024 },
      (response: ImagePickerResponse) => {
        if (response.didCancel || response.errorCode) return;
        const asset = response.assets?.[0];
        if (!asset?.base64) return;
        setLaunchImageBytes(asset.base64);
        setLaunchImageName(asset.fileName ?? 'image.jpg');
      },
    );
  }, []);

  const handleBagsLaunch = useCallback(async () => {
    if (!launchName.trim() || !launchSymbol.trim() || !launchDesc.trim()) {
      Alert.alert(t('earn.missingFields'), t('earn.missingFieldsBody'));
      return;
    }
    Alert.alert(
      t('earn.launchTokenTitle'),
      t('earn.launchTokenBody', { symbol: launchSymbol.toUpperCase() }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('earn.launch'),
          onPress: async () => {
            setLaunching(true);
            try {
              const params: BagsLaunchParams = {
                name: launchName.trim(),
                symbol: launchSymbol.trim().toUpperCase(),
                description: launchDesc.trim(),
                image_bytes: launchImageBytes ?? undefined,
                website_url: launchWebUrl.trim() || undefined,
                twitter_url: launchTwitter.trim() || undefined,
                telegram_url: launchTelegram.trim() || undefined,
                initial_buy_lamports: launchInitialBuy
                  ? Math.round(parseFloat(launchInitialBuy) * 1e9)
                  : undefined,
              };
              const res = await bagsLaunch(params);
              Alert.alert(
                t('earn.launchSuccess'),
                t('earn.launchSuccessBody', { symbol: launchSymbol.toUpperCase(), mint: shortId(res.token_mint), txid: shortId(res.txid) }),
              );
              // Reset form
              setLaunchName(''); setLaunchSymbol(''); setLaunchDesc('');
              setLaunchImageBytes(null); setLaunchImageName(null);
              setLaunchWebUrl(''); setLaunchTwitter('');
              setLaunchTelegram(''); setLaunchInitialBuy('');
            } catch (e: any) {
              Alert.alert(t('earn.launchFailed'), e?.message ?? t('common.error'));
            } finally {
              setLaunching(false);
            }
          },
        },
      ],
    );
  }, [launchName, launchSymbol, launchDesc, launchImageBytes, launchWebUrl, launchTwitter, launchTelegram, launchInitialBuy]);

  const handleBagsClaim = useCallback(async (token: BagsToken) => {
    Alert.alert(
      t('earn.claimFeesTitle'),
      t('earn.claimFeesBody', { symbol: token.symbol }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('earn.claim'),
          onPress: async () => {
            setClaiming(token.token_mint);
            try {
              const res = await bagsClaim(token.token_mint);
              Alert.alert(
                t('earn.claimed'),
                t('earn.claimedBody', { count: res.claimed_txs, s: res.claimed_txs !== 1 ? 's' : '', amount: (res.total_claimed_usdc / 1e6).toFixed(4) }),
              );
            } catch (e: any) {
              Alert.alert(t('earn.claimFailed'), e?.message ?? t('common.error'));
            } finally {
              setClaiming(null);
            }
          },
        },
      ],
    );
  }, []);

  const allTokens = [...SWAP_TOKENS, ...customTokens];

  const { quote, loading: quoteLoading } = useTradeQuote({
    inputMint:  inputToken.mint,
    outputMint: outputToken.mint,
    amount: (Number(swapAmount) || 0) * 10 ** inputToken.decimals,
  });

  const handleSwap = useCallback(async () => {
    if (!swapAmount || isNaN(Number(swapAmount)) || !quote) return;
    const outAmount = parseFloat(quote.outAmount) / 10 ** outputToken.decimals;
    Alert.alert(
      t('earn.confirmSwapTitle'),
      t('earn.confirmSwapBody', { amount: swapAmount, input: inputToken.label, output: outAmount.toFixed(6), outputLabel: outputToken.label }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('earn.swap'),
          onPress: async () => {
            setSwapping(true);
            const res = await executeJupiterSwap({
              inputMint:  inputToken.mint,
              outputMint: outputToken.mint,
              amount: Number(swapAmount) * 10 ** inputToken.decimals,
            });
            setSwapping(false);
            if (res?.txid) {
              injectSystemMessage(
                `✅ Trade Successful\nSwapped ${swapAmount} ${inputToken.label} → ${outAmount.toFixed(6)} ${outputToken.label}\nTxID: ${shortId(res.txid)}`,
              );
              navigation.navigate('Chat');
            } else {
              Alert.alert(t('earn.swapFailed'), t('earn.swapFailedBody'));
            }
          },
        },
      ],
    );
  }, [swapAmount, quote, inputToken, outputToken, injectSystemMessage, navigation]);

  const refreshBountyTab = useCallback(async () => {
    setBountyRefreshing(true);
    setBountyRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      // Reload task log so status changes made in Chat (delivered/abandoned) are reflected.
      loadTaskLog().then(setTaskLog);
    }, [])
  );

  const onEnvelope = useCallback((env: InboundEnvelope) => {
    if (env.msg_type !== 'PROPOSE' && env.msg_type !== 'DISCOVER') return;
    const terms = decodeTerms(env.payload_b64);
    if (!terms) return;
    const deadlineSecs = typeof terms.deadline_secs === 'number' ? terms.deadline_secs : null;
    const now = Date.now();
    setBounties(prev => {
      if (prev.some(b => b.conversationId === env.conversation_id)) return prev;
      return [
        {
          conversationId: env.conversation_id,
          sender: env.sender,
          slot: env.slot,
          terms,
          receivedAt: now,
          deadlineAt: deadlineSecs ? now + deadlineSecs * 1000 : undefined,
        },
        ...prev,
      ].slice(0, 50);
    });
  }, []);

  useInbox(onEnvelope, status === 'running');

  // Auto-expire bounties past their deadline
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setBounties(prev => prev.filter(b => !b.deadlineAt || b.deadlineAt > now));
    }, 2000);
    return () => clearInterval(id);
  }, []);

  const assignAndNavigate = useCallback(async (bounty: Bounty, agent: OwnedAgent) => {
    setPickerTarget(null);
    const ok = await sendEnvelope({
      msg_type: 'ACCEPT',
      recipient: bounty.sender,
      conversation_id: bounty.conversationId,
      payload_b64: '',
    });
    if (!ok) {
      Alert.alert(t('common.error'), t('earn.errorAccept'));
      return;
    }
    setBounties(prev => prev.filter(b => b.conversationId !== bounty.conversationId));

    // Log task
    const entry: TaskEntry = {
      conversationId: bounty.conversationId,
      description: bounty.terms.description ?? 'Task',
      reward: rewardLabel(bounty.terms),
      fromAgent: bounty.terms.from ?? bounty.sender,
      status: 'active',
      acceptedAt: Date.now(),
    };
    setTaskLog(prev => {
      const updated = [entry, ...prev];
      saveTaskLog(updated);
      return updated;
    });

    navigation.navigate('Chat', {
      agentId: agent.id,
      conversationId: bounty.conversationId,
      task: {
        description: entry.description,
        reward: entry.reward,
        fromAgent: entry.fromAgent,
      } as BountyTask,
    });
  }, [navigation]);

  const handleAccept = useCallback((bounty: Bounty) => {
    if (agents.length > 1) {
      setPickerTarget(bounty);
    } else if (agents.length === 1) {
      assignAndNavigate(bounty, agents[0]);
    }
  }, [agents, assignAndNavigate]);

  const handleSkip = useCallback((bounty: Bounty) => {
    setBounties(prev => prev.filter(b => b.conversationId !== bounty.conversationId));
  }, []);

  const handleRejectBounty = useCallback((bounty: Bounty) => {
    setBounties(prev => prev.filter(b => b.conversationId !== bounty.conversationId));
    sendEnvelope({
      msg_type: 'REJECT',
      recipient: bounty.sender,
      conversation_id: bounty.conversationId,
      payload_b64: '',
    });
  }, []);

  const handleAbandonTask = useCallback((task: TaskEntry) => {
    Alert.alert(
      t('earn.giveUpTitle'),
      t('earn.giveUpBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('earn.giveUp'),
          style: 'destructive',
          onPress: async () => {
            await sendEnvelope({
              msg_type: 'REJECT',
              recipient: task.fromAgent,
              conversation_id: task.conversationId,
              payload_b64: '',
            });
            setTaskLog(prev => {
              const updated = prev.filter(t => t.conversationId !== task.conversationId);
              saveTaskLog(updated);
              return updated;
            });
          },
        },
      ],
    );
  }, []);

  const isRunning = status === 'running';

  return (
    <View style={s.root}>
      <ThemeToggle halfCircle top={insets.top + 16} />
      <NodeStatusBanner />
      <View style={{ flex: 1, paddingHorizontal: contentHPad }}>
      {/* Tab Header */}
      <View style={[s.header, { paddingTop: insets.top + 16 }]}>
        <View style={s.tabRow}>
            <TouchableOpacity
              style={[s.tabBtn, activeTab === 'earn' && s.tabActive]}
              onPress={() => setActiveTab('earn')}
            >
              <Text style={[s.tabText, activeTab === 'earn' && s.tabTextActive]}>EARN</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.tabBtn, activeTab === 'trade' && s.tabActive]}
              onPress={() => setActiveTab('trade')}
            >
              <Text style={[s.tabText, activeTab === 'trade' && s.tabTextActive]}>{t('earn.tabTrade')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.tabBtn, activeTab === 'leaderboard' && s.tabActive]}
              onPress={() => setActiveTab('leaderboard')}
            >
              <Text style={[s.tabText, activeTab === 'leaderboard' && s.tabTextActive]}>{t('earn.tabTop')}</Text>
            </TouchableOpacity>
        </View>
      </View>

      {/* Earn Tab — My Agent + Agent Leaderboard */}
      {activeTab === 'earn' && (() => {
        const localAgent = agents.find(a => a.mode === 'local');
        const myToken = bagsPositions[0];
        const caps: string[] = brainConfig.capabilities ?? [];
        return (
          <ScrollView style={s.tradeRoot} contentContainerStyle={s.tradeContent}>
            {/* ── My Agent advertising card ─────────────────────────── */}
            <Text style={s.sectionLabel}>MY AGENT</Text>
            <View style={[s.card, { marginBottom: 20, borderColor: isRunning ? colors.green + '60' : colors.border }]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={s.agentName}>{localAgent?.name ?? 'Unnamed agent'}</Text>
                  <Text style={s.agentId}>{localAgent?.id ? shortId(localAgent.id) : '—'}</Text>
                </View>
                <View style={[s.badge, isRunning ? s.badgeLocal : { backgroundColor: colors.dim + '20', borderWidth: 1, borderColor: colors.dim + '60' }]}>
                  <Text style={[s.badgeText, { color: isRunning ? colors.green : colors.dim }]}>
                    {isRunning ? 'ONLINE' : 'OFFLINE'}
                  </Text>
                </View>
              </View>

              {myToken ? (
                <View style={{ marginBottom: 12 }}>
                  <Text style={{ fontSize: 9, color: colors.sub, letterSpacing: 2, fontFamily: 'monospace', marginBottom: 4 }}>TOKEN</Text>
                  <Text style={{ fontSize: 13, color: colors.green, fontFamily: 'monospace', fontWeight: '700' }}>
                    {myToken.symbol} · {shortId(myToken.token_mint)}
                  </Text>
                </View>
              ) : (
                <Text style={[s.sub, { marginBottom: 12 }]}>No token launched — go to Trade tab to launch</Text>
              )}

              {caps.length > 0 ? (
                <View style={{ marginBottom: 10 }}>
                  <Text style={{ fontSize: 9, color: colors.sub, letterSpacing: 2, fontFamily: 'monospace', marginBottom: 6 }}>OFFERING</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {caps.map(cap => (
                      <View key={cap} style={{ backgroundColor: colors.green + '15', borderWidth: 1, borderColor: colors.green + '40', borderRadius: 3, paddingHorizontal: 8, paddingVertical: 3 }}>
                        <Text style={{ fontSize: 10, color: colors.green, fontFamily: 'monospace' }}>{cap}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : (
                <Text style={[s.sub, { marginBottom: 8 }]}>No capabilities set — configure in Settings</Text>
              )}

              {brainConfig.minFeeUsdc > 0 && (
                <Text style={s.sub}>from ${brainConfig.minFeeUsdc} USD · auto-accept {brainConfig.autoAccept ? 'on' : 'off'}</Text>
              )}
            </View>

            {/* ── Agent leaderboard ─────────────────────────────────── */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <Text style={s.sectionLabel}>AGENT LEADERBOARD</Text>
              <Text style={{ fontSize: 9, color: colors.sub, fontFamily: 'monospace', letterSpacing: 2 }}>
                {allMeshAgents.length} agents
              </Text>
            </View>

            {allMeshAgents.length === 0 ? (
              <View style={s.emptyInline}>
                <Text style={s.emptyText}>No agents found.{'\n'}Connect to the mesh to see rankings.</Text>
              </View>
            ) : (
              allMeshAgents.map((agent, idx) => {
                const isMe = !!(localAgent?.id && agent.agent_id.toLowerCase() === localAgent.id.toLowerCase());
                return (
                  <View key={agent.agent_id} style={[s.card, { marginBottom: 10, borderColor: isMe ? colors.green : colors.border }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <Text style={s.rankNum}>#{idx + 1}</Text>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Text style={s.agentName} numberOfLines={1}>{agent.name || shortId(agent.agent_id)}</Text>
                          {isMe && (
                            <View style={{ backgroundColor: colors.green + '20', borderWidth: 1, borderColor: colors.green + '60', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1 }}>
                              <Text style={{ fontSize: 8, color: colors.green, fontFamily: 'monospace', fontWeight: '700', letterSpacing: 1 }}>YOU</Text>
                            </View>
                          )}
                        </View>
                        <Text style={s.agentId}>{shortId(agent.agent_id)}</Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={s.lbPrice}>{agent.average_score.toFixed(1)}</Text>
                        <Text style={[s.lbChange, { color: colors.sub }]}>rep</Text>
                      </View>
                    </View>
                    <View style={s.lbMetaRow}>
                      <Text style={s.lbMetaLabel}>JOBS</Text>
                      <Text style={s.lbMetaVal}>{agent.feedback_count}</Text>
                      <Text style={s.lbMetaDot}> · </Text>
                      <Text style={s.lbMetaLabel}>POS</Text>
                      <Text style={[s.lbMetaVal, { color: colors.green }]}>{agent.positive_count}</Text>
                      <Text style={s.lbMetaDot}> · </Text>
                      <Text style={s.lbMetaLabel}>NEG</Text>
                      <Text style={[s.lbMetaVal, { color: colors.red }]}>{agent.negative_count}</Text>
                      {agent.trend ? (
                        <>
                          <Text style={s.lbMetaDot}> · </Text>
                          <Text style={[s.lbMetaVal, { color: agent.trend === 'up' ? colors.green : agent.trend === 'down' ? colors.red : colors.sub }]}>
                            {agent.trend === 'up' ? '▲' : agent.trend === 'down' ? '▼' : '—'}
                          </Text>
                        </>
                      ) : null}
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>
        );
      })()}

      {/* Trade Tab */}
      {activeTab === 'trade' && (
        <ScrollView style={s.tradeRoot} contentContainerStyle={s.tradeContent}>
          <Text style={s.sectionLabel}>{t('earn.jupiterSwap')}</Text>
          <View style={s.card}>
            <Text style={s.sub}>{t('earn.swapHint')}</Text>

            <View style={s.swapBox}>
              <Text style={s.tradeLabel}>{t('earn.swapFrom')}</Text>
              <View style={[s.tradeInputRow, { paddingVertical: 8 }]}>
                <TouchableOpacity onPress={() => setPickerFor('input')} activeOpacity={0.7}>
                  <Text style={[s.tradeTokenBadge, s.tradeTokenTap]}>{inputToken.label} ▾</Text>
                </TouchableOpacity>
                <TextInput
                  style={s.tradeInputVal}
                  keyboardType="numeric"
                  value={swapAmount}
                  onChangeText={setSwapAmount}
                  placeholder="0.00"
                  placeholderTextColor={colors.dim}
                />
              </View>

              <View style={s.swapIconRow}>
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => {
                    const prev = inputToken;
                    setInputToken(outputToken);
                    setOutputToken(prev);
                  }}
                >
                  <Text style={s.swapIcon}>⇅</Text>
                </TouchableOpacity>
              </View>

              <Text style={s.tradeLabel}>{t('earn.swapTo')}</Text>
              <View style={[s.tradeInputRow, { paddingVertical: 14 }]}>
                <TouchableOpacity onPress={() => setPickerFor('output')} activeOpacity={0.7}>
                  <Text style={[s.tradeTokenBadge, s.tradeTokenTap]}>{outputToken.label} ▾</Text>
                </TouchableOpacity>
                {quoteLoading ? (
                  <ActivityIndicator size="small" color={colors.green} />
                ) : quote ? (
                  <Text style={s.tradeInputVal}>
                    {(parseFloat(quote.outAmount) / 10 ** outputToken.decimals).toFixed(6)}
                  </Text>
                ) : (
                  <Text style={[s.tradeInputVal, { color: colors.dim }]}>—</Text>
                )}
              </View>

              {quote && quote.priceImpactPct !== undefined && (
                <View style={s.impactRow}>
                  <Text style={s.impactLabel}>{t('earn.priceImpact')}</Text>
                  <Text style={[s.impactVal, quote.priceImpactPct > 1 ? { color: colors.red } : { color: colors.green }]}>
                    {quote.priceImpactPct.toFixed(2)}%
                  </Text>
                </View>
              )}
            </View>

            <TouchableOpacity
              style={[s.swapBtn, (swapping || !quote || inputToken.mint === outputToken.mint) && { opacity: 0.4 }]}
              activeOpacity={0.8}
              onPress={handleSwap}
              disabled={swapping || !quote || inputToken.mint === outputToken.mint}
            >
              <Text style={s.swapBtnText}>{swapping ? t('earn.swapping') : t('earn.swap')}</Text>
            </TouchableOpacity>
          </View>

          {/* ── BAGS.FM collapsible section ─────────────────────────────── */}
          <TouchableOpacity
            style={s.sectionToggle}
            activeOpacity={0.7}
            onPress={() => setBagsExpanded(e => !e)}
          >
            <Text style={s.sectionLabel}>{t('earn.bagsFm')}</Text>
            <Text style={s.toggleChevron}>{bagsExpanded ? '▲' : '▼'}</Text>
          </TouchableOpacity>

          {bagsExpanded && (
            !bagsApiConfigured ? (
              <View style={s.bagsNotConfigured}>
                <Text style={s.emptyText}>{t('earn.bagsNotConfigured')}</Text>
                <TouchableOpacity
                  style={[s.settingsBtn, { marginTop: 12 }]}
                  onPress={() => navigation.navigate('Settings')}
                >
                  <Text style={s.acceptText}>{t('earn.goToSettings')}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                {/* Launch form */}
                <Text style={[s.sectionLabel, { marginTop: 12, marginBottom: 8 }]}>{t('earn.launchToken')}</Text>
                <View style={s.card}>
                  <BagsField label={t('earn.fieldName')} value={launchName} onChange={setLaunchName} placeholder="My Token" />
                  <BagsField label={t('earn.fieldSymbol')} value={launchSymbol} onChange={v => setLaunchSymbol(v.toUpperCase())} placeholder="TKN" maxLength={10} />
                  <BagsField label={t('earn.fieldDescription')} value={launchDesc} onChange={setLaunchDesc} placeholder="A token for…" multiline />
                  {/* Image picker */}
                  <View style={{ marginBottom: 12 }}>
                    <Text style={{ fontSize: 9, color: colors.sub, letterSpacing: 2, fontFamily: 'monospace', marginBottom: 4 }}>
                      {t('earn.imageOptional')}
                    </Text>
                    <TouchableOpacity
                      style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.dim, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 8, gap: 8 }}
                      onPress={handlePickImage}
                      activeOpacity={0.7}
                    >
                      <Text style={{ fontSize: 13, color: launchImageBytes ? colors.green : colors.dim, fontFamily: 'monospace', flex: 1 }} numberOfLines={1}>
                        {launchImageName ?? t('earn.tapToPickImage')}
                      </Text>
                      {launchImageBytes && (
                        <TouchableOpacity onPress={() => { setLaunchImageBytes(null); setLaunchImageName(null); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <Text style={{ fontSize: 11, color: colors.red, fontFamily: 'monospace' }}>✕</Text>
                        </TouchableOpacity>
                      )}
                    </TouchableOpacity>
                  </View>
                  <BagsField label={t('earn.fieldWebsite')} value={launchWebUrl} onChange={setLaunchWebUrl} placeholder="https://…" optional />
                  <BagsField label={t('earn.fieldTwitter')} value={launchTwitter} onChange={setLaunchTwitter} placeholder="https://x.com/…" optional />
                  <BagsField label={t('earn.fieldTelegram')} value={launchTelegram} onChange={setLaunchTelegram} placeholder="https://t.me/…" optional />
                  <BagsField label={t('earn.fieldInitialBuy')} value={launchInitialBuy} onChange={setLaunchInitialBuy} placeholder="0 (skip)" optional keyboardType="decimal-pad" />
                  <TouchableOpacity
                    style={[s.swapBtn, (launching || !launchName.trim() || !launchSymbol.trim() || !launchDesc.trim()) && { opacity: 0.4 }]}
                    activeOpacity={0.8}
                    onPress={handleBagsLaunch}
                    disabled={launching || !launchName.trim() || !launchSymbol.trim() || !launchDesc.trim()}
                  >
                    <Text style={s.swapBtnText}>{launching ? t('earn.launching') : t('earn.launchOnBags')}</Text>
                  </TouchableOpacity>
                </View>

                {/* Positions */}
                {bagsPositions.length > 0 && (
                  <>
                    <Text style={[s.sectionLabel, { marginTop: 20 }]}>{t('earn.myTokens')}</Text>
                    {bagsPositions.map(token => (
                      <View key={token.token_mint} style={[s.card, { marginBottom: 10 }]}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <View style={{ flex: 1 }}>
                            <Text style={s.agentName}>{token.name}</Text>
                            <Text style={s.agentId}>{token.symbol} · {shortId(token.token_mint)}</Text>
                          </View>
                          <TouchableOpacity
                            style={[s.acceptBtn, { flex: 0, paddingHorizontal: 16, opacity: claiming === token.token_mint ? 0.5 : 1 }]}
                            onPress={() => handleBagsClaim(token)}
                            disabled={claiming === token.token_mint}
                            activeOpacity={0.8}
                          >
                            <Text style={s.acceptText}>{claiming === token.token_mint ? t('common.loading') : t('earn.claim')}</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ))}
                  </>
                )}
              </>
            )
          )}
        </ScrollView>
      )}

      {/* Leaderboard Tab */}
      {activeTab === 'leaderboard' && (
        <ScrollView
          style={s.tradeRoot}
          contentContainerStyle={s.tradeContent}
          refreshControl={
            <RefreshControl
              refreshing={skrLeague.loading}
              onRefresh={skrLeague.refresh}
              tintColor={colors.green}
              colors={[colors.green]}
            />
          }
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={s.sectionLabel}>{t('earn.skrLeague')}</Text>
            <TouchableOpacity onPress={() => skrLeague.refresh()} disabled={skrLeague.loading}>
              <Text style={{ fontSize: 9, color: colors.sub, fontFamily: 'monospace', letterSpacing: 2 }}>
                {skrLeague.loading ? t('common.loading') : t('common.refresh')}
              </Text>
            </TouchableOpacity>
          </View>

          {skrLeague.error ? (
            <View style={{ backgroundColor: '#1a0505', borderWidth: 1, borderColor: colors.red, borderRadius: 4, padding: 12, marginBottom: 12 }}>
              <Text style={{ color: colors.red, fontFamily: 'monospace', fontSize: 11 }}>{skrLeague.error}</Text>
            </View>
          ) : null}

          {skrLeague.data && (
            <View style={[s.card, { marginBottom: 12 }]}>
              <Text style={s.desc}>{skrLeague.data.season}</Text>
              <View style={s.meta}>
                <Text style={s.reward}>{skrLeague.data.reward_pool_skr.toLocaleString()} SKR</Text>
                <Text style={s.dot}> · </Text>
                <Text style={s.from}>{t('earn.skrMin', { amount: skrLeague.data.min_skr.toLocaleString() })}</Text>
                {skrLeague.data.wallet.rank ? (
                  <>
                    <Text style={s.dot}> · </Text>
                    <Text style={s.from}>{t('earn.skrRank', { rank: skrLeague.data.wallet.rank })}</Text>
                  </>
                ) : null}
              </View>
              <Text style={[s.from, { marginTop: 8 }]}>
                {t('earn.skrBalance', { amount: skrLeague.data.wallet.skr_balance.toLocaleString(undefined, { maximumFractionDigits: 2 }) })}
              </Text>
              <Text style={[s.from, { marginTop: 6 }]}>
                {t('earn.skrEarnRate', {
                  rate: `${skrLeague.data.wallet.earn_rate_pct >= 0 ? '+' : ''}${skrLeague.data.wallet.earn_rate_pct.toFixed(2)}`,
                  trades: skrLeague.data.wallet.trade_count,
                  days: skrLeague.data.wallet.active_days,
                })}
              </Text>
              <Text style={[s.from, { marginTop: 6, color: colors.sub }]}>
                {t('earn.skrBagsClaimed', {
                  sol: skrLeague.data.wallet.bags_fee_score.toLocaleString(undefined, { maximumFractionDigits: 4 }),
                  pts: skrLeague.data.wallet.points.toLocaleString(),
                })}
              </Text>
              <Text style={[s.desc, { marginTop: 8, color: skrLeague.data.wallet.has_access ? colors.green : colors.amber }]}>
                {!skrLeague.data.wallet.wallet
                  ? t('earn.skrLinkWallet')
                  : skrLeague.data.wallet.access_message}
              </Text>
              <View style={{ marginTop: 12 }}>
                {skrLeague.data.scoring.map((line, idx) => (
                  <Text key={`scoring-${idx}`} style={[s.from, { marginBottom: 4, color: colors.sub }]}>{line}</Text>
                ))}
              </View>
              <View style={{ marginTop: 12 }}>
                {skrLeague.data.rewards.map((reward, idx) => (
                  <Text key={idx} style={[s.from, { marginBottom: 4 }]}>{reward}</Text>
                ))}
              </View>
            </View>
          )}

          {skrLeague.loading && !skrLeague.data ? (
            <ActivityIndicator color={colors.green} style={{ marginTop: 40 }} />
          ) : (
            <FlatList
              data={skrLeague.data?.leaderboard ?? []}
              keyExtractor={item => item.wallet}
              scrollEnabled={false}
              ListEmptyComponent={
                <View style={s.empty}>
                  <Text style={s.emptyText}>
                    {skrLeague.data?.wallet.wallet
                      ? t('earn.skrNoEntries')
                      : t('earn.skrLinkWallet')}
                  </Text>
                </View>
              }
              renderItem={({ item }) => {
                return (
                  <View key={item.wallet} style={[s.card, { marginBottom: 10 }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <Text style={s.rankNum}>#{item.rank}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={s.agentName}>{item.label}</Text>
                        <Text style={s.agentId}>{shortId(item.wallet)}</Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={s.lbPrice}>{item.earn_rate_pct >= 0 ? '+' : ''}{item.earn_rate_pct.toFixed(2)}%</Text>
                        <Text style={[s.lbChange, { color: item.earn_rate_pct >= 0 ? colors.green : colors.red }]}>{t('earn.skrEarnRateLabel')}</Text>
                      </View>
                    </View>
                    <View style={s.lbMetaRow}>
                      <Text style={s.lbMetaLabel}>{t('earn.skrTradesDaysPts', { trades: item.trade_count, days: item.active_days, pts: item.points })}</Text>
                      <Text style={s.lbMetaDot}> · </Text>
                      <Text style={s.lbMetaLabel}>{t('earn.skrBagsClaimedLabel')}</Text>
                      <Text style={s.lbMetaVal}>{item.bags_fee_score.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL</Text>
                    </View>
                    <View style={[s.lbMetaRow, { marginTop: 4 }]}>
                      <Text style={s.lbMetaLabel}>{t('earn.skrBalanceLabel')}</Text>
                      <Text style={s.lbMetaVal}>{item.skr_balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} SKR</Text>
                    </View>
                  </View>
                );
              }}
            />
          )}
        </ScrollView>
      )}

      {/* Token picker modal */}
      {pickerFor && (
        <Modal transparent animationType="slide" onRequestClose={() => setPickerFor(null)}>
          <Pressable style={s.overlay} onPress={() => setPickerFor(null)} />
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>{t('earn.selectToken')}</Text>
            <ScrollView style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled">
              {allTokens.map((tok) => {
                const otherMint = pickerFor === 'input' ? outputToken.mint : inputToken.mint;
                const isOtherSide = tok.mint === otherMint;
                return (
                  <TouchableOpacity
                    key={tok.mint}
                    style={[s.agentRow, isOtherSide && { opacity: 0.3 }]}
                    onPress={() => {
                      if (isOtherSide) return;
                      if (pickerFor === 'input') setInputToken(tok);
                      else setOutputToken(tok);
                      setPickerFor(null);
                      setCaInput('');
                    }}
                    activeOpacity={0.7}
                  >
                    <Text style={s.agentName}>{tok.label}</Text>
                    <Text style={s.agentId}>{tok.mint.slice(0, 8)}…</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {/* Custom CA entry */}
            <View style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 }}>
              <Text style={[s.tradeLabel, { marginBottom: 6 }]}>OR ENTER CONTRACT ADDRESS</Text>
              <TextInput
                style={[s.tradeInputVal, { flex: undefined, borderWidth: 1, borderColor: colors.border, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 6 }]}
                value={caInput}
                onChangeText={setCaInput}
                placeholder="Mint address (base58)…"
                placeholderTextColor={colors.dim}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <Text style={{ color: colors.sub, fontSize: 12, fontFamily: 'monospace' }}>DECIMALS</Text>
                <TextInput
                  style={[s.tradeInputVal, { flex: undefined, width: 60, borderWidth: 1, borderColor: colors.border, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 6, textAlign: 'center' }]}
                  value={caDecimals}
                  onChangeText={setCaDecimals}
                  keyboardType="number-pad"
                  placeholder="6"
                  placeholderTextColor={colors.dim}
                />
                <TouchableOpacity
                  style={[s.swapBtn, { flex: 1, paddingVertical: 8, marginBottom: 0 }, !BASE58_RE.test(caInput.trim()) && { opacity: 0.4 }]}
                  activeOpacity={0.8}
                  disabled={!BASE58_RE.test(caInput.trim())}
                  onPress={() => {
                    const mint = caInput.trim();
                    const dec = parseInt(caDecimals, 10);
                    if (!BASE58_RE.test(mint)) return;
                    const decimals = isNaN(dec) ? 6 : Math.max(0, Math.min(18, dec));
                    const label = mint.slice(0, 4) + '…' + mint.slice(-4);
                    const tok: SwapToken = { label, mint, decimals };
                    const already = allTokens.find(t => t.mint === mint);
                    const resolved = already ?? tok;
                    if (!already) setCustomTokens(prev => [...prev, tok]);
                    if (pickerFor === 'input') setInputToken(resolved);
                    else setOutputToken(resolved);
                    setPickerFor(null);
                    setCaInput('');
                    setCaDecimals('6');
                  }}
                >
                  <Text style={s.swapBtnText}>ADD</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}

      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

function useStyles(colors: ThemeColors, isTablet = false, isWide = false) {
  return React.useMemo(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 20, paddingTop: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
  tabRow: { flexDirection: 'row', gap: isTablet ? 32 : 20, paddingBottom: 0, justifyContent: 'flex-start' },
  tabBtn: { paddingBottom: 12, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: colors.green },
  tabText: { fontSize: 13, fontWeight: '700', color: colors.dim, letterSpacing: 2, fontFamily: 'monospace' },
  tabTextActive: { color: colors.text },
  subHeader: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  title: { fontSize: 13, fontWeight: '700', color: colors.text, letterSpacing: 3, fontFamily: 'monospace' },
  sub: { fontSize: 11, color: colors.sub, fontFamily: 'monospace' },
  list: { padding: 16, gap: 12 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 4, padding: 16 },
  desc: { fontSize: 14, color: colors.text, fontFamily: 'monospace', lineHeight: 20, marginBottom: 10 },
  meta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 },
  reward: { fontSize: 11, color: colors.green, fontFamily: 'monospace', fontWeight: '700' },
  dot: { fontSize: 11, color: colors.dim },
  from: { fontSize: 11, color: colors.sub, fontFamily: 'monospace' },
  badge8004: { backgroundColor: '#00e67614', borderWidth: 1, borderColor: colors.green + '50', borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1, marginLeft: 5 },
  badge8004Text: { fontSize: 8, color: colors.green, fontFamily: 'monospace', fontWeight: '700', letterSpacing: 1 },
  time: { fontSize: 11, color: colors.sub, fontFamily: 'monospace' },
  actions: { flexDirection: 'row', gap: 10 },
  skipBtn: { flex: 1, borderWidth: 1, borderColor: colors.dim, borderRadius: 3, paddingVertical: 9, alignItems: 'center' },
  skipText: { fontSize: 11, color: colors.sub, letterSpacing: 2, fontWeight: '700' },
  rejectBountyBtn: { flex: 1, borderWidth: 1, borderColor: colors.red + '60', borderRadius: 3, paddingVertical: 9, alignItems: 'center' },
  rejectBountyText: { fontSize: 11, color: colors.red, letterSpacing: 2, fontWeight: '700' },
  acceptBtn: { flex: 2, backgroundColor: colors.green, borderRadius: 3, paddingVertical: 9, alignItems: 'center' },
  acceptText: { fontSize: 11, color: '#000', letterSpacing: 2, fontWeight: '700' },
  settingsBtn: { backgroundColor: colors.green, borderRadius: 3, paddingVertical: 10, paddingHorizontal: 28, alignItems: 'center', marginTop: 16 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  emptyText: { color: colors.sub, fontFamily: 'monospace', textAlign: 'center', lineHeight: 22, fontSize: 13 },
  // agent picker
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: { backgroundColor: colors.input, borderTopWidth: 1, borderTopColor: colors.border, padding: 24, gap: 4 },
  sheetTitle: { fontSize: 11, color: colors.sub, letterSpacing: 3, marginBottom: 12, fontFamily: 'monospace' },
  agentRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
  agentName: { fontSize: 14, color: colors.text, fontFamily: 'monospace', fontWeight: '700' },
  agentId: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', marginTop: 2 },
  badge: { borderRadius: 3, paddingHorizontal: 8, paddingVertical: 3 },
  badgeLocal: { backgroundColor: colors.green + '20', borderWidth: 1, borderColor: colors.green + '60' },
  badgeHosted: { backgroundColor: colors.amber + '20', borderWidth: 1, borderColor: colors.amber + '60' },
  badgeText: { fontSize: 9, fontWeight: '700', letterSpacing: 2 },

  // Trade TAB
  tradeRoot: { flex: 1 },
  tradeContent: { padding: 20 },
  sectionLabel: { fontSize: 11, color: colors.sub, letterSpacing: 3, marginBottom: 10, marginTop: 4, fontFamily: 'monospace' },
  swapBox: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 4, padding: 14, marginTop: 16, marginBottom: 16 },
  tradeLabel: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', letterSpacing: 1, marginBottom: 8 },
  tradeInputRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: colors.input, padding: 12, borderRadius: 3, borderWidth: 1, borderColor: colors.dim },
  tradeTokenBadge: { fontSize: 14, color: colors.text, fontWeight: '700', fontFamily: 'monospace' },
  tradeTokenTap: { color: colors.green, borderWidth: 1, borderColor: colors.green + '60', borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4 },
  tradeInputVal: { fontSize: 18, color: colors.text, fontFamily: 'monospace' },
  swapIconRow: { alignItems: 'center', paddingVertical: 8 },
  swapIcon: { fontSize: 16, color: colors.dim, fontFamily: 'monospace', fontWeight: '700' },
  swapBtn: { backgroundColor: colors.blue || '#2979ff', borderRadius: 4, paddingVertical: 14, alignItems: 'center' },
  swapBtnText: { fontSize: 12, fontWeight: '700', color: '#fff', letterSpacing: 2, fontFamily: 'monospace' },
  impactRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, paddingHorizontal: 4 },
  impactLabel: { fontSize: 10, color: colors.sub, fontFamily: 'monospace' },
  impactVal: { fontSize: 10, fontWeight: '700', fontFamily: 'monospace' },
  // Leaderboard
  rankNum: { fontSize: 16, color: colors.sub, fontFamily: 'monospace', fontWeight: '700', width: 28 },
  lbPrice: { fontSize: 13, color: colors.text, fontFamily: 'monospace', fontWeight: '700' },
  lbChange: { fontSize: 11, fontFamily: 'monospace', fontWeight: '700', marginTop: 2 },
  lbMetaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border },
  lbMetaLabel: { fontSize: 9, color: colors.sub, letterSpacing: 2, fontFamily: 'monospace' },
  lbMetaVal: { fontSize: 11, color: colors.text, fontFamily: 'monospace', marginLeft: 4 },
  lbMetaDot: { fontSize: 11, color: colors.dim, marginHorizontal: 4 },
  sortBtn: { paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: colors.border, borderRadius: 3 },
  sortBtnActive: { borderColor: colors.green, backgroundColor: '#00e67615' },
  sortBtnText: { fontSize: 9, color: colors.sub, letterSpacing: 2, fontFamily: 'monospace', fontWeight: '700' },
  sortBtnTextActive: { color: colors.green },
  // Bags collapsible
  sectionToggle: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 24, marginBottom: 4 },
  toggleChevron: { fontSize: 10, color: colors.sub, fontFamily: 'monospace' },
  bagsNotConfigured: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 4, padding: 20, alignItems: 'center', marginTop: 8 },

  // Earnings summary bar
  earningsBar: { flexDirection: 'row', backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: 12, paddingHorizontal: 16 },
  earningStat: { flex: 1, alignItems: 'center' },
  earningVal: { fontSize: 16, fontWeight: '700', color: colors.green, fontFamily: 'monospace' },
  earningLabel: { fontSize: 8, color: colors.sub, letterSpacing: 2, fontFamily: 'monospace', marginTop: 2 },
  earningDivider: { width: 1, backgroundColor: colors.border, marginVertical: 2 },

  // Auto-accept row
  autoAcceptRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  autoAcceptBtn: { borderWidth: 1, borderColor: colors.dim, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 4 },
  autoAcceptBtnOn: { borderColor: colors.green, backgroundColor: '#00e67615' },
  autoAcceptText: { fontSize: 9, color: colors.dim, letterSpacing: 2, fontFamily: 'monospace', fontWeight: '700' },
  autoAcceptTextOn: { color: colors.green },

  // Empty state (inline, not full-screen)
  emptyInline: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 20 },
  inlineStartBtn: { backgroundColor: colors.green, borderRadius: 4, paddingVertical: 12, paddingHorizontal: 32, marginTop: 16 },

  // Active task card
  activeTaskCard: { borderLeftWidth: 3, borderLeftColor: colors.amber, marginBottom: 10 },
  taskStatusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  taskStatusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.amber, marginRight: 6 },
  taskStatusText: { fontSize: 9, color: colors.amber, letterSpacing: 2, fontFamily: 'monospace', fontWeight: '700' },
  activeTaskActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  resumeBtn: { borderWidth: 1, borderColor: colors.green + '80', borderRadius: 3, paddingHorizontal: 12, paddingVertical: 6 },
  resumeText: { fontSize: 10, color: colors.green, fontWeight: '700', letterSpacing: 2, fontFamily: 'monospace' },
  giveUpBtn: { borderWidth: 1, borderColor: colors.red + '60', borderRadius: 3, paddingHorizontal: 12, paddingVertical: 6 },
  giveUpText: { fontSize: 10, color: colors.red, fontWeight: '700', letterSpacing: 2, fontFamily: 'monospace' },
  }), [colors]);
}
