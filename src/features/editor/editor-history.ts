import type { TakenOutClips } from '@/db/drafts';
import {
  redo as redoStep,
  undo as undoStep,
  type History,
} from '@/features/transcription/edit-history';

import type { EditValue } from './draft-writes';

/**
 * The editor's undo steps, as pure data and rules (use-editor-history.ts runs them). A `state`
 * step is the draft's order, every clip's stored edit and edited captions, and where the captions
 * sit, from before a change: undoing writes back what differs. An `added` step is clips added to
 * the draft (from the + or a recorder over the editor): undoing takes them out, keeping what a
 * redo needs to put them back (`taken`, set while the step waits on the redo stack).
 */
export type Snapshot = {
  order: string[];
  edits: Record<string, EditValue>;
  captions: Record<string, string | null>;
  captionY: number | null;
};

export type AddedStep = { kind: 'added'; ids: string[]; taken: TakenOutClips | null };

export type Step = { kind: 'state'; snapshot: Snapshot } | AddedStep;

/** What the clips are now, as far as a step can change them. */
export type Present = {
  clips: readonly { id: string; editKey: string | null }[];
  captions: ReadonlyMap<string, string | null>;
  captionY: number | null;
};

/** The writes that bring the draft back to a snapshot; empty when it already matches. */
export type SnapshotDiff = {
  edits: [string, EditValue][];
  captions: Map<string, string | null>;
  /** Undefined: leave where the captions sit. */
  captionY?: number | null;
  /** The full order to store, or null when it stays. */
  order: string[] | null;
};

export function snapshotOf(now: Present): Snapshot {
  return {
    order: now.clips.map((c) => c.id),
    edits: Object.fromEntries(now.clips.map((c) => [c.id, c.editKey])),
    captions: Object.fromEntries(now.clips.map((c) => [c.id, now.captions.get(c.id) ?? null])),
    captionY: now.captionY,
  };
}

/**
 * The order `target` had, among the clips still here, with the clips it doesn't name (added after
 * it was taken) kept beside their neighbours: each stays right after the clip it follows now, or
 * at the front when it leads. So undoing a reorder made before an insert never moves the inserted
 * clips to the end.
 */
export function restoreOrder(current: readonly string[], target: readonly string[]): string[] {
  const here = new Set(current);
  const named = new Set(target.filter((id) => here.has(id)));
  const out = target.filter((id) => here.has(id));
  // In the current order, so the clip each one follows is already placed.
  current.forEach((id, i) => {
    if (named.has(id)) return;
    if (i === 0) out.unshift(id);
    else out.splice(out.indexOf(current[i - 1]) + 1, 0, id);
  });
  return out;
}

/** What writing `target` back would change (a deleted clip's entries are skipped). */
export function diffSnapshot(target: Snapshot, now: Present): SnapshotDiff {
  const edits: [string, EditValue][] = [];
  for (const c of now.clips) {
    if (!(c.id in target.edits) || target.edits[c.id] === c.editKey) continue;
    edits.push([c.id, target.edits[c.id]]);
  }
  const captions = new Map<string, string | null>();
  for (const c of now.clips) {
    const value = target.captions?.[c.id];
    if (value === undefined || value === (now.captions.get(c.id) ?? null)) continue;
    captions.set(c.id, value);
  }
  // A step from before the captions' place was recorded has none.
  const captionY =
    target.captionY !== undefined && target.captionY !== now.captionY ? target.captionY : undefined;
  const ids = now.clips.map((c) => c.id);
  const restored = restoreOrder(ids, target.order);
  const order = restored.join() === ids.join() ? null : restored;
  return { edits, captions, captionY, order };
}

const isEmpty = (d: SnapshotDiff) =>
  d.edits.length === 0 && d.captions.size === 0 && d.captionY === undefined && d.order === null;

/**
 * The next undo or redo to carry out, skipping (and dropping) steps that would change nothing: a
 * state step that only touched deleted clips, or an addition whose clips have all gone. An
 * addition that would leave the draft with no clips is dropped too (the editor closes on an empty
 * draft). `history` is the history once the step is done, except for an addition: its undo takes
 * the clips out first, so the hook moves the step itself (`undoAdded` / `redoAdded`), and
 * `history` is the one to move it from.
 */
export type Plan =
  | { kind: 'none'; history: History<Step> }
  | { kind: 'state'; history: History<Step>; diff: SnapshotDiff }
  | { kind: 'takeOut'; history: History<Step>; step: AddedStep; ids: string[] }
  | { kind: 'putBack'; history: History<Step>; step: AddedStep & { taken: TakenOutClips } };

export function planStep(h: History<Step>, direction: 'undo' | 'redo', now: Present): Plan {
  const current: Step = { kind: 'state', snapshot: snapshotOf(now) };
  const ids = now.clips.map((c) => c.id);
  while (true) {
    const stack = direction === 'undo' ? h.past : h.future;
    const top = stack[stack.length - 1];
    if (!top) return { kind: 'none', history: h };
    if (top.kind === 'added') {
      if (direction === 'undo') {
        const live = top.ids.filter((id) => ids.includes(id));
        if (live.length > 0 && live.length < ids.length) {
          return { kind: 'takeOut', history: h, step: top, ids: live };
        }
      } else if (top.taken) {
        return { kind: 'putBack', history: h, step: top as AddedStep & { taken: TakenOutClips } };
      }
    } else {
      const diff = diffSnapshot(top.snapshot, now);
      if (!isEmpty(diff)) {
        const r = direction === 'undo' ? undoStep(h, current) : redoStep(h, current);
        return { kind: 'state', history: r!.history, diff };
      }
    }
    // Nothing left to change in that step: drop it, keep the other stack as it was.
    h =
      direction === 'undo'
        ? { ...h, past: h.past.slice(0, -1) }
        : { ...h, future: h.future.slice(0, -1) };
  }
}

/**
 * An addition undone: the step goes onto the redo stack with what was taken out. Null when the
 * step is no longer the top of the undo stack (a change came in meanwhile): it can't be redone.
 */
export function undoAdded(
  h: History<Step>,
  step: AddedStep,
  taken: TakenOutClips,
): History<Step> | null {
  if (h.past[h.past.length - 1] !== step) return null;
  return undoStep(h, { ...step, taken })!.history;
}

/** An addition redone: the step goes back onto the undo stack, its clips in the draft again. */
export function redoAdded(h: History<Step>, step: AddedStep): History<Step> | null {
  if (h.future[h.future.length - 1] !== step) return null;
  return redoStep(h, { ...step, taken: null })!.history;
}

/** The clips taken out by additions on the redo stack: their files go when it's cleared. */
export function takenOut(steps: readonly Step[]): TakenOutClips[] {
  return steps.flatMap((s) => (s.kind === 'added' && s.taken ? [s.taken] : []));
}
