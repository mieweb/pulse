import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, type LayoutRectangle, Pressable, StyleSheet, View } from 'react-native';
import Animated, { withTiming } from 'react-native-reanimated';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { EaseOut } from '@/constants/motion';
import { FloatShadow, Opacity, Radius, Spacing } from '@/constants/theme';
import { useTheme, useThemeMode } from '@/hooks/use-theme';

import { TIPS, type TipId } from './tips';

/**
 * Callout tips: drawn in React Native over the screen, pointing at their control, and not modal —
 * every touch outside the ✕ goes through to whatever is under it, so the shutter records on the
 * first tap with the record tip up (a system popover would take that tap just to close itself).
 *
 * The control's wrapper holds a `CalloutAnchor`, which measures where the control is; the screen's
 * `TipLayer` draws the callout there. Only one tip shows at a time (`useTip`), so one slot is
 * enough.
 */

type Callout = { id: TipId; rect: LayoutRectangle; onDismiss: () => void };

let current: Callout | null = null;
const listeners = new Set<() => void>();
function setCallout(next: Callout | null) {
  current = next;
  listeners.forEach((l) => l());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** How often a shown callout re-measures its control, so it follows a list that scrolls. */
const REMEASURE_MS = 250;

/**
 * Laid over a control (fills its wrapper, takes no touches): while `shown`, it reports where the
 * control is on screen so the screen's `TipLayer` can point the callout at it.
 */
export function CalloutAnchor({
  id,
  shown,
  onDismiss,
}: {
  id: TipId;
  shown: boolean;
  onDismiss: () => void;
}) {
  const ref = useRef<View>(null);

  useEffect(() => {
    if (!shown) return;
    let last = '';
    const measure = () =>
      ref.current?.measureInWindow((x, y, width, height) => {
        const key = `${x},${y},${width},${height}`;
        if (key === last || width === 0) return;
        last = key;
        setCallout({ id, rect: { x, y, width, height }, onDismiss });
      });
    measure();
    const timer = setInterval(measure, REMEASURE_MS);
    return () => {
      clearInterval(timer);
      if (current?.id === id) setCallout(null);
    };
  }, [id, shown, onDismiss]);

  return (
    <View ref={ref} style={StyleSheet.absoluteFill} pointerEvents="none" collapsable={false} />
  );
}

/** Screen gutter the callout keeps clear of, and its widest. */
const GUTTER = Spacing.three;
const MAX_WIDTH = 320;
/** The arrow: a triangle this wide and half as tall, and how far it keeps from the corners. */
const ARROW = 16;
const ARROW_INSET = Radius.card;

/** Grows out of its arrow and shrinks back into it: the same path in and out. */
const ENTER = { duration: 220, easing: EaseOut };
const EXIT = { duration: 160, easing: EaseOut };
const enter = () => {
  'worklet';
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.9 }] },
    animations: {
      opacity: withTiming(1, ENTER),
      transform: [{ scale: withTiming(1, ENTER) }],
    },
  };
};
const exit = () => {
  'worklet';
  return {
    initialValues: { opacity: 1, transform: [{ scale: 1 }] },
    animations: {
      opacity: withTiming(0, EXIT),
      transform: [{ scale: withTiming(0.9, EXIT) }],
    },
  };
};

/**
 * Where the screen's callout tip is drawn: put it last in a full-screen screen's root, over
 * everything. It lets every touch through except the callout's ✕.
 */
export function TipLayer() {
  const callout = useSyncExternalStore(subscribe, () => current);
  const ref = useRef<View>(null);
  // The layer's own place in the window and size: the anchors measure in window coordinates.
  const [frame, setFrame] = useState<LayoutRectangle | null>(null);

  return (
    <View
      ref={ref}
      style={StyleSheet.absoluteFill}
      pointerEvents="box-none"
      collapsable={false}
      onLayout={() =>
        ref.current?.measureInWindow((x, y, width, height) => setFrame({ x, y, width, height }))
      }>
      {callout && frame && <CalloutBubble key={callout.id} callout={callout} frame={frame} />}
    </View>
  );
}

function CalloutBubble({ callout, frame }: { callout: Callout; frame: LayoutRectangle }) {
  const theme = useTheme();
  const mode = useThemeMode();
  const tip = TIPS[callout.id];

  // VoiceOver / TalkBack read the tip as it appears, as they do a system popover.
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(`${tip.title}. ${tip.message}`);
  }, [tip]);

  const rect = {
    x: callout.rect.x - frame.x,
    y: callout.rect.y - frame.y,
    width: callout.rect.width,
    height: callout.rect.height,
  };
  const centerX = rect.x + rect.width / 2;
  // Above a control in the lower half of the screen, below one in the upper half.
  const above = rect.y + rect.height / 2 > frame.height / 2;
  const width = Math.min(MAX_WIDTH, frame.width - GUTTER * 2);
  const left = Math.min(Math.max(centerX - width / 2, GUTTER), frame.width - GUTTER - width);
  const arrowLeft = Math.min(
    Math.max(centerX - left - ARROW / 2, ARROW_INSET),
    width - ARROW_INSET - ARROW,
  );
  const gap = Spacing.one;
  // Raised in dark mode, where the shadow doesn't show, as the app's other floating surfaces.
  const fill = mode === 'dark' ? theme.cardRaised : theme.card;

  return (
    <Animated.View
      entering={enter}
      exiting={exit}
      pointerEvents="box-none"
      style={[
        styles.callout,
        { left, width, transformOrigin: [arrowLeft + ARROW / 2, above ? '100%' : 0, 0] },
        above
          ? { bottom: frame.height - rect.y + gap + ARROW / 2 }
          : { top: rect.y + rect.height + gap + ARROW / 2 },
      ]}>
      <View
        pointerEvents="none"
        style={[
          styles.arrow,
          { left: arrowLeft },
          above
            ? { bottom: -ARROW / 2, borderTopColor: fill, borderTopWidth: ARROW / 2 }
            : { top: -ARROW / 2, borderBottomColor: fill, borderBottomWidth: ARROW / 2 },
        ]}
      />
      <View style={[styles.bubble, { backgroundColor: fill }]} pointerEvents="box-none">
        <View pointerEvents="none" style={styles.symbol}>
          <Icon name={tip.symbol} size={24} tintColor={theme.accent} />
        </View>
        <View pointerEvents="none" style={styles.text}>
          <ThemedText type="headline">{tip.title}</ThemedText>
          <ThemedText type="subheadline" themeColor="textSecondary">
            {tip.message}
          </ThemedText>
        </View>
        <Pressable
          onPress={callout.onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Close tip"
          style={({ pressed }) => [styles.close, pressed && styles.closePressed]}>
          <Icon name="xmark" size={13} weight="semibold" tintColor={theme.textSecondary} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

/** The ✕'s 44 pt target reaches into the bubble's padding, so the text keeps its width. */
const CLOSE = 44;
const BUBBLE_PAD = Spacing.three;

const styles = StyleSheet.create({
  callout: { position: 'absolute' },
  bubble: {
    ...FloatShadow,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two + Spacing.one,
    padding: BUBBLE_PAD,
    paddingRight: BUBBLE_PAD + CLOSE / 2 - Spacing.two,
    borderRadius: Radius.card,
    borderCurve: 'continuous',
  },
  symbol: { paddingTop: Spacing.half },
  text: { flex: 1, gap: Spacing.half },
  close: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: CLOSE,
    height: CLOSE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closePressed: { opacity: Opacity.pressedGlyph },
  // A CSS-style triangle: transparent side borders and one coloured border pointing at the control.
  arrow: {
    position: 'absolute',
    width: 0,
    height: 0,
    borderLeftWidth: ARROW / 2,
    borderRightWidth: ARROW / 2,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
});
