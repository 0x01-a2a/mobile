/**
 * My — agent management hub.
 *
 * Two subtabs:
 *   Agents — all owned agents with status, reputation, location badge.
 *   Node   — local node controls, hosted banner, reputation detail, inbox.
 */
import React, { Component, useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNode } from '../hooks/useNode';
import {
  BridgeLogEntry,
  InboundEnvelope,
  NegotiationThread,
  PortfolioEvent,
  Skill,
  TokenBalance,
  clearTokenFromKeychain,
  groupNegotiations,
  probeRtt,
  skillInstallUrl,
  skillRemove,
  sweepUsdc,
  useBridgeActivityLog,
  useHotKeyBalance,
  useIdentity,
  useInbox,
  useOwnReputation,
  usePortfolioHistory,
  useSkills,
  useSolPrice,
} from '../hooks/useNodeApi';
import { useOwnedAgents, notifyLinkedAgentsUpdated, OwnedAgent } from '../hooks/useOwnedAgents';
import { NodeStatusBanner } from '../components/NodeStatusBanner';

const C = {
  bg: '#050505',
  card: '#0f0f0f',
  border: '#1a1a1a',
  green: '#00e676',
  red: '#ff1744',
  amber: '#ffc107',
  blue: '#2979ff',
  text: '#ffffff',
  sub: '#555555',
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
          <Text style={{ color: C.red, fontFamily: 'monospace', fontSize: 11, textAlign: 'center' }}>
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

function trendColor(trend: string) {
  if (trend === 'rising') return C.green;
  if (trend === 'falling') return C.red;
  return C.sub;
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
  const dotColor = agent.status === 'running' ? C.green : C.sub;
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

const AGGREGATOR_API_URL = 'https://api.0x01.world';

type LinkPreview = { agentId: string; ownerWallet: string; ownerStatus: 'claimed' | 'pending' };
type WalletAgent = { agent_id: string; name?: string };

function LinkAgentSection() {
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
  const agents = useOwnedAgents();
  const [refreshing, setRefreshing] = useState(false);

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
  hostUrl: string;
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
  return (
    <View style={s.statCard}>
      <Text style={[s.statVal, color ? { color } : undefined]}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}
function NodeSubtab() {
  const { status, loading, start, stop, config, saveConfig } = useNode();
  const identity = useIdentity();
  const rep = useOwnReputation(identity?.agent_id ?? null);
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

  const running = status === 'running';
  const isError = status === 'error';
  const dotColor = running ? C.green : isError ? C.amber : C.red;
  const scoreColor = rep && rep.total_score >= 0 ? C.green : C.red;
  const displayId = isHosted ? hostedAgentId : identity?.agent_id ?? null;
  const displayName = isHosted
    ? (hostedAgentId ? `hosted:${hostedAgentId.slice(0, 8)}` : 'hosted agent')
    : (identity?.name || config?.agentName || 'unnamed agent');

  if (loading) {
    return (
      <View style={[s.subtabRoot, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={C.green} size="large" />
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
              <StatCard label="SCORE" value={(rep.total_score > 0 ? '+' : '') + rep.total_score} color={scoreColor} />
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
    </ScrollView>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case 'PROPOSE': return C.blue;
    case 'COUNTER': return C.amber;
    case 'ACCEPT':  return C.green;
    case 'REJECT':  return C.red;
    case 'DELIVER': return '#a259f7';
    default:        return C.sub;
  }
}

function formatUsdc(microunits: number): string {
  return (microunits / 1_000_000).toFixed(2) + ' USDC';
}

function NegotiationCard({ thread }: { thread: NegotiationThread }) {
  const [expanded, setExpanded] = useState(false);
  const short = (id: string) => id.length > 16 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;
  const color = statusColor(thread.latestStatus);
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
              <View style={[s.negDot, { backgroundColor: statusColor(msg.msg_type) }]} />
              <View style={{ flex: 1 }}>
                <Text style={[s.negTimelineType, { color: statusColor(msg.msg_type) }]}>
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
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
]);

function TokenRow({ token, solPrice }: { token: TokenBalance; solPrice: number | null }) {
  const isSol = token.mint === SOL_MINT;
  const isUsdc = USDC_MINTS.has(token.mint);
  const symbol = isSol ? 'SOL' : isUsdc ? 'USDC' : shortId(token.mint);
  const color = isSol ? '#B351DF' : isUsdc ? C.amber : C.text;
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
  const { config } = useNode();
  const { tokens, loading: balLoading, solanaAddress } = useHotKeyBalance();
  const history = usePortfolioHistory();
  const solPrice = useSolPrice();
  const isHosted = !!config?.nodeApiUrl;

  const totalUsd = tokens.reduce((sum, t) => {
    if (t.mint === SOL_MINT && solPrice) return sum + t.amount * solPrice;
    if (USDC_MINTS.has(t.mint)) return sum + t.amount;
    return sum;
  }, 0);
  const [sweeping, setSweeping] = useState(false);
  const [sweepAmount, setSweepAmount] = useState('');
  const [coldWallet, setColdWallet] = useState<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem('zerox1:linked_agents')
      .then(raw => {
        if (!raw) return;
        const agents: Array<{ ownerWallet?: string }> = JSON.parse(raw);
        const first = agents.find(a => a.ownerWallet);
        setColdWallet(first?.ownerWallet ?? null);
      })
      .catch(() => {});
  }, []);

  const totalUsdc = tokens.find(t => t.mint.startsWith('4zMMC') || t.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')?.amount ?? 0;

  const handleSweep = async () => {
    if (!coldWallet) return;
    const amountNum = sweepAmount ? parseFloat(sweepAmount) : undefined;
    const atomicAmount = amountNum ? Math.floor(amountNum * 1_000_000) : undefined;

    setSweeping(true);
    try {
      const res = await sweepUsdc(coldWallet, atomicAmount);
      const txLine = res.signature ? `\n\nTx: ${res.signature}` : res.via === 'kora' ? '\n\n(gasless via Kora)' : '';
      Alert.alert('Success', `Swept ${res.amount_usdc} USDC to ${coldWallet}${txLine}`);
      setSweepAmount('');
    } catch (e: any) {
      Alert.alert('Sweep Failed', e.message);
    } finally {
      setSweeping(false);
    }
  };

  return (
    <ScrollView style={s.subtabRoot} contentContainerStyle={s.subtabContent}>
      <Text style={s.sectionLabel}>TOKEN BALANCES</Text>
      <View style={s.card}>
        <View style={s.hotWalletRow}>
          <Text style={[s.sectionLabel, { marginTop: 0, marginBottom: 4 }]}>ADDRESS</Text>
          {solanaAddress && (
            <TouchableOpacity
              onPress={() => {
                Share.share({ message: solanaAddress });
              }}
              activeOpacity={0.7}
            >
              <Text style={s.hotAddr}>
                {shortId(solanaAddress)} (COPY)
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {tokens.length > 0 && totalUsd > 0 && (
          <View style={s.totalUsdRow}>
            <Text style={s.totalUsdLabel}>TOTAL</Text>
            <Text style={s.totalUsdValue}>${totalUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
          </View>
        )}
        {balLoading && tokens.length === 0 ? (
          <ActivityIndicator color={C.green} style={{ marginVertical: 20 }} />
        ) : tokens.length === 0 ? (
          <Text style={s.noData}>No tokens found</Text>
        ) : (
          tokens.map(t => <TokenRow key={t.mint} token={t} solPrice={solPrice} />)
        )}

        {!isHosted && totalUsdc > 0 && coldWallet && (
          <View style={{ marginTop: 24, borderTopWidth: 1, borderTopColor: C.border, paddingTop: 16 }}>
            <Text style={s.sectionLabel}>SWEEP USDC</Text>
            <View style={s.linkInputRow}>
              <TextInput
                style={s.linkInput}
                value={sweepAmount}
                onChangeText={setSweepAmount}
                placeholder={`Max (${totalUsdc.toFixed(2)})`}
                placeholderTextColor={C.sub}
                keyboardType="numeric"
              />
              <TouchableOpacity
                style={[s.btn, { backgroundColor: C.amber, flex: 1, paddingVertical: 10 }, (sweeping || totalUsdc <= 0) && { opacity: 0.5 }]}
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
              Destination: {shortId(coldWallet)}
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

function PortfolioEventRow({ event, isLast }: { event: PortfolioEvent; isLast: boolean }) {
  const dateStr = new Date(event.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (event.type === 'swap') {
    return (
      <View style={[s.inboxRow, isLast && { borderBottomWidth: 0 }]}>
        <View style={{ flex: 1 }}>
          <Text style={s.inboxType}>SWAP</Text>
          <Text style={s.inboxFrom}>{shortId(event.input_mint)} → {shortId(event.output_mint)}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[s.inboxSlot, { color: C.green }]}>+{event.output_amount.toFixed(2)}</Text>
          <Text style={[s.inboxSlot, { marginTop: 2 }]}>{dateStr}</Text>
        </View>
      </View>
    );
  }

  if (event.type === 'bounty') {
    return (
      <View style={[s.inboxRow, isLast && { borderBottomWidth: 0 }]}>
        <View style={{ flex: 1 }}>
          <Text style={[s.inboxType, { color: C.blue }]}>BOUNTY</Text>
          <Text style={s.inboxFrom}>from {shortId(event.from_agent)}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[s.inboxSlot, { color: C.green }]}>+${event.amount_usdc.toFixed(2)}</Text>
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
  const outcomeColor = entry.outcome === 'ok' ? C.green
    : entry.outcome === 'disabled' || entry.outcome === 'denied' ? C.sub
      : entry.outcome === 'rate_limited' ? C.amber
        : C.red;
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

function SkillsSubtab() {
  const { skills, loading, refresh } = useSkills();
  const [installing, setInstalling] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [urlName, setUrlName] = useState('');
  const [urlValue, setUrlValue] = useState('');

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

  return (
    <ScrollView style={s.subtabRoot} contentContainerStyle={s.subtabContent}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={s.sectionLabel}>INSTALLED SKILLS</Text>
        <TouchableOpacity onPress={refresh} disabled={loading}>
          <Text style={{ fontSize: 9, color: C.sub, fontFamily: 'monospace', letterSpacing: 2 }}>
            {loading ? '…' : 'REFRESH'}
          </Text>
        </TouchableOpacity>
      </View>
      <View style={s.card}>
        {loading && skills.length === 0 ? (
          <ActivityIndicator color={C.green} style={{ marginVertical: 16 }} />
        ) : skills.length === 0 ? (
          <Text style={s.noData}>No skills installed</Text>
        ) : (
          skills.map((skill, i) => (
            <View key={skill.name} style={[s.skillRow, i === skills.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={s.skillDot} />
              <Text style={s.skillName}>{skill.name}</Text>
              <TouchableOpacity
                style={[s.removeBtn, removing === skill.name && { opacity: 0.4 }]}
                onPress={() => handleRemove(skill)}
                disabled={removing === skill.name}
                activeOpacity={0.7}
              >
                <Text style={s.removeBtnText}>{removing === skill.name ? '…' : 'REMOVE'}</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>

      <Text style={s.sectionLabel}>INSTALL FROM URL</Text>
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
          placeholderTextColor={C.sub}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={[s.fieldLabel, { marginTop: 10 }]}>URL</Text>
        <TextInput
          style={s.skillInput}
          value={urlValue}
          onChangeText={setUrlValue}
          placeholder="https://…/SKILL.toml"
          placeholderTextColor={C.sub}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={[s.btn, { marginTop: 14, backgroundColor: C.green }, !canInstall && { opacity: 0.4 }]}
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
  const [subtab, setSubtab] = useState<Subtab>('agents');

  return (
    <View style={s.root}>
      <NodeStatusBanner />
      <View style={s.header}>
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
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 0, borderBottomWidth: 1, borderBottomColor: C.border },
  title: { fontSize: 13, fontWeight: '700', color: C.text, letterSpacing: 3, fontFamily: 'monospace', marginBottom: 14 },
  tabs: { flexDirection: 'row' },
  tab: { paddingVertical: 10, paddingHorizontal: 20, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: C.green },
  tabText: { fontSize: 11, color: C.sub, letterSpacing: 2, fontWeight: '700', fontFamily: 'monospace' },
  tabTextActive: { color: C.green },
  subtabRoot: { flex: 1 },
  subtabContent: { padding: 20 },
  sectionLabel: { fontSize: 11, color: C.sub, letterSpacing: 3, marginBottom: 10, marginTop: 20 },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 16, marginBottom: 4 },
  hint: { fontSize: 11, color: C.sub, fontFamily: 'monospace', lineHeight: 18, marginTop: 20, textAlign: 'center' },
  // agent card
  agentCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 14, marginBottom: 8 },
  agentCardRow: { flexDirection: 'row', alignItems: 'center' },
  agentCardInfo: { flex: 1 },
  agentCardName: { fontSize: 14, fontWeight: '700', color: C.text, fontFamily: 'monospace' },
  agentCardId: { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginTop: 2 },
  agentCardStats: { flexDirection: 'row', alignItems: 'center', marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.border },
  agentScore: { fontSize: 16, fontWeight: '700', fontFamily: 'monospace' },
  agentScoreLabel: { fontSize: 10, color: C.sub },
  agentDot: { color: C.sub, marginHorizontal: 4 },
  agentTrend: { fontSize: 11, fontFamily: 'monospace' },
  modeBadge: { borderRadius: 3, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1 },
  badgeLocal: { backgroundColor: '#00e67615', borderColor: '#00e67640' },
  badgeHosted: { backgroundColor: '#ffc10715', borderColor: '#ffc10740' },
  badgeLinked: { backgroundColor: '#2979ff15', borderColor: '#2979ff40' },
  modeBadgeText: { fontSize: 9, fontWeight: '700', letterSpacing: 2 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  agentCardOwner: { fontSize: 9, color: C.blue, fontFamily: 'monospace', marginTop: 2 },
  // node subtab
  identityRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  agentName: { fontSize: 16, fontWeight: '700', color: C.text, fontFamily: 'monospace' },
  agentId: { fontSize: 11, color: C.sub, fontFamily: 'monospace', marginTop: 2 },
  btn: { borderRadius: 4, paddingVertical: 12, alignItems: 'center' },
  btnText: { fontSize: 12, fontWeight: '700', letterSpacing: 3 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  statCard: { flex: 1, minWidth: '45%', backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 12 },
  statVal: { fontSize: 24, fontWeight: '700', color: C.text, fontFamily: 'monospace' },
  statLabel: { fontSize: 10, color: C.sub, letterSpacing: 2, marginTop: 4 },
  noData: { color: C.sub, fontFamily: 'monospace', letterSpacing: 1 },
  inboxRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  inboxType: { fontSize: 12, fontWeight: '700', color: C.green, fontFamily: 'monospace' },
  inboxFrom: { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginTop: 2 },
  inboxSlot: { fontSize: 10, color: C.sub, fontFamily: 'monospace' },
  hostedBanner: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.green + '40', borderRadius: 4, padding: 14, marginBottom: 4 },
  hostedLabel: { fontSize: 9, color: C.green, letterSpacing: 3, fontWeight: '700' },
  hostedHost: { fontSize: 13, color: C.text, fontFamily: 'monospace', marginTop: 2 },
  disconnectBtn: { borderWidth: 1, borderColor: C.red + '60', borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4 },
  disconnectText: { fontSize: 9, color: C.red, letterSpacing: 2, fontWeight: '700' },
  barsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  bar: { width: 4, borderRadius: 1 },
  signalNull: { fontSize: 14, color: C.sub },
  // hot wallet / portfolio
  hotWalletRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hotBalance: { fontSize: 18, fontWeight: '700', color: C.amber, fontFamily: 'monospace' },
  hotBalanceSol: { fontSize: 18, fontWeight: '700', color: '#B351DF', fontFamily: 'monospace' },
  hotAddr: { fontSize: 9, color: C.sub, fontFamily: 'monospace' },
  sweepTx: { fontSize: 9, color: C.green, fontFamily: 'monospace', marginTop: 8 },
  // link agent
  linkBtn: { borderWidth: 1, borderColor: C.border, borderRadius: 4, padding: 14, alignItems: 'center', marginTop: 12 },
  linkBtnText: { fontSize: 11, color: C.sub, letterSpacing: 2, fontFamily: 'monospace' },
  linkSection: { marginTop: 12 },
  linkHint: { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginBottom: 10 },
  linkInputRow: { flexDirection: 'row', gap: 8 },
  linkInput: { flex: 1, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 8, color: C.text, fontFamily: 'monospace', fontSize: 12 },
  lookupBtn: { backgroundColor: C.blue, borderRadius: 4, paddingHorizontal: 14, justifyContent: 'center', alignItems: 'center', minWidth: 80 },
  lookupBtnDisabled: { opacity: 0.5 },
  lookupBtnText: { fontSize: 10, fontWeight: '700', color: '#fff', letterSpacing: 2 },
  linkError: { fontSize: 10, color: C.red, fontFamily: 'monospace', marginTop: 8 },
  previewBox: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: C.border },
  previewRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  previewLabel: { fontSize: 10, color: C.sub, fontFamily: 'monospace', letterSpacing: 2 },
  previewVal: { fontSize: 11, color: C.text, fontFamily: 'monospace' },
  previewPending: { fontSize: 10, color: C.amber, fontFamily: 'monospace', marginBottom: 6 },
  confirmBtn: { backgroundColor: C.blue, borderRadius: 4, paddingVertical: 10, alignItems: 'center', marginTop: 10 },
  confirmBtnText: { fontSize: 11, fontWeight: '700', color: '#fff', letterSpacing: 2 },
  cancelLink: { alignItems: 'center', paddingVertical: 10 },
  cancelLinkText: { fontSize: 10, color: C.sub, fontFamily: 'monospace' },
  // multi-agent picker
  pickerBox: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: C.border },
  pickerHint: { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginBottom: 8 },
  pickerRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 8, borderRadius: 4, marginBottom: 4, borderWidth: 1, borderColor: C.border },
  pickerRowSelected: { borderColor: C.blue, backgroundColor: '#2979ff15' },
  pickerRadio: { width: 12, height: 12, borderRadius: 6, borderWidth: 1, borderColor: C.sub, marginRight: 10 },
  pickerRadioSelected: { borderColor: C.blue, backgroundColor: C.blue },
  pickerName: { fontSize: 11, color: C.text, fontFamily: 'monospace', fontWeight: '700' },
  pickerAgentId: { fontSize: 9, color: C.sub, fontFamily: 'monospace', marginTop: 2 },
  // portfolio total
  totalUsdRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 12, marginBottom: 4, borderBottomWidth: 1, borderBottomColor: C.border },
  totalUsdLabel: { fontSize: 9, color: C.sub, letterSpacing: 3, fontFamily: 'monospace' },
  totalUsdValue: { fontSize: 20, fontWeight: '700', color: C.green, fontFamily: 'monospace' },
  // skills
  skillRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border, gap: 10 },
  skillDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.green },
  skillName: { flex: 1, fontSize: 13, color: C.text, fontFamily: 'monospace' },
  removeBtn: { borderWidth: 1, borderColor: C.red + '60', borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4 },
  removeBtnText: { fontSize: 9, color: C.red, letterSpacing: 2, fontWeight: '700', fontFamily: 'monospace' },
  fieldLabel: { fontSize: 9, color: C.sub, letterSpacing: 2, fontFamily: 'monospace', marginBottom: 6 },
  skillInput: { backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 8, color: C.text, fontFamily: 'monospace', fontSize: 13 },
  // negotiation cards
  negCard: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border },
  negHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  negBadge: { borderRadius: 3, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2 },
  negBadgeText: { fontSize: 9, fontWeight: '700', letterSpacing: 2 },
  negParty: { flex: 1, fontSize: 11, color: C.text, fontFamily: 'monospace' },
  negAmount: { fontSize: 11, color: C.amber, fontFamily: 'monospace', fontWeight: '700' },
  negChevron: { fontSize: 10, color: C.sub, marginLeft: 4 },
  negConvId: { fontSize: 9, color: C.sub, fontFamily: 'monospace', marginBottom: 2 },
  negTimeline: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.border },
  negTimelineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  negDot: { width: 8, height: 8, borderRadius: 4, marginTop: 3 },
  negTimelineType: { fontSize: 11, fontWeight: '700', fontFamily: 'monospace' },
  negTimelineMsg: { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginTop: 2 },
});
