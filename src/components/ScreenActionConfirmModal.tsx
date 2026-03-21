/**
 * ScreenActionConfirmModal — human-in-the-loop confirmation dialog for ASSISTED mode.
 *
 * Shown when the ZeroClaw agent requests a UI action (tap, global nav, notification reply)
 * and BuildConfig.POLICY_MODE = "ASSISTED". The native side blocks the IO thread for up to
 * 30 seconds waiting for a decision; this modal resolves it via NodeModule.confirmScreenAction.
 *
 * Renders as a bottom sheet over the current screen for the oldest pending action.
 * Multiple queued actions are shown as a counter badge.
 */
import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import {
  useScreenActionStore,
  useConfirmScreenAction,
  PendingScreenAction,
} from '../hooks/useScreenActions';

export function ScreenActionConfirmModal() {
  const queue = useScreenActionStore((s) => s.queue);
  const confirm = useConfirmScreenAction();

  // Always show the oldest pending action first.
  const action: PendingScreenAction | undefined = queue[0];

  if (!action) return null;

  const remaining = queue.length - 1;

  return (
    <Modal
      transparent
      animationType="slide"
      visible
      onRequestClose={() => confirm(action.id, false)}
    >
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <View style={s.header}>
            <Text style={s.title}>AGENT ACTION REQUEST</Text>
            {remaining > 0 && (
              <View style={s.badge}>
                <Text style={s.badgeText}>+{remaining}</Text>
              </View>
            )}
          </View>

          <Text style={s.endpoint}>{action.endpoint}</Text>
          <Text style={s.description}>{action.description}</Text>

          <Text style={s.hint}>
            The agent is waiting for your approval. No action will be taken if you
            reject or ignore (auto-rejected after 30 s).
          </Text>

          <View style={s.row}>
            <TouchableOpacity
              style={[s.btn, s.reject]}
              onPress={() => confirm(action.id, false)}
              activeOpacity={0.8}
            >
              <Text style={s.btnText}>REJECT</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.btn, s.approve]}
              onPress={() => confirm(action.id, true)}
              activeOpacity={0.8}
            >
              <Text style={s.btnText}>APPROVE</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#0f0f0f',
    borderTopWidth: 1,
    borderTopColor: '#ffc107',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: Platform.OS === 'ios' ? 36 : 20,
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  title: {
    color: '#ffc107',
    fontFamily: 'Courier New',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    flex: 1,
  },
  badge: {
    backgroundColor: '#ffc107',
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgeText: {
    color: '#000',
    fontFamily: 'Courier New',
    fontSize: 10,
    fontWeight: '700',
  },
  endpoint: {
    color: '#555',
    fontFamily: 'Courier New',
    fontSize: 11,
  },
  description: {
    color: '#ffffff',
    fontFamily: 'Courier New',
    fontSize: 13,
    lineHeight: 20,
  },
  hint: {
    color: '#555',
    fontFamily: 'Courier New',
    fontSize: 10,
    lineHeight: 16,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  btn: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
  },
  reject: {
    borderColor: '#ff1744',
    backgroundColor: 'rgba(255,23,68,0.08)',
  },
  approve: {
    borderColor: '#00e676',
    backgroundColor: 'rgba(0,230,118,0.08)',
  },
  btnText: {
    color: '#ffffff',
    fontFamily: 'Courier New',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
});
