/**
 * AppNavigator — bottom tab navigation for the 0x01 node app.
 *
 * Tabs: Today | Inbox | Chat | You
 */
import React from 'react';
import { StyleSheet, Text, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useTranslation } from 'react-i18next';
import { useLayout } from '../hooks/useLayout';

import TodayScreen        from '../screens/Today';
import InboxScreen        from '../screens/Inbox';
import { ChatScreen }     from '../screens/Chat';
import YouScreen          from '../screens/You';
import { useTheme, ThemeColors } from '../theme/ThemeContext';

const Tab = createBottomTabNavigator();

const ICONS: Record<string, string> = {
  Today: '[~]',
  Inbox: '[>]',
  Chat:  '[>]',
  You:   '[*]',
};

// Stable per-tab icon renderers defined at module scope to avoid
// re-creating inline components on every render (react/no-unstable-nested-components).
function makeTabIcon(name: string) {
  return function TabIconRenderer({ focused, color }: { focused: boolean; color: string }) {
    return (
      <Text style={[staticStyles.icon, { color }]}>
        {ICONS[name]}
      </Text>
    );
  };
}

const TodayIcon = makeTabIcon('Today');
const InboxIcon = makeTabIcon('Inbox');
const ChatIcon  = makeTabIcon('Chat');
const YouIcon   = makeTabIcon('You');

const SCREEN_OPTIONS = {
  headerShown: false,
} as const;

export function AppNavigator() {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useStyles(colors);
  const { isTablet, isLandscape } = useLayout();

  const bottomPad = insets.bottom || 8;
  const isWideMode = isTablet && isLandscape;
  const tabBarStyle = isWideMode
    ? [styles.tabBar, styles.tabBarSide, { paddingBottom: bottomPad }]
    : [styles.tabBar, { paddingBottom: bottomPad, height: 72 + (insets.bottom || 0) }];

  return (
      <Tab.Navigator
        screenOptions={{
          ...SCREEN_OPTIONS,
          tabBarStyle,
          tabBarPosition: isWideMode ? 'left' : 'bottom',
          tabBarActiveTintColor:   colors.green,
          tabBarInactiveTintColor: colors.sub,
          tabBarLabelStyle: isWideMode ? staticStyles.labelSide : staticStyles.label,
          tabBarIconStyle: isWideMode ? staticStyles.iconSide : undefined,
          tabBarButton: (props) => (
            <Pressable
              {...(props as any)}
              android_ripple={null}
            />
          ),
        }}
      >
      <Tab.Screen name="Today" component={TodayScreen} options={{ title: 'Today', tabBarLabel: 'Today', tabBarIcon: TodayIcon }} />
      <Tab.Screen name="Inbox" component={InboxScreen} options={{ title: 'Inbox', tabBarLabel: 'Inbox', tabBarIcon: InboxIcon }} />
      <Tab.Screen name="Chat"  component={ChatScreen}  options={{ title: 'Chat',  tabBarLabel: 'Chat',  tabBarIcon: ChatIcon  }} />
      <Tab.Screen name="You"   component={YouScreen}   options={{ title: 'You',   tabBarLabel: 'You',   tabBarIcon: YouIcon   }} />
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
  label: {
    fontSize: 10,
    letterSpacing: 1,
    fontFamily: 'monospace',
    marginBottom: 4,
  },
  labelSide: {
    fontSize: 9,
    letterSpacing: 1,
    fontFamily: 'monospace',
    marginTop: 4,
  },
  icon: {
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  iconSide: {
    fontSize: 16,
  },
});
