import type { Segment } from '@/db/schema';

import { clipRender, SPLIT_BOUNDARY_TOLERANCE_MS, type ClipWindow } from './segment-window';

export type TranscriptCutPlan = {
  kept: ClipWindow[];
  removed: ClipWindow[];
  /** Estimated timeline time removed, after the clip's speed setting. */
  removedMs: number;
};

function ownedWords(value: unknown, window: ClipWindow): unknown[] | null {
  if (
    !Array.isArray(value) ||
    !value.every(
      (word) =>
        word &&
        typeof word === 'object' &&
        typeof word.text === 'string' &&
        Number.isFinite(word.t0) &&
        Number.isFinite(word.t1) &&
        word.t1 >= word.t0,
    )
  )
    return null;
  // Exactly the caption composer's source midpoint rule; timestamps and word metadata stay put.
  const selected = value.filter((word) => {
    const middle = ((word.t0 + word.t1) / 2) * 10;
    return middle >= window.startMs && middle < window.endMs;
  });
  // Preserve explicit sentence grouping even when the original sentence start was cut away.
  if (selected.length && value.some((word) => word.start))
    selected[0] = { ...selected[0], start: true };
  return selected;
}

/** Retained ranges cannot expand beyond their baseWindow, so words outside it need no copy. */
export function compactTranscriptWords(json: string | null, window: ClipWindow): string | null {
  if (json == null) return json;
  try {
    const words = ownedWords(JSON.parse(json), window);
    return words ? JSON.stringify(words) : json;
  } catch {
    return json;
  }
}

/** Keep opaque/legacy payloads intact and preserve every unknown top-level and word field. */
export function compactCaptionWords(
  json: string | null,
  file: string,
  window: ClipWindow,
): string | null {
  if (json == null) return json;
  try {
    const value = JSON.parse(json);
    if (!value || typeof value !== 'object' || value.file !== file) return json;
    const words = ownedWords(value.words, window);
    return words ? JSON.stringify({ ...value, words }) : json;
  } catch {
    return json;
  }
}

/**
 * A batch edits source ranges, not composed caption positions. Clamp to the current trim,
 * snap to source frames, merge overlaps and absorb retained slivers the player cannot show.
 * Empty kept ranges mean the whole beat is removed; the history still owns its original.
 */
export function planTranscriptCut(
  segment: Segment,
  ranges: readonly ClipWindow[],
  fps: number,
): TranscriptCutPlan | null {
  const { inMs, outMs, speed } = clipRender(segment);
  if (
    ![inMs, outMs, speed, fps].every(Number.isFinite) ||
    outMs <= inMs ||
    speed <= 0 ||
    fps <= 0 ||
    ranges.length === 0 ||
    ranges.length > 5000 ||
    ranges.some(
      (range) =>
        !Number.isFinite(range.startMs) ||
        !Number.isFinite(range.endMs) ||
        range.endMs <= range.startMs,
    )
  )
    return null;
  const frameMs = 1000 / fps;
  const playable = (ms: number) =>
    ms >= Math.max(1, Math.floor(frameMs)) && ms / speed > SPLIT_BOUNDARY_TOLERANCE_MS;
  const snap = (ms: number) =>
    Math.min(outMs, Math.max(inMs, Math.round(Math.round(ms / frameMs) * frameMs)));
  const candidates = ranges
    .map(({ startMs, endMs }) => ({ startMs: snap(startMs), endMs: snap(endMs) }))
    .filter((range) => playable(range.endMs - range.startMs))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const removed: ClipWindow[] = [];
  for (const candidate of candidates) {
    const previous = removed.at(-1);
    if (previous && !playable(candidate.startMs - previous.endMs)) {
      previous.endMs = Math.max(previous.endMs, candidate.endMs);
    } else removed.push({ ...candidate });
  }
  if (!removed.length) return null;
  if (!playable(removed[0].startMs - inMs)) removed[0].startMs = inMs;
  if (!playable(outMs - removed[removed.length - 1].endMs))
    removed[removed.length - 1].endMs = outMs;
  const kept: ClipWindow[] = [];
  let cursor = inMs;
  for (const range of removed) {
    if (playable(range.startMs - cursor)) kept.push({ startMs: cursor, endMs: range.startMs });
    cursor = range.endMs;
  }
  if (playable(outMs - cursor)) kept.push({ startMs: cursor, endMs: outMs });
  return {
    kept,
    removed,
    removedMs: removed.reduce((sum, range) => sum + (range.endMs - range.startMs) / speed, 0),
  };
}
