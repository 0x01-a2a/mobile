/**
 * App — root component for the 0x01 node app.
 *
 * On first launch, shows the OnboardingScreen (ZeroClaw agent brain setup).
 * After onboarding completes (or is skipped), saves the config and renders
 * the main AppNavigator.
 */
import React, { useEffect, useState, Component, ErrorInfo, ReactNode } from 'react';
import { StatusBar, View, Text, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation/AppNavigator';
import { OnboardingScreen, checkOnboardingDone } from './src/screens/Onboarding';
import { AgentBrainConfig, useAgentBrain } from './src/hooks/useAgentBrain';
import { useNode } from './src/hooks/useNode';

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
    // Log to console so logcat / Metro picks it up
    console.error('[ErrorBoundary]', error, info.componentStack);
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

// ── Node auto-starter ─────────────────────────────────────────────────────────
// Mounts useNode at the root level so the node (and ZeroClaw) starts
// automatically even when the user opens Chat before visiting My tab.

function NodeAutoStarter() {
  useNode();
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);
  const { save: saveBrain } = useAgentBrain();

  useEffect(() => {
    checkOnboardingDone().then(done => setOnboardingDone(done));
  }, []);

  const handleOnboardingDone = async (config: AgentBrainConfig | null) => {
    if (config) await saveBrain(config);
    setOnboardingDone(true);
  };

  // Still checking — render nothing (avoids flash)
  if (onboardingDone === null) {
    return <View style={s.splash} />;
  }

  if (!onboardingDone) {
    return (
      <ErrorBoundary>
        <SafeAreaProvider>
          <StatusBar barStyle="light-content" backgroundColor="#050505" />
          <OnboardingScreen onDone={handleOnboardingDone} />
        </SafeAreaProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor="#050505" />
        <NavigationContainer>
          <NodeAutoStarter />
          <AppNavigator />
        </NavigationContainer>
      </SafeAreaProvider>
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
