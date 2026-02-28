/**
 * MyAgent — own agent profile + node controls.
 *
 * Local mode:  START/STOP button, identity from /identity, reputation from aggregator.
 * Hosted mode: "HOSTED @ <host>" banner with signal bars, hosted agent_id from AsyncStorage,
 *              DISCONNECT button to revert to local mode.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNode } from '../hooks/useNode';
import {
  InboundEnvelope,
  clearTokenFromKeychain,
  probeRtt,
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

// ── Signal bars ──────────────────────────────────────────────────────────────

function signalLevel(rtt: number | null): number {
  if (rtt === null) return 0;
  if (rtt <= 50)   return 5;
  if (rtt <= 100)  return 4;
  if (rtt <= 200)  return 3;
  if (rtt <= 500)  return 2;
  return 1;
}

function SignalBars({ rtt }: { rtt: number | null }) {
  const level = signalLevel(rtt);
  if (rtt === null) return <Text style={s.signalNull}>—</Text>;
  return (
    <View style={s.barsRow}>
      {[1, 2, 3, 4, 5].map(i => (
        <View
          key={i}
          style={[
            s.bar,
            { height: 4 + i * 3, backgroundColor: i <= level ? C.green : C.border },
          ]}
        />
      ))}
    </View>
  );
}

// ── Hosted-mode header ───────────────────────────────────────────────────────

function HostedHeader({
  hostUrl,
  onDisconnect,
}: {
  hostUrl:      string;
  onDisconnect: () => void;
}) {
  const [rtt, setRtt] = useState<number | null>(null);

  // Probe RTT on mount and every 30s.
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      const ms = await probeRtt(hostUrl);
      if (!cancelled) setRtt(ms);
    };
    probe();
    const id = setInterval(probe, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [hostUrl]);

  const shortHost = (() => {
    try {
      return new URL(hostUrl).host;
    } catch {
      return hostUrl.slice(0, 24);
    }
  })();

  return (
    <View style={s.hostedBanner}>
      <View style={s.hostedBannerLeft}>
        <Text style={s.hostedLabel}>HOSTED @</Text>
        <Text style={s.hostedHost}>{shortHost}</Text>
      </View>
      <View style={s.hostedBannerRight}>
        <SignalBars rtt={rtt} />
        <TouchableOpacity
          style={s.disconnectBtn}
          onPress={onDisconnect}
          activeOpacity={0.8}
        >
          <Text style={s.disconnectText}>DISCONNECT</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Main screen ──────────────────────────────────────────────────────────────

export function MyAgentScreen() {
  const { status, loading, start, stop, config, saveConfig } = useNode();
  const identity = useIdentity();
  const rep      = useOwnReputation(identity?.agent_id ?? null);
  const [inbox, setInbox] = useState<InboundEnvelope[]>([]);
  const [hostedAgentId, setHostedAgentId] = useState<string | null>(null);

  const isHosted = Boolean(config.nodeApiUrl);

  // Load hosted agent_id from AsyncStorage when in hosted mode.
  useEffect(() => {
    if (!isHosted) { setHostedAgentId(null); return; }
    AsyncStorage.getItem('zerox1:hosted_agent_id')
      .then(id => setHostedAgentId(id))
      .catch(() => {});
  }, [isHosted]);

  const onEnvelope = useCallback((env: InboundEnvelope) => {
    setInbox(prev => {
      const next = [env, ...prev];
      return next.length > 20 ? next.slice(0, 20) : next;
    });
  }, []);

  useInbox(onEnvelope, status === 'running');

  // Clear hosted-mode credentials and revert to local node.
  const handleDisconnect = useCallback(() => {
    Alert.alert(
      'Disconnect from host',
      'Return to running your own local node?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            await clearTokenFromKeychain();
            await AsyncStorage.multiRemove([
              'zerox1:hosted_mode',
              'zerox1:host_url',
              'zerox1:hosted_agent_id',
            ]);
            const newConfig = { ...config, nodeApiUrl: undefined };
            await saveConfig(newConfig);
            await stop();
          },
        },
      ],
    );
  }, [config, saveConfig, stop]);

  const running    = status === 'running';
  const isError    = status === 'error';
  const dotColor   = running ? C.green : isError ? C.amber : C.red;
  const scoreColor = rep && rep.total_score >= 0 ? C.green : C.red;

  // Display agent_id: prefer hosted_agent_id in hosted mode, else from /identity.
  const displayAgentId = isHosted ? hostedAgentId : identity?.agent_id ?? null;
  const displayName    = isHosted
    ? (hostedAgentId ? `hosted:${hostedAgentId.slice(0, 8)}` : 'hosted agent')
    : (identity?.name || 'unnamed agent');

  if (loading) {
    return (
      <View style={[s.root, s.center]}>
        <ActivityIndicator color={C.green} size="large" />
      </View>
    );
  }

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      {/* Hosted banner — shown instead of START/STOP when in hosted mode */}
      {isHosted && (
        <HostedHeader
          hostUrl={config.nodeApiUrl!}
          onDisconnect={handleDisconnect}
        />
      )}

      {/* Identity card */}
      <Text style={s.sectionLabel}>IDENTITY</Text>
      <View style={s.card}>
        <View style={s.identityRow}>
          <View style={[s.dot, { backgroundColor: dotColor }]} />
          <View style={s.identityText}>
            <Text style={s.agentName}>{displayName}</Text>
            <Text style={s.agentId}>
              {displayAgentId ? shortId(displayAgentId) : '—'}
            </Text>
          </View>
        </View>

        {/* START/STOP only in local mode */}
        {!isHosted && (
          <TouchableOpacity
            style={[s.btn, { backgroundColor: running ? C.red : C.green }]}
            onPress={running ? stop : () => start()}
            activeOpacity={0.8}
          >
            <Text style={[s.btnText, { color: running ? C.text : '#000' }]}>
              {running ? 'STOP NODE' : 'START NODE'}
            </Text>
          </TouchableOpacity>
        )}
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
  // Hosted mode
  hostedBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.green + '40',
    borderRadius: 4,
    padding: 14,
    marginBottom: 4,
  },
  hostedBannerLeft:  { flex: 1 },
  hostedBannerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  hostedLabel:  { fontSize: 9, color: C.green, letterSpacing: 3, fontWeight: '700' },
  hostedHost:   { fontSize: 13, color: C.text, fontFamily: 'monospace', marginTop: 2 },
  disconnectBtn: {
    borderWidth: 1,
    borderColor: C.red + '60',
    borderRadius: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  disconnectText: { fontSize: 9, color: C.red, letterSpacing: 2, fontWeight: '700' },
  barsRow:      { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  bar:          { width: 4, borderRadius: 1 },
  signalNull:   { fontSize: 14, color: C.sub },
});
