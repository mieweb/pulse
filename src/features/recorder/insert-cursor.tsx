import { type ReactNode, useCallback, useEffect, useMemo } from 'react';
import { type AccessibilityActionEvent, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  scrollTo,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type AnimatedRef,
  type FrameInfo,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import {
  boundaryX,
  CURSOR_A11Y_LABEL,
  edgeScrollSpeed,
  nearestBoundary,
  onClip,
  type StripGeometry,
  TAP_SLOP,
} from './insert-point';
import {
  BAR_LANE,
  CURSOR_INSET,
  CURSOR_TAG_HEIGHT,
  CURSOR_TAG_WIDTH,
  POP_LANE,
  THUMB_HEIGHT,
  THUMB_WIDTH,
  TRACK_GAP,
} from './track-metrics';

/** The strip in the viewport's frame (x along the scrolled content), for the cursor and the bar. */
export const STRIP: StripGeometry = {
  pad: CURSOR_INSET,
  tileWidth: THUMB_WIDTH,
  gap: TRACK_GAP,
  tileTop: BAR_LANE + POP_LANE,
  tileHeight: THUMB_HEIGHT,
};

/** The cursor's grab zone: the line's width plus the room either side its tags take. */
const FRAME = 14;
/** The dragged cursor stays this far in from the viewport's edges, and edge scrolling starts there. */
const EDGE_PAD = FRAME;

/**
 * The insert cursor (#308) over the clip strip: the recorder's old playhead cursor (a white line
 * between two grip tags, riding the lanes above and below the thumbs), now marking a clip
 * boundary instead of a time. Dragging it snaps from boundary to boundary with a tick each
 * (`onMove`); held near an edge of the strip, the strip scrolls under it. It plays nothing. At the
 * end of the draft (adding appends) only a dim line shows, still draggable.
 *
 * Rendered OUTSIDE the ScrollView, positioned by content x − scroll offset, so its pan never
 * competes with the strip's scroll or the clips' hold-to-reorder. Its grab zone sits in the gap
 * between two clips, overlapping each by a few points: a touch there drags the cursor rather than
 * the clip (the trade-off the playhead made). The pan runs on the UI thread and is built once.
 */
export function InsertCursor({
  at,
  count,
  atEnd,
  enabled,
  onMove,
  onDraggingChange,
  a11yValue,
  scrollRef,
  scrollOffset,
  viewportW,
  contentW,
}: {
  /** The boundary it's at (0 … count). */
  at: number;
  count: number;
  atEnd: boolean;
  enabled: boolean;
  /** A drag or an accessibility adjust moved it to boundary `k`; `tick` for the drag's haptic. */
  onMove: (k: number, tick: boolean) => void;
  onDraggingChange: (dragging: boolean) => void;
  a11yValue: string;
  scrollRef: AnimatedRef<Animated.ScrollView>;
  scrollOffset: SharedValue<number>;
  viewportW: SharedValue<number>;
  contentW: SharedValue<number>;
}) {
  const cursorAt = useSharedValue(at);
  const countSv = useSharedValue(count);
  const enabledSv = useSharedValue(enabled);
  const fingerDown = useSharedValue(false);
  const fingerTransX = useSharedValue(0);
  // The cursor's screen x when the drag began.
  const baseScreen = useSharedValue(0);

  // From the draft, except mid-drag: the boundaries the drag passed reach JS after it moved on, and
  // must not pull it back.
  useEffect(() => {
    if (!fingerDown.get()) cursorAt.set(at);
  }, [at, cursorAt, fingerDown]);
  useEffect(() => {
    countSv.set(count);
    enabledSv.set(enabled);
  }, [count, enabled, countSv, enabledSv]);

  // While a finger drags it, every frame: the strip scrolls if the cursor is held near an edge, and
  // the cursor takes the boundary nearest the finger (screen x + the live scroll), so it keeps
  // moving while the finger holds still at the edge.
  const onFrame = useCallback(
    (frame: FrameInfo) => {
      'worklet';
      if (!fingerDown.get()) return;
      const vw = viewportW.get();
      if (vw <= 0) return;
      const dt = (frame.timeSincePreviousFrame ?? 16) / 1000;
      const raw = baseScreen.get() + fingerTransX.get();
      const maxScroll = Math.max(0, contentW.get() - vw);
      const offset = scrollOffset.get();
      const next = Math.min(
        Math.max(offset + edgeScrollSpeed(raw, vw, EDGE_PAD) * dt, 0),
        maxScroll,
      );
      if (next !== offset) scrollTo(scrollRef, next, 0, false);
      const screen = Math.min(Math.max(raw, CURSOR_TAG_WIDTH / 2), vw - CURSOR_TAG_WIDTH / 2);
      const k = nearestBoundary(screen + next, countSv.get(), STRIP);
      if (k === cursorAt.get()) return;
      cursorAt.set(k);
      scheduleOnRN(onMove, k, true);
    },
    [
      fingerDown,
      viewportW,
      contentW,
      scrollOffset,
      scrollRef,
      baseScreen,
      fingerTransX,
      countSv,
      cursorAt,
      onMove,
    ],
  );
  // Off until a finger is down (the recorder runs the camera; no frame work while idle).
  const frames = useFrameCallback(onFrame, false);
  const setFramesActive = frames.setActive;
  const begin = useCallback(() => {
    setFramesActive(true);
    onDraggingChange(true);
  }, [setFramesActive, onDraggingChange]);
  const end = useCallback(() => {
    if (fingerDown.get()) return; // grabbed again meanwhile
    setFramesActive(false);
    onDraggingChange(false);
  }, [fingerDown, setFramesActive, onDraggingChange]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // Narrow, so a tap on a clip beside the line lands on the clip.
        .hitSlop({ left: 4, right: 4 })
        .onTouchesDown((_e, manager) => {
          if (!enabledSv.get()) manager.fail();
        })
        .onBegin(() => {
          baseScreen.set(boundaryX(cursorAt.get(), STRIP) - scrollOffset.get());
          fingerTransX.set(0);
          fingerDown.set(true);
          scheduleOnRN(begin);
        })
        .onUpdate((e) => {
          fingerTransX.set(e.translationX);
        })
        .onFinalize(() => {
          fingerDown.set(false);
          scheduleOnRN(end);
        }),
    [enabledSv, baseScreen, cursorAt, scrollOffset, fingerTransX, fingerDown, begin, end],
  );

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: boundaryX(cursorAt.get(), STRIP) - scrollOffset.get() - FRAME / 2 }],
  }));

  const onAccessibilityAction = (e: AccessibilityActionEvent) => {
    if (!enabled) return;
    const step = e.nativeEvent.actionName === 'increment' ? 1 : -1;
    const k = Math.min(count, Math.max(0, at + step));
    if (k !== at) onMove(k, false);
  };

  return (
    <Animated.View style={[styles.cursor, style]} pointerEvents="box-none">
      <GestureDetector gesture={pan}>
        <View
          style={styles.grabZone}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={CURSOR_A11Y_LABEL}
          accessibilityValue={{ text: a11yValue }}
          accessibilityState={{ disabled: !enabled }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={onAccessibilityAction}
          testID="recorder.insertCursor">
          {!atEnd && <Tag />}
          <View style={[styles.line, atEnd && styles.lineAtEnd]} />
          {!atEnd && <Tag />}
        </View>
      </GestureDetector>
    </Animated.View>
  );
}

/**
 * Around the strip's viewport: a tap off the clips — in a gap, or the lanes above and below them —
 * moves the cursor to the nearest boundary (`onMove`, with a tick). It lets go of any touch that
 * starts on a clip at once, so the clip's tap, hold to reorder and drag to the trash are the
 * grid's, untouched, and fails once the finger slides (a scroll).
 */
export function CursorTapArea({
  at,
  count,
  enabled,
  onMove,
  scrollOffset,
  children,
}: {
  at: number;
  count: number;
  enabled: boolean;
  onMove: (k: number, tick: boolean) => void;
  scrollOffset: SharedValue<number>;
  children: ReactNode;
}) {
  const atSv = useSharedValue(at);
  const countSv = useSharedValue(count);
  const enabledSv = useSharedValue(enabled);
  useEffect(() => {
    atSv.set(at);
    countSv.set(count);
    enabledSv.set(enabled);
  }, [at, count, enabled, atSv, countSv, enabledSv]);
  const tap = useMemo(
    () =>
      Gesture.Tap()
        .maxDistance(TAP_SLOP)
        .onTouchesDown((e, manager) => {
          const t = e.allTouches[0];
          if (!enabledSv.get() || !t || onClip(t.x + scrollOffset.get(), t.y, countSv.get(), STRIP))
            manager.fail();
        })
        .onEnd((e, success) => {
          if (!success) return;
          const k = nearestBoundary(e.x + scrollOffset.get(), countSv.get(), STRIP);
          if (k === atSv.get()) return;
          atSv.set(k);
          scheduleOnRN(onMove, k, true);
        }),
    [enabledSv, scrollOffset, countSv, atSv, onMove],
  );
  return <GestureDetector gesture={tap}>{children}</GestureDetector>;
}

/** A grip tag at each end of the line: the parts that say it can be dragged. */
function Tag() {
  return (
    <View style={styles.tag}>
      <View style={styles.gripTick} />
      <View style={styles.gripTick} />
    </View>
  );
}

const styles = StyleSheet.create({
  cursor: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: FRAME,
    alignItems: 'center',
  },
  // Full height: line and tags drag as one piece. The 2 pt inset keeps the tags a hair off the
  // bar's rounded edges; the top tag rides the lane above the clip labels, the bottom one the lane
  // below the thumbs.
  grabZone: { flex: 1, alignItems: 'center', paddingVertical: 2 },
  line: { flex: 1, width: 2, backgroundColor: '#fff' },
  // At the end (the default, appending): there, but quiet.
  lineAtEnd: { backgroundColor: 'rgba(255,255,255,0.45)' },
  tag: {
    width: CURSOR_TAG_WIDTH,
    height: CURSOR_TAG_HEIGHT,
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
