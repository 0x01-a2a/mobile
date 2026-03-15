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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { launchImageLibrary } from 'react-native-image-picker';
import {
  useInbox, InboundEnvelope, sendEnvelope, executeJupiterSwap, useTradeQuote,
  bagsLaunch, bagsClaim, useBagsPositions, useBagsConfig, usePhantomBalance,
  usePortfolioHistory, usePeers, PortfolioEvent,
  BagsLaunchParams, BagsToken,
} from '../hooks/useNodeApi';
import { useOwnedAgents, OwnedAgent } from '../hooks/useOwnedAgents';
import { useNode } from '../hooks/useNode';
import { useZeroclawChat } from '../hooks/useZeroclawChat';
import { useAgentBrain } from '../hooks/useAgentBrain';
import { NodeStatusBanner } from '../components/NodeStatusBanner';

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

const C = {
  bg: '#050505',
  card: '#0f0f0f',
  border: '#1a1a1a',
  green: '#00e676',
  red: '#ff1744',
  amber: '#ffc107',
  text: '#ffffff',
  sub: '#555555',
  dim: '#333333',
  blue: '#2979ff',
};

// ── Types ─────────────────────────────────────────────────────────────────

interface ProposalTerms {
  description?: string;
  reward?: string;
  escrow_amount_usdc?: number;
  quest?: string;
  from?: string;
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

// ── Leaderboard types ─────────────────────────────────────────────────────

interface LeaderboardToken {
  mint: string;
  name: string;
  symbol: string;
  priceUsd: number;
  volume24h: number;
  priceChange24h: number;
  marketCap: number;
}

// ── Token whitelist (mirrors node SWAP_WHITELIST) ─────────────────────────

const SWAP_TOKENS = [
  { label: 'SOL',  mint: 'So11111111111111111111111111111111111111112',   decimals: 9 },
  { label: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  { label: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
  { label: 'JUP',  mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  decimals: 6 },
  { label: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 },
  { label: 'RAY',  mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',  decimals: 6 },
  { label: 'WIF',  mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',  decimals: 6 },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────

function decodeTerms(payloadB64: string): ProposalTerms | null {
  try {
    if (payloadB64.length > 65536) return null; // ~48KB decoded max
    const json = JSON.parse(atob(payloadB64));
    return json?.terms ?? json ?? null;
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
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.overlay} onPress={onClose} />
      <View style={s.sheet}>
        <Text style={s.sheetTitle}>ASSIGN TO AGENT</Text>
        {agents.map(a => (
          <TouchableOpacity
            key={a.id || a.mode}
            style={s.agentRow}
            onPress={() => onSelect(a)}
            activeOpacity={0.7}
          >
            <View>
              <Text style={s.agentName}>{a.name}</Text>
              <Text style={s.agentId}>{a.id ? shortId(a.id) : 'starting…'}</Text>
            </View>
            <View style={[s.badge, a.mode === 'local' ? s.badgeLocal : s.badgeHosted]}>
              <Text style={s.badgeText}>
                {a.mode === 'local' ? 'PHONE' : 'HOSTED'}
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
}: {
  bounty: Bounty;
  onAccept: () => void;
  onSkip: () => void;
}) {
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
    <View style={[s.card, urgent && { borderColor: C.red }]}>
      <Text style={s.desc} numberOfLines={4}>
        {bounty.terms.description ?? 'No description'}
      </Text>
      <View style={s.meta}>
        <Text style={s.reward}>{rewardLabel(bounty.terms)}</Text>
        <Text style={s.dot}> · </Text>
        <Text style={s.from}>
          from {shortId(bounty.terms.from ?? bounty.sender)}
        </Text>
        <Text style={s.dot}> · </Text>
        <Text style={s.time}>{timeAgo(bounty.receivedAt)}</Text>
        {remainStr !== null && (
          <>
            <Text style={s.dot}> · </Text>
            <Text style={[s.time, urgent && { color: C.red }]}>{remainStr}</Text>
          </>
        )}
      </View>
      <View style={s.actions}>
        <TouchableOpacity style={s.skipBtn} onPress={onSkip} activeOpacity={0.7}>
          <Text style={s.skipText}>SKIP</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.acceptBtn} onPress={onAccept} activeOpacity={0.8}>
          <Text style={s.acceptText}>ACCEPT</Text>
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
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={{ fontSize: 9, color: C.sub, letterSpacing: 2, fontFamily: 'monospace', marginBottom: 4 }}>
        {label}{optional ? ' (optional)' : ''}
      </Text>
      <TextInput
        style={{
          backgroundColor: C.bg,
          borderWidth: 1,
          borderColor: C.dim,
          borderRadius: 3,
          color: C.text,
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
        placeholderTextColor={C.dim}
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
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const agents = useOwnedAgents().filter(a => a.mode !== 'linked');
  const { status, start } = useNode();
  const [bounties, setBounties] = useState<Bounty[]>([]);
  const [pickerTarget, setPickerTarget] = useState<Bounty | null>(null);
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [activeTab, setActiveTab] = useState<'bounty' | 'trade' | 'leaderboard'>('bounty');
  const [bagsExpanded, setBagsExpanded] = useState(false);

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
  const [inputIdx, setInputIdx] = useState(1);  // USDC
  const [outputIdx, setOutputIdx] = useState(0); // SOL
  const [pickerFor, setPickerFor] = useState<'input' | 'output' | null>(null);

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

  // ── Leaderboard ────────────────────────────────────────────────────────────
  const phantom = usePhantomBalance();
  const [leaderboardData, setLeaderboardData] = useState<LeaderboardToken[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardSort, setLeaderboardSort] = useState<'volume' | 'change'>('volume');
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const [bountyRefreshing, setBountyRefreshing] = useState(false);

  // Merge mint sources: Phantom SPL holdings + Bags API positions (deduplicated).
  // This way tokens show up even without a Bags API key configured.
  const allMints = useMemo(() => {
    const set = new Set<string>();
    for (const t of phantom.splTokens) set.add(t.mint);
    for (const t of bagsPositions) set.add(t.token_mint);
    // Exclude stablecoins — they're not tradeable tokens for the leaderboard.
    set.delete('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC mainnet
    set.delete('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'); // USDC devnet
    set.delete('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'); // USDT
    return [...set];
  }, [phantom.splTokens, bagsPositions]);

  const fetchLeaderboard = useCallback(async (attempt = 0) => {
    if (allMints.length === 0) {
      setLeaderboardData([]);
      return;
    }
    setLeaderboardLoading(true);
    setLeaderboardError(null);
    try {
      const mints = allMints.join(',');
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) { setLeaderboardData([]); return; }
      const byMint = new Map<string, LeaderboardToken>();
      for (const pair of data) {
        const mint: string = pair.baseToken?.address ?? '';
        if (!mint) continue;
        const entry: LeaderboardToken = {
          mint,
          name: pair.baseToken?.name ?? '',
          symbol: pair.baseToken?.symbol ?? '',
          priceUsd: parseFloat(pair.priceUsd ?? '0') || 0,
          volume24h: pair.volume?.h24 ?? 0,
          priceChange24h: pair.priceChange?.h24 ?? 0,
          marketCap: pair.marketCap ?? 0,
        };
        const existing = byMint.get(mint);
        if (!existing || entry.volume24h > existing.volume24h) byMint.set(mint, entry);
      }
      setLeaderboardData([...byMint.values()]);
    } catch (e: any) {
      if (attempt < 3) {
        // Retry with backoff — don't surface error to user on transient failures.
        setTimeout(() => fetchLeaderboard(attempt + 1), (attempt + 1) * 2_000);
      } else {
        setLeaderboardError(e?.message ?? 'Failed to load data. Pull to refresh.');
        setLeaderboardData([]);
      }
    }
    setLeaderboardLoading(false);
  }, [allMints]);

  // Re-fetch leaderboard when tab is active OR when allMints populates after RPC load.
  useEffect(() => {
    if (activeTab === 'leaderboard' && allMints.length > 0) fetchLeaderboard();
  }, [activeTab, fetchLeaderboard, allMints]);

  const sortedLeaderboard = [...leaderboardData].sort((a, b) =>
    leaderboardSort === 'volume' ? b.volume24h - a.volume24h : b.priceChange24h - a.priceChange24h,
  );

  const handlePickImage = useCallback(() => {
    launchImageLibrary(
      { mediaType: 'photo', includeBase64: true, quality: 0.8, maxWidth: 1024, maxHeight: 1024 },
      (response) => {
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
      Alert.alert('Missing Fields', 'Name, symbol and description are required.');
      return;
    }
    Alert.alert(
      'Launch Token',
      `Launch ${launchSymbol.toUpperCase()} on Bags.fm?\n\nThis will sign and broadcast transactions on Solana.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'LAUNCH',
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
                'Token Launched',
                `${launchSymbol.toUpperCase()} is live!\nMint: ${shortId(res.token_mint)}\nTx: ${shortId(res.txid)}`,
              );
              // Reset form
              setLaunchName(''); setLaunchSymbol(''); setLaunchDesc('');
              setLaunchImageBytes(null); setLaunchImageName(null);
              setLaunchWebUrl(''); setLaunchTwitter('');
              setLaunchTelegram(''); setLaunchInitialBuy('');
            } catch (e: any) {
              Alert.alert('Launch Failed', e?.message ?? 'Unknown error');
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
      'Claim Fees',
      `Claim accumulated Bags pool fees for ${token.symbol}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'CLAIM',
          onPress: async () => {
            setClaiming(token.token_mint);
            try {
              const res = await bagsClaim(token.token_mint);
              Alert.alert(
                'Claimed',
                `${res.claimed_txs} transaction${res.claimed_txs !== 1 ? 's' : ''} submitted.\n~${(res.total_claimed_usdc / 1e6).toFixed(4)} USDC claimed.`,
              );
            } catch (e: any) {
              Alert.alert('Claim Failed', e?.message ?? 'Unknown error');
            } finally {
              setClaiming(null);
            }
          },
        },
      ],
    );
  }, []);

  const inputToken  = SWAP_TOKENS[inputIdx];
  const outputToken = SWAP_TOKENS[outputIdx];

  const { quote, loading: quoteLoading } = useTradeQuote({
    inputMint:  inputToken.mint,
    outputMint: outputToken.mint,
    amount: (Number(swapAmount) || 0) * 10 ** inputToken.decimals,
  });

  const handleSwap = useCallback(async () => {
    if (!swapAmount || isNaN(Number(swapAmount)) || !quote) return;
    const outAmount = parseFloat(quote.outAmount) / 10 ** outputToken.decimals;
    Alert.alert(
      'Confirm Swap',
      `Swap ${swapAmount} ${inputToken.label} for ~${outAmount.toFixed(6)} ${outputToken.label}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'SWAP',
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
              Alert.alert('Swap Failed', 'Execution failed. Check your balance for gas or Kora status.');
            }
          },
        },
      ],
    );
  }, [swapAmount, quote, inputToken, outputToken, injectSystemMessage, navigation]);

  const refreshBountyTab = useCallback(async () => {
    setBountyRefreshing(true);
    const val = await AsyncStorage.getItem('zerox1:8004_registered');
    setRegistered(val === 'true');
    setBountyRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      AsyncStorage.getItem('zerox1:8004_registered').then(val => {
        setRegistered(val === 'true');
      });
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
      Alert.alert('Error', 'Failed to send ACCEPT. Check node connection and try again.');
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

  const isRunning = status === 'running';

  if (registered === false) {
    return (
      <View style={s.root}>
        <View style={[s.header, { paddingTop: insets.top + 16 }]}>
          <Text style={s.title}>EARN</Text>
          <Text style={s.sub}>registration required</Text>
        </View>

        <View style={s.empty}>
          <Text style={s.emptyText}>
            You must register your agent on the Solana 8004 network to participate in earning activities.
          </Text>
          <TouchableOpacity
            style={s.settingsBtn}
            onPress={() => navigation.navigate('Settings')}
          >
            <Text style={s.acceptText}>GO TO SETTINGS</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <NodeStatusBanner />
      {/* Tab Header */}
      <View style={[s.header, { paddingTop: insets.top + 16 }]}>
        <View style={s.tabRow}>
          <TouchableOpacity
            style={[s.tabBtn, activeTab === 'bounty' && s.tabActive]}
            onPress={() => setActiveTab('bounty')}
          >
            <Text style={[s.tabText, activeTab === 'bounty' && s.tabTextActive]}>BOUNTY</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.tabBtn, activeTab === 'trade' && s.tabActive]}
            onPress={() => setActiveTab('trade')}
          >
            <Text style={[s.tabText, activeTab === 'trade' && s.tabTextActive]}>TRADE</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.tabBtn, activeTab === 'leaderboard' && s.tabActive]}
            onPress={() => setActiveTab('leaderboard')}
          >
            <Text style={[s.tabText, activeTab === 'leaderboard' && s.tabTextActive]}>TOP</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Bounty Tab */}
      {activeTab === 'bounty' && (
        <>
          {/* ── Earnings summary bar ─────────────────────────────── */}
          <View style={s.earningsBar}>
            <View style={s.earningStat}>
              <Text style={s.earningVal}>
                ${earningsSummary.totalUsdc >= 1
                  ? earningsSummary.totalUsdc.toFixed(2)
                  : earningsSummary.totalUsdc.toFixed(4)}
              </Text>
              <Text style={s.earningLabel}>EARNED</Text>
            </View>
            <View style={s.earningDivider} />
            <View style={s.earningStat}>
              <Text style={s.earningVal}>{activeTasks.length}</Text>
              <Text style={s.earningLabel}>ACTIVE</Text>
            </View>
            <View style={s.earningDivider} />
            <View style={s.earningStat}>
              <Text style={s.earningVal}>{earningsSummary.bountyCount}</Text>
              <Text style={s.earningLabel}>COMPLETED</Text>
            </View>
          </View>

          {/* ── Auto-accept toggle + status ──────────────────────── */}
          <View style={s.autoAcceptRow}>
            <TouchableOpacity
              style={[s.autoAcceptBtn, autoAcceptOn && s.autoAcceptBtnOn]}
              onPress={toggleAutoAccept}
              activeOpacity={0.7}
            >
              <Text style={[s.autoAcceptText, autoAcceptOn && s.autoAcceptTextOn]}>
                AUTO-ACCEPT {autoAcceptOn ? 'ON' : 'OFF'}
              </Text>
            </TouchableOpacity>
            <Text style={s.sub}>
              {isRunning
                ? `${peers.length} peer${peers.length !== 1 ? 's' : ''} · ${bounties.length > 0 ? `${bounties.length} pending` : 'listening…'}`
                : 'node offline'}
            </Text>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={s.list}
            refreshControl={
              <RefreshControl
                refreshing={bountyRefreshing}
                onRefresh={refreshBountyTab}
                tintColor={C.green}
                colors={[C.green]}
              />
            }
          >
            {/* ── Context-aware empty / node start ─────────────────── */}
            {!isRunning && bounties.length === 0 && activeTasks.length === 0 && completedTasks.length === 0 && (
              <View style={s.emptyInline}>
                <Text style={s.emptyText}>
                  Your node is offline.{'\n'}Start it to receive bounties from the mesh.
                </Text>
                <TouchableOpacity
                  style={s.inlineStartBtn}
                  onPress={() => start()}
                  activeOpacity={0.8}
                >
                  <Text style={s.acceptText}>START NODE</Text>
                </TouchableOpacity>
              </View>
            )}

            {isRunning && bounties.length === 0 && activeTasks.length === 0 && completedTasks.length === 0 && (
              <View style={s.emptyInline}>
                <Text style={s.emptyText}>
                  Listening for bounties…{'\n\n'}Tasks from agents on the mesh will appear here.
                  {autoAcceptOn ? '\nAuto-accept is on — matching tasks will be taken automatically.' : ''}
                </Text>
              </View>
            )}

            {/* ── Active tasks ──────────────────────────────────────── */}
            {activeTasks.length > 0 && (
              <>
                <Text style={s.sectionLabel}>ACTIVE TASKS</Text>
                {activeTasks.map(t => (
                  <View key={t.conversationId} style={[s.card, s.activeTaskCard]}>
                    <View style={s.taskStatusRow}>
                      <View style={s.taskStatusDot} />
                      <Text style={s.taskStatusText}>
                        {t.status === 'delivered' ? 'DELIVERED' : 'IN PROGRESS'}
                      </Text>
                    </View>
                    <Text style={s.desc} numberOfLines={2}>{t.description}</Text>
                    <View style={s.meta}>
                      <Text style={s.reward}>{t.reward}</Text>
                      <Text style={s.dot}> · </Text>
                      <Text style={s.from}>from {shortId(t.fromAgent)}</Text>
                      <Text style={s.dot}> · </Text>
                      <Text style={s.time}>{timeAgo(t.acceptedAt)}</Text>
                    </View>
                  </View>
                ))}
              </>
            )}

            {/* ── Pending bounties ──────────────────────────────────── */}
            {bounties.length > 0 && (
              <>
                <Text style={[s.sectionLabel, activeTasks.length > 0 && { marginTop: 20 }]}>INCOMING BOUNTIES</Text>
                {bounties.map(item => (
                  <BountyCard
                    key={item.conversationId}
                    bounty={item}
                    onAccept={() => handleAccept(item)}
                    onSkip={() => handleSkip(item)}
                  />
                ))}
              </>
            )}

            {/* ── Completed tasks ───────────────────────────────────── */}
            {completedTasks.length > 0 && (
              <>
                <Text style={[s.sectionLabel, { marginTop: 20 }]}>COMPLETED</Text>
                {completedTasks.map(t => (
                  <View key={t.conversationId} style={[s.card, { marginBottom: 8, opacity: 0.7 }]}>
                    <Text style={s.desc} numberOfLines={1}>{t.description}</Text>
                    <View style={s.meta}>
                      <Text style={s.reward}>{t.reward}</Text>
                      <Text style={s.dot}> · </Text>
                      <Text style={s.from}>from {shortId(t.fromAgent)}</Text>
                      <Text style={s.dot}> · </Text>
                      <Text style={[s.time, { color: C.green }]}>done</Text>
                    </View>
                  </View>
                ))}
              </>
            )}
          </ScrollView>

          {pickerTarget && (
            <AgentPicker
              agents={agents}
              onSelect={a => assignAndNavigate(pickerTarget, a)}
              onClose={() => setPickerTarget(null)}
            />
          )}
        </>
      )}

      {/* Trade Tab */}
      {activeTab === 'trade' && (
        <ScrollView style={s.tradeRoot} contentContainerStyle={s.tradeContent}>
          <Text style={s.sectionLabel}>JUPITER SWAP</Text>
          <View style={s.card}>
            <Text style={s.sub}>Swap using your agent's hot wallet. Whitelisted tokens only.</Text>

            <View style={s.swapBox}>
              <Text style={s.tradeLabel}>From:</Text>
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
                  placeholderTextColor={C.dim}
                />
              </View>

              <View style={s.swapIconRow}>
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => {
                    setInputIdx(outputIdx);
                    setOutputIdx(inputIdx);
                  }}
                >
                  <Text style={s.swapIcon}>⇅</Text>
                </TouchableOpacity>
              </View>

              <Text style={s.tradeLabel}>To:</Text>
              <View style={[s.tradeInputRow, { paddingVertical: 14 }]}>
                <TouchableOpacity onPress={() => setPickerFor('output')} activeOpacity={0.7}>
                  <Text style={[s.tradeTokenBadge, s.tradeTokenTap]}>{outputToken.label} ▾</Text>
                </TouchableOpacity>
                {quoteLoading ? (
                  <ActivityIndicator size="small" color={C.green} />
                ) : quote ? (
                  <Text style={s.tradeInputVal}>
                    {(parseFloat(quote.outAmount) / 10 ** outputToken.decimals).toFixed(6)}
                  </Text>
                ) : (
                  <Text style={[s.tradeInputVal, { color: C.dim }]}>—</Text>
                )}
              </View>

              {quote && quote.priceImpactPct !== undefined && (
                <View style={s.impactRow}>
                  <Text style={s.impactLabel}>Price Impact:</Text>
                  <Text style={[s.impactVal, quote.priceImpactPct > 1 ? { color: C.red } : { color: C.green }]}>
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
              <Text style={s.swapBtnText}>{swapping ? 'SWAPPING…' : 'SWAP'}</Text>
            </TouchableOpacity>
          </View>

          {/* ── BAGS.FM collapsible section ─────────────────────────────── */}
          <TouchableOpacity
            style={s.sectionToggle}
            activeOpacity={0.7}
            onPress={() => setBagsExpanded(e => !e)}
          >
            <Text style={s.sectionLabel}>BAGS.FM</Text>
            <Text style={s.toggleChevron}>{bagsExpanded ? '▲' : '▼'}</Text>
          </TouchableOpacity>

          {bagsExpanded && (
            !bagsApiConfigured ? (
              <View style={s.bagsNotConfigured}>
                <Text style={s.emptyText}>
                  {'Set a Bags API key in Settings to\nlaunch and manage tokens.'}
                </Text>
                <TouchableOpacity
                  style={[s.settingsBtn, { marginTop: 12 }]}
                  onPress={() => navigation.navigate('Settings')}
                >
                  <Text style={s.acceptText}>GO TO SETTINGS</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                {/* Launch form */}
                <Text style={[s.sectionLabel, { marginTop: 12, marginBottom: 8 }]}>LAUNCH TOKEN</Text>
                <View style={s.card}>
                  <BagsField label="NAME" value={launchName} onChange={setLaunchName} placeholder="My Token" />
                  <BagsField label="SYMBOL" value={launchSymbol} onChange={v => setLaunchSymbol(v.toUpperCase())} placeholder="TKN" maxLength={10} />
                  <BagsField label="DESCRIPTION" value={launchDesc} onChange={setLaunchDesc} placeholder="A token for…" multiline />
                  {/* Image picker */}
                  <View style={{ marginBottom: 12 }}>
                    <Text style={{ fontSize: 9, color: C.sub, letterSpacing: 2, fontFamily: 'monospace', marginBottom: 4 }}>
                      IMAGE (optional)
                    </Text>
                    <TouchableOpacity
                      style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: C.bg, borderWidth: 1, borderColor: C.dim, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 8, gap: 8 }}
                      onPress={handlePickImage}
                      activeOpacity={0.7}
                    >
                      <Text style={{ fontSize: 13, color: launchImageBytes ? C.green : C.dim, fontFamily: 'monospace', flex: 1 }} numberOfLines={1}>
                        {launchImageName ?? 'Tap to pick image…'}
                      </Text>
                      {launchImageBytes && (
                        <TouchableOpacity onPress={() => { setLaunchImageBytes(null); setLaunchImageName(null); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <Text style={{ fontSize: 11, color: C.red, fontFamily: 'monospace' }}>✕</Text>
                        </TouchableOpacity>
                      )}
                    </TouchableOpacity>
                  </View>
                  <BagsField label="WEBSITE" value={launchWebUrl} onChange={setLaunchWebUrl} placeholder="https://…" optional />
                  <BagsField label="TWITTER" value={launchTwitter} onChange={setLaunchTwitter} placeholder="https://x.com/…" optional />
                  <BagsField label="TELEGRAM" value={launchTelegram} onChange={setLaunchTelegram} placeholder="https://t.me/…" optional />
                  <BagsField label="INITIAL BUY (SOL)" value={launchInitialBuy} onChange={setLaunchInitialBuy} placeholder="0 (skip)" optional keyboardType="decimal-pad" />
                  <TouchableOpacity
                    style={[s.swapBtn, (launching || !launchName.trim() || !launchSymbol.trim() || !launchDesc.trim()) && { opacity: 0.4 }]}
                    activeOpacity={0.8}
                    onPress={handleBagsLaunch}
                    disabled={launching || !launchName.trim() || !launchSymbol.trim() || !launchDesc.trim()}
                  >
                    <Text style={s.swapBtnText}>{launching ? 'LAUNCHING…' : 'LAUNCH ON BAGS.FM'}</Text>
                  </TouchableOpacity>
                </View>

                {/* Positions */}
                {bagsPositions.length > 0 && (
                  <>
                    <Text style={[s.sectionLabel, { marginTop: 20 }]}>MY TOKENS</Text>
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
                            <Text style={s.acceptText}>{claiming === token.token_mint ? '…' : 'CLAIM'}</Text>
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
              refreshing={leaderboardLoading}
              onRefresh={fetchLeaderboard}
              tintColor={C.green}
              colors={[C.green]}
            />
          }
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={s.sectionLabel}>BAGS TOKEN RANKINGS</Text>
            <TouchableOpacity onPress={() => fetchLeaderboard()} disabled={leaderboardLoading}>
              <Text style={{ fontSize: 9, color: C.sub, fontFamily: 'monospace', letterSpacing: 2 }}>
                {leaderboardLoading ? '…' : 'REFRESH'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Sort toggles */}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
            {(['volume', 'change'] as const).map(mode => (
              <TouchableOpacity
                key={mode}
                style={[s.sortBtn, leaderboardSort === mode && s.sortBtnActive]}
                onPress={() => setLeaderboardSort(mode)}
                activeOpacity={0.7}
              >
                <Text style={[s.sortBtnText, leaderboardSort === mode && s.sortBtnTextActive]}>
                  {mode === 'volume' ? '24H VOL' : '24H CHANGE'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {leaderboardError ? (
            <View style={{ backgroundColor: '#1a0505', borderWidth: 1, borderColor: C.red, borderRadius: 4, padding: 12, marginBottom: 12 }}>
              <Text style={{ color: C.red, fontFamily: 'monospace', fontSize: 11 }}>{leaderboardError}</Text>
            </View>
          ) : null}

          {leaderboardLoading && leaderboardData.length === 0 ? (
            <ActivityIndicator color={C.green} style={{ marginTop: 40 }} />
          ) : sortedLeaderboard.length === 0 ? (
            <View style={s.empty}>
              <Text style={s.emptyText}>
                {allMints.length === 0
                  ? (phantom.address
                    ? 'No tokens found in your wallet.\n\nLaunch a token in the TRADE tab.'
                    : 'Connect Phantom in Settings to see your tokens.')
                  : 'No market data available yet.\n\nTokens may not be listed on DexScreener yet.'}
              </Text>
            </View>
          ) : (
            sortedLeaderboard.map((token, i) => {
              const changePos = token.priceChange24h >= 0;
              const changeColor = changePos ? C.green : C.red;
              return (
                <View key={token.mint} style={[s.card, { marginBottom: 10 }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Text style={s.rankNum}>#{i + 1}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={s.agentName}>{token.name || token.symbol}</Text>
                      <Text style={s.agentId}>{token.symbol} · {shortId(token.mint)}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={[s.lbPrice, !token.priceUsd && { color: C.sub }]}>
                        {token.priceUsd ? `$${token.priceUsd < 0.01 ? token.priceUsd.toExponential(2) : token.priceUsd.toFixed(4)}` : '—'}
                      </Text>
                      <Text style={[s.lbChange, { color: changeColor }]}>
                        {token.priceChange24h !== 0 ? `${changePos ? '+' : ''}${token.priceChange24h.toFixed(2)}%` : '—'}
                      </Text>
                    </View>
                  </View>
                  {token.volume24h > 0 && (
                    <View style={s.lbMetaRow}>
                      <Text style={s.lbMetaLabel}>VOL 24H</Text>
                      <Text style={s.lbMetaVal}>${token.volume24h >= 1000 ? `${(token.volume24h / 1000).toFixed(1)}K` : token.volume24h.toFixed(0)}</Text>
                      {token.marketCap > 0 && (
                        <>
                          <Text style={s.lbMetaDot}> · </Text>
                          <Text style={s.lbMetaLabel}>MCAP</Text>
                          <Text style={s.lbMetaVal}>${token.marketCap >= 1e6 ? `${(token.marketCap / 1e6).toFixed(1)}M` : token.marketCap >= 1000 ? `${(token.marketCap / 1000).toFixed(1)}K` : token.marketCap.toFixed(0)}</Text>
                        </>
                      )}
                    </View>
                  )}
                </View>
              );
            })
          )}
        </ScrollView>
      )}

      {/* Token picker modal */}
      {pickerFor && (
        <Modal transparent animationType="slide" onRequestClose={() => setPickerFor(null)}>
          <Pressable style={s.overlay} onPress={() => setPickerFor(null)} />
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>SELECT TOKEN</Text>
            {SWAP_TOKENS.map((t, i) => {
              const isOtherSide = pickerFor === 'input' ? i === outputIdx : i === inputIdx;
              return (
                <TouchableOpacity
                  key={t.mint}
                  style={[s.agentRow, isOtherSide && { opacity: 0.3 }]}
                  onPress={() => {
                    if (isOtherSide) return;
                    if (pickerFor === 'input') setInputIdx(i);
                    else setOutputIdx(i);
                    setPickerFor(null);
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={s.agentName}>{t.label}</Text>
                  <Text style={s.agentId}>{t.mint.slice(0, 8)}…</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Modal>
      )}

    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 20, paddingTop: 16, borderBottomWidth: 1, borderBottomColor: C.border },
  tabRow: { flexDirection: 'row', gap: 24, paddingBottom: 0 },
  tabBtn: { paddingBottom: 12, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: C.green },
  tabText: { fontSize: 13, fontWeight: '700', color: C.dim, letterSpacing: 2, fontFamily: 'monospace' },
  tabTextActive: { color: C.text },
  subHeader: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  title: { fontSize: 13, fontWeight: '700', color: C.text, letterSpacing: 3, fontFamily: 'monospace' },
  sub: { fontSize: 11, color: C.sub, fontFamily: 'monospace' },
  list: { padding: 16, gap: 12 },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 16 },
  desc: { fontSize: 14, color: C.text, fontFamily: 'monospace', lineHeight: 20, marginBottom: 10 },
  meta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 },
  reward: { fontSize: 11, color: C.green, fontFamily: 'monospace', fontWeight: '700' },
  dot: { fontSize: 11, color: C.dim },
  from: { fontSize: 11, color: C.sub, fontFamily: 'monospace' },
  time: { fontSize: 11, color: C.sub, fontFamily: 'monospace' },
  actions: { flexDirection: 'row', gap: 10 },
  skipBtn: { flex: 1, borderWidth: 1, borderColor: C.dim, borderRadius: 3, paddingVertical: 9, alignItems: 'center' },
  skipText: { fontSize: 11, color: C.sub, letterSpacing: 2, fontWeight: '700' },
  acceptBtn: { flex: 2, backgroundColor: C.green, borderRadius: 3, paddingVertical: 9, alignItems: 'center' },
  acceptText: { fontSize: 11, color: '#000', letterSpacing: 2, fontWeight: '700' },
  settingsBtn: { backgroundColor: C.green, borderRadius: 3, paddingVertical: 10, paddingHorizontal: 28, alignItems: 'center', marginTop: 16 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  emptyText: { color: C.sub, fontFamily: 'monospace', textAlign: 'center', lineHeight: 22, fontSize: 13 },
  // agent picker
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: { backgroundColor: '#111', borderTopWidth: 1, borderTopColor: C.border, padding: 24, gap: 4 },
  sheetTitle: { fontSize: 11, color: C.sub, letterSpacing: 3, marginBottom: 12, fontFamily: 'monospace' },
  agentRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.border },
  agentName: { fontSize: 14, color: C.text, fontFamily: 'monospace', fontWeight: '700' },
  agentId: { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginTop: 2 },
  badge: { borderRadius: 3, paddingHorizontal: 8, paddingVertical: 3 },
  badgeLocal: { backgroundColor: C.green + '20', borderWidth: 1, borderColor: C.green + '60' },
  badgeHosted: { backgroundColor: C.amber + '20', borderWidth: 1, borderColor: C.amber + '60' },
  badgeText: { fontSize: 9, fontWeight: '700', letterSpacing: 2 },

  // Trade TAB
  tradeRoot: { flex: 1 },
  tradeContent: { padding: 20 },
  sectionLabel: { fontSize: 11, color: C.sub, letterSpacing: 3, marginBottom: 10, marginTop: 4, fontFamily: 'monospace' },
  swapBox: { backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 14, marginTop: 16, marginBottom: 16 },
  tradeLabel: { fontSize: 10, color: C.sub, fontFamily: 'monospace', letterSpacing: 1, marginBottom: 8 },
  tradeInputRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#111', padding: 12, borderRadius: 3, borderWidth: 1, borderColor: C.dim },
  tradeTokenBadge: { fontSize: 14, color: C.text, fontWeight: '700', fontFamily: 'monospace' },
  tradeTokenTap: { color: C.green, borderWidth: 1, borderColor: C.green + '60', borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4 },
  tradeInputVal: { fontSize: 18, color: C.text, fontFamily: 'monospace' },
  swapIconRow: { alignItems: 'center', paddingVertical: 8 },
  swapIcon: { fontSize: 16, color: C.dim, fontFamily: 'monospace', fontWeight: '700' },
  swapBtn: { backgroundColor: C.blue || '#2979ff', borderRadius: 4, paddingVertical: 14, alignItems: 'center' },
  swapBtnText: { fontSize: 12, fontWeight: '700', color: '#fff', letterSpacing: 2, fontFamily: 'monospace' },
  impactRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, paddingHorizontal: 4 },
  impactLabel: { fontSize: 10, color: C.sub, fontFamily: 'monospace' },
  impactVal: { fontSize: 10, fontWeight: '700', fontFamily: 'monospace' },
  // Leaderboard
  rankNum: { fontSize: 16, color: C.sub, fontFamily: 'monospace', fontWeight: '700', width: 28 },
  lbPrice: { fontSize: 13, color: C.text, fontFamily: 'monospace', fontWeight: '700' },
  lbChange: { fontSize: 11, fontFamily: 'monospace', fontWeight: '700', marginTop: 2 },
  lbMetaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border },
  lbMetaLabel: { fontSize: 9, color: C.sub, letterSpacing: 2, fontFamily: 'monospace' },
  lbMetaVal: { fontSize: 11, color: C.text, fontFamily: 'monospace', marginLeft: 4 },
  lbMetaDot: { fontSize: 11, color: C.dim, marginHorizontal: 4 },
  sortBtn: { paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: C.border, borderRadius: 3 },
  sortBtnActive: { borderColor: C.green, backgroundColor: '#00e67615' },
  sortBtnText: { fontSize: 9, color: C.sub, letterSpacing: 2, fontFamily: 'monospace', fontWeight: '700' },
  sortBtnTextActive: { color: C.green },
  // Bags collapsible
  sectionToggle: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 24, marginBottom: 4 },
  toggleChevron: { fontSize: 10, color: C.sub, fontFamily: 'monospace' },
  bagsNotConfigured: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 20, alignItems: 'center', marginTop: 8 },

  // Earnings summary bar
  earningsBar: { flexDirection: 'row', backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border, paddingVertical: 12, paddingHorizontal: 16 },
  earningStat: { flex: 1, alignItems: 'center' },
  earningVal: { fontSize: 16, fontWeight: '700', color: C.green, fontFamily: 'monospace' },
  earningLabel: { fontSize: 8, color: C.sub, letterSpacing: 2, fontFamily: 'monospace', marginTop: 2 },
  earningDivider: { width: 1, backgroundColor: C.border, marginVertical: 2 },

  // Auto-accept row
  autoAcceptRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  autoAcceptBtn: { borderWidth: 1, borderColor: C.dim, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 4 },
  autoAcceptBtnOn: { borderColor: C.green, backgroundColor: '#00e67615' },
  autoAcceptText: { fontSize: 9, color: C.dim, letterSpacing: 2, fontFamily: 'monospace', fontWeight: '700' },
  autoAcceptTextOn: { color: C.green },

  // Empty state (inline, not full-screen)
  emptyInline: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 20 },
  inlineStartBtn: { backgroundColor: C.green, borderRadius: 4, paddingVertical: 12, paddingHorizontal: 32, marginTop: 16 },

  // Active task card
  activeTaskCard: { borderLeftWidth: 3, borderLeftColor: C.amber, marginBottom: 10 },
  taskStatusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  taskStatusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.amber, marginRight: 6 },
  taskStatusText: { fontSize: 9, color: C.amber, letterSpacing: 2, fontFamily: 'monospace', fontWeight: '700' },
});
