/**
 * Inbox — real-time stream of inbound envelopes from the node WebSocket.
 */
import React, { useCallback, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { InboundEnvelope, useInbox } from '../hooks/useNodeApi';
import { useNode } from '../hooks/useNode';

const C = {
  bg:     '#050505',
  border: '#1a1a1a',
  text:   '#ffffff',
  sub:    '#555555',
};

const MSG_COLORS: Record<string, string> = {
  PROPOSE:  '#ffc107',
  COMMIT:   '#2196f3',
  SETTLE:   '#00e676',
  SLASH:    '#ff1744',
  BEACON:   '#9c27b0',
};

type TrackedEnvelope = InboundEnvelope & { key: string };

function EnvelopeRow({ item }: { item: TrackedEnvelope }) {
  const color = MSG_COLORS[item.msg_type] ?? '#666666';
  const sender =
    item.sender.length > 18
      ? `${item.sender.slice(0, 8)}...${item.sender.slice(-6)}`
      : item.sender;

  return (
    <View style={s.row}>
      <View style={[s.badge, { borderColor: color, backgroundColor: color + '18' }]}>
        <Text style={[s.badgeText, { color }]}>{item.msg_type}</Text>
      </View>
      <Text style={s.sender} numberOfLines={1}>{sender}</Text>
      <Text style={s.slot}>#{item.slot}</Text>
    </View>
  );
}

export function InboxScreen() {
  const { status } = useNode();
  const [messages, setMessages] = useState<TrackedEnvelope[]>([]);

  const onEnvelope = useCallback((env: InboundEnvelope) => {
    setMessages(prev => [
      { ...env, key: `${env.sender}-${env.slot}-${Date.now()}` },
      ...prev.slice(0, 199),           // keep last 200
    ]);
  }, []);

  useInbox(onEnvelope, status === 'running');

  return (
    <View style={s.root}>
      <Text style={s.heading}>INBOX</Text>

      {messages.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyText}>
            {status === 'running' ? 'Waiting for messages...' : 'Node is stopped'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={messages}
          keyExtractor={item => item.key}
          renderItem={({ item }) => <EnvelopeRow item={item} />}
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root:      { flex: 1, backgroundColor: C.bg },
  heading:   { fontSize: 11, color: C.sub, letterSpacing: 4, padding: 24, paddingBottom: 12 },
  empty:     { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { color: C.sub, fontSize: 14, fontFamily: 'monospace' },
  list:      { paddingHorizontal: 24 },
  row:       {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  badge:     {
    borderWidth: 1,
    borderRadius: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginRight: 12,
    minWidth: 76,
    alignItems: 'center',
  },
  badgeText: { fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  sender:    { flex: 1, color: C.text, fontFamily: 'monospace', fontSize: 13 },
  slot:      { color: C.sub, fontFamily: 'monospace', fontSize: 12 },
});
