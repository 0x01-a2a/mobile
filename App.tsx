/**
 * App — root component for the 0x01 node app.
 *
 * On first launch, shows the OnboardingScreen (ZeroClaw agent brain setup).
 * After onboarding completes (or is skipped), saves the config and renders
 * the main AppNavigator.
 */
import React, { useEffect, useState } from 'react';
import { StatusBar, View, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation/AppNavigator';
import { OnboardingScreen, checkOnboardingDone } from './src/screens/Onboarding';
import { AgentBrainConfig, useAgentBrain } from './src/hooks/useAgentBrain';

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
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor="#050505" />
        <OnboardingScreen onDone={handleOnboardingDone} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#050505" />
      <NavigationContainer>
        <AppNavigator />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  splash: { flex: 1, backgroundColor: '#050505' },
});
