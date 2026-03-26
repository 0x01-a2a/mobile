/**
 * My — agent management hub.
 *
 * Two subtabs:
 *   Agents — all owned agents with status, reputation, location badge.
 *   Node   — local node controls, hosted banner, reputation detail, inbox.
 */
import { useTheme, ThemeColors } from '../theme/ThemeContext';
import React, { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNode } from '../hooks/useNode';
import {
  BridgeLogEntry,
  InboundEnvelope,
  NegotiationThread,
  PortfolioEvent,
  Skill,
  TaskLogEntry,
  TokenBalance,
  clearTokenFromKeychain,
  deleteTaskEntry,
  groupNegotiations,
  markTaskShared,
  probeRtt,
  skillInstallUrl,
  skillRemove,
  sweepUsdc,
  useBridgeActivityLog,
  useHotKeyBalance,
  useIdentity,
  useInbox,
  useOwnReputation,
  usePhantomBalance,
  useDexPrices,
  usePortfolioHistory,
  useSkills,
  useSolPrice,
  useTaskLog,
  PendingSwap,
  usePendingSwaps,
} from '../hooks/useNodeApi';
import { useOwnedAgents, notifyLinkedAgentsUpdated, OwnedAgent } from '../hooks/useOwnedAgents';
import { useAgentBrain, CAPABILITY_LABELS } from '../hooks/useAgentBrain';
import { useBridgeCapabilities, CAPABILITY_KEYS, use8004Badge } from '../hooks/useNodeApi';
import { NodeStatusBanner } from '../components/NodeStatusBanner';
import { useLayout } from '../hooks/useLayout';

const BRIDGE_LABELS: Record<string, string> = {
  notifications_read: 'NOTIF', notifications_reply: 'NOTIF-RPL', notifications_dismiss: 'NOTIF-DIS',
  sms_read: 'SMS', sms_send: 'SMS-SND',
  contacts: 'CONTACTS', location: 'GPS', calendar: 'CAL', media: 'MEDIA', motion: 'MOTION',
  camera: 'CAM', microphone: 'MIC', calls: 'CALLS', health: 'HEALTH', wearables: 'WEAR',
  screen_read_tree: 'SCR-READ', screen_capture: 'SCR-CAP', screen_act: 'SCR-ACT',
  screen_global_nav: 'SCR-NAV', screen_vision: 'SCR-VIS', screen_autonomy: 'SCR-AUTO',
};



// ── Error boundary ────────────────────────────────────────────────────────

interface ErrorBoundaryState { hasError: boolean; message: string }

class ErrorBoundary extends Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, message: error?.message ?? 'Unknown error' };
  }
  render() {
    if (this.state.hasError) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 }}>
          <Text style={{ color: '#ff1744', fontFamily: 'monospace', fontSize: 11, textAlign: 'center' }}>
            {'Something went wrong.\n'}{this.state.message}
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

type Subtab = 'agents' | 'node' | 'portfolio' | 'skills';

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

function trendColor(trend: string, colors: ThemeColors) {
  if (trend === 'rising') return colors.green;
  if (trend === 'falling') return colors.red;
  return colors.sub;
}

function trendArrow(trend: string) {
  if (trend === 'rising') return '↑';
  if (trend === 'falling') return '↓';
  return '—';
}

// ── Signal bars ───────────────────────────────────────────────────────────

function signalLevel(rtt: number | null): number {
  if (rtt === null) return 0;
  if (rtt <= 50) return 5;
  if (rtt <= 100) return 4;
  if (rtt <= 200) return 3;
  if (rtt <= 500) return 2;
  return 1;
}

function SignalBars({ rtt }: { rtt: number | null }) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  const level = signalLevel(rtt);
  if (rtt === null) return <Text style={s.signalNull}>—</Text>;
  return (
    <View style={s.barsRow}>
      {[1, 2, 3, 4, 5].map(i => (
        <View
          key={i}
          style={[s.bar, { height: 4 + i * 3, backgroundColor: i <= level ? colors.green : colors.border }]}
        />
      ))}
    </View>
  );
}

// ── Agents subtab ─────────────────────────────────────────────────────────

interface AgentCardProps {
  agent: OwnedAgent;
  brainSkills: string[];
  bridgeCaps: Record<string, boolean>;
  bridgeLoading: boolean;
}

function AgentCard({ agent, brainSkills, bridgeCaps, bridgeLoading }: AgentCardProps) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  const rep = useOwnReputation(agent.id || null, 60_000);
  // For local/hosted agents: read from AsyncStorage (set during onboarding registration).
  // For linked agents: query 8004 by their agent ID.
  const [ownRegistered, setOwnRegistered] = useState(false);
  useEffect(() => {
    if (agent.mode !== 'linked') {
      AsyncStorage.getItem('zerox1:8004_registered').then(v => setOwnRegistered(v === 'true'));
    }
  }, [agent.mode]);
  const linkedRegistered = use8004Badge(agent.mode === 'linked' ? (agent.id ?? null) : null);
  const verified = agent.mode === 'linked' ? linkedRegistered : ownRegistered;
  const dotColor = agent.status === 'running' ? colors.green : colors.sub;
  const badgeStyle = agent.mode === 'local' ? s.badgeLocal : agent.mode === 'hosted' ? s.badgeHosted : s.badgeLinked;
  const badgeColor = agent.mode === 'local' ? colors.green : agent.mode === 'hosted' ? colors.amber : colors.blue;
  const badgeLabel = agent.mode === 'local' ? 'PHONE' : agent.mode === 'hosted' ? 'HOSTED' : 'LINKED';

  // Collect active capabilities as skill badges.
  const skills: string[] = [];
  if (agent.mode === 'local') {
    for (const sk of brainSkills) skills.push(sk);
  }
  // Add active bridge capabilities for local agents.
  if (agent.mode === 'local' && !bridgeLoading) {
    for (const key of CAPABILITY_KEYS) {
      if (bridgeCaps[key]) skills.push(BRIDGE_LABELS[key] ?? key.toUpperCase());
    }
  }
  // Always show TRADE for local/hosted agents (Jupiter is always available).
  if (agent.mode !== 'linked') skills.push('TRADE');

  return (
    <View style={s.agentCard}>
      <View style={s.agentCardRow}>
        <View style={[s.dot, { backgroundColor: dotColor }]} />
        <View style={s.agentCardInfo}>
          <View style={s.agentNameRow}>
            <Text style={s.agentCardName}>{agent.name}</Text>
            {verified && (
              <View style={s.verifiedBadge}>
                <Text style={s.verifiedText}>[8004]</Text>
              </View>
            )}
          </View>
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
          <Text style={[s.agentScore, { color: rep.total_score >= 0 ? colors.green : colors.red }]}>
            {rep.total_score > 0 ? '+' : ''}{rep.total_score}
          </Text>
          <Text style={s.agentScoreLabel}> REP</Text>
          <Text style={s.agentDot}> · </Text>
          <Text style={[s.agentTrend, { color: trendColor(rep.trend, colors) }]}>
            {trendArrow(rep.trend)} {rep.trend}
          </Text>
        </View>
      )}
      {skills.length > 0 && (
        <View style={s.skillBadgeRow}>
          {skills.map(sk => (
            <View key={sk} style={s.skillBadge}>
              <Text style={s.skillBadgeText}>{sk}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// ── Link Agent section ────────────────────────────────────────────────────

const AGGREGATOR_API_URL = 'https://api.0x01.world';

type LinkPreview = { agentId: string; ownerWallet: string; ownerStatus: 'claimed' | 'pending' };
type WalletAgent = { agent_id: string; name?: string };

function LinkAgentSection() {
  const { colors } = useTheme();
  const s = useStyles(colors);
  const [expanded, setExpanded] = useState(false);
  const [inputId, setInputId] = useState('');
  const [fetching, setFetching] = useState(false);
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [walletAgents, setWalletAgents] = useState<WalletAgent[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [resolvedWallet, setResolvedWallet] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resetState = useCallback(() => {
    setError(null);
    setPreview(null);
    setWalletAgents([]);
    setSelectedIdx(null);
    setResolvedWallet(null);
  }, []);

  const handleLookup = useCallback(async () => {
    const trimmed = inputId.trim();
    if (!trimmed) return;
    setFetching(true);
    resetState();

    try {
      let agentId: string | null = null;
      let ownerWallet: string | null = null;

      if (trimmed.toLowerCase().endsWith('.sol')) {
        // Resolve .sol domain via Bonfida SNS proxy.
        const domain = trimmed.slice(0, -4);
        const snsRes = await fetch(
          `https://sns-sdk-proxy.bonfida.workers.dev/resolve/${domain}`,
        );
        const sns = await snsRes.json();
        if (sns.s !== 'ok') {
          setError('Could not resolve .sol domain');
          return;
        }
        ownerWallet = sns.result as string;
      } else if (
        /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed) &&
        !/^[0-9a-f]{64}$/i.test(trimmed)
      ) {
        // Looks like a Solana base58 wallet address.
        ownerWallet = trimmed;
      } else {
        // Treat as raw hex agent_id (existing flow).
        agentId = trimmed;
      }

      if (ownerWallet) {
        setResolvedWallet(ownerWallet);
        const res = await fetch(
          `${AGGREGATOR_API_URL}/agents/by-owner/${ownerWallet}`,
        );
        if (!res.ok) {
          setError(`lookup failed (${res.status})`);
          return;
        }
        const agents: WalletAgent[] = await res.json();
        if (agents.length === 0) {
          setError('No agents found for this wallet');
        } else if (agents.length === 1) {
          // Auto-select the single result.
          setPreview({
            agentId: agents[0].agent_id,
            ownerWallet,
            ownerStatus: 'claimed',
          });
        } else {
          setWalletAgents(agents);
          setSelectedIdx(0);
        }
      } else if (agentId) {
        // Existing hex agent_id lookup.
        const res = await fetch(`${AGGREGATOR_API_URL}/agents/${agentId}/owner`);
        if (!res.ok) { setError(`lookup failed (${res.status})`); return; }
        const data = await res.json();
        if (data.status === 'claimed') {
          setPreview({ agentId, ownerWallet: data.owner, ownerStatus: 'claimed' });
        } else if (data.status === 'pending') {
          setPreview({ agentId, ownerWallet: data.proposed_owner, ownerStatus: 'pending' });
        } else {
          setError('no owner claimed for this agent id');
        }
      }
    } catch {
      setError('network error');
    } finally {
      setFetching(false);
    }
  }, [inputId, resetState]);

  // Called when the user confirms a multi-agent picker selection.
  const handlePickerConfirm = useCallback(() => {
    if (selectedIdx === null || walletAgents.length === 0 || !resolvedWallet) return;
    const picked = walletAgents[selectedIdx];
    setPreview({
      agentId: picked.agent_id,
      ownerWallet: resolvedWallet,
      ownerStatus: 'claimed',
    });
    setWalletAgents([]);
  }, [selectedIdx, walletAgents, resolvedWallet]);

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
        id: preview.agentId,
        name: `linked:${preview.agentId.slice(0, 8)}`,
        mode: 'linked',
        status: 'unknown',
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
    resetState();
  }, [resetState]);

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
        <Text style={s.linkHint}>
          enter agent id (hex), Solana wallet address, or .sol domain
        </Text>
        <View style={s.linkInputRow}>
          <TextInput
            style={s.linkInput}
            value={inputId}
            onChangeText={text => { setInputId(text); resetState(); }}
            placeholder="agent id / wallet / name.sol"
            placeholderTextColor={colors.sub}
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

        {/* Multi-agent picker (wallet owns multiple agents) */}
        {walletAgents.length > 1 && (
          <View style={s.pickerBox}>
            <Text style={s.pickerHint}>select your agent:</Text>
            {walletAgents.map((a, i) => (
              <TouchableOpacity
                key={a.agent_id}
                style={[s.pickerRow, selectedIdx === i && s.pickerRowSelected]}
                onPress={() => setSelectedIdx(i)}
                activeOpacity={0.7}
              >
                <View style={[s.pickerRadio, selectedIdx === i && s.pickerRadioSelected]} />
                <View style={{ flex: 1 }}>
                  {a.name ? <Text style={s.pickerName}>{a.name}</Text> : null}
                  <Text style={s.pickerAgentId}>{shortId(a.agent_id)}</Text>
                </View>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={s.confirmBtn}
              onPress={handlePickerConfirm}
              activeOpacity={0.8}
            >
              <Text style={s.confirmBtnText}>SELECT THIS AGENT</Text>
            </TouchableOpacity>
          </View>
        )}

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
  const { colors } = useTheme();
  const { isTablet } = useLayout();
  const s = useStyles(colors);
  const agents = useOwnedAgents();
  const [refreshing, setRefreshing] = useState(false);
  const { config: brainConfig } = useAgentBrain();
  const bridge = useBridgeCapabilities();

  // Pre-compute brain skill labels once (shared across all cards).
  const brainSkills = useMemo(() => {
    if (!brainConfig.enabled) return [] as string[];
    return brainConfig.capabilities.map(cap => CAPABILITY_LABELS[cap] ?? cap);
  }, [brainConfig.enabled, brainConfig.capabilities]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    notifyLinkedAgentsUpdated();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 800));
    setRefreshing(false);
  }, []);

  return (
    <ScrollView
      style={s.subtabRoot}
      contentContainerStyle={s.subtabContent}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#00e676" colors={['#00e676']} />
      }
    >
      <Text style={s.sectionLabel}>YOUR AGENTS</Text>
      <View style={isTablet ? { flexDirection: 'row', flexWrap: 'wrap', gap: 8 } : undefined}>
      {agents.map(a => (
        <View key={a.id || a.mode} style={isTablet ? { width: '48%' } : undefined}>
        <AgentCard
          agent={a}
          brainSkills={brainSkills}
          bridgeCaps={bridge.caps}
          bridgeLoading={bridge.loading}
        />
        </View>
      ))}
      </View>
      <LinkAgentSection />
      <Text style={s.hint}>
        Each agent runs on a node — your phone or a hosted server.
        Agents earn reputation and USDC by completing tasks on the mesh.
        {brainSkills.length > 0 ? ' More skills = more competitive for bounties.' : ''}
      </Text>
    </ScrollView>
  );
}

// ── Node subtab (existing MyAgent content) ────────────────────────────────

function HostedHeader({
  hostUrl,
  onDisconnect,
}: {
  hostUrl: string;
  onDisconnect: () => void;
}) {
  const { colors } = useTheme();
  const s = useStyles(colors);
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
    try { return new URL(hostUrl).host; }
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
  const { colors } = useTheme();
  const { isTablet, isWide } = useLayout();
  const s = useStyles(colors, isTablet, isWide);
  return (
    <View style={s.statCard}>
      <Text style={[s.statVal, color ? { color } : undefined]}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}
function NodeSubtab() {
  const { colors } = useTheme();
  const s = useStyles(colors);
  const { status, loading, start, stop, config, saveConfig } = useNode();
  const identity = useIdentity();
  const rep = useOwnReputation(identity?.agent_id ?? null);
  const { swaps: pendingSwaps, confirm: confirmSwap, reject: rejectSwap } = usePendingSwaps();
  const bridgeLog = useBridgeActivityLog(30);
  const [inbox, setInbox] = useState<InboundEnvelope[]>([]);
  const [hostedAgentId, setHostedAgentId] = useState<string | null>(null);

  const isHosted = Boolean(config.nodeApiUrl);

  useEffect(() => {
    if (!isHosted) { setHostedAgentId(null); return; }
    AsyncStorage.getItem('zerox1:hosted_agent_id')
      .then(id => setHostedAgentId(id))
      .catch(() => { });
  }, [isHosted]);

  const onEnvelope = useCallback((env: InboundEnvelope) => {
    setInbox(prev => {
      const next = [env, ...prev];
      return next.length > 20 ? next.slice(0, 20) : next;
    });
  }, []);

  useInbox(onEnvelope, status === 'running');

  const negotiations = groupNegotiations(inbox);

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

  const [nodeRefreshing, setNodeRefreshing] = useState(false);
  const onNodeRefresh = useCallback(async () => {
    setNodeRefreshing(true);
    await new Promise<void>(resolve => setTimeout(() => resolve(), 800));
    setNodeRefreshing(false);
  }, []);

  const [taskTick, setTaskTick] = useState(0);
  const { entries: taskEntries, loading: taskLoading } = useTaskLog(taskTick);
  const [shareEntry, setShareEntry] = useState<TaskLogEntry | null>(null);

  const running = status === 'running';
  const isError = status === 'error';
  const dotColor = running ? colors.green : isError ? colors.amber : colors.red;
  const scoreColor = rep && rep.total_score >= 0 ? colors.green : colors.red;
  const displayId = isHosted ? hostedAgentId : identity?.agent_id ?? null;
  const displayName = isHosted
    ? (hostedAgentId ? `hosted:${hostedAgentId.slice(0, 8)}` : 'hosted agent')
    : (identity?.name || config?.agentName || 'unnamed agent');

  if (loading) {
    return (
      <View style={[s.subtabRoot, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={colors.green} size="large" />
      </View>
    );
  }

  return (
    <ScrollView
      style={s.subtabRoot}
      contentContainerStyle={s.subtabContent}
      refreshControl={
        <RefreshControl refreshing={nodeRefreshing} onRefresh={onNodeRefresh} tintColor="#00e676" colors={['#00e676']} />
      }
    >
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
            style={[s.btn, { backgroundColor: running ? colors.red : colors.green }]}
            onPress={running ? stop : () => start()}
            activeOpacity={0.8}
          >
            <Text style={[s.btnText, { color: running ? colors.text : '#000' }]}>
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
              <StatCard label="SCORE" value={(rep.total_score > 0 ? '+' : '') + rep.total_score} color={scoreColor} />
              <StatCard label="VERDICTS" value={rep.verdict_count} />
              <StatCard label="POSITIVE" value={rep.positive_count} color={colors.green} />
              <StatCard label="NEGATIVE" value={rep.negative_count} color={colors.red} />
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12 }}>
              <Text style={[{ fontSize: 18, fontWeight: '700' }, { color: trendColor(rep.trend, colors) }]}>
                {trendArrow(rep.trend)}
              </Text>
              <Text style={{ fontSize: 12, color: colors.sub, fontFamily: 'monospace' }}> {rep.trend}</Text>
            </View>
          </>
        ) : (
          <Text style={s.noData}>no reputation data yet</Text>
        )}
      </View>

      {negotiations.length > 0 && (
        <>
          <Text style={s.sectionLabel}>NEGOTIATIONS</Text>
          <View style={s.card}>
            {negotiations.map(t => (
              <NegotiationCard key={t.conversationId} thread={t} />
            ))}
          </View>
        </>
      )}

      {inbox.length > 0 && negotiations.length === 0 && (
        <>
          <Text style={s.sectionLabel}>INBOX</Text>
          <View style={s.card}>
            {inbox.map((env, i) => (
              <InboxRow key={i} env={env} />
            ))}
          </View>
        </>
      )}

      {pendingSwaps.length > 0 && (
        <>
          <Text style={s.sectionLabel}>PENDING SWAPS</Text>
          <View style={s.card}>
            {pendingSwaps.map((swap, i) => (
              <PendingSwapRow
                key={swap.swap_id}
                swap={swap}
                isLast={i === pendingSwaps.length - 1}
                onConfirm={confirmSwap}
                onReject={rejectSwap}
                colors={colors}
                s={s}
              />
            ))}
          </View>
        </>
      )}

      {/* Agent phone activity log */}
      {!isHosted && bridgeLog.length > 0 && (
        <>
          <Text style={s.sectionLabel}>AGENT ACTIONS</Text>
          <View style={s.card}>
            {bridgeLog.map((e, i) => (
              <BridgeLogRow key={i} entry={e} isLast={i === bridgeLog.length - 1} />
            ))}
          </View>
        </>
      )}

      {/* Task audit log */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, marginTop: 4 }}>
        <Text style={s.sectionLabel}>COMPLETED TASKS</Text>
        {taskLoading && <ActivityIndicator size="small" color={colors.sub} />}
      </View>
      {taskEntries.length === 0 ? (
        <View style={{ paddingVertical: 16, paddingHorizontal: 4 }}>
          <Text style={s.noData}>No tasks logged yet.{'\n'}ZeroClaw writes here after each delivery.</Text>
        </View>
      ) : (
        taskEntries.map((entry, i) => (
          <TaskLogRow
            key={entry.id}
            entry={entry}
            agentName={displayName}
            onShare={() => setShareEntry(entry)}
            onDelete={async () => {
              const ok = await deleteTaskEntry(entry.id, null);
              if (ok) setTaskTick(t => t + 1);
            }}
            isLast={i === taskEntries.length - 1}
          />
        ))
      )}

      {shareEntry && (
        <ShareCardModal
          entry={shareEntry}
          agentName={displayName}
          agentId={displayId ?? ''}
          onClose={() => setShareEntry(null)}
          onShared={async () => {
            await markTaskShared(shareEntry.id);
            setShareEntry(null);
            setTaskTick(t => t + 1);
          }}
        />
      )}
    </ScrollView>
  );
}

// ── Task log helpers ──────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  research: '#4a9eff',
  code: '#a259f7',
  writing: '#f7a259',
  trade: '#59f7a2',
  data: '#f7d959',
  other: '#8a8a8a',
};

function categoryColor(cat: string): string {
  return CATEGORY_COLORS[cat.toLowerCase()] ?? CATEGORY_COLORS.other;
}

function fmtDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDuration(min: number): string {
  if (min <= 0) return '';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ── TaskLogRow ────────────────────────────────────────────────────────────

interface TaskLogRowProps {
  entry: TaskLogEntry;
  agentName: string;
  onShare: () => void;
  onDelete: () => void;
  isLast: boolean;
}

function TaskLogRow({ entry, onShare, onDelete, isLast }: TaskLogRowProps) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  const catColor = categoryColor(entry.category);
  return (
    <View style={[s.card, { marginBottom: isLast ? 20 : 10 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ backgroundColor: catColor + '20', borderWidth: 1, borderColor: catColor + '60', borderRadius: 3, paddingHorizontal: 7, paddingVertical: 2 }}>
            <Text style={{ fontSize: 9, color: catColor, fontFamily: 'monospace', letterSpacing: 1, fontWeight: '700' }}>
              {entry.category.toUpperCase()}
            </Text>
          </View>
          {entry.outcome === 'delivered' && (
            <View style={{ backgroundColor: colors.green + '15', borderWidth: 1, borderColor: colors.green + '40', borderRadius: 3, paddingHorizontal: 7, paddingVertical: 2 }}>
              <Text style={{ fontSize: 9, color: colors.green, fontFamily: 'monospace', letterSpacing: 1 }}>DELIVERED</Text>
            </View>
          )}
          {entry.outcome === 'disputed' && (
            <View style={{ backgroundColor: colors.amber + '15', borderWidth: 1, borderColor: colors.amber + '40', borderRadius: 3, paddingHorizontal: 7, paddingVertical: 2 }}>
              <Text style={{ fontSize: 9, color: colors.amber, fontFamily: 'monospace', letterSpacing: 1 }}>DISPUTED</Text>
            </View>
          )}
          {entry.shared && (
            <Text style={{ fontSize: 9, color: colors.sub, fontFamily: 'monospace' }}>↑ shared</Text>
          )}
        </View>
        <Text style={{ fontSize: 10, color: colors.sub, fontFamily: 'monospace' }}>{fmtDate(entry.timestamp)}</Text>
      </View>

      <Text style={{ fontSize: 13, color: colors.text, lineHeight: 18, marginBottom: 8 }} numberOfLines={3}>
        {entry.summary}
      </Text>

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          {entry.amount_usd > 0 && (
            <Text style={{ fontSize: 11, color: colors.green, fontFamily: 'monospace', fontWeight: '700' }}>
              +${entry.amount_usd.toFixed(0)} USD
            </Text>
          )}
          {entry.duration_min > 0 && (
            <Text style={{ fontSize: 11, color: colors.sub, fontFamily: 'monospace' }}>
              {fmtDuration(entry.duration_min)}
            </Text>
          )}
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <TouchableOpacity onPress={onShare} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={{ fontSize: 11, color: colors.green, fontFamily: 'monospace', fontWeight: '700' }}>SHARE ↗</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onDelete} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={{ fontSize: 11, color: colors.sub, fontFamily: 'monospace' }}>DEL</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ── ShareCardModal ────────────────────────────────────────────────────────

interface ShareCardModalProps {
  entry: TaskLogEntry;
  agentName: string;
  agentId: string;
  onClose: () => void;
  onShared: () => void;
}

function ShareCardModal({ entry, agentName, agentId, onClose, onShared }: ShareCardModalProps) {
  const { colors } = useTheme();
  const catColor = categoryColor(entry.category);
  const shortAgent = agentId.length > 16 ? `${agentId.slice(0, 8)}…${agentId.slice(-6)}` : agentId;

  const handleShare = async () => {
    const lines: string[] = [];
    lines.push(`My AI agent ${agentName} just completed a ${entry.category} task.`);
    lines.push('');
    lines.push(`"${entry.summary}"`);
    lines.push('');
    if (entry.amount_usd > 0) lines.push(`Earned: $${entry.amount_usd.toFixed(0)} USD`);
    if (entry.duration_min > 0) lines.push(`Time: ${fmtDuration(entry.duration_min)}`);
    lines.push('');
    lines.push(`Verified on 0x01 mesh · ${fmtDate(entry.timestamp)}`);
    lines.push(`Agent: ${shortAgent}`);
    lines.push('0x01.world');

    try {
      const result = await Share.share({ message: lines.join('\n') });
      if (result.action === Share.sharedAction) {
        onShared();
      }
    } catch {
      // user dismissed — do nothing
    }
  };

  return (
    <Modal
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' }}>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose} />
        <View style={{ backgroundColor: '#0a0a0a', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, paddingBottom: 36 }}>
          {/* Card preview */}
          <View style={{
            backgroundColor: '#111',
            borderWidth: 1,
            borderColor: catColor + '60',
            borderRadius: 8,
            padding: 20,
            marginBottom: 20,
          }}>
            {/* Header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <View>
                <Text style={{ fontSize: 14, color: '#fff', fontWeight: '700', fontFamily: 'monospace' }}>
                  {agentName}
                </Text>
                <Text style={{ fontSize: 10, color: '#666', fontFamily: 'monospace', marginTop: 2 }}>
                  {shortAgent}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ fontSize: 9, color: '#444', fontFamily: 'monospace', letterSpacing: 2 }}>0X01</Text>
                <Text style={{ fontSize: 9, color: '#444', fontFamily: 'monospace', letterSpacing: 1 }}>MESH</Text>
              </View>
            </View>

            {/* Category badge */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <View style={{ backgroundColor: catColor + '20', borderWidth: 1, borderColor: catColor, borderRadius: 3, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ fontSize: 9, color: catColor, fontFamily: 'monospace', fontWeight: '700', letterSpacing: 2 }}>
                  {entry.category.toUpperCase()}
                </Text>
              </View>
              <View style={{ backgroundColor: colors.green + '15', borderWidth: 1, borderColor: colors.green + '40', borderRadius: 3, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ fontSize: 9, color: colors.green, fontFamily: 'monospace', letterSpacing: 1 }}>
                  {entry.outcome.toUpperCase()}
                </Text>
              </View>
            </View>

            {/* Summary */}
            <Text style={{ fontSize: 14, color: '#e8e8e8', lineHeight: 20, marginBottom: 16 }}>
              {entry.summary}
            </Text>

            {/* Stats row */}
            <View style={{ flexDirection: 'row', gap: 20, marginBottom: 16 }}>
              {entry.amount_usd > 0 && (
                <View>
                  <Text style={{ fontSize: 20, color: colors.green, fontFamily: 'monospace', fontWeight: '700' }}>
                    ${entry.amount_usd.toFixed(0)}
                  </Text>
                  <Text style={{ fontSize: 9, color: '#666', fontFamily: 'monospace', letterSpacing: 1 }}>USD EARNED</Text>
                </View>
              )}
              {entry.duration_min > 0 && (
                <View>
                  <Text style={{ fontSize: 20, color: '#fff', fontFamily: 'monospace', fontWeight: '700' }}>
                    {fmtDuration(entry.duration_min)}
                  </Text>
                  <Text style={{ fontSize: 9, color: '#666', fontFamily: 'monospace', letterSpacing: 1 }}>DURATION</Text>
                </View>
              )}
            </View>

            {/* Footer */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#222', paddingTop: 12 }}>
              <Text style={{ fontSize: 9, color: '#555', fontFamily: 'monospace' }}>
                {fmtDate(entry.timestamp)}
              </Text>
              <Text style={{ fontSize: 9, color: '#555', fontFamily: 'monospace', letterSpacing: 1 }}>
                0X01.WORLD
              </Text>
            </View>
          </View>

          {/* Actions */}
          <TouchableOpacity
            onPress={handleShare}
            style={{ backgroundColor: colors.green, borderRadius: 6, paddingVertical: 14, alignItems: 'center', marginBottom: 10 }}
          >
            <Text style={{ fontSize: 13, color: '#000', fontFamily: 'monospace', fontWeight: '700', letterSpacing: 2 }}>
              SHARE ↗
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onClose}
            style={{ paddingVertical: 12, alignItems: 'center' }}
          >
            <Text style={{ fontSize: 12, color: colors.sub, fontFamily: 'monospace' }}>CANCEL</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function statusColor(status: string, colors: ThemeColors): string {
  switch (status) {
    case 'PROPOSE': return colors.blue;
    case 'COUNTER': return colors.amber;
    case 'ACCEPT':  return colors.green;
    case 'REJECT':  return colors.red;
    case 'DELIVER': return '#a259f7';
    default:        return colors.sub;
  }
}

function formatUsdc(microunits: number): string {
  return (microunits / 1_000_000).toFixed(2) + ' USDC';
}

function NegotiationCard({ thread }: { thread: NegotiationThread }) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  const [expanded, setExpanded] = useState(false);
  const short = (id: string) => id.length > 16 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;
  const color = statusColor(thread.latestStatus, colors);
  return (
    <TouchableOpacity
      style={s.negCard}
      onPress={() => setExpanded(e => !e)}
      activeOpacity={0.8}
    >
      <View style={s.negHeader}>
        <View style={[s.negBadge, { backgroundColor: color + '22', borderColor: color }]}>
          <Text style={[s.negBadgeText, { color }]}>{thread.latestStatus}</Text>
        </View>
        <Text style={s.negParty}>{short(thread.counterparty)}</Text>
        {thread.latestAmount !== undefined && (
          <Text style={s.negAmount}>{formatUsdc(thread.latestAmount)}</Text>
        )}
        <Text style={s.negChevron}>{expanded ? '▲' : '▼'}</Text>
      </View>
      <Text style={s.negConvId}>{short(thread.conversationId)}</Text>
      {expanded && (
        <View style={s.negTimeline}>
          {thread.messages.map((msg, i) => (
            <View key={i} style={s.negTimelineRow}>
              <View style={[s.negDot, { backgroundColor: statusColor(msg.msg_type, colors) }]} />
              <View style={{ flex: 1 }}>
                <Text style={[s.negTimelineType, { color: statusColor(msg.msg_type, colors) }]}>
                  {msg.msg_type}
                  {msg.round !== undefined ? ` (round ${msg.round}/${msg.maxRounds ?? '?'})` : ''}
                  {msg.amount !== undefined ? `  ${formatUsdc(msg.amount)}` : ''}
                </Text>
                {msg.message ? (
                  <Text style={s.negTimelineMsg} numberOfLines={2}>{msg.message}</Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      )}
    </TouchableOpacity>
  );
}

function InboxRow({ env }: { env: InboundEnvelope }) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  let displayFrom = env.sender ?? '';
  if (displayFrom.length > 16) {
    displayFrom = `${displayFrom.slice(0, 6)}…${displayFrom.slice(-6)}`;
  }
  return (
    <View style={s.inboxRow}>
      <View>
        <Text style={s.inboxType}>{env.msg_type}</Text>
        <Text style={s.inboxFrom}>{displayFrom}</Text>
      </View>
      <Text style={s.inboxSlot}>{env.slot}</Text>
    </View>
  );
}

// ── Portfolio Subtab ──────────────────────────────────────────────────────

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
]);

function TokenRow({ token, solPrice }: { token: TokenBalance; solPrice: number | null }) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  const isSol = token.mint === SOL_MINT;
  const isUsdc = USDC_MINTS.has(token.mint);
  const symbol = isSol ? 'SOL' : isUsdc ? 'USDC' : shortId(token.mint);
  const color = isSol ? '#B351DF' : isUsdc ? colors.amber : colors.text;
  const usdValue = isSol && solPrice ? token.amount * solPrice : isUsdc ? token.amount : null;

  return (
    <View style={[s.hotWalletRow, { marginTop: 8 }]}>
      <Text style={[s.hotBalance, { color, fontSize: 16 }]}>
        {symbol} {token.amount.toLocaleString(undefined, { minimumFractionDigits: isSol ? 4 : 2, maximumFractionDigits: isSol ? 4 : 2 })}
      </Text>
      {usdValue !== null
        ? <Text style={s.hotAddr}>${usdValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
        : (isSol || isUsdc) ? <Text style={s.hotAddr}>{isSol ? 'SOL' : 'USDC'}</Text> : null
      }
    </View>
  );
}

function PortfolioSubtab() {
  const { colors } = useTheme();
  const s = useStyles(colors);
  const { config } = useNode();
  const { tokens, loading: balLoading, solanaAddress } = useHotKeyBalance();
  const phantom = usePhantomBalance();
  const history = usePortfolioHistory();
  const solPrice = useSolPrice();
  const isHosted = !!config?.nodeApiUrl;

  // Fetch DexScreener prices for non-stablecoin SPL tokens in the Phantom wallet.
  const otherMints = phantom.splTokens
    .map(t => t.mint)
    .filter(m => !USDC_MINTS.has(m));
  const dexPrices = useDexPrices(otherMints);

  const hotTotalUsd = tokens.reduce((sum, t) => {
    if (t.mint === SOL_MINT && solPrice) return sum + t.amount * solPrice;
    if (USDC_MINTS.has(t.mint)) return sum + t.amount;
    return sum;
  }, 0);
  const [sweeping, setSweeping] = useState(false);
  const [sweepAmount, setSweepAmount] = useState('');

  // Sweep destination: Phantom wallet (owner) if registered, otherwise prompt
  const sweepDest = phantom.address;

  const totalUsdc = tokens.find(t => USDC_MINTS.has(t.mint))?.amount ?? 0;

  const handleSweep = () => {
    if (!sweepDest) return;
    const amountNum = sweepAmount ? parseFloat(sweepAmount) : undefined;
    // H-2: Require explicit user confirmation before sweeping funds.
    const displayAmount = amountNum != null && !isNaN(amountNum)
      ? `${amountNum.toFixed(6)} USDC`
      : `all USDC (max ${totalUsdc.toFixed(2)})`;
    Alert.alert(
      'Confirm Sweep',
      `Send ${displayAmount} to ${sweepDest.slice(0, 8)}…${sweepDest.slice(-4)}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sweep',
          style: 'destructive',
          onPress: async () => {
            const atomicAmount = amountNum != null && !isNaN(amountNum)
              ? Math.floor(amountNum * 1_000_000)
              : undefined;
            setSweeping(true);
            try {
              const res = await sweepUsdc(sweepDest, atomicAmount);
              const txLine = res?.signature ? `\n\nTx: ${res.signature}` : res?.via === 'kora' ? '\n\n(gasless via Kora)' : '';
              Alert.alert('Success', `Swept ${res.amount_usdc} USDC to ${sweepDest}${txLine}`);
              setSweepAmount('');
            } catch (e: any) {
              Alert.alert('Sweep Failed', e.message);
            } finally {
              setSweeping(false);
            }
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={s.subtabRoot} contentContainerStyle={s.subtabContent}>

      {/* ── Owner / Phantom wallet (primary) ─────────────────────────── */}
      {phantom.address ? (
        <>
          <Text style={s.sectionLabel}>OWNER WALLET (PHANTOM)</Text>
          <View style={s.card}>
            <TouchableOpacity
              onPress={() => Share.share({ message: phantom.address! })}
              activeOpacity={0.7}
              style={s.hotWalletRow}
            >
              <Text style={[s.sectionLabel, { marginTop: 0, marginBottom: 0, color: colors.amber }]}>
                {shortId(phantom.address)}
              </Text>
              <Text style={s.hotAddr}>(COPY)</Text>
            </TouchableOpacity>
            {phantom.loading ? (
              <ActivityIndicator color={colors.amber} style={{ marginTop: 12 }} />
            ) : (
              <View style={{ marginTop: 10 }}>
                {/* Total USD */}
                {(() => {
                  const solUsd = (phantom.sol ?? 0) * (solPrice ?? 0);
                  const usdcUsd = phantom.usdc ?? 0;
                  const splUsd = phantom.splTokens.reduce((sum, t) => {
                    const p = dexPrices.get(t.mint);
                    return sum + (p ? t.amount * p.priceUsd : 0);
                  }, 0);
                  const total = solUsd + usdcUsd + splUsd;
                  if (total <= 0) return null;
                  return (
                    <View style={[s.totalUsdRow, { marginBottom: 8 }]}>
                      <Text style={s.totalUsdLabel}>TOTAL</Text>
                      <Text style={s.totalUsdValue}>${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
                    </View>
                  );
                })()}
                {/* SOL */}
                {phantom.sol !== null && (
                  <View style={s.hotWalletRow}>
                    <Text style={[s.hotBalance, { color: '#B351DF' }]}>
                      SOL {phantom.sol.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}
                    </Text>
                    {solPrice && (
                      <Text style={s.hotAddr}>
                        ${(phantom.sol * solPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </Text>
                    )}
                  </View>
                )}
                {/* USDC */}
                {phantom.usdc !== null && phantom.usdc > 0 && (
                  <View style={[s.hotWalletRow, { marginTop: 6 }]}>
                    <Text style={[s.hotBalance, { color: colors.amber }]}>USDC</Text>
                    <Text style={s.hotAddr}>
                      ${phantom.usdc.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </Text>
                  </View>
                )}
                {/* Other SPL tokens */}
                {phantom.splTokens
                  .filter(t => !USDC_MINTS.has(t.mint))
                  .map(t => {
                    const info = dexPrices.get(t.mint);
                    const usd = info ? t.amount * info.priceUsd : null;
                    const label = info?.symbol || shortId(t.mint);
                    return (
                      <View key={t.mint} style={[s.hotWalletRow, { marginTop: 6 }]}>
                        <Text style={[s.hotBalance, { color: colors.text }]}>
                          {label} {t.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                        </Text>
                        {usd !== null && usd > 0 ? (
                          <Text style={s.hotAddr}>
                            ${usd < 0.01 ? usd.toExponential(2) : usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </Text>
                        ) : null}
                      </View>
                    );
                  })
                }
              </View>
            )}
          </View>
        </>
      ) : null}

      {/* ── Agent hot wallet (earnings) ───────────────────────────────── */}
      <Text style={s.sectionLabel}>
        {phantom.address ? 'AGENT HOT WALLET (EARNINGS)' : 'TOKEN BALANCES'}
      </Text>
      <View style={s.card}>
        <View style={s.hotWalletRow}>
          <Text style={[s.sectionLabel, { marginTop: 0, marginBottom: 4 }]}>ADDRESS</Text>
          {solanaAddress && (
            <TouchableOpacity
              onPress={() => Share.share({ message: solanaAddress })}
              activeOpacity={0.7}
            >
              <Text style={s.hotAddr}>
                {shortId(solanaAddress)} (COPY)
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {tokens.length > 0 && hotTotalUsd > 0 && (
          <View style={s.totalUsdRow}>
            <Text style={s.totalUsdLabel}>TOTAL</Text>
            <Text style={s.totalUsdValue}>${hotTotalUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
          </View>
        )}
        {balLoading && tokens.length === 0 ? (
          <ActivityIndicator color={colors.green} style={{ marginVertical: 20 }} />
        ) : tokens.length === 0 ? (
          <Text style={s.noData}>No tokens found</Text>
        ) : (
          tokens.map(t => <TokenRow key={t.mint} token={t} solPrice={solPrice} />)
        )}

        {!isHosted && totalUsdc > 0 && sweepDest && (
          <View style={{ marginTop: 24, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 16 }}>
            <Text style={s.sectionLabel}>SWEEP TO PHANTOM</Text>
            <View style={s.linkInputRow}>
              <TextInput
                style={s.linkInput}
                value={sweepAmount}
                onChangeText={setSweepAmount}
                placeholder={`Max (${totalUsdc.toFixed(2)})`}
                placeholderTextColor={colors.sub}
                keyboardType="numeric"
              />
              <TouchableOpacity
                style={[s.btn, { backgroundColor: colors.amber, flex: 1, paddingVertical: 10 }, (sweeping || totalUsdc <= 0) && { opacity: 0.5 }]}
                onPress={handleSweep}
                disabled={sweeping || totalUsdc <= 0}
                activeOpacity={0.8}
              >
                {sweeping
                  ? <ActivityIndicator size="small" color="#000" />
                  : <Text style={[s.btnText, { color: '#000' }]}>SWEEP</Text>
                }
              </TouchableOpacity>
            </View>
            <Text style={[s.hint, { marginTop: 8, textAlign: 'left' }]}>
              → {shortId(sweepDest)}
            </Text>
          </View>
        )}
      </View>

      <Text style={s.sectionLabel}>ACTIVITY</Text>
      <View style={s.card}>
        {history.length === 0 ? (
          <Text style={[s.noData, { textAlign: 'center', paddingVertical: 10 }]}>
            No recent activity
          </Text>
        ) : (
          history.map((ev, i) => (
            <PortfolioEventRow key={i} event={ev} isLast={i === history.length - 1} />
          ))
        )}
      </View>
    </ScrollView>
  );
}

function PendingSwapRow({
  swap,
  isLast,
  onConfirm,
  onReject,
  colors,
  s,
}: {
  swap: PendingSwap;
  isLast: boolean;
  onConfirm: (id: string) => Promise<{ out_amount: number; txid: string }>;
  onReject: (id: string) => Promise<void>;
  colors: ThemeColors;
  s: any;
}) {
  const [busy, setBusy] = useState(false);
  const expiresIn = Math.max(0, Math.round((swap.expires_at - Date.now() / 1000)));
  const mm = Math.floor(expiresIn / 60);
  const ss = expiresIn % 60;

  const handleConfirm = async () => {
    setBusy(true);
    try {
      const res = await onConfirm(swap.swap_id);
      Alert.alert('Swap executed', `Received ${res.out_amount.toFixed(4)} tokens\n${res.txid.slice(0, 16)}…`);
    } catch (e: any) {
      Alert.alert('Swap failed', e?.message ?? 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    setBusy(true);
    try {
      await onReject(swap.swap_id);
    } catch {
      // silent
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[s.inboxRow, isLast && { borderBottomWidth: 0 }, { flexDirection: 'column', gap: 8 }]}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={s.inboxType}>UNKNOWN TOKEN SWAP</Text>
        <Text style={[s.hint, { color: expiresIn < 60 ? colors.red : colors.sub }]}>
          {mm}:{ss.toString().padStart(2, '0')}
        </Text>
      </View>
      <Text style={s.inboxFrom}>
        {(swap.amount / 1e6).toFixed(2)} {shortId(swap.input_mint)} → {shortId(swap.output_mint)}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TouchableOpacity
          style={[s.btn, { flex: 1, paddingVertical: 8, backgroundColor: colors.green }, busy && { opacity: 0.5 }]}
          onPress={handleConfirm}
          disabled={busy}
          activeOpacity={0.8}
        >
          {busy
            ? <ActivityIndicator size="small" color="#000" />
            : <Text style={[s.btnText, { color: '#000' }]}>CONFIRM</Text>
          }
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.btn, { flex: 1, paddingVertical: 8, borderWidth: 1, borderColor: colors.red, backgroundColor: 'transparent' }, busy && { opacity: 0.5 }]}
          onPress={handleReject}
          disabled={busy}
          activeOpacity={0.8}
        >
          <Text style={[s.btnText, { color: colors.red }]}>REJECT</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function PortfolioEventRow({ event, isLast }: { event: PortfolioEvent; isLast: boolean }) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  const dateStr = new Date(event.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (event.type === 'swap') {
    return (
      <View style={[s.inboxRow, isLast && { borderBottomWidth: 0 }]}>
        <View style={{ flex: 1 }}>
          <Text style={s.inboxType}>SWAP</Text>
          <Text style={s.inboxFrom}>{shortId(event.input_mint)} → {shortId(event.output_mint)}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[s.inboxSlot, { color: colors.green }]}>+{event.output_amount.toFixed(2)}</Text>
          <Text style={[s.inboxSlot, { marginTop: 2 }]}>{dateStr}</Text>
        </View>
      </View>
    );
  }

  if (event.type === 'bounty') {
    return (
      <View style={[s.inboxRow, isLast && { borderBottomWidth: 0 }]}>
        <View style={{ flex: 1 }}>
          <Text style={[s.inboxType, { color: colors.blue }]}>BOUNTY</Text>
          <Text style={s.inboxFrom}>from {shortId(event.from_agent)}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[s.inboxSlot, { color: colors.green }]}>+${event.amount_usdc.toFixed(2)}</Text>
          <Text style={[s.inboxSlot, { marginTop: 2 }]}>{dateStr}</Text>
        </View>
      </View>
    );
  }

  if (event.type === 'bags_fee') {
    return (
      <View style={[s.inboxRow, isLast && { borderBottomWidth: 0 }]}>
        <View style={{ flex: 1 }}>
          <Text style={[s.inboxType, { color: '#9c27b0' }]}>BAGS FEE</Text>
          <Text style={s.inboxFrom}>{shortId(event.txid)}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[s.inboxSlot, { color: '#9c27b0' }]}>-${event.amount_usdc.toFixed(4)}</Text>
          <Text style={[s.inboxSlot, { marginTop: 2 }]}>{dateStr}</Text>
        </View>
      </View>
    );
  }

  if (event.type === 'bags_launch') {
    return (
      <View style={[s.inboxRow, isLast && { borderBottomWidth: 0 }]}>
        <View style={{ flex: 1 }}>
          <Text style={[s.inboxType, { color: '#9c27b0' }]}>TOKEN LAUNCH</Text>
          <Text style={s.inboxFrom}>{event.name} ({event.symbol})</Text>
          <Text style={[s.inboxFrom, { fontFamily: 'monospace', fontSize: 10 }]}>{shortId(event.token_mint)}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[s.inboxSlot, { color: '#9c27b0' }]}>BAGS</Text>
          <Text style={[s.inboxSlot, { marginTop: 2 }]}>{dateStr}</Text>
        </View>
      </View>
    );
  }

  if (event.type === 'bags_claim') {
    return (
      <View style={[s.inboxRow, isLast && { borderBottomWidth: 0 }]}>
        <View style={{ flex: 1 }}>
          <Text style={[s.inboxType, { color: '#9c27b0' }]}>FEE CLAIM</Text>
          <Text style={s.inboxFrom}>{shortId(event.token_mint)}</Text>
          <Text style={[s.inboxFrom, { fontSize: 10 }]}>{event.claimed_txs} tx{event.claimed_txs !== 1 ? 's' : ''}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[s.inboxSlot, { color: '#9c27b0' }]}>BAGS</Text>
          <Text style={[s.inboxSlot, { marginTop: 2 }]}>{dateStr}</Text>
        </View>
      </View>
    );
  }

  return null;
}
function BridgeLogRow({ entry, isLast }: { entry: BridgeLogEntry; isLast: boolean }) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  const outcomeColor = entry.outcome === 'ok' ? colors.green
    : entry.outcome === 'disabled' || entry.outcome === 'denied' ? colors.sub
      : entry.outcome === 'rate_limited' ? colors.amber
        : colors.red;
  const outcomeLabel = entry.outcome === 'ok' ? 'ok'
    : entry.outcome === 'disabled' ? 'off'
      : entry.outcome === 'denied' ? 'no perm'
        : entry.outcome === 'rate_limited' ? 'throttled'
          : 'err';
  return (
    <View style={[s.inboxRow, isLast && { borderBottomWidth: 0 }]}>
      <View style={{ flex: 1 }}>
        <Text style={s.inboxType}>{entry.capability}</Text>
        <Text style={s.inboxFrom}>{entry.action}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[s.inboxSlot, { color: outcomeColor }]}>{outcomeLabel}</Text>
        <Text style={[s.inboxSlot, { marginTop: 2 }]}>{entry.time}</Text>
      </View>
    </View>
  );
}

// ── Skills Subtab ─────────────────────────────────────────────────────────

const SKILL_STORE_URL = 'https://skills.0x01.world/?source=app';

// JS injected into the skill store page so it can send install requests back.
const SKILL_STORE_BRIDGE = `
  (function() {
    window.__zerox1 = {
      installSkill: function(name, url) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'install_skill', name: name, url: url }));
      }
    };
  })();
  true;
`;

function SkillsSubtab() {
  const { colors } = useTheme();
  const s = useStyles(colors);
  const { skills, loading, refresh } = useSkills();
  const [installing, setInstalling] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [urlName, setUrlName] = useState('');
  const [urlValue, setUrlValue] = useState('');
  const [storeVisible, setStoreVisible] = useState(false);
  const [storeLoading, setStoreLoading] = useState(true);
  const installCooldownRef = useRef<number>(0);

  const handleInstall = useCallback(async () => {
    const name = urlName.trim();
    const url = urlValue.trim();
    if (!name || !url) return;
    setInstalling(true);
    try {
      await skillInstallUrl(name, url);
      setUrlName('');
      setUrlValue('');
      await refresh();
    } catch (e: any) {
      Alert.alert('Install Failed', e?.message ?? 'Unknown error');
    } finally {
      setInstalling(false);
    }
  }, [urlName, urlValue, refresh]);

  const handleRemove = useCallback((skill: Skill) => {
    Alert.alert('Remove Skill', `Remove "${skill.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'REMOVE',
        style: 'destructive',
        onPress: async () => {
          setRemoving(skill.name);
          try {
            await skillRemove(skill.name);
            await refresh();
          } catch (e: any) {
            Alert.alert('Error', e?.message ?? 'Failed to remove skill');
          } finally {
            setRemoving(null);
          }
        },
      },
    ]);
  }, [refresh]);

  const canInstall = urlName.trim().length > 0 && urlValue.trim().length > 0 && !installing;

  const handleStoreMessage = useCallback(async (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'install_skill' && msg.name && msg.url) {
        if (Date.now() - installCooldownRef.current < 2000) return;
        installCooldownRef.current = Date.now();
        setStoreVisible(false);
        setInstalling(true);
        try {
          await skillInstallUrl(msg.name, msg.url);
          await refresh();
          Alert.alert('Skill installed', `"${msg.name}" is ready.`);
        } catch (e: any) {
          Alert.alert('Install Failed', e?.message ?? 'Unknown error');
        } finally {
          setInstalling(false);
        }
      }
    } catch { /* ignore non-JSON messages */ }
  }, [refresh]);


  return (
    <ScrollView style={s.subtabRoot} contentContainerStyle={s.subtabContent}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={s.sectionLabel}>INSTALLED SKILLS</Text>
        <TouchableOpacity onPress={refresh} disabled={loading}>
          <Text style={{ fontSize: 9, color: colors.sub, fontFamily: 'monospace', letterSpacing: 2 }}>
            {loading ? '…' : 'REFRESH'}
          </Text>
        </TouchableOpacity>
      </View>
      <View style={s.card}>
        {loading && skills.length === 0 ? (
          <ActivityIndicator color={colors.green} style={{ marginVertical: 16 }} />
        ) : skills.length === 0 ? (
          <Text style={s.noData}>No skills installed</Text>
        ) : (
          skills.map((skill, i) => (
            <View key={skill.name} style={[s.skillRow, i === skills.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <View style={s.skillBadge}>
                    <Text style={s.skillBadgeText}>{skill.icon}</Text>
                  </View>
                  <Text style={s.skillName}>{skill.label}</Text>
                </View>
                {skill.description ? (
                  <Text style={s.skillDesc}>{skill.description}</Text>
                ) : null}
              </View>
              <TouchableOpacity
                onPress={() => handleRemove(skill)}
                disabled={removing === skill.name}
                style={{ paddingLeft: 12 }}
              >
                <Text style={s.removeBtnText}>{removing === skill.name ? '...' : 'REMOVE'}</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>

      <TouchableOpacity
        style={s.skillStoreBtn}
        onPress={() => { setStoreLoading(true); setStoreVisible(true); }}
        activeOpacity={0.8}
        disabled={installing}
      >
        <Text style={s.skillStoreBtnText}>
          {installing ? 'INSTALLING…' : 'BROWSE SKILL STORE'}
        </Text>
      </TouchableOpacity>

      <Modal
        visible={storeVisible}
        animationType="slide"
        onRequestClose={() => setStoreVisible(false)}
      >
        <View style={s.storeModal}>
          <View style={s.storeHeader}>
            <Text style={s.storeTitle}>SKILL STORE</Text>
            <TouchableOpacity onPress={() => setStoreVisible(false)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Text style={s.storeClose}>✕</Text>
            </TouchableOpacity>
          </View>
          {storeLoading && (
            <View style={s.storeSpinner}>
              <ActivityIndicator color={colors.green} />
            </View>
          )}
          <WebView
            source={{ uri: SKILL_STORE_URL }}
            injectedJavaScript={SKILL_STORE_BRIDGE}
            onMessage={handleStoreMessage}
            onLoadStart={() => setStoreLoading(true)}
            onLoadEnd={() => setStoreLoading(false)}
            style={storeLoading ? { opacity: 0 } : { flex: 1 }}
          />
        </View>
      </Modal>

      <Text style={s.sectionLabel}>INSTALL SKILL</Text>
      <View style={s.card}>
        <Text style={[s.noData, { marginBottom: 12, lineHeight: 18 }]}>
          HTTPS only. URL must point to a raw SKILL.toml file.
        </Text>
        <Text style={s.fieldLabel}>SKILL NAME</Text>
        <TextInput
          style={s.skillInput}
          value={urlName}
          onChangeText={setUrlName}
          placeholder="my_skill"
          placeholderTextColor={colors.sub}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={[s.fieldLabel, { marginTop: 10 }]}>URL</Text>
        <TextInput
          style={s.skillInput}
          value={urlValue}
          onChangeText={setUrlValue}
          placeholder="https://…/SKILL.toml"
          placeholderTextColor={colors.sub}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={{ fontSize: 10, color: colors.sub, marginTop: 4 }}>Paste a URL to a SKILL.toml file</Text>
        <TouchableOpacity
          style={[s.btn, { marginTop: 14, backgroundColor: colors.green }, !canInstall && { opacity: 0.4 }]}
          onPress={handleInstall}
          disabled={!canInstall}
          activeOpacity={0.8}
        >
          {installing
            ? <ActivityIndicator size="small" color="#000" />
            : <Text style={[s.btnText, { color: '#000' }]}>INSTALL</Text>
          }
        </TouchableOpacity>
      </View>

      <Text style={s.hint}>
        Skills extend your agent's capabilities. Restart ZeroClaw after installing to activate.
      </Text>
    </ScrollView>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────

export function MyScreen() {
  const { colors } = useTheme();
  const s = useStyles(colors);
  const insets = useSafeAreaInsets();
  const [subtab, setSubtab] = useState<Subtab>('agents');
  const { contentHPad } = useLayout();

  return (
    <View style={s.root}>
      <NodeStatusBanner />
      <View style={{ flex: 1, paddingHorizontal: contentHPad }}>
      <View style={[s.header, { paddingTop: insets.top + 16 }]}>
        <Text style={s.title}>MY</Text>
        <View style={s.tabs}>
          {(['agents', 'node', 'portfolio', 'skills'] as Subtab[]).map(t => (
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
      {subtab === 'agents' && <ErrorBoundary><AgentsSubtab /></ErrorBoundary>}
      {subtab === 'node' && <ErrorBoundary><NodeSubtab /></ErrorBoundary>}
      {subtab === 'portfolio' && <ErrorBoundary><PortfolioSubtab /></ErrorBoundary>}
      {subtab === 'skills' && <ErrorBoundary><SkillsSubtab /></ErrorBoundary>}
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

function useStyles(colors: ThemeColors, isTablet = false, isWide = false) {
  return React.useMemo(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 0, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { fontSize: 13, fontWeight: '700', color: colors.text, letterSpacing: 3, fontFamily: 'monospace', marginBottom: 14 },
  tabs: { flexDirection: 'row' },
  tab: { paddingVertical: 10, paddingHorizontal: 20, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: colors.green },
  tabText: { fontSize: 11, color: colors.sub, letterSpacing: 2, fontWeight: '700', fontFamily: 'monospace' },
  tabTextActive: { color: colors.green },
  subtabRoot: { flex: 1 },
  subtabContent: { padding: 20 },
  sectionLabel: { fontSize: 11, color: colors.sub, letterSpacing: 3, marginBottom: 10, marginTop: 20 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 4, padding: 16, marginBottom: 4 },
  hint: { fontSize: 11, color: colors.sub, fontFamily: 'monospace', lineHeight: 18, marginTop: 20, textAlign: 'center' },
  // agent card
  agentCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 4, padding: 14, marginBottom: 8 },
  agentCardRow: { flexDirection: 'row', alignItems: 'center' },
  agentCardInfo: { flex: 1 },
  agentNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  agentCardName: { fontSize: 14, fontWeight: '700', color: colors.text, fontFamily: 'monospace' },
  verifiedBadge: { backgroundColor: '#00e67618', borderWidth: 1, borderColor: colors.green + '60', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1 },
  verifiedText: { fontSize: 8, color: colors.green, fontWeight: '700', letterSpacing: 1, fontFamily: 'monospace' },
  agentCardId: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', marginTop: 2 },
  agentCardStats: { flexDirection: 'row', alignItems: 'center', marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border },
  agentScore: { fontSize: 16, fontWeight: '700', fontFamily: 'monospace' },
  agentScoreLabel: { fontSize: 10, color: colors.sub },
  agentDot: { color: colors.sub, marginHorizontal: 4 },
  agentTrend: { fontSize: 11, fontFamily: 'monospace' },
  modeBadge: { borderRadius: 3, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1 },
  badgeLocal: { backgroundColor: '#00e67615', borderColor: '#00e67640' },
  badgeHosted: { backgroundColor: '#ffc10715', borderColor: '#ffc10740' },
  badgeLinked: { backgroundColor: '#2979ff15', borderColor: '#2979ff40' },
  modeBadgeText: { fontSize: 9, fontWeight: '700', letterSpacing: 2 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  agentCardOwner: { fontSize: 9, color: colors.blue, fontFamily: 'monospace', marginTop: 2 },
  // skill badges
  skillBadgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border },
  skillBadge: { backgroundColor: '#00e67612', borderWidth: 1, borderColor: '#00e67630', borderRadius: 2, paddingHorizontal: 6, paddingVertical: 2 },
  skillBadgeText: { fontSize: 8, color: colors.green, letterSpacing: 1.5, fontFamily: 'monospace', fontWeight: '700' },
  // node subtab
  identityRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  agentName: { fontSize: 16, fontWeight: '700', color: colors.text, fontFamily: 'monospace' },
  agentId: { fontSize: 11, color: colors.sub, fontFamily: 'monospace', marginTop: 2 },
  btn: { borderRadius: 4, paddingVertical: 12, alignItems: 'center' },
  btnText: { fontSize: 12, fontWeight: '700', letterSpacing: 3 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  statCard: { flex: 1, minWidth: isWide ? '30%' : '45%', backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 4, padding: 12 },
  statVal: { fontSize: 24, fontWeight: '700', color: colors.text, fontFamily: 'monospace' },
  statLabel: { fontSize: 10, color: colors.sub, letterSpacing: 2, marginTop: 4 },
  noData: { color: colors.sub, fontFamily: 'monospace', letterSpacing: 1 },
  inboxRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  inboxType: { fontSize: 12, fontWeight: '700', color: colors.green, fontFamily: 'monospace' },
  inboxFrom: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', marginTop: 2 },
  inboxSlot: { fontSize: 10, color: colors.sub, fontFamily: 'monospace' },
  hostedBanner: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.green + '40', borderRadius: 4, padding: 14, marginBottom: 4 },
  hostedLabel: { fontSize: 9, color: colors.green, letterSpacing: 3, fontWeight: '700' },
  hostedHost: { fontSize: 13, color: colors.text, fontFamily: 'monospace', marginTop: 2 },
  disconnectBtn: { borderWidth: 1, borderColor: colors.red + '60', borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4 },
  disconnectText: { fontSize: 9, color: colors.red, letterSpacing: 2, fontWeight: '700' },
  barsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  bar: { width: 4, borderRadius: 1 },
  signalNull: { fontSize: 14, color: colors.sub },
  // hot wallet / portfolio
  hotWalletRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hotBalance: { fontSize: 18, fontWeight: '700', color: colors.amber, fontFamily: 'monospace' },
  hotBalanceSol: { fontSize: 18, fontWeight: '700', color: '#B351DF', fontFamily: 'monospace' },
  hotAddr: { fontSize: 9, color: colors.sub, fontFamily: 'monospace' },
  sweepTx: { fontSize: 9, color: colors.green, fontFamily: 'monospace', marginTop: 8 },
  // link agent
  linkBtn: { borderWidth: 1, borderColor: colors.border, borderRadius: 4, padding: 14, alignItems: 'center', marginTop: 12 },
  linkBtnText: { fontSize: 11, color: colors.sub, letterSpacing: 2, fontFamily: 'monospace' },
  linkSection: { marginTop: 12 },
  linkHint: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', marginBottom: 10 },
  linkInputRow: { flexDirection: 'row', gap: 8 },
  linkInput: { flex: 1, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 8, color: colors.text, fontFamily: 'monospace', fontSize: 12 },
  lookupBtn: { backgroundColor: colors.blue, borderRadius: 4, paddingHorizontal: 14, justifyContent: 'center', alignItems: 'center', minWidth: 80 },
  lookupBtnDisabled: { opacity: 0.5 },
  lookupBtnText: { fontSize: 10, fontWeight: '700', color: '#fff', letterSpacing: 2 },
  linkError: { fontSize: 10, color: '#ff1744', fontFamily: 'monospace', marginTop: 8 },
  previewBox: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.border },
  previewRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  previewLabel: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', letterSpacing: 2 },
  previewVal: { fontSize: 11, color: colors.text, fontFamily: 'monospace' },
  previewPending: { fontSize: 10, color: colors.amber, fontFamily: 'monospace', marginBottom: 6 },
  confirmBtn: { backgroundColor: colors.blue, borderRadius: 4, paddingVertical: 10, alignItems: 'center', marginTop: 10 },
  confirmBtnText: { fontSize: 11, fontWeight: '700', color: '#fff', letterSpacing: 2 },
  cancelLink: { alignItems: 'center', paddingVertical: 10 },
  cancelLinkText: { fontSize: 10, color: colors.sub, fontFamily: 'monospace' },
  // multi-agent picker
  pickerBox: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.border },
  pickerHint: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', marginBottom: 8 },
  pickerRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 8, borderRadius: 4, marginBottom: 4, borderWidth: 1, borderColor: colors.border },
  pickerRowSelected: { borderColor: colors.blue, backgroundColor: '#2979ff15' },
  pickerRadio: { width: 12, height: 12, borderRadius: 6, borderWidth: 1, borderColor: colors.sub, marginRight: 10 },
  pickerRadioSelected: { borderColor: colors.blue, backgroundColor: colors.blue },
  pickerName: { fontSize: 11, color: colors.text, fontFamily: 'monospace', fontWeight: '700' },
  pickerAgentId: { fontSize: 9, color: colors.sub, fontFamily: 'monospace', marginTop: 2 },
  // portfolio total
  totalUsdRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 12, marginBottom: 4, borderBottomWidth: 1, borderBottomColor: colors.border },
  totalUsdLabel: { fontSize: 9, color: colors.sub, letterSpacing: 3, fontFamily: 'monospace' },
  totalUsdValue: { fontSize: 20, fontWeight: '700', color: colors.green, fontFamily: 'monospace' },
  // skills
  skillRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  skillName: { fontSize: 13, color: colors.text, fontFamily: 'monospace' },
  skillDesc: { fontSize: 11, color: colors.sub, lineHeight: 16, marginTop: 3 },
  removeBtn: { borderWidth: 1, borderColor: colors.red + '60', borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4 },
  removeBtnText: { fontSize: 9, color: colors.red, letterSpacing: 2, fontWeight: '700', fontFamily: 'monospace' },
  fieldLabel: { fontSize: 9, color: colors.sub, letterSpacing: 2, fontFamily: 'monospace', marginBottom: 6 },
  skillInput: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 8, color: colors.text, fontFamily: 'monospace', fontSize: 13 },
  skillStoreBtn: { borderWidth: 1, borderColor: colors.green, borderRadius: 4, paddingVertical: 10, alignItems: 'center', marginBottom: 16 },
  skillStoreBtnText: { fontSize: 11, color: colors.green, fontFamily: 'monospace', letterSpacing: 2, fontWeight: '700' },
  storeModal: { flex: 1, backgroundColor: colors.bg },
  storeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
  storeTitle: { fontSize: 13, color: colors.text, fontFamily: 'monospace', letterSpacing: 3, fontWeight: '700' },
  storeClose: { fontSize: 16, color: colors.sub, fontFamily: 'monospace' },
  storeSpinner: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', zIndex: 1 },
  // negotiation cards
  negCard: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  negHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  negBadge: { borderRadius: 3, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  negBadgeText: { fontSize: 9, fontWeight: '700', letterSpacing: 2 },
  negParty: { flex: 1, fontSize: 11, color: colors.text, fontFamily: 'monospace' },
  negAmount: { fontSize: 11, color: colors.amber, fontFamily: 'monospace', fontWeight: '700' },
  negChevron: { fontSize: 10, color: colors.sub, marginLeft: 4 },
  negConvId: { fontSize: 9, color: colors.sub, fontFamily: 'monospace', marginBottom: 2 },
  negTimeline: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border },
  negTimelineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  negDot: { width: 8, height: 8, borderRadius: 4, marginTop: 3 },
  negTimelineType: { fontSize: 11, fontWeight: '700', fontFamily: 'monospace' },
  negTimelineMsg: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', marginTop: 2 },
  }), [colors]);
}
