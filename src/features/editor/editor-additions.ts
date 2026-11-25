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
export type ImageBatch = { key: string; writing: readonly string[]; landed: readonly string[] };

/** A clip of the batch is about to be written: from then on it's told apart from other adds. */
export function batchWriting(batch: ImageBatch, id: string): ImageBatch {
  return { ...batch, writing: [...batch.writing, id] };
}

export type AddedGroup = { ids: string[]; batchKey?: string };

/**
 * Clips added to the draft while the editor is open (`added`, in the order they landed), from its
 * "+" or a recorder over it, as undo steps: each addition is one step, in the order they're taken,
 * with the playhead to go right after the last clip of the last one. A batch lands one image at
 * a time. Its first committed clip registers the batch's history step immediately;
 * later clips extend that same step, beneath any intervening edit. Other additions remain their
 * own steps. A batch that landed nothing (its only image failed) makes none.
 */
export function groupAdditions(
  batch: ImageBatch | null,
  added: readonly string[],
  batchRunning: boolean,
): { steps: AddedGroup[]; batch: ImageBatch | null; placeAfter: string | null } {
  const ours = new Set(batch?.writing ?? []);
  const landed = [...(batch?.landed ?? [])];
  const seen = new Set(landed);
  const steps: AddedGroup[] = [];
  let otherLast: string | null = null;
  for (const id of added) {
    const own = ours.has(id);
    if (own && seen.has(id)) continue;
    if (own) {
      landed.push(id);
      seen.add(id);
    } else otherLast = id;
    const batchKey = own ? batch?.key : undefined;
    const last = steps[steps.length - 1];
    if (last && last.batchKey === batchKey) last.ids.push(id);
    else steps.push({ ids: [id], ...(batchKey === undefined ? {} : { batchKey }) });
  }
  return {
    steps,
    batch: batch && batchRunning ? { ...batch, landed } : null,
    // Register history as each image commits, but move the playhead only when its batch ends.
    placeAfter: !batchRunning && landed.length ? landed[landed.length - 1] : otherLast,
  };
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
