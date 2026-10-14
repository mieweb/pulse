import type { ParsedEdit } from '@/utils/segment-window';

// Pure timeline maths for the editor, safe to call from worklets (UI thread) and from JS.

/** Strip scale: dp per timeline ms (48 dp per second; a 12 s clip is a 576 dp tile). */
export const DP_PER_MS = 0.048;
/** Shortest clip a trim can make, in source ms (RNVT's minimum). */
export const MIN_CLIP_SOURCE_MS = 1000;
/** A crop this close to the whole frame is stored as no crop (RNVT's rule). */
const FULL_FRAME_SLACK = 0.01;

export const clamp = (v: number, lo: number, hi: number) => {
  'worklet';
  return Math.min(hi, Math.max(lo, v));
};

/** The nearest source frame's time, in whole ms (the engine snaps trims the same way). */
export function snapToFrame(ms: number, frameMs: number): number {
  'worklet';
  return Math.round(Math.round(ms / frameMs) * frameMs);
}

/** Index of the clip under timeline time `ms` (-1 for an empty timeline). */
export function clipIndexAt(starts: readonly number[], ms: number): number {
  'worklet';
  let index = starts.length ? 0 : -1;
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] <= ms) index = i;
    else break;
  }
  return index;
}

/** `m:ss.t`, the readout under the preview. */
export function formatTime(ms: number): string {
  'worklet';
  const tenths = Math.max(0, Math.floor(ms / 100));
  const seconds = Math.floor(tenths / 10);
  const ss = seconds % 60;
  return `${Math.floor(seconds / 60)}:${ss < 10 ? '0' : ''}${ss}.${tenths % 10}`;
}

/** Where each clip sits on the timeline, and the timeline's length, in ms. */
export type TimelineLayout = { starts: number[]; totalMs: number };

/**
 * The layout to draw: the engine's clip starts when its last status describes these clips
 * (every clip's length within a frame or two of the edit's), else the edits' own lengths. The
 * engine's numbers are the truth (an untrimmed clip's end differs per platform), but a status
 * lags an edit by one rebuild, so a stale one is told apart by its lengths.
 */
export function timelineLayout(
  lengthsMs: readonly number[],
  engine: { durationMs: number; clipStartsMs: readonly number[] } | null,
): TimelineLayout {
  const starts: number[] = [];
  let at = 0;
  for (const len of lengthsMs) {
    starts.push(at);
    at += len;
  }
  const e = engine?.clipStartsMs;
  if (!engine || !e || e.length !== lengthsMs.length || e.length === 0) return { starts, totalMs: at };
  for (let i = 0; i < e.length; i++) {
    const len = (i + 1 < e.length ? e[i + 1] : engine.durationMs) - e[i];
    if (Math.abs(len - lengthsMs[i]) > 60) return { starts, totalMs: at };
  }
  return { starts: [...e], totalMs: engine.durationMs };
}

// --- Edits (the clip's settings, as `setClipEdit` stores them) --------------------------------

/** One quarter turn counter-clockwise, as RNVT's rotate (it counts down while flipped, so it
 * still turns the same way on screen). A crop is relative to the rotated frame, so it resets. */
export const rotated = (e: ParsedEdit): ParsedEdit => ({
  ...e,
  rotation: (e.rotation + (e.flipped ? 3 : 1)) % 4,
  crop: null,
});

/** Mirrored horizontally; the crop resets, as in RNVT. */
export const flippedEdit = (e: ParsedEdit): ParsedEdit => ({ ...e, flipped: !e.flipped, crop: null });

/** A crop rect normalized to the displayed frame, or null when it's (nearly) the whole frame. */
export function normalizedCrop(c: { x: number; y: number; w: number; h: number }) {
  const x = clamp(c.x, 0, 1);
  const y = clamp(c.y, 0, 1);
  const w = clamp(c.w, 0, 1 - x);
  const h = clamp(c.h, 0, 1 - y);
  const full =
    x <= FULL_FRAME_SLACK &&
    y <= FULL_FRAME_SLACK &&
    w >= 1 - FULL_FRAME_SLACK - x &&
    h >= 1 - FULL_FRAME_SLACK - y;
  return full ? null : { x, y, w, h };
}

/** The clip's speed as the toolbar shows it: "1x", "1.25x". */
export const speedLabel = (speed: number) => `${Number(speed.toFixed(2))}x`;
