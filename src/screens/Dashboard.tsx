/**
 * Dashboard — node status, start/stop, and live network metrics.
 */
import React from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNode } from '../hooks/useNode';
import { useNetworkStats, usePeers } from '../hooks/useNodeApi';

const C = {
  bg:     '#050505',
  card:   '#0f0f0f',
  border: '#1a1a1a',
  green:  '#00e676',
  red:    '#ff1744',
  amber:  '#ffc107',
  text:   '#ffffff',
  sub:    '#555555',
};

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={s.card}>
      <Text style={s.cardVal}>{value}</Text>
      <Text style={s.cardLabel}>{label}</Text>
    </View>
  );
}

export function DashboardScreen() {
  const { status, loading, start, stop } = useNode();
  const peers = usePeers();
  const stats = useNetworkStats();

  const running = status === 'running';
  const isError = status === 'error';
  const dotColor = running ? C.green : isError ? C.amber : C.red;

  if (loading) {
    return (
      <View style={[s.root, s.center]}>
        <ActivityIndicator color={C.green} size="large" />
      </View>
    );
  }

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      {/* Status */}
      <View style={s.header}>
        <View style={[s.dot, { backgroundColor: dotColor }]} />
        <Text style={s.statusText}>{status.toUpperCase()}</Text>
      </View>

      {/* Start / Stop */}
      <TouchableOpacity
        style={[s.btn, { backgroundColor: running ? C.red : C.green }]}
        onPress={running ? stop : () => start()}
        activeOpacity={0.8}
      >
        <Text style={[s.btnText, { color: running ? C.text : '#000' }]}>
          {running ? 'STOP NODE' : 'START NODE'}
        </Text>
      </TouchableOpacity>

      <Text style={s.sectionLabel}>NETWORK</Text>

      {/* Metrics grid */}
      <View style={s.grid}>
        <StatCard label="PEERS" value={peers.length} />
        <StatCard label="AGENTS" value={stats?.agent_count ?? '—'} />
        <StatCard
          label="BEACON BPM"
          value={stats ? stats.beacon_bpm.toFixed(1) : '—'}
        />
        <StatCard label="INTERACTIONS" value={stats?.interaction_count ?? '—'} />
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root:        { flex: 1, backgroundColor: C.bg },
  content:     { padding: 24 },
  center:      { justifyContent: 'center', alignItems: 'center' },
  header:      { flexDirection: 'row', alignItems: 'center', marginBottom: 32 },
  dot:         { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  statusText:  { fontSize: 28, fontWeight: '700', color: C.text, letterSpacing: 4, fontFamily: 'monospace' },
  btn:         { borderRadius: 4, paddingVertical: 16, alignItems: 'center', marginBottom: 40 },
  btnText:     { fontSize: 13, fontWeight: '700', letterSpacing: 3 },
  sectionLabel:{ fontSize: 11, color: C.sub, letterSpacing: 3, marginBottom: 12 },
  grid:        { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card:        {
    flex: 1,
    minWidth: '45%',
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    padding: 16,
  },
  cardVal:     { fontSize: 28, fontWeight: '700', color: C.text, fontFamily: 'monospace' },
  cardLabel:   { fontSize: 11, color: C.sub, letterSpacing: 2, marginTop: 6 },
});
