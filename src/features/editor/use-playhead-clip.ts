import { useMemo, useState } from 'react';
import { useAnimatedReaction, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { clipIndexAt } from './timeline-geometry';
import { canSplitAtPlayhead } from './clip-split';

/**
 * The index of the clip under the playhead (-1 with no clips), following scrubs, flings and
 * playback. Worked out on the UI thread; React hears only when it changes (a clip boundary
 * crossed), so moving the playhead doesn't re-render the editor.
 */
export function usePlayheadClip(
  starts: readonly number[],
  timeMs: SharedValue<number>,
  /** Followed only while true (edit mode), so playing elsewhere doesn't re-render per clip. */
  active: boolean,
): number {
  const [index, setIndex] = useState(-1);
  useAnimatedReaction(
    () => (active ? clipIndexAt(starts, timeMs.get()) : -1),
    (i, prev) => {
      if (i !== prev) scheduleOnRN(setIndex, i);
    },
    [starts, active],
  );
  // (Until the reaction answers, a clip just deleted may still be the one heard.)
  return active && index < starts.length ? index : -1;
}

/** Only crossing a split boundary re-renders React, rather than every scrub/playback frame. */
export function useCanSplitAtPlayhead(
  clips: readonly { edit: { startMs: number; endMs: number; speed: number } }[],
  layout: { starts: readonly number[]; totalMs: number },
  timeMs: SharedValue<number>,
): boolean {
  const edits = useMemo(() => clips.map((clip) => clip.edit), [clips]);
  const { starts, totalMs } = layout;
  const [available, setAvailable] = useState(false);
  useAnimatedReaction(
    () => canSplitAtPlayhead(edits, starts, totalMs, timeMs.get()),
    (next, previous) => {
      if (next !== previous) scheduleOnRN(setAvailable, next);
    },
    [edits, starts, totalMs],
  );
  return edits.length > 0 && available;
}
