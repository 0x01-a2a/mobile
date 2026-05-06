/**
 * Chat — interactive chat with the ZeroClaw agent brain.
 *
 * When navigated from Inbox with task params, shows task context in Chat mode.
 * Agent selector pills are shown when the user owns more than one agent.
 */
import { useTheme, ThemeColors } from '../theme/ThemeContext';
import { useSafeAreaInsets, SafeAreaView } from 'react-native-safe-area-context';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Clipboard from '@react-native-clipboard/clipboard';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Image,
} from 'react-native';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { launchCamera, launchImageLibrary } from 'react-native-image-picker';
import { useZeroclawChat, ChatMessage } from '../hooks/useZeroclawChat';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { useTTS } from '../hooks/useTTS';
import { useRecorder, usePlayer, generateTTSFile, formatDuration, concatPodcastOnDevice } from '../hooks/useAudioBubble';
import { NodeModule } from '../native/NodeModule';
import { useOwnedAgents, OwnedAgent } from '../hooks/useOwnedAgents';
import { useBlobs } from '../hooks/useBlobs';
import { sendEnvelope, setBagsApiKey } from '../hooks/useNodeApi';
import { useNode } from '../hooks/useNode';
import { useAgentBrain } from '../hooks/useAgentBrain';
import { ChatActionCard } from '../components/ChatActionCard';
import { useLayout } from '../hooks/useLayout';
import { useTranslation } from 'react-i18next';
export interface BountyTask {
  description: string;
  reward: string;
  fromAgent: string;
}

const TASK_LOG_KEY = 'zerox1:task_log';

/**
 * Strip characters that could be used for prompt injection from bounty content
 * before passing it to the LLM as part of the task context (H-1).
 * Control characters and repeated newlines are removed; length is capped.
 */
function sanitizeForPrompt(text: string, maxLen = 500): string {
  return String(text)
    .slice(0, maxLen * 2) // pre-cap before expensive regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') // strip control chars
    .replace(/\n{3,}/g, '\n\n')                          // collapse excess newlines
    .trim()
    .slice(0, maxLen);
}

async function markTaskDelivered(conversationId: string) {
  try {
    const raw = await AsyncStorage.getItem(TASK_LOG_KEY);
    if (!raw) return;
    const log = JSON.parse(raw);
    const updated = log.map((t: any) =>
      t.conversationId === conversationId && t.status === 'active'
        ? { ...t, status: 'delivered' }
        : t,
    );
    await AsyncStorage.setItem(TASK_LOG_KEY, JSON.stringify(updated));
  } catch { /* silently ignore */ }
}

async function markTaskAbandoned(conversationId: string) {
  try {
    const raw = await AsyncStorage.getItem(TASK_LOG_KEY);
    if (!raw) return;
    const log = JSON.parse(raw);
    const updated = log.filter((t: any) => t.conversationId !== conversationId);
    await AsyncStorage.setItem(TASK_LOG_KEY, JSON.stringify(updated));
  } catch { /* silently ignore */ }
}



// ── Types ─────────────────────────────────────────────────────────────────

interface ChatRouteParams {
  agentId?: string;
  conversationId?: string;
  task?: BountyTask;
  initialMode?: 'chat' | 'brief' | 'deliver';
}

// ── Agent selector pills ──────────────────────────────────────────────────

function AgentSelector({
  agents,
  selectedId,
  onSelect,
}: {
  agents: OwnedAgent[];
  selectedId: string;
  onSelect: (a: OwnedAgent) => void;
}) {
  const { colors } = useTheme();
  const s = useStyles(colors);
  if (agents.length <= 1) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={s.agentBar}
      contentContainerStyle={s.agentBarContent}
    >
      {agents.map(a => {
        const active = a.id === selectedId;
        return (
          <TouchableOpacity
            key={a.id || a.mode}
            style={[s.agentPill, active && s.agentPillActive]}
            onPress={() => onSelect(a)}
            activeOpacity={0.7}
          >
            <Text style={[s.agentPillText, active && s.agentPillTextActive]}>
              {a.name}
            </Text>
            <Text style={[s.agentPillBadge, { color: a.mode === 'local' ? colors.green : colors.amber }]}>
              {a.mode === 'local' ? ' [L]' : ' [H]'}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ── Launch result detection ───────────────────────────────────────────────

interface LaunchResult {
  token_mint: string;
  txid?: string;
  name?: string;
  symbol?: string;
}

function tryParseLaunchResult(text: string): LaunchResult | null {
  // Find all {...} spans that contain "token_mint" and try to parse them.
  const idx = text.indexOf('"token_mint"');
  if (idx === -1) return null;
  // Walk backwards to find the opening brace.
  for (let start = idx - 1; start >= 0; start--) {
    if (text[start] !== '{') continue;
    // Walk forwards to find the matching closing brace.
    let depth = 0;
    for (let end = start; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}') { depth--; if (depth === 0) {
        try {
          const obj = JSON.parse(text.slice(start, end + 1));
          if (typeof obj.token_mint === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(obj.token_mint)) return obj as LaunchResult;
        } catch { /* not valid JSON, keep searching */ }
      }}
    }
  }
  return null;
}

// ── Launch result card ────────────────────────────────────────────────────

function LaunchResultCard({ result }: { result: LaunchResult }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const s = useStyles(colors);
  const shortMint = result.token_mint.length > 20
    ? `${result.token_mint.slice(0, 8)}…${result.token_mint.slice(-6)}`
    : result.token_mint;
  const shortTxid = result.txid && result.txid.length > 20
    ? `${result.txid.slice(0, 8)}…${result.txid.slice(-6)}`
    : result.txid;
  return (
    <View style={s.launchCard}>
      <Text style={s.launchCardLabel}>{t('chat.tokenLaunched')}</Text>
      {(result.name || result.symbol) && (
        <Text style={s.launchCardName}>
          {result.name ?? ''}{result.symbol ? ` (${result.symbol})` : ''}
        </Text>
      )}
      <Text style={s.launchCardField}>{t('chat.mintLabel')}</Text>
      <Text style={s.launchCardValue} selectable>{shortMint}</Text>
      {shortTxid && (
        <>
          <Text style={s.launchCardField}>{t('chat.txLabel')}</Text>
          <Text style={s.launchCardValue} selectable>{shortTxid}</Text>
        </>
      )}
    </View>
  );
}

// ── Podcast result detection ─────────────────────────────────────────────

interface PodcastResult {
  episode_id: string;
  audio_url: string;
  duration_secs: number;
  title: string;
}

function tryParsePodcastResult(text: string): PodcastResult | null {
  const idx = text.indexOf('"episode_id"');
  if (idx === -1) return null;
  for (let start = idx - 1; start >= 0; start--) {
    if (text[start] !== '{') continue;
    let depth = 0;
    for (let end = start; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}') { depth--; if (depth === 0) {
        try {
          const obj = JSON.parse(text.slice(start, end + 1));
          if (typeof obj.episode_id === 'string' && typeof obj.audio_url === 'string') return obj as PodcastResult;
        } catch { /* keep searching */ }
      }}
    }
  }
  return null;
}

function PodcastResultCard({ result, player }: { result: PodcastResult; player: { playing: boolean; play: (uri: string) => Promise<void>; stop: () => Promise<void> } }) {
  const { colors } = useTheme();
  const { config: brain } = useAgentBrain();
  const { config: nodeConfig } = useNode();
  const agentName = nodeConfig?.agentName;
  const tokenAddress = brain?.tokenAddress;
  const [clipping, setClipping] = useState(false);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const mins = Math.floor(result.duration_secs / 60);
  const secs = result.duration_secs % 60;

  const handleMakeClip = useCallback(async () => {
    setClipping(true);
    try {
      // If audio is a local file, upload it to blob storage first
      let episodeId = result.episode_id;
      if (result.audio_url.startsWith('file://')) {
        // Upload MP3 to aggregator blobs
        const localPath = result.audio_url.replace('file://', '');
        const uploadResp = await fetch('http://127.0.0.1:9090/podcast/upload-for-clip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_path: localPath, episode_id: episodeId }),
          signal: AbortSignal.timeout(30000),
        });
        if (!uploadResp.ok) {
          // Fallback: share just the MP3 for manual video creation
          Alert.alert(
            'Video clips require premium',
            'Upgrade to premium to generate TikTok-ready video clips with backgrounds and captions. For now, share the MP3 and add visuals in CapCut.',
            [{ text: 'OK' }],
          );
          setClipping(false);
          return;
        }
      }

      const clipDuration = Math.min(60, result.duration_secs);
      const resp = await fetch('https://api.0x01.world/podcast/clip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Id': '' },
        body: JSON.stringify({
          episode_id: episodeId,
          start_secs: 0,
          end_secs: clipDuration,
          background: 'particles',
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (resp.ok) {
        const data = await resp.json();
        setClipUrl(data.clip_url);
      } else {
        Alert.alert('Clip failed', 'Could not generate video clip. Try again later.');
      }
    } catch {
      Alert.alert('Clip failed', 'Network error. Check your connection.');
    }
    setClipping(false);
  }, [result]);

  return (
    <ChatActionCard
      icon="🎙"
      accentColor={colors.green}
      title={result.title}
      subtitle={`${mins}:${secs.toString().padStart(2, '0')} episode`}
      buttons={[
        {
          label: player.playing ? '◼ Stop' : '▶ Play',
          onPress: () => player.playing ? player.stop() : player.play(result.audio_url),
          variant: 'primary',
        },
        {
          label: '↗ Share MP3',
          onPress: () => {
            const caption = `${result.title}\n\nMade with 01 Pilot${tokenAddress ? `\nToken: ${tokenAddress}` : ''}\n\n#01Pilot #AIPodcast`;
            Share.share(Platform.OS === 'ios'
              ? { url: result.audio_url, message: caption }
              : { message: `${caption}\n${result.audio_url}` }
            );
          },
          variant: 'secondary',
        },
        ...(clipUrl ? [{
          label: '↗ Share TikTok Video',
          onPress: () => {
            const caption = `${result.title}${agentName ? ` by ${agentName}` : ''}\n\nMade with 01 Pilot — talk to your AI, make a podcast${tokenAddress ? `\n\nSupport: ${tokenAddress}` : ''}\n\n#01Pilot #AIPodcast #podcast`;
            Share.share(Platform.OS === 'ios'
              ? { url: clipUrl, message: caption }
              : { message: `${caption}\n${clipUrl}` }
            );
          },
          variant: 'secondary' as const,
        }] : [{
          label: clipping ? 'Generating video...' : '🎬 Make TikTok Clip',
          onPress: handleMakeClip,
          loading: clipping,
          disabled: clipping,
          variant: 'ghost' as const,
        }]),
      ]}
    />
  );
}

// ── Podcast produce trigger detection ─────────────────────────────────────

/** Detect if agent message is suggesting podcast production. */
function isPodcastProduceTrigger(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    (lower.includes('produce') || lower.includes('make') || lower.includes('create')) &&
    (lower.includes('podcast') || lower.includes('episode')) &&
    !lower.includes('"episode_id"') // not an already-produced result
  );
}

function ProducePodcastCard({
  audioMap,
  messages,
  onProduced,
}: {
  audioMap: Map<string, { uri: string; durationMs: number }>;
  messages: ChatMessage[];
  onProduced: (result: { uri: string; durationMs: number; title: string }) => void;
}) {
  const { colors } = useTheme();
  const [producing, setProducing] = useState(false);
  const [title, setTitle] = useState('');

  // Collect all audio URIs in order from the conversation
  const audioUris = messages
    .map(m => audioMap.get(m.id)?.uri)
    .filter((uri): uri is string => !!uri && uri.length > 0);

  const totalDurationMs = messages
    .map(m => audioMap.get(m.id)?.durationMs ?? 0)
    .reduce((a, b) => a + b, 0);

  const handleProduce = async () => {
    if (audioUris.length === 0) return;
    setProducing(true);
    try {
      const auth = await NodeModule.getLocalAuthConfig();
      const result = await concatPodcastOnDevice(
        audioUris,
        title || 'Untitled Episode',
        auth?.nodeApiToken ?? null,
      );
      if (result && result.uri) {
        onProduced({
          uri: result.uri,
          durationMs: result.durationMs || totalDurationMs,
          title: title || 'Untitled Episode',
        });
      }
    } catch { /* production failed */ }
    setProducing(false);
  };

  if (audioUris.length === 0) {
    return (
      <ChatActionCard
        icon="🎙"
        accentColor={colors.sub}
        title="No voice messages yet"
        description="Record a voice conversation first, then produce your episode."
        buttons={[]}
      />
    );
  }

  return (
    <ChatActionCard
      icon="🎙"
      accentColor={colors.green}
      title="Produce Episode"
      subtitle={`${audioUris.length} voice segments · ${formatDuration(totalDurationMs)}`}
      buttons={[
        {
          label: producing ? 'Producing...' : 'Produce MP3',
          onPress: handleProduce,
          loading: producing,
          disabled: producing,
          variant: 'primary',
        },
      ]}
    />
  );
}

// ── MoltBook claim card ───────────────────────────────────────────────────

function MoltbookClaimCard({
  claim,
  onDismiss,
}: {
  claim: NonNullable<import('../hooks/useAgentBrain').AgentBrainConfig['moltbookPendingClaim']>;
  onDismiss: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState('');

  const handleVerifyEmail = () => {
    if (claim.claimUrl) Linking.openURL(claim.claimUrl);
  };

  const handleTweetClaim = () => {
    const text = encodeURIComponent(claim.tweetTemplate);
    Linking.openURL(`https://x.com/intent/tweet?text=${text}`);
  };

  const handleCheckStatus = async () => {
    setChecking(true);
    setCheckMsg('');
    try {
      const resp = await fetch('https://www.moltbook.com/api/v1/agents/me', {
        headers: { Authorization: `Bearer ${claim.apiKey}` },
      });
      const data = await resp.json();
      if (data?.agent?.is_claimed || data?.is_claimed) {
        onDismiss();
      } else {
        setCheckMsg('Not claimed yet — complete both steps above and try again.');
      }
    } catch {
      setCheckMsg('Could not reach MoltBook — check your connection.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <ChatActionCard
      icon="🦞"
      title="Activate MoltBook"
      subtitle={`Registered as @${claim.registeredName} — 2 steps to go`}
      description="MoltBook requires a human to verify ownership before your agent can post. It takes about 60 seconds."
      steps={[
        {
          label: 'Verify email',
          detail: 'Opens moltbook.com — enter your email to claim the account',
          onPress: handleVerifyEmail,
        },
        {
          label: 'Post claim tweet',
          detail: 'Opens X with a pre-written verification tweet — just post it',
          onPress: handleTweetClaim,
        },
      ]}
      buttons={[
        {
          label: checking ? 'Checking…' : 'Done — confirm activation',
          onPress: handleCheckStatus,
          loading: checking,
          variant: 'primary',
        },
      ]}
      statusMessage={checkMsg}
      statusType="error"
      onDismiss={onDismiss}
    />
  );
}

// ── Message bubble ────────────────────────────────────────────────────────

function VoiceBubble({ msg, player }: { msg: ChatMessage; player: { playing: boolean; currentMs: number; play: (uri: string) => Promise<void>; stop: () => Promise<void> } }) {
  const { colors } = useTheme();
  const isUser = msg.role === 'user';
  const duration = formatDuration(msg.audioDurationMs ?? 0);

  const handleTap = useCallback(() => {
    if (player.playing) {
      player.stop();
    } else if (msg.audioUri) {
      player.play(msg.audioUri);
    }
  }, [msg.audioUri, player]);

  return (
    <TouchableOpacity
      onPress={handleTap}
      activeOpacity={0.7}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingHorizontal: 12, paddingVertical: 10,
        backgroundColor: isUser ? colors.text : colors.card,
        borderRadius: 18, minWidth: 120,
        borderWidth: isUser ? 0 : 1, borderColor: colors.border,
      }}
      accessibilityLabel={player.playing ? 'Stop playing voice message' : 'Play voice message'}
      accessibilityRole="button"
    >
      <Text style={{ fontSize: 16, color: isUser ? colors.bg : colors.green }}>
        {player.playing ? '◼' : '▶'}
      </Text>
      {/* Waveform placeholder — simple bars */}
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 1.5, height: 20 }}>
        {Array.from({ length: 16 }, (_, i) => (
          <View key={i} style={{
            width: 2.5, borderRadius: 1,
            height: 6 + Math.sin(i * 0.8 + (msg.ts % 10)) * 8,
            backgroundColor: isUser ? colors.bg + '80' : colors.sub + '60',
          }} />
        ))}
      </View>
      <Text style={{ fontSize: 11, color: isUser ? colors.bg + 'cc' : colors.sub }}>
        {duration}
      </Text>
    </TouchableOpacity>
  );
}

function Bubble({ msg, agentName, tts, player }: { msg: ChatMessage; agentName: string; tts: { speaking: boolean; speak: (t: string) => void; stop: () => void }; player: { playing: boolean; currentMs: number; play: (uri: string) => Promise<void>; stop: () => Promise<void> } }) {
  const { colors } = useTheme();
  const { isTablet } = useLayout();
  const { t } = useTranslation();
  const s = useStyles(colors, isTablet);
  const isSystem = msg.role === 'system';
  if (isSystem) {
    return (
      <View style={s.bubbleSystemRow}>
        <Text style={s.bubbleSystemText}>{msg.text}</Text>
      </View>
    );
  }

  const isUser = msg.role === 'user';
  const hasAudio = !!msg.audioUri;
  const launchResult = !isUser ? tryParseLaunchResult(msg.text) : null;
  const podcastResult = !isUser ? tryParsePodcastResult(msg.text) : null;
  const displayText = (launchResult || podcastResult)
    ? msg.text.replace(/\{[^{}]*"(token_mint|episode_id)"[^{}]*\}/g, '').trim()
    : msg.text;

  const handleLongPress = useCallback(() => {
    if (!displayText) return;
    Clipboard.setString(displayText);
    Alert.alert('Copied', undefined, [{ text: 'OK' }], { cancelable: true });
  }, [displayText]);

  // Voice bubble — show waveform-style audio player
  if (hasAudio) {
    return (
      <View style={[s.bubbleRow, isUser ? s.rowRight : s.rowLeft]}>
        {!isUser && <Text style={s.roleLabel}>{agentName}</Text>}
        <VoiceBubble msg={msg} player={player} />
        {isUser && <Text style={s.roleLabel}>{t('chat.roleYou')}</Text>}
      </View>
    );
  }

  // Text bubble (original)
  return (
    <View style={[s.bubbleRow, isUser ? s.rowRight : s.rowLeft]}>
      {!isUser && <Text style={s.roleLabel}>{agentName}</Text>}
      <TouchableOpacity
        activeOpacity={0.85}
        onLongPress={handleLongPress}
        delayLongPress={400}
        style={[s.bubble, isUser ? s.bubbleUser : s.bubbleAgent]}
      >
        {msg.imageUri ? (
          <Image
            source={{ uri: msg.imageUri }}
            style={s.bubbleThumb}
            resizeMode="cover"
          />
        ) : null}
        {displayText ? (
          <Text style={[s.bubbleText, isUser ? s.bubbleTextUser : undefined]}>
            {displayText}
          </Text>
        ) : null}
        {launchResult ? <LaunchResultCard result={launchResult} /> : null}
        {podcastResult ? <PodcastResultCard result={podcastResult} player={player} /> : null}
      </TouchableOpacity>
      {isUser && <Text style={s.roleLabel}>{t('chat.roleYou')}</Text>}
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────

// Hosted mode: limit inline image data to 150 KB to stay within MAX_MESSAGE_SIZE.
const MAX_INLINE_BYTES = 150 * 1024;

// ── Task entry type (mirrors Earn storage format) ─────────────────────────
interface TaskEntry {
  conversationId: string;
  description: string;
  reward: string;
  fromAgent: string;
  status: 'active' | 'delivered' | 'completed';
}

export function ChatScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { isTablet, contentHPad } = useLayout();
  const { t } = useTranslation();
  const s = useStyles(colors, isTablet);
  const route = useRoute();
  const navigation = useNavigation<any>();
  const params = (route.params ?? {}) as ChatRouteParams;
  const { config, status: nodeStatus, loading: nodeLoading } = useNode();
  const { config: brain, save: saveBrain } = useAgentBrain();
  const tts = useTTS();
  const audioRecorder = useRecorder();
  const audioPlayer = usePlayer();

  const agents = useOwnedAgents().filter(a => a.mode !== 'linked');
  const [selectedAgentId, setSelectedAgentId] = useState<string>(
    params.agentId ?? agents[0]?.id ?? '',
  );

  const [mode, setMode] = useState<'chat' | 'brief' | 'deliver'>(
    params.initialMode ?? 'chat',
  );
  const [briefText, setBriefText] = useState('');
  const [deliverText, setDeliverText] = useState('');

  // Active task conversations — loaded from AsyncStorage on focus.
  const [activeTasks, setActiveTasks] = useState<TaskEntry[]>([]);
  const [selectedConvId, setSelectedConvId] = useState<string | undefined>(
    params.conversationId,
  );
  // Derive current BountyTask from selected entry or nav params.
  const selectedEntry = activeTasks.find(t => t.conversationId === selectedConvId);
  const activeTask: BountyTask | undefined = selectedEntry
    ? { description: selectedEntry.description, reward: selectedEntry.reward, fromAgent: selectedEntry.fromAgent }
    : params.task;

  // Reload task log whenever the screen comes into focus.
  useFocusEffect(useCallback(() => {
    AsyncStorage.getItem(TASK_LOG_KEY).then(raw => {
      if (!raw) return;
      try {
        const log: any[] = JSON.parse(raw);
        const entries: TaskEntry[] = log.filter(
          t => (t.status === 'active' || t.status === 'delivered') && t.conversationId && t.description,
        );
        setActiveTasks(entries);
        // If navigated with a conversationId, select it; otherwise keep current or pick first.
        if (params.conversationId) {
          setSelectedConvId(params.conversationId);
        } else if (!selectedConvId && entries.length > 0) {
          setSelectedConvId(entries[0].conversationId);
        }
      } catch {}
    });
  }, [params.conversationId])); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep selectedAgentId in sync when agents load or params change.
  useEffect(() => {
    if (params.agentId) {
      setSelectedAgentId(params.agentId);
    } else if (!selectedAgentId && agents.length > 0) {
      setSelectedAgentId(agents[0].id);
    }
  }, [params.agentId, agents, selectedAgentId]);

  // Session scoped by agentId + conversationId so each bounty has its own LLM context.
  const { messages, loading, error, send, resetSession, injectSystemMessage, prewarm } = useZeroclawChat(selectedAgentId, selectedConvId);
  const { upload, uploading, error: uploadError } = useBlobs();
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList>(null);

  // Voice input — records audio + STT simultaneously.
  // On stop: sends as a voice bubble (audio file + transcribed text).
  const voicePendingSend = useRef(false);
  const pendingAudioRef = useRef<{ uri: string; durationMs: number } | null>(null);
  const voice = useVoiceInput((text) => {
    if (text.trim()) {
      setDraft(text);
      voicePendingSend.current = true;
    }
  });
  // Show live transcript while speaking.
  useEffect(() => {
    if (voice.listening && voice.transcript) {
      setDraft(voice.transcript);
    }
  }, [voice.listening, voice.transcript]);
  // Auto-send after voice stops and final transcript is in draft.
  useEffect(() => {
    if (!voice.listening && voicePendingSend.current && draft.trim()) {
      voicePendingSend.current = false;
      handleSendRef.current();
    }
  }, [voice.listening, draft]);

  // Wrap voice.toggle to also start/stop audio recording.
  const handleVoiceToggle = useCallback(async () => {
    if (voice.listening) {
      // Stop both STT and audio recording
      const result = await audioRecorder.stop();
      if (result) {
        pendingAudioRef.current = result;
      }
      await voice.stop();
    } else {
      // Start both STT and audio recording
      pendingAudioRef.current = null;
      await audioRecorder.start();
      await voice.start();
    }
  }, [voice, audioRecorder]);

  // Voice message audio metadata — keyed by message ID.
  // Populated after send (user recordings) and after agent response (TTS generation).
  const [audioMap, setAudioMap] = useState<Map<string, { uri: string; durationMs: number }>>(new Map());
  const bridgeTokenRef = useRef<string | null>(null);
  useEffect(() => {
    NodeModule.getLocalAuthConfig()
      .then((auth: any) => { bridgeTokenRef.current = auth?.phoneBridgeToken ?? auth?.gatewayToken ?? null; })
      .catch(() => {});
  }, []);

  // After send: attach recording to the last user message.
  const prevMsgCount = useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevMsgCount.current) {
      const newest = messages[messages.length - 1];
      // User message just sent with pending audio
      if (newest.role === 'user' && pendingAudioRef.current) {
        const audio = pendingAudioRef.current;
        pendingAudioRef.current = null;
        setAudioMap(prev => new Map(prev).set(newest.id, audio));
      }
      // Agent response just arrived — generate TTS audio.
      if (newest.role === 'assistant' && newest.text.length > 10) {
        generateTTSFile(newest.text, bridgeTokenRef.current).then(result => {
          if (result) {
            setAudioMap(prev => new Map(prev).set(newest.id, result));
          }
        });
      }
    }
    prevMsgCount.current = messages.length;
  }, [messages]);

  // Pending image attachment (picked but not yet sent)
  const [pendingImage, setPendingImage] = useState<{ uri: string; base64: string; mime: string } | null>(null);
  const [imagePreviewVisible, setImagePreviewVisible] = useState(false);

  // Bags rate-limit modal state
  const [bagsKeyModalVisible, setBagsKeyModalVisible] = useState(false);
  const [bagsKeyDraft, setBagsKeyDraft] = useState('');
  const [bagsKeySaving, setBagsKeySaving] = useState(false);

  // Text deliver modal state
  const [textDeliverVisible, setTextDeliverVisible] = useState(false);
  const [textDeliverInput, setTextDeliverInput] = useState('');

  // Pre-warm the ZeroClaw gateway URL as soon as the node is running so it is
  // cached before the user sends their first message.
  useEffect(() => {
    if (nodeStatus === 'running') prewarm();
  }, [nodeStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show the Bags API key modal when ZeroClaw signals rate limiting.
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && last.text.includes('[BAGS_RATE_LIMITED]')) {
      setBagsKeyModalVisible(true);
    }
  }, [messages]);

  // Inject task context when a new bounty session starts (messages empty = fresh session).
  const [taskInjected, setTaskInjected] = useState(false);
  useEffect(() => {
    setTaskInjected(false);
  }, [selectedAgentId, selectedConvId]);
  useEffect(() => {
    if (activeTask && !taskInjected && messages.length === 0) {
      setTaskInjected(true);
      send(
        `You have accepted a new task. Task: ${JSON.stringify(sanitizeForPrompt(activeTask.description))}. ` +
        `Reward: ${JSON.stringify(sanitizeForPrompt(activeTask.reward, 80))}. ` +
        `Requester: ${JSON.stringify(sanitizeForPrompt(activeTask.fromAgent, 80))}. ` +
        `Let me know when you are ready to deliver.`,
      );
    }
  }, [activeTask, taskInjected, messages.length, send]);

  useEffect(() => {
    if (messages.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [messages]);

  // Pick an image to attach to the next chat message.
  const pickChatImage = useCallback(async () => {
    const result = await launchImageLibrary({
      mediaType: 'photo',
      includeBase64: true,
      maxWidth: 1024,
      maxHeight: 1024,
      quality: 0.8,
    });
    if (result.didCancel || !result.assets?.[0]) return;
    const asset = result.assets[0];
    if (!asset.base64) { Alert.alert('Error', 'Could not read image data.'); return; }
    setPendingImage({ uri: asset.uri!, base64: asset.base64, mime: asset.type ?? 'image/jpeg' });
    setImagePreviewVisible(true);
  }, []);

  // Discard the pending image (called from preview modal cancel).
  const discardPendingImage = useCallback(() => {
    setImagePreviewVisible(false);
    setPendingImage(null);
  }, []);

  // Confirm image selection from the preview modal — close modal, keep attachment.
  const confirmPendingImage = useCallback(() => {
    setImagePreviewVisible(false);
  }, []);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if ((!text && !pendingImage) || loading) return;
    setDraft('');
    const img = pendingImage;
    setPendingImage(null);
    if (img) {
      // Send immediately with inline base64 so ZeroClaw sees the image regardless
      // of blob-store availability (no reputation gate on the LLM path).
      // Attempt blob upload in the background to get a CID for task delivery — but
      // don't block the chat on it.
      upload(img.base64, img.mime).then(cid => {
        // cid may be null if upload fails (e.g. node not running, rep too low)
        // that's fine — the LLM already received the image inline above
      }).catch(() => {});
      await send(text, { uri: img.uri, base64: img.base64, mime: img.mime });
    } else {
      await send(text);
    }
  }, [draft, pendingImage, loading, send, upload]);
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  const pickAndDeliver = useCallback(async (source: 'camera' | 'gallery') => {
    const isHosted = Boolean(config.nodeApiUrl);

    // In hosted mode compress more aggressively to fit within inline limit.
    const pickerOptions = {
      mediaType: 'photo' as const,
      includeBase64: true,
      maxWidth: isHosted ? 800 : 1920,
      maxHeight: isHosted ? 800 : 1920,
      quality: (isHosted ? 0.5 : 0.8) as 0.5 | 0.8,
    };

    const result = source === 'camera'
      ? await launchCamera(pickerOptions)
      : await launchImageLibrary(pickerOptions);

    if (result.didCancel || !result.assets?.[0]) return;

    const asset = result.assets[0];
    const b64 = asset.base64;
    const mimeType = asset.type ?? 'image/jpeg';

    if (!b64) {
      Alert.alert('Error', 'Could not read image data.');
      return;
    }

    let payload: string;
    try {
      if (isHosted) {
        // Hosted mode: no access to the local signing key, so we can't use the
        // blob store. Inline the image data directly in the DELIVER payload.
        const estimatedBytes = Math.ceil(b64.length * 0.75);
        if (estimatedBytes > MAX_INLINE_BYTES) {
          Alert.alert(
            'Image too large',
            'Hosted mode limits inline delivery to 150 KB. Choose a smaller image.',
          );
          return;
        }
        payload = btoa(JSON.stringify({ inline_data: b64, mime_type: mimeType }));
      } else {
        // Local mode: upload to blob store, deliver the CID.
        const cid = await upload(b64, mimeType);
        if (!cid) return; // error already surfaced via useBlobs error state
        payload = btoa(JSON.stringify({ cid, mime_type: mimeType }));
      }
    } catch {
      Alert.alert('Error', 'Failed to encode delivery payload.');
      return;
    }

    const ok = await sendEnvelope({
      msg_type: 'DELIVER',
      recipient: activeTask?.fromAgent,
      conversation_id: selectedConvId,
      payload_b64: payload,
    });
    if (ok) {
      if (selectedConvId) {
        await markTaskDelivered(selectedConvId);
        setActiveTasks(prev => prev.map(t =>
          t.conversationId === selectedConvId ? { ...t, status: 'delivered' } : t,
        ));
      }
      Alert.alert('Delivered', isHosted
        ? 'Photo sent inline. DELIVER sent — awaiting feedback.'
        : 'Photo uploaded. DELIVER sent — awaiting feedback.',
      );
    } else {
      Alert.alert('Error', 'DELIVER failed. Check your connection and try again.');
    }
  }, [upload, selectedConvId, activeTask, config.nodeApiUrl]);

  const submitTextDeliver = useCallback(async () => {
    const text = textDeliverInput.trim();
    if (!text || !selectedConvId) return;
    setTextDeliverVisible(false);
    setTextDeliverInput('');
    const ok = await sendEnvelope({
      msg_type: 'DELIVER',
      recipient: activeTask?.fromAgent,
      conversation_id: selectedConvId,
      payload_b64: btoa(unescape(encodeURIComponent(JSON.stringify({ text })))),
    });
    if (ok) {
      await markTaskDelivered(selectedConvId);
      setActiveTasks(prev => prev.map(t =>
        t.conversationId === selectedConvId ? { ...t, status: 'delivered' } : t,
      ));
      Alert.alert('Delivered', 'DELIVER sent — awaiting feedback.');
    } else {
      Alert.alert('Error', 'DELIVER failed. Check your connection and try again.');
    }
  }, [textDeliverInput, selectedConvId, activeTask]);

  const handleDeliver = useCallback(() => {
    if (!selectedConvId) return;
    Alert.alert(
      t('chat.deliverTaskTitle'),
      t('chat.deliverTaskHow'),
      [
        { text: t('chat.deliverTextResult'), onPress: () => setTextDeliverVisible(true) },
        { text: t('chat.deliverTakePhoto'), onPress: () => pickAndDeliver('camera') },
        { text: t('chat.deliverFromGallery'), onPress: () => pickAndDeliver('gallery') },
        { text: t('common.cancel'), style: 'cancel' },
      ],
    );
  }, [selectedConvId, pickAndDeliver, t]);

  const handleReject = useCallback(() => {
    if (!selectedConvId) return;
    Alert.alert(
      t('chat.rejectTaskTitle'),
      t('chat.rejectTaskBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('chat.reject'),
          style: 'destructive',
          onPress: async () => {
            await sendEnvelope({
              msg_type: 'REJECT',
              recipient: activeTask?.fromAgent,
              conversation_id: selectedConvId,
              payload_b64: '',
            });
            await markTaskAbandoned(selectedConvId);
            // Remove from local list and switch to next or clear
            setActiveTasks(prev => {
              const remaining = prev.filter(t => t.conversationId !== selectedConvId);
              setSelectedConvId(remaining[0]?.conversationId ?? undefined);
              return remaining;
            });
          },
        },
      ],
    );
  }, [selectedConvId, activeTask, t]);

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={isTablet ? 0 : insets.bottom + 49}
    >
      <View style={[s.chatContainer, { paddingHorizontal: contentHPad }]}>
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + 16 }]}>
        <View style={s.headerLeft}>
          {config.agentAvatar && (
            <Image source={{ uri: config.agentAvatar }} style={s.headerAvatar} />
          )}
          <Text style={s.headerTitle}>{(config.agentName || '01 PILOT').toUpperCase()}</Text>
        </View>
        <View style={s.headerRight}>
          <View style={s.statusDot} />
          <TouchableOpacity onPress={resetSession} style={s.resetBtn} accessibilityLabel={t('chat.newSession')} accessibilityRole="button">
            <Text style={s.resetBtnText}>{t('chat.newSession')}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Agent selector — visible when user owns multiple agents */}
      <AgentSelector
        agents={agents}
        selectedId={selectedAgentId}
        onSelect={a => {
          if (messages.length > 0) {
            Alert.alert(
              'Switch Agent?',
              'This will start a new chat session.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Switch', style: 'destructive', onPress: () => { setSelectedAgentId(a.id); } },
              ],
            );
          } else {
            setSelectedAgentId(a.id);
          }
        }}
      />

      {/* Sticky task context card — pinned below the agent selector when a task is active */}
      {activeTask && (
        <View style={s.stickyTaskCard}>
          <Text style={s.stickyTaskDesc} numberOfLines={2}>
            {activeTask.description}
          </Text>
          {activeTask.reward ? (
            <Text style={s.stickyTaskReward}>
              {activeTask.reward}
            </Text>
          ) : null}
          <Text style={s.stickyTaskStatus}>
            {t('chat.awaitingDelivery')}
          </Text>
        </View>
      )}

      {/* Mode pills */}
      <View style={s.pillRow}>
        {(['chat', 'brief', 'deliver'] as const).map(m => {
          const isActive = mode === m;
          const isDeliver = m === 'deliver';
          const deliverHighlight = isDeliver && activeTask != null;
          return (
            <TouchableOpacity
              key={m}
              testID={`pill-${m}`}
              style={[
                s.pill,
                isActive && s.pillActive,
                !isActive && deliverHighlight && s.pillDeliverHighlight,
              ]}
              onPress={() => setMode(m)}
              accessibilityLabel={`${m.charAt(0).toUpperCase() + m.slice(1)} mode`}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
            >
              <Text style={[
                s.pillText,
                isActive && s.pillTextActive,
                !isActive && deliverHighlight && s.pillTextDeliverHighlight,
              ]}>
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Task switcher — shows all active bounty tasks when there are multiple */}
      {activeTasks.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={s.taskSwitcher}
          contentContainerStyle={s.taskSwitcherContent}
        >
          <TouchableOpacity
            style={[s.taskPill, !selectedConvId && s.taskPillActive]}
            onPress={() => setSelectedConvId(undefined)}
          >
            <Text style={[s.taskPillText, !selectedConvId && s.taskPillTextActive]}>{t('chat.freeChat')}</Text>
          </TouchableOpacity>
          {activeTasks.map(t => {
            const active = t.conversationId === selectedConvId;
            return (
              <TouchableOpacity
                key={t.conversationId}
                style={[s.taskPill, active && s.taskPillActive, t.status === 'delivered' && s.taskPillDelivered]}
                onPress={() => setSelectedConvId(t.conversationId)}
              >
                <Text style={[s.taskPillText, active && s.taskPillTextActive]} numberOfLines={1} ellipsizeMode="tail">
                  {(t.description ?? '').slice(0, 20)}…
                </Text>
                {t.status === 'delivered' && (
                  <Text style={s.taskPillBadge}>✓</Text>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {mode === 'chat' && (
        <>
          {/* Message list */}
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={m => m.id}
            renderItem={({ item }) => {
              const audio = audioMap.get(item.id);
              const enriched = audio ? { ...item, audioUri: audio.uri, audioDurationMs: audio.durationMs } : item;
              const showProduceCard = item.role === 'assistant' && isPodcastProduceTrigger(item.text) && !tryParsePodcastResult(item.text);
              return (
                <>
                  <Bubble msg={enriched} agentName={config.agentName || '01 Pilot'} tts={tts} player={audioPlayer} />
                  {showProduceCard && (
                    <ProducePodcastCard
                      audioMap={audioMap}
                      messages={messages}
                      onProduced={(result) => {
                        // Inject a podcast result message into the chat
                        injectSystemMessage(JSON.stringify({
                          episode_id: Date.now().toString(36),
                          audio_url: result.uri,
                          duration_secs: Math.floor(result.durationMs / 1000),
                          title: result.title,
                        }));
                      }}
                    />
                  )}
                </>
              );
            }}
            contentContainerStyle={s.listContent}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            ListHeaderComponent={brain?.moltbookPendingClaim ? (
              <MoltbookClaimCard
                claim={brain.moltbookPendingClaim}
                onDismiss={() => saveBrain?.({ ...brain, moltbookPendingClaim: undefined })}
              />
            ) : null}
            ListEmptyComponent={
              <View style={s.emptyWrap}>
                <Text style={s.emptyLine}>  _______ ___</Text>
                <Text style={s.emptyLine}> |__  / __| _ \___ __ __</Text>
                <Text style={s.emptyLine}>   / / (__| / / _ \\ V  V /</Text>
                <Text style={s.emptyLine}>  /___\___|_|_\___/ \_/\_/</Text>
                <Text style={s.emptyHint}>{t('chat.agentBrainReady')}</Text>
                <View style={s.suggestionsWrap}>
                  {([
                    { label: t('chat.suggestPodcast'),    prompts: [t('chat.suggestPodcast1'), t('chat.suggestPodcast2')] },
                    { label: t('chat.suggestHealthBody'), prompts: [t('chat.suggestHealth1'), t('chat.suggestHealth2')] },
                    { label: t('chat.suggestSchedule'),   prompts: [t('chat.suggestSchedule1'), t('chat.suggestSchedule2')] },
                    { label: t('chat.suggestTrading'),     prompts: [t('chat.suggestTrading1'), t('chat.suggestTrading2')] },
                    { label: t('chat.suggestMessaging'),   prompts: [t('chat.suggestMessaging1'), t('chat.suggestMessaging2')] },
                    { label: t('chat.suggestLocation'),    prompts: [t('chat.suggestLocation1'), t('chat.suggestLocation2')] },
                    { label: t('chat.suggestVoice'),       prompts: [t('chat.suggestVoice1'), t('chat.suggestVoice2')] },
                  ] as { label: string; prompts: string[] }[]).map(group => (
                    <View key={group.label} style={s.suggestionGroup}>
                      <Text style={s.suggestionGroupLabel}>{group.label}</Text>
                      {group.prompts.map(prompt => (
                        <TouchableOpacity
                          key={prompt}
                          style={s.suggestionChip}
                          onPress={() => setDraft(prompt)}
                          activeOpacity={0.7}
                        >
                          <Text style={s.suggestionText}>{prompt}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ))}
                </View>
              </View>
            }
            ListFooterComponent={
              loading ? (
                <View style={s.thinkingWrap}>
                  <Text style={s.thinkingText}>{t('chat.thinking')}</Text>
                </View>
              ) : null
            }
          />

          {/* Status banner — starting takes priority over errors */}
          {nodeLoading ? (
            <View style={s.startingBanner}>
              <Text style={s.startingText}>starting agent...</Text>
            </View>
          ) : (uploadError || error) ? (
            <View style={s.errorBanner}>
              <Text style={s.errorText}>{uploadError || error}</Text>
              {!uploadError && (
                <Text style={s.errorHint}>
                  {t('chat.enableAgentBrain')}
                </Text>
              )}
            </View>
          ) : null}

          {/* Delivery action bar — visible when an active task is set */}
          {activeTask && (
            <View style={s.deliverBar}>
              <TouchableOpacity
                style={s.deliverBarBtn}
                onPress={() => pickAndDeliver('gallery')}
                accessibilityLabel={t('chat.deliverFromGallery')}
                accessibilityRole="button"
              >
                <Text style={s.deliverBarBtnText}>{t('chat.deliverPhoto')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.deliverBarBtn}
                onPress={() => setTextDeliverVisible(true)}
                accessibilityLabel={t('chat.deliverTextResult')}
                accessibilityRole="button"
              >
                <Text style={s.deliverBarBtnText}>{t('chat.deliverTextBtn')}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Input row */}
          <View style={s.inputWrap}>
            {/* Pending image indicator strip */}
            {pendingImage && !imagePreviewVisible && (
              <View style={s.pendingImageStrip}>
                <Image source={{ uri: pendingImage.uri }} style={s.pendingThumb} resizeMode="cover" />
                <Text style={s.pendingImageLabel}>{t('chat.imageAttached')}</Text>
                <TouchableOpacity onPress={discardPendingImage} style={s.pendingRemoveBtn}>
                  <Text style={s.pendingRemoveText}>✕</Text>
                </TouchableOpacity>
              </View>
            )}
            <View style={s.inputRow}>
              <TouchableOpacity
                style={[s.attachBtn, (loading || nodeStatus !== 'running') && s.sendBtnDisabled]}
                onPress={pickChatImage}
                disabled={loading || nodeStatus !== 'running'}
              >
                <Text style={s.attachBtnText}>📎</Text>
              </TouchableOpacity>
              <TextInput
                style={s.input}
                value={draft}
                onChangeText={setDraft}
                placeholder={voice.listening ? t('chat.listening') : nodeLoading ? 'starting agent...' : t('you.messagePlaceholder', { name: config.agentName || '01 Pilot' })}
                placeholderTextColor={voice.listening ? colors.red : colors.sub}
                multiline
                maxLength={4000}
                onSubmitEditing={handleSend}
                blurOnSubmit={false}
                editable={!loading && !nodeLoading && !voice.listening}
              />
              {/* Send when there's text; mic when empty — like WhatsApp/Telegram */}
              {(draft.trim() || pendingImage) ? (
              <TouchableOpacity
                style={[s.sendBtn, (loading || nodeLoading) && s.sendBtnDisabled]}
                onPress={handleSend}
                disabled={loading || nodeLoading}
                accessibilityLabel="Send message"
                accessibilityRole="button"
              >
                <Text style={s.sendBtnText}>{(loading || nodeLoading) ? '…' : '↑'}</Text>
              </TouchableOpacity>
              ) : voice.available ? (
              <TouchableOpacity
                style={[s.sendBtn, voice.listening && { backgroundColor: colors.red }]}
                onPress={handleVoiceToggle}
                disabled={loading || nodeLoading}
                accessibilityLabel={voice.listening ? 'Stop voice input' : 'Start voice input'}
                accessibilityRole="button"
              >
                <Text style={[s.sendBtnText, voice.listening && { color: colors.bg }]}>{voice.listening ? '◉' : '🎙'}</Text>
              </TouchableOpacity>
              ) : (
              <TouchableOpacity
                style={[s.sendBtn, s.sendBtnDisabled]}
                disabled
              >
                <Text style={s.sendBtnText}>↑</Text>
              </TouchableOpacity>
              )}
            </View>
          </View>
        </>
      )}

      {mode === 'brief' && (
        <View style={s.briefContainer}>
          <TextInput
            style={s.briefInput}
            placeholder={t('you.briefPlaceholder', { name: config.agentName || '01 Pilot' })}
            placeholderTextColor="#9ca3af"
            multiline
            value={briefText}
            onChangeText={setBriefText}
          />
          <TouchableOpacity
            style={s.briefAttachBtn}
            onPress={pickChatImage}
          >
            <Text style={s.briefAttachBtnText}>📎 Attach image</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.briefStartBtn}
            onPress={() => {
              if (!briefText.trim()) return;
              send(briefText.trim());
              setBriefText('');
              setMode('chat');
            }}
          >
            <Text style={s.briefStartBtnText}>Start</Text>
          </TouchableOpacity>
        </View>
      )}

      {mode === 'deliver' && (
        <View style={s.deliverModeContainer}>
          {activeTask && (
            <View style={s.deliverTaskCard}>
              <Text style={s.deliverTaskTitle}>{activeTask.description}</Text>
              <Text style={s.deliverTaskMeta}>{activeTask.reward} · {activeTask.fromAgent}</Text>
            </View>
          )}
          <TextInput
            style={s.deliverModeInput}
            placeholder="Add a delivery note or result summary…"
            placeholderTextColor="#9ca3af"
            multiline
            value={deliverText}
            onChangeText={setDeliverText}
          />
          <View style={s.deliverActions}>
            <TouchableOpacity
              style={s.deliverModeBtn}
              onPress={() => {
                if (deliverText.trim()) {
                  setTextDeliverInput(deliverText.trim());
                  setTextDeliverVisible(true);
                } else {
                  handleDeliver();
                }
                setMode('chat');
                setDeliverText('');
              }}
            >
              <Text style={s.deliverModeBtnText}>{t('chat.deliver')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Bags rate-limit modal */}
      <Modal
        visible={bagsKeyModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setBagsKeyModalVisible(false)}
      >
        <SafeAreaView style={{ flex: 1 }}>
          <View style={s.modalOverlay}>
            <View style={[s.modalCard, { paddingBottom: 32 }]}>
              <Text style={s.modalTitle}>{t('chat.bagsApiKeyRequired')}</Text>
              <Text style={s.modalBody}>{t('chat.bagsApiKeyBody')}</Text>
              <TextInput
                style={s.modalInput}
                value={bagsKeyDraft}
                onChangeText={setBagsKeyDraft}
                placeholder={t('chat.bagsApiKeyPlaceholder')}
                placeholderTextColor={colors.sub}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!bagsKeySaving}
              />
              <View style={s.modalActions}>
                <TouchableOpacity
                  style={[s.modalCancel, { minHeight: 44, justifyContent: 'center' }]}
                  onPress={() => { setBagsKeyModalVisible(false); setBagsKeyDraft(''); }}
                  disabled={bagsKeySaving}
                >
                  <Text style={s.modalCancelText}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.modalSave, { minHeight: 44, justifyContent: 'center' }, (!bagsKeyDraft.trim() || bagsKeySaving) && s.sendBtnDisabled]}
                  disabled={!bagsKeyDraft.trim() || bagsKeySaving}
                  onPress={async () => {
                    setBagsKeySaving(true);
                    try {
                      await setBagsApiKey(bagsKeyDraft.trim());
                      setBagsKeyModalVisible(false);
                      setBagsKeyDraft('');
                      Alert.alert('Saved', 'Bags API key updated. Try your request again.');
                    } catch (e: any) {
                      Alert.alert('Error', e?.message ?? 'Failed to save key.');
                    } finally {
                      setBagsKeySaving(false);
                    }
                  }}
                >
                  <Text style={s.modalSaveText}>{bagsKeySaving ? t('common.loading') : t('common.save')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </SafeAreaView>
      </Modal>

      {/* Text deliver modal */}
      <Modal
        visible={textDeliverVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setTextDeliverVisible(false)}
      >
        <SafeAreaView style={{ flex: 1 }}>
          <View style={s.modalOverlay}>
            <View style={[s.modalCard, { paddingBottom: 32 }]}>
              <Text style={s.modalTitle}>{t('chat.deliverResult')}</Text>
              <TextInput
                style={[s.modalInput, { minHeight: 80, textAlignVertical: 'top' }]}
                value={textDeliverInput}
                onChangeText={setTextDeliverInput}
                placeholder={t('chat.deliverResultPlaceholder')}
                placeholderTextColor={colors.sub}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                maxLength={2000}
              />
              <View style={s.modalActions}>
                <TouchableOpacity
                  style={[s.modalCancel, { minHeight: 44, justifyContent: 'center' }]}
                  onPress={() => { setTextDeliverVisible(false); setTextDeliverInput(''); }}
                >
                  <Text style={s.modalCancelText}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.modalSave, { minHeight: 44, justifyContent: 'center' }, !textDeliverInput.trim() && s.sendBtnDisabled]}
                  disabled={!textDeliverInput.trim()}
                  onPress={submitTextDeliver}
                >
                  <Text style={s.modalSaveText}>{t('chat.send')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </SafeAreaView>
      </Modal>

      {/* Image preview modal */}
      <Modal
        visible={imagePreviewVisible}
        transparent
        animationType="fade"
        onRequestClose={() => { if (!uploading) discardPendingImage(); }}
      >
        <SafeAreaView style={{ flex: 1 }}>
          <View style={s.modalOverlay}>
            <View style={[s.imgPreviewCard, { paddingBottom: 32 }]}>
              <Text style={s.imgPreviewTitle}>{t('chat.attachImageTitle')}</Text>
              {pendingImage && (
                <Image
                  source={{ uri: pendingImage.uri }}
                  style={s.imgPreviewSquare}
                  resizeMode="cover"
                />
              )}
              <Text style={s.imgPreviewHint}>{t('chat.attachImageHint')}</Text>
              <TextInput
                style={s.modalInput}
                value={draft}
                onChangeText={setDraft}
                placeholder={t('chat.optionalCaption')}
                placeholderTextColor={colors.sub}
                multiline
                maxLength={500}
              />
              <View style={s.modalActions}>
                <TouchableOpacity style={[s.modalCancel, { minHeight: 44, justifyContent: 'center' }]} onPress={discardPendingImage}>
                  <Text style={s.modalCancelText}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.modalSave, { minHeight: 44, justifyContent: 'center' }, (uploading || loading) && s.sendBtnDisabled]}
                  disabled={uploading || loading}
                  onPress={() => { confirmPendingImage(); handleSend(); }}
                >
                  <Text style={s.modalSaveText}>{uploading ? t('common.loading') : t('chat.send')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </SafeAreaView>
      </Modal>

      </View>
    </KeyboardAvoidingView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

function useStyles(colors: ThemeColors, isTablet = false) {
  return React.useMemo(() => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  chatContainer: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerLeft: { flexDirection: 'row', alignItems: 'center' },
  headerAvatar: { width: 32, height: 32, borderRadius: 16, marginRight: 8, borderWidth: 1, borderColor: colors.border },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green },
  headerTitle: { color: colors.green, fontFamily: 'monospace', fontSize: 13, fontWeight: '700', letterSpacing: 2 },
  resetBtn: { paddingVertical: 4, paddingHorizontal: 8 },
  resetBtnText: { color: colors.sub, fontFamily: 'monospace', fontSize: 11 },
  // agent selector
  agentBar: { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: colors.border },
  agentBarContent: { paddingHorizontal: 12, paddingVertical: 8, gap: 8, flexDirection: 'row' },
  agentPill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  agentPillActive: { borderColor: colors.green, backgroundColor: colors.green + '15' },
  agentPillText: { fontSize: 11, color: colors.sub, fontFamily: 'monospace' },
  agentPillTextActive: { color: colors.green },
  agentPillBadge: { fontSize: 11 },
  // task switcher
  taskSwitcher: { maxHeight: 44, borderBottomWidth: 1, borderBottomColor: colors.border },
  taskSwitcherContent: { paddingHorizontal: 10, paddingVertical: 6, gap: 6, flexDirection: 'row', alignItems: 'center' },
  taskPill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, maxWidth: 160 },
  taskPillActive: { borderColor: colors.amber, backgroundColor: colors.amber + '15' },
  taskPillDelivered: { borderColor: colors.green + '80' },
  taskPillText: { fontSize: 10, color: colors.sub, fontFamily: 'monospace' },
  taskPillTextActive: { color: colors.amber },
  taskPillBadge: { fontSize: 10, color: colors.green, marginLeft: 4 },
  // task banner
  taskBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.green + '40', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  taskBannerLeft: { flex: 1 },
  taskBannerActions: { flexDirection: 'column', gap: 6 },
  taskLabel: { fontSize: 9, color: colors.green, letterSpacing: 3, fontWeight: '700', fontFamily: 'monospace', marginBottom: 3 },
  taskDesc: { fontSize: 12, color: colors.text, fontFamily: 'monospace', lineHeight: 17 },
  taskMeta: { fontSize: 10, color: colors.sub, fontFamily: 'monospace', marginTop: 4 },
  deliverBtn: { backgroundColor: colors.green, borderRadius: 3, paddingHorizontal: 12, paddingVertical: 8 },
  deliverBtnBusy: { backgroundColor: colors.sub },
  deliverText: { fontSize: 10, color: '#000', fontWeight: '700', letterSpacing: 2 },
  rejectBtn: { borderWidth: 1, borderColor: colors.red + '80', borderRadius: 3, paddingHorizontal: 12, paddingVertical: 6 },
  rejectText: { fontSize: 10, color: colors.red, fontWeight: '700', letterSpacing: 2, fontFamily: 'monospace' },
  // messages
  listContent: { padding: 12, paddingBottom: 8, flexGrow: 1 },
  bubbleRow: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 10, gap: 6 },
  rowLeft: { justifyContent: 'flex-start' },
  rowRight: { justifyContent: 'flex-end' },
  roleLabel: { color: colors.sub, fontFamily: 'monospace', fontSize: 9, marginBottom: 2 },
  bubble: { maxWidth: isTablet ? '60%' : '78%', borderRadius: 4, padding: 10 },
  bubbleUser: { backgroundColor: colors.green + '15', borderWidth: 1, borderColor: colors.green },
  bubbleAgent: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  bubbleText: { color: colors.text, fontFamily: 'monospace', fontSize: 13, lineHeight: 19 },
  bubbleTextUser: { color: colors.green },
  bubbleSystemRow: { alignItems: 'center', marginVertical: 12 },
  bubbleSystemText: { color: colors.green, fontFamily: 'monospace', fontSize: 11, textAlign: 'center', backgroundColor: colors.green + '15', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 6, borderWidth: 1, borderColor: colors.green + '40', overflow: 'hidden' },
  thinkingWrap: { padding: 12 },
  thinkingText: { color: colors.sub, fontFamily: 'monospace', fontSize: 12 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, paddingBottom: 24 },
  emptyLine: { color: colors.sub, fontFamily: 'monospace', fontSize: 11, lineHeight: 17 },
  emptyHint: { color: colors.sub, fontFamily: 'monospace', fontSize: 12, textAlign: 'center' },
  suggestionsWrap: { marginTop: 24, width: '100%', paddingHorizontal: 8, gap: 16 },
  suggestionGroup: { gap: 6 },
  suggestionGroupLabel: { color: colors.sub, fontFamily: 'monospace', fontSize: 9, letterSpacing: 1.5, marginBottom: 2, opacity: 0.6 },
  suggestionChip: { borderWidth: 1, borderColor: colors.border, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 8 },
  suggestionText: { color: colors.sub, fontFamily: 'monospace', fontSize: 11, lineHeight: 16 },
  startingBanner: { backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.border, padding: 10, alignItems: 'center' },
  startingText: { color: colors.sub, fontFamily: 'monospace', fontSize: 11 },
  errorBanner: { backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.red, padding: 12 },
  errorText: { color: colors.red, fontFamily: 'monospace', fontSize: 11, marginBottom: 2 },
  errorHint: { color: colors.sub, fontFamily: 'monospace', fontSize: 10 },
  inputWrap: { borderTopWidth: 1, borderTopColor: colors.border },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', padding: 12, gap: 8 },
  input: { flex: 1, backgroundColor: colors.input, borderWidth: 1, borderColor: colors.border, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 10, color: colors.text, fontFamily: 'monospace', fontSize: 13, maxHeight: 120 },
  attachBtn: { width: 44, height: 44, borderRadius: 4, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  attachBtnText: { fontSize: 20 },
  sendBtn: { backgroundColor: colors.green, width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { backgroundColor: colors.border },
  sendBtnText: { color: '#000000', fontFamily: 'monospace', fontSize: 18, fontWeight: '700' },
  // pending image strip
  pendingImageStrip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 8, gap: 8 },
  pendingThumb: { width: 40, height: 40, borderRadius: 4, borderWidth: 1, borderColor: colors.green },
  pendingImageLabel: { flex: 1, color: colors.green, fontFamily: 'monospace', fontSize: 11 },
  pendingRemoveBtn: { padding: 6 },
  pendingRemoveText: { color: colors.sub, fontFamily: 'monospace', fontSize: 14 },
  // bubble image thumbnail
  bubbleThumb: { width: 180, height: 180, borderRadius: 4, marginBottom: 6, borderWidth: 1, borderColor: colors.border },
  // image preview modal
  imgPreviewCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 6, padding: 20, width: '100%', maxWidth: isTablet ? 480 : undefined },
  imgPreviewTitle: { color: colors.green, fontFamily: 'monospace', fontSize: 11, fontWeight: '700', letterSpacing: 2, marginBottom: 12 },
  imgPreviewSquare: { width: '100%', aspectRatio: 1, borderRadius: 4, borderWidth: 1, borderColor: colors.border, marginBottom: 12 },
  imgPreviewHint: { color: colors.sub, fontFamily: 'monospace', fontSize: 11, lineHeight: 16, marginBottom: 10 },
  // launch result card
  launchCard: { marginTop: 8, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.green + '60', borderRadius: 4, padding: 10 },
  launchCardLabel: { fontSize: 9, color: colors.green, letterSpacing: 3, fontWeight: '700', fontFamily: 'monospace', marginBottom: 6 },
  launchCardName: { fontSize: 13, color: colors.text, fontFamily: 'monospace', fontWeight: '700', marginBottom: 6 },
  launchCardField: { fontSize: 9, color: colors.sub, letterSpacing: 2, fontFamily: 'monospace', marginTop: 4 },
  launchCardValue: { fontSize: 11, color: colors.green, fontFamily: 'monospace', marginTop: 2 },
  // bags rate-limit modal
  modalOverlay: { flex: 1, backgroundColor: '#000000cc', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 6, padding: 20, width: '100%' },
  modalTitle: { color: colors.amber, fontFamily: 'monospace', fontSize: 11, fontWeight: '700', letterSpacing: 2, marginBottom: 10 },
  modalBody: { color: colors.sub, fontFamily: 'monospace', fontSize: 12, lineHeight: 18, marginBottom: 14 },
  modalInput: { backgroundColor: colors.input, borderWidth: 1, borderColor: colors.border, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 10, color: colors.text, fontFamily: 'monospace', fontSize: 12, marginBottom: 16 },
  modalActions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  modalCancel: { paddingHorizontal: 14, paddingVertical: 10 },
  modalCancelText: { color: colors.sub, fontFamily: 'monospace', fontSize: 11 },
  modalSave: { backgroundColor: colors.green, borderRadius: 3, paddingHorizontal: 18, paddingVertical: 10 },
  modalSaveText: { color: '#000', fontFamily: 'monospace', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  // sticky task context card
  stickyTaskCard: { backgroundColor: colors.green + '10', borderBottomWidth: 1, borderBottomColor: colors.green + '30', paddingVertical: 10, paddingHorizontal: 16 },
  stickyTaskDesc: { fontSize: 12, fontWeight: '700', color: colors.text, fontFamily: 'monospace', marginBottom: 2 },
  stickyTaskReward: { fontSize: 11, color: colors.green, fontFamily: 'monospace', marginBottom: 2 },
  stickyTaskStatus: { fontSize: 10, color: colors.sub, fontFamily: 'monospace' },
  // delivery action bar
  deliverBar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.green + '30', backgroundColor: colors.green + '10', paddingHorizontal: 12, paddingVertical: 6, gap: 8 },
  deliverBarBtn: { flex: 1, height: 36, borderWidth: 1, borderColor: colors.green + '40', borderRadius: 4, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card },
  deliverBarBtnText: { fontSize: 11, color: colors.green, fontFamily: 'monospace', fontWeight: '600' },
  // mode pills
  pillRow: { flexDirection: 'row', gap: 4, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  pill: { borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  pillActive: { backgroundColor: colors.text, borderColor: colors.text },
  pillDeliverHighlight: { backgroundColor: colors.amber + '15', borderColor: colors.amber },
  pillText: { fontSize: 10, color: colors.sub },
  pillTextActive: { color: colors.bg, fontWeight: '500' },
  pillTextDeliverHighlight: { color: colors.amber },
  // brief mode
  briefContainer: { flex: 1, padding: 16, gap: 12 },
  briefInput: { flex: 1, backgroundColor: colors.input, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 12, padding: 14, fontSize: 13, color: colors.text, textAlignVertical: 'top' },
  briefAttachBtn: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, alignItems: 'center' as const },
  briefAttachBtnText: { fontSize: 12, color: colors.sub },
  briefStartBtn: { backgroundColor: colors.text, borderRadius: 10, padding: 14, alignItems: 'center' as const },
  briefStartBtnText: { fontSize: 13, color: colors.bg, fontWeight: '600' as const },
  // deliver mode
  deliverModeContainer: { flex: 1, padding: 16, gap: 12 },
  deliverTaskCard: { backgroundColor: colors.input, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: colors.border },
  deliverTaskTitle: { fontSize: 12, color: colors.text, fontWeight: '500' as const, marginBottom: 4 },
  deliverTaskMeta: { fontSize: 10, color: colors.dim },
  deliverModeInput: { flex: 1, backgroundColor: colors.input, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 12, padding: 14, fontSize: 13, color: colors.text, textAlignVertical: 'top' },
  deliverActions: { gap: 8 },
  deliverModeBtn: { backgroundColor: colors.text, borderRadius: 10, padding: 14, alignItems: 'center' as const },
  deliverModeBtnText: { fontSize: 13, color: colors.bg, fontWeight: '600' as const },
  }), [colors]);
}
