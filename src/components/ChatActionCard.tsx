/**
 * ChatActionCard — a structured action card rendered inside the Chat tab.
 *
 * Used for flows that require user steps to complete a feature setup,
 * e.g. MoltBook claim, Farcaster verify, permission grants, update prompts.
 *
 * Anatomy:
 *   ┌──────────────────────────────────┐
 *   │ [icon]  Title                 [×]│  ← header
 *   │         Subtitle                 │
 *   ├──────────────────────────────────┤
 *   │  description text (optional)     │  ← body
 *   │                                  │
 *   │  [1] Step label               →  │  ← steps (tappable rows)
 *   │      step detail                 │
 *   │  [2] Step label               →  │
 *   │      step detail                 │
 *   │                                  │
 *   │  [ Primary button             ]  │  ← buttons
 *   │  [ Secondary button           ]  │
 *   │                                  │
 *   │  status message                  │  ← status
 *   └──────────────────────────────────┘
 */

import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../theme/ThemeContext';

// ── Types ─────────────────────────────────────────────────────────────────

export interface ChatActionStep {
  label: string;
  detail?: string;
  onPress: () => void;
  completed?: boolean;
}

export interface ChatActionButton {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  /** Defaults to 'primary' */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}

export interface ChatActionCardProps {
  /** Emoji or short glyph displayed in the header badge */
  icon: string;
  /**
   * Left-border accent colour for this card type.
   * Defaults to the theme blue.
   */
  accentColor?: string;
  title: string;
  subtitle?: string;
  /** Optional body copy above the step list */
  description?: string;
  steps?: ChatActionStep[];
  buttons?: ChatActionButton[];
  /** Short status message shown below the buttons */
  statusMessage?: string;
  statusType?: 'error' | 'success' | 'info';
  /** Renders a dismiss (×) button in the top-right corner */
  onDismiss?: () => void;
  style?: ViewStyle;
}

// ── Component ──────────────────────────────────────────────────────────────

export function ChatActionCard({
  icon,
  accentColor,
  title,
  subtitle,
  description,
  steps,
  buttons,
  statusMessage,
  statusType = 'error',
  onDismiss,
  style,
}: ChatActionCardProps) {
  const { colors, isDark } = useTheme();
  const accent = accentColor ?? colors.blue;

  const statusColor =
    statusType === 'success' ? colors.green :
    statusType === 'info'    ? colors.blue  :
    colors.red;

  return (
    <View style={[styles.card, {
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderLeftColor: accent,
    }, style]}>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={[styles.iconBadge, { backgroundColor: accent + '22' }]}>
          <Text style={styles.iconText}>{icon}</Text>
        </View>

        <View style={styles.headerText}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: colors.sub }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        {onDismiss ? (
          <TouchableOpacity
            onPress={onDismiss}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={styles.dismissBtn}
          >
            <Text style={[styles.dismissText, { color: colors.sub }]}>✕</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <View style={styles.body}>
        {description ? (
          <Text style={[styles.description, { color: colors.sub }]}>
            {description}
          </Text>
        ) : null}

        {/* Steps */}
        {steps && steps.length > 0 ? (
          <View style={[styles.stepsWrap, description ? styles.stepsMarginTop : null]}>
            {steps.map((step, i) => (
              <TouchableOpacity
                key={i}
                onPress={step.onPress}
                activeOpacity={0.7}
                style={[styles.stepRow, {
                  backgroundColor: isDark ? '#0a0a0a' : colors.input,
                  borderColor: step.completed ? accent + '55' : colors.border,
                }]}
              >
                {/* Number badge */}
                <View style={[styles.stepBadge, {
                  backgroundColor: step.completed ? accent + '33' : colors.dim,
                }]}>
                  {step.completed ? (
                    <Text style={[styles.stepBadgeText, { color: accent }]}>✓</Text>
                  ) : (
                    <Text style={[styles.stepBadgeText, { color: colors.sub }]}>
                      {i + 1}
                    </Text>
                  )}
                </View>

                {/* Text */}
                <View style={styles.stepText}>
                  <Text style={[styles.stepLabel, {
                    color: step.completed ? colors.sub : colors.text,
                    textDecorationLine: step.completed ? 'line-through' : 'none',
                  }]}>
                    {step.label}
                  </Text>
                  {step.detail ? (
                    <Text style={[styles.stepDetail, { color: colors.sub }]}>
                      {step.detail}
                    </Text>
                  ) : null}
                </View>

                {/* Arrow */}
                {!step.completed ? (
                  <Text style={[styles.stepArrow, { color: colors.dim }]}>›</Text>
                ) : null}
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {/* Buttons */}
        {buttons && buttons.length > 0 ? (
          <View style={[styles.buttonsWrap,
            (steps && steps.length > 0) || description ? styles.buttonsMarginTop : null,
          ]}>
            {buttons.map((btn, i) => (
              <ActionButton
                key={i}
                btn={btn}
                accent={accent}
                colors={colors}
              />
            ))}
          </View>
        ) : null}

        {/* Status message */}
        {statusMessage ? (
          <Text style={[styles.statusMsg, { color: statusColor }]}>
            {statusMessage}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// ── ActionButton sub-component ─────────────────────────────────────────────

function ActionButton({
  btn,
  accent,
  colors,
}: {
  btn: ChatActionButton;
  accent: string;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const variant = btn.variant ?? 'primary';
  const isDisabled = btn.disabled || btn.loading;

  const bgColor =
    variant === 'primary'   ? (isDisabled ? colors.dim : accent) :
    variant === 'danger'    ? (isDisabled ? colors.dim : colors.red) :
    variant === 'secondary' ? colors.input :
    'transparent';

  const textColor =
    variant === 'primary' || variant === 'danger' ? '#ffffff' :
    variant === 'secondary'                       ? colors.text :
    colors.sub;

  const borderColor =
    variant === 'ghost'     ? colors.border :
    variant === 'secondary' ? colors.border :
    'transparent';

  return (
    <TouchableOpacity
      onPress={btn.onPress}
      disabled={isDisabled}
      activeOpacity={0.75}
      style={[styles.btn, {
        backgroundColor: bgColor,
        borderColor,
        borderWidth: variant === 'ghost' || variant === 'secondary' ? 1 : 0,
        opacity: isDisabled && variant !== 'primary' && variant !== 'danger' ? 0.5 : 1,
      }]}
    >
      {btn.loading ? (
        <ActivityIndicator size="small" color={textColor} />
      ) : (
        <Text style={[styles.btnText, { color: textColor }]}>{btn.label}</Text>
      )}
    </TouchableOpacity>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderLeftWidth: 3,
    overflow: 'hidden',
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  iconBadge: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  iconText: {
    fontSize: 17,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  subtitle: {
    fontSize: 11,
  },
  dismissBtn: {
    paddingLeft: 6,
  },
  dismissText: {
    fontSize: 14,
    fontWeight: '300',
  },

  // Body
  body: {
    padding: 14,
  },
  description: {
    fontSize: 12,
    lineHeight: 18,
  },

  // Steps
  stepsWrap: {
    gap: 6,
  },
  stepsMarginTop: {
    marginTop: 12,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  stepBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  stepBadgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  stepText: {
    flex: 1,
    gap: 2,
  },
  stepLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  stepDetail: {
    fontSize: 11,
    lineHeight: 15,
  },
  stepArrow: {
    fontSize: 20,
    fontWeight: '300',
    marginTop: -1,
  },

  // Buttons
  buttonsWrap: {
    gap: 7,
  },
  buttonsMarginTop: {
    marginTop: 12,
  },
  btn: {
    borderRadius: 9,
    paddingVertical: 11,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  btnText: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.1,
  },

  // Status
  statusMsg: {
    fontSize: 11,
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 16,
  },
});
