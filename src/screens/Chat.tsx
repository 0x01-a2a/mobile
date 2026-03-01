/**
 * Chat — interactive chat with the local ZeroClaw agent brain.
 *
 * Only functional when the node is running with AGENT BRAIN enabled in
 * Settings. When the gateway is unreachable, send() surfaces an error
 * message inline so the user knows what to fix.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useZeroclawChat, ChatMessage } from '../hooks/useZeroclawChat';

const C = {
  bg:      '#050505',
  card:    '#0f0f0f',
  border:  '#1a1a1a',
  green:   '#00e676',
  dim:     '#1a2e1a',
  text:    '#ffffff',
  sub:     '#555555',
  red:     '#ff1744',
  input:   '#111111',
};

// ─── Message bubble ────────────────────────────────────────────────────────

function Bubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
  return (
    <View style={[s.bubbleRow, isUser ? s.rowRight : s.rowLeft]}>
      {!isUser && (
        <Text style={s.roleLabel}>[ZC]</Text>
      )}
      <View style={[s.bubble, isUser ? s.bubbleUser : s.bubbleAgent]}>
        <Text style={[s.bubbleText, isUser ? s.bubbleTextUser : undefined]}>
          {msg.text}
        </Text>
      </View>
      {isUser && (
        <Text style={s.roleLabel}>[YOU]</Text>
      )}
    </View>
  );
}

// ─── Main screen ───────────────────────────────────────────────────────────

export function ChatScreen() {
  const { messages, loading, error, send, resetSession } = useZeroclawChat();
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList>(null);

  // Scroll to bottom whenever messages change.
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

// ─── Styles ────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
  },
  header: {
    flexDirection:    'row',
    alignItems:       'center',
    justifyContent:   'space-between',
    paddingHorizontal: 16,
    paddingTop:       52,
    paddingBottom:    12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  headerTitle: {
    color:       C.green,
    fontFamily:  'monospace',
    fontSize:    13,
    fontWeight:  '700',
    letterSpacing: 2,
  },
  resetBtn: {
    paddingVertical:   4,
    paddingHorizontal: 8,
  },
  resetBtnText: {
    color:      C.sub,
    fontFamily: 'monospace',
    fontSize:   11,
  },
  listContent: {
    padding:    12,
    paddingBottom: 8,
    flexGrow:   1,
  },
  bubbleRow: {
    flexDirection: 'row',
    alignItems:    'flex-end',
    marginBottom:  10,
    gap:           6,
  },
  rowLeft:  { justifyContent: 'flex-start' },
  rowRight: { justifyContent: 'flex-end' },
  roleLabel: {
    color:      C.sub,
    fontFamily: 'monospace',
    fontSize:   9,
    marginBottom: 2,
  },
  bubble: {
    maxWidth:     '78%',
    borderRadius: 4,
    padding:      10,
  },
  bubbleUser: {
    backgroundColor: C.dim,
    borderWidth:     1,
    borderColor:     C.green,
  },
  bubbleAgent: {
    backgroundColor: C.card,
    borderWidth:     1,
    borderColor:     C.border,
  },
  bubbleText: {
    color:      C.text,
    fontFamily: 'monospace',
    fontSize:   13,
    lineHeight: 19,
  },
  bubbleTextUser: {
    color: C.green,
  },
  thinkingWrap: {
    padding: 12,
  },
  thinkingText: {
    color:      C.sub,
    fontFamily: 'monospace',
    fontSize:   12,
  },
  emptyWrap: {
    flex:            1,
    alignItems:      'center',
    justifyContent:  'center',
    paddingTop:      80,
  },
  emptyLine: {
    color:      C.sub,
    fontFamily: 'monospace',
    fontSize:   11,
    lineHeight: 17,
  },
  emptyHint: {
    color:      C.sub,
    fontFamily: 'monospace',
    fontSize:   12,
    textAlign:  'center',
  },
  errorBanner: {
    backgroundColor: '#1a0505',
    borderTopWidth:  1,
    borderTopColor:  C.red,
    padding:         12,
  },
  errorText: {
    color:      C.red,
    fontFamily: 'monospace',
    fontSize:   11,
    marginBottom: 2,
  },
  errorHint: {
    color:      C.sub,
    fontFamily: 'monospace',
    fontSize:   10,
  },
  inputRow: {
    flexDirection:    'row',
    alignItems:       'flex-end',
    padding:          12,
    borderTopWidth:   1,
    borderTopColor:   C.border,
    gap:              8,
  },
  input: {
    flex:            1,
    backgroundColor: C.input,
    borderWidth:     1,
    borderColor:     C.border,
    borderRadius:    4,
    paddingHorizontal: 12,
    paddingVertical:   10,
    color:           C.text,
    fontFamily:      'monospace',
    fontSize:        13,
    maxHeight:       120,
  },
  sendBtn: {
    backgroundColor: C.green,
    width:           44,
    height:          44,
    borderRadius:    4,
    alignItems:      'center',
    justifyContent:  'center',
  },
  sendBtnDisabled: {
    backgroundColor: C.border,
  },
  sendBtnText: {
    color:      '#000000',
    fontFamily: 'monospace',
    fontSize:   18,
    fontWeight: '700',
  },
});
