/**
 * AppNavigator — bottom tab navigation for the 0x01 node app.
 *
 * Tabs: Earn | Chat | My | Settings
 */
import React from 'react';
import { StyleSheet, Text, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useTranslation } from 'react-i18next';
import { useLayout } from '../hooks/useLayout';

import { EarnScreen }     from '../screens/Earn';
import { ChatScreen }     from '../screens/Chat';
import { MyScreen }       from '../screens/My';
import { SettingsScreen } from '../screens/Settings';
import { useTheme, ThemeColors } from '../theme/ThemeContext';

const Tab = createBottomTabNavigator();

const ICONS: Record<string, string> = {
  Earn:     '[~]',
  Chat:     '[>]',
  My:       '[*]',
  Settings: '[=]',
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

const EarnIcon     = makeTabIcon('Earn');
const ChatIcon     = makeTabIcon('Chat');
const MyIcon       = makeTabIcon('My');
const SettingsIcon = makeTabIcon('Settings');

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
          tabBarPressColor: 'transparent',
          tabBarButton: (props) => (
            <Pressable
              {...props}
              android_ripple={null}
            />
          ),
        }}
      >
      <Tab.Screen name="Earn"     component={EarnScreen}     options={{ tabBarLabel: t('nav.earn'), tabBarIcon: EarnIcon }}     />
      <Tab.Screen name="Chat"     component={ChatScreen}     options={{ tabBarLabel: t('nav.chat'), tabBarIcon: ChatIcon }}     />
      <Tab.Screen name="My"       component={MyScreen}       options={{ tabBarLabel: t('nav.my'), tabBarIcon: MyIcon }}       />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarLabel: t('nav.settings'), tabBarIcon: SettingsIcon }} />
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
