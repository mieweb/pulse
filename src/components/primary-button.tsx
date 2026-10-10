import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { ButtonHeight, CardShadow, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { Icon, type IconName } from './icon';
import { ThemedText } from './themed-text';

type Props = Omit<PressableProps, 'style' | 'children'> & {
  label: string;
  /** `filled`: the screen's main action, in the accent. `card`: its pair or an alternative. */
  variant?: 'filled' | 'card';
  icon?: IconName;
  /** Shows a spinner in place of the icon; the button stays pressable unless `disabled`. */
  busy?: boolean;
  /** Middle-truncates a long label (a server host) so its end stays readable. */
  truncateMiddle?: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * The app's one primary button: 52 pt tall (it grows with large text instead of clipping it),
 * radius 14, a semibold label. Paired actions sit side by side in one row, each with `flex: 1`
 * (export's Watch | Share link, On-device AI's Cancel | Use).
 */
export function PrimaryButton({
  label,
  variant = 'filled',
  icon,
  busy = false,
  truncateMiddle = false,
  disabled,
  style,
  ...rest
}: Props) {
  const theme = useTheme();
  const filled = variant === 'filled';
  const color = filled ? theme.onAccent : theme.text;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        filled ? { backgroundColor: theme.accent } : { backgroundColor: theme.card, ...CardShadow },
        disabled && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
      {...rest}>
      {busy ? (
        <ActivityIndicator color={color} />
      ) : (
        icon && <Icon name={icon} size={18} tintColor={color} scalesWithText />
      )}
      <ButtonLabel color={color} truncateMiddle={truncateMiddle}>
        {label}
      </ButtonLabel>
    </Pressable>
  );
}

function ButtonLabel({
  children,
  color,
  truncateMiddle,
}: {
  children: ReactNode;
  color: string;
  truncateMiddle: boolean;
}) {
  return (
    <ThemedText
      type="headline"
      numberOfLines={truncateMiddle ? 1 : 2}
      ellipsizeMode={truncateMiddle ? 'middle' : 'tail'}
      style={[styles.label, { color }]}>
      {children}
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    minHeight: ButtonHeight,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.button,
    borderCurve: 'continuous',
  },
  label: { flexShrink: 1, textAlign: 'center' },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.35 },
});
