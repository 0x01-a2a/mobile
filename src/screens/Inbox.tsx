import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import { useInbox, sendEnvelope, decodeBidPayload, InboundEnvelope } from '../hooks/useNodeApi';
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
    const card = envelopeToCard(env);
    if (!card) return;
    setBounties(prev => {
      if (prev.find(b => b.conversationId === card.conversationId)) return prev;
      return [card, ...prev];
    });
  }, []);

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

  const aboveThreshold = useMemo(
    () => bounties.filter(b => b.amountMicro / 1_000_000 >= threshold),
    [bounties, threshold],
  );
  const belowThreshold = useMemo(
    () => bounties.filter(b => b.amountMicro / 1_000_000 < threshold),
    [bounties, threshold],
  );
  const sorted = [...aboveThreshold, ...belowThreshold];

  return (
    <ScrollView style={s.root}>
      <View style={s.header}>
        <Text style={s.title}>Inbox</Text>
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
                <Text
                  style={[s.cardTitle, !above && s.cardTitleMuted]}
                  numberOfLines={1}
                >
                  {card.description}
                </Text>
                <Text style={[s.cardAmount, !above && s.cardAmountMuted]}>
                  {fmtMicro(card.amountMicro)}
                </Text>
              </View>
              <View style={s.cardMetaRow}>
                <Text style={[s.cardMeta, !above && s.cardMetaMuted]}>
                  {card.fromAgent}
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
                    <TouchableOpacity
                      style={s.acceptBtn}
                      onPress={() => handleAccept(card)}
                    >
                      <Text style={s.acceptBtnText}>
                        Accept · {fmtMicro(card.amountMicro)}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={s.passBtn}
                      onPress={() => handlePass(card.conversationId)}
                    >
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
                style={[
                  s.completedRow,
                  i < completedToday.length - 1 && s.completedRowBorder,
                ]}
              >
                <Text style={s.completedTitle}>{entry.description}</Text>
                <Text style={s.completedAmount}>{entry.reward}</Text>
              </View>
            ))}
          </View>
        </>
      )}
    </ScrollView>
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
});
