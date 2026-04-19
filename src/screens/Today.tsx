import React, { useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Image, Modal,
  ActivityIndicator, Alert, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { useNode } from '../hooks/useNode';
import { useTaskLog, useSkrLeague } from '../hooks/useNodeApi';
import { DEFAULT_AGENT_ICON_URI } from '../assets/defaultAgentIcon';
import { useLayout } from '../hooks/useLayout';
import { useAudioMute } from '../hooks/useAudioMute.tsx';
import { useTheme, ThemeColors } from '../theme/ThemeContext';

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

function seasonCountdown(endsAt: number, t: (key: string, opts?: any) => string): string {
  const days = Math.ceil((endsAt * 1000 - Date.now()) / 86_400_000);
  if (days >= 2) return t('today.seasonEndsIn', { count: days });
  if (days === 1) return t('today.seasonEndsTomorrow');
  if (days === 0) return t('today.seasonEndsToday');
  return t('today.seasonEnded');
}

export default function TodayScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { t } = useTranslation();
  const { contentMaxWidth } = useLayout();
  const { status, config } = useNode();
  const { muted, toggle: toggleMute } = useAudioMute();
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const { entries, loading } = useTaskLog();
  const { data: leagueData } = useSkrLeague();
  const [leagueModalVisible, setLeagueModalVisible] = useState(false);
  const [leaguePeriod, setLeaguePeriod] = useState<'week' | 'month' | 'all'>('week');

  const agentName = config?.agentName || 'my-agent';
  const isRunning = status === 'running';
  const earnedToday = useMemo(() => sumEarnings(entries, true), [entries]);
  const earnedAllTime = useMemo(() => sumEarnings(entries, false), [entries]);

  const periodEarnings = useMemo(() => {
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const monthMs = 30 * 24 * 60 * 60 * 1000;
    const filter = (cutoff: number) =>
      entries.filter(e => e.outcome === 'success' && e.timestamp * 1000 >= cutoff)
             .reduce((acc, e) => acc + (e.amount_usd ?? 0), 0);
    return {
      week: filter(now - weekMs),
      month: filter(now - monthMs),
      all: earnedAllTime,
    };
  }, [entries, earnedAllTime]);
  const recentJobs = useMemo(
    () => entries.filter(e => e.outcome === 'success').slice(0, 10),
    [entries],
  );

  const centerStyle = contentMaxWidth
    ? { maxWidth: contentMaxWidth, alignSelf: 'center' as const, width: '100%' as const }
    : undefined;

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      <View style={centerStyle}>
      {/* Top bar */}
      <View style={[s.topBar, { paddingTop: insets.top + 12 }]}>
        <Text style={s.pilotLabel}>01 PILOT</Text>
        <View style={s.topBarRight}>
          {Platform.OS === 'ios' && isRunning && (
            <TouchableOpacity
              onPress={toggleMute}
              style={[s.muteBtn, muted && s.muteBtnMuted]}
            >
              <Text style={[s.muteLabel, muted && s.muteLabelMuted]}>
                {muted ? 'MUTED' : 'AUDIO'}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => navigation.navigate('You')}>
            <Text style={s.settingsIcon}>◎</Text>
          </TouchableOpacity>
        </View>
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
              {isRunning ? t('today.statusWorking') : t('today.statusIdle')}
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
        {earnedToday === 0 && earnedAllTime === 0 && !loading && (
          <Text style={s.earningsHint}>{t('today.noEarningsYet')}</Text>
        )}
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
          <Text style={s.actionText}>◈ {t('nav.inbox')}</Text>
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
        {loading && (
          <View style={s.loadingContainer}>
            <ActivityIndicator size="small" color={colors.green} />
          </View>
        )}
        {!loading && recentJobs.length === 0 && (
          <View style={s.emptyContainer}>
            <Text style={s.emptyPrimary}>{t('today.noJobsYet')}</Text>
            <Text style={s.emptySecondary}>{t('today.acceptBountiesHint')}</Text>
            <TouchableOpacity style={s.emptyAction} onPress={() => navigation.navigate('Inbox')}>
              <Text style={s.emptyActionText}>{t('today.browseInbox')}</Text>
            </TouchableOpacity>
          </View>
        )}
        {recentJobs.map((entry, i) => {
          // Note: recentJobs is pre-filtered to outcome === 'success', so isActive
          // will always be false here. The badge is preserved for forward-compat if
          // the filter is relaxed, but it never shows in the current data set.
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
            <Text style={s.leagueCountdown}>{seasonCountdown(leagueData.ends_at, t)}</Text>
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
                <Text style={[s.leagueRate, { color: entry.earn_rate_pct < 0 ? colors.red : colors.green }]}>{fmtRate(entry.earn_rate_pct)}</Text>
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

      </View>

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

              {/* Period filter pills — control your earnings view */}
              <View style={s.periodFilterRow}>
                {(['week', 'month', 'all'] as const).map((period) => {
                  const labels: Record<typeof period, string> = {
                    week: 'This Week',
                    month: 'This Month',
                    all: 'All Time',
                  };
                  const selected = leaguePeriod === period;
                  return (
                    <TouchableOpacity
                      key={period}
                      style={[s.periodPill, selected && s.periodPillSelected]}
                      onPress={() => setLeaguePeriod(period)}
                    >
                      <Text style={[s.periodPillText, selected && s.periodPillTextSelected]}>
                        {labels[period]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Your earnings for selected period */}
              <View style={s.periodEarningsRow}>
                <Text style={s.periodEarningsLabel}>YOUR EARNINGS</Text>
                <Text style={s.periodEarningsValue}>{fmt(periodEarnings[leaguePeriod])}</Text>
              </View>

              <Text style={[s.modalSectionLabel, { marginTop: 12 }]}>WEEKLY LEADERBOARD</Text>
              {leagueData.leaderboard.slice(0, 10).map((entry) => {
                const isYou =
                  leagueData.wallet.rank !== null &&
                  leagueData.wallet.rank >= 1 &&
                  leagueData.wallet.rank === entry.rank;
                return (
                  <View key={entry.rank} style={[s.leagueRow, isYou && s.leagueRowHighlight]}>
                    <Text style={s.leagueRank}>#{entry.rank}</Text>
                    <Text style={[s.leagueName, isYou && s.leagueNameYou]}>{entry.label}</Text>
                    <Text style={[s.leagueRate, { color: entry.earn_rate_pct < 0 ? colors.red : colors.green }]}>{fmtRate(entry.earn_rate_pct)}</Text>
                  </View>
                );
              })}
              {leagueData.wallet.rank !== null && leagueData.wallet.rank >= 1 && (
                <View style={s.modalFooter}>
                  <TouchableOpacity
                    style={s.modalStatCol}
                    onPress={() =>
                      Alert.alert(
                        'Token Rate',
                        'Weekly % change in your agent token\'s price on Bags.fm. This is token performance, not job income.',
                      )
                    }
                  >
                    <Text style={s.modalStatLabel}>TOKEN RATE <Text style={s.modalStatHint}>(?)</Text></Text>
                    <Text style={[s.modalStatValue, { color: leagueData.wallet.earn_rate_pct < 0 ? colors.red : colors.green }]}>{fmtRate(leagueData.wallet.earn_rate_pct)}</Text>
                  </TouchableOpacity>
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
              <Text style={s.modalFootnote}>Token price performance · updates daily</Text>
            </ScrollView>
          </View>
        )}
      </Modal>
    </ScrollView>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    content: { paddingBottom: 24 },
    topBar: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      paddingHorizontal: 16, paddingBottom: 4,
    },
    pilotLabel: { fontSize: 13, color: colors.sub, fontWeight: '700', letterSpacing: 1.5 },
    topBarRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    muteBtn: {
      paddingHorizontal: 8, paddingVertical: 3,
      borderRadius: 4, borderWidth: 1, borderColor: colors.green,
    },
    muteBtnMuted: { borderColor: colors.border },
    muteLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, color: colors.green },
    muteLabelMuted: { color: colors.sub },
    settingsIcon: { fontSize: 20, color: colors.text },

    heroCard: {
      margin: 16, marginTop: 12,
      backgroundColor: colors.card,
      borderRadius: 14,
      borderWidth: 1, borderColor: colors.border,
      borderLeftWidth: 3, borderLeftColor: colors.green,
      padding: 14,
    },
    heroRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    avatarCircle: {
      width: 40, height: 40, borderRadius: 20,
      backgroundColor: colors.bg, borderWidth: 2, borderColor: colors.green,
      overflow: 'hidden',
    },
    avatarImage: { width: 40, height: 40 },
    heroInfo: { flex: 1 },
    agentName: { fontSize: 14, fontWeight: '600', color: colors.text },
    agentStatus: { fontSize: 11, color: colors.green, marginTop: 2 },
    heroDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 12 },
    earningsRow: { flexDirection: 'row', justifyContent: 'space-between' },
    earningsRight: { alignItems: 'flex-end' },
    earningsLabel: { fontSize: 11, color: colors.sub, letterSpacing: 0.3, marginBottom: 2 },
    earningsAmount: { fontSize: 20, fontWeight: '700', color: colors.text, letterSpacing: -0.5 },
    earningsAmountMuted: { color: colors.sub },
    earningsHint: { fontSize: 11, color: colors.dim, marginTop: 6, fontStyle: 'italic' },

    actionsRow: {
      flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 4,
    },
    actionBtn: {
      flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 10,
      paddingVertical: 11, alignItems: 'center',
    },
    actionBtnPrimary: { flex: 2, backgroundColor: colors.text, borderColor: colors.text },
    actionText: { fontSize: 12, color: colors.sub, fontWeight: '600' },
    actionTextPrimary: { color: colors.bg, fontSize: 12, fontWeight: '700' },

    sectionDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginHorizontal: 16, marginTop: 16 },

    section: { paddingHorizontal: 16, paddingTop: 14 },
    sectionLabel: {
      fontSize: 11, color: colors.dim, letterSpacing: 0.5, marginBottom: 10,
    },
    emptyText: { fontSize: 14, color: colors.dim, textAlign: 'center', paddingVertical: 24 },

    loadingContainer: { alignItems: 'center', paddingVertical: 24 },

    emptyContainer: { alignItems: 'center', paddingVertical: 24 },
    emptyPrimary: { fontSize: 13, color: colors.text, textAlign: 'center', marginBottom: 4 },
    emptySecondary: { fontSize: 12, color: colors.sub, textAlign: 'center', marginBottom: 12 },
    emptyAction: {
      borderWidth: 1, borderColor: colors.border, borderRadius: 8,
      paddingHorizontal: 14, paddingVertical: 8,
    },
    emptyActionText: { fontSize: 12, color: colors.text, fontWeight: '600' },

    jobRow: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      paddingVertical: 10,
    },
    jobRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    jobTitle: { fontSize: 13, color: colors.text, fontWeight: '500' },
    jobTitleMuted: { color: colors.dim },
    jobTime: { fontSize: 11, color: colors.sub, marginTop: 2 },
    jobAmount: { fontSize: 13, color: colors.green, fontWeight: '600' },
    workingBadge: {
      borderWidth: 1, borderColor: colors.border, borderRadius: 4,
      paddingHorizontal: 6, paddingVertical: 2, backgroundColor: colors.card,
    },
    workingBadgeText: { fontSize: 11, color: colors.sub },

    // ── Earnings League ──────────────────────────────────────────────────────
    leagueHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
    leagueCountdown: { fontSize: 11, color: colors.sub },
    leagueRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    leagueRowHighlight: { backgroundColor: colors.card, borderRadius: 6, marginHorizontal: -4, paddingHorizontal: 4 },
    leagueRowYouAppended: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, borderBottomWidth: 0 },
    leagueRank: { fontSize: 12, color: colors.sub, width: 28 },
    leagueName: { flex: 1, fontSize: 13, color: colors.text, fontWeight: '500' },
    leagueNameYou: { color: colors.green },
    leagueRate: { fontSize: 13, fontWeight: '600' },
    leagueSeeAll: { paddingVertical: 10 },
    leagueSeeAllText: { fontSize: 12, color: colors.sub },
    // ── League modal ─────────────────────────────────────────────────────────
    modalRoot: { flex: 1, backgroundColor: colors.bg },
    modalHandle: { width: 32, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginTop: 8, marginBottom: 16 },
    modalHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, marginBottom: 12 },
    modalTitle: { fontSize: 12, fontWeight: '700', color: colors.text, letterSpacing: 0.5 },
    modalClose: { fontSize: 16, color: colors.sub, padding: 4 },
    modalScroll: { flex: 1 },
    modalScrollContent: { paddingHorizontal: 16, paddingBottom: 32 },
    modalSectionLabel: { fontSize: 11, color: colors.sub, letterSpacing: 0.5, marginBottom: 8 },
    modalInfoRow: { fontSize: 13, color: colors.text, marginBottom: 6 },
    modalFooter: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, marginTop: 8 },
    modalStatCol: { alignItems: 'center' as const },
    modalStatLabel: { fontSize: 11, color: colors.sub, letterSpacing: 0.3, marginBottom: 4 },
    modalStatValue: { fontSize: 16, fontWeight: '700', color: colors.text },
    modalStatHint: { fontSize: 10, color: colors.dim },
    modalFootnote: { fontSize: 11, color: colors.dim, textAlign: 'center', marginTop: 8 },
    // ── Period filter pills ───────────────────────────────────────────────────
    periodFilterRow: { flexDirection: 'row', gap: 8, marginBottom: 8, marginTop: 4 },
    periodEarningsRow: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      backgroundColor: colors.card, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border, padding: 10, marginBottom: 12,
    },
    periodEarningsLabel: { fontSize: 11, color: colors.sub, fontWeight: '600', letterSpacing: 0.3 },
    periodEarningsValue: { fontSize: 16, fontWeight: '700', color: colors.green },
    periodPill: {
      borderWidth: 1, borderColor: colors.border, borderRadius: 20,
      paddingHorizontal: 12, paddingVertical: 5,
    },
    periodPillSelected: { backgroundColor: colors.text, borderColor: colors.text },
    periodPillText: { fontSize: 12, color: colors.sub, fontWeight: '500' },
    periodPillTextSelected: { color: colors.bg },
  });
}
