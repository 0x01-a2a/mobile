/**
 * AppNavigator — bottom tab navigation for the 0x01 node app.
 *
 * Tabs: Earn | Chat | My | Settings
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { EarnScreen }     from '../screens/Earn';
import { ChatScreen }     from '../screens/Chat';
import { MyScreen }       from '../screens/My';
import { SettingsScreen } from '../screens/Settings';

const Tab = createBottomTabNavigator();

const C = {
  bg:       '#0a0a0a',
  border:   '#1a1a1a',
  active:   '#00e676',
  inactive: '#444444',
};

const ICONS: Record<string, string> = {
  Earn:     '[~]',
  Chat:     '[>]',
  My:       '[*]',
  Settings: '[=]',
};

// Stable per-tab icon renderers defined at module scope to avoid
// re-creating inline components on every render (react/no-unstable-nested-components).
function makeTabIcon(name: string) {
  return function TabIconRenderer({ focused }: { focused: boolean }) {
    return (
      <Text style={[styles.icon, { color: focused ? C.active : C.inactive }]}>
        {ICONS[name]}
      </Text>
    );
  };
}

const EarnIcon     = makeTabIcon('Earn');
const ChatIcon     = makeTabIcon('Chat');
const MyIcon       = makeTabIcon('My');
const SettingsIcon = makeTabIcon('Settings');

const SCREEN_OPTIONS = {
  headerShown: false,
} as const;

export function AppNavigator() {
  const insets = useSafeAreaInsets();
  const bottomPad = insets.bottom || 8;
  const tabBarStyle = [styles.tabBar, { paddingBottom: bottomPad, height: 72 + (insets.bottom || 0) }];

  return (
    <Tab.Navigator
      screenOptions={{
        ...SCREEN_OPTIONS,
        tabBarStyle,
        tabBarActiveTintColor:   C.active,
        tabBarInactiveTintColor: C.inactive,
        tabBarLabelStyle: styles.label,
      }}
    >
      <Tab.Screen name="Earn"     component={EarnScreen}     options={{ tabBarIcon: EarnIcon }}     />
      <Tab.Screen name="Chat"     component={ChatScreen}     options={{ tabBarIcon: ChatIcon }}     />
      <Tab.Screen name="My"       component={MyScreen}       options={{ tabBarIcon: MyIcon }}       />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarIcon: SettingsIcon }} />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: C.bg,
    borderTopColor:  C.border,
    borderTopWidth:  1,
    paddingTop: 6,
    height: 72,
  },
  label: {
    fontSize: 10,
    letterSpacing: 1,
    fontFamily: 'monospace',
    marginBottom: 4,
  },
  icon: {
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
});
