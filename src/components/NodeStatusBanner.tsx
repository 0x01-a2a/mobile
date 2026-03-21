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
import { useTranslation } from 'react-i18next';
import { useTheme, ThemeColors } from '../theme/ThemeContext';

export function NodeStatusBanner() {
  const { status } = useNode();
  const { reachable, offline } = useNodeHealth();
  const navigation = useNavigation<any>();
  const { t } = useTranslation();
  const { colors, isDark } = useTheme();
  const s = useStyles(colors, isDark);

  if (status === 'running' && reachable) return null;

  const isStarting = status === 'running' && !reachable && !offline;
  const isOffline  = offline;

  const label = isOffline
    ? t('banner.noInternet')
    : isStarting
    ? t('banner.starting')
    : t('banner.nodeOffline');

  return (
    <View style={[s.banner, isOffline ? s.bannerOffline : isStarting ? s.bannerStarting : s.bannerStopped]}>
      <Text style={s.text}>{label}</Text>
      {!isStarting && !isOffline && (
        <TouchableOpacity onPress={() => navigation.navigate('My')} hitSlop={{ top: 8, bottom: 8, left: 16, right: 16 }}>
          <Text style={s.action}>{t('banner.start')}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function useStyles(colors: ThemeColors, isDark: boolean) {
  return React.useMemo(() => StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 6,
    },
    bannerStopped:  { backgroundColor: isDark ? '#1a0505' : '#fee2e2', borderBottomWidth: 1, borderBottomColor: colors.red + '40' },
    bannerStarting: { backgroundColor: isDark ? '#0a0a05' : '#fef3c7', borderBottomWidth: 1, borderBottomColor: colors.amber + '40' },
    bannerOffline:  { backgroundColor: isDark ? '#050a1a' : '#dbeafe', borderBottomWidth: 1, borderBottomColor: '#2979ff40' },
    text: { fontSize: 10, fontFamily: 'monospace', letterSpacing: 2, color: colors.sub },
    action: { fontSize: 10, fontFamily: 'monospace', letterSpacing: 2, color: colors.green, fontWeight: '700' },
  }), [colors, isDark]);
}

