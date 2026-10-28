import { Image } from 'expo-image';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useScrollOffset,
  useSharedValue,
} from 'react-native-reanimated';
import Sortable, { type SortableGridDragEndParams } from 'react-native-sortables';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';

import { Icon } from '@/components/icon';
import { Accent } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatDuration } from '@/utils/format';
import { haptics } from '@/utils/haptics';

import { TILE_HEIGHT } from './clip-tile';
import { EditCues } from './edit-cues';
import { clamp, type TimelineLayout } from './timeline-geometry';
import type { EditorClip } from './use-editor-draft';
import { Mode, type PlayheadValues } from './use-preview-transport';

const THUMB_WIDTH = 60;
const THUMB_HEIGHT = TILE_HEIGHT;
const THUMB_GAP = 8;
/** One clip's share of the row: its thumbnail and the gap after it. */
const STEP = THUMB_WIDTH + THUMB_GAP;
export const ROW_HEIGHT = THUMB_HEIGHT + 20;
const BADGE = 18;
const RADIUS = 10;
/** A selected clip counts as on screen while at least this much of it shows. */
const VISIBLE_DP = 12;

// The row is padded half its width on each side, so the scroll offset IS the playhead's place
// on the row: each clip spans its thumbnail and the gap after it, in proportion to its length.

/** Scroll offset for timeline time `t`. */
function offsetOfTime(starts: readonly number[], total: number, t: number): number {
  'worklet';
  const n = starts.length;
  if (n === 0) return 0;
  let i = 0;
  while (i + 1 < n && starts[i + 1] <= t) i++;
  const end = i + 1 < n ? starts[i + 1] : total;
  const frac = end > starts[i] ? clamp((t - starts[i]) / (end - starts[i]), 0, 1) : 0;
  return (i + frac) * STEP;
}

/** Timeline time for scroll offset `x` (the inverse). */
function timeOfOffset(starts: readonly number[], total: number, x: number): number {
  'worklet';
  const n = starts.length;
  if (n === 0) return 0;
  const slot = clamp(Math.floor(x / STEP), 0, n - 1);
  const end = slot + 1 < n ? starts[slot + 1] : total;
  const frac = clamp(x / STEP - slot, 0, 1);
  return starts[slot] + frac * (end - starts[slot]);
}

type ThumbProps = {
  clip: EditorClip;
  index: number;
  cover: string | null;
  selected: boolean;
  onTap: () => void;
};

/** One clip as a thumbnail, in the recorder's look: number pill on top, length at the bottom. */
const Thumb = memo(function Thumb({ clip, index, cover, selected, onTap }: ThumbProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.thumb,
        { backgroundColor: theme.backgroundElement },
        selected && styles.selected,
      ]}>
      <Sortable.Touchable
        onTap={onTap}
        style={styles.inner}
        accessibilityLabel="Clip (hold to move)">
        {cover ? (
          <Image source={cover} style={StyleSheet.absoluteFill} contentFit="cover" transition={0} />
        ) : (
          <Icon name="video.fill" size={18} tintColor={theme.textSecondary} />
        )}
        <View style={styles.glyphs} pointerEvents="none">
          <EditCues edit={clip.edit} layout="stack" showMute part="glyphs" />
        </View>
        <View style={styles.speedWrap} pointerEvents="none">
          <EditCues edit={clip.edit} layout="stack" showMute={false} part="speed" />
        </View>
        <View style={styles.durationWrap} pointerEvents="none">
          <Text style={styles.duration} numberOfLines={1} maxFontSizeMultiplier={1}>
            {formatDuration(Math.max(clip.lengthMs, 1000), { pad: true })}
          </Text>
        </View>
      </Sortable.Touchable>
      <View style={styles.badgeWrap} pointerEvents="none">
        <View style={styles.badge}>
          <Text style={styles.badgeText} numberOfLines={1} maxFontSizeMultiplier={1}>
            {clip.label || index + 1}
          </Text>
        </View>
      </View>
    </View>
  );
});

type Props = {
  clips: EditorClip[];
  covers: ReadonlyMap<string, string | null>;
  layout: TimelineLayout;
  selected: number;
  values: PlayheadValues;
  /** A tap on clip `id`. */
  onSelect: (id: string) => void;
  /** A swipe started (pause, approximate seeks) and ended at `ms` (with its fling). */
  onDragStart: () => void;
  onScrubEnd: (ms: number) => void;
  onReorderStart: () => void;
  /** A clip was dropped: the new order (ids) and the clip that moved. */
  onReorder: (order: string[], moved: string) => void;
  /** The selected clip scrolled out of view (it's let go). */
  onSelectedHidden: () => void;
  /** A tap on the row but not on a clip (the gaps, either side). */
  onBlankTap?: () => void;
};

/**
 * The Clips view: thumbnails under the same fixed centre playhead as the timeline. Playback
 * scrolls the row; a swipe or a fling scrubs. Tap a thumbnail to select it; hold one to move it
 * (react-native-sortables; it scrolls the row near the edges).
 */
export function ClipRow(props: Props) {
  const theme = useTheme();
  const { clips, covers, layout, selected, values } = props;
  const { timeMs, totalMs, mode, playing } = values;
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const offset = useScrollOffset(scrollRef);
  const [width, setWidth] = useState(0);
  const widthSv = useSharedValue(0);

  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const [handlers] = useState(() => ({
    dragStart: () => latest.current.onDragStart(),
    scrubEnd: (ms: number) => latest.current.onScrubEnd(ms),
    hidden: () => latest.current.onSelectedHidden(),
  }));
  const { dragStart, scrubEnd, hidden } = handlers;

  const geom = useSharedValue({ starts: layout.starts, total: layout.totalMs });
  /** A finger (or its fling) is moving the row: time follows the row, not the other way. */
  const user = useSharedValue(false);
  /** A clip is being moved: the row follows neither (sortables scrolls it). */
  const moving = useSharedValue(false);

  /** The row under the playhead at the current time. */
  const follow = useCallback(() => {
    'worklet';
    if (user.get() || moving.get()) return;
    const g = geom.get();
    scrollTo(scrollRef, offsetOfTime(g.starts, g.total, timeMs.get()), 0, false);
  }, [user, moving, geom, scrollRef, timeMs]);

  useEffect(() => {
    const g = { starts: layout.starts, total: layout.totalMs };
    scheduleOnUI(() => {
      'worklet';
      geom.set(g);
      follow();
    });
  }, [layout, geom, follow]);
  useAnimatedReaction(
    () => timeMs.get(),
    () => follow(),
  );

  const finish = () => {
    'worklet';
    if (!user.get()) return;
    user.set(false);
    mode.set(Mode.idle);
    scheduleOnRN(scrubEnd, timeMs.get());
  };
  const begin = () => {
    'worklet';
    if (user.get() || moving.get()) return;
    user.set(true);
    mode.set(Mode.scrub);
    scheduleOnRN(dragStart);
  };
  const onScroll = useAnimatedScrollHandler({
    onBeginDrag: () => begin(),
    onScroll: (e) => {
      if (!user.get()) return;
      const g = geom.get();
      timeMs.set(Math.min(totalMs.get(), timeOfOffset(g.starts, g.total, e.contentOffset.x)));
    },
    onEndDrag: (e) => {
      // No fling: done now; otherwise the momentum's end finishes it.
      if (Math.abs(e.velocity?.x ?? 0) < 0.01) finish();
    },
    onMomentumBegin: () => begin(),
    onMomentumEnd: () => finish(),
  });

  // Switched away mid-swipe: end the scrub, so the preview leaves scrubbing.
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

  // The selected clip scrolled out of view: let it go (the clip being edited is always on screen).
  useAnimatedReaction(
    () => {
      if (selected < 0 || moving.get()) return true;
      const x = width / 2 + selected * STEP - offset.get();
      return x + THUMB_WIDTH > VISIBLE_DP && x < widthSv.get() - VISIBLE_DP;
    },
    (visible, prev) => {
      // Only when the person moved it (a swipe, a fling, playback): the row's own layout and
      // scrolls (opening, switching views, after a drop) never let a selection go.
      if (prev === true && !visible && (user.get() || playing.get())) scheduleOnRN(hidden);
    },
    [selected, width],
  );

  const draggedKey = useRef<string | null>(null);
  const touchStart = useRef<{ x: number; y: number; at: number } | null>(null);
  const rowX = useRef(0);
  const onDragStartSortable = useCallback(
    ({ key }: { key: string }) => {
      haptics.pickUp();
      draggedKey.current = key;
      moving.set(true);
      latest.current.onReorderStart();
    },
    [moving],
  );
  const onDragEndSortable = useCallback(
    ({ data }: SortableGridDragEndParams<EditorClip>) => {
      moving.set(false);
      const key = draggedKey.current;
      draggedKey.current = null;
      if (key)
        latest.current.onReorder(
          data.map((c) => c.id),
          key,
        );
    },
    [moving],
  );

  return (
    <View
      style={styles.row}
      // Taps off the thumbnails, watched without a gesture of their own (so nothing competes
      // with sortables' taps and holds): a short touch that didn't move, outside every thumbnail.
      onTouchStart={(e) => {
        touchStart.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, at: Date.now() };
      }}
      onTouchEnd={(e) => {
        const t = touchStart.current;
        touchStart.current = null;
        if (!t || !latest.current.onBlankTap) return;
        const { pageX, pageY } = e.nativeEvent;
        if (Math.hypot(pageX - t.x, pageY - t.y) > 10 || Date.now() - t.at > 400) return;
        const x = pageX - rowX.current + offset.get() - width / 2;
        const slot = Math.floor(x / STEP);
        const onThumb = x >= 0 && slot < clips.length && x - slot * STEP <= THUMB_WIDTH;
        if (!onThumb) latest.current.onBlankTap();
      }}
      onLayout={(e) => {
        rowX.current = e.nativeEvent.layout.x;
        const w = e.nativeEvent.layout.width;
        setWidth(w);
        widthSv.set(w);
      }}>
      <Animated.ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={[styles.content, { paddingHorizontal: width / 2 }]}
        onContentSizeChange={() =>
          scheduleOnUI(() => {
            'worklet';
            follow();
          })
        }>
        <Sortable.Grid
          rows={1}
          rowHeight={THUMB_HEIGHT}
          columnGap={THUMB_GAP}
          data={clips}
          keyExtractor={(c) => c.id}
          scrollableRef={scrollRef}
          autoScrollDirection="horizontal"
          // The dragged clip slides into the gap and the clips it passes shift over by one.
          strategy="insert"
          // In place at once (opening the editor, switching views, a hold on the timeline): no
          // entering animation. Deletes still fade out.
          itemEntering={null}
          // Positions animate only while a clip is dragged; the row's first layout (and any other
          // change) puts the thumbnails straight in place.
          itemsLayoutTransitionMode="reorder"
          onDragStart={onDragStartSortable}
          onDragEnd={onDragEndSortable}
          // Also on the drop: the row must never stay frozen if a drag's end goes unreported.
          onActiveItemDropped={() => moving.set(false)}
          renderItem={({ item, index }) => (
            <Thumb
              clip={item}
              index={index}
              cover={covers.get(item.id) ?? null}
              selected={index === selected}
              onTap={() => latest.current.onSelect(item.id)}
            />
          )}
        />
      </Animated.ScrollView>
      <View
        pointerEvents="none"
        style={[styles.playhead, { left: width / 2 - 2, backgroundColor: theme.text }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { height: ROW_HEIGHT },
  content: { paddingVertical: (ROW_HEIGHT - THUMB_HEIGHT) / 2 },
  thumb: {
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    borderRadius: RADIUS,
    borderCurve: 'continuous',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  selected: { borderColor: Accent },
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
  inner: {
    flex: 1,
    borderRadius: RADIUS - 2,
    borderCurve: 'continuous',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphs: { position: 'absolute', top: 10, left: 0, right: 0, alignItems: 'center' },
  speedWrap: { position: 'absolute', bottom: 20, left: 0, right: 0, alignItems: 'center' },
  durationWrap: { position: 'absolute', bottom: 4, left: 0, right: 0, alignItems: 'center' },
  duration: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    paddingHorizontal: 3,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  badgeWrap: { position: 'absolute', top: -BADGE / 2, left: 0, right: 0, alignItems: 'center' },
  badge: {
    height: BADGE,
    minWidth: BADGE,
    paddingHorizontal: 5,
    borderRadius: BADGE / 2,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
