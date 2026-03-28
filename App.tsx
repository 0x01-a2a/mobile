/**
 * App — root component for the 0x01 node app.
 *
 * On first launch, shows the OnboardingScreen (ZeroClaw agent brain setup).
 * After onboarding completes (or is skipped), saves the config and renders
 * the main AppNavigator.
 */
import React, { useEffect, useState, Component, ErrorInfo, ReactNode, createContext, useContext } from 'react';
import { StatusBar, View, Text, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Sentry from '@sentry/react-native';
import { AppNavigator } from './src/navigation/AppNavigator';
import { OnboardingScreen, checkOnboardingDone } from './src/screens/Onboarding';
import { AgentBrainConfig, useAgentBrain } from './src/hooks/useAgentBrain';
import { NodeProvider } from './src/hooks/useNode';
import { initI18n } from './src/i18n';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import { useScreenActionListener } from './src/hooks/useScreenActions';
import { ScreenActionConfirmModal } from './src/components/ScreenActionConfirmModal';

// Set SENTRY_DSN to your project's DSN from sentry.io to enable crash reporting.
// Leave empty to disable (safe for dev builds).
const SENTRY_DSN = '';
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    tracesSampleRate: 0.2,
    environment: __DEV__ ? 'development' : 'production',
  });
}

// ── Error boundary ────────────────────────────────────────────────────────────
// Catches uncaught render errors so the app shows a recovery screen instead
// of crashing entirely.  Without this, any render-time throw kills the app.

interface EBState { hasError: boolean; message: string }

class ErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): EBState {
    return { hasError: true, message: error?.message ?? 'Unknown error' };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
    if (SENTRY_DSN) Sentry.captureException(error, { extra: { componentStack: info.componentStack } });
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={s.errorContainer}>
          <Text style={s.errorTitle}>Something went wrong</Text>
          <Text style={s.errorMsg}>{this.state.message}</Text>
          <Text style={s.errorHint}>Restart the app to recover.</Text>
        </View>
      );
    }
    return this.props.children;
  }
}


// ─────────────────────────────────────────────────────────────────────────────

export const SignOutContext = createContext<() => void>(() => {});
export function useSignOut() { return useContext(SignOutContext); }

function ThemedStatusBar() {
  const { isDark, colors } = useTheme();
  return <StatusBar barStyle={isDark ? "light-content" : "dark-content"} backgroundColor={colors.bg} />;
}

/** Mounts the screen-action confirmation listener + modal (ASSISTED mode only). */
function ScreenActionGate() {
  useScreenActionListener();
  return <ScreenActionConfirmModal />;
}

export default function App() {
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);
  const [i18nReady, setI18nReady] = useState(false);
  const { save: saveBrain } = useAgentBrain();

  useEffect(() => {
    initI18n().then(() => setI18nReady(true)).catch(() => setI18nReady(true));
    checkOnboardingDone().then(done => setOnboardingDone(done));
  }, []);

  const handleOnboardingDone = async (config: AgentBrainConfig | null) => {
    if (config) await saveBrain(config);
    setOnboardingDone(true);
  };

  // Still checking — render nothing (avoids flash)
  if (onboardingDone === null || !i18nReady) {
    return <View style={s.splash} />;
  }

  if (!onboardingDone) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <SafeAreaProvider>
            <ThemedStatusBar />
            <OnboardingScreen onDone={handleOnboardingDone} />
          </SafeAreaProvider>
        </ThemeProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <SafeAreaProvider>
          <ThemedStatusBar />
          <SignOutContext.Provider value={() => setOnboardingDone(false)}>
            <NavigationContainer>
              <NodeProvider>
                <AppNavigator />
                <ScreenActionGate />
              </NodeProvider>
            </NavigationContainer>
          </SignOutContext.Provider>
        </SafeAreaProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

const s = StyleSheet.create({
  splash: { flex: 1, backgroundColor: '#050505' },
  errorContainer: {
    flex: 1,
    backgroundColor: '#050505',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  errorTitle: { color: '#ff4444', fontSize: 18, fontWeight: '700', marginBottom: 12 },
  errorMsg:   { color: '#aaa', fontSize: 13, textAlign: 'center', marginBottom: 16 },
  errorHint:  { color: '#555', fontSize: 12 },
});
