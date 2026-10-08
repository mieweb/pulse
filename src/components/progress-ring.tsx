import Svg, { Circle } from 'react-native-svg';

/** A small determinate ring (0–1), drawn clockwise from 12 o'clock. A sliver always shows so a
 *  job that just started still reads as "in progress". */
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
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - clamped)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </Svg>
  );
}
