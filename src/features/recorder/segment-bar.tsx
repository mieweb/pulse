import { Image } from 'expo-image';
import { Icon } from '@/components/icon';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  interpolateColor,
  ReduceMotion,
  useAnimatedRef,
  useAnimatedStyle,
  useReducedMotion,
  useScrollViewOffset,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Sortable, {
  type DragMoveParams,
  type DragStartParams,
  type SortableGridDragEndParams,
} from 'react-native-sortables';
import { scheduleOnRN } from 'react-native-worklets';

import { GlassPill } from '@/components/glass-pill';
import { EaseOut } from '@/constants/motion';
import { Accent, ControlScrim, Opacity, Spacing } from '@/constants/theme';
import type { Segment } from '@/db/schema';
import { useThemeMode } from '@/hooks/use-theme';
import { useThumbnail } from '@/hooks/use-thumbnail';
import { formatDuration } from '@/utils/format';
import { haptics } from '@/utils/haptics';
import { effMs } from '@/utils/segment-window';
import { PlayheadCursor, type Cursor } from './playhead-cursor';
import {
  BADGE_SIZE,
  POP_LANE,
  RECORD_BAR_GAP,
  RECORD_BUTTON_SIZE,
  SCRUB_INSET,
  SCRUB_LANE,
  THUMB_HEIGHT,
  THUMB_WIDTH,
  TRACK_GAP,
} from './track-metrics';

// Sits centered on the record button's spot (which is hidden during a drag), a little
// smaller than it. Size is independent of RECORD_BUTTON_SIZE; the wrapper offset below keeps
// it centered on the record button regardless.
const TRASH_SIZE = 56;
// Nudge the trash below the record button's exact center so it clears the preview modal.
const TRASH_DROP_OFFSET = 18;
// Never skipped for Reduce Motion: what they drive is opacity and colour (the scale that rides
// along is dropped under Reduce Motion, see trashStyle).
const TRASH_FADE = { duration: 150, easing: EaseOut, reduceMotion: ReduceMotion.Never };
const TRASH_HOVER = { duration: 120, easing: EaseOut, reduceMotion: ReduceMotion.Never };
// How much the trash grows while a clip hovers it.
const TRASH_HOVER_SCALE = 0.12;
// Once a clip is over the trash, it stays over until it leaves the grown circle (6% a side of 56 pt
// is the hover scale's 62.7 pt): testing the resting rect both ways made the edge flicker in and
// out, a haptic each time.
const TRASH_EXIT_MARGIN = TRASH_HOVER_SCALE / 2;
// Captured by the drag-move worklet, which can only call a JS function through scheduleOnRN.
const hoverHaptic = haptics.tap;
// The thumbs' labels (length, clip number) stay at their size whatever the text size: the 48 pt
// thumb doesn't grow, so a larger label only covers the frame (at the largest size "00:01" ran
// edge to edge), the way Photos keeps its thumbnails' durations fixed.
const THUMB_TEXT_SCALE = 1;

type TrashRect = { x: number; y: number; w: number; h: number };

type Props = {
  segments: Segment[];
  onReorder: (ids: string[]) => void;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
  /** Fired true when a drag begins, false when it ends — lets the recorder hide its record
   *  button so the floating trash above the bar has clear space. */
  onDragActiveChange?: (active: boolean) => void;
  onNext?: () => void;
  cursor?: Cursor;
  /** Laid over the first clip, where nothing reads its touches: the clips tip's anchor. */
  firstClipOverlay?: ReactNode;
};

export function SegmentBar(props: Props) {
  // Gate BEFORE the hooks mount: useScrollViewOffset warns on every empty-draft render
  // while its ref has no ScrollView attached, so the hooks live in Bar below.
  if (props.segments.length === 0) return null;
  return <Bar {...props} />;
}

function Bar({
  segments,
  onReorder,
  onDelete,
  onSelect,
  onDragActiveChange,
  onNext,
  cursor,
  firstClipOverlay,
}: Props) {
  const mode = useThemeMode();
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  // Owned here (not in PlayheadCursor) so the offset is already tracked when the cursor
  // mounts on a bar the user scrolled before opening the preview.
  const scrollOffset = useScrollViewOffset(scrollRef);

  // Live viewport + scroll-content widths, fed to the playhead's edge-band follow math.
  const viewportW = useSharedValue(0);
  const contentW = useSharedValue(0);
  // True during a reorder drag — tells the playhead to pause its follow so the two scrollers
  // (this and Sortable's autoScroll) don't fight when reordering while previewing.
  const dragScroll = useSharedValue(false);

  // React-side mirror of the drag state, used to hide the → (Next) button while reordering so
  // the flex:1 viewport reclaims its slot (button + gap) for more room. Item slot positions are
  // index-based (i * STEP), independent of viewport width, so widening mid-drag is reorder-safe.
  const [dragActive, setDragActive] = useState(false);

  // Length-change reactions, mutually exclusive by direction (reorder never changes length):
  // — DECREASE (delete): preserve the user's place. Capture the current offset (the effect
  //   runs before the shrunken content re-lays out and snaps the scroll) and restore it in
  //   onContentSizeChange, clamped to the new content width.
  // — INCREASE (new recording or library import): scroll the new clip into view (#167).
  //   Record mode only — while previewing, the playhead-follow owns the scroll. Deferred to
  //   onContentSizeChange so the added thumb has laid out before the scrollToEnd.
  const prevCount = useRef(segments.length);
  const restoreOffset = useRef<number | null>(null);
  const stickToEnd = useRef(false);
  useEffect(() => {
    // Preview opened before a pending scroll-to-newest ran — drop it; playhead-follow owns
    // the scroll now, and a stale flag would otherwise fire on a LATER content-size change.
    if (cursor) stickToEnd.current = false;
    if (segments.length < prevCount.current) restoreOffset.current = scrollOffset.get();
    else if (segments.length > prevCount.current && !cursor) stickToEnd.current = true;
    prevCount.current = segments.length;
  }, [segments.length, scrollOffset, cursor]);

  // Drag-to-trash. The trash floats above the bar, shown only while dragging; dropping a clip
  // on it deletes that clip — otherwise the drag just reorders. Hit-testing runs on the UI
  // thread from the drag's touch position (onDragMove, a worklet) against the trash's measured
  // window rect, and only a crossing in or out does anything: animate the highlight, tap.
  // Hidden while previewing (see the trash below), so drags there only reorder.
  const trashShown = !cursor;
  const trashRef = useRef<View>(null);
  const trashRect = useSharedValue<TrashRect | null>(null);
  const draggedKey = useRef<string | null>(null);
  const overTrash = useSharedValue(false);
  const vis = useSharedValue(0); // 0→1 trash fade-in during a drag
  const over = useSharedValue(0); // highlight when a dragged clip hovers the trash

  // Measures the static target around the trash, not the trash itself: the trash is scaled
  // (0.85 while it fades in), and measureInWindow reports the scaled rect — a target ~15% small.
  const measureTrash = useCallback(
    () =>
      trashRef.current?.measureInWindow((x, y, w, h) => {
        trashRect.set({ x, y, w, h });
      }),
    [trashRect],
  );

  // Reduce Motion keeps the fade and the colour change and drops the scale.
  const reduceMotion = useReducedMotion();
  const trashStyle = useAnimatedStyle(() => ({
    opacity: vis.get(),
    transform: reduceMotion
      ? []
      : [{ scale: 0.85 + 0.15 * vis.get() + TRASH_HOVER_SCALE * over.get() }],
    backgroundColor: interpolateColor(over.get(), [0, 1], ['rgba(0,0,0,0.6)', Accent]),
    borderColor: interpolateColor(over.get(), [0, 1], ['rgba(255,255,255,0.4)', '#fff']),
  }));

  // The drag callbacks are stable, so the grid doesn't re-wrap them on every render; the
  // parent's callbacks are read through this ref, kept current after each render.
  const latest = useRef({ onDelete, onReorder, onDragActiveChange });
  useEffect(() => {
    latest.current = { onDelete, onReorder, onDragActiveChange };
  });

  const onDragStart = useCallback(
    ({ key }: DragStartParams) => {
      haptics.pickUp();
      draggedKey.current = key;
      overTrash.set(false);
      over.set(0);
      if (trashShown) {
        vis.set(withTiming(1, TRASH_FADE));
        measureTrash();
      }
      dragScroll.set(true); // pause playhead-follow so it can't fight the grid autoscroll
      setDragActive(true); // hide → so the viewport gets its space
      latest.current.onDragActiveChange?.(true);
    },
    [trashShown, measureTrash, overTrash, over, vis, dragScroll],
  );

  const onDragMove = useCallback(
    ({ touchData }: DragMoveParams) => {
      'worklet';
      if (!trashShown) return;
      const r = trashRect.get();
      const was = overTrash.get();
      // Leaving is tested against the grown rect (see TRASH_EXIT_MARGIN), entering the resting one.
      const mx = was && r ? r.w * TRASH_EXIT_MARGIN : 0;
      const my = was && r ? r.h * TRASH_EXIT_MARGIN : 0;
      const inside =
        !!r &&
        touchData.absoluteX >= r.x - mx &&
        touchData.absoluteX <= r.x + r.w + mx &&
        touchData.absoluteY >= r.y - my &&
        touchData.absoluteY <= r.y + r.h + my;
      if (inside === was) return;
      overTrash.set(inside);
      over.set(withTiming(inside ? 1 : 0, TRASH_HOVER));
      if (inside) scheduleOnRN(hoverHaptic);
    },
    [trashShown, trashRect, overTrash, over],
  );

  const onDragEnd = useCallback(
    ({ data }: SortableGridDragEndParams<Segment>) => {
      vis.set(withTiming(0, TRASH_FADE));
      // Dropped on the trash → delete that clip; otherwise persist the new order.
      const key = draggedKey.current;
      const deleting = overTrash.get() && !!key;
      // A delete leaves the trash red as it fades: easing it back to grey at the moment the
      // delete lands read as "cancelled". (The next drag starts it grey again.)
      if (!deleting) over.set(withTiming(0, TRASH_HOVER));
      if (deleting && key) {
        haptics.drop();
        latest.current.onDelete(key);
      } else {
        latest.current.onReorder(data.map((s) => s.id));
      }
      overTrash.set(false);
      draggedKey.current = null;
      dragScroll.set(false);
      setDragActive(false); // restore → now the drag is done
      latest.current.onDragActiveChange?.(false);
    },
    [vis, over, overTrash, dragScroll],
  );

  return (
    // Teleports the dragged thumbnail to a portal outlet rendered OUTSIDE the horizontal
    // ScrollView, which otherwise clips anything dragged out of its vertical bounds (the clip
    // went invisible the moment it left the bar on the way to the trash). The outlet is layout-
    // neutral and the active item positions itself in window coords, so the clip stays visible
    // as it's dragged up to the trash. Enabled by default.
    <Sortable.PortalProvider>
      <View style={styles.bar}>
        {/* Glass surface as a passive background LAYER, not a container — the Sortable grid,
            ScrollView, and playhead keep their exact hierarchy (and gesture/portal behavior)
            above it. pointerEvents="none" so it can never intercept a touch. Glass only over
            the live camera; on the preview's themed backdrop it swaps to the same mode-aware
            scrim as the ✕/✂/🗑 controls, so the whole chrome reads as one family. */}
        {cursor ? (
          <View
            style={[styles.barSurface, styles.barSurfaceScrim, ControlScrim[mode]]}
            pointerEvents="none"
          />
        ) : (
          <GlassPill style={styles.barSurface} pointerEvents="none" />
        )}
        {/* Trash drop target — above the bar, fades in during a drag. pointerEvents="none" so it
            never intercepts touches; it's purely a drop zone hit-tested from the drag position.
            Hidden while previewing: it would float over the full-bleed video stage, and the
            preview's own 🗑 covers deletion — drags are reorder-only there. */}
        {trashShown && (
          <View style={styles.trashWrap} pointerEvents="none">
            {/* The measured drop target: never transformed, so its rect is the trash at rest.
                Not collapsable, or Android could flatten it away and leave nothing to measure. */}
            <View
              ref={trashRef}
              collapsable={false}
              onLayout={measureTrash}
              style={styles.trashTarget}>
              <Animated.View style={[styles.trash, trashStyle]}>
                <Icon name="trash.fill" size={22} tintColor="#fff" />
              </Animated.View>
            </View>
          </View>
        )}

        <View
          style={styles.viewport}
          onLayout={(e) => {
            viewportW.set(e.nativeEvent.layout.width);
          }}>
          <Animated.ScrollView
            ref={scrollRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.content}
            onContentSizeChange={(w) => {
              contentW.set(w);
              // Restore the pre-delete offset now the remaining thumbs have laid out.
              if (restoreOffset.current != null) {
                const target = Math.min(restoreOffset.current, Math.max(0, w - viewportW.get()));
                restoreOffset.current = null;
                scrollRef.current?.scrollTo({ x: target, animated: false });
              }
              // Honor a pending scroll-to-newest now that the added thumb has been measured.
              // Re-checked against cursor: the native event can land before the effect above
              // has cleared a stale flag on a just-opened preview.
              if (stickToEnd.current && !cursor) {
                stickToEnd.current = false;
                scrollRef.current?.scrollToEnd({ animated: true });
              }
            }}>
            <Sortable.Grid
              rows={1}
              rowHeight={THUMB_HEIGHT}
              columnGap={TRACK_GAP}
              data={segments}
              keyExtractor={(s) => s.id}
              scrollableRef={scrollRef}
              autoScrollDirection="horizontal"
              // 'swap' keeps the row still during a drag — only the hovered thumb trades
              // places with the dragged one. The default 'insert' reflowed every neighbor
              // to open a gap, which made long bars feel like they scattered on pickup.
              // Note the semantics: dropping 1 on 5 exchanges them (2–4 stay put).
              strategy="swap"
              onDragStart={onDragStart}
              onDragMove={onDragMove}
              onDragEnd={onDragEnd}
              renderItem={({ item }) => (
                <SegmentThumb
                  segment={item}
                  active={cursor?.activeId === item.id}
                  onSelect={() => onSelect(item.id)}
                />
              )}
            />
          </Animated.ScrollView>

          {firstClipOverlay && (
            <View style={styles.firstClip} pointerEvents="none">
              {firstClipOverlay}
            </View>
          )}

          {cursor && (
            <PlayheadCursor
              cursor={cursor}
              segments={segments}
              scrollRef={scrollRef}
              scrollOffset={scrollOffset}
              viewportW={viewportW}
              contentW={contentW}
              suspendAutoScroll={dragScroll}
            />
          )}
        </View>

        {/* Hidden while reordering — its slot (button + gap) is handed to the flex:1 viewport for
          more room; restored on drag end. */}
        {onNext && !dragActive && (
          <Pressable
            onPress={onNext}
            accessibilityRole="button"
            accessibilityLabel="Next"
            style={({ pressed }) => [styles.next, pressed && styles.nextPressed]}>
            <Icon name="arrow.right" size={22} weight="semibold" tintColor="#fff" />
          </Pressable>
        )}
      </View>
    </Sortable.PortalProvider>
  );
}

function SegmentThumb({
  segment,
  active,
  onSelect,
}: {
  segment: Segment;
  active: boolean;
  onSelect: () => void;
}) {
  // Persisted jpeg cover; falls back to the EFFECTIVE clip (edited ?? original) for legacy rows.
  const thumbnail = useThumbnail(
    segment.thumbnail,
    segment.editedFilename ?? segment.originalFilename,
  );

  // Effective (post-trim) clip length, the same number the playhead and export use. A failed
  // native read stores 0ms (the clip is skipped on playback) — show nothing rather than 00:00.
  const durationMs = effMs(segment);

  return (
    // The clip under the playhead is marked by its border turning accent — no scale-up, so
    // the row stays visually still while the playhead moves across it.
    <View style={[styles.thumb, active && styles.thumbActive]}>
      {/* tap = preview · hold anywhere on the thumb = drag to reorder (drop on the trash to
          delete) — the grid's default long-press activation, so the ENTIRE thumb is tappable
          (the old pill-handle strip swallowed taps on the thumb's top third). Editing lives in
          the preview's ✂. Sortable.Touchable cooperates with the grid so a tap can't fire
          after a drag. */}
      <Sortable.Touchable
        onTap={onSelect}
        accessibilityLabel="Preview clip (hold to reorder)"
        style={styles.thumbTouch}>
        {thumbnail ? (
          <Image source={thumbnail} style={styles.thumbImage} contentFit="cover" />
        ) : (
          <Icon name="video.fill" size={18} tintColor="rgba(255,255,255,0.8)" />
        )}
      </Sortable.Touchable>

      {/* Clip length, bottom-center. pointerEvents none so it never steals taps from the thumb. */}
      {durationMs > 0 && (
        <View style={styles.durationWrap} pointerEvents="none">
          <View style={styles.duration}>
            {/* Shrinks to fit rather than overflow the 48 pt thumb: an hour-long clip's
                "1:02:03". */}
            <Text
              style={styles.durationText}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
              maxFontSizeMultiplier={THUMB_TEXT_SCALE}>
              {/* Under a second still reads as one: "00:00" looks like an empty or broken clip
                  (the draft card does the same). */}
              {formatDuration(Math.max(durationMs, 1000), { pad: true })}
            </Text>
          </View>
        </View>
      )}

      {/* Clip label — a pill straddling the thumb's top edge (half out, half in), centered.
          Pure decoration now (the whole thumb drags): pointerEvents none so it can never
          swallow a tap. The label is initialized to the clip's creation number when it's
          recorded and never renumbered on reorder (deletes leave gaps), so "move 7 between
          3 and 12" stays meaningful however the draft is shuffled. */}
      <View style={styles.badgeWrap} pointerEvents="none">
        <View style={styles.badge}>
          <Text style={styles.badgeText} numberOfLines={1} maxFontSizeMultiplier={THUMB_TEXT_SCALE}>
            {segment.label || '≡'}
          </Text>
        </View>
      </View>
    </View>
  );
}

/** Matches the draft card's thumbnail (draft-card.tsx). */
const THUMB_RADIUS = 10;

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    gap: Spacing.two,
    marginHorizontal: Spacing.three,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.three,
    borderCurve: 'continuous',
  },
  // The bar's glass background (dark-scrim fallback via GlassPill) — fills the bar behind
  // its content and carries the rounding.
  barSurface: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: Spacing.three,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  barSurfaceScrim: { borderWidth: StyleSheet.hairlineWidth },
  trashWrap: {
    position: 'absolute',
    // Vertically: align the trash's CENTER with the record button's center. The record
    // button sits RECORD_BAR_GAP above the bar and is RECORD_BUTTON_SIZE tall, so its center
    // is (RECORD_BAR_GAP + RECORD_BUTTON_SIZE/2) up; offset this wrapper by a further
    // TRASH_SIZE/2 so the (smaller) circle's center lands there too. Horizontally: span the
    // bar (left/right 0) and center the circle with alignItems — robust against the bar's
    // padding (a plain left:'50%' lands ~one padding off because % is measured from the edge).
    top: -(RECORD_BAR_GAP + RECORD_BUTTON_SIZE / 2 + TRASH_SIZE / 2) + TRASH_DROP_OFFSET,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  trashTarget: { width: TRASH_SIZE, height: TRASH_SIZE },
  trash: {
    width: TRASH_SIZE,
    height: TRASH_SIZE,
    borderRadius: TRASH_SIZE / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The scrub lanes (the strips above/below the thumbs the playhead's grab tags ride in) are
  // reserved permanently, not just while previewing — adding them only with the cursor grew
  // the bar and visibly bumped it upward every time a preview opened. Both lanes live INSIDE
  // the viewport (not as bar padding) so the playhead — an absolute child of the viewport,
  // clipped by its overflow — can span them: top tag above the number pills, bottom tag
  // below the thumbs, symmetric in the bar.
  viewport: { flex: 1, overflow: 'hidden', paddingTop: SCRUB_LANE, paddingBottom: SCRUB_LANE },
  // The first thumb at rest: the scroll content's leading inset, below its pop lane.
  firstClip: {
    position: 'absolute',
    left: SCRUB_INSET,
    top: SCRUB_LANE + POP_LANE,
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
  },
  content: {
    alignItems: 'center',
    paddingLeft: SCRUB_INSET,
    paddingRight: Spacing.two,
    // Symmetric top/bottom room inside the scroll frame so the badge pill's protruding half
    // isn't clipped by the ScrollView. Symmetric → thumbs stay vertically centered, keeping
    // the export-button alignment.
    paddingVertical: POP_LANE,
  },
  thumb: {
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    backgroundColor: 'rgba(255,255,255,0.12)',
    // The same corners as the home screen's draft thumbnails (a thumbnail, not the video).
    borderRadius: THUMB_RADIUS,
    borderCurve: 'continuous',
    // Border space is reserved (transparent) at all times so going active only changes the
    // color — adding the border on activation would otherwise shift the inner box (and the
    // absolutely-positioned grab handle) inward by 2px.
    borderWidth: 2,
    borderColor: 'transparent',
  },
  thumbTouch: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbActive: {
    borderColor: Accent,
  },
  thumbImage: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Inside the 2 pt selection ring, so its corners follow the ring's inner edge.
    borderRadius: THUMB_RADIUS - 2,
    borderCurve: 'continuous',
  },
  // Full-width wrapper so the badge centers horizontally regardless of its text width.
  durationWrap: {
    position: 'absolute',
    bottom: 3,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  duration: {
    maxWidth: '100%',
    paddingHorizontal: 3,
    paddingVertical: 1,
    borderRadius: 3,
    borderCurve: 'continuous',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  durationText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  // Positions the label pill half above the thumb's top edge; decoration only (see JSX).
  badgeWrap: {
    position: 'absolute',
    top: -BADGE_SIZE / 2,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  badge: {
    height: BADGE_SIZE,
    minWidth: BADGE_SIZE,
    paddingHorizontal: 5,
    borderRadius: BADGE_SIZE / 2,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    // Soft shadow keeps the pill legible over bright thumbnails (as the old grabber had).
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  next: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Accent,
    alignItems: 'center',
    justifyContent: 'center',
    // The viewport's scrub lanes are symmetric (top + bottom), so the thumbs sit on the
    // bar's centerline and the button centers naturally — no offset needed.
  },
  nextPressed: { opacity: Opacity.pressed },
});
