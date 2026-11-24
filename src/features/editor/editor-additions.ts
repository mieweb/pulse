import type { MenuAction } from '@/components/action-menu';
import type { ClipAnchor } from '@/core/clip-anchor';
import {
  importImagesAction,
  importVideoAction,
  recordScreenAction,
} from '@/features/recorder/add-menu-actions';

// The editor's "+" (#308) as pure logic: its items, and how the clips that land become undo
// steps. use-editor-additions.ts runs them.

/**
 * The "+" items. Each adds at the playhead's clip boundary, read once, as the item is picked (the
 * player paused first), and kept: an import's long conversion or a screen take lands there
 * whatever is scrubbed, trimmed or reordered meanwhile. An item whose callback is absent isn't
 * offered (no recorder to open, no screen recording or one already running, no other draft with
 * clips).
 */
export function editorAddActions({
  anchorNow,
  pause,
  record,
  recordScreen,
  importVideo,
  importImages,
  fromAnotherPulse,
}: {
  anchorNow: () => ClipAnchor;
  pause: () => void;
  /** Into the recorder, its insert cursor here; back here with the new clips on Edit. */
  record?: (anchor: ClipAnchor) => void;
  /** Pulse app only, one take at a time: the clip lands here once the take is stopped. */
  recordScreen?: (anchor: ClipAnchor) => void;
  importVideo: (anchor: ClipAnchor) => void;
  /** One clip per image, in the order picked. */
  importImages: (anchor: ClipAnchor) => void;
  /** Copies of another draft's clips, with their edits and captions (it reads its own anchor). */
  fromAnotherPulse?: MenuAction;
}): MenuAction[] {
  const at = (add: (anchor: ClipAnchor) => void) => () => {
    pause();
    add(anchorNow());
  };
  return [
    ...(record
      ? [{ key: 'record', label: 'Record', icon: 'video.badge.plus' as const, onPress: at(record) }]
      : []),
    ...(recordScreen ? [recordScreenAction(at(recordScreen))] : []),
    importVideoAction(at(importVideo)),
    importImagesAction(at(importImages)),
    ...(fromAnotherPulse ? [fromAnotherPulse] : []),
  ];
}

/**
 * A batch of images being added: its clips' ids as each is about to be written (`onWriting`), and
 * those that have landed, in order.
 */
export type ImageBatch = { writing: readonly string[]; landed: readonly string[] };

/** A clip of the batch is about to be written: from then on it's told apart from other adds. */
export function batchWriting(batch: ImageBatch | null, id: string): ImageBatch {
  return { writing: [...(batch?.writing ?? []), id], landed: batch?.landed ?? [] };
}

/**
 * Clips added to the draft while the editor is open (`added`, in the order they landed), from its
 * "+" or a recorder over it, as undo steps: each addition is one step, in the order they're taken,
 * with the playhead to go right after the last clip of the last one. A batch of images lands one
 * clip at a time: its clips are kept in the batch as they land and make one step once it's over
 * (`batchRunning` false); any other clip landing meanwhile (a screen take stopped mid-batch) is
 * its own step, taken at once. A batch that landed nothing (its only image failed) makes none.
 */
export function groupAdditions(
  batch: ImageBatch | null,
  added: readonly string[],
  batchRunning: boolean,
): { steps: string[][]; batch: ImageBatch | null; placeAfter: string | null } {
  const ours = new Set(batch?.writing ?? []);
  const others = added.filter((id) => !ours.has(id));
  const landed = [...(batch?.landed ?? []), ...added.filter((id) => ours.has(id))];
  const steps = others.length > 0 ? [others] : [];
  let next: ImageBatch | null = null;
  if (batch && batchRunning) next = { writing: batch.writing, landed };
  else if (landed.length > 0) steps.push(landed);
  const last = steps[steps.length - 1];
  return { steps, batch: next, placeAfter: last ? last[last.length - 1] : null };
}
