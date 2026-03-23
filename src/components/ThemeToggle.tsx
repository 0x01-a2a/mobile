import React from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeContext';

interface ThemeToggleProps {
  style?: any;
  /** Render as a half-circle tab on the right screen edge */
  halfCircle?: boolean;
  /** top offset for the half-circle (e.g. insets.top + 8) */
  top?: number;
}

export function ThemeToggle({ style, halfCircle, top = 0 }: ThemeToggleProps) {
  const { mode, setMode, colors } = useTheme();

  const handleToggle = () => {
    if (mode === 'system') setMode('light');
    else if (mode === 'light') setMode('dark');
    else setMode('system');
  };

  let icon = mode === 'light' ? '[L]' : mode === 'dark' ? '[D]' : '[S]';

  if (halfCircle) {
    return (
      <TouchableOpacity
        onPress={handleToggle}
        activeOpacity={0.7}
        style={[
          styles.halfCircle,
          {
            top,
            borderColor: colors.border,
            backgroundColor: colors.input,
          },
          style,
        ]}
      >
        <Text style={[styles.halfCircleText, { color: colors.text }]}>{icon}</Text>
      </TouchableOpacity>
    );
  }

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
  halfCircle: {
    position: 'absolute',
    right: 0,
    width: 28,
    height: 48,
    borderTopLeftRadius: 24,
    borderBottomLeftRadius: 24,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    borderWidth: 1,
    borderRightWidth: 0,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  halfCircleText: {
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
    marginLeft: -4,
  },
});
