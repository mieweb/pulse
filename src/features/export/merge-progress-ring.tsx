import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { ThemedText } from '@/components/themed-text';
import { SystemColors } from '@/constants/theme';
import { useTheme, useThemeMode } from '@/hooks/use-theme';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const SIZE = 140;
const STROKE = 10;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const clamp = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Circular progress ring for the merge screen. `progress` is a fraction in [0,1] emitted by the
 * native merge engine (`onMergeProgress`). The arc sweeps from 12 o'clock; the fill is animated
 * with a linear `withTiming` so even the near-instant passthrough path animates rather than
 * snapping, and a stream of updates reads as one steady sweep (an eased curve surges on each).
 * The centered label shows whole percents (e.g. `50%`) in tabular digits, so it doesn't jitter
 * as it counts.
 */
export function MergeProgressRing({ progress }: { progress: number }) {
  const theme = useTheme();
  const mode = useThemeMode();
  const value = useSharedValue(0);
  const percent = Math.floor(clamp(progress) * 100);

  useEffect(() => {
    value.set(withTiming(clamp(progress), { duration: 250, easing: Easing.linear }));
  }, [progress, value]);

  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: CIRCUMFERENCE * (1 - value.get()),
  }));

  return (
    <View
      style={[styles.wrap, { width: SIZE, height: SIZE }]}
      accessibilityRole="progressbar"
      accessibilityLabel="Merging"
      accessibilityValue={{ min: 0, max: 100, now: percent }}>
      <Svg width={SIZE} height={SIZE}>
        {/* The track: a gray step that shows on both the grouped grey (light) and black (dark). */}
        <Circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          stroke={SystemColors.gray4[mode]}
          strokeWidth={STROKE}
          fill="none"
        />
        <AnimatedCircle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          stroke={theme.accent}
          strokeWidth={STROKE}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={CIRCUMFERENCE}
          animatedProps={animatedProps}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </Svg>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={styles.center}>
          {/* Shrinks to fit inside the ring at large text sizes rather than overflowing it. */}
          <ThemedText
            type="subtitle"
            numberOfLines={1}
            adjustsFontSizeToFit
            maxFontSizeMultiplier={1.5}
            style={styles.label}>
            {`${percent}%`}
          </ThemedText>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  // Inset past the stroke so the label fits within the ring's inner circle.
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: STROKE * 2,
  },
  label: { fontVariant: ['tabular-nums'] },
});
