// The gesture and frame loop reach the latest scrub callbacks through refs written during
// render — the pattern the React-Compiler refs rule flags. Disabled for this file.
/* eslint-disable react-hooks/refs */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  scrollTo,
  useAnimatedReaction,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withTiming,
  type AnimatedRef,
  type FrameInfo,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import type { Segment } from '@/db/schema';
import { segmentOffsets } from '@/utils/segment-window';
import { msToPx, pxToMs } from './track-mapping';
import { KNOB, SCRUB_INSET, STEP, THUMB_WIDTH } from './track-metrics';

/** Max rate at which a knob drag issues player seeks (the knob itself moves every frame). */
const SCRUB_INTERVAL_MS = 80;

/** Scrub auto-scroll: while the dragged knob dwells within EDGE_ZONE px of a viewport edge, the bar
 *  scrolls continuously at up to MAX_SCROLL_SPEED px/s (ramping with depth into the zone), so a long
 *  bar can be crossed by holding at the edge rather than repeatedly dragging. The knob's screen-x is
 *  clamped KNOB_PAD in from each edge so it stays fully visible and never chases the finger off-screen. */
const EDGE_ZONE = 56;
const MAX_SCROLL_SPEED = 760;
const KNOB_PAD = KNOB;

/** Breathing room kept between the playhead and each viewport edge before the bar auto-scrolls to
 *  follow it during PLAYBACK. Set to the scrub zone's outer bound so playback parks the playhead
 *  exactly where scrub auto-scroll begins — grabbing the knob mid-follow then starts at zero velocity
 *  (no creep) and only scrolls once the finger pushes further into the edge. */
const EDGE_MARGIN = KNOB_PAD + EDGE_ZONE;

/** Playhead state, present only while the preview is open. */
export type Cursor = {
  activeId: string | null;
  globalMs: number;
  onScrub: (globalMs: number) => void;
  /** Fired true at finger-down on the playhead, false on release — lets the preview
   *  suppress its play badge while a drag is in flight (boundary crossings otherwise
   *  blink it via their transient clip loads). */
  onScrubbingChange?: (scrubbing: boolean) => void;
};

/**
 * The draggable playhead over the track. Thumbs are fixed-width, so each thumb maps
 * proportionally onto its segment's effective (trimmed) duration; gaps snap to the
 * nearer thumb edge. Rendered OUTSIDE the ScrollView and positioned by
 * `contentX − scrollOffset`, so its pan gesture never competes with the bar's scroll or
 * sortables' long-press drag.
 *
 * The bar auto-scrolls to keep the playhead visible, with two mechanisms tuned to their physics:
 * during PLAYBACK (the knob moves on its own) a calm edge-band reaction nudges the scroll, and it
 * also brings a freshly-opened off-screen clip into view; during a SCRUB (finger dragging the knob)
 * a per-frame velocity loop scrolls continuously while the knob dwells near an edge, so a long bar
 * can be crossed by holding at the edge instead of repeatedly dragging. Neither adds a gesture.
 */
export function PlayheadCursor({
  cursor,
  segments,
  scrollRef,
  scrollOffset,
  viewportW,
  contentW,
  suspendAutoScroll,
}: {
  cursor: Cursor;
  segments: Segment[];
  /** The bar's ScrollView ref — auto-scrolled (UI thread) to follow the playhead. */
  scrollRef: AnimatedRef<Animated.ScrollView>;
  /** The bar's live scroll offset — owned by the always-mounted SegmentBar so it is
   * already correct when the cursor mounts on an earlier-scrolled bar. */
  scrollOffset: SharedValue<number>;
  /** Measured viewport width and scroll-content width — the edge-band follow math. */
  viewportW: SharedValue<number>;
  contentW: SharedValue<number>;
  /** True during a reorder drag — pauses follow so it doesn't fight Sortable's auto-scroll. */
  suspendAutoScroll: SharedValue<boolean>;
}) {
  const offsets = useMemo(() => segmentOffsets(segments), [segments]);

  const cursorX = useSharedValue(msToPx(cursor.globalMs, segments, offsets));

  // Scrub state, all driven from the pan + frame loop below.
  const scrubbing = useSharedValue(false); // a finger drag is in progress (vs. playback follow)
  // The finger is on the knob — the frame loop scrolls and seeks only then. `scrubbing` outlives
  // it until JS has taken the final seek, so playback-follow can't glide back to a stale position.
  const fingerDown = useSharedValue(false);
  const fingerTransX = useSharedValue(0); // the pan's translationX, fed to the frame loop
  const baseKnobScreen = useSharedValue(0); // knob centre screen-x captured at drag start
  const sinceSeek = useSharedValue(0); // accumulated frame time for the throttled seek
  // Highest content-x the playhead can reach (right edge of the last thumb), kept current as the
  // clip count changes so the frame loop can clamp without reading the segments array on the UI thread.
  const maxContentX = useSharedValue(0);
  useEffect(() => {
    maxContentX.set(Math.max(0, (segments.length - 1) * STEP + THUMB_WIDTH));
  }, [segments.length, maxContentX]);

  // PLAYBACK follow: when the playhead's content-x nears either viewport edge, nudge the bar's scroll
  // to restore EDGE_MARGIN. cursorX is smoothly animated on playback-follow, so animated:false tracks
  // it cleanly; the reaction's first run scrolls a freshly-opened far clip into view. Yields while a
  // reorder OR a finger-scrub is active (those own the scroll then), and is idle while cursorX is
  // steady — so a manual scroll on a paused bar is preserved.
  useAnimatedReaction(
    () => cursorX.get(),
    (x) => {
      if (suspendAutoScroll.get() || scrubbing.get()) return;
      const viewportWidth = viewportW.get();
      if (viewportWidth <= 0) return;
      const maxScroll = Math.max(0, contentW.get() - viewportWidth);
      const knobX = x + SCRUB_INSET; // content-x of the knob/line (matches the translate inset)
      const currentOffset = scrollOffset.get();
      let target = currentOffset;
      if (knobX < currentOffset + EDGE_MARGIN) target = knobX - EDGE_MARGIN;
      else if (knobX > currentOffset + viewportWidth - EDGE_MARGIN)
        target = knobX - viewportWidth + EDGE_MARGIN;
      target = Math.min(Math.max(target, 0), maxScroll);
      if (Math.abs(target - currentOffset) > 0.5) scrollTo(scrollRef, target, 0, false);
    },
  );

  // Follow playback (smoothed to the ~4Hz timeUpdate cadence) unless the user is dragging.
  // `scrubbing` is set on the UI thread at touch-down; reading it here is synchronous, so a
  // playback render landing mid-drag can't start a follow animation under the finger.
  // Never reduced: it's a position indicator, and under Reduce Motion the default would turn
  // the glide into 4 Hz jumps.
  useEffect(() => {
    if (scrubbing.get()) return;
    cursorX.set(
      withTiming(msToPx(cursor.globalMs, segments, offsets), {
        duration: 250,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.Never,
      }),
    );
  }, [cursor.globalMs, segments, offsets, cursorX, scrubbing]);

  // seekToGlobalMs and the scrubbing callback change identity mid-scrub (seeking sets
  // selectedId), so neither the frame loop nor the pan may capture them — both call through
  // these per-render refs, and the stable wrappers below keep the frame callback registered once
  // and the pan built once. pxToMs / segments / offsets stay on JS.
  const scrubSeekRef = useRef<(contentX: number) => void>(() => {});
  scrubSeekRef.current = (contentX) => cursor.onScrub(pxToMs(contentX, segments, offsets));
  const onScrubbingChangeRef = useRef(cursor.onScrubbingChange);
  onScrubbingChangeRef.current = cursor.onScrubbingChange;
  const flushSeek = useCallback((contentX: number) => scrubSeekRef.current(contentX), []);

  // SCRUB follow: while a drag is active, this runs every frame. The knob's screen-x is finger-driven
  // but clamped fully inside the viewport (so it never chases off-screen); when it dwells within
  // EDGE_ZONE of an edge the bar scrolls continuously (velocity ∝ depth). The seek position is derived
  // from knob screen-x + the live scroll offset, so it keeps advancing while the finger holds still.
  // Memoized (deps are all stable shared values) so useFrameCallback registers it once, not every
  // 4Hz render; the explicit 'worklet' keeps the babel plugin workletizing the extracted function.
  const onScrubFrame = useCallback(
    (frame: FrameInfo) => {
      'worklet';
      if (!fingerDown.get()) return;
      const vw = viewportW.get();
      if (vw <= 0) return;
      const dt = (frame.timeSincePreviousFrame ?? 16) / 1000;
      const raw = baseKnobScreen.get() + fingerTransX.get();
      // Edge-zone auto-scroll trigger uses the wider KNOB_PAD band (clamping the finger to the
      // zone's outer edge also caps the scroll velocity at MAX).
      const knob = Math.min(Math.max(raw, KNOB_PAD), vw - KNOB_PAD);
      let v = 0;
      if (knob < KNOB_PAD + EDGE_ZONE) v = -MAX_SCROLL_SPEED * (1 - (knob - KNOB_PAD) / EDGE_ZONE);
      else if (knob > vw - KNOB_PAD - EDGE_ZONE)
        v = MAX_SCROLL_SPEED * (1 - (vw - KNOB_PAD - knob) / EDGE_ZONE);
      const maxScroll = Math.max(0, contentW.get() - vw);
      const offset = scrollOffset.get();
      const nextOffset = Math.min(Math.max(offset + v * dt, 0), maxScroll);
      if (nextOffset !== offset) scrollTo(scrollRef, nextOffset, 0, false);
      // Seek position uses a tighter KNOB/2 clamp — just enough to keep the knob fully on-screen
      // (SCRUB_INSET = KNOB/2). With the wider KNOB_PAD the playhead stopped (KNOB_PAD - SCRUB_INSET)
      // px short of each end, so it never reached globalMs 0 / totalMs and the preview started a
      // little into the first clip. KNOB/2 lets contentX reach 0 and maxContentX exactly.
      const knobSeek = Math.min(Math.max(raw, KNOB / 2), vw - KNOB / 2);
      // content-x (the playhead/seek position) = knob screen-x − inset + offset.
      const contentX = Math.min(
        Math.max(knobSeek - SCRUB_INSET + nextOffset, 0),
        maxContentX.get(),
      );
      cursorX.set(contentX); // drives the knob render (cursorX − scrollOffset)
      const since = sinceSeek.get() + dt;
      if (since >= SCRUB_INTERVAL_MS / 1000) {
        sinceSeek.set(0);
        scheduleOnRN(flushSeek, contentX);
      } else {
        sinceSeek.set(since);
      }
    },
    [
      flushSeek,
      fingerDown,
      viewportW,
      contentW,
      scrollOffset,
      scrollRef,
      baseKnobScreen,
      fingerTransX,
      sinceSeek,
      maxContentX,
      cursorX,
    ],
  );
  // Always running while the playhead is on screen (the preview): an idle frame returns on its
  // first line (`fingerDown`), and a scrub starts the moment the finger lands. Switching it on
  // from JS (setActive is JS-only) waited for a JS thread that may be busy seeking.
  useFrameCallback(onScrubFrame, true);

  // Scrub start / end on JS: the preview's badge suppression. The end runs after the final seek
  // (queued first), so the follow resumes from the settled position; a re-grab that landed in
  // between owns the scrub instead.
  const beginScrub = useCallback(() => {
    onScrubbingChangeRef.current?.(true);
  }, []);
  const endScrub = useCallback(() => {
    if (fingerDown.get()) return;
    scrubbing.set(false);
    onScrubbingChangeRef.current?.(false);
  }, [fingerDown, scrubbing]);

  // The pan runs on the UI thread and is built once (its deps are stable shared values and
  // callbacks), so a finger move never waits on a JS thread busy seeking, and GestureDetector
  // never gets a new config mid-drag. It only records finger state and toggles the frame loop
  // (which owns cursorX + the scroll during a scrub); the final settle seek is flushed here so
  // the end point is exact even if it lands between throttled frames.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        // Gesture-level hitSlop — the RN prop on the child View isn't honored consistently
        // by gesture-handler across platforms. Kept narrow so thumb taps beside the line land.
        .hitSlop({ left: 4, right: 4 })
        .onBegin(() => {
          cancelAnimation(cursorX);
          baseKnobScreen.set(cursorX.get() - scrollOffset.get() + SCRUB_INSET);
          fingerTransX.set(0);
          sinceSeek.set(0);
          fingerDown.set(true);
          scrubbing.set(true);
          scheduleOnRN(beginScrub);
        })
        .onUpdate((e) => {
          fingerTransX.set(e.translationX);
        })
        .onEnd(() => {
          scheduleOnRN(flushSeek, cursorX.get());
        })
        .onFinalize(() => {
          fingerDown.set(false);
          scheduleOnRN(endScrub);
        }),
    [
      beginScrub,
      endScrub,
      flushSeek,
      cursorX,
      scrollOffset,
      baseKnobScreen,
      fingerTransX,
      fingerDown,
      scrubbing,
      sinceSeek,
    ],
  );

  const style = useAnimatedStyle(() => ({
    // + SCRUB_INSET matches the track's left inset so the line stays on the thumb edges; − KNOB/2
    // centers the knob on the line.
    transform: [{ translateX: cursorX.get() - scrollOffset.get() - KNOB / 2 + SCRUB_INSET }],
  }));

  return (
    <Animated.View style={[styles.cursor, style]} pointerEvents="box-none">
      <GestureDetector gesture={pan}>
        <View style={styles.grabZone} accessibilityLabel="Playhead">
          <View style={styles.tag}>
            <View style={styles.gripTick} />
            <View style={styles.gripTick} />
          </View>
          <View style={styles.cursorLine} />
          <View style={styles.tag}>
            <View style={styles.gripTick} />
            <View style={styles.gripTick} />
          </View>
        </View>
      </GestureDetector>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  cursor: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: KNOB,
    alignItems: 'center',
  },
  // Full-height grab zone — line + both end tags drag as one piece, so the playhead is
  // grabbable anywhere along it (the zone sits over the thumbs; taps inside it scrub
  // rather than select, same trade-off as the iOS Photos grabber). The 2pt inset keeps
  // the tags a hair off the bar's rounded edges; the viewport's symmetric scrub lanes
  // put the top tag above the number pills and the bottom tag below the thumbs.
  grabZone: { flex: 1, alignItems: 'center', paddingVertical: 2 },
  // Spans between the two tags: top tag rides the badge-pill lane, bottom tag the scrub lane.
  cursorLine: {
    flex: 1,
    width: 2,
    backgroundColor: '#fff',
  },
  // Grip ticks inside each tag mark the draggable ends.
  tag: {
    width: 18,
    height: 12,
    borderRadius: 4,
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  gripTick: {
    width: 1.5,
    height: 6,
    borderRadius: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
});
