import React, { useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Image, Modal,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { useNode } from '../hooks/useNode';
import { useTaskLog, useSkrLeague } from '../hooks/useNodeApi';
import { DEFAULT_AGENT_ICON_URI } from '../assets/defaultAgentIcon';

function isToday(timestampSeconds: number): boolean {
  const d = new Date(timestampSeconds * 1000);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
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
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return `${Math.floor(diffHrs / 24)}d ago`;
}

function fmtRate(pct: number): string {
  if (pct === 0) return '0.0%';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function seasonCountdown(endsAt: number): string {
  const days = Math.ceil((endsAt * 1000 - Date.now()) / 86_400_000);
  if (days >= 2) return `Season ends in ${days}d`;
  if (days === 1) return 'Season ends tomorrow';
  if (days === 0) return 'Season ends today';
  return 'Season ended';
}

export default function TodayScreen() {
  const navigation = useNavigation<any>();
  const { t } = useTranslation();
  const { status, config } = useNode();
  const { entries, loading } = useTaskLog();
  const { data: leagueData } = useSkrLeague();
  const [leagueModalVisible, setLeagueModalVisible] = useState(false);

  const agentName = config?.agentName ?? 'Aria';
  const isRunning = status === 'running';
  const earnedToday = useMemo(() => sumEarnings(entries, true), [entries]);
  const earnedAllTime = useMemo(() => sumEarnings(entries, false), [entries]);
  const recentJobs = useMemo(
    () => entries.filter(e => e.outcome === 'success').slice(0, 10),
    [entries],
  );

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
            <Image
              source={{ uri: config?.agentAvatar || DEFAULT_AGENT_ICON_URI }}
              style={s.avatarImage}
            />
          </View>
          <View style={s.heroInfo}>
            <Text style={s.agentName}>{agentName}</Text>
            <Text style={s.agentStatus}>
              {isRunning ? `● ${t('today.statusWorking')}` : `○ ${t('today.statusIdle')}`}
            </Text>
          </View>
        </View>
        <View style={s.heroDivider} />
        <View style={s.earningsRow}>
          <View>
            <Text style={s.earningsLabel}>{t('today.earnedToday')}</Text>
            <Text style={s.earningsAmount}>{fmt(earnedToday)}</Text>
          </View>
          <View style={s.earningsRight}>
            <Text style={s.earningsLabel}>{t('today.allTime')}</Text>
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
          <Text style={s.actionText}>✦ {t('today.brief')}</Text>
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
          <Text style={[s.actionText, s.actionTextPrimary]}>→ {t('today.send')}</Text>
        </TouchableOpacity>
      </View>

      {/* Section divider */}
      <View style={s.sectionDivider} />

      {/* Recent jobs */}
      <View style={s.section}>
        <Text style={s.sectionLabel}>{t('today.recentJobs')}</Text>
        {loading && <Text style={s.emptyText}>Loading…</Text>}
        {!loading && recentJobs.length === 0 && (
          <Text style={s.emptyText}>{t('today.noJobs')}</Text>
        )}
        {recentJobs.map((entry, i) => {
          const isActive = entry.outcome !== 'success' && (entry.amount_usd ?? 0) === 0;
          const isLast = i === recentJobs.length - 1;
          return (
            <View key={entry.id} style={[s.jobRow, !isLast && s.jobRowBorder]}>
              <View>
                <Text style={[s.jobTitle, isActive && s.jobTitleMuted]}>
                  {entry.summary || 'Task'}
                </Text>
                <Text style={s.jobTime}>
                  {isActive ? t('today.inProgress') : relativeTime(entry.timestamp)}
                </Text>
              </View>
              {isActive ? (
                <View style={s.workingBadge}>
                  <Text style={s.workingBadgeText}>{t('today.working')}</Text>
                </View>
              ) : (
                <Text style={s.jobAmount}>+{fmt(entry.amount_usd)}</Text>
              )}
            </View>
          );
        })}
      </View>

      {/* Section divider */}
      <View style={s.sectionDivider} />

      {/* Earnings League */}
      {leagueData && (
        <View style={s.section}>
          <View style={s.leagueHeader}>
            <Text style={s.sectionLabel}>{t('today.earningsLeague')}</Text>
            <Text style={s.leagueCountdown}>{seasonCountdown(leagueData.ends_at)}</Text>
          </View>
          {leagueData.leaderboard.slice(0, 5).map((entry) => {
            const isYou =
              leagueData.wallet.rank !== null &&
              leagueData.wallet.rank >= 1 &&
              leagueData.wallet.rank === entry.rank;
            return (
              <View key={entry.rank} style={[s.leagueRow, isYou && s.leagueRowHighlight]}>
                <Text style={s.leagueRank}>#{entry.rank}</Text>
                <Text style={[s.leagueName, isYou && s.leagueNameYou]}>{entry.label}</Text>
                <Text style={s.leagueRate}>{fmtRate(entry.earn_rate_pct)}</Text>
              </View>
            );
          })}
          {leagueData.wallet.rank !== null && leagueData.wallet.rank >= 6 && (
            <View style={[s.leagueRow, s.leagueRowYouAppended]}>
              <View style={{ width: 28 }} />
              <Text style={s.leagueNameYou}>You · #{leagueData.wallet.rank}</Text>
              <Text style={s.leagueRate}>{fmtRate(leagueData.wallet.earn_rate_pct)}</Text>
            </View>
          )}
          <TouchableOpacity style={s.leagueSeeAll} onPress={() => setLeagueModalVisible(true)}>
            <Text style={s.leagueSeeAllText}>→ {t('today.seeAllAgents')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* League bottom-sheet modal */}
      <Modal
        visible={leagueModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setLeagueModalVisible(false)}
      >
        {leagueData && (
          <View style={s.modalRoot}>
            <View style={s.modalHandle} />
            <View style={s.modalHeaderRow}>
              <Text style={s.modalTitle}>EARNINGS LEAGUE · {leagueData.season}</Text>
              <TouchableOpacity onPress={() => setLeagueModalVisible(false)} accessibilityLabel="Close league" accessibilityRole="button">
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={s.modalScroll} contentContainerStyle={s.modalScrollContent}>
              <Text style={s.modalSectionLabel}>{t('today.rewards')}</Text>
              {leagueData.rewards.map((r) => (
                <Text key={r} style={s.modalInfoRow}>{r}</Text>
              ))}
              <Text style={[s.modalSectionLabel, { marginTop: 16 }]}>{t('today.howItWorks')}</Text>
              {leagueData.scoring.map((r) => (
                <Text key={r} style={s.modalInfoRow}>{r}</Text>
              ))}
              <View style={s.sectionDivider} />
              {leagueData.leaderboard.map((entry) => {
                const isYou =
                  leagueData.wallet.rank !== null &&
                  leagueData.wallet.rank >= 1 &&
                  leagueData.wallet.rank === entry.rank;
                return (
                  <View key={entry.rank} style={[s.leagueRow, isYou && s.leagueRowHighlight]}>
                    <Text style={s.leagueRank}>#{entry.rank}</Text>
                    <Text style={[s.leagueName, isYou && s.leagueNameYou]}>{entry.label}</Text>
                    <Text style={s.leagueRate}>{fmtRate(entry.earn_rate_pct)}</Text>
                  </View>
                );
              })}
              {leagueData.wallet.rank !== null && leagueData.wallet.rank >= 1 && (
                <View style={s.modalFooter}>
                  <View style={s.modalStatCol}>
                    <Text style={s.modalStatLabel}>EARN RATE</Text>
                    <Text style={s.modalStatValue}>{fmtRate(leagueData.wallet.earn_rate_pct)}</Text>
                  </View>
                  <View style={s.modalStatCol}>
                    <Text style={s.modalStatLabel}>{t('today.leagueTrades')}</Text>
                    <Text style={s.modalStatValue}>{leagueData.wallet.trade_count}</Text>
                  </View>
                  <View style={s.modalStatCol}>
                    <Text style={s.modalStatLabel}>{t('today.leagueDays')}</Text>
                    <Text style={s.modalStatValue}>{leagueData.wallet.active_days}</Text>
                  </View>
                </View>
              )}
            </ScrollView>
          </View>
        )}
      </Modal>
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
    overflow: 'hidden',
  },
  avatarImage: { width: 38, height: 38 },
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

  // ── Earnings League ──────────────────────────────────────────────────────
  leagueHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  leagueCountdown: { fontSize: 10, color: '#9ca3af' },
  leagueRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  leagueRowHighlight: { backgroundColor: '#f0fdf4', borderRadius: 6, marginHorizontal: -4, paddingHorizontal: 4 },
  leagueRowYouAppended: { borderTopWidth: 1, borderTopColor: '#e5e7eb', borderBottomWidth: 0 },
  leagueRank: { fontSize: 11, color: '#9ca3af', width: 28 },
  leagueName: { flex: 1, fontSize: 12, color: '#111', fontWeight: '500' },
  leagueNameYou: { color: '#22c55e' },
  leagueRate: { fontSize: 12, color: '#22c55e', fontWeight: '600' },
  leagueSeeAll: { paddingVertical: 10 },
  leagueSeeAllText: { fontSize: 11, color: '#6b7280' },
  // ── League modal ─────────────────────────────────────────────────────────
  modalRoot: { flex: 1, backgroundColor: '#fff' },
  modalHandle: { width: 32, height: 4, backgroundColor: '#e5e7eb', borderRadius: 2, alignSelf: 'center', marginTop: 8, marginBottom: 16 },
  modalHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, marginBottom: 12 },
  modalTitle: { fontSize: 11, fontWeight: '700', color: '#111', letterSpacing: 0.5 },
  modalClose: { fontSize: 16, color: '#6b7280', padding: 4 },
  modalScroll: { flex: 1 },
  modalScrollContent: { paddingHorizontal: 16, paddingBottom: 32 },
  modalSectionLabel: { fontSize: 10, color: '#9ca3af', letterSpacing: 0.5, marginBottom: 8 },
  modalInfoRow: { fontSize: 12, color: '#374151', marginBottom: 6 },
  modalFooter: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 16, borderTopWidth: 1, borderTopColor: '#f3f4f6', marginTop: 8 },
  modalStatCol: { alignItems: 'center' as const },
  modalStatLabel: { fontSize: 9, color: '#9ca3af', letterSpacing: 0.3, marginBottom: 4 },
  modalStatValue: { fontSize: 15, fontWeight: '700', color: '#111' },
});
