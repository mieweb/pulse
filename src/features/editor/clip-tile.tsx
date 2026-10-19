import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { Icon } from '@/components/icon';
import type { ParsedEdit } from '@/utils/segment-window';

import { EditCues } from './edit-cues';

export const TILE_HEIGHT = 88;
/** The film lane's height (the waveform lane starts just under it). */
export const FILM_HEIGHT = 46;
export const TILE_GAP = 2;
export const TILE_RADIUS = 6;

/** Where the clips are and how a trim is moving them, on the UI thread (the strip owns it). */
export type TileMotion = {
  /** Each clip's [start, length] in timeline ms, flattened: the layout. */
  slots: SharedValue<number[]>;
  /** The clip being trimmed (-1: none), which grip (1 left, 2 right) and how far it moved (ms). */
  sel: SharedValue<number>;
  side: SharedValue<number>;
  delta: SharedValue<number>;
  /** The strip's scale as it is this frame (dp per timeline ms; a pinch changes it live). */
  zoom: SharedValue<number>;
};

/** The tile's colours, from the app's theme. */
export type TilePalette = { tile: string; film: string; wave: string; line: string; dim: string };

type Props = {
  index: number;
  edit: ParsedEdit;
  motion: TileMotion;
  palette: TilePalette;
};

/**
 * One clip on the strip, over the timeline canvas that draws its filmstrip and waveform
 * (timeline-canvas.tsx): its edits as cues, and a mute glyph in the sound lane. Placed from the
 * strip's layout and scale on the UI thread, so a trim and a pinch move it live; it re-renders
 * only when its edit does.
 */
export const ClipTile = memo(function ClipTile({ index, edit, motion, palette }: Props) {
  const { slots, sel, side, delta, zoom } = motion;
  const frame = useAnimatedStyle(() => {
    const z = zoom.get();
    const g = slots.get();
    const left = (g[index * 2] ?? 0) * z;
    const w = Math.max(2, (g[index * 2 + 1] ?? 0) * z - TILE_GAP);
    const s = side.get();
    const d = delta.get() * z;
    const t = sel.get();
    if (s === 0 || t < 0 || index < t) return { left, width: w };
    if (index === t) {
      return s === 1
        ? { left: left + d, width: Math.max(2, w - d) }
        : { left, width: Math.max(2, w + d) };
    }
    // After the trimmed clip: a right grip carries them along.
    return { left: s === 2 ? left + d : left, width: w };
  }, [index]);

  return (
    <Animated.View style={[styles.tile, frame]} pointerEvents="none">
      {edit.muted && (
        <View style={styles.muted}>
          <Icon name="speaker.slash.fill" size={11} tintColor={palette.dim} />
        </View>
      )}
      <EditCues edit={edit} layout="row" showMute={false} style={styles.cues} />
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  tile: {
    position: 'absolute',
    top: 0,
    height: TILE_HEIGHT,
    borderRadius: TILE_RADIUS,
    overflow: 'hidden',
  },
  muted: {
    position: 'absolute',
    left: 8,
    top: FILM_HEIGHT + 2,
    bottom: 0,
    justifyContent: 'center',
  },
  cues: { position: 'absolute', top: 4, left: 4 },
});
