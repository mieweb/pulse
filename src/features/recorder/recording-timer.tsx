import { useEffect, useState } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';

import type { Segment } from '@/db/schema';
import { formatDuration } from '@/utils/format';
import { effMs } from '@/utils/segment-window';

/**
 * The recorder's running total: the saved clips, plus the take in progress while recording.
 * Its own component so the 100 ms tick re-renders this text alone, not the recorder screen
 * (on a slower Android phone, a whole-screen render per tick kept the JS thread busy enough to
 * delay the record button's taps).
 */
export function RecordingTimer({
  segments,
  startedAt,
  stoppedAt,
  style,
}: {
  segments: Segment[];
  /** Wall-clock start of the take in progress; null when idle. */
  startedAt: number | null;
  /** When its stop was asked for: the total holds there while the clip saves. */
  stoppedAt: number | null;
  style: StyleProp<TextStyle>;
}) {
  const totalMs = useRecordingTimer(segments, startedAt, stoppedAt);
  return (
    <Text style={style} maxFontSizeMultiplier={1.3}>
      {/* Floored like a playhead while recording, so it doesn't tick to the next second half a
          second early; at rest it rounds, like the draft's total on Home. */}
      {formatDuration(totalMs, { pad: true, floor: startedAt != null })}
    </Text>
  );
}

// While idle this is just the sum of saved clip durations; while recording it adds the
// wall-clock elapsed since `startedAt`, ticking every 100ms, and holds at `stoppedAt` once the
// take is stopped. When the clip is saved its precise file duration lands in `segments` and the
// live estimate is dropped — a sub-second snap that's expected.
function useRecordingTimer(
  segments: Segment[],
  startedAt: number | null,
  stoppedAt: number | null,
): number {
  const savedTotal = segments.reduce((sum, s) => sum + effMs(s), 0);
  // Only the interval mutates `now`; elapsed is derived in render. A stale `now` (idle, or the
  // first 100ms of a fresh recording) yields a negative diff that the clamp floors to 0.
  const [now, setNow] = useState(0);
  const ticking = startedAt != null && stoppedAt == null;

  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [ticking]);

  if (startedAt == null) return savedTotal;
  return savedTotal + Math.max(0, (stoppedAt ?? now) - startedAt);
}
