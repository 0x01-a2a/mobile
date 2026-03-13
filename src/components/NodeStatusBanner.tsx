/**
 * NodeStatusBanner — sticky top banner shown when the node is offline or starting.
 *
 * Renders nothing when status=running AND the local API is reachable.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useNode } from '../hooks/useNode';
import { useNodeHealth } from '../hooks/useNodeApi';

export function NodeStatusBanner() {
  const { status } = useNode();
  const { reachable, offline } = useNodeHealth();
  const navigation = useNavigation<any>();

  if (status === 'running' && reachable) return null;

  const isStarting = status === 'running' && !reachable && !offline;
  const isOffline  = offline;

  const label = isOffline
    ? '[ no internet ]'
    : isStarting
    ? '[ starting… ]'
    : '[ node offline ]';

  return (
    <View style={[s.banner, isOffline ? s.bannerOffline : isStarting ? s.bannerStarting : s.bannerStopped]}>
      <Text style={s.text}>{label}</Text>
      {!isStarting && !isOffline && (
        <TouchableOpacity onPress={() => navigation.navigate('My')} hitSlop={{ top: 8, bottom: 8, left: 16, right: 16 }}>
          <Text style={s.action}>START →</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  bannerStopped:  { backgroundColor: '#1a0505', borderBottomWidth: 1, borderBottomColor: '#ff174440' },
  bannerStarting: { backgroundColor: '#0a0a05', borderBottomWidth: 1, borderBottomColor: '#ffc10740' },
  bannerOffline:  { backgroundColor: '#050a1a', borderBottomWidth: 1, borderBottomColor: '#2979ff40' },
  text: { fontSize: 10, fontFamily: 'monospace', letterSpacing: 2, color: '#888' },
  action: { fontSize: 10, fontFamily: 'monospace', letterSpacing: 2, color: '#00e676', fontWeight: '700' },
});
