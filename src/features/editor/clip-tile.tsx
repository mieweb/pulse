import { Image } from 'expo-image';
import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { Icon } from '@/components/icon';
import type { ParsedEdit } from '@/utils/segment-window';

import { EditCues } from './edit-cues';
import { DP_PER_MS } from './timeline-geometry';
import { PEAK_MS, type Peaks } from './use-waveforms';

export const TILE_HEIGHT = 88;
const FILM_HEIGHT = 46;
const WAVE_HEIGHT = TILE_HEIGHT - FILM_HEIGHT - 2;
/** One cover per this many dp of tile: a 9:16 cover cropped to the film lane. */
const CELL_WIDTH = 30;
/** One waveform line per this many dp. */
const WAVE_STEP = 2;
export const TILE_GAP = 2;
export const TILE_RADIUS = 6;

/** Stored level (0–255 over -48…0 dBFS) → display height 0–1: back to amplitude, then a gentle
 * curve (≈ loudness), so speech, pauses and peaks read apart instead of every sound filling the
 * lane as a dB scale does. */
const LEVELS = Array.from({ length: 256 }, (_, l) =>
  l === 0 ? 0 : Math.pow(Math.pow(10, ((l / 255) * 48 - 48) / 20), 0.6),
);

/**
 * The tile's sound as a waveform: one thin vertical line per WAVE_STEP dp of the source it shows
 * (its trim, at its speed), mirrored around the centre: the peak in that slice (outer, light) and
 * its RMS (inner, solid).
 */
function wavePaths(peaks: Peaks, edit: ParsedEdit, width: number): { peak: string; rms: string } {
  const mid = WAVE_HEIGHT / 2;
  const half = mid - 2;
  const span = (WAVE_STEP / DP_PER_MS) * edit.speed;
  const count = peaks.length / 2;
  let peak = '';
  let rms = '';
  for (let x = WAVE_STEP / 2; x < width; x += WAVE_STEP) {
    const t0 = edit.startMs + ((x - WAVE_STEP / 2) / DP_PER_MS) * edit.speed;
    let p = 0;
    let r = 0;
    const last = Math.min(count, Math.ceil((t0 + span) / PEAK_MS));
    for (let b = Math.max(0, Math.floor(t0 / PEAK_MS)); b < last; b++) {
      if (peaks[b * 2] > p) p = peaks[b * 2];
      if (peaks[b * 2 + 1] > r) r = peaks[b * 2 + 1];
    }
    const ph = LEVELS[p] * half;
    // Silence is the centre line (drawn once), not a row of dots.
    if (ph < 0.75) continue;
    const rh = Math.min(ph, LEVELS[r] * half);
    const xs = x.toFixed(1);
    peak += `M${xs} ${(mid - ph).toFixed(1)}V${(mid + ph).toFixed(1)}`;
    rms += `M${xs} ${(mid - rh).toFixed(1)}V${(mid + rh).toFixed(1)}`;
  }
  return { peak, rms };
}

/** Where the clips are and how a trim is moving them, on the UI thread (the strip owns it). */
export type TileMotion = {
  /** Each clip's [left, width] in dp, flattened: the layout. */
  slots: SharedValue<number[]>;
  /** The clip being trimmed (-1: none), which grip (1 left, 2 right) and how far it moved (dp). */
  sel: SharedValue<number>;
  side: SharedValue<number>;
  delta: SharedValue<number>;
};

/** The tile's colours, from the app's theme. */
export type TilePalette = { tile: string; film: string; wave: string; line: string; dim: string };

type Props = {
  index: number;
  /** Its width on the timeline, dp (the layout's; motion moves the drawn one). */
  width: number;
  cover: string | null;
  /** Undefined while loading, null when the file has no sound. */
  peaks: Peaks | null | undefined;
  edit: ParsedEdit;
  /** The source file's length, ms. */
  sourceMs: number;
  /** Near the visible part of the strip: draws the covers and the waveform. */
  near: boolean;
  /** Being trimmed: shows its whole source behind the window, so a grip reveals or hides it. */
  trimming: boolean;
  motion: TileMotion;
  palette: TilePalette;
};

/**
 * One clip on the strip: its cover repeated as a filmstrip (one decode, cached by expo-image),
 * its loudness under it so speech and silence show at a glance, and its edits as cues. Placed
 * from the strip's layout on the UI thread, so a trim resizes it (and moves the clips after it)
 * live under the finger.
 */
export const ClipTile = memo(function ClipTile({
  index,
  width,
  cover,
  peaks,
  edit,
  sourceMs,
  near,
  trimming,
  motion,
  palette,
}: Props) {
  const inner = Math.max(2, width - TILE_GAP);
  // While trimmed, the content is the whole source, its trim start at the window's left edge.
  const offset = trimming ? (edit.startMs / edit.speed) * DP_PER_MS : 0;
  const contentWidth = trimming ? Math.max(inner, (sourceMs / edit.speed) * DP_PER_MS) : inner;
  const contentEdit = useMemo(
    () => (trimming ? { ...edit, startMs: 0, endMs: sourceMs } : edit),
    [trimming, edit, sourceMs],
  );
  const cells = near && cover ? Math.ceil(contentWidth / CELL_WIDTH) : 0;
  const wave = useMemo(
    () => (near && peaks && !edit.muted ? wavePaths(peaks, contentEdit, contentWidth) : null),
    [near, peaks, edit.muted, contentEdit, contentWidth],
  );

  const { slots, sel, side, delta } = motion;
  const frame = useAnimatedStyle(() => {
    const g = slots.get();
    const left = g[index * 2] ?? 0;
    const w = Math.max(2, (g[index * 2 + 1] ?? 0) - TILE_GAP);
    const s = side.get();
    const d = delta.get();
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
  const content = useAnimatedStyle(() => {
    const d = sel.get() === index && side.get() === 1 ? delta.get() : 0;
    return { transform: [{ translateX: -offset - d }] };
  }, [index, offset]);

  return (
    <Animated.View style={[styles.tile, { backgroundColor: palette.tile }, frame]}>
      <Animated.View style={[{ width: contentWidth }, content]}>
        <View style={[styles.film, { backgroundColor: palette.film }]}>
          {Array.from({ length: cells }, (_, i) => (
            <Image
              key={i}
              source={cover}
              style={styles.cell}
              contentFit="cover"
              transition={0}
              cachePolicy="memory-disk"
            />
          ))}
        </View>
        <View style={[styles.wave, { backgroundColor: palette.wave }]}>
          {wave ? (
            <Svg width={contentWidth} height={WAVE_HEIGHT}>
              <Path
                d={`M0 ${WAVE_HEIGHT / 2}H${contentWidth}`}
                stroke={palette.line}
                strokeOpacity={0.35}
                strokeWidth={1}
              />
              <Path d={wave.peak} stroke={palette.line} strokeOpacity={0.5} strokeWidth={1} />
              <Path d={wave.rms} stroke={palette.line} strokeWidth={1} />
            </Svg>
          ) : edit.muted ? (
            <View style={styles.muted}>
              <Icon name="speaker.slash.fill" size={11} tintColor={palette.dim} />
            </View>
          ) : peaks === null ? (
            <View style={[styles.silence, { backgroundColor: palette.line }]} />
          ) : null}
        </View>
      </Animated.View>
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
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  film: {
    height: FILM_HEIGHT,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  cell: { width: CELL_WIDTH, height: FILM_HEIGHT },
  wave: {
    marginTop: 2,
    height: WAVE_HEIGHT,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  muted: { paddingLeft: 8 },
  silence: { height: 1, marginHorizontal: 4, opacity: 0.45 },
  cues: { position: 'absolute', top: 4, left: 4 },
});
