import { useEffect, useRef, useState } from 'react';
import { Dimensions, StyleSheet, Text, View } from 'react-native';
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
  floorToFrame,
  formatTime,
  MAX_DP_PER_MS,
  MIN_CLIP_SOURCE_MS,
  minDpPerMs,
  rulerSteps,
  snapToFrame,
  type TimelineLayout,
} from './timeline-geometry';
import type { EditorClip } from './use-editor-draft';
import { Mode, type PlayheadValues } from './use-preview-transport';
import type { Peaks } from './use-waveforms';

/** The time ruler, above the clips. */
const RULER_HEIGHT = 16;
/** Space below the captions lane. */
const STRIP_PAD = 8;
/** The captions lane, under the clips. */
const LANE_GAP = 4;
const LANE_HEIGHT = 22;
const LANE_TOP = TILE_HEIGHT + LANE_GAP;
export const STRIP_HEIGHT = RULER_HEIGHT + LANE_TOP + LANE_HEIGHT + STRIP_PAD;
/** How often a pinch redraws the covers, waveforms, captions and ruler at the scale it's at
 * (between, they stretch to it). */
const ZOOM_REDRAW_MS = 100;
const GRIP_WIDTH = 16;
/** Extra touch area around each trim grip. */
const GRIP_SLOP = 10;
const FRAME_BAR = 3;

/** Each clip's [start, length] in timeline ms, flattened (the tiles' layout). */
function slotsOf(layout: TimelineLayout): number[] {
  const g: number[] = [];
  const n = layout.starts.length;
  for (let i = 0; i < n; i++) {
    const end = i + 1 < n ? layout.starts[i + 1] : layout.totalMs;
    g.push(layout.starts[i], end - layout.starts[i]);
  }
  return g;
}

/** A ruler label: m:ss, with tenths while the marks are under a second apart. */
const rulerLabel = (ms: number, majorMs: number) =>
  majorMs < 1000 ? formatTime(ms) : formatTime(ms).slice(0, -2);

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

/** A caption on the lane: timeline centiseconds, and its text. */
export type LaneCaption = { t0: number; t1: number; text: string };

type Props = {
  clips: EditorClip[];
  covers: ReadonlyMap<string, string | null>;
  peaks: ReadonlyMap<string, Peaks | null>;
  layout: TimelineLayout;
  selected: number;
  trim: TrimInfo | null;
  values: PlayheadValues;
  /** The draft's captions, drawn on a lane under the clips. */
  captions: readonly LaneCaption[];
  /** The caption being edited (outlined), or -1. */
  captionSelected: number;
  /** A tap on the captions lane at timeline `ms`. */
  onCaptionTap: (ms: number) => void;
  /** The scale to open at (dp per timeline ms), and where a pinch left it. */
  zoom: number;
  onZoom: (dpPerMs: number) => void;
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
 * The timeline: clips laid out at a scale under a fixed centre playhead, a time ruler above them
 * and the draft's captions on a lane below (a tap there opens them). One animated transform moves
 * the whole strip (time lives in `values.timeMs` on the UI thread); a pan scrubs it and flings on
 * release, a pinch zooms it around the playhead, a tap selects the clip under the finger, and the
 * selected clip gets a frame with trim grips. The scale lives on the UI thread too: the clips and
 * the frame follow a pinch every frame, while covers, waveforms, captions and the ruler are drawn
 * at the scale of the last redraw and stretched to it in between. Covers, waveforms, captions and
 * ruler marks draw only near the visible part.
 */
export function TimelineStrip(props: Props) {
  const { clips, covers, peaks, layout, selected, trim, values, captions, captionSelected } = props;
  const { timeMs, totalMs, mode, trimTarget } = values;

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
  // The scale: live on the UI thread (`zoomNow`, what a pinch moves), and the one the content
  // was last drawn at (`zoom`).
  const [zoom, setZoom] = useState(props.zoom);
  const zoomNow = useSharedValue(props.zoom);
  const pinchFrom = useSharedValue(props.zoom);
  const lastRedraw = useSharedValue(0);
  // Every clip's [start, length] (ms) on the UI thread, and which one a trim is resizing: tiles
  // draw from these, so a trim moves them live and its release lands in one frame.
  const slots = useSharedValue<number[]>(slotsOf(layout));
  const sel = useSharedValue(selected);
  const [motion] = useState(() => ({ slots, sel, side, delta, zoom: zoomNow }));
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
    captionTap: (ms: number) => latest.current.onCaptionTap(ms),
    trimStart: (s: TrimSide) => {
      setTrimming(latest.current.selected);
      latest.current.onTrimStart(s);
    },
    trimEnd: (s: TrimSide, ms: number) => {
      const i = latest.current.selected;
      const next = latest.current.onTrimEnd(s, ms);
      const left = next.leftMs;
      const w = next.lengthMs;
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
    redraw: (z: number) => setZoom(z),
    zoomed: (z: number) => {
      setZoom(z);
      latest.current.onZoom(z);
    },
  }));

  // The selected clip's frame follows the layout, except mid-trim (the drag owns it then). In ms.
  const selLeft = selected >= 0 ? (layout.starts[selected] ?? 0) : 0;
  const selWidth =
    selected >= 0
      ? (selected + 1 < layout.starts.length ? layout.starts[selected + 1] : layout.totalMs) -
        (layout.starts[selected] ?? 0)
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

  const {
    dragStart,
    scrubEnd,
    tap: tapAt,
    captionTap,
    trimStart,
    trimEnd,
    limit,
    redraw,
    zoomed,
  } = handlers;

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
      .maxPointers(1)
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
        timeMs.set(clamp(panFrom.get() - e.translationX / zoomNow.get(), 0, totalMs.get()));
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
            {
              velocity: -e.velocityX / zoomNow.get(),
              clamp: [0, totalMs.get()],
              deceleration: 0.997,
            },
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
        const ms = timeMs.get() + (e.x - half.get()) / zoomNow.get();
        const y = e.y - RULER_HEIGHT;
        // The captions lane (with a little slack into the gap above it).
        if (y >= LANE_TOP - LANE_GAP && y <= LANE_TOP + LANE_HEIGHT + 4) {
          scheduleOnRN(captionTap, ms);
          return;
        }
        // The ruler, and below the lane, are off-clip space (-1 lets a selection go).
        if (y < 0 || y > TILE_HEIGHT) {
          scheduleOnRN(tapAt, -1);
          return;
        }
        scheduleOnRN(tapAt, ms);
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
          const raw = clamp(base + (e.translationX / zoomNow.get()) * info.speed, lo, hi);
          const src = clamp(snapToFrame(raw, info.frameMs), lo, hi);
          const limited = src <= lo || src >= hi;
          if (limited && !atLimit.get()) scheduleOnRN(limit);
          atLimit.set(limited);
          trimSrc.set(src);
          delta.set((src - base) / info.speed);
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

    // Two fingers zoom around the playhead (it stays put, the timeline stretches or shrinks
    // about it): from the whole draft fitting the strip to MAX_DP_PER_MS.
    const pinch = Gesture.Pinch()
      .onStart(() => {
        pinchFrom.set(zoomNow.get());
        lastRedraw.set(0);
      })
      .onUpdate((e) => {
        const lo = minDpPerMs(totalMs.get(), half.get() * 2);
        const z = clamp(pinchFrom.get() * e.scale, lo, MAX_DP_PER_MS);
        zoomNow.set(z);
        const now = Date.now();
        if (now - lastRedraw.get() >= ZOOM_REDRAW_MS) {
          lastRedraw.set(now);
          scheduleOnRN(redraw, z);
        }
      })
      .onEnd(() => {
        scheduleOnRN(zoomed, zoomNow.get());
      });

    const left = grip(1);
    const right = grip(2);
    left.blocksExternalGesture(scrub, tap, pinch);
    right.blocksExternalGesture(scrub, tap, pinch);
    return { strip: Gesture.Race(pinch, scrub, tap), left, right };
  });

  // Draw covers, waveforms, captions and ruler marks only within about a screen of the playhead:
  // the page changes once per strip width of travel, so they re-render rarely.
  const [page, setPage] = useState(0);
  const pageMs = Math.max(1, width) / zoom;
  useAnimatedReaction(
    () => Math.floor(timeMs.get() / pageMs),
    (p, prev) => {
      if (p !== prev) scheduleOnRN(setPage, p);
    },
    [pageMs],
  );
  const nearFrom = (page - 1) * pageMs;
  const nearTo = (page + 2) * pageMs;

  const content = useAnimatedStyle(() => ({
    transform: [{ translateX: half.get() - timeMs.get() * zoomNow.get() }],
  }));
  // The captions and the ruler, drawn at `zoom`, stretched to the live scale about time 0.
  const drawn = useAnimatedStyle(() => ({ transform: [{ scaleX: zoomNow.get() / zoom }] }), [zoom]);
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
    const z = zoomNow.get();
    const s = side.get();
    const d = delta.get();
    // The grips sit outside the clip, so the clip shows edge to edge inside the frame.
    const clipMs = frameWidth.get() + (s === 1 ? -d : s === 2 ? d : 0);
    return {
      left: (frameLeft.get() + (s === 1 ? d : 0)) * z - GRIP_WIDTH,
      width: Math.max(1, clipMs * z - TILE_GAP) + GRIP_WIDTH * 2,
    };
  });

  // The ruler's marks near the playhead: a tick every minorMs, a taller one and a label every
  // majorMs.
  const { majorMs, minorMs } = rulerSteps(zoom);
  const marks: { ms: number; major: boolean }[] = [];
  const lastMark = Math.min(layout.totalMs, nearTo);
  for (let n = Math.max(0, Math.floor(nearFrom / minorMs)); n * minorMs <= lastMark; n++) {
    const ms = n * minorMs;
    marks.push({ ms, major: Math.abs(ms / majorMs - Math.round(ms / majorMs)) < 1e-6 });
  }

  return (
    <GestureDetector gesture={gestures.strip}>
      <View
        style={styles.strip}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          setWidth(w);
          half.set(w / 2);
        }}>
        <Animated.View style={[styles.content, { width: layout.totalMs * zoom }, content]}>
          <Animated.View
            style={[styles.drawn, { width: layout.totalMs * zoom }, drawn]}
            pointerEvents="none">
            <View style={styles.ruler}>
              {marks.map((m) => (
                <View
                  key={m.ms}
                  style={[
                    m.major ? styles.majorTick : styles.minorTick,
                    { left: m.ms * zoom, backgroundColor: theme.textSecondary },
                  ]}
                />
              ))}
              {marks
                .filter((m) => m.major)
                .map((m) => (
                  <Text
                    key={`l${m.ms}`}
                    allowFontScaling={false}
                    style={[
                      styles.rulerLabel,
                      { left: m.ms * zoom + 3, color: theme.textSecondary },
                    ]}>
                    {rulerLabel(m.ms, majorMs)}
                  </Text>
                ))}
            </View>
            <View style={[styles.lane, { backgroundColor: palette.wave }]}>
              {captions.map((c, i) => {
                if (c.t1 * 10 < nearFrom || c.t0 * 10 > nearTo) return null;
                return (
                  <View
                    key={i}
                    style={[
                      styles.cue,
                      {
                        left: c.t0 * 10 * zoom,
                        width: Math.max(6, (c.t1 - c.t0) * 10 * zoom - 2),
                        backgroundColor: palette.tile,
                      },
                      i === captionSelected && styles.cueSelected,
                    ]}>
                    <Text numberOfLines={1} style={[styles.cueText, { color: theme.text }]}>
                      {c.text}
                    </Text>
                  </View>
                );
              })}
            </View>
          </Animated.View>
          {clips.map((c, i) => {
            const left = layout.starts[i] ?? 0;
            const end = i + 1 < layout.starts.length ? layout.starts[i + 1] : layout.totalMs;
            return (
              <ClipTile
                key={c.id}
                id={c.id}
                uri={c.uri}
                index={i}
                lengthMs={end - left}
                dpPerMs={zoom}
                cover={covers.get(c.id) ?? null}
                peaks={peaks.get(c.uri)}
                edit={c.edit}
                sourceMs={c.sourceMs}
                startMs={left}
                near={i === trimming || (end >= nearFrom && left <= nearTo)}
                nearFromMs={nearFrom}
                nearToMs={nearTo}
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
  strip: { height: STRIP_HEIGHT, paddingTop: RULER_HEIGHT, overflow: 'hidden' },
  content: { height: TILE_HEIGHT },
  // The ruler and the lane, scaled about the timeline's start (time 0).
  drawn: { position: 'absolute', top: 0, left: 0, height: TILE_HEIGHT, transformOrigin: 'left' },
  ruler: { position: 'absolute', top: -RULER_HEIGHT, left: 0, right: 0, height: RULER_HEIGHT },
  majorTick: {
    position: 'absolute',
    bottom: 0,
    width: StyleSheet.hairlineWidth * 2,
    height: 6,
    opacity: 0.5,
  },
  minorTick: {
    position: 'absolute',
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    height: 3,
    opacity: 0.35,
  },
  rulerLabel: {
    position: 'absolute',
    top: 0,
    fontSize: 9,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
    opacity: 0.7,
  },
  lane: {
    position: 'absolute',
    top: LANE_TOP,
    left: 0,
    right: 0,
    height: LANE_HEIGHT,
    borderRadius: 6,
  },
  cue: {
    position: 'absolute',
    top: 0,
    height: LANE_HEIGHT,
    borderRadius: 6,
    borderCurve: 'continuous',
    paddingHorizontal: 6,
    justifyContent: 'center',
  },
  cueSelected: { borderWidth: 2, borderColor: Accent, paddingHorizontal: 4 },
  cueText: { fontSize: 11, fontWeight: '600' },
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
