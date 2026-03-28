import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert,
  TextInput, Modal,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import {
  useInbox, sendEnvelope, decodeBidPayload, InboundEnvelope,
  useAgents, useAgentSearch, useAgentProfile, useSentOffers, buyAgentToken,
  AgentSummary, SentOffer,
} from '../hooks/useNodeApi';
import { useAgentBrain } from '../hooks/useAgentBrain';

const TASK_LOG_KEY = 'zerox1:task_log';

interface TaskEntry {
  conversationId: string;
  description: string;
  reward: string;
  fromAgent: string;
  status: 'active' | 'delivered' | 'completed';
  acceptedAt: number;
}

interface BountyCard {
  sender: string;
  conversationId: string;
  description: string;
  amountMicro: number;
  fromAgent: string;
  expiresAt: number;
  capabilities: string[];
}

function fmtMicro(microUsdc: number): string {
  return `$${(microUsdc / 1_000_000).toFixed(2)}`;
}

function secsLeft(expiresAt: number): number {
  return Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
}

function fmtExpiry(expiresAt: number): string {
  const s = secsLeft(expiresAt);
  if (s < 60) return `${s}s left`;
  return `${Math.floor(s / 60)}m left`;
}

function isToday(tsMs: number): boolean {
  const d = new Date(tsMs);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function envelopeToCard(env: InboundEnvelope): BountyCard | null {
  if (env.msg_type !== 'PROPOSE') return null;
  const decoded = decodeBidPayload(env.payload_b64);
  const amountMicro = decoded?.amount ?? 0;
  const description =
    decoded?.body?.['message'] !== undefined
      ? String(decoded.body['message'])
      : 'Task';
  const capabilities: string[] = Array.isArray(decoded?.body?.['capabilities'])
    ? (decoded.body['capabilities'] as string[]).slice(0, 5)
    : [];
  return {
    sender: env.sender,
    conversationId: env.conversation_id,
    description,
    amountMicro,
    fromAgent: `Agent_${env.sender.slice(0, 4).toUpperCase()}`,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    capabilities,
  };
}

export default function InboxScreen() {
  const navigation = useNavigation<any>();
  const { config: brain } = useAgentBrain();
  const threshold = brain?.minFeeUsdc ?? 1.0;

  const [bounties, setBounties] = useState<BountyCard[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [completedToday, setCompletedToday] = useState<TaskEntry[]>([]);

  // Subtabs
  const [subtab, setSubtab] = useState<'offers' | 'hire' | 'active'>('offers');

  // HIRE tab
  const allAgents = useAgents('active', 50);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<AgentSummary | null>(null);
  const [hireDescription, setHireDescription] = useState('');
  const [hireSending, setHireSending] = useState(false);
  const agentProfile = useAgentProfile(selectedAgent?.agent_id ?? null);
  const { results: searchResults } = useAgentSearch(debouncedQuery);

  // ACTIVE tab
  const { offers: sentOffers, addOffer, updateStatus } = useSentOffers();

  // Debounce search query
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery), 400);
    return () => clearTimeout(id);
  }, [searchQuery]);

  const displayedAgents = useMemo(
    () => (debouncedQuery.trim() ? searchResults : allAgents),
    [debouncedQuery, searchResults, allAgents],
  );

  useEffect(() => {
    AsyncStorage.getItem(TASK_LOG_KEY).then(raw => {
      if (!raw) return;
      const log: TaskEntry[] = JSON.parse(raw);
      setCompletedToday(
        log.filter(e => e.status === 'delivered' && isToday(e.acceptedAt)),
      );
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setBounties(prev => prev.filter(b => secsLeft(b.expiresAt) > 0));
    }, 10_000);
    return () => clearInterval(id);
  }, []);

  const onEnvelope = useCallback((env: InboundEnvelope) => {
    // Update status for outbound offers we've sent
    if (env.msg_type === 'ACCEPT') {
      updateStatus(env.conversation_id, 'accepted');
      return;
    }
    if (env.msg_type === 'REJECT') {
      updateStatus(env.conversation_id, 'rejected', { rejected_at: Date.now() });
      return;
    }
    if (env.msg_type === 'DELIVER') {
      const decoded = decodeBidPayload(env.payload_b64);
      const payload = decoded?.body?.['message']
        ? String(decoded.body['message'])
        : atob(env.payload_b64).slice(16); // skip 16-byte prefix
      updateStatus(env.conversation_id, 'delivered', { delivered_payload: payload });
      return;
    }

    // Existing: handle incoming PROPOSE bounties
    const card = envelopeToCard(env);
    if (!card) return;
    setBounties(prev => {
      if (prev.find(b => b.conversationId === card.conversationId)) return prev;
      return [card, ...prev];
    });
  }, [updateStatus]);

  useInbox(onEnvelope);

  const handleAccept = useCallback(async (card: BountyCard) => {
    const ok = await sendEnvelope({
      msg_type: 'ACCEPT',
      recipient: card.sender,
      conversation_id: card.conversationId,
      payload_b64: '',
    });
    if (!ok) {
      Alert.alert('Error', 'Failed to accept job. Try again.');
      return;
    }
    setBounties(prev => prev.filter(b => b.conversationId !== card.conversationId));
    setExpandedId(null);

    const entry: TaskEntry = {
      conversationId: card.conversationId,
      description: card.description,
      reward: `+${fmtMicro(card.amountMicro)}`,
      fromAgent: card.fromAgent,
      status: 'active',
      acceptedAt: Date.now(),
    };
    AsyncStorage.getItem(TASK_LOG_KEY).then(raw => {
      const log: TaskEntry[] = raw ? JSON.parse(raw) : [];
      AsyncStorage.setItem(
        TASK_LOG_KEY,
        JSON.stringify([entry, ...log].slice(0, 100)),
      );
    }).catch(() => {});

    navigation.navigate('Chat', {
      conversationId: card.conversationId,
      task: { description: card.description, reward: entry.reward, fromAgent: card.fromAgent },
      initialMode: 'chat',
    });
  }, [navigation]);

  const handlePass = useCallback((conversationId: string) => {
    setBounties(prev => prev.filter(b => b.conversationId !== conversationId));
    if (expandedId === conversationId) setExpandedId(null);
  }, [expandedId]);

  const handleSendOffer = useCallback(async () => {
    if (!selectedAgent || !hireDescription.trim() || !selectedAgent.token_address) return;
    setHireSending(true);
    const conversationId =
      Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const ok = await sendEnvelope({
      msg_type: 'PROPOSE',
      recipient: selectedAgent.agent_id,
      conversation_id: conversationId,
      payload_b64: btoa(JSON.stringify({
        message: hireDescription.trim(),
        payment_type: 'token',
        token_mint: selectedAgent.token_address,
      })),
    });
    setHireSending(false);
    if (!ok) {
      Alert.alert('Error', 'Failed to send offer. Try again.');
      return;
    }
    addOffer({
      conversation_id: conversationId,
      agent_id: selectedAgent.agent_id,
      agent_name: selectedAgent.name,
      token_address: selectedAgent.token_address,
      description: hireDescription.trim(),
      price_range_usd: selectedAgent.price_range_usd,
      status: 'pending',
      sent_at: Date.now(),
    });
    setSelectedAgent(null);
    setHireDescription('');
    setSubtab('active');
  }, [selectedAgent, hireDescription, addOffer]);

  const handlePayAccept = useCallback(async (offer: SentOffer) => {
    const result = await buyAgentToken(
      offer.token_address,
      offer.price_range_usd?.[1] ?? 1,
    );
    if (result === 'error') {
      Alert.alert('Payment failed', 'Could not buy token. Try again.');
      return;
    }
    if (result === 'not_implemented') {
      Alert.alert('Manual payment required', 'Complete the token purchase in your wallet.');
    }
    const sent = await sendEnvelope({
      msg_type: 'VERDICT',
      recipient: offer.agent_id,
      conversation_id: offer.conversation_id,
      payload_b64: btoa(JSON.stringify({ outcome: 'positive', message: 'Accepted' })),
    });
    if (sent) {
      updateStatus(offer.conversation_id, 'completed');
    }
  }, [updateStatus]);

  const handleDispute = useCallback(async (offer: SentOffer) => {
    const sent = await sendEnvelope({
      msg_type: 'DISPUTE',
      recipient: offer.agent_id,
      conversation_id: offer.conversation_id,
      payload_b64: btoa(JSON.stringify({ reason: 'Result not satisfactory' })),
    });
    if (sent) {
      updateStatus(offer.conversation_id, 'rejected', { rejected_at: Date.now() });
    }
  }, [updateStatus]);

  const aboveThreshold = useMemo(
    () => bounties.filter(b => b.amountMicro / 1_000_000 >= threshold),
    [bounties, threshold],
  );
  const belowThreshold = useMemo(
    () => bounties.filter(b => b.amountMicro / 1_000_000 < threshold),
    [bounties, threshold],
  );
  const sorted = [...aboveThreshold, ...belowThreshold];

  const canSendOffer = !!selectedAgent?.token_address && hireDescription.trim().length > 0;

  return (
    <>
      <ScrollView style={s.root}>
        {/* ── Subtab selector ── */}
        <View style={s.subtabRow}>
          {(['offers', 'hire', 'active'] as const).map(tab => (
            <TouchableOpacity
              key={tab}
              style={[s.subtabPill, subtab === tab && s.subtabPillActive]}
              onPress={() => setSubtab(tab)}
            >
              <Text style={[s.subtabLabel, subtab === tab && s.subtabLabelActive]}>
                {tab.toUpperCase()}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── OFFERS tab ── */}
        {subtab === 'offers' && (
          <>
            <View style={s.header}>
              <Text style={s.subtitle}>
                {`${bounties.length} new · auto-accepting above $${threshold.toFixed(2)}`}
              </Text>
            </View>
            <View style={s.list}>
              {sorted.length === 0 && (
                <Text style={s.emptyText}>No new jobs</Text>
              )}
              {sorted.map(card => {
                const isExpanded = expandedId === card.conversationId;
                const above = card.amountMicro / 1_000_000 >= threshold;
                const urgent = secsLeft(card.expiresAt) < 300;
                return (
                  <TouchableOpacity
                    key={card.conversationId}
                    testID={above ? 'job-card-above-threshold' : 'job-card-below-threshold'}
                    style={[
                      s.card,
                      above ? s.cardAbove : s.cardBelow,
                      isExpanded && s.cardExpanded,
                      !isExpanded && expandedId !== null && s.cardDimmed,
                    ]}
                    onPress={() => setExpandedId(isExpanded ? null : card.conversationId)}
                    activeOpacity={0.85}
                  >
                    <View style={s.cardTopRow}>
                      <Text style={[s.cardTitle, !above && s.cardTitleMuted]} numberOfLines={1}>
                        {card.description}
                      </Text>
                      <Text style={[s.cardAmount, !above && s.cardAmountMuted]}>
                        {fmtMicro(card.amountMicro)}
                      </Text>
                    </View>
                    <View style={s.cardMetaRow}>
                      <Text style={[s.cardMeta, !above && s.cardMetaMuted]}>{card.fromAgent}</Text>
                      <Text style={[s.cardExpiry, urgent && s.cardExpiryUrgent]}>
                        {fmtExpiry(card.expiresAt)}
                      </Text>
                    </View>
                    {isExpanded && (
                      <View style={s.expanded}>
                        <View style={s.descBox}>
                          <Text style={s.descText}>{card.description}</Text>
                        </View>
                        {card.capabilities.length > 0 && (
                          <View style={s.tags}>
                            {card.capabilities.map((tag, i) => (
                              <View key={i} style={s.tag}>
                                <Text style={s.tagText}>{tag}</Text>
                              </View>
                            ))}
                          </View>
                        )}
                        <View style={s.actions}>
                          <TouchableOpacity style={s.acceptBtn} onPress={() => handleAccept(card)}>
                            <Text style={s.acceptBtnText}>Accept · {fmtMicro(card.amountMicro)}</Text>
                          </TouchableOpacity>
                          <TouchableOpacity style={s.passBtn} onPress={() => handlePass(card.conversationId)}>
                            <Text style={s.passBtnText}>Pass</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
            {completedToday.length > 0 && (
              <>
                <View style={s.sectionDivider} />
                <View style={s.section}>
                  <Text style={s.sectionLabel}>COMPLETED TODAY</Text>
                  {completedToday.map((entry, i) => (
                    <View
                      key={entry.conversationId}
                      style={[s.completedRow, i < completedToday.length - 1 && s.completedRowBorder]}
                    >
                      <Text style={s.completedTitle}>{entry.description}</Text>
                      <Text style={s.completedAmount}>{entry.reward}</Text>
                    </View>
                  ))}
                </View>
              </>
            )}
          </>
        )}

        {/* ── HIRE tab ── */}
        {subtab === 'hire' && (
          <View style={s.hireRoot}>
            <TextInput
              style={s.searchInput}
              placeholder="Search by capability..."
              placeholderTextColor="#9ca3af"
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {displayedAgents.length === 0 ? (
              <Text style={s.emptyText}>No agents advertising right now</Text>
            ) : (
              displayedAgents.map(agent => {
                const hireable = !!agent.token_address;
                const repPct = agent.feedback_count > 0
                  ? Math.round((agent.positive_count / agent.feedback_count) * 100)
                  : null;
                return (
                  <TouchableOpacity
                    key={agent.agent_id}
                    style={[s.agentRow, hireable ? s.agentRowHireable : s.agentRowNoToken]}
                    onPress={() => setSelectedAgent(agent)}
                  >
                    <View style={s.agentRowLeft}>
                      <Text style={s.agentName}>{agent.name || agent.agent_id.slice(0, 8)}</Text>
                      {repPct !== null && (
                        <Text style={s.agentRep}>★ {repPct}%</Text>
                      )}
                    </View>
                    <View style={s.agentRowRight}>
                      {agent.price_range_usd ? (
                        <Text style={s.agentPrice}>
                          ${agent.price_range_usd[0]}–${agent.price_range_usd[1]}
                        </Text>
                      ) : (
                        <Text style={s.agentPriceMuted}>—</Text>
                      )}
                      {!!agent.downpayment_bps && (
                        <Text style={s.downpaymentBadge}>
                          {Math.round(agent.downpayment_bps / 100)}% down
                        </Text>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        )}

        {/* ── ACTIVE tab ── */}
        {subtab === 'active' && (
          <View style={s.activeRoot}>
            {sentOffers.length === 0 ? (
              <Text style={s.emptyText}>No active offers</Text>
            ) : (
              sentOffers.map(offer => (
                <View
                  key={offer.conversation_id}
                  style={[
                    s.activeCard,
                    offer.status === 'pending'   && s.activeCardPending,
                    offer.status === 'accepted'  && s.activeCardAccepted,
                    offer.status === 'delivered' && s.activeCardDelivered,
                    offer.status === 'rejected'  && s.activeCardRejected,
                  ]}
                >
                  <View style={s.activeCardTop}>
                    <Text style={s.activeAgentName}>{offer.agent_name}</Text>
                    <Text style={s.activeDesc} numberOfLines={1}>{offer.description}</Text>
                  </View>
                  {offer.status === 'pending' && (
                    <Text style={s.activeStatusText}>Awaiting response</Text>
                  )}
                  {offer.status === 'accepted' && (
                    <Text style={[s.activeStatusText, s.activeStatusGreen]}>Working on it…</Text>
                  )}
                  {offer.status === 'rejected' && (
                    <Text style={s.activeStatusText}>Declined</Text>
                  )}
                  {offer.status === 'delivered' && (
                    <>
                      {!!offer.delivered_payload && (
                        <Text style={s.deliveredPayload} numberOfLines={4}>
                          {offer.delivered_payload}
                        </Text>
                      )}
                      <View style={s.deliveredActions}>
                        <TouchableOpacity
                          style={s.payAcceptBtn}
                          onPress={() => handlePayAccept(offer)}
                        >
                          <Text style={s.payAcceptBtnText}>Pay & Accept</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={s.disputeBtn}
                          onPress={() => handleDispute(offer)}
                        >
                          <Text style={s.disputeBtnText}>Dispute</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </View>
              ))
            )}
          </View>
        )}
      </ScrollView>

      {/* ── HireAgent modal ── */}
      <Modal
        visible={selectedAgent !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSelectedAgent(null)}
      >
        {selectedAgent && (
          <View style={s.modalRoot}>
            <View style={s.modalHandle} />
            <View style={s.modalHeaderRow}>
              <Text style={s.modalAgentName}>{selectedAgent.name || selectedAgent.agent_id.slice(0, 8)}</Text>
              <TouchableOpacity
                onPress={() => setSelectedAgent(null)}
                accessibilityLabel="Close"
                accessibilityRole="button"
              >
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* Stats row */}
            <View style={s.modalStatsRow}>
              <View style={s.modalStatCol}>
                <Text style={s.modalStatLabel}>FEEDBACK</Text>
                <Text style={s.modalStatValue}>{selectedAgent.feedback_count}</Text>
              </View>
              <View style={s.modalStatCol}>
                <Text style={s.modalStatLabel}>SCORE</Text>
                <Text style={s.modalStatValue}>{selectedAgent.average_score.toFixed(1)}</Text>
              </View>
              <View style={s.modalStatCol}>
                <Text style={s.modalStatLabel}>REP</Text>
                <Text style={s.modalStatValue}>
                  {selectedAgent.feedback_count > 0
                    ? `${Math.round((selectedAgent.positive_count / selectedAgent.feedback_count) * 100)}%`
                    : '—'}
                </Text>
              </View>
            </View>

            {/* Capability chips */}
            {agentProfile?.capabilities?.length > 0 && (
              <View style={s.capChips}>
                {(agentProfile.capabilities as any[]).slice(0, 8).map((c: any, i: number) => (
                  <View key={i} style={s.capChip}>
                    <Text style={s.capChipText}>{c.capability ?? c}</Text>
                  </View>
                ))}
              </View>
            )}

            <View style={s.modalDivider} />

            <ScrollView style={s.modalScroll} keyboardShouldPersistTaps="handled">
              <TextInput
                style={s.descInput}
                multiline
                placeholder="Describe what you need..."
                placeholderTextColor="#9ca3af"
                value={hireDescription}
                onChangeText={setHireDescription}
                textAlignVertical="top"
              />

              {/* Fee (read-only) */}
              {selectedAgent.price_range_usd ? (
                <Text style={s.feeText}>
                  Agent charges ${selectedAgent.price_range_usd[0]}–${selectedAgent.price_range_usd[1]}
                </Text>
              ) : (
                <Text style={s.feeText}>Agent hasn't set a price range</Text>
              )}

              {/* Downpayment note */}
              {!!selectedAgent.downpayment_bps && (
                <Text style={s.downpaymentNote}>
                  Requires {Math.round(selectedAgent.downpayment_bps / 100)}% token downpayment
                </Text>
              )}

              <TouchableOpacity
                style={[s.sendBtn, (!canSendOffer || hireSending) && s.sendBtnDisabled]}
                onPress={handleSendOffer}
                disabled={!canSendOffer || hireSending}
              >
                <Text style={s.sendBtnText}>
                  {!selectedAgent.token_address
                    ? "Can't hire — no token"
                    : hireSending ? 'Sending…' : 'Send Offer'}
                </Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        )}
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  header: {
    padding: 16, paddingBottom: 10,
    borderBottomWidth: 1, borderBottomColor: '#f3f4f6',
  },
  title: { fontSize: 16, fontWeight: '700', color: '#111' },
  subtitle: { fontSize: 11, color: '#9ca3af', marginTop: 2 },
  list: { padding: 12, gap: 7 },
  emptyText: {
    fontSize: 14, color: '#d1d5db', textAlign: 'center', paddingVertical: 32,
  },

  card: { borderWidth: 1, borderRadius: 12, padding: 11, backgroundColor: '#fff' },
  cardAbove: { borderColor: '#d1d5db', borderLeftWidth: 3, borderLeftColor: '#111' },
  cardBelow: { borderColor: '#f3f4f6', backgroundColor: '#fafafa' },
  cardExpanded: {
    borderColor: '#111', borderLeftWidth: 1, borderRadius: 14, padding: 14,
    shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 }, elevation: 4,
  },
  cardDimmed: { opacity: 0.6 },

  cardTopRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 3,
  },
  cardTitle: { fontSize: 12, fontWeight: '600', color: '#111', flex: 1, marginRight: 8 },
  cardTitleMuted: { color: '#9ca3af' },
  cardAmount: { fontSize: 13, fontWeight: '700', color: '#111' },
  cardAmountMuted: { color: '#9ca3af' },

  cardMetaRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  cardMeta: { fontSize: 10, color: '#6b7280' },
  cardMetaMuted: { color: '#d1d5db' },
  cardExpiry: { fontSize: 10, color: '#9ca3af' },
  cardExpiryUrgent: { color: '#ef4444', fontWeight: '500' },

  expanded: { marginTop: 10 },
  descBox: { backgroundColor: '#f9fafb', borderRadius: 8, padding: 9, marginBottom: 10 },
  descText: { fontSize: 11, color: '#374151', lineHeight: 16 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 10 },
  tag: { backgroundColor: '#f3f4f6', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2 },
  tagText: { fontSize: 9, color: '#374151', fontWeight: '500' },
  actions: { flexDirection: 'row', gap: 6 },
  acceptBtn: {
    flex: 2, backgroundColor: '#111', borderRadius: 8, padding: 9, alignItems: 'center',
  },
  acceptBtnText: { fontSize: 11, color: '#fff', fontWeight: '600' },
  passBtn: {
    flex: 1, borderWidth: 1, borderColor: '#e5e7eb',
    borderRadius: 8, padding: 9, alignItems: 'center',
  },
  passBtnText: { fontSize: 11, color: '#9ca3af' },

  sectionDivider: { height: 6, backgroundColor: '#f3f4f6', marginTop: 8 },
  section: { padding: 16, paddingTop: 14 },
  sectionLabel: { fontSize: 10, color: '#9ca3af', letterSpacing: 0.5, marginBottom: 8 },
  completedRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingVertical: 7,
  },
  completedRowBorder: { borderBottomWidth: 1, borderBottomColor: '#f9fafb' },
  completedTitle: { fontSize: 11, color: '#6b7280' },
  completedAmount: { fontSize: 11, color: '#22c55e', fontWeight: '600' },

  // ── Subtabs ──────────────────────────────────────────────────────────────
  subtabRow: {
    flexDirection: 'row', gap: 6, padding: 12, paddingBottom: 6,
    borderBottomWidth: 1, borderBottomColor: '#f3f4f6',
  },
  subtabPill: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 6, backgroundColor: '#f3f4f6',
  },
  subtabPillActive: { backgroundColor: '#111' },
  subtabLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5, color: '#6b7280' },
  subtabLabelActive: { color: '#fff' },

  // ── HIRE tab ─────────────────────────────────────────────────────────────
  hireRoot: { padding: 12 },
  searchInput: {
    borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8,
    fontSize: 12, color: '#111', marginBottom: 10,
  },
  agentRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10,
    padding: 10, marginBottom: 7, borderLeftWidth: 3,
  },
  agentRowHireable: { borderLeftColor: '#111' },
  agentRowNoToken: { borderLeftColor: '#e5e7eb' },
  agentRowLeft: { flex: 1 },
  agentRowRight: { alignItems: 'flex-end' },
  agentName: { fontSize: 13, fontWeight: '600', color: '#111' },
  agentRep: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  agentPrice: { fontSize: 12, fontWeight: '600', color: '#111' },
  agentPriceMuted: { fontSize: 12, color: '#9ca3af' },
  downpaymentBadge: { fontSize: 9, color: '#d97706', fontWeight: '600', marginTop: 2 },

  // ── ACTIVE tab ───────────────────────────────────────────────────────────
  activeRoot: { padding: 12 },
  activeCard: {
    borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10,
    padding: 10, marginBottom: 7, borderLeftWidth: 3,
  },
  activeCardPending: { borderLeftColor: '#d1d5db' },
  activeCardAccepted: { borderLeftColor: '#22c55e' },
  activeCardDelivered: { borderLeftColor: '#111' },
  activeCardRejected: { borderLeftColor: '#ef4444', opacity: 0.45 },
  activeCardTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  activeAgentName: { fontSize: 12, fontWeight: '600', color: '#111' },
  activeDesc: { fontSize: 11, color: '#6b7280', flex: 1, textAlign: 'right', marginLeft: 8 },
  activeStatusText: { fontSize: 10, color: '#9ca3af' },
  activeStatusGreen: { color: '#22c55e' },
  deliveredPayload: {
    fontSize: 11, color: '#374151', backgroundColor: '#f9fafb',
    borderRadius: 6, padding: 8, marginVertical: 8, lineHeight: 16,
  },
  deliveredActions: { flexDirection: 'row', gap: 6, marginTop: 4 },
  payAcceptBtn: {
    flex: 2, backgroundColor: '#111', borderRadius: 7, padding: 8, alignItems: 'center',
  },
  payAcceptBtnText: { fontSize: 11, color: '#fff', fontWeight: '600' },
  disputeBtn: {
    flex: 1, borderWidth: 1, borderColor: '#e5e7eb',
    borderRadius: 7, padding: 8, alignItems: 'center',
  },
  disputeBtnText: { fontSize: 11, color: '#9ca3af' },

  // ── HireAgent modal ──────────────────────────────────────────────────────
  modalRoot: { flex: 1, backgroundColor: '#fff' },
  modalHandle: {
    width: 32, height: 4, backgroundColor: '#e5e7eb', borderRadius: 2,
    alignSelf: 'center', marginTop: 8, marginBottom: 12,
  },
  modalHeaderRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, marginBottom: 12,
  },
  modalAgentName: { fontSize: 16, fontWeight: '700', color: '#111' },
  modalClose: { fontSize: 16, color: '#6b7280', padding: 4 },
  modalStatsRow: {
    flexDirection: 'row', justifyContent: 'space-around',
    paddingHorizontal: 16, marginBottom: 12,
  },
  modalStatCol: { alignItems: 'center' },
  modalStatLabel: { fontSize: 9, color: '#9ca3af', letterSpacing: 0.3, marginBottom: 2 },
  modalStatValue: { fontSize: 14, fontWeight: '700', color: '#111' },
  capChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, paddingHorizontal: 16, marginBottom: 12 },
  capChip: { backgroundColor: '#f3f4f6', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2 },
  capChipText: { fontSize: 10, color: '#374151' },
  modalDivider: { height: 1, backgroundColor: '#f3f4f6', marginBottom: 12 },
  modalScroll: { flex: 1, paddingHorizontal: 16 },
  descInput: {
    borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 8,
    padding: 10, fontSize: 12, color: '#111',
    minHeight: 80, marginBottom: 10,
  },
  feeText: { fontSize: 12, color: '#6b7280', marginBottom: 6 },
  downpaymentNote: { fontSize: 11, color: '#d97706', marginBottom: 10 },
  sendBtn: {
    backgroundColor: '#111', borderRadius: 10, padding: 12,
    alignItems: 'center', marginTop: 8, marginBottom: 24,
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { fontSize: 12, color: '#fff', fontWeight: '700' },
});
