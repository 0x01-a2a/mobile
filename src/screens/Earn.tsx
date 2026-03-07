/**
 * Earn — bounty feed.
 *
 * Listens for incoming PROPOSE envelopes, shows them as actionable bounty
 * cards. User picks which agent handles the task, ACCEPT is sent, then
 * the app routes to Chat with the task loaded as context.
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ScrollView,
  TextInput,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useInbox, InboundEnvelope, sendEnvelope, executeJupiterSwap, useTradeQuote } from '../hooks/useNodeApi';
import { useOwnedAgents, OwnedAgent } from '../hooks/useOwnedAgents';
import { useNode } from '../hooks/useNode';
import { useZeroclawChat } from '../hooks/useZeroclawChat';

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

// ── Main screen ───────────────────────────────────────────────────────────

export function EarnScreen() {
  const navigation = useNavigation<any>();
  const agents = useOwnedAgents().filter(a => a.mode !== 'linked');
  const { status } = useNode();
  const [bounties, setBounties] = useState<Bounty[]>([]);
  const [pickerTarget, setPickerTarget] = useState<Bounty | null>(null);
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [activeTab, setActiveTab] = useState<'bounty' | 'trade'>('bounty');

  const { injectSystemMessage } = useZeroclawChat();
  const [swapAmount, setSwapAmount] = useState('0.1');
  const [swapping, setSwapping] = useState(false);
  const [inputIdx, setInputIdx] = useState(1);  // USDC
  const [outputIdx, setOutputIdx] = useState(0); // SOL
  const [pickerFor, setPickerFor] = useState<'input' | 'output' | null>(null);

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
  }, [swapAmount, quote, inputIdx, outputIdx, injectSystemMessage, navigation]);

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
            style={[s.acceptBtn, { alignSelf: 'center', paddingHorizontal: 24, marginTop: 12 }]}
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
});
