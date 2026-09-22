import type { Segment } from '@/db/schema';
import { segmentSignature } from '@/utils/segment-window';

// The app's export contract: reels-style portrait 1080×1920 H.264 30fps, on every platform.
// Pinned so the canvas is never inferred from the clips — recorder clips and normalized imports
// already match (lossless fast path); anything else (e.g. a landscape library import) conforms.
export const REELS_TARGET = {
  targetWidth: 1080,
  targetHeight: 1920,
  targetFps: 30,
  targetCodec: 'h264',
} as const;

/**
 * Bump whenever REELS_TARGET or any other merge setting changes, so a persisted export encoded
 * under the old settings stops matching and an app update never serves a stale encode.
 */
export const MERGE_VERSION = 1;

/**
 * Content key of a draft's merged export: the merge settings version + the ordered effective
 * files. Originals are never rewritten and every trim writes a new `effFile`, so equal
 * signatures mean identical content: it changes on add/delete/reorder/trim, and returns to its
 * old value when those are undone (reset a trim → back to the original file). It is also the
 * merged-transcript staleness key, so video and captions follow the clips in lockstep.
 */
export const mergedSignature = (segments: Segment[], version: number = MERGE_VERSION): string =>
  `${version}|${segmentSignature(segments)}`;

/** What's on record for a draft's persisted export (the `drafts` row + whether the file exists). */
export type PersistedExport = {
  fileExists: boolean;
  signature: string | null;
  durationMs: number | null;
};

/**
 * The persisted export's duration if it is a valid export of exactly `segments` — the file is
 * on disk AND its recorded signature matches the current clips — else `null` (merge again).
 * This is the only freshness check: clip edits don't touch the export, so this is what decides
 * reuse vs re-merge when the export screen opens.
 */
export function currentExportDuration(
  persisted: PersistedExport,
  segments: Segment[],
): number | null {
  if (!persisted.fileExists || persisted.durationMs == null) return null;
  return persisted.signature === mergedSignature(segments) ? persisted.durationMs : null;
}
