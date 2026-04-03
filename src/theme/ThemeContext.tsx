import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme, ColorSchemeName } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface ThemeColors {
  bg: string;
  card: string;
  border: string;
  green: string;
  red: string;
  amber: string;
  text: string;
  sub: string;
  dim: string;
  blue: string;
  input: string;
  inputBorder: string;
}

export const DarkTheme: ThemeColors = {
  bg: '#050505',
  card: '#0f0f0f',
  border: '#1a1a1a',
  green: '#00e676',
  red: '#ff1744',
  amber: '#ffc107',
  text: '#ffffff',
  sub: '#555555',
  dim: '#333333',
  blue: '#2979ff',
  input: '#111111',
  inputBorder: '#2a2a2a',
};

export const LightTheme: ThemeColors = {
  bg: '#f8f9fa',
  card: '#ffffff',
  border: '#e5e7eb',
  green: '#00c853',
  red: '#d50000',
  amber: '#f57f17',
  text: '#111827',
  sub: '#6b7280',
  dim: '#9ca3af',
  blue: '#2563eb',
  input: '#f3f4f6',
  inputBorder: '#d1d5db',
};

interface ThemeContextValue {
  colors: ThemeColors;
  isDark: boolean;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  colors: DarkTheme,
  isDark: true,
  mode: 'system',
  setMode: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const deviceTheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('zerox1:theme_mode').then((saved) => {
      if (saved === 'light' || saved === 'dark' || saved === 'system') {
        setModeState(saved);
      }
      setIsReady(true);
    });
  }, []);

  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    AsyncStorage.setItem('zerox1:theme_mode', newMode).catch(() => {});
  }, []);

  const isDark = mode === 'system' ? deviceTheme === 'dark' : mode === 'dark';
  const colors = isDark ? DarkTheme : LightTheme;

  const value = useMemo(
    () => ({ colors, isDark, mode, setMode }),
    [colors, isDark, mode, setMode],
  );

  // Wait until we load from storage so we don't flash the wrong theme
  if (!isReady) return null;

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
