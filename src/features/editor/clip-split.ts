import { anchorForExactPlayhead } from '@/core/clip-anchor';
import { isSplitInterior, SPLIT_BOUNDARY_TOLERANCE_MS } from '@/utils/segment-window';

import { clipIndexAt } from './timeline-geometry';

/** Whether a selected clip contains two nonempty halves at this timeline position. */
export function canSplitClip(
  edit: { startMs: number; endMs: number; speed: number },
  slotStartMs: number,
  totalMs: number,
  timeMs: number,
): boolean {
  'worklet';
  // The preview represents an end seek as totalMs - 1, as exact insertion anchors do.
  if (!Number.isFinite(timeMs) || timeMs >= totalMs - SPLIT_BOUNDARY_TOLERANCE_MS) return false;
  const sourceMs = edit.startMs + (timeMs - slotStartMs) * edit.speed;
  return isSplitInterior(sourceMs, edit.startMs, edit.endMs, edit.speed);
}

/** Main-toolbar availability follows the playhead even when no clip is selected. */
export function canSplitAtPlayhead(
  edits: readonly { startMs: number; endMs: number; speed: number }[],
  starts: readonly number[],
  totalMs: number,
  timeMs: number,
): boolean {
  'worklet';
  const i = clipIndexAt(starts, timeMs);
  return !!edits[i] && canSplitClip(edits[i], starts[i], totalMs, timeMs);
}

/** Re-read the playhead when pressed: the toolbar's enabled state can lag playback. */
export function clipSplitAnchor(
  clips: Parameters<typeof anchorForExactPlayhead>[0],
  layout: { starts: readonly number[]; totalMs: number },
  timeMs: number,
  freshId: () => string,
) {
  const anchor = anchorForExactPlayhead(clips, layout.starts, layout.totalMs, timeMs, freshId);
  return 'before' in anchor && anchor.split ? anchor : null;
}
