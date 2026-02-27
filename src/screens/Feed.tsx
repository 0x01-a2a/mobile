/**
 * Feed — live activity timeline from the aggregator.
 * Events: JOIN (green), FEEDBACK+ (green), FEEDBACK- (red), DISPUTE (red), VERDICT (blue).
 */
import React, { useCallback, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ActivityEvent, useActivityFeed } from '../hooks/useNodeApi';

const C = {
  bg:      '#050505',
  card:    '#0f0f0f',
  border:  '#1a1a1a',
  green:   '#00e676',
  red:     '#ff1744',
  blue:    '#2979ff',
  amber:   '#ffc107',
  text:    '#ffffff',
  sub:     '#555555',
  accent:  '#00e676',
};

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60)   return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function badgeColor(ev: ActivityEvent): string {
  if (ev.event_type === 'JOIN')    return C.green;
  if (ev.event_type === 'VERDICT') return C.blue;
  if (ev.event_type === 'DISPUTE') return C.red;
  // FEEDBACK
  if ((ev.score ?? 0) >= 0) return C.green;
  return C.red;
}

function badgeLabel(ev: ActivityEvent): string {
  if (ev.event_type === 'FEEDBACK') {
    const sign = (ev.score ?? 0) >= 0 ? '+' : '';
    return `FB${sign}${ev.score ?? ''}`;
  }
  return ev.event_type;
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function agentLabel(name: string | undefined, id: string): string {
  return name && name.length > 0 ? name : shortId(id);
}

function FeedRow({ ev }: { ev: ActivityEvent }) {
  const color = badgeColor(ev);
  return (
    <View style={s.row}>
      <View style={s.rowMain}>
        <Text style={[s.agentName, { color: C.accent }]}>
          {agentLabel(ev.name, ev.agent_id)}
        </Text>
        {ev.target_id ? (
          <>
            <Text style={s.arrow}> → </Text>
            <Text style={[s.agentName, { color: C.text }]}>
              {agentLabel(ev.target_name, ev.target_id)}
            </Text>
          </>
        ) : null}
        <View style={[s.badge, { borderColor: color }]}>
          <Text style={[s.badgeText, { color }]}>{badgeLabel(ev)}</Text>
        </View>
      </View>
      <View style={s.rowMeta}>
        {ev.slot ? (
          <Text style={s.slot}>#{ev.slot}</Text>
        ) : null}
        <Text style={s.timeAgo}>{timeAgo(ev.ts)}</Text>
      </View>
    </View>
  );
}

export function FeedScreen() {
  const events = useActivityFeed(50);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(() => {
    // The hook auto-reconnects; just briefly show the indicator.
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 800);
  }, []);

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Text style={s.title}>FEED</Text>
        <Text style={s.subtitle}>live mesh activity</Text>
      </View>
      <FlatList
        data={events}
        keyExtractor={item => String(item.id)}
        renderItem={({ item }) => <FeedRow ev={item} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={C.green}
          />
        }
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyText}>waiting for events…</Text>
          </View>
        }
        contentContainerStyle={events.length === 0 ? s.emptyContainer : undefined}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root:          { flex: 1, backgroundColor: C.bg },
  header:        { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  title:         { fontSize: 20, fontWeight: '700', color: C.text, letterSpacing: 4, fontFamily: 'monospace' },
  subtitle:      { fontSize: 11, color: C.sub, letterSpacing: 2, marginTop: 2 },
  row:           { paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  rowMain:       { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  rowMeta:       { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  agentName:     { fontSize: 13, fontWeight: '700', fontFamily: 'monospace' },
  arrow:         { fontSize: 13, color: C.sub },
  badge:         { borderWidth: 1, borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1, marginLeft: 8 },
  badgeText:     { fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  slot:          { fontSize: 10, color: C.sub, fontFamily: 'monospace' },
  timeAgo:       { fontSize: 10, color: C.sub, fontFamily: 'monospace' },
  empty:         { alignItems: 'center', paddingTop: 60 },
  emptyContainer:{ flexGrow: 1 },
  emptyText:     { color: C.sub, fontFamily: 'monospace', letterSpacing: 2 },
});
