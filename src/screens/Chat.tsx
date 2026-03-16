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
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Image,
} from 'react-native';
import { useRoute } from '@react-navigation/native';
import { launchCamera, launchImageLibrary } from 'react-native-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useZeroclawChat, ChatMessage } from '../hooks/useZeroclawChat';
import { useOwnedAgents, OwnedAgent } from '../hooks/useOwnedAgents';
import { useBlobs } from '../hooks/useBlobs';
import { sendEnvelope, setBagsApiKey } from '../hooks/useNodeApi';
import { useNode } from '../hooks/useNode';
import type { BountyTask } from './Earn';

const TASK_LOG_KEY = 'zerox1:task_log';

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

const C = {
  bg: '#050505',
  card: '#0f0f0f',
  border: '#1a1a1a',
  green: '#00e676',
  dim: '#1a2e1a',
  text: '#ffffff',
  sub: '#555555',
  red: '#ff1744',
  amber: '#ffc107',
  input: '#111111',
};

// ── Types ─────────────────────────────────────────────────────────────────

interface ChatRouteParams {
  agentId?: string;
  conversationId?: string;
  task?: BountyTask;
}

// ── Task banner ───────────────────────────────────────────────────────────

function TaskBanner({
  task,
  uploading,
  onDeliver,
  onReject,
}: {
  task: BountyTask;
  conversationId: string;
  uploading: boolean;
  onDeliver: () => void;
  onReject: () => void;
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
      <View style={s.taskBannerActions}>
        <TouchableOpacity
          style={s.rejectBtn}
          onPress={onReject}
          activeOpacity={0.8}
        >
          <Text style={s.rejectText}>REJECT</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.deliverBtn, uploading && s.deliverBtnBusy]}
          onPress={onDeliver}
          activeOpacity={0.8}
          disabled={uploading}
        >
          <Text style={s.deliverText}>{uploading ? '...' : 'DELIVER'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
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

// ── Launch result detection ───────────────────────────────────────────────

interface LaunchResult {
  token_mint: string;
  txid?: string;
  name?: string;
  symbol?: string;
}

function tryParseLaunchResult(text: string): LaunchResult | null {
  const match = text.match(/\{[^{}]*"token_mint"[^{}]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    if (typeof obj.token_mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(obj.token_mint)) return null;
    return obj as LaunchResult;
  } catch {}
  return null;
}

// ── Launch result card ────────────────────────────────────────────────────

function LaunchResultCard({ result }: { result: LaunchResult }) {
  const shortMint = result.token_mint.length > 20
    ? `${result.token_mint.slice(0, 8)}…${result.token_mint.slice(-6)}`
    : result.token_mint;
  const shortTxid = result.txid && result.txid.length > 20
    ? `${result.txid.slice(0, 8)}…${result.txid.slice(-6)}`
    : result.txid;
  return (
    <View style={s.launchCard}>
      <Text style={s.launchCardLabel}>TOKEN LAUNCHED</Text>
      {(result.name || result.symbol) && (
        <Text style={s.launchCardName}>
          {result.name ?? ''}{result.symbol ? ` (${result.symbol})` : ''}
        </Text>
      )}
      <Text style={s.launchCardField}>MINT</Text>
      <Text style={s.launchCardValue} selectable>{shortMint}</Text>
      {shortTxid && (
        <>
          <Text style={s.launchCardField}>TX</Text>
          <Text style={s.launchCardValue} selectable>{shortTxid}</Text>
        </>
      )}
    </View>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────

function Bubble({ msg }: { msg: ChatMessage }) {
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

  return (
    <View style={[s.bubbleRow, isUser ? s.rowRight : s.rowLeft]}>
      {!isUser && <Text style={s.roleLabel}>[ZC]</Text>}
      <View style={[s.bubble, isUser ? s.bubbleUser : s.bubbleAgent]}>
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
      </View>
      {isUser && <Text style={s.roleLabel}>[YOU]</Text>}
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────

// Hosted mode: limit inline image data to 150 KB to stay within MAX_MESSAGE_SIZE.
const MAX_INLINE_BYTES = 150 * 1024;

export function ChatScreen() {
  const route = useRoute();
  const params = (route.params ?? {}) as ChatRouteParams;
  const { config } = useNode();

  const agents = useOwnedAgents().filter(a => a.mode !== 'linked');
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
  }, [params.agentId, agents, selectedAgentId]);

  // Pass agentId so the hook scopes its session per agent and auto-resets on switch.
  const { messages, loading, error, send, resetSession } = useZeroclawChat(selectedAgentId);
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

  // Inject task context as first message when routed from Earn.
  // Reset taskInjected whenever the agent changes so context is re-injected
  // into the fresh session for the new agent.
  const [taskInjected, setTaskInjected] = useState(false);
  useEffect(() => {
    setTaskInjected(false);
  }, [selectedAgentId]);
  useEffect(() => {
    if (params.task && !taskInjected && messages.length === 0) {
      setTaskInjected(true);
      // Use JSON.stringify to safely embed untrusted mesh data in the prompt,
      // preventing prompt injection via crafted task descriptions.
      send(
        `You have accepted a new task. Task: ${JSON.stringify(String(params.task.description).slice(0, 500))}. ` +
        `Reward: ${JSON.stringify(String(params.task.reward))}. ` +
        `Requester: ${JSON.stringify(String(params.task.fromAgent))}. ` +
        `Let me know when you are ready to deliver.`,
      );
    }
  }, [params.task, taskInjected, messages.length, send]);

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
      // Upload to blob store first, then send.
      try {
        const cid = await upload(img.base64, img.mime);
        if (!cid) return; // upload error surfaced via useBlobs
        await send(text, { uri: img.uri, cid, mime: img.mime });
      } catch {
        // upload() already sets uploadError
      }
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
      recipient: params.task?.fromAgent,
      conversation_id: params.conversationId,
      payload_b64: payload,
    });
    if (ok) {
      if (params.conversationId) await markTaskDelivered(params.conversationId);
      Alert.alert('Delivered', isHosted
        ? 'Photo sent inline. DELIVER sent — awaiting feedback.'
        : 'Photo uploaded. DELIVER sent — awaiting feedback.',
      );
    } else {
      Alert.alert('Error', 'DELIVER failed. Check your connection and try again.');
    }
  }, [upload, params.conversationId, config.nodeApiUrl]);

  const submitTextDeliver = useCallback(async () => {
    const text = textDeliverInput.trim();
    if (!text || !params.conversationId) return;
    setTextDeliverVisible(false);
    setTextDeliverInput('');
    const ok = await sendEnvelope({
      msg_type: 'DELIVER',
      recipient: params.task?.fromAgent,
      conversation_id: params.conversationId,
      payload_b64: btoa(unescape(encodeURIComponent(JSON.stringify({ text })))),
    });
    if (ok) {
      await markTaskDelivered(params.conversationId);
      Alert.alert('Delivered', 'DELIVER sent — awaiting feedback.');
    } else {
      Alert.alert('Error', 'DELIVER failed. Check your connection and try again.');
    }
  }, [textDeliverInput, params.conversationId]);

  const handleDeliver = useCallback(() => {
    if (!params.conversationId) return;
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
  }, [params.conversationId, pickAndDeliver]);

  const handleReject = useCallback(() => {
    if (!params.conversationId) return;
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
              recipient: params.task?.fromAgent,
              conversation_id: params.conversationId,
              payload_b64: '',
            });
            await markTaskAbandoned(params.conversationId!);
          },
        },
      ],
    );
  }, [params.conversationId, params.task?.fromAgent]);

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={80}
    >
      {/* Header */}
      <View style={s.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {config.agentAvatar && (
            <Image source={{ uri: config.agentAvatar }} style={{ width: 24, height: 24, borderRadius: 12, marginRight: 8, borderWidth: 1, borderColor: C.border }} />
          )}
          <Text style={s.headerTitle}>{(config.agentName || '01 PILOT').toUpperCase()}</Text>
        </View>
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
          onReject={handleReject}
        />
      )}

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
            <Text style={s.emptyHint}>{'\n'}Agent brain ready.{'\n'}Type a message to begin.</Text>
          </View>
        }
        ListFooterComponent={
          loading ? (
            <View style={s.thinkingWrap}>
              <Text style={s.thinkingText}>[01 Pilot] thinking...</Text>
            </View>
          ) : null
        }
      />

      {/* ZeroClaw error banner */}
      {error ? (
        <View style={s.errorBanner}>
          <Text style={s.errorText}>{error}</Text>
          <Text style={s.errorHint}>
            Enable AGENT BRAIN in Settings, then restart the node.
          </Text>
        </View>
      ) : null}

      {/* Upload error banner */}
      {uploadError ? (
        <View style={s.errorBanner}>
          <Text style={s.errorText}>{uploadError}</Text>
        </View>
      ) : null}

      {/* Bags rate-limit modal */}
      <Modal
        visible={bagsKeyModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setBagsKeyModalVisible(false)}
      >
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>BAGS API KEY REQUIRED</Text>
            <Text style={s.modalBody}>
              The default Bags API key is rate-limited. Paste your own key from bags.fm to continue.
            </Text>
            <TextInput
              style={s.modalInput}
              value={bagsKeyDraft}
              onChangeText={setBagsKeyDraft}
              placeholder="Enter Bags API key..."
              placeholderTextColor={C.sub}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!bagsKeySaving}
            />
            <View style={s.modalActions}>
              <TouchableOpacity
                style={s.modalCancel}
                onPress={() => { setBagsKeyModalVisible(false); setBagsKeyDraft(''); }}
                disabled={bagsKeySaving}
              >
                <Text style={s.modalCancelText}>CANCEL</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalSave, (!bagsKeyDraft.trim() || bagsKeySaving) && s.sendBtnDisabled]}
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
                <Text style={s.modalSaveText}>{bagsKeySaving ? '...' : 'SAVE'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Text deliver modal */}
      <Modal
        visible={textDeliverVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setTextDeliverVisible(false)}
      >
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>DELIVER RESULT</Text>
            <TextInput
              style={[s.modalInput, { minHeight: 80, textAlignVertical: 'top' }]}
              value={textDeliverInput}
              onChangeText={setTextDeliverInput}
              placeholder="Enter your result..."
              placeholderTextColor={C.sub}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              maxLength={2000}
            />
            <View style={s.modalActions}>
              <TouchableOpacity
                style={s.modalCancel}
                onPress={() => { setTextDeliverVisible(false); setTextDeliverInput(''); }}
              >
                <Text style={s.modalCancelText}>CANCEL</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalSave, !textDeliverInput.trim() && s.sendBtnDisabled]}
                disabled={!textDeliverInput.trim()}
                onPress={submitTextDeliver}
              >
                <Text style={s.modalSaveText}>SEND</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Image preview modal */}
      <Modal
        visible={imagePreviewVisible}
        transparent
        animationType="fade"
        onRequestClose={discardPendingImage}
      >
        <View style={s.modalOverlay}>
          <View style={s.imgPreviewCard}>
            <Text style={s.imgPreviewTitle}>ATTACH IMAGE</Text>
            {pendingImage && (
              <Image
                source={{ uri: pendingImage.uri }}
                style={s.imgPreviewSquare}
                resizeMode="cover"
              />
            )}
            <Text style={s.imgPreviewHint}>
              Add a caption below, then tap SEND — or tap CANCEL to discard.
            </Text>
            <TextInput
              style={s.modalInput}
              value={draft}
              onChangeText={setDraft}
              placeholder="Optional caption..."
              placeholderTextColor={C.sub}
              multiline
              maxLength={500}
            />
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancel} onPress={discardPendingImage}>
                <Text style={s.modalCancelText}>CANCEL</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalSave, (uploading || loading) && s.sendBtnDisabled]}
                disabled={uploading || loading}
                onPress={() => { confirmPendingImage(); handleSend(); }}
              >
                <Text style={s.modalSaveText}>{uploading ? '...' : 'SEND'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Input row */}
      <View style={s.inputWrap}>
        {/* Pending image indicator strip */}
        {pendingImage && !imagePreviewVisible && (
          <View style={s.pendingImageStrip}>
            <Image source={{ uri: pendingImage.uri }} style={s.pendingThumb} resizeMode="cover" />
            <Text style={s.pendingImageLabel}>Image attached</Text>
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
            placeholder="Message 01 Pilot..."
            placeholderTextColor={C.sub}
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
            <Text style={s.sendBtnText}>{loading ? '…' : '>'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 52, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  headerTitle: { color: C.green, fontFamily: 'monospace', fontSize: 13, fontWeight: '700', letterSpacing: 2 },
  resetBtn: { paddingVertical: 4, paddingHorizontal: 8 },
  resetBtnText: { color: C.sub, fontFamily: 'monospace', fontSize: 11 },
  // agent selector
  agentBar: { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: C.border },
  agentBarContent: { paddingHorizontal: 12, paddingVertical: 8, gap: 8, flexDirection: 'row' },
  agentPill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  agentPillActive: { borderColor: C.green, backgroundColor: '#00e67615' },
  agentPillText: { fontSize: 11, color: C.sub, fontFamily: 'monospace' },
  agentPillTextActive: { color: C.green },
  agentPillBadge: { fontSize: 11 },
  // task banner
  taskBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0a1a0a', borderBottomWidth: 1, borderBottomColor: C.green + '40', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  taskBannerLeft: { flex: 1 },
  taskBannerActions: { flexDirection: 'column', gap: 6 },
  taskLabel: { fontSize: 9, color: C.green, letterSpacing: 3, fontWeight: '700', fontFamily: 'monospace', marginBottom: 3 },
  taskDesc: { fontSize: 12, color: C.text, fontFamily: 'monospace', lineHeight: 17 },
  taskMeta: { fontSize: 10, color: C.sub, fontFamily: 'monospace', marginTop: 4 },
  deliverBtn: { backgroundColor: C.green, borderRadius: 3, paddingHorizontal: 12, paddingVertical: 8 },
  deliverBtnBusy: { backgroundColor: C.sub },
  deliverText: { fontSize: 10, color: '#000', fontWeight: '700', letterSpacing: 2 },
  rejectBtn: { borderWidth: 1, borderColor: C.red + '80', borderRadius: 3, paddingHorizontal: 12, paddingVertical: 6 },
  rejectText: { fontSize: 10, color: C.red, fontWeight: '700', letterSpacing: 2, fontFamily: 'monospace' },
  // messages
  listContent: { padding: 12, paddingBottom: 8, flexGrow: 1 },
  bubbleRow: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 10, gap: 6 },
  rowLeft: { justifyContent: 'flex-start' },
  rowRight: { justifyContent: 'flex-end' },
  roleLabel: { color: C.sub, fontFamily: 'monospace', fontSize: 9, marginBottom: 2 },
  bubble: { maxWidth: '78%', borderRadius: 4, padding: 10 },
  bubbleUser: { backgroundColor: C.dim, borderWidth: 1, borderColor: C.green },
  bubbleAgent: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  bubbleText: { color: C.text, fontFamily: 'monospace', fontSize: 13, lineHeight: 19 },
  bubbleTextUser: { color: C.green },
  bubbleSystemRow: { alignItems: 'center', marginVertical: 12 },
  bubbleSystemText: { color: C.green, fontFamily: 'monospace', fontSize: 11, textAlign: 'center', backgroundColor: '#00e67615', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 6, borderWidth: 1, borderColor: '#00e67640', overflow: 'hidden' },
  thinkingWrap: { padding: 12 },
  thinkingText: { color: C.sub, fontFamily: 'monospace', fontSize: 12 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyLine: { color: C.sub, fontFamily: 'monospace', fontSize: 11, lineHeight: 17 },
  emptyHint: { color: C.sub, fontFamily: 'monospace', fontSize: 12, textAlign: 'center' },
  errorBanner: { backgroundColor: '#1a0505', borderTopWidth: 1, borderTopColor: C.red, padding: 12 },
  errorText: { color: C.red, fontFamily: 'monospace', fontSize: 11, marginBottom: 2 },
  errorHint: { color: C.sub, fontFamily: 'monospace', fontSize: 10 },
  inputWrap: { borderTopWidth: 1, borderTopColor: C.border },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', padding: 12, gap: 8 },
  input: { flex: 1, backgroundColor: C.input, borderWidth: 1, borderColor: C.border, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 10, color: C.text, fontFamily: 'monospace', fontSize: 13, maxHeight: 120 },
  attachBtn: { width: 44, height: 44, borderRadius: 4, alignItems: 'center', justifyContent: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  attachBtnText: { fontSize: 20 },
  sendBtn: { backgroundColor: C.green, width: 44, height: 44, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { backgroundColor: C.border },
  sendBtnText: { color: '#000000', fontFamily: 'monospace', fontSize: 18, fontWeight: '700' },
  // pending image strip
  pendingImageStrip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 8, gap: 8 },
  pendingThumb: { width: 40, height: 40, borderRadius: 4, borderWidth: 1, borderColor: C.green },
  pendingImageLabel: { flex: 1, color: C.green, fontFamily: 'monospace', fontSize: 11 },
  pendingRemoveBtn: { padding: 6 },
  pendingRemoveText: { color: C.sub, fontFamily: 'monospace', fontSize: 14 },
  // bubble image thumbnail
  bubbleThumb: { width: 180, height: 180, borderRadius: 4, marginBottom: 6, borderWidth: 1, borderColor: C.border },
  // image preview modal
  imgPreviewCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 6, padding: 20, width: '100%' },
  imgPreviewTitle: { color: C.green, fontFamily: 'monospace', fontSize: 11, fontWeight: '700', letterSpacing: 2, marginBottom: 12 },
  imgPreviewSquare: { width: '100%', aspectRatio: 1, borderRadius: 4, borderWidth: 1, borderColor: C.border, marginBottom: 12 },
  imgPreviewHint: { color: C.sub, fontFamily: 'monospace', fontSize: 11, lineHeight: 16, marginBottom: 10 },
  // launch result card
  launchCard: { marginTop: 8, backgroundColor: '#0a1a0a', borderWidth: 1, borderColor: C.green + '60', borderRadius: 4, padding: 10 },
  launchCardLabel: { fontSize: 9, color: C.green, letterSpacing: 3, fontWeight: '700', fontFamily: 'monospace', marginBottom: 6 },
  launchCardName: { fontSize: 13, color: C.text, fontFamily: 'monospace', fontWeight: '700', marginBottom: 6 },
  launchCardField: { fontSize: 9, color: C.sub, letterSpacing: 2, fontFamily: 'monospace', marginTop: 4 },
  launchCardValue: { fontSize: 11, color: C.green, fontFamily: 'monospace', marginTop: 2 },
  // bags rate-limit modal
  modalOverlay: { flex: 1, backgroundColor: '#000000cc', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 6, padding: 20, width: '100%' },
  modalTitle: { color: C.amber, fontFamily: 'monospace', fontSize: 11, fontWeight: '700', letterSpacing: 2, marginBottom: 10 },
  modalBody: { color: C.sub, fontFamily: 'monospace', fontSize: 12, lineHeight: 18, marginBottom: 14 },
  modalInput: { backgroundColor: C.input, borderWidth: 1, borderColor: C.border, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 10, color: C.text, fontFamily: 'monospace', fontSize: 12, marginBottom: 16 },
  modalActions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  modalCancel: { paddingHorizontal: 14, paddingVertical: 10 },
  modalCancelText: { color: C.sub, fontFamily: 'monospace', fontSize: 11 },
  modalSave: { backgroundColor: C.green, borderRadius: 3, paddingHorizontal: 18, paddingVertical: 10 },
  modalSaveText: { color: '#000', fontFamily: 'monospace', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
});
