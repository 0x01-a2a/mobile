/**
 * AppNavigator — bottom tab navigation for the 0x01 node app.
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { FeedScreen }     from '../screens/Feed';
import { AgentsScreen }   from '../screens/Agents';
import { ChatScreen }     from '../screens/Chat';
import { MyAgentScreen }  from '../screens/MyAgent';
import { SettingsScreen } from '../screens/Settings';

const Tab = createBottomTabNavigator();

const C = {
  bg:      '#0a0a0a',
  border:  '#1a1a1a',
  active:  '#00e676',
  inactive:'#444444',
};

const ICONS: Record<string, string> = {
  Feed:     '[~]',
  Agents:   '[@]',
  Chat:     '[>]',
  'My Node':'[*]',
  Settings: '[=]',
};

function TabIcon({ name, focused }: { name: string; focused: boolean }) {
  return (
    <Text style={[styles.icon, { color: focused ? C.active : C.inactive }]}>
      {ICONS[name]}
    </Text>
  );
}

export function AppNavigator() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: styles.tabBar,
        tabBarActiveTintColor:   C.active,
        tabBarInactiveTintColor: C.inactive,
        tabBarLabelStyle: styles.label,
        tabBarIcon: ({ focused }) => (
          <TabIcon name={route.name} focused={focused} />
        ),
      })}
    >
      <Tab.Screen name="Feed"     component={FeedScreen}    />
      <Tab.Screen name="Agents"   component={AgentsScreen}  />
      <Tab.Screen name="Chat"     component={ChatScreen}    />
      <Tab.Screen name="My Node"  component={MyAgentScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen}/>
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: C.bg,
    borderTopColor:  C.border,
    borderTopWidth:  1,
    paddingTop: 6,
    height: 60,
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
