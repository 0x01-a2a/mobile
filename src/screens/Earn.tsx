/**
 * Earn — bounty feed.
 *
 * Listens for incoming PROPOSE envelopes, shows them as actionable bounty
 * cards. User picks which agent handles the task, ACCEPT is sent, then
 * the app routes to Chat with the task loaded as context.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Linking,
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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { launchImageLibrary } from 'react-native-image-picker';
import {
  useInbox, InboundEnvelope, sendEnvelope, executeJupiterSwap, useTradeQuote,
  bagsLaunch, bagsClaim, useBagsPositions, useBagsConfig,
  BagsLaunchParams, BagsToken,
} from '../hooks/useNodeApi';
import { useOwnedAgents, OwnedAgent } from '../hooks/useOwnedAgents';
import { useNode } from '../hooks/useNode';
import { useZeroclawChat } from '../hooks/useZeroclawChat';
import { NodeStatusBanner } from '../components/NodeStatusBanner';

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

// ── Campaign ──────────────────────────────────────────────────────────────

const CAMPAIGN_END_DATE = new Date('2026-04-15T23:59:59Z');

type TrackId = 'design' | 'launch' | 'social';
type TrackStatus = 'pending' | 'submitted' | 'claimed';

interface CampaignSubmission {
  status: TrackStatus;
  submittedAt?: number;
}

const CAMPAIGN_STORAGE_KEY = 'zerox1:campaign_01pilot_v1';

interface CampaignState {
  design: CampaignSubmission;
  launch: CampaignSubmission;
  social: CampaignSubmission;
}

const DEFAULT_CAMPAIGN_STATE: CampaignState = {
  design:  { status: 'pending' },
  launch:  { status: 'pending' },
  social:  { status: 'pending' },
};

function daysLeft(): number {
  return Math.max(0, Math.ceil((CAMPAIGN_END_DATE.getTime() - Date.now()) / 86_400_000));
}

// ── Campaign track card ────────────────────────────────────────────────────

function CampaignTrackCard({
  icon,
  title,
  rewardLine,
  description,
  requirements,
  submission,
  ctaLabel,
  onCta,
}: {
  icon: string;
  title: string;
  rewardLine: string;
  description: string;
  requirements: string[];
  submission: CampaignSubmission;
  ctaLabel: string;
  onCta: () => void;
}) {
  const statusColor =
    submission.status === 'claimed'    ? C.green :
    submission.status === 'submitted'  ? C.amber :
    C.sub;
  const statusLabel =
    submission.status === 'claimed'    ? 'REWARDED' :
    submission.status === 'submitted'  ? 'SUBMITTED' :
    'OPEN';

  return (
    <View style={cs.trackCard}>
      <View style={cs.trackHeader}>
        <Text style={cs.trackIcon}>{icon}</Text>
        <View style={{ flex: 1 }}>
          <Text style={cs.trackTitle}>{title}</Text>
          <Text style={cs.trackReward}>{rewardLine}</Text>
        </View>
        <View style={[cs.statusBadge, { borderColor: statusColor + '80', backgroundColor: statusColor + '15' }]}>
          <Text style={[cs.statusText, { color: statusColor }]}>{statusLabel}</Text>
        </View>
      </View>

      <Text style={cs.trackDesc}>{description}</Text>

      <View style={cs.reqList}>
        {requirements.map((r, i) => (
          <Text key={i} style={cs.reqItem}>{'> '}{r}</Text>
        ))}
      </View>

      {submission.status !== 'claimed' && (
        <TouchableOpacity
          style={[cs.ctaBtn, submission.status === 'submitted' && { opacity: 0.55 }]}
          activeOpacity={0.8}
          onPress={onCta}
          disabled={submission.status === 'submitted'}
        >
          <Text style={cs.ctaText}>
            {submission.status === 'submitted' ? 'AWAITING REVIEW' : ctaLabel}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
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
  return (
    <View style={s.card}>
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
  const navigation = useNavigation<any>();
  const agents = useOwnedAgents().filter(a => a.mode !== 'linked');
  const { status } = useNode();
  const [bounties, setBounties] = useState<Bounty[]>([]);
  const [pickerTarget, setPickerTarget] = useState<Bounty | null>(null);
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [activeTab, setActiveTab] = useState<'bounty' | 'trade' | 'leaderboard' | 'campaign'>('bounty');
  const [bagsExpanded, setBagsExpanded] = useState(false);

  // ── Campaign state ─────────────────────────────────────────────────────────
  const [campaignState, setCampaignState] = useState<CampaignState>(DEFAULT_CAMPAIGN_STATE);
  const [designModalVisible, setDesignModalVisible] = useState(false);
  const [socialModalVisible, setSocialModalVisible] = useState(false);
  const [designImageBytes, setDesignImageBytes] = useState<string | null>(null);
  const [designImageName, setDesignImageName] = useState<string | null>(null);
  const [designNote, setDesignNote] = useState('');
  const [socialPostUrl, setSocialPostUrl] = useState('');
  const campaignPulse = useRef(new Animated.Value(1)).current;

  const { injectSystemMessage } = useZeroclawChat(agents[0]?.id);

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
  const [leaderboardData, setLeaderboardData] = useState<LeaderboardToken[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardSort, setLeaderboardSort] = useState<'volume' | 'change'>('volume');
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const [bountyRefreshing, setBountyRefreshing] = useState(false);

  const fetchLeaderboard = useCallback(async () => {
    if (bagsPositions.length === 0) {
      setLeaderboardData([]);
      return;
    }
    setLeaderboardLoading(true);
    setLeaderboardError(null);
    try {
      const mints = bagsPositions.map(t => t.token_mint).join(',');
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints}`);
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
      setLeaderboardError(e?.message ?? 'Failed to load leaderboard data.');
      setLeaderboardData([]);
    }
    setLeaderboardLoading(false);
  }, [bagsPositions]);

  useEffect(() => {
    if (activeTab === 'leaderboard') fetchLeaderboard();
  }, [activeTab, fetchLeaderboard]);

  // Load/save campaign submission state
  useEffect(() => {
    AsyncStorage.getItem(CAMPAIGN_STORAGE_KEY).then(val => {
      if (val) {
        try { setCampaignState(JSON.parse(val)); } catch { /* ignore */ }
      }
    });
  }, []);

  const saveCampaignState = useCallback((next: CampaignState) => {
    setCampaignState(next);
    AsyncStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  // Pulse animation for the MISSION badge
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(campaignPulse, { toValue: 1.18, duration: 900, useNativeDriver: true }),
        Animated.timing(campaignPulse, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [campaignPulse]);

  const handleDesignPickImage = useCallback(() => {
    launchImageLibrary(
      { mediaType: 'photo', includeBase64: true, quality: 0.8, maxWidth: 1024, maxHeight: 1024 },
      (response) => {
        if (response.didCancel || response.errorCode) return;
        const asset = response.assets?.[0];
        if (!asset?.base64) return;
        setDesignImageBytes(asset.base64);
        setDesignImageName(asset.fileName ?? 'design.jpg');
      },
    );
  }, []);

  const handleDesignSubmit = useCallback(() => {
    if (!designImageBytes) {
      Alert.alert('Missing Image', 'Please pick a token design image to submit.');
      return;
    }
    const next: CampaignState = {
      ...campaignState,
      design: { status: 'submitted', submittedAt: Date.now() },
    };
    saveCampaignState(next);
    setDesignModalVisible(false);
    setDesignImageBytes(null);
    setDesignImageName(null);
    setDesignNote('');
    Alert.alert(
      'Design Submitted',
      'Your token design has been submitted for review. Rewards are distributed within 48h of acceptance.',
    );
  }, [designImageBytes, designNote, campaignState, saveCampaignState]);

  const handleSocialSubmit = useCallback(() => {
    const url = socialPostUrl.trim();
    if (!url.startsWith('https://')) {
      Alert.alert('Invalid URL', 'Enter the full https:// link to your post.');
      return;
    }
    const next: CampaignState = {
      ...campaignState,
      social: { status: 'submitted', submittedAt: Date.now() },
    };
    saveCampaignState(next);
    setSocialModalVisible(false);
    setSocialPostUrl('');
    Alert.alert(
      'Post Submitted',
      'Your social post has been submitted for review. Rewards are sent once engagement is verified (up to 72h).',
    );
  }, [socialPostUrl, campaignState, saveCampaignState]);

  const handleLaunchTrackCta = useCallback(() => {
    setActiveTab('trade');
    setBagsExpanded(true);
    if (campaignState.launch.status === 'pending') {
      const next: CampaignState = {
        ...campaignState,
        launch: { status: 'submitted', submittedAt: Date.now() },
      };
      saveCampaignState(next);
    }
  }, [campaignState, saveCampaignState]);

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
    if (env.msg_type !== 'PROPOSE') return;
    const terms = decodeTerms(env.payload_b64);
    if (!terms) return;
    setBounties(prev => {
      if (prev.some(b => b.conversationId === env.conversation_id)) return prev;
      return [
        {
          conversationId: env.conversation_id,
          sender: env.sender,
          slot: env.slot,
          terms,
          receivedAt: Date.now(),
        },
        ...prev,
      ].slice(0, 50);
    });
  }, []);

  useInbox(onEnvelope, status === 'running');

  const assignAndNavigate = useCallback(async (bounty: Bounty, agent: OwnedAgent) => {
    setPickerTarget(null);
    const ok = await sendEnvelope({
      msg_type: 'ACCEPT',
      recipient: bounty.sender,
      conversation_id: bounty.conversationId,
    });
    if (!ok) {
      Alert.alert('Error', 'Failed to send ACCEPT. Check node connection and try again.');
      return;
    }
    setBounties(prev => prev.filter(b => b.conversationId !== bounty.conversationId));
    navigation.navigate('Chat', {
      agentId: agent.id,
      conversationId: bounty.conversationId,
      task: {
        description: bounty.terms.description ?? 'Task',
        reward: rewardLabel(bounty.terms),
        fromAgent: bounty.terms.from ?? bounty.sender,
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
        <View style={s.header}>
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
      <View style={s.header}>
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
          <TouchableOpacity
            style={[s.tabBtn, activeTab === 'campaign' && s.tabActive]}
            onPress={() => setActiveTab('campaign')}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Text style={[s.tabText, activeTab === 'campaign' && s.tabTextActive]}>MISSION</Text>
              <Animated.View style={[cs.liveDot, { transform: [{ scale: campaignPulse }] }]} />
            </View>
          </TouchableOpacity>
        </View>
      </View>

      {/* Bounty Tab */}
      {activeTab === 'bounty' && (
        <>
          <View style={s.subHeader}>
            <Text style={s.sub}>
              {isRunning
                ? bounties.length > 0
                  ? `${bounties.length} open ${bounties.length === 1 ? 'bounty' : 'bounties'}`
                  : 'listening for bounties…'
                : 'start node to receive bounties'}
            </Text>
          </View>
          {bounties.length === 0 ? (
            <View style={s.empty}>
              <Text style={s.emptyText}>
                {isRunning
                  ? 'No bounties yet.\n\nBounties appear when agents on the\nmesh broadcast tasks your way.'
                  : 'Your node is not running.\n\nGo to My Node to start it.'}
              </Text>
            </View>
          ) : (
            <FlatList
              data={bounties}
              keyExtractor={b => b.conversationId}
              renderItem={({ item }) => (
                <BountyCard
                  bounty={item}
                  onAccept={() => handleAccept(item)}
                  onSkip={() => handleSkip(item)}
                />
              )}
              contentContainerStyle={s.list}
              refreshControl={
                <RefreshControl
                  refreshing={bountyRefreshing}
                  onRefresh={refreshBountyTab}
                  tintColor={C.green}
                  colors={[C.green]}
                />
              }
            />
          )}
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
            <TouchableOpacity onPress={fetchLeaderboard} disabled={leaderboardLoading}>
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
                {bagsPositions.length === 0
                  ? 'No Bags tokens found.\n\nLaunch a token in the TRADE tab first.'
                  : 'No market data available yet.\n\nTry again once your token has trading activity.'}
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

      {/* Campaign Tab */}
      {activeTab === 'campaign' && (
        <ScrollView style={s.tradeRoot} contentContainerStyle={s.tradeContent}>
          {/* Campaign header */}
          <View style={cs.campaignBanner}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <Text style={cs.campaignTitle}>01PILOT LAUNCH CAMPAIGN</Text>
                <Text style={cs.campaignSub}>Earn rewards by growing the 01pilot ecosystem</Text>
              </View>
              <View style={cs.daysLeftBadge}>
                <Text style={cs.daysLeftNum}>{daysLeft()}</Text>
                <Text style={cs.daysLeftLabel}>DAYS LEFT</Text>
              </View>
            </View>
            <View style={cs.partnerNote}>
              <Text style={cs.partnerNoteText}>
                {'[!] Partner key active — you earn 25% of fees from every token launched via 01pilot'}
              </Text>
            </View>
          </View>

          {/* Track: Design */}
          <CampaignTrackCard
            icon="[#]"
            title="TOKEN DESIGN"
            rewardLine="8 USDC per accepted design"
            description="Create original artwork for tokens launched via 01pilot. Stand out with a strong visual identity — clean logos, distinct colour palettes."
            requirements={[
              'Original art (no plagiarism)',
              'PNG or JPG, min 512×512',
              'Brief concept note (1–2 sentences)',
            ]}
            submission={campaignState.design}
            ctaLabel="SUBMIT DESIGN"
            onCta={() => setDesignModalVisible(true)}
          />

          {/* Track: Launch & Trade */}
          <CampaignTrackCard
            icon="[^]"
            title="LAUNCH & TRADE"
            rewardLine="12 USDC first launch · ongoing fee share"
            description="Launch a token on Bags.fm through 01pilot. You keep all pool trading fees as creator. On top of that, the 01pilot partner key earns you 25% of platform fees from every launch in this app."
            requirements={[
              'Bags API key configured in Settings',
              'Launch at least one token via 01pilot',
              'Token must have a name, symbol, and description',
            ]}
            submission={campaignState.launch}
            ctaLabel="GO TO LAUNCH"
            onCta={handleLaunchTrackCta}
          />

          {/* Track: Social */}
          <CampaignTrackCard
            icon="[~]"
            title="SOCIAL PROMO"
            rewardLine="3 USDC per qualifying post"
            description="Post about 01pilot on X (Twitter). Show your trades, bounties earned, or agent activity. Tag @0x01world and include #01pilot."
            requirements={[
              'Post on X (Twitter)',
              'Tag @0x01world + #01pilot',
              'Minimum 50 engagements (likes + replies)',
              'Submit post URL below',
            ]}
            submission={campaignState.social}
            ctaLabel="SUBMIT POST"
            onCta={() => setSocialModalVisible(true)}
          />

          <TouchableOpacity
            onPress={() => Linking.openURL('https://x.com/0x01world')}
            style={{ marginTop: 4, marginBottom: 32, alignSelf: 'center' }}
            activeOpacity={0.7}
          >
            <Text style={{ fontSize: 10, color: C.sub, fontFamily: 'monospace', letterSpacing: 1 }}>
              questions? @0x01world on X
            </Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {/* Design submission modal */}
      {designModalVisible && (
        <Modal transparent animationType="slide" onRequestClose={() => setDesignModalVisible(false)}>
          <Pressable style={s.overlay} onPress={() => setDesignModalVisible(false)} />
          <View style={[s.sheet, { paddingBottom: 32 }]}>
            <Text style={s.sheetTitle}>SUBMIT TOKEN DESIGN</Text>

            {/* Image picker */}
            <TouchableOpacity
              style={cs.imagePickerBtn}
              onPress={handleDesignPickImage}
              activeOpacity={0.7}
            >
              <Text style={[cs.imagePickerText, designImageBytes ? { color: C.green } : {}]} numberOfLines={1}>
                {designImageName ?? 'Tap to pick image…'}
              </Text>
              {designImageBytes && (
                <TouchableOpacity
                  onPress={() => { setDesignImageBytes(null); setDesignImageName(null); }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={{ fontSize: 11, color: C.red, fontFamily: 'monospace' }}>✕</Text>
                </TouchableOpacity>
              )}
            </TouchableOpacity>

            <TextInput
              style={cs.noteInput}
              value={designNote}
              onChangeText={setDesignNote}
              placeholder="Concept note (what is this token for?)"
              placeholderTextColor={C.dim}
              multiline
              maxLength={280}
              autoCapitalize="sentences"
              autoCorrect={false}
            />

            <TouchableOpacity
              style={[cs.ctaBtn, { marginTop: 16 }, !designImageBytes && { opacity: 0.4 }]}
              activeOpacity={0.8}
              onPress={handleDesignSubmit}
              disabled={!designImageBytes}
            >
              <Text style={cs.ctaText}>SUBMIT</Text>
            </TouchableOpacity>
          </View>
        </Modal>
      )}

      {/* Social submission modal */}
      {socialModalVisible && (
        <Modal transparent animationType="slide" onRequestClose={() => setSocialModalVisible(false)}>
          <Pressable style={s.overlay} onPress={() => setSocialModalVisible(false)} />
          <View style={[s.sheet, { paddingBottom: 32 }]}>
            <Text style={s.sheetTitle}>SUBMIT SOCIAL POST</Text>
            <Text style={[s.sub, { marginBottom: 14 }]}>
              {'Post must tag @0x01world + #01pilot and have 50+ engagements.'}
            </Text>
            <TextInput
              style={cs.noteInput}
              value={socialPostUrl}
              onChangeText={setSocialPostUrl}
              placeholder="https://x.com/your_post_url"
              placeholderTextColor={C.dim}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              maxLength={512}
            />
            <TouchableOpacity
              style={[cs.ctaBtn, { marginTop: 16 }, !socialPostUrl.trim() && { opacity: 0.4 }]}
              activeOpacity={0.8}
              onPress={handleSocialSubmit}
              disabled={!socialPostUrl.trim()}
            >
              <Text style={cs.ctaText}>SUBMIT</Text>
            </TouchableOpacity>
          </View>
        </Modal>
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
});

// ── Campaign styles ────────────────────────────────────────────────────────

const CAMPAIGN_ACCENT = '#b388ff'; // soft purple — distinct from green/amber

const cs = StyleSheet.create({
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: CAMPAIGN_ACCENT,
    marginBottom: 1,
  },

  // Banner
  campaignBanner: {
    backgroundColor: '#0d0a14',
    borderWidth: 1,
    borderColor: CAMPAIGN_ACCENT + '50',
    borderRadius: 6,
    padding: 16,
    marginBottom: 16,
  },
  campaignTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: CAMPAIGN_ACCENT,
    fontFamily: 'monospace',
    letterSpacing: 2,
    marginBottom: 4,
  },
  campaignSub: {
    fontSize: 11,
    color: C.sub,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
  daysLeftBadge: {
    alignItems: 'center',
    backgroundColor: CAMPAIGN_ACCENT + '18',
    borderWidth: 1,
    borderColor: CAMPAIGN_ACCENT + '50',
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginLeft: 12,
  },
  daysLeftNum: {
    fontSize: 20,
    fontWeight: '700',
    color: CAMPAIGN_ACCENT,
    fontFamily: 'monospace',
    textAlign: 'center',
  },
  daysLeftLabel: {
    fontSize: 7,
    color: CAMPAIGN_ACCENT + 'aa',
    fontFamily: 'monospace',
    letterSpacing: 2,
    textAlign: 'center',
  },
  partnerNote: {
    marginTop: 12,
    backgroundColor: '#00e67610',
    borderWidth: 1,
    borderColor: '#00e67640',
    borderRadius: 3,
    padding: 8,
  },
  partnerNoteText: {
    fontSize: 10,
    color: C.green,
    fontFamily: 'monospace',
    lineHeight: 15,
  },

  // Track card
  trackCard: {
    backgroundColor: '#0a0a10',
    borderWidth: 1,
    borderColor: '#1e1a2e',
    borderRadius: 6,
    padding: 16,
    marginBottom: 14,
  },
  trackHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 10,
  },
  trackIcon: {
    fontSize: 14,
    color: CAMPAIGN_ACCENT,
    fontFamily: 'monospace',
    fontWeight: '700',
    marginTop: 1,
  },
  trackTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: C.text,
    fontFamily: 'monospace',
    letterSpacing: 2,
  },
  trackReward: {
    fontSize: 10,
    color: CAMPAIGN_ACCENT,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  statusBadge: {
    borderWidth: 1,
    borderRadius: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  statusText: {
    fontSize: 8,
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: 2,
  },
  trackDesc: {
    fontSize: 12,
    color: '#aaaaaa',
    fontFamily: 'monospace',
    lineHeight: 18,
    marginBottom: 12,
  },
  reqList: {
    gap: 4,
    marginBottom: 14,
  },
  reqItem: {
    fontSize: 10,
    color: C.sub,
    fontFamily: 'monospace',
    lineHeight: 15,
  },
  ctaBtn: {
    backgroundColor: CAMPAIGN_ACCENT + '20',
    borderWidth: 1,
    borderColor: CAMPAIGN_ACCENT + '80',
    borderRadius: 4,
    paddingVertical: 11,
    alignItems: 'center',
  },
  ctaText: {
    fontSize: 11,
    fontWeight: '700',
    color: CAMPAIGN_ACCENT,
    fontFamily: 'monospace',
    letterSpacing: 2,
  },

  // Modals
  imagePickerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.bg,
    borderWidth: 1,
    borderColor: C.dim,
    borderRadius: 3,
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 8,
    marginBottom: 12,
  },
  imagePickerText: {
    fontSize: 13,
    color: C.dim,
    fontFamily: 'monospace',
    flex: 1,
  },
  noteInput: {
    backgroundColor: C.bg,
    borderWidth: 1,
    borderColor: C.dim,
    borderRadius: 3,
    color: C.text,
    fontFamily: 'monospace',
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 72,
    textAlignVertical: 'top',
  },
});
