import { useEffect } from 'react';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * A small determinate ring (0–1), drawn clockwise from 12 o'clock. A sliver always shows so a
 * job that just started still reads as "in progress". Each progress update glides over 250 ms,
 * linear, as the merge ring does: a stream of updates reads as one steady sweep instead of a jump
 * per update. `Never`, because Reanimated's default would make Reduce Motion snap it, and the
 * sweep is the progress itself, not decoration.
 */
export function ProgressRing({
  progress,
  size = 28,
  stroke = 3,
  color,
  trackColor,
}: {
  progress: number;
  size?: number;
  stroke?: number;
  color: string;
  trackColor: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0.03, Math.min(1, progress));
  // Starts where the job is, so a ring that mounts mid-job (a card scrolled in, a relaunch)
  // doesn't sweep up from empty.
  const value = useSharedValue(clamped);
  useEffect(() => {
    value.set(
      withTiming(clamped, {
        duration: 250,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.Never,
      }),
    );
  }, [clamped, value]);
  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: c * (1 - value.get()),
  }));
  return (
    <Svg width={size} height={size}>
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={trackColor}
        strokeWidth={stroke}
        fill="none"
      />
      <AnimatedCircle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={c}
        animatedProps={animatedProps}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </Svg>
  );
}
