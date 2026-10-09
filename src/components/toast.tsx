import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useEffect, useMemo, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Spacing, SystemColors } from '@/constants/theme';
import { useTheme, useThemeMode } from '@/hooks/use-theme';

import { Icon, type IconName } from './icon';
import { ThemedText } from './themed-text';

/**
 * - `success`: something finished as asked (saved, copied, connected).
 * - `info`: worth knowing, nothing to do (a link pairing without asking, a setting applied).
 * - `warning`: it worked, but not all of it (some clips skipped).
 * - `error`: it didn't happen; the detail line says what to do next.
 */
export type ToastKind = 'success' | 'info' | 'warning' | 'error';

export type ToastAction = { label: string; onPress: () => void };

export type ToastContent = {
  kind: ToastKind;
  /** What happened, in a few words ("Saved to Photos"). */
  title: string;
  /** Optional second line: the detail or the next step ("Scan a new link to try again."). */
  message?: string;
  /** Optional button at the end ("Undo", "Retry"); tapping it also dismisses the toast. */
  action?: ToastAction;
};

const ICONS: Record<ToastKind, IconName> = {
  success: 'checkmark.circle.fill',
  info: 'info.circle',
  warning: 'exclamationmark.triangle.fill',
  error: 'xmark.circle.fill',
};

function iconColor(kind: ToastKind, mode: 'light' | 'dark'): string {
  switch (kind) {
    case 'success':
      return SystemColors.green[mode];
    case 'info':
      return SystemColors.blue[mode];
    case 'warning':
      return SystemColors.orange[mode];
    case 'error':
      return SystemColors.red[mode];
  }
}

/** A static capability (iOS 26 + build SDK), read once, per the expo-glass-effect docs. */
const LIQUID_GLASS = isLiquidGlassAvailable();

/**
 * The glass's tint: the surface color, mostly opaque. Plain glass shows whatever is behind it
 * (thumbnails, the camera) through the text; this frosts it so the toast reads on anything,
 * while keeping the glass edge and light.
 */
/** Far enough above the safe area to start (and leave) fully off screen. */
const OFFSCREEN = 160;
/** An upward drag past this (pt), or a flick faster than this (pt/ms), swipes the toast away. */
const SWIPE_DISTANCE = 24;
const SWIPE_VELOCITY = 0.4;
/** Pulling it down moves it this fraction of the drag: it gives, but doesn't follow. */
const PULL_DOWN_RESISTANCE = 0.2;

const FROST = { light: 'rgba(255,255,255,0.78)', dark: 'rgba(28,28,30,0.78)' } as const;

/**
 * A single transient banner below the top safe area: a colored icon for the kind, a bold title,
 * an optional detail line and action. Liquid Glass on iOS 26, a raised card elsewhere. Tap to
 * dismiss, or swipe it up; a finger on it holds it. Purely presentational — `ToastProvider` owns the timing and which toast is up;
 * `leaving` plays the exit before it unmounts.
 */
export function Toast({
  content,
  leaving,
  onDismiss,
  onHold,
  onRelease,
}: {
  content: ToastContent;
  leaving: boolean;
  onDismiss: () => void;
  /** A finger is on the toast: hold it up. */
  onHold: () => void;
  /** The finger let go without dismissing it. */
  onRelease: () => void;
}) {
  const theme = useTheme();
  const mode = useThemeMode();
  const insets = useSafeAreaInsets();
  const { kind, title, message, action } = content;
  // `Animated.Value` is mutable and meant to be read during render (its whole purpose is to
  // drive a style prop) — a lazy `useState` initializer holds it without re-creating it on every
  // render, whereas `useRef` is reserved for values that should never be read during render.
  const [progress] = useState(() => new Animated.Value(0));
  // The swipe's offset, on top of the slide in and out.
  const [drag] = useState(() => new Animated.Value(0));

  // Swipe up to dismiss. Only a vertical drag claims the touch, so a tap still reaches the
  // toast (dismiss) and its action button. The provider's callbacks are stable, so this is made
  // once per toast.
  const swipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
          Math.abs(g.dy) > 4 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderGrant: () => onHold(),
        onPanResponderMove: (_, g) => drag.setValue(g.dy < 0 ? g.dy : g.dy * PULL_DOWN_RESISTANCE),
        onPanResponderRelease: (_, g) => {
          if (g.dy < -SWIPE_DISTANCE || g.vy < -SWIPE_VELOCITY) {
            onDismiss();
          } else {
            Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 6 }).start();
            onRelease();
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start();
          onRelease();
        },
      }),
    [drag, onDismiss, onHold, onRelease],
  );

  useEffect(() => {
    Animated.spring(progress, {
      toValue: leaving ? 0 : 1,
      useNativeDriver: true,
      ...(leaving ? { speed: 40, bounciness: 0 } : { speed: 18, bounciness: 6 }),
    }).start();
  }, [progress, leaving]);

  // Screen readers hear it once, as it appears.
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(message ? `${title}. ${message}` : title);
  }, [title, message]);

  const body = (
    <>
      <Icon name={ICONS[kind]} size={22} tintColor={iconColor(kind, mode)} />
      <View style={styles.text}>
        <ThemedText type="headline" numberOfLines={2}>
          {title}
        </ThemedText>
        {message && (
          <ThemedText type="subheadline" themeColor="textSecondary" numberOfLines={2}>
            {message}
          </ThemedText>
        )}
      </View>
      {action && (
        <Pressable
          onPress={() => {
            action.onPress();
            onDismiss();
          }}
          hitSlop={Spacing.two}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.action,
            { backgroundColor: theme.backgroundSelected },
            pressed && styles.pressed,
          ]}>
          <ThemedText type="subheadline" themeColor="accent" style={styles.actionLabel}>
            {action.label}
          </ThemedText>
        </Pressable>
      )}
    </>
  );

  return (
    <Animated.View
      pointerEvents="box-none"
      {...swipe.panHandlers}
      style={[
        styles.container,
        {
          top: insets.top + Spacing.two,
          // Slides in from above the screen, no fade: iOS stops drawing the glass when a parent
          // view is partly transparent, so animating opacity left the text with no background.
          transform: [
            {
              translateY: Animated.add(
                progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-(insets.top + OFFSCREEN), 0],
                }),
                drag,
              ),
            },
          ],
        },
      ]}>
      <Pressable
        onPress={onDismiss}
        onPressIn={onHold}
        onPressOut={onRelease}
        accessibilityRole="alert"
        accessibilityHint="Dismisses this message. You can also swipe it up."
        accessibilityLiveRegion="polite"
        style={styles.press}>
        {LIQUID_GLASS ? (
          <GlassView
            glassEffectStyle="regular"
            colorScheme={mode}
            tintColor={FROST[mode]}
            style={styles.banner}>
            {body}
          </GlassView>
        ) : (
          <View style={[styles.banner, styles.card, { backgroundColor: theme.card }]}>{body}</View>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    alignItems: 'center',
    zIndex: 1000,
  },
  press: { alignSelf: 'stretch', alignItems: 'center' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
    paddingLeft: Spacing.three,
    paddingRight: Spacing.three,
    borderRadius: 22,
    minWidth: 240,
    maxWidth: 480,
  },
  // The non-glass surface: a raised card with a soft shadow.
  card: {
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  text: { flexShrink: 1, gap: Spacing.half },
  action: {
    paddingVertical: Spacing.two - Spacing.half,
    paddingHorizontal: Spacing.three,
    borderRadius: 999,
  },
  actionLabel: { fontWeight: '600' },
  pressed: { opacity: 0.7 },
});
