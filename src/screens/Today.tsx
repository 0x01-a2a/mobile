import React, { useMemo } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useNode } from '../hooks/useNode';
import { useAgentBrain } from '../hooks/useAgentBrain';
import { useTaskLog } from '../hooks/useNodeApi';

function isToday(timestampSeconds: number): boolean {
  const d = new Date(timestampSeconds * 1000);
  const now = new Date();
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

function sumEarnings(entries: any[], todayOnly: boolean): number {
  return entries
    .filter(e => e.outcome === 'success' && (!todayOnly || isToday(e.timestamp)))
    .reduce((acc, e) => acc + (e.amount_usd ?? 0), 0);
}

function fmt(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function relativeTime(timestampSeconds: number): string {
  const diffMs = Date.now() - timestampSeconds * 1000;
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return `${Math.floor(diffHrs / 24)}d ago`;
}

export default function TodayScreen() {
  const navigation = useNavigation<any>();
  const { status } = useNode();
  const { config: brain } = useAgentBrain();
  const { entries, loading } = useTaskLog();

  const agentName = brain?.name ?? 'Aria';
  const isRunning = status === 'running';
  const earnedToday = useMemo(() => sumEarnings(entries, true), [entries]);
  const earnedAllTime = useMemo(() => sumEarnings(entries, false), [entries]);
  const recentJobs = useMemo(() => entries.slice(0, 10), [entries]);

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      {/* Top bar */}
      <View style={s.topBar}>
        <Text style={s.pilotLabel}>01 PILOT</Text>
        <TouchableOpacity onPress={() => navigation.navigate('You')}>
          <Text style={s.settingsIcon}>◎</Text>
        </TouchableOpacity>
      </View>

      {/* Agent hero card */}
      <View style={s.heroCard}>
        <View style={s.heroRow}>
          <View style={s.avatarCircle}>
            <Text style={s.avatarIcon}>◉</Text>
          </View>
          <View style={s.heroInfo}>
            <Text style={s.agentName}>{agentName}</Text>
            <Text style={s.agentStatus}>
              {isRunning ? '● Working' : '○ Idle'}
            </Text>
          </View>
        </View>
        <View style={s.heroDivider} />
        <View style={s.earningsRow}>
          <View>
            <Text style={s.earningsLabel}>EARNED TODAY</Text>
            <Text style={s.earningsAmount}>{fmt(earnedToday)}</Text>
          </View>
          <View style={s.earningsRight}>
            <Text style={s.earningsLabel}>ALL TIME</Text>
            <Text style={[s.earningsAmount, s.earningsAmountMuted]}>{fmt(earnedAllTime)}</Text>
          </View>
        </View>
      </View>

      {/* Quick actions */}
      <View style={s.actionsRow}>
        <TouchableOpacity
          style={s.actionBtn}
          onPress={() => navigation.navigate('Chat', { initialMode: 'brief' })}
        >
          <Text style={s.actionText}>✦ Brief</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={s.actionBtn}
          onPress={() => navigation.navigate('Inbox')}
        >
          <Text style={s.actionText}>◈ Inbox</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.actionBtn, s.actionBtnPrimary]}
          onPress={() => navigation.navigate('Chat', { initialMode: 'chat' })}
        >
          <Text style={[s.actionText, s.actionTextPrimary]}>→ Send</Text>
        </TouchableOpacity>
      </View>

      {/* Section divider */}
      <View style={s.sectionDivider} />

      {/* Recent jobs */}
      <View style={s.section}>
        <Text style={s.sectionLabel}>RECENT JOBS</Text>
        {loading && <Text style={s.emptyText}>Loading…</Text>}
        {!loading && recentJobs.length === 0 && (
          <Text style={s.emptyText}>No jobs completed yet</Text>
        )}
        {recentJobs.map((entry, i) => {
          const isActive = !entry.outcome;
          const isLast = i === recentJobs.length - 1;
          return (
            <View key={entry.id} style={[s.jobRow, !isLast && s.jobRowBorder]}>
              <View>
                <Text style={[s.jobTitle, isActive && s.jobTitleMuted]}>
                  {entry.summary || 'Task'}
                </Text>
                <Text style={s.jobTime}>
                  {isActive ? 'in progress' : relativeTime(entry.timestamp)}
                </Text>
              </View>
              {isActive ? (
                <View style={s.workingBadge}>
                  <Text style={s.workingBadgeText}>working</Text>
                </View>
              ) : (
                <Text style={s.jobAmount}>+{fmt(entry.amount_usd)}</Text>
              )}
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  content: { paddingBottom: 24 },
  topBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4,
  },
  pilotLabel: { fontSize: 10, color: '#999', fontWeight: '600', letterSpacing: 0.5 },
  settingsIcon: { fontSize: 20, color: '#374151' },

  heroCard: {
    margin: 16, marginTop: 12,
    backgroundColor: '#f0fdf4',
    borderRadius: 14,
    borderWidth: 1, borderColor: '#bbf7d0',
    padding: 14,
  },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatarCircle: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: '#fff', borderWidth: 2, borderColor: '#86efac',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarIcon: { fontSize: 18, color: '#374151' },
  heroInfo: { flex: 1 },
  agentName: { fontSize: 13, fontWeight: '600', color: '#111' },
  agentStatus: { fontSize: 10, color: '#16a34a', marginTop: 2 },
  heroDivider: { height: 1, backgroundColor: '#bbf7d0', opacity: 0.5, marginVertical: 10 },
  earningsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  earningsRight: { alignItems: 'flex-end' },
  earningsLabel: { fontSize: 9, color: '#6b7280', letterSpacing: 0.3, marginBottom: 2 },
  earningsAmount: { fontSize: 18, fontWeight: '700', color: '#111', letterSpacing: -0.5 },
  earningsAmountMuted: { color: '#374151' },

  actionsRow: {
    flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 4,
  },
  actionBtn: {
    flex: 1, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10,
    paddingVertical: 9, alignItems: 'center',
  },
  actionBtnPrimary: { backgroundColor: '#111', borderColor: '#111' },
  actionText: { fontSize: 9, color: '#374151', fontWeight: '600' },
  actionTextPrimary: { color: '#fff' },

  sectionDivider: { height: 6, backgroundColor: '#f3f4f6', marginTop: 12 },

  section: { paddingHorizontal: 16, paddingTop: 14 },
  sectionLabel: {
    fontSize: 10, color: '#9ca3af', letterSpacing: 0.5, marginBottom: 10,
  },
  emptyText: { fontSize: 14, color: '#d1d5db', textAlign: 'center', paddingVertical: 24 },

  jobRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 8,
  },
  jobRowBorder: { borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  jobTitle: { fontSize: 12, color: '#111', fontWeight: '500' },
  jobTitleMuted: { color: '#9ca3af' },
  jobTime: { fontSize: 10, color: '#9ca3af', marginTop: 2 },
  jobAmount: { fontSize: 13, color: '#22c55e', fontWeight: '600' },
  workingBadge: {
    borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 4,
    paddingHorizontal: 6, paddingVertical: 2, backgroundColor: '#f9fafb',
  },
  workingBadgeText: { fontSize: 10, color: '#d1d5db' },
});
