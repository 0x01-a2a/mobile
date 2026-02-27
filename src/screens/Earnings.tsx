/**
 * Earnings — reputation score and verdict history for the local node.
 */
import React from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useIdentity, useOwnReputation } from '../hooks/useNodeApi';
import { useNode } from '../hooks/useNode';

const C = {
  bg:     '#050505',
  card:   '#0f0f0f',
  border: '#1a1a1a',
  green:  '#00e676',
  red:    '#ff1744',
  text:   '#ffffff',
  sub:    '#555555',
};

function Row({ label, value, valueColor }: { label: string; value: string | number; valueColor?: string }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowValue, valueColor ? { color: valueColor } : {}]}>{value}</Text>
    </View>
  );
}

export function EarningsScreen() {
  const { status } = useNode();
  const identity = useIdentity();
  const rep = useOwnReputation(identity?.agent_id ?? null);

  const running = status === 'running';

  if (running && !identity) {
    return (
      <View style={[s.root, s.center]}>
        <ActivityIndicator color={C.green} size="large" />
      </View>
    );
  }

  if (!running) {
    return (
      <View style={[s.root, s.center]}>
        <Text style={s.offlineText}>Node is stopped</Text>
      </View>
    );
  }

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      <Text style={s.heading}>REPUTATION</Text>

      {/* Agent identity */}
      {identity && (
        <View style={s.identityCard}>
          <Text style={s.agentName}>{identity.name || 'unnamed'}</Text>
          <Text style={s.agentId} numberOfLines={1} ellipsizeMode="middle">
            {identity.agent_id}
          </Text>
        </View>
      )}

      {/* Score */}
      {rep ? (
        <View style={s.scoreCard}>
          <Text style={s.scoreNum}>{rep.total_score}</Text>
          <Text style={s.scoreLabel}>TOTAL SCORE</Text>
        </View>
      ) : (
        <View style={s.scoreCard}>
          <Text style={s.scoreNum}>—</Text>
          <Text style={s.scoreLabel}>NO DATA YET</Text>
        </View>
      )}

      {/* Stats */}
      <View style={s.statsCard}>
        <Row label="VERDICTS"        value={rep?.verdict_count   ?? '—'} />
        <Row label="FEEDBACK"        value={rep?.feedback_count  ?? '—'} />
        <Row label="POSITIVE"        value={rep?.positive_count  ?? '—'} valueColor={C.green} />
        <Row label="NEGATIVE"        value={rep?.negative_count  ?? '—'} valueColor={C.red} />
        <Row label="TREND"           value={rep?.trend            ?? '—'} />
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: C.bg },
  content:      { padding: 24 },
  center:       { justifyContent: 'center', alignItems: 'center' },
  offlineText:  { color: C.sub, fontSize: 14, fontFamily: 'monospace' },
  heading:      { fontSize: 11, color: C.sub, letterSpacing: 4, marginBottom: 24 },
  identityCard: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    padding: 16,
    marginBottom: 16,
  },
  agentName:    { fontSize: 16, fontWeight: '700', color: C.text, marginBottom: 6 },
  agentId:      { fontSize: 11, color: C.sub, fontFamily: 'monospace' },
  scoreCard:    {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    padding: 24,
    alignItems: 'center',
    marginBottom: 16,
  },
  scoreNum:     { fontSize: 56, fontWeight: '700', color: C.green, fontFamily: 'monospace' },
  scoreLabel:   { fontSize: 11, color: C.sub, letterSpacing: 3, marginTop: 8 },
  statsCard:    {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    overflow: 'hidden',
  },
  row:          {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  rowLabel:     { fontSize: 11, color: C.sub, letterSpacing: 2 },
  rowValue:     { fontSize: 16, fontWeight: '700', color: C.text, fontFamily: 'monospace' },
});
