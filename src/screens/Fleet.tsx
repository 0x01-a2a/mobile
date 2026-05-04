/**
 * Fleet — 01fi agent fleet management + analytics.
 *
 * Sections (top to bottom):
 *   1. Headline   — total deployed, blended APR, earnings strip
 *   2. Legs       — per-strategy cards (Multiply / Hedged JLP / Stable Floor)
 *   3. Agents     — live status of all fleet members
 *   4. Activity   — recent inter-agent PROPOSE/DELIVER messages
 *   5. Briefs     — Researcher Agent's structured intelligence briefs
 *   6. Alerts     — Risk Watcher alerts (only shown when non-empty)
 *
 * Data source: useFleet() hook (currently mock; daemon API contract is fixed
 * in src/hooks/useFleet.ts and will plug in when zerox1-defi-daemon is live).
 */
import React from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme, ThemeColors } from '../theme/ThemeContext';
import {
  useFleet,
  type LegStatus,
  type AgentStatus,
  type ActivityEvent,
  type ResearcherBrief,
  type RiskAlert,
  type AgentStatusKind,
  type AlertSeverity,
} from '../hooks/useFleet';

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function statusColor(status: AgentStatusKind, C: ThemeColors): string {
  switch (status) {
    case 'running': return C.green;
    case 'idle':    return C.sub;
    case 'paused':  return C.amber;
    case 'error':   return C.red;
    case 'offline': return C.dim;
  }
}

function severityColor(sev: AlertSeverity, C: ThemeColors): string {
  switch (sev) {
    case 'info':     return C.blue;
    case 'warning':  return C.amber;
    case 'critical': return C.red;
  }
}

// ── Subcomponents ───────────────────────────────────────────────────────────

function Headline({ deployed, apr, today, week, month, sharpe }: {
  deployed: number; apr: number; today: number; week: number; month: number; sharpe: number | null;
}) {
  const { colors: C } = useTheme();
  const s = useStyles(C);
  return (
    <View style={s.headlineCard}>
      <View style={s.headlineRow}>
        <View style={s.headlineCol}>
          <Text style={s.headlineLabel}>DEPLOYED</Text>
          <Text style={s.headlineValueLarge}>{fmtUsd(deployed)}</Text>
        </View>
        <View style={s.headlineCol}>
          <Text style={s.headlineLabel}>BLENDED APR</Text>
          <Text style={[s.headlineValueLarge, { color: C.green }]}>{apr.toFixed(1)}%</Text>
        </View>
      </View>
      <View style={[s.headlineRow, { marginTop: 14 }]}>
        <View style={s.headlineColSmall}>
          <Text style={s.headlineLabel}>TODAY</Text>
          <Text style={s.headlineValueSmall}>{fmtUsd(today)}</Text>
        </View>
        <View style={s.headlineColSmall}>
          <Text style={s.headlineLabel}>WEEK</Text>
          <Text style={s.headlineValueSmall}>{fmtUsd(week)}</Text>
        </View>
        <View style={s.headlineColSmall}>
          <Text style={s.headlineLabel}>MONTH</Text>
          <Text style={s.headlineValueSmall}>{fmtUsd(month)}</Text>
        </View>
        <View style={s.headlineColSmall}>
          <Text style={s.headlineLabel}>SHARPE 30D</Text>
          <Text style={s.headlineValueSmall}>{sharpe == null ? '—' : sharpe.toFixed(2)}</Text>
        </View>
      </View>
    </View>
  );
}

function LegCard({ leg }: { leg: LegStatus }) {
  const { colors: C } = useTheme();
  const { t } = useTranslation();
  const s = useStyles(C);
  const titleKey = `fleet.leg.${leg.id}` as const;
  const apprColor = leg.current_apr_pct >= 10 ? C.green : leg.current_apr_pct >= 5 ? C.text : C.amber;
  return (
    <View style={s.card}>
      <View style={s.cardHeader}>
        <Text style={s.cardTitle}>{t(titleKey)}</Text>
        {leg.paused ? (
          <Text style={[s.statusPill, { color: C.amber, borderColor: C.amber }]}>PAUSED</Text>
        ) : (
          <Text style={[s.statusPill, { color: C.green, borderColor: C.green }]}>ACTIVE</Text>
        )}
      </View>
      <View style={s.cardBody}>
        <View style={s.cardCol}>
          <Text style={s.cardLabel}>Position</Text>
          <Text style={s.cardValue}>{fmtUsd(leg.position_usd)}</Text>
        </View>
        <View style={s.cardCol}>
          <Text style={s.cardLabel}>Current APR</Text>
          <Text style={[s.cardValue, { color: apprColor }]}>{leg.current_apr_pct.toFixed(1)}%</Text>
        </View>
        <View style={s.cardCol}>
          <Text style={s.cardLabel}>24h P&L</Text>
          <Text style={[s.cardValue, { color: leg.pnl_24h_usd >= 0 ? C.green : C.red }]}>
            {fmtUsd(leg.pnl_24h_usd)}
          </Text>
        </View>
        <View style={s.cardCol}>
          <Text style={s.cardLabel}>Health</Text>
          <Text style={s.cardValue}>{leg.health_factor == null ? '—' : leg.health_factor.toFixed(2)}</Text>
        </View>
      </View>
      <Text style={s.cardSubLine}>Last action: {relTime(leg.last_action_iso)}</Text>
    </View>
  );
}

function AgentRow({ agent }: { agent: AgentStatus }) {
  const { colors: C } = useTheme();
  const { t } = useTranslation();
  const s = useStyles(C);
  const dotColor = statusColor(agent.status, C);
  const roleKey = `fleet.agentRole.${agent.role}` as const;
  return (
    <View style={s.agentRow}>
      <View style={[s.statusDot, { backgroundColor: dotColor }]} />
      <View style={s.agentTextCol}>
        <View style={s.agentRowTop}>
          <Text style={s.agentRole}>{t(roleKey)}</Text>
          <Text style={s.agentMeta}>{relTime(agent.last_message_iso)}</Text>
        </View>
        <Text style={s.agentTask} numberOfLines={1}>
          {agent.current_task ?? t(`fleet.agentStatus.${agent.status}`)}
        </Text>
      </View>
    </View>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const { colors: C } = useTheme();
  const s = useStyles(C);
  const kindColor =
    event.kind === 'PROPOSE' ? C.blue :
    event.kind === 'ACCEPT'  ? C.green :
    event.kind === 'REJECT'  ? C.red :
    event.kind === 'COUNTER' ? C.amber :
                               C.text;
  return (
    <View style={s.activityRow}>
      <View style={s.activityHeaderRow}>
        <Text style={[s.activityKind, { color: kindColor }]}>{event.kind}</Text>
        <Text style={s.activityFlow}>{event.from_role} → {event.to_role ?? '—'}</Text>
        <Text style={s.activityTime}>{relTime(event.ts_iso)}</Text>
      </View>
      <Text style={s.activitySummary} numberOfLines={2}>{event.summary}</Text>
      {event.txid && <Text style={s.activityTxid}>{event.txid}</Text>}
    </View>
  );
}

function BriefRow({ brief }: { brief: ResearcherBrief }) {
  const { colors: C } = useTheme();
  const s = useStyles(C);
  const kindColor =
    brief.kind === 'risk_update'   ? C.amber :
    brief.kind === 'opportunity'   ? C.green :
                                      C.blue;
  return (
    <View style={s.activityRow}>
      <View style={s.activityHeaderRow}>
        <Text style={[s.activityKind, { color: kindColor }]}>
          {brief.kind.replace('_', ' ').toUpperCase()}
        </Text>
        {brief.conviction != null && (
          <Text style={s.briefConviction}>conviction {brief.conviction}/100</Text>
        )}
        <Text style={s.activityTime}>{relTime(brief.ts_iso)}</Text>
      </View>
      <Text style={s.activitySummary} numberOfLines={3}>{brief.headline}</Text>
    </View>
  );
}

function AlertRow({ alert }: { alert: RiskAlert }) {
  const { colors: C } = useTheme();
  const s = useStyles(C);
  const color = severityColor(alert.severity, C);
  return (
    <View style={[s.alertRow, { borderLeftColor: color }]}>
      <View style={s.activityHeaderRow}>
        <Text style={[s.activityKind, { color }]}>{alert.severity.toUpperCase()}</Text>
        <Text style={s.activityFlow}>{alert.source}</Text>
        <Text style={s.activityTime}>{relTime(alert.ts_iso)}</Text>
      </View>
      <Text style={s.activitySummary}>{alert.message}</Text>
    </View>
  );
}

// ── Section helper ──────────────────────────────────────────────────────────

function SectionHeader({ title, action }: { title: string; action?: { label: string; onPress: () => void } }) {
  const { colors: C } = useTheme();
  const s = useStyles(C);
  return (
    <View style={s.sectionHeader}>
      <Text style={s.sectionTitle}>{title}</Text>
      {action && (
        <TouchableOpacity onPress={action.onPress}>
          <Text style={s.sectionAction}>{action.label}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ── Main screen ─────────────────────────────────────────────────────────────

export default function FleetScreen() {
  const { colors: C } = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const s = useStyles(C);
  const { data, refreshing, refresh } = useFleet();

  if (!data.overview.fleet_online) {
    return (
      <View style={[s.container, { paddingTop: insets.top + 24, justifyContent: 'center' }]}>
        <Text style={s.headline}>{t('fleet.headline')}</Text>
        <Text style={[s.cardSubLine, { textAlign: 'center', marginTop: 24 }]}>
          {t('fleet.fleetOffline')}
        </Text>
        <Text style={[s.cardSubLine, { textAlign: 'center', marginTop: 8, paddingHorizontal: 32 }]}>
          {t('fleet.fleetOfflineHint')}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 80 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.sub} />}
    >
      <Text style={s.headline}>{t('fleet.headline')}</Text>

      <Headline
        deployed={data.overview.deployed_usd}
        apr={data.overview.blended_apr_pct}
        today={data.overview.earned_today_usd}
        week={data.overview.earned_week_usd}
        month={data.overview.earned_month_usd}
        sharpe={data.overview.sharpe_30d}
      />

      <SectionHeader title={t('fleet.legs')} />
      {data.legs.map(leg => <LegCard key={leg.id} leg={leg} />)}

      <SectionHeader title={t('fleet.agents')} />
      <View style={s.card}>
        {data.agents.map(a => <AgentRow key={a.agent_id} agent={a} />)}
      </View>

      {data.alerts.length > 0 ? (
        <>
          <SectionHeader title={t('fleet.alerts')} />
          {data.alerts.map(a => <AlertRow key={a.id} alert={a} />)}
        </>
      ) : null}

      <SectionHeader title={t('fleet.activity')} />
      {data.activity.length === 0 ? (
        <Text style={s.empty}>{t('fleet.noActivity')}</Text>
      ) : (
        <View style={s.card}>
          {data.activity.map(e => <ActivityRow key={e.id} event={e} />)}
        </View>
      )}

      <SectionHeader title={t('fleet.briefs')} />
      {data.briefs.length === 0 ? (
        <Text style={s.empty}>{t('fleet.noBriefs')}</Text>
      ) : (
        <View style={s.card}>
          {data.briefs.map(b => <BriefRow key={b.id} brief={b} />)}
        </View>
      )}
    </ScrollView>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

function useStyles(C: ThemeColors) {
  return React.useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: C.bg },
    headline: {
      fontSize: 22, fontWeight: '700', color: C.text,
      paddingHorizontal: 16, marginBottom: 14, letterSpacing: 0.5,
    },
    headlineCard: {
      backgroundColor: C.card, borderColor: C.border, borderWidth: 1,
      borderRadius: 12, paddingVertical: 18, paddingHorizontal: 16,
      marginHorizontal: 16,
    },
    headlineRow: { flexDirection: 'row', justifyContent: 'space-between' },
    headlineCol: { flex: 1 },
    headlineColSmall: { flex: 1, alignItems: 'flex-start' },
    headlineLabel: { fontSize: 10, fontWeight: '700', color: C.sub, letterSpacing: 1, marginBottom: 4 },
    headlineValueLarge: { fontSize: 26, fontWeight: '700', color: C.text },
    headlineValueSmall: { fontSize: 14, fontWeight: '600', color: C.text },

    sectionHeader: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
      paddingHorizontal: 16, marginTop: 24, marginBottom: 8,
    },
    sectionTitle: { fontSize: 11, fontWeight: '700', color: C.sub, letterSpacing: 1 },
    sectionAction: { fontSize: 11, fontWeight: '700', color: C.blue, letterSpacing: 1 },

    card: {
      backgroundColor: C.card, borderColor: C.border, borderWidth: 1,
      borderRadius: 12, marginHorizontal: 16, marginBottom: 10,
      paddingVertical: 12, paddingHorizontal: 14,
    },
    cardHeader: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      marginBottom: 10,
    },
    cardTitle: { fontSize: 14, fontWeight: '700', color: C.text },
    statusPill: {
      fontSize: 9, fontWeight: '700', letterSpacing: 1,
      paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1,
    },
    cardBody: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
    cardCol: { flex: 1 },
    cardLabel: { fontSize: 9, fontWeight: '700', color: C.sub, letterSpacing: 1, marginBottom: 2 },
    cardValue: { fontSize: 14, fontWeight: '600', color: C.text },
    cardSubLine: { fontSize: 11, color: C.dim, marginTop: 4 },

    agentRow: {
      flexDirection: 'row', alignItems: 'center', paddingVertical: 8,
      borderBottomColor: C.border, borderBottomWidth: StyleSheet.hairlineWidth,
    },
    statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 12 },
    agentTextCol: { flex: 1 },
    agentRowTop: { flexDirection: 'row', justifyContent: 'space-between' },
    agentRole: { fontSize: 13, fontWeight: '600', color: C.text },
    agentMeta: { fontSize: 11, color: C.dim },
    agentTask: { fontSize: 12, color: C.sub, marginTop: 1 },

    activityRow: {
      paddingVertical: 8,
      borderBottomColor: C.border, borderBottomWidth: StyleSheet.hairlineWidth,
    },
    activityHeaderRow: {
      flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 10,
    },
    activityKind: { fontSize: 10, fontWeight: '700', letterSpacing: 1 },
    activityFlow: { fontSize: 11, color: C.sub, flex: 1 },
    activityTime: { fontSize: 11, color: C.dim },
    activitySummary: { fontSize: 13, color: C.text, lineHeight: 18 },
    activityTxid: { fontSize: 10, color: C.blue, marginTop: 2, fontFamily: 'Menlo' },
    briefConviction: { fontSize: 11, color: C.sub },

    alertRow: {
      backgroundColor: C.card, marginHorizontal: 16, marginBottom: 8,
      paddingVertical: 10, paddingHorizontal: 12,
      borderLeftWidth: 3, borderRadius: 6,
    },

    empty: { fontSize: 12, color: C.dim, textAlign: 'center', paddingVertical: 24 },
  }), [C]);
}
