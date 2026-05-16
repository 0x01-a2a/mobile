/**
 * AppNavigator — bottom tab navigation for the 0x01 node app.
 *
 * Tabs: Today | Inbox | Fleet | Chat | You
 */
import React from 'react';
import { StyleSheet, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useTranslation } from 'react-i18next';
import { useLayout } from '../hooks/useLayout';

import TodayScreen        from '../screens/Today';
import InboxScreen        from '../screens/Inbox';
import FleetScreen        from '../screens/Fleet';
import { ChatScreen }     from '../screens/Chat';
import YouScreen          from '../screens/You';
import { useTheme, ThemeColors } from '../theme/ThemeContext';
import { useLiveActivity } from '../hooks/useLiveActivity';

const Tab = createBottomTabNavigator();

// Stable tab button renderer — defined at module scope so it is never recreated
// and does not cause unnecessary tab bar re-renders.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TabButton(props: any) {
  return <Pressable {...(props as any)} android_ripple={null} />;
}

const SCREEN_OPTIONS = {
  headerShown: false,
} as const;

function TabDot({ focused, color }: { focused: boolean; color: string }) {
  return (
    <View style={{
      width: 14, height: 2, borderRadius: 1,
      backgroundColor: focused ? color : 'transparent',
      marginBottom: 1,
    }} />
  );
}

export function AppNavigator() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useStyles(colors);
  const { isTablet, isLandscape } = useLayout();
  const { t } = useTranslation();

  // Manage Dynamic Island / Lock Screen Live Activity for agent state.
  useLiveActivity();

  const bottomPad = insets.bottom || 8;
  const isWideMode = isTablet && isLandscape;
  const tabBarStyle = isWideMode
    ? [styles.tabBar, styles.tabBarSide, { paddingBottom: bottomPad }]
    : [styles.tabBar, { paddingBottom: bottomPad, height: 56 + (insets.bottom || 0) }];

  return (
      <Tab.Navigator
        screenOptions={{
          ...SCREEN_OPTIONS,
          tabBarStyle,
          tabBarPosition: isWideMode ? 'left' : 'bottom',
          tabBarActiveTintColor:   colors.green,
          tabBarInactiveTintColor: colors.sub,
          tabBarLabelStyle: isWideMode ? staticStyles.labelSide : staticStyles.label,
          tabBarItemStyle: staticStyles.tabItem,
          tabBarIconStyle: staticStyles.tabIcon,
          tabBarButton: TabButton,
          tabBarIcon: ({ focused, color }) => <TabDot focused={focused} color={color} />,
        }}
      >
      <Tab.Screen name="Today" component={TodayScreen} options={{ title: t('nav.today'), tabBarLabel: t('nav.today') }} />
      <Tab.Screen name="Inbox" component={InboxScreen} options={{ title: t('nav.inbox'), tabBarLabel: t('nav.inbox') }} />
      <Tab.Screen name="Fleet" component={FleetScreen} options={{ title: t('nav.fleet'), tabBarLabel: t('nav.fleet') }} />
      <Tab.Screen name="Chat"  component={ChatScreen}  options={{ title: t('nav.chat'),  tabBarLabel: t('nav.chat')  }} />
      <Tab.Screen name="You"   component={YouScreen}   options={{ title: t('nav.you'),   tabBarLabel: t('nav.you')   }} />
    </Tab.Navigator>
  );
}

function useStyles(colors: ThemeColors) {
  return React.useMemo(() => StyleSheet.create({
    tabBar: {
      backgroundColor: colors.bg,
      borderTopColor:  colors.border,
      borderTopWidth:  1,
      paddingTop: 6,
    },
    tabBarSide: {
      borderTopWidth: 0,
      borderRightWidth: 1,
      borderRightColor: colors.border,
      paddingTop: 16,
      width: 100,
    },
  }), [colors]);
}

const staticStyles = StyleSheet.create({
  tabItem: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 0,
    paddingBottom: 0,
  },
  tabIcon: {
    marginBottom: 0,
    marginTop: 4,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textAlign: 'center',
    marginBottom: 0,
    marginTop: 2,
  },
  labelSide: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    textAlign: 'center',
    marginTop: 0,
    marginBottom: 0,
  },
  iconSide: {
    fontSize: 16,
  },
});
