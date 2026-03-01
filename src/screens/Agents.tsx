/**
 * Agents — discovery screen: sortable list of agents on the mesh.
 * Tap an agent card to see a full profile sheet.
 */
import React, { useState } from 'react';
import {
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { AgentSummary, useAgentProfile, useAgents, useNetworkStats, useWatchlist } from '../hooks/useNodeApi';

const C = {
  bg:      '#050505',
  card:    '#0f0f0f',
  sheet:   '#111111',
  border:  '#1a1a1a',
  green:   '#00e676',
  red:     '#ff1744',
  blue:    '#2979ff',
  text:    '#ffffff',
  sub:     '#555555',
  accent:  '#00e676',
};

type SortKey = 'reputation' | 'active' | 'new';

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function trendArrow(trend: string): string {
  if (trend === 'rising')  return '↑';
  if (trend === 'falling') return '↓';
  return '—';
}

function trendColor(trend: string): string {
  if (trend === 'rising')  return C.green;
  if (trend === 'falling') return C.red;
  return C.sub;
}

// ============================================================================
// Profile modal
// ============================================================================

function ProfileModal({
  agentId,
  onClose,
  isWatched,
  onWatch,
  onUnwatch,
}: {
  agentId:   string;
  onClose:   () => void;
  isWatched: boolean;
  onWatch:   () => void;
  onUnwatch: () => void;
}) {
  const profile = useAgentProfile(agentId);

  return (
    <Modal animationType="slide" transparent onRequestClose={onClose}>
      <View style={ps.overlay}>
        <View style={ps.sheet}>
          <View style={ps.handle} />
          <TouchableOpacity style={ps.closeBtn} onPress={onClose}>
            <Text style={ps.closeTxt}>[X]</Text>
          </TouchableOpacity>

          <Text style={ps.agentName}>
            {profile?.name || shortId(agentId)}
          </Text>
          <Text style={ps.agentId}>{shortId(agentId)}</Text>

          <TouchableOpacity
            style={[ps.watchBtn, isWatched && ps.watchBtnActive]}
            onPress={isWatched ? onUnwatch : onWatch}
            activeOpacity={0.8}
          >
            <Text style={[ps.watchBtnText, isWatched && ps.watchBtnTextActive]}>
              {isWatched ? '\u2605 WATCHING' : '\u2606 WATCH'}
            </Text>
          </TouchableOpacity>

          {profile ? (
            <ScrollView style={ps.body}>
              {profile.reputation ? (
                <View style={ps.section}>
                  <Text style={ps.sectionLabel}>REPUTATION</Text>
                  <View style={ps.statsRow}>
                    <Stat label="SCORE"    value={String(profile.reputation.total_score)} />
                    <Stat label="VERDICTS" value={String(profile.reputation.verdict_count)} />
                    <Stat label="POSITIVE" value={String(profile.reputation.positive_count)} />
                    <Stat label="NEGATIVE" value={String(profile.reputation.negative_count)} />
                  </View>
                </View>
              ) : null}

              {profile.capabilities && profile.capabilities.length > 0 ? (
                <View style={ps.section}>
                  <Text style={ps.sectionLabel}>CAPABILITIES</Text>
                  <View style={ps.capRow}>
                    {profile.capabilities.map((c: any) => (
                      <View key={c.capability} style={ps.capBadge}>
                        <Text style={ps.capText}>{c.capability}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}

              {profile.disputes && profile.disputes.length > 0 ? (
                <View style={ps.section}>
                  <Text style={ps.sectionLabel}>RECENT DISPUTES</Text>
                  {profile.disputes.slice(0, 5).map((d: any) => (
                    <View key={d.id} style={ps.disputeRow}>
                      <Text style={ps.disputeText}>
                        from {shortId(d.sender)} · slot {d.slot}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </ScrollView>
          ) : (
            <Text style={ps.loading}>loading…</Text>
          )}
        </View>
      </View>
    </Modal>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={ps.stat}>
      <Text style={ps.statVal}>{value}</Text>
      <Text style={ps.statLabel}>{label}</Text>
    </View>
  );
}

// ============================================================================
// Agent card
// ============================================================================

function AgentCard({
  agent,
  rank,
  isWatched,
  onPress,
}: {
  agent:     AgentSummary;
  rank:      number;
  isWatched: boolean;
  onPress:   () => void;
}) {
  const arrow = trendArrow(agent.trend);
  const arrowColor = trendColor(agent.trend);
  const scoreColor = agent.total_score >= 0 ? C.green : C.red;

  return (
    <TouchableOpacity style={s.card} onPress={onPress} activeOpacity={0.7}>
      <View style={s.cardTop}>
        <View style={s.cardRankWrap}>
          <Text style={s.rankText}>#{rank}</Text>
        </View>
        <View style={s.cardLeft}>
          <View style={s.nameRow}>
            <Text style={s.cardName}>
              {agent.name || shortId(agent.agent_id)}
            </Text>
            {isWatched && <Text style={s.starText}> \u2605</Text>}
          </View>
          <Text style={s.cardId}>{shortId(agent.agent_id)}</Text>
        </View>
        <View style={s.cardRight}>
          <Text style={[s.score, { color: scoreColor }]}>
            {agent.total_score > 0 ? '+' : ''}{agent.total_score}
          </Text>
          <Text style={[s.trend, { color: arrowColor }]}>{arrow}</Text>
        </View>
      </View>
      <Text style={s.lastSeen}>{timeAgo(agent.last_seen)}</Text>
    </TouchableOpacity>
  );
}

// ============================================================================
// Main screen
// ============================================================================

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'reputation', label: 'REP' },
  { key: 'active',     label: 'ACTIVE' },
  { key: 'new',        label: 'NEW' },
];

export function AgentsScreen() {
  const [sort, setSort]           = useState<SortKey>('reputation');
  const [selected, setSelected]   = useState<string | null>(null);
  const stats  = useNetworkStats();
  const agents = useAgents(sort, 100);
  const { isWatched, watch, unwatch } = useWatchlist();

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.title}>AGENTS</Text>
        <Text style={s.subtitle}>
          {stats?.agent_count ?? '—'} on mesh
        </Text>
      </View>

      {/* Sort toggle */}
      <View style={s.sortBar}>
        {SORTS.map(({ key, label }) => (
          <TouchableOpacity
            key={key}
            style={[s.sortBtn, sort === key && s.sortBtnActive]}
            onPress={() => setSort(key)}
          >
            <Text style={[s.sortLabel, sort === key && s.sortLabelActive]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={agents}
        keyExtractor={a => a.agent_id}
        renderItem={({ item, index }) => (
          <AgentCard
            agent={item}
            rank={index + 1}
            isWatched={isWatched(item.agent_id)}
            onPress={() => setSelected(item.agent_id)}
          />
        )}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyText}>no agents found</Text>
          </View>
        }
        contentContainerStyle={agents.length === 0 ? s.emptyContainer : undefined}
      />

      {selected ? (
        <ProfileModal
          agentId={selected}
          onClose={() => setSelected(null)}
          isWatched={isWatched(selected)}
          onWatch={() => watch(selected)}
          onUnwatch={() => unwatch(selected)}
        />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root:          { flex: 1, backgroundColor: C.bg },
  header:        { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  title:         { fontSize: 20, fontWeight: '700', color: C.text, letterSpacing: 4, fontFamily: 'monospace' },
  subtitle:      { fontSize: 11, color: C.sub, letterSpacing: 2, marginTop: 2 },
  sortBar:       { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.border },
  sortBtn:       { flex: 1, alignItems: 'center', paddingVertical: 10 },
  sortBtnActive: { borderBottomWidth: 2, borderBottomColor: C.accent },
  sortLabel:     { fontSize: 11, color: C.sub, letterSpacing: 2, fontFamily: 'monospace' },
  sortLabelActive:{ color: C.accent },
  card:          { marginHorizontal: 16, marginTop: 10, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 14 },
  cardTop:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  cardRankWrap:  { width: 30, paddingTop: 2 },
  rankText:      { fontSize: 10, color: C.sub, fontFamily: 'monospace' },
  cardLeft:      { flex: 1 },
  nameRow:       { flexDirection: 'row', alignItems: 'center' },
  cardRight:     { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardName:      { fontSize: 14, fontWeight: '700', color: C.text, fontFamily: 'monospace' },
  starText:      { fontSize: 12, color: C.green },
  cardId:        { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginTop: 2 },
  score:         { fontSize: 18, fontWeight: '700', fontFamily: 'monospace' },
  trend:         { fontSize: 16, fontWeight: '700' },
  lastSeen:      { fontSize: 10, color: C.sub, marginTop: 6, fontFamily: 'monospace' },
  empty:         { alignItems: 'center', paddingTop: 60 },
  emptyContainer:{ flexGrow: 1 },
  emptyText:     { color: C.sub, fontFamily: 'monospace', letterSpacing: 2 },
});

const ps = StyleSheet.create({
  overlay:          { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet:            { backgroundColor: C.sheet, borderTopLeftRadius: 12, borderTopRightRadius: 12, paddingBottom: 40, maxHeight: '80%' },
  handle:           { width: 40, height: 4, backgroundColor: C.border, borderRadius: 2, alignSelf: 'center', marginTop: 12 },
  closeBtn:         { position: 'absolute', top: 16, right: 20 },
  closeTxt:         { color: C.sub, fontFamily: 'monospace', fontSize: 13 },
  agentName:        { fontSize: 18, fontWeight: '700', color: C.text, fontFamily: 'monospace', marginTop: 24, marginHorizontal: 20 },
  agentId:          { fontSize: 11, color: C.sub, fontFamily: 'monospace', marginHorizontal: 20, marginTop: 2, marginBottom: 8 },
  watchBtn:         { marginHorizontal: 20, marginBottom: 12, borderWidth: 1, borderColor: C.sub, borderRadius: 3, paddingVertical: 7, paddingHorizontal: 12, alignSelf: 'flex-start' },
  watchBtnActive:   { borderColor: C.green + '80', backgroundColor: C.green + '12' },
  watchBtnText:     { fontSize: 11, color: C.sub, fontFamily: 'monospace', letterSpacing: 1, fontWeight: '700' },
  watchBtnTextActive: { color: C.green },
  body:             { paddingHorizontal: 20 },
  loading:          { color: C.sub, fontFamily: 'monospace', margin: 20 },
  section:          { marginTop: 16 },
  sectionLabel:     { fontSize: 11, color: C.sub, letterSpacing: 3, marginBottom: 10 },
  statsRow:         { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  stat:             { flex: 1, minWidth: '40%', backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 12 },
  statVal:          { fontSize: 22, fontWeight: '700', color: C.text, fontFamily: 'monospace' },
  statLabel:        { fontSize: 10, color: C.sub, letterSpacing: 2, marginTop: 4 },
  capRow:           { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  capBadge:         { borderWidth: 1, borderColor: C.blue, borderRadius: 3, paddingHorizontal: 8, paddingVertical: 3 },
  capText:          { color: C.blue, fontSize: 11, fontFamily: 'monospace' },
  disputeRow:       { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.border },
  disputeText:      { color: C.red, fontSize: 11, fontFamily: 'monospace' },
});
