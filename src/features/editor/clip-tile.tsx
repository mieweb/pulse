import { Image } from 'expo-image';
import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { Icon } from '@/components/icon';
import type { ParsedEdit } from '@/utils/segment-window';

import { EditCues } from './edit-cues';
import { frameAt, frameStep, frameTimes, useFrames, type FrameLook } from './filmstrip';
import { PEAK_MS, type Peaks } from './use-waveforms';

export const TILE_HEIGHT = 88;
const FILM_HEIGHT = 46;
const WAVE_HEIGHT = TILE_HEIGHT - FILM_HEIGHT - 2;
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
 * (its trim, at its speed, `dpPerMs` dp per timeline ms), mirrored around the centre: the peak in
 * that slice (outer, light) and its RMS (inner, solid). Only `fromX` … `toX` (dp into the tile),
 * with x measured from `fromX`: a zoomed-in tile can be far wider than anything drawn at once.
 */
function wavePaths(
  peaks: Peaks,
  edit: ParsedEdit,
  fromX: number,
  toX: number,
  dpPerMs: number,
): { peak: string; rms: string } {
  const mid = WAVE_HEIGHT / 2;
  const half = mid - 2;
  const span = (WAVE_STEP / dpPerMs) * edit.speed;
  const count = peaks.length / 2;
  let peak = '';
  let rms = '';
  const first = WAVE_STEP / 2 + Math.floor(fromX / WAVE_STEP) * WAVE_STEP;
  for (let x = first; x < toX; x += WAVE_STEP) {
    const t0 = edit.startMs + ((x - WAVE_STEP / 2) / dpPerMs) * edit.speed;
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
    const xs = (x - fromX).toFixed(1);
    peak += `M${xs} ${(mid - ph).toFixed(1)}V${(mid + ph).toFixed(1)}`;
    rms += `M${xs} ${(mid - rh).toFixed(1)}V${(mid + rh).toFixed(1)}`;
  }
  return { peak, rms };
}

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
  /** The clip's id, and the file it plays (`file://`): the filmstrip's frames are that file's. */
  id: string;
  uri: string;
  index: number;
  /** Its length on the timeline, ms (the layout's; motion moves the drawn one). */
  lengthMs: number;
  /** The scale its covers and waveform are drawn at (dp per ms); during a pinch they stretch to
   * the live one until the strip draws them again. */
  dpPerMs: number;
  cover: string | null;
  /** Undefined while loading, null when the file has no sound. */
  peaks: Peaks | null | undefined;
  edit: ParsedEdit;
  /** The source file's length, ms. */
  sourceMs: number;
  /** Where it starts on the timeline, ms. */
  startMs: number;
  /** Near the visible part of the strip: draws the covers and the waveform, within the strip's
   * near window (`nearFromMs` … `nearToMs`, timeline ms). */
  near: boolean;
  nearFromMs: number;
  nearToMs: number;
  /** Being trimmed: draws its whole source behind the window, so a grip reveals or hides it. */
  trimming: boolean;
  motion: TileMotion;
  palette: TilePalette;
};

/**
 * One clip on the strip: a filmstrip of its frames (filmstrip.ts), its loudness under it so
 * speech and silence show at a glance, and its edits as cues. Its content is its whole source,
 * frames and waveform at their source times, and the tile is a window onto the trimmed part: a
 * trim moves the window, so it shows more or less of the same frames and nothing is fetched or
 * redrawn for it. Placed from the strip's layout and scale on the UI thread, so a trim resizes it
 * (and moves the clips after it) and a pinch zooms it live under the fingers.
 */
export const ClipTile = memo(function ClipTile({
  id,
  uri,
  index,
  lengthMs,
  dpPerMs,
  startMs,
  nearFromMs,
  nearToMs,
  cover,
  peaks,
  edit,
  sourceMs,
  near,
  trimming,
  motion,
  palette,
}: Props) {
  const { speed } = edit;
  const inner = Math.max(2, lengthMs * dpPerMs - TILE_GAP);
  // The content is the whole source, its trim start at the window's left edge.
  const offsetMs = edit.startMs / speed;
  const contentWidth = Math.max(inner, (sourceMs / speed) * dpPerMs);
  const contentEdit = useMemo(() => ({ ...edit, startMs: 0, endMs: sourceMs }), [edit, sourceMs]);
  // The part to draw (dp into the content): the trimmed part (all of it while a grip reveals the
  // rest), within the near window. Zoomed in, a tile is many screens wide, and only this much of
  // it is ever on screen.
  const leftMs = startMs - offsetMs;
  const shownFrom = trimming ? 0 : (edit.startMs / speed) * dpPerMs;
  const shownTo = trimming ? contentWidth : (edit.endMs / speed) * dpPerMs;
  const fromX = near ? Math.max(shownFrom, (nearFromMs - leftMs) * dpPerMs) : 0;
  const toX = near ? Math.min(shownTo, (nearToMs - leftMs) * dpPerMs) : 0;

  // Frames at fixed source times (a grid the scale picks), each drawn from its time to the next.
  const look = useMemo<FrameLook>(
    () => ({ rotation: edit.rotation, flipped: edit.flipped, crop: edit.crop }),
    [edit.rotation, edit.flipped, edit.crop],
  );
  const step = frameStep(dpPerMs, speed);
  const cellDp = (step / speed) * dpPerMs;
  const times =
    toX > fromX
      ? frameTimes(step, (fromX / dpPerMs) * speed, (toX / dpPerMs) * speed, sourceMs)
      : [];
  // Re-renders as the file's frames land.
  useFrames(id, uri, look, times, sourceMs);
  const wave = useMemo(
    () =>
      near && peaks && !edit.muted && toX > fromX
        ? wavePaths(peaks, contentEdit, fromX, toX, dpPerMs)
        : null,
    [near, peaks, edit.muted, contentEdit, fromX, toX, dpPerMs],
  );

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
  // The covers and waveform, drawn at `dpPerMs`, stretched to the live scale.
  const content = useAnimatedStyle(() => {
    const z = zoom.get();
    const d = sel.get() === index && side.get() === 1 ? delta.get() : 0;
    return { transform: [{ translateX: -(offsetMs + d) * z }, { scaleX: z / dpPerMs }] };
  }, [index, offsetMs, dpPerMs]);

  return (
    <Animated.View style={[styles.tile, { backgroundColor: palette.tile }, frame]}>
      <Animated.View style={[styles.content, { width: contentWidth }, content]}>
        <View style={[styles.film, { backgroundColor: palette.film }]}>
          {times.map((t) => {
            const source = frameAt(uri, look, t, step) ?? cover;
            if (!source) return null;
            return (
              <Image
                key={t}
                source={source}
                style={[styles.cell, { left: (t / speed) * dpPerMs, width: cellDp }]}
                contentFit="cover"
                transition={0}
                cachePolicy="memory"
              />
            );
          })}
        </View>
        <View style={[styles.wave, { backgroundColor: palette.wave }]}>
          {wave ? (
            <Svg
              width={toX - fromX}
              height={WAVE_HEIGHT}
              style={[styles.waveDrawn, { left: fromX }]}>
              <Path
                d={`M0 ${WAVE_HEIGHT / 2}H${toX - fromX}`}
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
  content: { transformOrigin: 'left' },
  film: {
    height: FILM_HEIGHT,
    overflow: 'hidden',
  },
  cell: { position: 'absolute', top: 0, height: FILM_HEIGHT },
  waveDrawn: { position: 'absolute', top: 0 },
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
