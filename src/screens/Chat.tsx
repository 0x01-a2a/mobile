/**
 * Chat — interactive chat with the ZeroClaw agent brain.
 *
 * When navigated from Earn with task params, shows a sticky task banner
 * at the top with a DELIVER button. Agent selector pills are shown when
 * the user owns more than one agent.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRoute } from '@react-navigation/native';
import { launchCamera, launchImageLibrary } from 'react-native-image-picker';
import { useZeroclawChat, ChatMessage } from '../hooks/useZeroclawChat';
import { useOwnedAgents, OwnedAgent } from '../hooks/useOwnedAgents';
import { useBlobs } from '../hooks/useBlobs';
import { sendEnvelope } from '../hooks/useNodeApi';
import type { BountyTask } from './Earn';

const C = {
  bg:      '#050505',
  card:    '#0f0f0f',
  border:  '#1a1a1a',
  green:   '#00e676',
  dim:     '#1a2e1a',
  text:    '#ffffff',
  sub:     '#555555',
  red:     '#ff1744',
  amber:   '#ffc107',
  input:   '#111111',
};

// ── Types ─────────────────────────────────────────────────────────────────

interface ChatRouteParams {
  agentId?:        string;
  conversationId?: string;
  task?:           BountyTask;
}

// ── Task banner ───────────────────────────────────────────────────────────

function TaskBanner({
  task,
  conversationId,
  uploading,
  onDeliver,
}: {
  task:           BountyTask;
  conversationId: string;
  uploading:      boolean;
  onDeliver:      () => void;
}) {
  return (
    <View style={s.taskBanner}>
      <View style={s.taskBannerLeft}>
        <Text style={s.taskLabel}>TASK</Text>
        <Text style={s.taskDesc} numberOfLines={2}>{task.description}</Text>
        <Text style={s.taskMeta}>
          {task.reward}  ·  from {task.fromAgent.length > 12 ? task.fromAgent.slice(0, 8) + '…' : task.fromAgent}
        </Text>
      </View>
      <TouchableOpacity
        style={[s.deliverBtn, uploading && s.deliverBtnBusy]}
        onPress={onDeliver}
        activeOpacity={0.8}
        disabled={uploading}
      >
        <Text style={s.deliverText}>{uploading ? '...' : 'DELIVER'}</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Agent selector pills ──────────────────────────────────────────────────

function AgentSelector({
  agents,
  selectedId,
  onSelect,
}: {
  agents:     OwnedAgent[];
  selectedId: string;
  onSelect:   (a: OwnedAgent) => void;
}) {
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
            <Text style={[s.agentPillBadge, { color: a.mode === 'local' ? C.green : C.amber }]}>
              {a.mode === 'local' ? ' [L]' : ' [H]'}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────

function Bubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
  return (
    <View style={[s.bubbleRow, isUser ? s.rowRight : s.rowLeft]}>
      {!isUser && <Text style={s.roleLabel}>[ZC]</Text>}
      <View style={[s.bubble, isUser ? s.bubbleUser : s.bubbleAgent]}>
        <Text style={[s.bubbleText, isUser ? s.bubbleTextUser : undefined]}>
          {msg.text}
        </Text>
      </View>
      {isUser && <Text style={s.roleLabel}>[YOU]</Text>}
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────

export function ChatScreen() {
  const route  = useRoute();
  const params = (route.params ?? {}) as ChatRouteParams;

  const agents  = useOwnedAgents();
  const [selectedAgentId, setSelectedAgentId] = useState<string>(
    params.agentId ?? agents[0]?.id ?? '',
  );

  // Keep selectedAgentId in sync when agents load or params change.
  useEffect(() => {
    if (params.agentId) {
      setSelectedAgentId(params.agentId);
    } else if (!selectedAgentId && agents.length > 0) {
      setSelectedAgentId(agents[0].id);
    }
  }, [params.agentId, agents]);

  const { messages, loading, error, send, resetSession } = useZeroclawChat();
  const { upload, uploading } = useBlobs();
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList>(null);

  // Inject task context as first message when routed from Earn.
  const [taskInjected, setTaskInjected] = useState(false);
  useEffect(() => {
    if (params.task && !taskInjected && messages.length === 0) {
      setTaskInjected(true);
      send(
        `You have accepted a new task. Task: "${params.task.description}". ` +
        `Reward: ${params.task.reward}. Requester: ${params.task.fromAgent}. ` +
        `Let me know when you are ready to deliver.`,
      );
    }
  }, [params.task, taskInjected, messages.length]);

  useEffect(() => {
    if (messages.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [messages]);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || loading) return;
    setDraft('');
    await send(text);
  }, [draft, loading, send]);

  const pickAndDeliver = useCallback(async (source: 'camera' | 'gallery') => {
    const pickerOptions = {
      mediaType:    'photo' as const,
      includeBase64: true,
      maxWidth:     1920,
      maxHeight:    1920,
      quality:      0.85 as const,
    };

    const result = source === 'camera'
      ? await launchCamera(pickerOptions)
      : await launchImageLibrary(pickerOptions);

    if (result.didCancel || !result.assets?.[0]) return;

    const asset    = result.assets[0];
    const b64      = asset.base64;
    const mimeType = asset.type ?? 'image/jpeg';

    if (!b64) {
      Alert.alert('Error', 'Could not read image data.');
      return;
    }

    const cid = await upload(b64, mimeType);
    if (!cid) return; // error surfaced by useBlobs

    await sendEnvelope({
      msg_type:        'DELIVER',
      conversation_id: params.conversationId,
      payload:         btoa(JSON.stringify({ cid, mime_type: mimeType })),
    });
    Alert.alert('Delivered', 'Photo uploaded. DELIVER sent — awaiting feedback.');
  }, [upload, params.conversationId]);

  const handleDeliver = useCallback(() => {
    if (!params.conversationId) return;
    Alert.alert(
      'Deliver task',
      'Attach proof of completion:',
      [
        { text: 'Take Photo',          onPress: () => pickAndDeliver('camera') },
        { text: 'Choose from Gallery', onPress: () => pickAndDeliver('gallery') },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [params.conversationId, pickAndDeliver]);

  const isEmpty = messages.length === 0 && !loading && !error;

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={80}
    >
      {/* Header */}
      <View style={s.header}>
        <Text style={s.headerTitle}>AGENT CHAT</Text>
        <TouchableOpacity onPress={resetSession} style={s.resetBtn}>
          <Text style={s.resetBtnText}>[NEW]</Text>
        </TouchableOpacity>
      </View>

      {/* Agent selector — visible when user owns multiple agents */}
      <AgentSelector
        agents={agents}
        selectedId={selectedAgentId}
        onSelect={a => setSelectedAgentId(a.id)}
      />

      {/* Task banner — visible when routed from Earn */}
      {params.task && params.conversationId && (
        <TaskBanner
          task={params.task}
          conversationId={params.conversationId}
          uploading={uploading}
          onDeliver={handleDeliver}
        />
      )}

      {/* Message list */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={m => m.id}
        renderItem={({ item }) => <Bubble msg={item} />}
        contentContainerStyle={s.listContent}
        ListEmptyComponent={
          <View style={s.emptyWrap}>
            <Text style={s.emptyLine}>  _______ ___</Text>
            <Text style={s.emptyLine}> |__  / __| _ \___ __ __</Text>
            <Text style={s.emptyLine}>   / / (__| / / _ \\ V  V /</Text>
            <Text style={s.emptyLine}>  /___\___|_|_\___/ \_/\_/</Text>
            <Text style={s.emptyHint}>{'\n'}Agent brain ready.{'\n'}Type a message to begin.</Text>
          </View>
        }
        ListFooterComponent={
          loading ? (
            <View style={s.thinkingWrap}>
              <Text style={s.thinkingText}>[ZC] thinking...</Text>
            </View>
          ) : null
        }
      />

      {/* Error banner */}
      {error ? (
        <View style={s.errorBanner}>
          <Text style={s.errorText}>{error}</Text>
          <Text style={s.errorHint}>
            Enable AGENT BRAIN in Settings, then restart the node.
          </Text>
        </View>
      ) : null}

      {/* Input row */}
      <View style={s.inputRow}>
        <TextInput
          style={s.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message ZeroClaw..."
          placeholderTextColor={C.sub}
          multiline
          maxLength={4000}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
          editable={!loading}
        />
        <TouchableOpacity
          style={[s.sendBtn, (!draft.trim() || loading) && s.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!draft.trim() || loading}
        >
          <Text style={s.sendBtnText}>{loading ? '…' : '>'}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:    { flex: 1, backgroundColor: C.bg },
  header:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 52, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  headerTitle: { color: C.green, fontFamily: 'monospace', fontSize: 13, fontWeight: '700', letterSpacing: 2 },
  resetBtn:     { paddingVertical: 4, paddingHorizontal: 8 },
  resetBtnText: { color: C.sub, fontFamily: 'monospace', fontSize: 11 },
  // agent selector
  agentBar:        { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: C.border },
  agentBarContent: { paddingHorizontal: 12, paddingVertical: 8, gap: 8, flexDirection: 'row' },
  agentPill:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  agentPillActive: { borderColor: C.green, backgroundColor: '#00e67615' },
  agentPillText:   { fontSize: 11, color: C.sub, fontFamily: 'monospace' },
  agentPillTextActive: { color: C.green },
  agentPillBadge:  { fontSize: 11 },
  // task banner
  taskBanner:     { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0a1a0a', borderBottomWidth: 1, borderBottomColor: C.green + '40', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  taskBannerLeft: { flex: 1 },
  taskLabel:      { fontSize: 9, color: C.green, letterSpacing: 3, fontWeight: '700', fontFamily: 'monospace', marginBottom: 3 },
  taskDesc:       { fontSize: 12, color: C.text, fontFamily: 'monospace', lineHeight: 17 },
  taskMeta:       { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginTop: 4 },
  deliverBtn:     { backgroundColor: C.green, borderRadius: 3, paddingHorizontal: 12, paddingVertical: 8 },
  deliverBtnBusy: { backgroundColor: C.sub },
  deliverText:    { fontSize: 10, color: '#000', fontWeight: '700', letterSpacing: 2 },
  // messages
  listContent:    { padding: 12, paddingBottom: 8, flexGrow: 1 },
  bubbleRow:      { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 10, gap: 6 },
  rowLeft:        { justifyContent: 'flex-start' },
  rowRight:       { justifyContent: 'flex-end' },
  roleLabel:      { color: C.sub, fontFamily: 'monospace', fontSize: 9, marginBottom: 2 },
  bubble:         { maxWidth: '78%', borderRadius: 4, padding: 10 },
  bubbleUser:     { backgroundColor: C.dim, borderWidth: 1, borderColor: C.green },
  bubbleAgent:    { backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  bubbleText:     { color: C.text, fontFamily: 'monospace', fontSize: 13, lineHeight: 19 },
  bubbleTextUser: { color: C.green },
  thinkingWrap:   { padding: 12 },
  thinkingText:   { color: C.sub, fontFamily: 'monospace', fontSize: 12 },
  emptyWrap:      { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyLine:      { color: C.sub, fontFamily: 'monospace', fontSize: 11, lineHeight: 17 },
  emptyHint:      { color: C.sub, fontFamily: 'monospace', fontSize: 12, textAlign: 'center' },
  errorBanner:    { backgroundColor: '#1a0505', borderTopWidth: 1, borderTopColor: C.red, padding: 12 },
  errorText:      { color: C.red, fontFamily: 'monospace', fontSize: 11, marginBottom: 2 },
  errorHint:      { color: C.sub, fontFamily: 'monospace', fontSize: 10 },
  inputRow:       { flexDirection: 'row', alignItems: 'flex-end', padding: 12, borderTopWidth: 1, borderTopColor: C.border, gap: 8 },
  input:          { flex: 1, backgroundColor: C.input, borderWidth: 1, borderColor: C.border, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 10, color: C.text, fontFamily: 'monospace', fontSize: 13, maxHeight: 120 },
  sendBtn:        { backgroundColor: C.green, width: 44, height: 44, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled:{ backgroundColor: C.border },
  sendBtnText:    { color: '#000000', fontFamily: 'monospace', fontSize: 18, fontWeight: '700' },
});
