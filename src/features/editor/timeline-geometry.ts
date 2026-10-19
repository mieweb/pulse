import type { ParsedEdit } from '@/utils/segment-window';

// Pure timeline maths for the editor, safe to call from worklets (UI thread) and from JS.

/** The strip's scale when the editor opens: dp per timeline ms (48 dp per second; a 12 s clip is
 * a 576 dp tile). A pinch zooms it between the draft fitting the strip and MAX_DP_PER_MS. */
export const DP_PER_MS = 0.048;
/** The furthest a pinch zooms in: 600 dp per second (a 0.3 s caption is 180 dp wide). */
export const MAX_DP_PER_MS = 0.6;

/** The scale at which `totalMs` fills `widthDp` (the furthest a pinch zooms out), at most the
 * opening scale. */
export function minDpPerMs(totalMs: number, widthDp: number): number {
  'worklet';
  return totalMs > 0 && widthDp > 0 ? Math.min(DP_PER_MS, (widthDp * 0.9) / totalMs) : DP_PER_MS;
}

/** The ruler's marks at a scale: labelled every `majorMs`, a tick every `minorMs`, with labels
 * about 80 dp apart. */
export function rulerSteps(dpPerMs: number): { majorMs: number; minorMs: number } {
  const steps = [500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];
  const majorMs = steps.find((ms) => ms * dpPerMs >= 80) ?? steps[steps.length - 1];
  const parts = [5, 4, 2].find((n) => (majorMs / n) * dpPerMs >= 12) ?? 1;
  return { majorMs, minorMs: majorMs / parts };
}
/** Shortest clip a trim can make, in source ms. */
export const MIN_CLIP_SOURCE_MS = 1000;
/** A crop this close to the whole frame is stored as no crop. */
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

/** The first frame time at or after `ms` (within a ms counts as on it), in whole ms. */
export function ceilToFrame(ms: number, frameMs: number): number {
  'worklet';
  const n = Math.round(ms / frameMs);
  return Math.round((n * frameMs < ms - 1 ? n + 1 : n) * frameMs);
}

/** The last frame time at or before `ms` (within a ms counts as on it), in whole ms. */
export function floorToFrame(ms: number, frameMs: number): number {
  'worklet';
  const n = Math.round(ms / frameMs);
  return Math.round((n * frameMs > ms + 1 ? n - 1 : n) * frameMs);
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

/** About how wide the captions lane draws a character (11 pt semibold), dp. */
const LANE_CHAR_DP = 6.6;
/** Room around a word's text on the lane, and the narrowest a word gets for a fingertip, dp. */
const WORD_PAD_DP = 8;
const WORD_MIN_DP = 32;
/** The most a caption zooms the timeline to on its own (dp per ms): 300 dp a second. */
const CAPTION_ZOOM_MAX = 0.3;
/** Room a tapped word takes past its text: its two grips (timeline-canvas CAP_GRIP, 10 dp). */
const WORD_GRIPS_DP = 20;

/** The dp a word needs on the lane: its text with padding, at least a fingertip. */
const wordDp = (text: string) => Math.max(WORD_MIN_DP, text.length * LANE_CHAR_DP + WORD_PAD_DP);

/**
 * The scale (dp per ms) for editing a sentence's words on the captions lane: where about half its
 * words fit their text (each needs its text plus padding over its duration), but never past the
 * whole sentence fitting on the strip, nor 300 dp a second. With a word tapped (`focus`, its
 * index), at least where that word fits its text and its grips, however short it is, up to the
 * deepest zoom: a quick "a" or "I" can be read and trimmed. Left as it is when the strip is
 * already zoomed in at least that far. Times in centiseconds, as captions keep them.
 */
export function captionZoom(
  words: readonly { text: string; t0: number; t1: number }[],
  stripWidth: number,
  focus = -1,
): ZoomRequest {
  const durMs = (w: { t0: number; t1: number }) => Math.max(10, (w.t1 - w.t0) * 10);
  const need = words.map((w) => wordDp(w.text) / durMs(w)).sort((a, b) => a - b);
  const median = need.length ? need[Math.floor(need.length / 2)] : DP_PER_MS;
  const spanMs = words.length ? (words[words.length - 1].t1 - words[0].t0) * 10 : 0;
  const fits = spanMs > 0 ? (stripWidth * 0.9) / spanMs : median;
  let target = Math.min(CAPTION_ZOOM_MAX, median, fits);
  const w = words[focus];
  if (w) {
    const own = Math.min(MAX_DP_PER_MS, (wordDp(w.text) + WORD_GRIPS_DP) / durMs(w));
    target = Math.max(target, own);
  }
  return { min: target, max: MAX_DP_PER_MS, target };
}

/**
 * The scale for editing a clip (`lengthMs` long) on the timeline: the whole clip and both its trim
 * grips on the strip, the clip filling about 80% of it, within the zoom's range (no further out
 * than the whole draft, no further in than 300 dp a second). Left as it is while the clip already
 * takes 40–100% of the strip.
 */
export function clipZoom(lengthMs: number, totalMs: number, stripWidth: number): ZoomRequest {
  const len = Math.max(1, lengthMs);
  const target = clamp((stripWidth * 0.8) / len, minDpPerMs(totalMs, stripWidth), CAPTION_ZOOM_MAX);
  return { min: (stripWidth * 0.4) / len, max: stripWidth / len, target };
}

/**
 * The scale the timeline opens a whole draft at (the recorder's Edit): the whole draft on the
 * strip while that leaves it at least half the usual scale (a draft up to about 16 s on a phone),
 * no further in than 300 dp a second; a longer one at the usual scale (about 9 s across), where
 * frames and words still read.
 */
export function draftZoom(totalMs: number, stripWidth: number): number {
  const fit = totalMs > 0 ? (stripWidth * 0.9) / totalMs : DP_PER_MS;
  return fit >= DP_PER_MS / 2 ? Math.min(fit, CAPTION_ZOOM_MAX) : DP_PER_MS;
}

/** A scale to zoom the timeline to (`target`, dp per ms), unless it's already within min … max;
 * `instant` sets it without the ease (the editor opening). */
export type ZoomRequest = { min: number; max: number; target: number; instant?: boolean };

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
 * The layout to draw: the engine's clip starts when its status describes these clips (every
 * clip's length within a frame or two of the edit's), else the edits' own lengths. The engine's
 * numbers are the truth (an untrimmed clip's end differs per platform). Pass only a status built
 * from the preview's current clips (a status lags an edit by one rebuild, and a one-frame trim is
 * within the tolerance); the lengths still set aside one that played a clip differently (the clip
 * being trimmed plays whole).
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
  if (!engine || !e || e.length !== lengthsMs.length || e.length === 0)
    return { starts, totalMs: at };
  for (let i = 0; i < e.length; i++) {
    const len = (i + 1 < e.length ? e[i + 1] : engine.durationMs) - e[i];
    if (Math.abs(len - lengthsMs[i]) > 60) return { starts, totalMs: at };
  }
  return { starts: [...e], totalMs: engine.durationMs };
}

// --- Edits (the clip's settings, as `setClipEdit` stores them) --------------------------------

/** One quarter turn counter-clockwise (it counts down while flipped, so it still turns the
 * same way on screen). A crop is relative to the rotated frame, so it resets. */
export const rotated = (e: ParsedEdit): ParsedEdit => ({
  ...e,
  rotation: (e.rotation + (e.flipped ? 3 : 1)) % 4,
  crop: null,
});

/** Mirrored horizontally; the crop resets. */
export const flippedEdit = (e: ParsedEdit): ParsedEdit => ({
  ...e,
  flipped: !e.flipped,
  crop: null,
});

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
