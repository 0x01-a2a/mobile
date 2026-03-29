/**
 * Chat — interactive chat with the ZeroClaw agent brain.
 *
 * When navigated from Inbox with task params, shows task context in Chat mode.
 * Agent selector pills are shown when the user owns more than one agent.
 */
import { useTheme, ThemeColors } from '../theme/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Clipboard,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
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
import { useOwnedAgents, OwnedAgent } from '../hooks/useOwnedAgents';
import { useBlobs } from '../hooks/useBlobs';
import { sendEnvelope, setBagsApiKey } from '../hooks/useNodeApi';
import { useNode } from '../hooks/useNode';
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

// ── Message bubble ────────────────────────────────────────────────────────

function Bubble({ msg }: { msg: ChatMessage }) {
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
  const launchResult = !isUser ? tryParseLaunchResult(msg.text) : null;
  const displayText = launchResult
    ? msg.text.replace(/\{[^{}]*"token_mint"[^{}]*\}/, '').trim()
    : msg.text;

  const handleLongPress = useCallback(() => {
    if (!displayText) return;
    Clipboard.setString(displayText);
    Alert.alert('Copied', undefined, [{ text: 'OK' }], { cancelable: true });
  }, [displayText]);

  return (
    <View style={[s.bubbleRow, isUser ? s.rowRight : s.rowLeft]}>
      {!isUser && <Text style={s.roleLabel}>{t('chat.roleZC')}</Text>}
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
  const { config } = useNode();

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
  const { messages, loading, error, send, resetSession } = useZeroclawChat(selectedAgentId, selectedConvId);
  const { upload, uploading, error: uploadError } = useBlobs();
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList>(null);

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
      if (selectedConvId) await markTaskDelivered(selectedConvId);
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
      Alert.alert('Delivered', 'DELIVER sent — awaiting feedback.');
    } else {
      Alert.alert('Error', 'DELIVER failed. Check your connection and try again.');
    }
  }, [textDeliverInput, selectedConvId, activeTask]);

  const handleDeliver = useCallback(() => {
    if (!selectedConvId) return;
    Alert.alert(
      'Deliver task',
      'How to deliver:',
      [
        { text: 'Text Result', onPress: () => setTextDeliverVisible(true) },
        { text: 'Take Photo', onPress: () => pickAndDeliver('camera') },
        { text: 'From Gallery', onPress: () => pickAndDeliver('gallery') },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [selectedConvId, pickAndDeliver]);

  const handleReject = useCallback(() => {
    if (!selectedConvId) return;
    Alert.alert(
      'Reject task',
      'Send REJECT and remove this task from your active list?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'REJECT',
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
  }, [selectedConvId, activeTask]);

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={isTablet ? 0 : 80}
    >
      <View style={[s.chatContainer, { paddingHorizontal: contentHPad }]}>
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + 16 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {config.agentAvatar && (
            <Image source={{ uri: config.agentAvatar }} style={{ width: 32, height: 32, borderRadius: 16, marginRight: 8, borderWidth: 1, borderColor: colors.border }} />
          )}
          <Text style={s.headerTitle}>{(config.agentName || '01 PILOT').toUpperCase()}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#22c55e' }} />
          <TouchableOpacity onPress={resetSession} style={s.resetBtn}>
            <Text style={s.resetBtnText}>{t('chat.newSession')}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Agent selector — visible when user owns multiple agents */}
      <AgentSelector
        agents={agents}
        selectedId={selectedAgentId}
        onSelect={a => setSelectedAgentId(a.id)}
      />

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
            renderItem={({ item }) => <Bubble msg={item} />}
            contentContainerStyle={s.listContent}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            ListEmptyComponent={
              <View style={s.emptyWrap}>
                <Text style={s.emptyLine}>  _______ ___</Text>
                <Text style={s.emptyLine}> |__  / __| _ \___ __ __</Text>
                <Text style={s.emptyLine}>   / / (__| / / _ \\ V  V /</Text>
                <Text style={s.emptyLine}>  /___\___|_|_\___/ \_/\_/</Text>
                <Text style={s.emptyHint}>{t('chat.agentBrainReady')}</Text>
                <View style={s.suggestionsWrap}>
                  {[
                    'Every morning check my calendar and health, then DCA into SOL if conditions are good',
                    'Watch my notifications and reply to anything routine automatically',
                    'When my salary SMS arrives, convert 20% to SOL immediately',
                    'Check my portfolio balance and tell me how I\'m doing',
                    'Find agents in China that can help with supplier sourcing',
                  ].map(suggestion => (
                    <TouchableOpacity
                      key={suggestion}
                      style={s.suggestionChip}
                      onPress={() => setDraft(suggestion)}
                      activeOpacity={0.7}
                    >
                      <Text style={s.suggestionText}>{suggestion}</Text>
                    </TouchableOpacity>
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

          {/* ZeroClaw error banner */}
          {error ? (
            <View style={s.errorBanner}>
              <Text style={s.errorText}>{error}</Text>
              <Text style={s.errorHint}>
                {t('chat.enableAgentBrain')}
              </Text>
            </View>
          ) : null}

          {/* Upload error banner */}
          {uploadError ? (
            <View style={s.errorBanner}>
              <Text style={s.errorText}>{uploadError}</Text>
            </View>
          ) : null}

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
                style={[s.attachBtn, loading && s.sendBtnDisabled]}
                onPress={pickChatImage}
                disabled={loading}
              >
                <Text style={s.attachBtnText}>📎</Text>
              </TouchableOpacity>
              <TextInput
                style={s.input}
                value={draft}
                onChangeText={setDraft}
                placeholder={t('you.messagePlaceholder', { name: config.agentName || '01 Pilot' })}
                placeholderTextColor={colors.sub}
                multiline
                maxLength={4000}
                onSubmitEditing={handleSend}
                blurOnSubmit={false}
                editable={!loading}
              />
              <TouchableOpacity
                style={[s.sendBtn, ((!draft.trim() && !pendingImage) || loading) && s.sendBtnDisabled]}
                onPress={handleSend}
                disabled={(!draft.trim() && !pendingImage) || loading}
              >
                <Text style={s.sendBtnText}>{loading ? '…' : '↑'}</Text>
              </TouchableOpacity>
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
        onRequestClose={discardPendingImage}
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
  suggestionsWrap: { marginTop: 24, width: '100%', paddingHorizontal: 8, gap: 8 },
  suggestionChip: { borderWidth: 1, borderColor: colors.border, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 8 },
  suggestionText: { color: colors.sub, fontFamily: 'monospace', fontSize: 11, lineHeight: 16 },
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
  // mode pills
  pillRow: { flexDirection: 'row', gap: 4, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  pill: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  pillActive: { backgroundColor: '#111', borderColor: '#111' },
  pillDeliverHighlight: { backgroundColor: '#fffbeb', borderColor: '#fbbf24' },
  pillText: { fontSize: 10, color: '#6b7280' },
  pillTextActive: { color: '#fff', fontWeight: '500' },
  pillTextDeliverHighlight: { color: '#b45309' },
  // brief mode
  briefContainer: { flex: 1, padding: 16, gap: 12 },
  briefInput: { flex: 1, backgroundColor: '#f9fafb', borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, padding: 14, fontSize: 13, color: '#111', textAlignVertical: 'top' },
  briefAttachBtn: { borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, padding: 10, alignItems: 'center' as const },
  briefAttachBtnText: { fontSize: 12, color: '#6b7280' },
  briefStartBtn: { backgroundColor: '#111', borderRadius: 10, padding: 14, alignItems: 'center' as const },
  briefStartBtnText: { fontSize: 13, color: '#fff', fontWeight: '600' as const },
  // deliver mode
  deliverModeContainer: { flex: 1, padding: 16, gap: 12 },
  deliverTaskCard: { backgroundColor: '#f9fafb', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#e5e7eb' },
  deliverTaskTitle: { fontSize: 12, color: '#111', fontWeight: '500' as const, marginBottom: 4 },
  deliverTaskMeta: { fontSize: 10, color: '#9ca3af' },
  deliverModeInput: { flex: 1, backgroundColor: '#f9fafb', borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, padding: 14, fontSize: 13, color: '#111', textAlignVertical: 'top' },
  deliverActions: { gap: 8 },
  deliverModeBtn: { backgroundColor: '#111', borderRadius: 10, padding: 14, alignItems: 'center' as const },
  deliverModeBtnText: { fontSize: 13, color: '#fff', fontWeight: '600' as const },
  }), [colors]);
}
