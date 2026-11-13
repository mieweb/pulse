import { useMemo, useState } from 'react';
import { useAnimatedReaction, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

/**
 * Where the playhead is among the captions: the sentence under it (its index), or, in a gap, the
 * index of the next sentence (-1 past the last). Worked out on the UI thread; React hears only
 * when it changes (a sentence or gap entered), so playback doesn't re-render per frame. Followed
 * only while `active`.
 */
export function usePlayheadCaption(
  lines: readonly { t0: number; t1: number }[],
  timeMs: SharedValue<number>,
  active: boolean,
): { line: number; next: number } {
  const [code, setCode] = useState(-1);
  // Starts and ends (centiseconds), flat, for the UI thread.
  const bounds = useMemo(() => lines.flatMap((l) => [l.t0, l.t1]), [lines]);
  useAnimatedReaction(
    () => {
      if (!active) return -1;
      const pos = timeMs.get() / 10;
      const n = bounds.length / 2;
      // The first sentence ending after the playhead (half-open, start up to not including the
      // end: where two touch, the later one has it).
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (bounds[mid * 2 + 1] <= pos) lo = mid + 1;
        else hi = mid;
      }
      // Under sentence `lo`: lo × 2 (even); in the gap before it: lo × 2 + 1 (odd).
      return lo < n && bounds[lo * 2] <= pos ? lo * 2 : lo * 2 + 1;
    },
    (v, prev) => {
      if (v !== prev) scheduleOnRN(setCode, v);
    },
    [bounds, active],
  );
  if (!active || code < 0) return { line: -1, next: -1 };
  const at = code >> 1;
  // (Until the reaction answers, fewer captions than it last heard may be there.)
  if (code % 2 === 0) return at < lines.length ? { line: at, next: -1 } : { line: -1, next: -1 };
  return { line: -1, next: at < lines.length ? at : -1 };
}
