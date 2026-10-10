import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  FadeIn,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { EaseOut } from '@/constants/motion';
import { FloatShadow, Opacity, Spacing, SystemColors } from '@/constants/theme';
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
  /** Optional button at the end ("Retry"); tapping it also dismisses the toast. */
  action?: ToastAction;
};

const ICONS: Record<ToastKind, IconName> = {
  success: 'checkmark.circle.fill',
  info: 'info.circle.fill',
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
const FROST = { light: 'rgba(255,255,255,0.78)', dark: 'rgba(28,28,30,0.78)' } as const;

/**
 * Far enough above the safe area to start (and leave) fully off screen, for the tallest toast the
 * text ceiling allows (`MaxTextScale`): a 3-line title and 2-line message is ≈ 180 pt of banner, plus the
 * 8 pt it sits below the safe area and FloatShadow's 16 pt reach. A fixed distance rather than the
 * measured height: the slide in starts before the banner's first layout, so a measured one would
 * still need this as its fallback, and the steep ease-out covers the extra distance off screen.
 */
const OFFSCREEN = 240;
/**
 * A release whose projected end (pt above where the finger started) passes this, or an upward
 * flick faster than this (pt/s), swipes the toast away.
 */
const SWIPE_DISTANCE = 24;
const SWIPE_VELOCITY = 400;
/**
 * UIScrollView's normal deceleration rate: where the toast would coast to after the release, so
 * a short fast flick counts as much as a long slow drag.
 */
const DECELERATION = 0.998;
/** How far a downward pull can stretch: it gives, more and more stiffly, but doesn't follow. */
const PULL_DOWN_LIMIT = 80;

/** Something the person didn't cause arrives and leaves without a bounce. */
const ENTER = { duration: 300, easing: EaseOut };
const EXIT = { duration: 240, easing: EaseOut };
/**
 * The Reduce Motion stand-in for the slide on the raised card. `Never`, because Reanimated's
 * default (follow the system) would make this fade instant too.
 */
const FADE = { duration: 200, easing: EaseOut, reduceMotion: ReduceMotion.Never };
/**
 * A replacing toast's content fading in over the surface that stays put. Opacity only, so it
 * stays under Reduce Motion (`Never`): gentler than a snap, and nothing moves.
 */
const SWAP_IN = FadeIn.duration(150).easing(EaseOut).reduceMotion(ReduceMotion.Never);

/** Rubber-banding for a pull past the resting point: 1:1 at first, never past the limit. */
function rubberBand(offset: number): number {
  'worklet';
  return (offset * PULL_DOWN_LIMIT * 0.55) / (PULL_DOWN_LIMIT + 0.55 * Math.abs(offset));
}

/**
 * On iOS the toast lives in `FullWindowOverlay`, a UIWindow of its own above every modal, so it
 * gets its own gesture-handler root rather than relying on the app's. That root is sized to the
 * toast (the positioned container below), never the full window: the overlay passes a touch
 * through only when nothing inside it claims it, so a full-window root would swallow every touch
 * on the screen beneath. On Android the toast is a plain sibling inside the app's root.
 */
const Root = Platform.OS === 'ios' ? GestureHandlerRootView : View;

/**
 * A single transient banner below the top safe area: a colored icon for the kind, a bold title,
 * an optional detail line and action. Liquid Glass on iOS 26, a raised card elsewhere. Tap to
 * dismiss, or swipe it up; a finger on it holds it. `ToastProvider` owns the timing and which
 * toast is up; this owns the motion. `leaving` plays the exit, and `onExited` says when the toast
 * is off screen and can be unmounted. A new `id` while mounted is a replacement: the surface stays
 * where it is (or comes back, if it was leaving) and only the content changes.
 */
export function Toast({
  id,
  content,
  leaving,
  onDismiss,
  onHold,
  onRelease,
  onExited,
}: {
  /** Passed back with every callback, so the provider can ignore a toast that's been replaced. */
  id: number;
  content: ToastContent;
  leaving: boolean;
  onDismiss: (id: number) => void;
  /**
   * A finger is on the toast: hold it up. The tap target, the action button and the swipe each
   * call this and `onRelease` in pairs, and can overlap (a drag cancels the press it began as).
   */
  onHold: (id: number) => void;
  /** That finger let go without dismissing it. */
  onRelease: (id: number) => void;
  /** The exit (slide, fade or swipe) has finished: the toast is off screen. */
  onExited: (id: number) => void;
}) {
  const theme = useTheme();
  const mode = useThemeMode();
  const insets = useSafeAreaInsets();
  const { kind, title, message, action } = content;
  const hidden = -(insets.top + OFFSCREEN);

  // Reduce Motion, read once at launch. Reanimated already makes the slide instant then, which
  // is all the glass can do: iOS stops drawing it under a partly transparent parent, so it can't
  // fade. The raised card can, so it fades in place instead of snapping in and out.
  const reduceMotion = useReducedMotion();
  const fade = !LIQUID_GLASS && reduceMotion;

  // 0 is resting below the safe area; `hidden` is above the screen. The swipe moves the same
  // value, so grabbing the toast mid-slide picks it up where it is.
  const y = useSharedValue(fade ? 0 : hidden);
  const opacity = useSharedValue(fade ? 0 : 1);
  // Where `y` was when the finger took it.
  const dragStart = useSharedValue(0);
  // A drag holds the toast from its start until the pan finishes, however it finishes.
  const dragging = useSharedValue(false);
  // A swipe that throws the toast away runs its own spring; the exit mustn't start a second one.
  const swiped = useSharedValue(false);
  const isLeaving = useSharedValue(leaving);

  // The first toast slides in whole; a replacement's content fades in over the surface.
  const [firstId] = useState(id);

  useEffect(() => {
    isLeaving.set(leaving);
    if (leaving) {
      if (swiped.get()) return;
      const done = (finished?: boolean) => {
        'worklet';
        if (finished) scheduleOnRN(onExited, id);
      };
      if (fade) opacity.set(withTiming(0, FADE, done));
      else y.set(withTiming(hidden, EXIT, done));
    } else {
      // Arriving, or replaced while leaving (from wherever it got to), or replaced while up
      // (already at rest, so nothing moves).
      swiped.set(false);
      y.set(withTiming(0, ENTER));
      if (fade) opacity.set(withTiming(1, FADE));
    }
  }, [leaving, id, fade, hidden, onExited, y, opacity, swiped, isLeaving]);

  // Screen readers hear each toast once, as it appears (or replaces the one that was up). The
  // announcement on both platforms rather than an Android live region, which reads a change to
  // a view already on screen but not reliably one that has just been added.
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(message ? `${title}. ${message}` : title);
  }, [id, title, message]);

  // Swipe up to dismiss. Only a vertical drag claims the touch, so a tap still reaches the
  // toast (dismiss) and its action button.
  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!leaving)
        .activeOffsetY([-6, 6])
        .failOffsetX([-12, 12])
        .onStart(() => {
          cancelAnimation(y);
          dragStart.set(y.get());
          dragging.set(true);
          scheduleOnRN(onHold, id);
        })
        .onUpdate((e) => {
          const offset = dragStart.get() + e.translationY;
          y.set(offset <= 0 ? offset : rubberBand(offset));
        })
        .onEnd((e) => {
          const projected =
            e.translationY + ((e.velocityY / 1000) * DECELERATION) / (1 - DECELERATION);
          // Also when the toast started leaving mid-drag (it timed out under the finger): let
          // go, it carries on out rather than settling back as a toast nobody will unmount.
          if (isLeaving.get() || projected < -SWIPE_DISTANCE || e.velocityY < -SWIPE_VELOCITY) {
            swiped.set(true);
            y.set(
              withSpring(
                hidden,
                { velocity: e.velocityY, dampingRatio: 1, duration: 300, overshootClamping: true },
                (finished) => {
                  if (finished) scheduleOnRN(onExited, id);
                },
              ),
            );
            scheduleOnRN(onDismiss, id);
          } else {
            y.set(withSpring(0, { velocity: e.velocityY, dampingRatio: 0.8, duration: 350 }));
          }
        })
        // The hold is released here, not in onEnd: a pan cancelled mid-drag (the system took the
        // touch) skips onEnd, and its hold would keep the toast up for good. A cancelled drag
        // also settles back, as onEnd would have.
        .onFinalize((_, success) => {
          if (!dragging.get()) return;
          dragging.set(false);
          if (!success) y.set(withSpring(0, { dampingRatio: 0.8, duration: 350 }));
          scheduleOnRN(onRelease, id);
        }),
    [
      leaving,
      hidden,
      id,
      y,
      dragStart,
      dragging,
      swiped,
      isLeaving,
      onHold,
      onRelease,
      onDismiss,
      onExited,
    ],
  );

  const slide = useAnimatedStyle(() =>
    // Translate only on the glass: iOS stops drawing it when a parent view is partly
    // transparent, so a fade left the text with no background. Opacity only on the card.
    fade
      ? { opacity: opacity.get(), transform: [{ translateY: y.get() }] }
      : { transform: [{ translateY: y.get() }] },
  );

  const body = (
    // Keyed by id so a replacement swaps in whole (and any press on the old action button ends
    // with it). Opacity on this child of the glass is fine; it's an ancestor's that blanks it.
    <Animated.View key={id} entering={id === firstId ? undefined : SWAP_IN} style={styles.row}>
      <Icon name={ICONS[kind]} size={22} tintColor={iconColor(kind, mode)} />
      <View style={styles.text}>
        <ThemedText type="headline" numberOfLines={3}>
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
          // Dismiss first: an action that shows a toast of its own ("Retrying…") must not have
          // that new toast dismissed right after.
          onPress={() => {
            onDismiss(id);
            action.onPress();
          }}
          // The button owns this touch, so it holds the toast itself while pressed.
          onPressIn={() => onHold(id)}
          onPressOut={() => onRelease(id)}
          hitSlop={Spacing.two}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.action,
            // `cardRaisedPressed`, a step off the banner's `cardRaised`: dark's
            // `backgroundSelected` is the same gray as the card banner, so the pill vanished on
            // it (Android, iOS before 26). On the glass it's a pill over the frost either way.
            { backgroundColor: theme.cardRaisedPressed },
            pressed && styles.pressed,
          ]}>
          <ThemedText
            type="subheadline"
            themeColor="accent"
            numberOfLines={1}

            style={styles.actionLabel}>
            {action.label}
          </ThemedText>
        </Pressable>
      )}
    </Animated.View>
  );

  return (
    <Root pointerEvents="box-none" style={[styles.container, { top: insets.top + Spacing.two }]}>
      <GestureDetector gesture={swipe}>
        <Animated.View style={[styles.slide, slide]}>
          <Pressable
            onPress={() => onDismiss(id)}
            onPressIn={() => onHold(id)}
            onPressOut={() => onRelease(id)}
            // VoiceOver's escape (two-finger scrub) closes it like a tap does.
            onAccessibilityEscape={() => onDismiss(id)}
            // With an action, not one element: VoiceOver would read it as a whole and never
            // reach the button. The text and the button are then separate elements (the toast
            // is announced as it appears either way).
            accessible={!action}
            accessibilityRole="alert"
            accessibilityHint="Dismisses this message. You can also swipe it up."
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
              // `cardRaised`, not `card`: white in light, and in dark a step lighter than the
              // cards beneath, where the shadow doesn't show.
              <View style={[styles.banner, FloatShadow, { backgroundColor: theme.cardRaised }]}>
                {body}
              </View>
            )}
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </Root>
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
  slide: { alignSelf: 'stretch' },
  press: { alignSelf: 'stretch', alignItems: 'center' },
  banner: {
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.three,
    borderRadius: 22,
    borderCurve: 'continuous',
    minWidth: 240,
    maxWidth: 480,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  text: { flexShrink: 1, gap: Spacing.half },
  action: {
    flexShrink: 0,
    maxWidth: '40%',
    paddingVertical: Spacing.two - Spacing.half,
    paddingHorizontal: Spacing.three,
    borderRadius: 999,
  },
  actionLabel: { fontWeight: '600' },
  // Matches the app's other filled controls. On a child of the glass, never an ancestor.
  pressed: { opacity: Opacity.pressed },
});
