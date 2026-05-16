/**
 * App — root component for the 0x01 node app.
 *
 * On first launch, shows the OnboardingScreen (ZeroClaw agent brain setup).
 * After onboarding completes (or is skipped), saves the config and renders
 * the main AppNavigator.
 */
import React, { useEffect, useState, Component, ErrorInfo, ReactNode, createContext, useContext } from 'react';
import { StatusBar, View, Text, StyleSheet, Linking, Alert } from 'react-native';
import { LaunchScreen } from './src/components/LaunchScreen';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation/AppNavigator';
import { OnboardingScreen, checkOnboardingDone } from './src/screens/Onboarding';
import { AgentBrainConfig, useAgentBrain } from './src/hooks/useAgentBrain';
import { NodeProvider } from './src/hooks/useNode';
import { AudioMuteProvider } from './src/hooks/useAudioMute.tsx';
import { initI18n } from './src/i18n';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import { useScreenActionListener } from './src/hooks/useScreenActions';
import { ScreenActionConfirmModal } from './src/components/ScreenActionConfirmModal';
import { useIdentity, useOwnReel, skillInstallUrl } from './src/hooks/useNodeApi';

// ── Deep link config for Agent Presence notification actions ──────────────────
// zerox1://chat             → Chat tab (normal chat)
// zerox1://chat?initialMode=brief → Chat tab with initialMode='brief'
// zerox1://today            → Today tab
const DEEP_LINKING = {
  prefixes: ['zerox1://'],
  config: {
    screens: {
      Today: {
        path: 'today',
      },
      Chat: {
        path: 'chat',
        parse: {
          initialMode: (m: string) => m || 'chat',
        },
      },
    },
  },
};

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

/**
 * Polls own agent's reel URL and saves newly generated reels to the camera roll.
 * Renders nothing — side-effect only.
 */
function ReelWatcher() {
  const identity = useIdentity();
  useOwnReel(identity?.agent_id ?? null);
  return null;
}

export default function App() {
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);
  const [i18nReady, setI18nReady] = useState(false);
  const [launchDone, setLaunchDone] = useState(false);
  const { save: saveBrain } = useAgentBrain();

  useEffect(() => {
    initI18n().then(() => setI18nReady(true)).catch(() => setI18nReady(true));
    checkOnboardingDone().then(done => setOnboardingDone(done));
  }, []);

  useEffect(() => {
    const parseSkillDeepLink = (url: string): { name: string; tomlUrl: string } | null => {
      if (!url.includes('zerox1://skill/install')) return null;
      const qs = url.split('?')[1] ?? '';
      const params: Record<string, string> = {};
      qs.split('&').forEach(pair => {
        const [k, ...rest] = pair.split('=');
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(rest.join('='));
      });
      return params.name && params.url ? { name: params.name, tomlUrl: params.url } : null;
    };

    const handleSkillDeepLink = (url: string) => {
      const parsed = parseSkillDeepLink(url);
      if (!parsed) return;
      Alert.alert(
        'Install Skill',
        `Install "${parsed.name}"?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Install',
            onPress: async () => {
              try {
                await skillInstallUrl(parsed.name, parsed.tomlUrl);
                Alert.alert('Installed', `"${parsed.name}" is ready. Reload skills to activate.`);
              } catch (e: any) {
                Alert.alert('Install failed', e?.message ?? 'Make sure your node is running.');
              }
            },
          },
        ],
      );
    };

    Linking.getInitialURL().then(url => { if (url) handleSkillDeepLink(url); }).catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => handleSkillDeepLink(url));
    return () => sub.remove();
  }, []);

  const handleOnboardingDone = async (config: AgentBrainConfig | null) => {
    if (config) await saveBrain(config);
    setOnboardingDone(true);
  };

  // Show launch animation until both it finishes AND async checks are done
  if (!launchDone || onboardingDone === null || !i18nReady) {
    return <LaunchScreen onDone={() => setLaunchDone(true)} />;
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
            <NavigationContainer linking={DEEP_LINKING}>
              <NodeProvider>
                <AudioMuteProvider>
                  <AppNavigator />
                  <ScreenActionGate />
                  <ReelWatcher />
                </AudioMuteProvider>
              </NodeProvider>
            </NavigationContainer>
          </SignOutContext.Provider>
        </SafeAreaProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

const s = StyleSheet.create({
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
