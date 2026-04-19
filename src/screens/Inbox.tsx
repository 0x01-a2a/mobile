import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert,
  TextInput, Modal, Animated,
} from 'react-native';
import { useTheme, ThemeColors } from '../theme/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLayout } from '../hooks/useLayout';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import {
  useInbox, sendEnvelope, decodeBidPayload, InboundEnvelope,
  useAgents, useAgentSearch, useAgentProfile, useSentOffers, buyAgentToken,
  AgentSummary, SentOffer,
} from '../hooks/useNodeApi';
import { useAgentBrain } from '../hooks/useAgentBrain';
import { NodeModule } from '../native/NodeModule';

function taskTypeFromCapabilities(caps: string[]): string {
  const c = caps.map(s => s.toLowerCase());
  if (c.some(s => s.includes('summariz') || s.includes('summary'))) return 'page_flip';
  if (c.some(s => s.includes('code') || s.includes('translat'))) return 'keyboard';
  if (c.some(s => s.includes('data') || s.includes('analys'))) return 'rain';
  if (c.some(s => s.includes('qa') || s.includes('question') || s.includes('research'))) return 'ocean';
  return '';
}

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
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { t } = useTranslation();
  const { contentMaxWidth } = useLayout();
  const { config: brain } = useAgentBrain();
  const threshold = brain?.minFeeUsdc ?? 1.0;

  const toastOpacity = useRef(new Animated.Value(0)).current;

  const [bounties, setBounties] = useState<BountyCard[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [completedToday, setCompletedToday] = useState<TaskEntry[]>([]);
  const [expiredToast, setExpiredToast] = useState<string | null>(null);

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
  const [activeFilter, setActiveFilter] = useState<'all' | 'action' | 'active'>('all');

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
      setBounties(prev => {
        const stillAlive = prev.filter(b => secsLeft(b.expiresAt) > 0);
        const removedCount = prev.length - stillAlive.length;
        if (removedCount > 0) {
          const msg = removedCount === 1 ? '1 offer expired' : `${removedCount} offers expired`;
          setExpiredToast(msg);
        }
        return stillAlive;
      });
    }, 10_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!expiredToast) return;
    const id = setTimeout(() => setExpiredToast(null), 3_000);
    return () => clearTimeout(id);
  }, [expiredToast]);

  useEffect(() => {
    if (expiredToast) {
      Animated.sequence([
        Animated.timing(toastOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.delay(2440),
        Animated.timing(toastOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start();
    }
  }, [expiredToast, toastOpacity]);

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
      let payload: string;
      if (decoded?.body?.['message'] !== undefined) {
        payload = String(decoded.body['message']);
      } else {
        try {
          payload = atob(env.payload_b64).slice(16); // skip 16-byte prefix
        } catch {
          payload = ''; // binary CBOR or malformed — not displayable as text
        }
      }
      updateStatus(env.conversation_id, 'delivered', { delivered_payload: payload });
      NodeModule.setAgentTaskType(''); // task complete — stop ambient sound
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
      Alert.alert(t('common.error'), t('inbox.acceptError'));
      return;
    }
    setBounties(prev => prev.filter(b => b.conversationId !== card.conversationId));
    setExpandedId(null);

    NodeModule.setAgentTaskType(taskTypeFromCapabilities(card.capabilities));

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
      Alert.alert(t('common.error'), t('inbox.sendOfferError'));
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
    const sendVerdict = async () => {
      const sent = await sendEnvelope({
        msg_type: 'VERDICT',
        recipient: offer.agent_id,
        conversation_id: offer.conversation_id,
        payload_b64: btoa(JSON.stringify({ outcome: 'positive', message: 'Accepted' })),
      });
      if (sent) updateStatus(offer.conversation_id, 'completed');
    };

    const result = await buyAgentToken(
      offer.token_address,
      offer.price_range_usd?.[1] ?? 1,
    );
    if (result === 'error') {
      Alert.alert(t('common.error'), t('inbox.paymentFailed'));
      return;
    }
    if (result === 'not_implemented') {
      Alert.alert(
        t('inbox.confirmPayment'),
        t('inbox.manualPayment'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('inbox.ivepaid'), onPress: sendVerdict },
        ],
      );
      return;
    }
    await sendVerdict();
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

  const centerStyle = contentMaxWidth
    ? { maxWidth: contentMaxWidth, alignSelf: 'center' as const, width: '100%' as const }
    : undefined;

  return (
    <>
      {expiredToast && (
        <Animated.View style={[s.expiredToast, { opacity: toastOpacity }]} pointerEvents="none">
          <Text style={s.expiredToastText}>{expiredToast}</Text>
        </Animated.View>
      )}
      <ScrollView style={s.root}>
        <View style={centerStyle}>
        {/* ── Subtab selector ── */}
        <View style={[s.subtabRow, { paddingTop: insets.top + 12 }]}>
          {(['offers', 'hire', 'active'] as const).map(tab => {
            const tabLabels = {
              offers: t('inbox.tabOffers'),
              hire:   t('inbox.tabHire'),
              active: t('inbox.tabActive'),
            };
            return (
              <TouchableOpacity
                key={tab}
                style={[s.subtabPill, subtab === tab && s.subtabPillActive]}
                onPress={() => setSubtab(tab)}
              >
                <Text style={[s.subtabLabel, subtab === tab && s.subtabLabelActive]}>
                  {tabLabels[tab]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── OFFERS tab ── */}
        {subtab === 'offers' && (
          <>
            <View style={s.header}>
              <Text style={s.subtitle}>
                {t('inbox.autoAcceptingAbove', { count: bounties.length, threshold: threshold.toFixed(2) })}
              </Text>
            </View>
            <View style={s.list}>
              {sorted.length === 0 && (
                <View style={s.emptyStateContainer}>
                  <Text style={s.emptyStatePrimary}>No incoming job requests yet.</Text>
                  <Text style={s.emptyStateSecondary}>{t('inbox.agentRunningHint')}</Text>
                  <TouchableOpacity
                    style={s.emptyStateBtn}
                    onPress={() => navigation.navigate('You')}
                  >
                    <Text style={s.emptyStateBtnText}>→ Check Settings</Text>
                  </TouchableOpacity>
                </View>
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
                      <Text style={[s.cardMeta, !above && s.cardMetaMuted]}>
                        {allAgents.find(a => a.agent_id === card.sender)?.name || card.fromAgent}
                      </Text>
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
                            <Text style={s.acceptBtnText}>{t('inbox.accept', { amount: fmtMicro(card.amountMicro) })}</Text>
                          </TouchableOpacity>
                          <TouchableOpacity style={s.passBtn} onPress={() => handlePass(card.conversationId)}>
                            <Text style={s.passBtnText}>{t('inbox.pass')}</Text>
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
                  <Text style={s.sectionLabel}>{t('inbox.completedToday')}</Text>
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
              placeholder={t('inbox.searchPlaceholder')}
              placeholderTextColor={colors.sub}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {displayedAgents.length === 0 ? (
              <View style={s.emptyStateContainer}>
                <Text style={s.emptyStatePrimary}>No agents found matching your criteria.</Text>
                <Text style={s.emptyStateSecondary}>Try refreshing or broadening your search.</Text>
                <TouchableOpacity
                  style={s.emptyStateBtn}
                  onPress={() => setSearchQuery('')}
                >
                  <Text style={s.emptyStateBtnText}>↺ Clear Search</Text>
                </TouchableOpacity>
              </View>
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
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={s.agentName}>{agent.name || agent.agent_id.slice(0, 8)}</Text>
                        {agent.is_pilot && (
                          <Text style={s.pilotBadge}>◈ PILOT</Text>
                        )}
                      </View>
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
                          {Math.round(agent.downpayment_bps / 100)}% upfront
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
            {/* Filter pills */}
            <View style={s.activeFilterRow}>
              {([
                { key: 'all', label: 'All' },
                { key: 'action', label: 'Needs Action' },
                { key: 'active', label: 'In Progress' },
              ] as const).map(f => (
                <TouchableOpacity
                  key={f.key}
                  style={[s.activeFilterPill, activeFilter === f.key && s.activeFilterPillSelected]}
                  onPress={() => setActiveFilter(f.key)}
                >
                  <Text style={[s.activeFilterPillText, activeFilter === f.key && s.activeFilterPillTextSelected]}>
                    {f.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {sentOffers.length === 0 ? (
              <View style={s.emptyStateContainer}>
                <Text style={s.emptyStatePrimary}>No active offers.</Text>
                <Text style={s.emptyStateSecondary}>{t('inbox.browseAgentsHint')}</Text>
              </View>
            ) : (() => {
              const filtered = sentOffers.filter(offer => {
                if (activeFilter === 'action') return offer.status === 'delivered';
                if (activeFilter === 'active') return offer.status === 'accepted';
                return true;
              });
              return (
                <>
                  {activeFilter === 'action' && filtered.length > 0 && (
                    <View style={s.actionBanner}>
                      <Text style={s.actionBannerText}>
                        {'💬 Agent delivered — review and pay to complete'}
                      </Text>
                    </View>
                  )}
                  {filtered.length === 0 ? (
                    <View style={s.emptyStateContainer}>
                      <Text style={s.emptyStatePrimary}>No active offers.</Text>
                      <Text style={s.emptyStateSecondary}>{t('inbox.browseAgentsHint')}</Text>
                    </View>
                  ) : (
                    filtered.map(offer => (
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
                          <Text style={s.activeStatusText}>{t('inbox.awaitingResponse')}</Text>
                        )}
                        {offer.status === 'accepted' && (
                          <>
                            <Text style={[s.activeStatusText, s.activeStatusGreen]}>{t('inbox.workingOnIt')}</Text>
                            <TouchableOpacity
                              style={s.continueChatBtn}
                              onPress={() => navigation.navigate('Chat', {
                                conversationId: offer.conversation_id,
                                task: { description: offer.description, fromAgent: offer.agent_name },
                                initialMode: 'chat',
                              })}
                            >
                              <Text style={s.continueChatBtnText}>→ Continue in Chat</Text>
                            </TouchableOpacity>
                          </>
                        )}
                        {offer.status === 'rejected' && (
                          <Text style={s.activeStatusText}>{t('inbox.declined')}</Text>
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
                                <Text style={s.payAcceptBtnText}>{t('inbox.payAccept')}</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={s.disputeBtn}
                                onPress={() => handleDispute(offer)}
                              >
                                <Text style={s.disputeBtnText}>{t('inbox.dispute')}</Text>
                              </TouchableOpacity>
                            </View>
                          </>
                        )}
                      </View>
                    ))
                  )}
                </>
              );
            })()}
          </View>
        )}
        </View>
      </ScrollView>

      {/* ── HireAgent modal ── */}
      <Modal
        visible={selectedAgent !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          if (hireSending) return;
          if (hireDescription.trim()) {
            Alert.alert('Discard changes?', 'Your message will be lost.', [
              { text: 'Keep editing', style: 'cancel' },
              { text: 'Discard', style: 'destructive', onPress: () => { setSelectedAgent(null); setHireDescription(''); } },
            ]);
          } else {
            setSelectedAgent(null);
          }
        }}
      >
        {selectedAgent && (
          <View style={[s.modalRoot, contentMaxWidth ? { maxWidth: contentMaxWidth, alignSelf: 'center' as const, width: '100%' as const } : undefined]}>
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
                <Text style={s.modalStatLabel}>{t('inbox.feedback')}</Text>
                <Text style={s.modalStatValue}>{selectedAgent.feedback_count}</Text>
              </View>
              <View style={s.modalStatCol}>
                <Text style={s.modalStatLabel}>{t('inbox.score')}</Text>
                <Text style={s.modalStatValue}>{selectedAgent.average_score.toFixed(1)}</Text>
              </View>
              <View style={s.modalStatCol}>
                <Text style={s.modalStatLabel}>{t('inbox.rep')}</Text>
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
                placeholder={t('inbox.describePlaceholder')}
                placeholderTextColor={colors.sub}
                value={hireDescription}
                onChangeText={setHireDescription}
                textAlignVertical="top"
              />

              {/* Fee (read-only) */}
              {selectedAgent.price_range_usd ? (
                <Text style={s.feeText}>
                  {t('inbox.agentCharges', { min: selectedAgent.price_range_usd[0], max: selectedAgent.price_range_usd[1] })}
                </Text>
              ) : (
                <Text style={s.feeText}>{t('inbox.agentNoPriceRange')}</Text>
              )}

              {/* Downpayment note */}
              {!!selectedAgent.downpayment_bps && (
                <Text style={s.downpaymentNote}>
                  {t('inbox.downpaymentRequired', { pct: Math.round(selectedAgent.downpayment_bps / 100) })}
                  {'\n'}{t('inbox.downpaymentExplain')}
                </Text>
              )}

              {!selectedAgent.token_address && (
                <Text style={s.noTokenHint}>{t('inbox.cantHireNoTokenHint')}</Text>
              )}

              <TouchableOpacity
                style={[s.sendBtn, (!canSendOffer || hireSending) && s.sendBtnDisabled]}
                onPress={handleSendOffer}
                disabled={!canSendOffer || hireSending}
              >
                <Text style={s.sendBtnText}>
                  {!selectedAgent.token_address
                    ? t('inbox.cantHireNoToken')
                    : hireSending ? t('inbox.sending') : t('inbox.sendOffer')}
                </Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        )}
      </Modal>
    </>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    header: {
      padding: 16, paddingBottom: 10,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    title: { fontSize: 16, fontWeight: '700', color: colors.text },
    subtitle: { fontSize: 11, color: colors.sub, marginTop: 2 },
    list: { padding: 12, gap: 7 },
    emptyText: {
      fontSize: 14, color: colors.sub, textAlign: 'center', paddingVertical: 32,
    },

    // ── Empty state helpers ─────────────────────────────────────────────────
    emptyStateContainer: { alignItems: 'center', paddingVertical: 32, paddingHorizontal: 24 },
    emptyStatePrimary: { fontSize: 13, color: colors.text, textAlign: 'center', marginBottom: 4 },
    emptyStateSecondary: { fontSize: 11, color: colors.sub, textAlign: 'center', marginBottom: 12 },
    emptyStateBtn: {
      borderWidth: 1, borderColor: colors.border, borderRadius: 8,
      paddingHorizontal: 14, paddingVertical: 7,
    },
    emptyStateBtnText: { fontSize: 11, color: colors.sub, fontWeight: '600' },

    card: { borderWidth: 1, borderRadius: 12, padding: 11, backgroundColor: colors.bg },
    cardAbove: { borderColor: colors.border, borderLeftWidth: 3, borderLeftColor: colors.text },
    cardBelow: { borderColor: colors.border, backgroundColor: colors.card },
    cardExpanded: {
      borderColor: colors.text, borderLeftWidth: 1, borderRadius: 14, padding: 14,
      shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 }, elevation: 4,
    },
    cardDimmed: { opacity: 0.6 },

    cardTopRow: {
      flexDirection: 'row', justifyContent: 'space-between',
      alignItems: 'center', marginBottom: 3,
    },
    cardTitle: { fontSize: 12, fontWeight: '600', color: colors.text, flex: 1, marginRight: 8 },
    cardTitleMuted: { color: colors.sub },
    cardAmount: { fontSize: 13, fontWeight: '700', color: colors.text },
    cardAmountMuted: { color: colors.sub },

    cardMetaRow: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    },
    cardMeta: { fontSize: 11, color: colors.sub },
    cardMetaMuted: { color: colors.dim },
    cardExpiry: { fontSize: 11, color: colors.dim },
    cardExpiryUrgent: { color: colors.red, fontWeight: '500' },

    expanded: { marginTop: 10 },
    descBox: { backgroundColor: colors.card, borderRadius: 8, padding: 9, marginBottom: 10 },
    descText: { fontSize: 12, color: colors.sub, lineHeight: 16 },
    tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 10 },
    tag: { backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 4, paddingHorizontal: 7, paddingVertical: 3 },
    tagText: { fontSize: 11, color: colors.sub, fontWeight: '500' },
    actions: { flexDirection: 'row', gap: 6 },
    acceptBtn: {
      flex: 2, backgroundColor: colors.text, borderRadius: 8, padding: 9, alignItems: 'center',
    },
    acceptBtnText: { fontSize: 12, color: colors.bg, fontWeight: '600' },
    passBtn: {
      flex: 1, borderWidth: 1, borderColor: colors.border,
      borderRadius: 8, padding: 9, alignItems: 'center',
    },
    passBtnText: { fontSize: 12, color: colors.sub },

    sectionDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginTop: 8, marginHorizontal: 16 },
    section: { padding: 16, paddingTop: 14 },
    sectionLabel: { fontSize: 11, color: colors.dim, letterSpacing: 0.5, marginBottom: 8 },
    completedRow: {
      flexDirection: 'row', justifyContent: 'space-between',
      alignItems: 'center', paddingVertical: 7,
    },
    completedRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    completedTitle: { fontSize: 11, color: colors.sub },
    completedAmount: { fontSize: 11, color: colors.green, fontWeight: '600' },

    // ── Subtabs ────────────────────────────────────────────────────────────
    subtabRow: {
      flexDirection: 'row', gap: 6,
      paddingHorizontal: 12, paddingBottom: 6,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    subtabPill: {
      paddingHorizontal: 12, paddingVertical: 6,
      borderRadius: 6, backgroundColor: colors.card,
    },
    subtabPillActive: { backgroundColor: colors.text },
    subtabLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, color: colors.sub },
    subtabLabelActive: { color: colors.bg },

    // ── HIRE tab ──────────────────────────────────────────────────────────
    hireRoot: { padding: 12 },
    searchInput: {
      borderWidth: 1, borderColor: colors.border, borderRadius: 8,
      paddingHorizontal: 10, paddingVertical: 8,
      fontSize: 12, color: colors.text, marginBottom: 10,
    },
    agentRow: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      borderWidth: 1, borderColor: colors.border, borderRadius: 10,
      padding: 10, marginBottom: 7, borderLeftWidth: 3,
    },
    agentRowHireable: { borderLeftColor: colors.text },
    agentRowNoToken: { borderLeftColor: colors.border },
    agentRowLeft: { flex: 1 },
    agentRowRight: { alignItems: 'flex-end' },
    agentName: { fontSize: 13, fontWeight: '600', color: colors.text },
    agentRep: { fontSize: 11, color: colors.sub, marginTop: 2 },
    pilotBadge: { fontSize: 11, fontWeight: '700', color: '#f59e0b', letterSpacing: 0.5 },
    expiredToast: {
      position: 'absolute', top: 60, alignSelf: 'center', zIndex: 999,
      backgroundColor: colors.text + 'D9', borderRadius: 20,
      paddingHorizontal: 16, paddingVertical: 7,
    },
    expiredToastText: { fontSize: 11, color: colors.bg, fontWeight: '600' },
    agentPrice: { fontSize: 12, fontWeight: '600', color: colors.text },
    agentPriceMuted: { fontSize: 12, color: colors.sub },
    downpaymentBadge: { fontSize: 11, color: '#d97706', fontWeight: '600', marginTop: 2 },

    // ── ACTIVE tab ────────────────────────────────────────────────────────
    activeRoot: { padding: 12 },
    activeFilterRow: { flexDirection: 'row', gap: 6, marginBottom: 10 },
    activeFilterPill: {
      height: 28, borderRadius: 14, paddingHorizontal: 12,
      justifyContent: 'center', alignItems: 'center',
      borderWidth: 1, borderColor: colors.border,
    },
    activeFilterPillSelected: { backgroundColor: colors.text, borderColor: colors.text },
    activeFilterPillText: { fontSize: 11, color: colors.sub },
    activeFilterPillTextSelected: { color: colors.bg },
    actionBanner: {
      backgroundColor: '#fef3c7', borderWidth: 1, borderColor: '#fde68a',
      borderRadius: 8, padding: 10, marginBottom: 10,
    },
    actionBannerText: { fontSize: 11, color: '#92400e', lineHeight: 16 },
    continueChatBtn: {
      marginTop: 6, borderWidth: 1, borderColor: colors.text,
      borderRadius: 7, padding: 7, alignItems: 'center',
      alignSelf: 'flex-start',
    },
    continueChatBtnText: { fontSize: 11, color: colors.text, fontWeight: '600' },
    activeCard: {
      borderWidth: 1, borderColor: colors.border, borderRadius: 10,
      padding: 10, marginBottom: 7, borderLeftWidth: 3,
    },
    activeCardPending: { borderLeftColor: colors.border },
    activeCardAccepted: { borderLeftColor: colors.green },
    activeCardDelivered: { borderLeftColor: colors.text },
    activeCardRejected: { borderLeftColor: colors.red, opacity: 0.45 },
    activeCardTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
    activeAgentName: { fontSize: 12, fontWeight: '600', color: colors.text },
    activeDesc: { fontSize: 11, color: colors.sub, flex: 1, textAlign: 'right', marginLeft: 8 },
    activeStatusText: { fontSize: 11, color: colors.sub },
    activeStatusGreen: { color: colors.green },
    deliveredPayload: {
      fontSize: 11, color: colors.sub, backgroundColor: colors.card,
      borderRadius: 6, padding: 8, marginVertical: 8, lineHeight: 16,
    },
    deliveredActions: { flexDirection: 'row', gap: 6, marginTop: 4 },
    payAcceptBtn: {
      flex: 2, backgroundColor: colors.text, borderRadius: 7, padding: 8, alignItems: 'center',
    },
    payAcceptBtnText: { fontSize: 11, color: colors.bg, fontWeight: '600' },
    disputeBtn: {
      flex: 1, borderWidth: 1, borderColor: colors.border,
      borderRadius: 7, padding: 8, alignItems: 'center',
    },
    disputeBtnText: { fontSize: 11, color: colors.sub },

    // ── HireAgent modal ────────────────────────────────────────────────────
    modalRoot: { flex: 1, backgroundColor: colors.bg },
    modalHandle: {
      width: 32, height: 4, backgroundColor: colors.border, borderRadius: 2,
      alignSelf: 'center', marginTop: 8, marginBottom: 12,
    },
    modalHeaderRow: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      paddingHorizontal: 16, marginBottom: 12,
    },
    modalAgentName: { fontSize: 16, fontWeight: '700', color: colors.text },
    modalClose: { fontSize: 16, color: colors.sub, padding: 4 },
    modalStatsRow: {
      flexDirection: 'row', justifyContent: 'space-around',
      paddingHorizontal: 16, marginBottom: 12,
    },
    modalStatCol: { alignItems: 'center' },
    modalStatLabel: { fontSize: 11, color: colors.sub, letterSpacing: 0.3, marginBottom: 2 },
    modalStatValue: { fontSize: 14, fontWeight: '700', color: colors.text },
    capChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, paddingHorizontal: 16, marginBottom: 12 },
    capChip: { backgroundColor: colors.card, borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2 },
    capChipText: { fontSize: 11, color: colors.sub },
    modalDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginBottom: 12 },
    modalScroll: { flex: 1, paddingHorizontal: 16 },
    descInput: {
      borderWidth: 1, borderColor: colors.border, borderRadius: 8,
      padding: 10, fontSize: 12, color: colors.text,
      minHeight: 80, marginBottom: 10,
    },
    feeText: { fontSize: 12, color: colors.sub, marginBottom: 6 },
    downpaymentNote: { fontSize: 11, color: '#d97706', marginBottom: 10 },
    noTokenHint: { fontSize: 11, color: colors.sub, marginBottom: 10, fontStyle: 'italic' },
    sendBtn: {
      backgroundColor: colors.text, borderRadius: 10, padding: 12,
      alignItems: 'center', marginTop: 8, marginBottom: 24,
    },
    sendBtnDisabled: { opacity: 0.4 },
    sendBtnText: { fontSize: 12, color: colors.bg, fontWeight: '700' },
  });
}
