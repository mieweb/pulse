import { useEffect, useMemo, useRef, useState } from 'react';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { CaptionText, captionRowStyle } from '@/features/transcription/caption-overlay';
import {
  CAPTION_Y_MAX,
  CAPTION_Y_MIN,
  type CaptionStyle,
} from '@/features/transcription/caption-style';
import type { TranscriptLine } from '@/features/transcription/whisper';
import { haptics } from '@/utils/haptics';

import { clamp } from './timeline-geometry';

type Props = {
  /** The draft's captions (timeline centiseconds), sorted. */
  lines: readonly TranscriptLine[];
  /** The playhead (timeline ms, UI thread). */
  timeMs: SharedValue<number>;
  /** How the captions look, and where they sit (`y`). */
  style: CaptionStyle;
  /** The picture's height (dp): the caption is sized to it, and a drag moves it by its share. */
  height: number;
  /** A drag started (playback stops, so the caption stays while it's moved). */
  onPickUp: () => void;
  /** A drag let go at `y`. */
  onMove: (y: number) => void;
  /** The caption was tapped. */
  onTap: () => void;
  /** The line under the playhead changed (its index, or -1). Only while passed. */
  onLine?: (index: number) => void;
};

/**
 * The caption under the playhead, over the editor's preview, at the draft's caption position;
 * drag it up or down to move every caption, tap it to edit the captions. The line and the word to highlight are found on the
 * UI thread as the playhead moves, and React hears only when one of them changes, so playback
 * doesn't re-render the editor.
 */
export function EditorCaption(props: Props) {
  const { lines, timeMs, style, height, onPickUp, onMove, onTap, onLine } = props;
  const { y } = style;
  // Lines and words as flat time arrays (centiseconds) for the worklet: [t0, t1, t0, t1, …], and
  // where each line's words start in `wordT` (one more entry at the end).
  const { lineT, wordT, wordFrom } = useMemo(() => {
    const lt: number[] = [];
    const wt: number[] = [];
    const from: number[] = [];
    for (const l of lines) {
      lt.push(l.t0, l.t1);
      from.push(wt.length);
      for (const w of l.words ?? []) wt.push(w.t0, w.t1);
    }
    from.push(wt.length);
    return { lineT: lt, wordT: wt, wordFrom: from };
  }, [lines]);

  // line * 10000 + word + 1 (word -1 = none yet), or -1 when no line is under the playhead.
  const [code, setCode] = useState(-1);
  useAnimatedReaction(
    () => {
      const pos = timeMs.get() / 10;
      let lo = 0;
      let hi = lineT.length / 2 - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (pos < lineT[mid * 2]) hi = mid - 1;
        else if (pos > lineT[mid * 2 + 1]) lo = mid + 1;
        else {
          found = mid;
          break;
        }
      }
      if (found < 0) return -1;
      const start = wordFrom[found];
      let active = -1;
      for (let k = start; k < wordFrom[found + 1]; k += 2) {
        if (pos >= wordT[k]) active = (k - start) / 2;
        if (pos >= wordT[k] && pos <= wordT[k + 1]) break;
      }
      return found * 10000 + active + 1;
    },
    (next, prev) => {
      if (next !== prev) scheduleOnRN(setCode, next);
    },
    [lineT, wordT, wordFrom],
  );
  const index = code < 0 ? -1 : Math.floor(code / 10000);
  const word = code < 0 ? -1 : (code % 10000) - 1;
  const line = index >= 0 ? lines[index] : undefined;

  const latest = useRef({ onPickUp, onMove, onTap, onLine });
  useEffect(() => {
    latest.current = { onPickUp, onMove, onTap, onLine };
  });
  const reporting = !!onLine;
  useEffect(() => {
    if (reporting) latest.current.onLine?.(line ? index : -1);
  }, [index, line, reporting]);

  // The drag: the caption's centre follows the finger, within the picture.
  const yv = useSharedValue(y);
  const from = useSharedValue(y);
  const h = useSharedValue(height);
  const dragging = useSharedValue(false);
  useEffect(() => {
    h.set(height);
    if (!dragging.get()) yv.set(y);
  }, [y, height, h, yv, dragging]);
  const [handlers] = useState(() => ({
    pickUp: () => {
      haptics.pickUp();
      latest.current.onPickUp();
    },
    drop: (v: number) => {
      haptics.drop();
      latest.current.onMove(v);
    },
    tap: () => latest.current.onTap(),
  }));
  const { pickUp, drop, tap } = handlers;
  const [gesture] = useState(() => {
    const press = Gesture.Tap()
      .maxDistance(10)
      .onEnd(() => {
        scheduleOnRN(tap);
      });
    const pan = Gesture.Pan()
      .activeOffsetY([-6, 6])
      .onStart(() => {
        dragging.set(true);
        from.set(yv.get());
        scheduleOnRN(pickUp);
      })
      .onUpdate((e) => {
        const hh = h.get();
        if (hh > 0) yv.set(clamp(from.get() + e.translationY / hh, CAPTION_Y_MIN, CAPTION_Y_MAX));
      })
      .onEnd(() => {
        scheduleOnRN(drop, yv.get());
      })
      .onFinalize(() => {
        dragging.set(false);
      });
    return Gesture.Exclusive(pan, press);
  });
  // The row is twice the picture's height, centred on the caption's place (captionRowStyle).
  const rowStyle = useAnimatedStyle(() => ({
    top: (yv.get() - 1) * h.get(),
    height: h.get() * 2,
  }));

  if (!line) return null;
  return (
    <Animated.View style={[captionRowStyle(style, height), rowStyle]} pointerEvents="box-none">
      <GestureDetector gesture={gesture}>
        {/* Takes the touch from the preview under it, so a drag or a tap here never plays or
            pauses. */}
        <Animated.View
          onStartShouldSetResponder={() => true}
          accessibilityRole="button"
          accessibilityLabel={line.text}
          accessibilityHint="Edits the captions. Drag up or down to move them.">
          <CaptionText key={index} line={line} active={word} style={style} height={height} />
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}
