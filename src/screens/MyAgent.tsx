/**
 * MyAgent — own agent profile + node controls.
 * Sections: identity card, reputation card, recent inbox activity.
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNode } from '../hooks/useNode';
import {
  InboundEnvelope,
  useIdentity,
  useInbox,
  useOwnReputation,
} from '../hooks/useNodeApi';

const C = {
  bg:     '#050505',
  card:   '#0f0f0f',
  border: '#1a1a1a',
  green:  '#00e676',
  red:    '#ff1744',
  amber:  '#ffc107',
  blue:   '#2979ff',
  text:   '#ffffff',
  sub:    '#555555',
};

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

function trendColor(trend: string): string {
  if (trend === 'rising')  return C.green;
  if (trend === 'falling') return C.red;
  return C.sub;
}

function trendArrow(trend: string): string {
  if (trend === 'rising')  return '↑';
  if (trend === 'falling') return '↓';
  return '—';
}

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <View style={s.statCard}>
      <Text style={[s.statVal, color ? { color } : undefined]}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

function InboxRow({ env }: { env: InboundEnvelope }) {
  return (
    <View style={s.inboxRow}>
      <View style={s.inboxLeft}>
        <Text style={s.inboxType}>{env.msg_type}</Text>
        <Text style={s.inboxFrom}>from {shortId(env.sender)}</Text>
      </View>
      <Text style={s.inboxSlot}>#{env.slot}</Text>
    </View>
  );
}

export function MyAgentScreen() {
  const { status, loading, start, stop } = useNode();
  const identity = useIdentity();
  const rep      = useOwnReputation(identity?.agent_id ?? null);
  const [inbox, setInbox] = useState<InboundEnvelope[]>([]);

  const onEnvelope = useCallback((env: InboundEnvelope) => {
    setInbox(prev => {
      const next = [env, ...prev];
      return next.length > 20 ? next.slice(0, 20) : next;
    });
  }, []);

  useInbox(onEnvelope, status === 'running');

  const running  = status === 'running';
  const isError  = status === 'error';
  const dotColor = running ? C.green : isError ? C.amber : C.red;
  const scoreColor = rep && rep.total_score >= 0 ? C.green : C.red;

  if (loading) {
    return (
      <View style={[s.root, s.center]}>
        <ActivityIndicator color={C.green} size="large" />
      </View>
    );
  }

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      {/* Identity card */}
      <Text style={s.sectionLabel}>IDENTITY</Text>
      <View style={s.card}>
        <View style={s.identityRow}>
          <View style={[s.dot, { backgroundColor: dotColor }]} />
          <View style={s.identityText}>
            <Text style={s.agentName}>
              {identity?.name || 'unnamed agent'}
            </Text>
            <Text style={s.agentId}>
              {identity ? shortId(identity.agent_id) : '—'}
            </Text>
          </View>
        </View>
        <TouchableOpacity
          style={[s.btn, { backgroundColor: running ? C.red : C.green }]}
          onPress={running ? stop : () => start()}
          activeOpacity={0.8}
        >
          <Text style={[s.btnText, { color: running ? C.text : '#000' }]}>
            {running ? 'STOP NODE' : 'START NODE'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Reputation card */}
      <Text style={s.sectionLabel}>REPUTATION</Text>
      <View style={s.card}>
        {rep ? (
          <>
            <View style={s.statsGrid}>
              <StatCard
                label="SCORE"
                value={(rep.total_score > 0 ? '+' : '') + rep.total_score}
                color={scoreColor}
              />
              <StatCard label="VERDICTS"  value={rep.verdict_count} />
              <StatCard label="POSITIVE"  value={rep.positive_count} color={C.green} />
              <StatCard label="NEGATIVE"  value={rep.negative_count} color={C.red} />
            </View>
            <View style={s.trendRow}>
              <Text style={[s.trendArrow, { color: trendColor(rep.trend) }]}>
                {trendArrow(rep.trend)}
              </Text>
              <Text style={s.trendLabel}> {rep.trend}</Text>
            </View>
          </>
        ) : (
          <Text style={s.noData}>no reputation data yet</Text>
        )}
      </View>

      {/* Recent inbox */}
      <Text style={s.sectionLabel}>RECENT ACTIVITY</Text>
      <View style={s.card}>
        {inbox.length === 0 ? (
          <Text style={s.noData}>
            {running ? 'listening for envelopes…' : 'start node to see activity'}
          </Text>
        ) : (
          inbox.map((env, i) => <InboxRow key={i} env={env} />)
        )}
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: C.bg },
  content:      { padding: 20 },
  center:       { justifyContent: 'center', alignItems: 'center' },
  sectionLabel: { fontSize: 11, color: C.sub, letterSpacing: 3, marginBottom: 10, marginTop: 20 },
  card:         { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 16, marginBottom: 4 },
  identityRow:  { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  dot:          { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  identityText: { flex: 1 },
  agentName:    { fontSize: 16, fontWeight: '700', color: C.text, fontFamily: 'monospace' },
  agentId:      { fontSize: 11, color: C.sub, fontFamily: 'monospace', marginTop: 2 },
  btn:          { borderRadius: 4, paddingVertical: 12, alignItems: 'center' },
  btnText:      { fontSize: 12, fontWeight: '700', letterSpacing: 3 },
  statsGrid:    { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  statCard:     { flex: 1, minWidth: '45%', backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 12 },
  statVal:      { fontSize: 24, fontWeight: '700', color: C.text, fontFamily: 'monospace' },
  statLabel:    { fontSize: 10, color: C.sub, letterSpacing: 2, marginTop: 4 },
  trendRow:     { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  trendArrow:   { fontSize: 18, fontWeight: '700' },
  trendLabel:   { fontSize: 12, color: C.sub, fontFamily: 'monospace' },
  noData:       { color: C.sub, fontFamily: 'monospace', letterSpacing: 1 },
  inboxRow:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  inboxLeft:    { flex: 1 },
  inboxType:    { fontSize: 12, fontWeight: '700', color: C.green, fontFamily: 'monospace' },
  inboxFrom:    { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginTop: 2 },
  inboxSlot:    { fontSize: 10, color: C.sub, fontFamily: 'monospace' },
});
