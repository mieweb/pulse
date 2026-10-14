import { Image } from 'expo-image';
import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
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
const WAVE_COLOR = '#FF9230';

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

type Props = {
  left: number;
  width: number;
  cover: string | null;
  /** Undefined while loading, null when the file has no sound. */
  peaks: Peaks | null | undefined;
  edit: ParsedEdit;
  /** Near the visible part of the strip: draws the covers and the waveform. */
  near: boolean;
};

/**
 * One clip on the strip: its cover repeated as a filmstrip (one decode, cached by expo-image),
 * its loudness under it so speech and silence show at a glance, and its speed when it's not 1x.
 * Static: only the strip's container moves.
 */
export const ClipTile = memo(function ClipTile({ left, width, cover, peaks, edit, near }: Props) {
  const inner = Math.max(2, width - TILE_GAP);
  const cells = near && cover ? Math.ceil(inner / CELL_WIDTH) : 0;
  const wave = useMemo(
    () => (near && peaks && !edit.muted ? wavePaths(peaks, edit, inner) : null),
    [near, peaks, edit, inner],
  );
  return (
    <View style={[styles.tile, { left, width: inner }]}>
      <View style={styles.film}>
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
      <View style={styles.wave}>
        {wave ? (
          <Svg width={inner} height={WAVE_HEIGHT}>
            <Path
              d={`M0 ${WAVE_HEIGHT / 2}H${inner}`}
              stroke={WAVE_COLOR}
              strokeOpacity={0.35}
              strokeWidth={1}
            />
            <Path d={wave.peak} stroke={WAVE_COLOR} strokeOpacity={0.5} strokeWidth={1} />
            <Path d={wave.rms} stroke={WAVE_COLOR} strokeWidth={1} />
          </Svg>
        ) : edit.muted ? (
          <View style={styles.muted}>
            <Icon name="speaker.slash.fill" size={11} tintColor="rgba(255,255,255,0.55)" />
          </View>
        ) : peaks === null ? (
          <View style={styles.silence} />
        ) : null}
      </View>
      <EditCues edit={edit} layout="row" showMute={false} style={styles.cues} />
    </View>
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
    backgroundColor: '#2C2C2E',
  },
  film: {
    height: FILM_HEIGHT,
    flexDirection: 'row',
    overflow: 'hidden',
    backgroundColor: '#3A3A3C',
  },
  cell: { width: CELL_WIDTH, height: FILM_HEIGHT },
  wave: {
    marginTop: 2,
    height: WAVE_HEIGHT,
    backgroundColor: '#1C1C1E',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  muted: { paddingLeft: 8 },
  silence: { height: 1.5, marginHorizontal: 4, backgroundColor: 'rgba(255,146,48,0.45)' },
  cues: { position: 'absolute', top: 4, left: 4 },
});
