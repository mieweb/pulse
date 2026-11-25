import type { MenuAction } from '@/components/action-menu';
import {
  anchorForExactPlayhead,
  anchorForPlayhead,
  type ClipAnchor,
  timeAtAnchor,
} from '@/core/clip-anchor';
import type { EditorView } from '@/db/settings';
import {
  importImagesAction,
  importVideoAction,
  fromAnotherPulseAction,
  recordScreenAction,
} from '@/features/recorder/add-menu-actions';

// The editor's "+" (#308) as pure logic: its items, and how the clips that land become undo
// steps. use-editor-additions.ts runs them.

/** Beat view keeps each beat whole; the timeline permits an exact metadata split. */
export function editorAddAnchor(
  view: EditorView,
  clips: Parameters<typeof anchorForExactPlayhead>[0],
  layout: { starts: readonly number[]; totalMs: number },
  timeMs: number,
  freshId: () => string,
): ClipAnchor {
  return view === 'clips'
    ? anchorForPlayhead(
        clips.map((clip) => clip.id),
        layout.starts,
        layout.totalMs,
        timeMs,
      )
    : anchorForExactPlayhead(clips, layout.starts, layout.totalMs, timeMs, freshId);
}

/**
 * The "+" items. Each adds at its anchor, read once, as the item is picked (the
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
  /** Copies of another draft's clips, with their edits and captions. */
  fromAnotherPulse?: (anchor: ClipAnchor) => void;
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
    ...(fromAnotherPulse ? [fromAnotherPulseAction(at(fromAnotherPulse))] : []),
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

/**
 * Where the playhead goes as the editor takes the clips added (`groupAdditions`): right after the
 * last one (`after`), unless a recorder over the editor came back to it on its Edit (`returnTo`, see
 * `returnEditorTo`): then where that recorder's insert cursor was, or the clip tapped there.
 */
export type PlayheadGoal = { after: string } | { at: ClipAnchor };

export function playheadGoal(
  returnTo: ClipAnchor | null,
  placeAfter: string | null,
): PlayheadGoal | null {
  if (returnTo) return { at: returnTo };
  return placeAfter ? { after: placeAfter } : null;
}

/**
 * The goal's time on the timeline (`ids`, `starts`, `totalMs` as the editor lays the clips out):
 * the start of the clip after `after` (or the end), or the anchor's boundary (`timeAtAnchor`).
 * Null while `after` isn't among the clips yet (the list a beat behind the insert).
 */
export function playheadGoalMs(
  goal: PlayheadGoal,
  ids: readonly string[],
  starts: readonly number[],
  totalMs: number,
): number | null {
  if ('at' in goal) return timeAtAnchor(goal.at, ids, starts, totalMs);
  const i = ids.indexOf(goal.after);
  if (i < 0) return null;
  return i + 1 < starts.length ? starts[i + 1] : totalMs;
}
