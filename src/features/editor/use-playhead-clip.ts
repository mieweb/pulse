import { useState } from 'react';
import { useAnimatedReaction, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { clipIndexAt } from './timeline-geometry';

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
