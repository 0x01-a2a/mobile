import React, { useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, Image,
  ActivityIndicator, Platform, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { useNode } from '../hooks/useNode';
import { useTaskLog } from '../hooks/useNodeApi';
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


export default function TodayScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { t } = useTranslation();
  const { contentMaxWidth } = useLayout();
  const { status, config } = useNode();
  const { muted, toggle: toggleMute } = useAudioMute();
  const { colors } = useTheme();
  const s = makeStyles(colors);
  const { entries, loading, reload: reloadTasks } = useTaskLog();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    await reloadTasks();
    setRefreshing(false);
  }, [reloadTasks]);

  const agentName = config?.agentName || 'my-agent';
  const isRunning = status === 'running';
  const earnedToday = useMemo(() => sumEarnings(entries, true), [entries]);
  const earnedAllTime = useMemo(() => sumEarnings(entries, false), [entries]);


  const centerStyle = contentMaxWidth
    ? { maxWidth: contentMaxWidth, alignSelf: 'center' as const, width: '100%' as const }
    : undefined;

  return (
    <ScrollView
      style={s.root}
      contentContainerStyle={s.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.green}
          colors={[colors.green]}
        />
      }
    >
      <View style={centerStyle}>
      {/* Top bar */}
      <View style={[s.topBar, { paddingTop: insets.top + 12 }]}>
        <Text style={s.pilotLabel}>01 PILOT</Text>
        <View style={s.topBarRight}>
          {Platform.OS === 'ios' && isRunning && (
            <TouchableOpacity
              onPress={toggleMute}
              style={[s.muteBtn, muted && s.muteBtnMuted]}
              accessibilityLabel={muted ? 'Unmute audio' : 'Mute audio'}
              accessibilityRole="button"
            >
              <Text style={[s.muteLabel, muted && s.muteLabelMuted]}>
                {muted ? 'MUTED' : 'AUDIO'}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => navigation.navigate('You')} accessibilityLabel="Profile and settings" accessibilityRole="button" hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
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
          accessibilityLabel={t('today.brief')}
          accessibilityRole="button"
        >
          <Text style={s.actionText}>✦ {t('today.brief')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={s.actionBtn}
          onPress={() => navigation.navigate('Chat', { initialMode: 'chat' })}
          accessibilityLabel="Record podcast"
          accessibilityRole="button"
        >
          <Text style={s.actionText}>🎙 Podcast</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.actionBtn, s.actionBtnPrimary]}
          onPress={() => navigation.navigate('Chat', { initialMode: 'chat' })}
          accessibilityLabel={t('today.send')}
          accessibilityRole="button"
        >
          <Text style={[s.actionText, s.actionTextPrimary]}>→ {t('today.send')}</Text>
        </TouchableOpacity>
      </View>

      {/* Section divider */}
      <View style={s.sectionDivider} />

      {/* Agent Marketplace — coming soon */}
      <View style={[s.section, { opacity: 0.4 }]}>
        <Text style={s.sectionLabel}>AGENT MARKETPLACE</Text>
        <View style={s.emptyContainer}>
          <Text style={[s.emptyPrimary, { fontSize: 14 }]}>Coming Soon</Text>
          <Text style={s.emptySecondary}>
            Hire other agents and get hired for tasks on the 0x01 mesh.
            Build your reputation through podcasts first.
          </Text>
        </View>
      </View>

      </View>
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
  });
}
