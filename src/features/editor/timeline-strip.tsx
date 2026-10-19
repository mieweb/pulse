import { useEffect, useMemo, useRef, useState } from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';

import { Icon } from '@/components/icon';
import { Accent, SystemColors } from '@/constants/theme';
import { useTheme, useThemeMode } from '@/hooks/use-theme';
import { EaseOut } from '@/constants/motion';
import { haptics } from '@/utils/haptics';

import { ClipTile, TILE_GAP, TILE_HEIGHT, TILE_RADIUS, type TilePalette } from './clip-tile';
import {
  anyFrame,
  frameStep,
  frameTimes,
  framesOf,
  tileWidth,
  useFrames,
  type FrameWant,
} from './filmstrip';
import { CAP_GRIP, TimelineCanvas, useCovers, type CanvasClip } from './timeline-canvas';
import {
  ceilToFrame,
  clamp,
  DP_PER_MS,
  floorToFrame,
  MAX_DP_PER_MS,
  MIN_CLIP_SOURCE_MS,
  minDpPerMs,
  snapToFrame,
  type TimelineLayout,
  type ZoomRequest,
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
/** How far a pinch moves the scale before the strip re-renders for it (asks for the frames and
 * the scroll width of the new scale): a factor of √2, so the frame step (a power of two) is never
 * more than one level behind; the canvas follows the live scale in between. */
const ZOOM_LEVELS_PER_DOUBLING = 2;
/** How long after a pinch the scroll view's moves still count as the pinch's (its fingers lifting
 * one after the other, their momentum). */
const PINCH_SETTLE_MS = 400;

/** Which step of ZOOM_LEVELS_PER_DOUBLING a scale is on. */
function zoomLevel(dpPerMs: number): number {
  'worklet';
  return Math.floor(Math.log2(dpPerMs) * ZOOM_LEVELS_PER_DOUBLING);
}
const GRIP_WIDTH = 16;
/** Extra touch area around each trim grip. */
const GRIP_SLOP = 10;
const FRAME_BAR = 3;

/** The scale a pinch left the timeline at (dp per ms), kept while switching views. */
let keptZoom = DP_PER_MS;
/** Back to the usual scale (an editor opening). */
export function resetTimelineZoom() {
  keptZoom = DP_PER_MS;
}

/** The look frames are fetched in: none (the canvas draws each clip's edit on them). */
const UNEDITED = { rotation: 0, flipped: false, crop: null };

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

/** The selected word's box and how far its grips may go (timeline ms): the start within
 * lo0 … hi0, the end within lo1 … hi1 (each grip moves only this word). */
export type CaptionDrag = {
  box: { t0: number; t1: number };
  lo0: number;
  hi0: number;
  lo1: number;
  hi1: number;
};

/** A caption on the lane: timeline centiseconds, and its text. */
export type LaneCaption = {
  t0: number;
  t1: number;
  text: string;
  /** Its words (timeline centiseconds), drawn at their own times once they fit. */
  words?: readonly { text: string; t0: number; t1: number }[];
};

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
  /** The selected caption (index in `captions`), or -1; its selected word, or -1. */
  captionSelected: number;
  captionWord: number;
  /** What the selection's grips may do (null: nothing selected). */
  captionDrag: CaptionDrag | null;
  /** A tap on the captions lane at timeline `ms`, at the scale it was made at (dp per ms). */
  onCaptionTap: (ms: number, dpPerMs: number) => void;
  /** A selected word's grip picked up, and let go: `side` 1 its start, 2 its end, at timeline
   * `ms`. */
  onCaptionDragStart: () => void;
  /** Zoom to an editing scale (`captionZoom`, `clipZoom`): to `target`, unless the strip is
   * already within min … max. A new `seq` asks again. */
  zoomTo?: (ZoomRequest & { seq: number }) | null;
  onCaptionDragEnd: (side: number, ms: number) => void;
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
  const { captionWord, captionDrag } = props;
  const { timeMs, totalMs, mode, trimTarget } = values;

  // The strip spans the screen: start centred before the first layout (no frame off-centre).
  const half = useSharedValue(Dimensions.get('window').width / 2);
  // The strip scrolls with the platform's own scroll view (UIScrollView on iOS), so a drag and a
  // fling feel native: an invisible one under the drawing, whose offset is the playhead's time ×
  // the scale. `user`: a finger (or its fling) is moving it, so time follows it; otherwise it
  // follows time (playback, a seek). `pinching`: a pinch owns the scale, and the scroll view's
  // offset is ignored until it's set again at the end. `stopped`: this touch stopped a fling.
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const user = useSharedValue(false);
  const pinching = useSharedValue(false);
  const stopped = useSharedValue(false);
  // The selected word's grips: what they may do, which one is held (1 start, 2 end) and where it
  // is (ms), all on the UI thread.
  const capInfo = useSharedValue<CaptionDrag | null>(null);
  const capSide = useSharedValue(0);
  const capValue = useSharedValue(0);
  const capSnapped = useSharedValue(false);
  const pinchEndedAt = useSharedValue(0);
  const side = useSharedValue(0);
  const delta = useSharedValue(0);
  const trimSrc = useSharedValue(0);
  const atLimit = useSharedValue(false);
  const frameLeft = useSharedValue(0);
  const frameWidth = useSharedValue(0);
  // The scale: live on the UI thread (`zoomNow`, what a pinch moves), and the one the content
  // was last drawn at (`zoom`).
  const [zoom, setZoom] = useState(() => keptZoom);
  const zoomNow = useSharedValue(keptZoom);
  const pinchFrom = useSharedValue(keptZoom);
  const lastLevel = useSharedValue(0);
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
    captionTap: (ms: number, z: number) => latest.current.onCaptionTap(ms, z),
    capStart: () => {
      haptics.pickUp();
      latest.current.onCaptionDragStart();
    },
    capEnd: (side: number, ms: number) => {
      latest.current.onCaptionDragEnd(side, ms);
      // The drag stays drawn until the saved captions arrive (`capKey` changes), or this long if
      // nothing changed.
      setTimeout(() => capSide.set(0), 700);
    },
    capSnap: () => haptics.tap(),
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
      keptZoom = z;
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
    capStart,
    capEnd,
    capSnap,
  } = handlers;

  // The selection's limits on the UI thread; a new selection (or the saved result of a drag)
  // ends the drawn drag.
  const capKey = captionDrag
    ? `${captionSelected}:${captionWord}:${captionDrag.box.t0}:${captionDrag.box.t1}`
    : '';
  useEffect(() => {
    capInfo.set(captionDrag);
    capSide.set(0);
    // `capKey` is what decides; `captionDrag` is read for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capKey, capInfo, capSide]);
  // The selection's touch areas: the box (or word) with a grip each side, following a drag.
  const capFrame = useAnimatedStyle(() => {
    const info = capInfo.get();
    if (!info) return { left: 0, width: 0 };
    const z = zoomNow.get();
    const s = capSide.get();
    const v = capValue.get();
    let a = info.box.t0;
    let b = info.box.t1;
    if (s === 1) a = v;
    else if (s === 2) b = v;
    return { left: a * z - CAP_GRIP, width: Math.max(1, (b - a) * z) + CAP_GRIP * 2 };
  });

  // Switched away mid-scroll (or mid-fling): end it, so the preview leaves scrubbing.
  useEffect(
    () => () => {
      scheduleOnUI(() => {
        'worklet';
        if (!user.get()) return;
        user.set(false);
        mode.set(Mode.idle);
        scheduleOnRN(scrubEnd, timeMs.get());
      });
    },
    [user, mode, timeMs, scrubEnd],
  );

  // The scroll view under the playhead's time, whenever something else moved it.
  const follow = () => {
    'worklet';
    if (user.get() || pinching.get()) return;
    scrollTo(scrollRef, timeMs.get() * zoomNow.get(), 0, false);
  };
  useAnimatedReaction(
    () => timeMs.get(),
    () => follow(),
  );
  // A pinch let go: the scroll view back under the playhead at the new scale (its content grows
  // or shrinks with the next render, and `onContentSizeChange` places it again then).
  useAnimatedReaction(
    () => pinching.get(),
    (now, before) => {
      if (before && !now) follow();
    },
  );
  const finish = () => {
    'worklet';
    if (!user.get()) return;
    user.set(false);
    mode.set(Mode.idle);
    scheduleOnRN(scrubEnd, timeMs.get());
  };
  /** A pinch is on, or just ended: the scroll view's moves are the pinch's fingers (or what's
   * left of their momentum), not a scroll. */
  const pinchy = () => {
    'worklet';
    return pinching.get() || Date.now() - pinchEndedAt.get() < PINCH_SETTLE_MS;
  };
  const begin = () => {
    'worklet';
    if (user.get() || mode.get() === Mode.trim || pinchy()) return;
    user.set(true);
    mode.set(Mode.scrub);
    scheduleOnRN(dragStart);
  };
  const onScroll = useAnimatedScrollHandler({
    onBeginDrag: () => begin(),
    onScroll: (e) => {
      if (!user.get() || pinching.get()) return;
      timeMs.set(clamp(e.contentOffset.x / zoomNow.get(), 0, totalMs.get()));
    },
    onEndDrag: (e) => {
      // No fling: done now; otherwise the momentum's end finishes it.
      if (Math.abs(e.velocity?.x ?? 0) < 0.01) finish();
    },
    onMomentumBegin: () => {
      // A pinch's fingers lifting with some speed: no fling; the scroll view back under the
      // playhead (which stops it).
      if (pinchy()) follow();
      else begin();
    },
    onMomentumEnd: () => finish(),
  });

  const [gestures] = useState(() => {
    // The scroll view, as a gesture the others can run alongside.
    const native = Gesture.Native();

    const tap = Gesture.Tap()
      .maxDistance(10)
      .onBegin(() => {
        // A touch on a moving strip stops it (the scroll view does), and does only that.
        stopped.set(user.get());
      })
      .onEnd((e) => {
        if (stopped.get() || mode.get() !== Mode.idle) return;
        const ms = timeMs.get() + (e.x - half.get()) / zoomNow.get();
        const y = e.y - RULER_HEIGHT;
        // The captions lane (with a little slack into the gap above it).
        if (y >= LANE_TOP - LANE_GAP && y <= LANE_TOP + LANE_HEIGHT + 4) {
          scheduleOnRN(captionTap, ms, zoomNow.get());
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
        // A scroll the fingers had started ends where it is: from here they zoom.
        finish();
        pinching.set(true);
        pinchFrom.set(zoomNow.get());
        lastLevel.set(zoomLevel(zoomNow.get()));
      })
      .onUpdate((e) => {
        const lo = minDpPerMs(totalMs.get(), half.get() * 2);
        const z = clamp(pinchFrom.get() * e.scale, lo, MAX_DP_PER_MS);
        zoomNow.set(z);
        const level = zoomLevel(z);
        if (level !== lastLevel.get()) {
          lastLevel.set(level);
          scheduleOnRN(redraw, z);
        }
      })
      .onEnd(() => {
        scheduleOnRN(zoomed, zoomNow.get());
      })
      .onFinalize(() => {
        pinchEndedAt.set(Date.now());
        pinching.set(false);
      });

    // The selected caption's grips: an edge within its limits, snapping to the playhead.
    const capGrip = (side: 1 | 2) =>
      Gesture.Pan()
        .hitSlop({ left: 12, right: 12, top: 8, bottom: 8 })
        .onStart(() => {
          const info = capInfo.get();
          if (!info) return;
          capSide.set(side);
          capSnapped.set(false);
          capValue.set(side === 1 ? info.box.t0 : info.box.t1);
          trimTarget.set(capValue.get());
          mode.set(Mode.trim);
          scheduleOnRN(capStart);
        })
        .onUpdate((e) => {
          const info = capInfo.get();
          if (!info || capSide.get() !== side) return;
          const z = zoomNow.get();
          const base = side === 1 ? info.box.t0 : info.box.t1;
          const lo = side === 1 ? info.lo0 : info.lo1;
          const hi = side === 1 ? info.hi0 : info.hi1;
          let v = clamp(base + e.translationX / z, lo, hi);
          const t = timeMs.get();
          const snap = Math.abs(v - t) * z < 8 && t >= lo && t <= hi;
          if (snap) v = t;
          if (snap && !capSnapped.get()) scheduleOnRN(capSnap);
          capSnapped.set(snap);
          capValue.set(v);
          trimTarget.set(v);
        })
        .onFinalize(() => {
          if (capSide.get() !== side || mode.get() !== Mode.trim) return;
          mode.set(Mode.idle);
          scheduleOnRN(capEnd, side, capValue.get());
        });
    // A tap on the selected word lets it go.
    const capTap = Gesture.Tap()
      .maxDistance(10)
      .onEnd((e) => {
        const info = capInfo.get();
        if (!info) return;
        const z = zoomNow.get();
        scheduleOnRN(captionTap, info.box.t0 + (e.x - CAP_GRIP) / z, z);
      });
    const capLeft = capGrip(1);
    const capRight = capGrip(2);
    const capBody = capTap;

    const left = grip(1);
    const right = grip(2);
    for (const g of [left, right, capLeft, capRight, capTap]) {
      g.blocksExternalGesture(native, tap, pinch);
    }
    pinch.simultaneousWithExternalGesture(native);
    tap.simultaneousWithExternalGesture(native);
    return { strip: Gesture.Race(pinch, tap), native, left, right, capLeft, capRight, capBody };
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

  // A caption or a clip to edit: zoom to its scale, about the playhead (as a pinch does), unless
  // the current one already suits. The scroll view's offset is ignored meanwhile, and set again
  // at the end (the same as after a pinch).
  const zoomSeq = props.zoomTo?.seq ?? 0;
  useEffect(() => {
    const req = latest.current.zoomTo;
    if (!req) return;
    const z0 = zoomNow.get();
    if (z0 >= req.min && z0 <= req.max) return;
    const z = req.target;
    if (req.instant) {
      // The scroll view is placed again when its content takes the new width.
      zoomNow.set(z);
      zoomed(z);
      return;
    }
    pinching.set(true);
    zoomNow.set(
      withTiming(z, { duration: 250, easing: EaseOut }, (finished) => {
        pinching.set(false);
        if (finished) scheduleOnRN(zoomed, z);
      }),
    );
    // `zoomSeq` is what asks; the request is read from `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomSeq]);

  // Spike: drive the strip from the debugger (dev builds only).
  useEffect(() => {
    if (!__DEV__) return;
    (globalThis as { __timeline?: object }).__timeline = {
      seek: (ms: number) => timeMs.set(ms),
      zoom: (z: number) => {
        zoomNow.set(z);
        setZoom(z);
        keptZoom = z;
      },
      state: () => ({ timeMs: timeMs.get(), zoom: zoomNow.get(), totalMs: totalMs.get() }),
    };
  }, [timeMs, zoomNow, totalMs]);

  const content = useAnimatedStyle(() => ({
    transform: [{ translateX: half.get() - timeMs.get() * zoomNow.get() }],
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

  // What the canvas draws (timeline-canvas.tsx), and the frames each clip asks for: those near
  // the screen at the scale of the last redraw, within its trim (all of its source while a grip
  // drags, so footage brought back already has frames).
  const coverImages = useCovers(clips.map((c) => ({ id: c.id, uri: covers.get(c.id) ?? null })));
  // Every clip asks (for its coarse frames, the whole draft's from the start); the ones near the
  // screen also for their detail, nearest the middle of the screen first, and the clips are asked
  // for in order of how near they are, so what's on screen fills in first.
  const centerMs = (page + 0.5) * pageMs;
  // Frames are the file's own, unedited: the canvas draws a clip's rotate, flip and crop on them,
  // so an edit shows at once on frames already loaded instead of fetching a new set.
  const look = UNEDITED;
  // Each clip's tile width: its picture's shape as edited.
  const tileWs = clips.map((c, i) =>
    tileWidth(anyFrame(c.uri, UNEDITED), coverImages[i] ?? null, c.edit),
  );
  const wants: (FrameWant & { distance: number })[] = [];
  clips.forEach((c, i) => {
    const start = layout.starts[i] ?? 0;
    const end = i + 1 < layout.starts.length ? layout.starts[i + 1] : layout.totalMs;
    const distance = centerMs < start ? start - centerMs : centerMs > end ? centerMs - end : 0;
    const step = frameStep(zoom, c.edit.speed, tileWs[i]);
    if (end < nearFrom || start > nearTo) {
      wants.push({
        id: c.id,
        uri: c.uri,
        look,
        near: [],
        nearStep: step,
        sourceMs: c.sourceMs,
        distance,
      });
      return;
    }
    const { speed } = c.edit;
    const lo = i === trimming ? 0 : c.edit.startMs;
    const hi = i === trimming ? c.sourceMs : c.edit.endMs;
    const from = Math.max(lo, c.edit.startMs + (nearFrom - start) * speed);
    const to = Math.min(hi, c.edit.startMs + (nearTo - start) * speed);
    // The source time at the middle of the screen, for ordering this clip's detail.
    const centerSrc = c.edit.startMs + (centerMs - start) * speed;
    const near = to > from ? frameTimes(step, from, to, c.sourceMs) : [];
    near.sort((a, b) => Math.abs(a - centerSrc) - Math.abs(b - centerSrc));
    wants.push({
      id: c.id,
      uri: c.uri,
      look,
      near,
      nearStep: step,
      sourceMs: c.sourceMs,
      distance,
    });
  });
  wants.sort((a, b) => a.distance - b.distance);
  const framesVersion = useFrames(wants);
  const canvasClips = useMemo<CanvasClip[]>(
    () =>
      clips.map((c, i) => {
        const f = framesOf(c.uri, UNEDITED);
        return {
          inMs: c.edit.startMs,
          outMs: c.edit.endMs,
          speed: c.edit.speed,
          sourceMs: c.sourceMs,
          muted: c.edit.muted,
          peaks: peaks.get(c.uri) ?? null,
          cover: coverImages[i] ?? null,
          // The editor's quarter turns are counter-clockwise; the canvas turns clockwise.
          turns: (4 - c.edit.rotation) % 4,
          flipped: c.edit.flipped,
          crop: c.edit.crop,
          tileW: tileWs[i],
          frameTimes: f.times,
          frameImages: f.images,
        };
      }),
    // `framesVersion` is what says the frames changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clips, peaks, coverImages, framesVersion],
  );

  return (
    <GestureDetector gesture={gestures.strip}>
      <View
        style={styles.strip}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          setWidth(w);
          half.set(w / 2);
        }}>
        {width > 0 && (
          <TimelineCanvas
            width={width}
            rulerTop={0}
            rulerHeight={RULER_HEIGHT}
            tilesTop={RULER_HEIGHT}
            laneTop={RULER_HEIGHT + LANE_TOP}
            laneHeight={LANE_HEIGHT}
            clips={canvasClips}
            captions={captions}
            captionSelected={captionSelected}
            captionWord={captionWord}
            capSide={capSide}
            capValue={capValue}
            timeMs={timeMs}
            motion={motion}
            palette={{ ...palette, text: theme.text, ruler: theme.textSecondary }}
          />
        )}
        {/* Invisible: only its offset is read (the playhead's time × the scale). Its content is
            the timeline's width plus the strip's, so time 0 and the end both reach the middle. */}
        <GestureDetector gesture={gestures.native}>
          <Animated.ScrollView
            ref={scrollRef}
            horizontal
            style={StyleSheet.absoluteFill}
            showsHorizontalScrollIndicator={false}
            onScroll={onScroll}
            scrollEventThrottle={16}
            onContentSizeChange={() =>
              scheduleOnUI(() => {
                'worklet';
                follow();
              })
            }>
            <View style={{ width: layout.totalMs * zoom + width, height: STRIP_HEIGHT }} />
          </Animated.ScrollView>
        </GestureDetector>
        <Animated.View
          style={[styles.content, { width: layout.totalMs * zoom }, content]}
          // Over the scroll view: only the trim grips take touches; the rest falls through to it.
          pointerEvents="box-none">
          {clips.map((c, i) => (
            <ClipTile key={c.id} index={i} edit={c.edit} motion={motion} palette={palette} />
          ))}
          {/* The selected word's touch areas (the canvas draws them): its grips, and the word
              between, which a tap lets go. */}
          {captionDrag && (
            <Animated.View style={[styles.capFrame, capFrame]} pointerEvents="box-none">
              <GestureDetector gesture={gestures.capLeft}>
                <View style={styles.capGrip} />
              </GestureDetector>
              <GestureDetector gesture={gestures.capBody}>
                <View style={styles.capBody} />
              </GestureDetector>
              <GestureDetector gesture={gestures.capRight}>
                <View style={styles.capGrip} />
              </GestureDetector>
            </Animated.View>
          )}
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
  // Tall enough to hold the captions lane's touch areas (touches outside a view never reach it).
  content: { height: LANE_TOP + LANE_HEIGHT + 4 },
  capFrame: {
    position: 'absolute',
    top: LANE_TOP - 2,
    height: LANE_HEIGHT + 4,
    flexDirection: 'row',
  },
  capGrip: { width: CAP_GRIP, height: '100%' },
  capBody: { flex: 1, height: '100%' },
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
