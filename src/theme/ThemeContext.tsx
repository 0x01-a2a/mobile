import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
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

// Pilot accent: replaces green across the entire UI for 01PL holders.
export const PILOT_ACCENT = '#f59e0b';

function applyPilotAccent(base: ThemeColors): ThemeColors {
  return { ...base, green: PILOT_ACCENT, amber: PILOT_ACCENT };
}

interface ThemeContextValue {
  colors: ThemeColors;
  isDark: boolean;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  /** True when the 01PL Pilot Mode gold accent is active. */
  pilotMode: boolean;
  /** Enable or disable Pilot Mode gold accent. Only call when user is eligible. */
  setPilotMode: (enabled: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  colors: DarkTheme,
  isDark: true,
  mode: 'system',
  setMode: () => {},
  pilotMode: false,
  setPilotMode: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const deviceTheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [pilotMode, setPilotModeState] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem('zerox1:theme_mode'),
      AsyncStorage.getItem('zerox1:pilot_mode'),
    ]).then(([savedMode, savedPilot]) => {
      if (savedMode === 'light' || savedMode === 'dark' || savedMode === 'system') {
        setModeState(savedMode);
      }
      if (savedPilot === 'true') setPilotModeState(true);
      setIsReady(true);
    });
  }, []);

  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    AsyncStorage.setItem('zerox1:theme_mode', newMode).catch(() => {});
  }, []);

  const setPilotMode = useCallback((enabled: boolean) => {
    setPilotModeState(enabled);
    AsyncStorage.setItem('zerox1:pilot_mode', enabled ? 'true' : 'false').catch(() => {});
  }, []);

  const isDark = mode === 'system' ? deviceTheme === 'dark' : mode === 'dark';
  const baseColors = isDark ? DarkTheme : LightTheme;
  const colors = pilotMode ? applyPilotAccent(baseColors) : baseColors;

  const value = useMemo(
    () => ({ colors, isDark, mode, setMode, pilotMode, setPilotMode }),
    [colors, isDark, mode, setMode, pilotMode, setPilotMode],
  );

  // Wait until we load from storage so we don't flash the wrong theme.
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
