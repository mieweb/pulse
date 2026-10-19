import { useMemo, useState } from 'react';
import { useAnimatedReaction, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

/**
 * Where the playhead is among the captions: the sentence under it (its index) and the word in it
 * (the last one started, as the highlight rests on it), or, in a gap, the index of the next
 * sentence (-1 past the last). Worked out on the UI thread; React hears only when it changes, so
 * playback doesn't re-render per frame. Followed only while `active`.
 */
export function usePlayheadCaption(
  lines: readonly { t0: number; t1: number; words?: readonly { t0: number }[] }[],
  timeMs: SharedValue<number>,
  active: boolean,
): { line: number; word: number; next: number } {
  const [code, setCode] = useState(-1);
  // Starts and ends (centiseconds), flat, and each sentence's word starts, for the UI thread.
  const { bounds, starts } = useMemo(() => {
    const b: number[] = [];
    const s: number[][] = [];
    for (const l of lines) {
      b.push(l.t0, l.t1);
      const w: number[] = [];
      for (const x of l.words ?? []) w.push(x.t0);
      s.push(w);
    }
    return { bounds: b, starts: s };
  }, [lines]);
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
      // In the gap before sentence `lo`: lo × 2 + 1 (odd). Under it: an even code carrying the
      // sentence and its word, (lo × 1000 + word) × 2.
      if (!(lo < n && bounds[lo * 2] <= pos)) return lo * 2 + 1;
      const ws = starts[lo];
      let w = 0;
      for (let k = 0; k < ws.length; k++) if (pos >= ws[k]) w = k;
      return (lo * 1000 + w) * 2;
    },
    (v, prev) => {
      if (v !== prev) scheduleOnRN(setCode, v);
    },
    [bounds, starts, active],
  );
  if (!active || code < 0) return { line: -1, word: -1, next: -1 };
  if (code % 2 === 0) {
    const v = code / 2;
    return { line: Math.floor(v / 1000), word: v % 1000, next: -1 };
  }
  const next = (code - 1) / 2;
  return { line: -1, word: -1, next: next < lines.length ? next : -1 };
}
