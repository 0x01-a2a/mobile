/**
 * My — agent management hub.
 *
 * Two subtabs:
 *   Agents — all owned agents with status, reputation, location badge.
 *   Node   — local node controls, hosted banner, reputation detail, inbox.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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
import { useOwnedAgents, notifyLinkedAgentsUpdated, OwnedAgent } from '../hooks/useOwnedAgents';

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

type Subtab = 'agents' | 'node';

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

function trendColor(trend: string) {
  if (trend === 'rising')  return C.green;
  if (trend === 'falling') return C.red;
  return C.sub;
}

function trendArrow(trend: string) {
  if (trend === 'rising')  return '↑';
  if (trend === 'falling') return '↓';
  return '—';
}

// ── Signal bars ───────────────────────────────────────────────────────────

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
          style={[s.bar, { height: 4 + i * 3, backgroundColor: i <= level ? C.green : C.border }]}
        />
      ))}
    </View>
  );
}

// ── Agents subtab ─────────────────────────────────────────────────────────

function AgentCard({ agent }: { agent: OwnedAgent }) {
  const rep = useOwnReputation(agent.id || null, 60_000);
  const dotColor   = agent.status === 'running' ? C.green : C.sub;
  const badgeStyle = agent.mode === 'local' ? s.badgeLocal : agent.mode === 'hosted' ? s.badgeHosted : s.badgeLinked;
  const badgeColor = agent.mode === 'local' ? C.green : agent.mode === 'hosted' ? C.amber : C.blue;
  const badgeLabel = agent.mode === 'local' ? 'PHONE' : agent.mode === 'hosted' ? 'HOSTED' : 'LINKED';

  return (
    <View style={s.agentCard}>
      <View style={s.agentCardRow}>
        <View style={[s.dot, { backgroundColor: dotColor }]} />
        <View style={s.agentCardInfo}>
          <Text style={s.agentCardName}>{agent.name}</Text>
          <Text style={s.agentCardId}>{agent.id ? shortId(agent.id) : 'pending…'}</Text>
          {agent.mode === 'linked' && agent.ownerWallet && (
            <Text style={s.agentCardOwner}>owner {shortId(agent.ownerWallet)}</Text>
          )}
        </View>
        <View style={[s.modeBadge, badgeStyle]}>
          <Text style={[s.modeBadgeText, { color: badgeColor }]}>
            {badgeLabel}
          </Text>
        </View>
      </View>
      {rep && (
        <View style={s.agentCardStats}>
          <Text style={[s.agentScore, { color: rep.total_score >= 0 ? C.green : C.red }]}>
            {rep.total_score > 0 ? '+' : ''}{rep.total_score}
          </Text>
          <Text style={s.agentScoreLabel}> REP</Text>
          <Text style={s.agentDot}> · </Text>
          <Text style={[s.agentTrend, { color: trendColor(rep.trend) }]}>
            {trendArrow(rep.trend)} {rep.trend}
          </Text>
        </View>
      )}
    </View>
  );
}

// ── Link Agent section ────────────────────────────────────────────────────

type LinkPreview = { agentId: string; ownerWallet: string; ownerStatus: 'claimed' | 'pending' };

function LinkAgentSection() {
  const [expanded, setExpanded] = useState(false);
  const [inputId, setInputId]   = useState('');
  const [fetching, setFetching] = useState(false);
  const [preview, setPreview]   = useState<LinkPreview | null>(null);
  const [error, setError]       = useState<string | null>(null);

  const handleLookup = useCallback(async () => {
    const id = inputId.trim();
    if (!id) return;
    setFetching(true);
    setError(null);
    setPreview(null);
    try {
      const res = await fetch(`https://api.0x01.world/agents/${id}/owner`);
      if (!res.ok) { setError(`lookup failed (${res.status})`); return; }
      const data = await res.json();
      if (data.status === 'claimed') {
        setPreview({ agentId: id, ownerWallet: data.owner, ownerStatus: 'claimed' });
      } else if (data.status === 'pending') {
        setPreview({ agentId: id, ownerWallet: data.proposed_owner, ownerStatus: 'pending' });
      } else {
        setError('no owner claimed for this agent id');
      }
    } catch {
      setError('network error');
    } finally {
      setFetching(false);
    }
  }, [inputId]);

  const handleConfirm = useCallback(async () => {
    if (!preview) return;
    try {
      const raw = await AsyncStorage.getItem('zerox1:linked_agents');
      const existing: OwnedAgent[] = raw ? JSON.parse(raw) : [];
      if (existing.some(a => a.id === preview.agentId)) {
        setError('already linked');
        return;
      }
      const newAgent: OwnedAgent = {
        id:          preview.agentId,
        name:        `linked:${preview.agentId.slice(0, 8)}`,
        mode:        'linked',
        status:      'unknown',
        ownerWallet: preview.ownerWallet,
      };
      await AsyncStorage.setItem(
        'zerox1:linked_agents',
        JSON.stringify([...existing, newAgent]),
      );
      notifyLinkedAgentsUpdated();
      setPreview(null);
      setInputId('');
      setExpanded(false);
    } catch {
      setError('failed to save');
    }
  }, [preview]);

  const handleCancel = useCallback(() => {
    setExpanded(false);
    setInputId('');
    setPreview(null);
    setError(null);
  }, []);

  if (!expanded) {
    return (
      <TouchableOpacity style={s.linkBtn} onPress={() => setExpanded(true)} activeOpacity={0.7}>
        <Text style={s.linkBtnText}>+ LINK EXISTING AGENT</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={s.linkSection}>
      <Text style={s.sectionLabel}>LINK EXISTING AGENT</Text>
      <View style={s.card}>
        <Text style={s.linkHint}>enter agent id (hex ed25519 pubkey)</Text>
        <View style={s.linkInputRow}>
          <TextInput
            style={s.linkInput}
            value={inputId}
            onChangeText={text => { setInputId(text); setError(null); setPreview(null); }}
            placeholder="0000000000000000..."
            placeholderTextColor={C.sub}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={[s.lookupBtn, fetching && s.lookupBtnDisabled]}
            onPress={handleLookup}
            disabled={fetching}
            activeOpacity={0.8}
          >
            {fetching
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={s.lookupBtnText}>LOOK UP</Text>
            }
          </TouchableOpacity>
        </View>
        {error && <Text style={s.linkError}>{error}</Text>}
        {preview && (
          <View style={s.previewBox}>
            <View style={s.previewRow}>
              <Text style={s.previewLabel}>AGENT</Text>
              <Text style={s.previewVal}>{shortId(preview.agentId)}</Text>
            </View>
            <View style={s.previewRow}>
              <Text style={s.previewLabel}>OWNER</Text>
              <Text style={s.previewVal}>{shortId(preview.ownerWallet)}</Text>
            </View>
            {preview.ownerStatus === 'pending' && (
              <Text style={s.previewPending}>ownership claim pending</Text>
            )}
            <TouchableOpacity style={s.confirmBtn} onPress={handleConfirm} activeOpacity={0.8}>
              <Text style={s.confirmBtnText}>YES, THIS IS MY AGENT</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
      <TouchableOpacity style={s.cancelLink} onPress={handleCancel}>
        <Text style={s.cancelLinkText}>cancel</Text>
      </TouchableOpacity>
    </View>
  );
}

function AgentsSubtab() {
  const agents = useOwnedAgents();

  return (
    <ScrollView style={s.subtabRoot} contentContainerStyle={s.subtabContent}>
      <Text style={s.sectionLabel}>YOUR AGENTS</Text>
      {agents.map(a => (
        <AgentCard key={a.id || a.mode} agent={a} />
      ))}
      <LinkAgentSection />
      <Text style={s.hint}>
        Each agent runs on a node — your phone or a hosted server.
        Agents earn reputation and USDC by completing tasks on the mesh.
      </Text>
    </ScrollView>
  );
}

// ── Node subtab (existing MyAgent content) ────────────────────────────────

function HostedHeader({
  hostUrl,
  onDisconnect,
}: {
  hostUrl:      string;
  onDisconnect: () => void;
}) {
  const [rtt, setRtt] = useState<number | null>(null);

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
    try   { return new URL(hostUrl).host; }
    catch { return hostUrl.slice(0, 24); }
  })();

  return (
    <View style={s.hostedBanner}>
      <View style={{ flex: 1 }}>
        <Text style={s.hostedLabel}>HOSTED @</Text>
        <Text style={s.hostedHost}>{shortHost}</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <SignalBars rtt={rtt} />
        <TouchableOpacity style={s.disconnectBtn} onPress={onDisconnect} activeOpacity={0.8}>
          <Text style={s.disconnectText}>DISCONNECT</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
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
      <View style={{ flex: 1 }}>
        <Text style={s.inboxType}>{env.msg_type}</Text>
        <Text style={s.inboxFrom}>from {shortId(env.sender)}</Text>
      </View>
      <Text style={s.inboxSlot}>#{env.slot}</Text>
    </View>
  );
}

function NodeSubtab() {
  const { status, loading, start, stop, config, saveConfig } = useNode();
  const identity   = useIdentity();
  const rep        = useOwnReputation(identity?.agent_id ?? null);
  const [inbox, setInbox] = useState<InboundEnvelope[]>([]);
  const [hostedAgentId, setHostedAgentId] = useState<string | null>(null);

  const isHosted = Boolean(config.nodeApiUrl);

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
            await saveConfig({ ...config, nodeApiUrl: undefined });
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
  const displayId  = isHosted ? hostedAgentId : identity?.agent_id ?? null;
  const displayName = isHosted
    ? (hostedAgentId ? `hosted:${hostedAgentId.slice(0, 8)}` : 'hosted agent')
    : (identity?.name || 'unnamed agent');

  if (loading) {
    return (
      <View style={[s.subtabRoot, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={C.green} size="large" />
      </View>
    );
  }

  return (
    <ScrollView style={s.subtabRoot} contentContainerStyle={s.subtabContent}>
      {isHosted && (
        <HostedHeader hostUrl={config.nodeApiUrl!} onDisconnect={handleDisconnect} />
      )}

      <Text style={s.sectionLabel}>IDENTITY</Text>
      <View style={s.card}>
        <View style={s.identityRow}>
          <View style={[s.dot, { backgroundColor: dotColor }]} />
          <View style={{ flex: 1 }}>
            <Text style={s.agentName}>{displayName}</Text>
            <Text style={s.agentId}>{displayId ? shortId(displayId) : '—'}</Text>
          </View>
        </View>
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

      <Text style={s.sectionLabel}>REPUTATION</Text>
      <View style={s.card}>
        {rep ? (
          <>
            <View style={s.statsGrid}>
              <StatCard label="SCORE"    value={(rep.total_score > 0 ? '+' : '') + rep.total_score} color={scoreColor} />
              <StatCard label="VERDICTS" value={rep.verdict_count} />
              <StatCard label="POSITIVE" value={rep.positive_count} color={C.green} />
              <StatCard label="NEGATIVE" value={rep.negative_count} color={C.red} />
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12 }}>
              <Text style={[{ fontSize: 18, fontWeight: '700' }, { color: trendColor(rep.trend) }]}>
                {trendArrow(rep.trend)}
              </Text>
              <Text style={{ fontSize: 12, color: C.sub, fontFamily: 'monospace' }}> {rep.trend}</Text>
            </View>
          </>
        ) : (
          <Text style={s.noData}>no reputation data yet</Text>
        )}
      </View>

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

// ── Main screen ───────────────────────────────────────────────────────────

export function MyScreen() {
  const [subtab, setSubtab] = useState<Subtab>('agents');

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Text style={s.title}>MY</Text>
        <View style={s.tabs}>
          {(['agents', 'node'] as Subtab[]).map(t => (
            <TouchableOpacity
              key={t}
              style={[s.tab, subtab === t && s.tabActive]}
              onPress={() => setSubtab(t)}
              activeOpacity={0.7}
            >
              <Text style={[s.tabText, subtab === t && s.tabTextActive]}>
                {t.toUpperCase()}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {subtab === 'agents' ? <AgentsSubtab /> : <NodeSubtab />}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:            { flex: 1, backgroundColor: C.bg },
  header:          { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 0, borderBottomWidth: 1, borderBottomColor: C.border },
  title:           { fontSize: 13, fontWeight: '700', color: C.text, letterSpacing: 3, fontFamily: 'monospace', marginBottom: 14 },
  tabs:            { flexDirection: 'row' },
  tab:             { paddingVertical: 10, paddingHorizontal: 20, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive:       { borderBottomColor: C.green },
  tabText:         { fontSize: 11, color: C.sub, letterSpacing: 2, fontWeight: '700', fontFamily: 'monospace' },
  tabTextActive:   { color: C.green },
  subtabRoot:      { flex: 1 },
  subtabContent:   { padding: 20 },
  sectionLabel:    { fontSize: 11, color: C.sub, letterSpacing: 3, marginBottom: 10, marginTop: 20 },
  card:            { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 16, marginBottom: 4 },
  hint:            { fontSize: 11, color: C.sub, fontFamily: 'monospace', lineHeight: 18, marginTop: 20, textAlign: 'center' },
  // agent card
  agentCard:       { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 14, marginBottom: 8 },
  agentCardRow:    { flexDirection: 'row', alignItems: 'center' },
  agentCardInfo:   { flex: 1 },
  agentCardName:   { fontSize: 14, fontWeight: '700', color: C.text, fontFamily: 'monospace' },
  agentCardId:     { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginTop: 2 },
  agentCardStats:  { flexDirection: 'row', alignItems: 'center', marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.border },
  agentScore:      { fontSize: 16, fontWeight: '700', fontFamily: 'monospace' },
  agentScoreLabel: { fontSize: 10, color: C.sub },
  agentDot:        { color: C.sub, marginHorizontal: 4 },
  agentTrend:      { fontSize: 11, fontFamily: 'monospace' },
  modeBadge:       { borderRadius: 3, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1 },
  badgeLocal:      { backgroundColor: '#00e67615', borderColor: '#00e67640' },
  badgeHosted:     { backgroundColor: '#ffc10715', borderColor: '#ffc10740' },
  badgeLinked:     { backgroundColor: '#2979ff15', borderColor: '#2979ff40' },
  modeBadgeText:   { fontSize: 9, fontWeight: '700', letterSpacing: 2 },
  dot:             { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  agentCardOwner:  { fontSize: 9, color: C.blue, fontFamily: 'monospace', marginTop: 2 },
  // node subtab
  identityRow:     { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  agentName:       { fontSize: 16, fontWeight: '700', color: C.text, fontFamily: 'monospace' },
  agentId:         { fontSize: 11, color: C.sub, fontFamily: 'monospace', marginTop: 2 },
  btn:             { borderRadius: 4, paddingVertical: 12, alignItems: 'center' },
  btnText:         { fontSize: 12, fontWeight: '700', letterSpacing: 3 },
  statsGrid:       { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  statCard:        { flex: 1, minWidth: '45%', backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 12 },
  statVal:         { fontSize: 24, fontWeight: '700', color: C.text, fontFamily: 'monospace' },
  statLabel:       { fontSize: 10, color: C.sub, letterSpacing: 2, marginTop: 4 },
  noData:          { color: C.sub, fontFamily: 'monospace', letterSpacing: 1 },
  inboxRow:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  inboxType:       { fontSize: 12, fontWeight: '700', color: C.green, fontFamily: 'monospace' },
  inboxFrom:       { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginTop: 2 },
  inboxSlot:       { fontSize: 10, color: C.sub, fontFamily: 'monospace' },
  hostedBanner:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.green + '40', borderRadius: 4, padding: 14, marginBottom: 4 },
  hostedLabel:     { fontSize: 9, color: C.green, letterSpacing: 3, fontWeight: '700' },
  hostedHost:      { fontSize: 13, color: C.text, fontFamily: 'monospace', marginTop: 2 },
  disconnectBtn:   { borderWidth: 1, borderColor: C.red + '60', borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4 },
  disconnectText:  { fontSize: 9, color: C.red, letterSpacing: 2, fontWeight: '700' },
  barsRow:         { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  bar:             { width: 4, borderRadius: 1 },
  signalNull:      { fontSize: 14, color: C.sub },
  // link agent
  linkBtn:         { borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 14, alignItems: 'center', marginTop: 12 },
  linkBtnText:     { fontSize: 11, color: C.sub, letterSpacing: 2, fontFamily: 'monospace' },
  linkSection:     { marginTop: 12 },
  linkHint:        { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginBottom: 10 },
  linkInputRow:    { flexDirection: 'row', gap: 8 },
  linkInput:       { flex: 1, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 8, color: C.text, fontFamily: 'monospace', fontSize: 12 },
  lookupBtn:       { backgroundColor: C.blue, borderRadius: 4, paddingHorizontal: 14, justifyContent: 'center', alignItems: 'center', minWidth: 80 },
  lookupBtnDisabled: { opacity: 0.5 },
  lookupBtnText:   { fontSize: 10, fontWeight: '700', color: '#fff', letterSpacing: 2 },
  linkError:       { fontSize: 10, color: C.red, fontFamily: 'monospace', marginTop: 8 },
  previewBox:      { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: C.border },
  previewRow:      { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  previewLabel:    { fontSize: 10, color: C.sub, fontFamily: 'monospace', letterSpacing: 2 },
  previewVal:      { fontSize: 11, color: C.text, fontFamily: 'monospace' },
  previewPending:  { fontSize: 10, color: C.amber, fontFamily: 'monospace', marginBottom: 6 },
  confirmBtn:      { backgroundColor: C.blue, borderRadius: 4, paddingVertical: 10, alignItems: 'center', marginTop: 10 },
  confirmBtnText:  { fontSize: 11, fontWeight: '700', color: '#fff', letterSpacing: 2 },
  cancelLink:      { alignItems: 'center', paddingVertical: 10 },
  cancelLinkText:  { fontSize: 10, color: C.sub, fontFamily: 'monospace' },
});
