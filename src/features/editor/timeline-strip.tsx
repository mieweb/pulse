import { useEffect, useRef, useState } from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDecay,
} from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';

import { Icon } from '@/components/icon';
import { Accent, SystemColors } from '@/constants/theme';
import { useTheme, useThemeMode } from '@/hooks/use-theme';
import { haptics } from '@/utils/haptics';

import { ClipTile, TILE_GAP, TILE_HEIGHT, TILE_RADIUS, type TilePalette } from './clip-tile';
import {
  ceilToFrame,
  clamp,
  DP_PER_MS,
  floorToFrame,
  MIN_CLIP_SOURCE_MS,
  snapToFrame,
  type TimelineLayout,
} from './timeline-geometry';
import type { EditorClip } from './use-editor-draft';
import { Mode, type PlayheadValues } from './use-preview-transport';
import type { Peaks } from './use-waveforms';

export const STRIP_HEIGHT = TILE_HEIGHT + 20;
const GRIP_WIDTH = 16;
/** Extra touch area around each trim grip. */
const GRIP_SLOP = 10;
/** A selected clip counts as on screen while at least this much of it shows. */
const VISIBLE_DP = 12;
const FRAME_BAR = 3;

/** Each clip's [left, width] in dp, flattened (the tiles' layout). */
function slotsOf(layout: TimelineLayout): number[] {
  const g: number[] = [];
  const n = layout.starts.length;
  for (let i = 0; i < n; i++) {
    const end = i + 1 < n ? layout.starts[i + 1] : layout.totalMs;
    g.push(layout.starts[i] * DP_PER_MS, (end - layout.starts[i]) * DP_PER_MS);
  }
  return g;
}

/** The selected clip, as its trim handles need it. All times in ms. */
export type TrimInfo = {
  /** The clip's source window and source length. */
  startMs: number;
  endMs: number;
  sourceMs: number;
  speed: number;
  /** Where the clip starts on the timeline. */
  slotStartMs: number;
  /** One source frame. */
  frameMs: number;
};

/** 1 = the left (in) handle, 2 = the right (out) handle. */
export type TrimSide = 1 | 2;

type Props = {
  clips: EditorClip[];
  covers: ReadonlyMap<string, string | null>;
  peaks: ReadonlyMap<string, Peaks | null>;
  layout: TimelineLayout;
  selected: number;
  trim: TrimInfo | null;
  values: PlayheadValues;
  /** The selected clip scrolled out of view (it's let go). */
  onSelectedHidden: () => void;
  /** The scrub started (pause, approximate seeks). */
  onDragStart: () => void;
  /** A scrub (and its fling) ended at `ms`. */
  onScrubEnd: (ms: number) => void;
  /** A tap at timeline `ms` (outside the timeline: below 0 or past the end). */
  onTap: (ms: number) => void;
  onTrimStart: (side: TrimSide) => void;
  /** A handle was let go at source `ms` (snapped). Returns the clip's new place on the strip. */
  onTrimEnd: (side: TrimSide, ms: number) => { leftMs: number; lengthMs: number };
};

/**
 * The timeline: clips laid out at a fixed scale under a fixed centre playhead. One animated
 * transform moves the whole strip (time lives in `values.timeMs` on the UI thread); a pan scrubs
 * it and flings on release, a tap selects the clip under the finger, and the selected clip gets
 * a frame with trim grips. Covers and waveforms draw only near the visible part.
 */
export function TimelineStrip(props: Props) {
  const { clips, covers, peaks, layout, selected, trim, values } = props;
  const { timeMs, totalMs, mode, trimTarget, playing } = values;

  // The strip spans the screen: start centred before the first layout (no frame off-centre).
  const half = useSharedValue(Dimensions.get('window').width / 2);
  const panFrom = useSharedValue(0);
  const panning = useSharedValue(false);
  /** This touch stopped a fling: it ends the scrub there and selects nothing. */
  const stopped = useSharedValue(false);
  const side = useSharedValue(0);
  const delta = useSharedValue(0);
  const trimSrc = useSharedValue(0);
  const atLimit = useSharedValue(false);
  const frameLeft = useSharedValue(0);
  const frameWidth = useSharedValue(0);
  // Every clip's [left, width] (dp) on the UI thread, and which one a trim is resizing: tiles
  // draw from these, so a trim moves them live and its release lands in one frame.
  const slots = useSharedValue<number[]>(slotsOf(layout));
  const sel = useSharedValue(selected);
  const [motion] = useState(() => ({ slots, sel, side, delta }));
  const [trimming, setTrimming] = useState(-1);
  const scheme = useThemeMode();
  const theme = useTheme();
  const palette: TilePalette = {
    tile: SystemColors.gray5[scheme],
    film: SystemColors.gray4[scheme],
    wave: SystemColors.gray6[scheme],
    line: theme.warning,
    dim: theme.textSecondary,
  };
  const trimInfo = useSharedValue<TrimInfo | null>(null);
  const starts = useSharedValue<number[]>([]);
  useEffect(() => {
    starts.set(layout.starts);
  }, [layout.starts, starts]);
  const [width, setWidth] = useState(0);

  // The gestures are built once; their JS callbacks reach the current props through this.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const [handlers] = useState(() => ({
    dragStart: () => latest.current.onDragStart(),
    scrubEnd: (ms: number) => latest.current.onScrubEnd(ms),
    tap: (ms: number) => latest.current.onTap(ms),
    trimStart: (s: TrimSide) => {
      setTrimming(latest.current.selected);
      latest.current.onTrimStart(s);
    },
    trimEnd: (s: TrimSide, ms: number) => {
      const i = latest.current.selected;
      const next = latest.current.onTrimEnd(s, ms);
      const left = next.leftMs * DP_PER_MS;
      const w = next.lengthMs * DP_PER_MS;
      // The clips' new places (the trimmed one resized, the ones after it moved by the change),
      // applied with the end of the drag in one UI frame, so nothing snaps back first.
      const g = slotsOf(latest.current.layout);
      const shift = w - (g[i * 2 + 1] ?? w);
      g[i * 2] = left;
      g[i * 2 + 1] = w;
      for (let k = i + 1; k < g.length / 2; k++) g[k * 2] += shift;
      setTrimming(-1);
      scheduleOnUI(() => {
        'worklet';
        slots.set(g);
        frameLeft.set(left);
        frameWidth.set(w);
        delta.set(0);
        side.set(0);
      });
    },
    limit: () => haptics.drop(),
    hidden: () => latest.current.onSelectedHidden(),
  }));

  // The selected clip's frame follows the layout, except mid-trim (the drag owns it then).
  const selLeft = selected >= 0 ? (layout.starts[selected] ?? 0) * DP_PER_MS : 0;
  const selWidth =
    selected >= 0
      ? ((selected + 1 < layout.starts.length ? layout.starts[selected + 1] : layout.totalMs) -
          (layout.starts[selected] ?? 0)) *
        DP_PER_MS
      : 0;
  useEffect(() => {
    trimInfo.set(trim);
    const g = slotsOf(layout);
    scheduleOnUI(() => {
      'worklet';
      if (side.get() !== 0) return;
      slots.set(g);
      sel.set(selected);
      frameLeft.set(selLeft);
      frameWidth.set(selWidth);
    });
  }, [
    trim,
    layout,
    selected,
    selLeft,
    selWidth,
    trimInfo,
    side,
    slots,
    sel,
    frameLeft,
    frameWidth,
  ]);

  const { dragStart, scrubEnd, tap: tapAt, trimStart, trimEnd, limit, hidden: onHidden } = handlers;

  // The selected clip scrolled out of view: let it go (the clip being edited is always on screen).
  useAnimatedReaction(
    () => {
      if (selected < 0 || mode.get() === Mode.trim) return true;
      const st = starts.get();
      const s0 = st[selected];
      if (s0 === undefined) return true;
      const e0 = selected + 1 < st.length ? st[selected + 1] : totalMs.get();
      const halfMs = half.get() / DP_PER_MS;
      const edge = VISIBLE_DP / DP_PER_MS;
      const t = timeMs.get();
      return e0 > t - halfMs + edge && s0 < t + halfMs - edge;
    },
    (visible, prev) => {
      // Only when the person moved it (a scrub, a fling, playback), never a layout or a placement.
      if (prev === true && !visible && (mode.get() === Mode.scrub || playing.get())) {
        scheduleOnRN(onHidden);
      }
    },
    [selected],
  );

  // Switched away mid-scrub (or mid-fling): end it, so the preview leaves scrubbing.
  useEffect(
    () => () => {
      scheduleOnUI(() => {
        'worklet';
        if (mode.get() !== Mode.scrub) return;
        cancelAnimation(timeMs);
        mode.set(Mode.idle);
        scheduleOnRN(scrubEnd, timeMs.get());
      });
    },
    [mode, timeMs, scrubEnd],
  );
  const [gestures] = useState(() => {
    const scrub = Gesture.Pan()
      .activeOffsetX([-8, 8])
      .onBegin(() => {
        // A touch stops a fling where it is.
        stopped.set(mode.get() === Mode.scrub && !panning.get());
        cancelAnimation(timeMs);
      })
      .onStart(() => {
        const was = mode.get() === Mode.scrub;
        mode.set(Mode.scrub);
        panning.set(true);
        panFrom.set(timeMs.get());
        if (!was) scheduleOnRN(dragStart);
      })
      .onUpdate((e) => {
        timeMs.set(clamp(panFrom.get() - e.translationX / DP_PER_MS, 0, totalMs.get()));
      })
      .onFinalize((e) => {
        if (!panning.get()) {
          // The touch stopped a fling and let go without dragging (a tap, or a rest).
          if (stopped.get() && mode.get() === Mode.scrub) {
            mode.set(Mode.idle);
            scheduleOnRN(scrubEnd, timeMs.get());
          }
          return;
        }
        panning.set(false);
        timeMs.set(
          withDecay(
            { velocity: -e.velocityX / DP_PER_MS, clamp: [0, totalMs.get()], deceleration: 0.997 },
            (finished) => {
              // Interrupted by a new touch: that touch carries the scrub on (or ends it, a tap).
              if (!finished) return;
              mode.set(Mode.idle);
              scheduleOnRN(scrubEnd, timeMs.get());
            },
          ),
        );
      });

    const tap = Gesture.Tap()
      .maxDistance(10)
      .onEnd((e) => {
        // A tap that stopped a fling does only that (the pan's finalize ends the scrub).
        if (stopped.get() || mode.get() !== Mode.idle) return;
        // Above or below the clips is off-clip space (-1 lets a selection go).
        const band = (STRIP_HEIGHT - TILE_HEIGHT) / 2;
        if (e.y < band || e.y > STRIP_HEIGHT - band) {
          scheduleOnRN(tapAt, -1);
          return;
        }
        scheduleOnRN(tapAt, timeMs.get() + (e.x - half.get()) / DP_PER_MS);
      });

    const grip = (s: TrimSide) =>
      Gesture.Pan()
        .hitSlop({ left: GRIP_SLOP, right: GRIP_SLOP, top: 6, bottom: 6 })
        .onStart(() => {
          const info = trimInfo.get();
          if (!info) return;
          side.set(s);
          delta.set(0);
          atLimit.set(false);
          trimSrc.set(s === 1 ? info.startMs : info.endMs);
          trimTarget.set(
            info.slotStartMs + (s === 1 ? info.startMs : info.endMs - info.frameMs) / info.speed,
          );
          mode.set(Mode.trim);
          scheduleOnRN(trimStart, s);
        })
        .onUpdate((e) => {
          const info = trimInfo.get();
          if (!info || side.get() !== s) return;
          const base = s === 1 ? info.startMs : info.endMs;
          // The shortest-clip limits sit on frames, so a handle stopped there leaves a frame edge.
          const lo =
            s === 1
              ? 0
              : Math.min(
                  info.sourceMs,
                  ceilToFrame(info.startMs + MIN_CLIP_SOURCE_MS, info.frameMs),
                );
          const hi =
            s === 1
              ? Math.max(0, floorToFrame(info.endMs - MIN_CLIP_SOURCE_MS, info.frameMs))
              : info.sourceMs;
          const raw = clamp(base + (e.translationX / DP_PER_MS) * info.speed, lo, hi);
          const src = clamp(snapToFrame(raw, info.frameMs), lo, hi);
          const limited = src <= lo || src >= hi;
          if (limited && !atLimit.get()) scheduleOnRN(limit);
          atLimit.set(limited);
          trimSrc.set(src);
          delta.set(((src - base) / info.speed) * DP_PER_MS);
          // The preview has this clip untrimmed meanwhile: source time = slot start + src/speed.
          trimTarget.set(
            info.slotStartMs + (s === 1 ? src : Math.max(0, src - info.frameMs)) / info.speed,
          );
        })
        .onFinalize(() => {
          if (side.get() !== s || mode.get() !== Mode.trim) return;
          mode.set(Mode.idle);
          scheduleOnRN(trimEnd, s, trimSrc.get());
        });

    const left = grip(1);
    const right = grip(2);
    left.blocksExternalGesture(scrub, tap);
    right.blocksExternalGesture(scrub, tap);
    return { strip: Gesture.Race(scrub, tap), left, right };
  });

  // Draw covers and waveforms only within about a screen of the playhead: the page changes
  // once per strip width of travel, so tiles re-render rarely.
  const [page, setPage] = useState(0);
  const pageWidth = Math.max(1, width);
  useAnimatedReaction(
    () => Math.floor((timeMs.get() * DP_PER_MS) / pageWidth),
    (p, prev) => {
      if (p !== prev) scheduleOnRN(setPage, p);
    },
    [pageWidth],
  );
  const nearFrom = (page - 1) * pageWidth;
  const nearTo = (page + 2) * pageWidth;

  const content = useAnimatedStyle(() => ({
    transform: [{ translateX: half.get() - timeMs.get() * DP_PER_MS }],
  }));
  // Each grip's chevron says which way its edge can go: inward while the edge is at the source's
  // own start or end (nothing hidden beyond it), outward once it's trimmed (footage to bring
  // back). Follows the drag live.
  const leftTrimmed = useDerivedValue(() => {
    const info = trimInfo.get();
    if (!info) return false;
    const start = side.get() === 1 ? trimSrc.get() : info.startMs;
    return start > info.frameMs / 2;
  });
  const rightTrimmed = useDerivedValue(() => {
    const info = trimInfo.get();
    if (!info) return false;
    const end = side.get() === 2 ? trimSrc.get() : info.endMs;
    return end < info.sourceMs - info.frameMs / 2;
  });
  const leftOut = useAnimatedStyle(() => ({ opacity: leftTrimmed.get() ? 1 : 0 }));
  const leftIn = useAnimatedStyle(() => ({ opacity: leftTrimmed.get() ? 0 : 1 }));
  const rightOut = useAnimatedStyle(() => ({ opacity: rightTrimmed.get() ? 1 : 0 }));
  const rightIn = useAnimatedStyle(() => ({ opacity: rightTrimmed.get() ? 0 : 1 }));

  const frame = useAnimatedStyle(() => {
    const s = side.get();
    const d = delta.get();
    // The grips sit outside the clip, so the clip shows edge to edge inside the frame.
    const clipWidth = Math.max(1, frameWidth.get() + (s === 1 ? -d : s === 2 ? d : 0) - TILE_GAP);
    return {
      left: frameLeft.get() + (s === 1 ? d : 0) - GRIP_WIDTH,
      width: clipWidth + GRIP_WIDTH * 2,
    };
  });

  return (
    <GestureDetector gesture={gestures.strip}>
      <View
        style={styles.strip}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          setWidth(w);
          half.set(w / 2);
        }}>
        <Animated.View style={[styles.content, { width: layout.totalMs * DP_PER_MS }, content]}>
          {clips.map((c, i) => {
            const left = (layout.starts[i] ?? 0) * DP_PER_MS;
            const end =
              (i + 1 < layout.starts.length ? layout.starts[i + 1] : layout.totalMs) * DP_PER_MS;
            return (
              <ClipTile
                key={c.id}
                index={i}
                width={end - left}
                cover={covers.get(c.id) ?? null}
                peaks={peaks.get(c.uri)}
                edit={c.edit}
                sourceMs={c.sourceMs}
                near={i === trimming || (end >= nearFrom && left <= nearTo)}
                trimming={i === trimming}
                motion={motion}
                palette={palette}
              />
            );
          })}
          {selected >= 0 && (
            <Animated.View style={[styles.frame, frame]} pointerEvents="box-none">
              <GestureDetector gesture={gestures.left}>
                <View style={[styles.grip, styles.gripLeft]}>
                  <Animated.View style={[styles.chevron, leftOut]}>
                    <Icon name="chevron.compact.left" size={14} weight="bold" tintColor="#fff" />
                  </Animated.View>
                  <Animated.View style={[styles.chevron, leftIn]}>
                    <Icon name="chevron.compact.right" size={14} weight="bold" tintColor="#fff" />
                  </Animated.View>
                </View>
              </GestureDetector>
              <View style={styles.frameMiddle} pointerEvents="none" />
              <GestureDetector gesture={gestures.right}>
                <View style={[styles.grip, styles.gripRight]}>
                  <Animated.View style={[styles.chevron, rightOut]}>
                    <Icon name="chevron.compact.right" size={14} weight="bold" tintColor="#fff" />
                  </Animated.View>
                  <Animated.View style={[styles.chevron, rightIn]}>
                    <Icon name="chevron.compact.left" size={14} weight="bold" tintColor="#fff" />
                  </Animated.View>
                </View>
              </GestureDetector>
            </Animated.View>
          )}
        </Animated.View>
        <View
          pointerEvents="none"
          style={[styles.playhead, { left: width / 2 - 2, backgroundColor: theme.text }]}
        />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  strip: { height: STRIP_HEIGHT, justifyContent: 'center', overflow: 'hidden' },
  content: { height: TILE_HEIGHT },
  frame: {
    position: 'absolute',
    top: -FRAME_BAR,
    height: TILE_HEIGHT + FRAME_BAR * 2,
    flexDirection: 'row',
  },
  frameMiddle: {
    flex: 1,
    borderTopWidth: FRAME_BAR,
    borderBottomWidth: FRAME_BAR,
    borderColor: Accent,
  },
  grip: {
    width: GRIP_WIDTH,
    height: '100%',
    backgroundColor: Accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gripLeft: { borderTopLeftRadius: TILE_RADIUS, borderBottomLeftRadius: TILE_RADIUS },
  chevron: { position: 'absolute' },
  gripRight: { borderTopRightRadius: TILE_RADIUS, borderBottomRightRadius: TILE_RADIUS },
  playhead: {
    position: 'absolute',
    top: 2,
    bottom: 2,
    width: 4,
    borderRadius: 2,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 0 },
    elevation: 2,
  },
});
