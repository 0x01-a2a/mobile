import React from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeContext';

export function ThemeToggle({ style }: { style?: any }) {
  const { mode, setMode, colors } = useTheme();

  const handleToggle = () => {
    if (mode === 'system') setMode('light');
    else if (mode === 'light') setMode('dark');
    else setMode('system');
  };

  let icon = '[S]';
  if (mode === 'light') icon = '[L]';
  if (mode === 'dark') icon = '[D]';

  return (
    <TouchableOpacity
      onPress={handleToggle}
      style={[styles.btn, { borderColor: colors.border, backgroundColor: colors.input }, style]}
      activeOpacity={0.7}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
    >
      <Text style={[styles.text, { color: colors.text }]}>{icon}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  text: {
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
});
