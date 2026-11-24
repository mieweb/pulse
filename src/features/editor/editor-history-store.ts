import type { TakenOutClips } from '@/db/drafts';
import {
  closeCoalescing,
  emptyHistory,
  record as recordStep,
  type History,
} from '@/features/transcription/edit-history';

import {
  planStep,
  snapshotOf,
  takenOut,
  type AddedStep,
  type Present,
  type SnapshotDiff,
  type Step,
} from './editor-history';

/** What the history does to the draft, so it runs (and is tested) without the database. */
export type HistoryDeps = {
  /** Every edit asked for is stored (draft-writes.ts): an addition's rows are read after them. */
  flush: () => Promise<void>;
  /** Take an addition's clips out (`takeOutSegments`, then their transcription jobs dropped). */
  takeOut: (ids: string[]) => Promise<TakenOutClips | null>;
  /** Put them back (`restoreSegments`). */
  restore: (taken: TakenOutClips) => Promise<void>;
  /** Their files, once nothing can put them back (`dropTakenOut`). */
  drop: (taken: TakenOutClips) => Promise<void>;
  /** An addition's undo or redo failed (the draft locked for upload, a write failing). */
  failed: (direction: 'undo' | 'redo', error: unknown) => void;
};

/**
 * The editor's undo/redo history (the steps and their rules: editor-history.ts) as a store
 * outside React, because undoing or redoing an addition waits on the database. While one runs,
 * its step is on neither stack, so nothing else can move it or drop its files, and other undos
 * and redos wait for it:
 *
 * - Undo of an addition: the queued edits are stored first (an edit to one of its clips lands
 *   before the row is taken out, never on a missing row), then the clips come out and the step
 *   goes onto the redo stack with what a redo needs.
 * - Redo: the same wait, then the clips go back and the step onto the undo stack.
 * - A change recorded meanwhile clears the redo stack as any change does: an undo finishing then
 *   drops what it took out (its files go); a redo finishing, or an undo failing (its clips still
 *   in), puts its step back under that change.
 * - Closed (`dispose`): the redo stack's files go, and those of an undo still running once it
 *   has finished.
 */
export function createEditorHistory(deps: HistoryDeps) {
  let history: History<Step> = emptyHistory<Step>();
  /** Counts recorded changes, so a step finishing knows whether one came in meanwhile. */
  let changes = 0;
  let running: Promise<void> | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();

  const set = (next: History<Step>) => {
    history = next;
    for (const l of listeners) l();
  };
  const dropAll = (steps: readonly Step[]) => {
    for (const taken of takenOut(steps)) void deps.drop(taken);
  };
  /**
   * The undo stack with `step` back under the changes recorded since `below` was its top. Changes
   * only go on top (`record` drops the oldest past 100), so they're the steps above `below`, or
   * all of them once it has been dropped too.
   */
  const putUnderChanges = (step: Step, below: Step | undefined) => {
    const past = [...history.past];
    past.splice(below ? past.lastIndexOf(below) + 1 : 0, 0, step);
    set({ ...history, past });
  };

  const push = (step: Step, opKey: string | null) => {
    if (disposed) return;
    changes++;
    dropAll(history.future);
    set(recordStep(history, step, opKey, Date.now()));
  };

  const takeOut = (h: History<Step>, step: AddedStep, ids: string[]) => {
    // Off the undo stack while it runs.
    set({ ...h, past: h.past.slice(0, -1), lastOp: null });
    const below = h.past[h.past.length - 2];
    const at = changes;
    return (async () => {
      let taken: TakenOutClips | null = null;
      try {
        await deps.flush();
        taken = await deps.takeOut(ids);
      } catch (e) {
        // Nothing came out: the step goes back where it was, under any change recorded meanwhile.
        if (!disposed) putUnderChanges(step, below);
        deps.failed('undo', e);
        return;
      }
      // Nothing left to take out (gone meanwhile): the step is done with.
      if (!taken) return;
      if (disposed || changes !== at) {
        void deps.drop(taken);
        return;
      }
      set({ ...history, future: [...history.future, { ...step, taken }] });
    })();
  };

  const putBack = (h: History<Step>, step: AddedStep & { taken: TakenOutClips }) => {
    // Off the redo stack while it runs, so no change or close drops its files meanwhile.
    set({ ...h, future: h.future.slice(0, -1), lastOp: null });
    const below = h.past[h.past.length - 1];
    const at = changes;
    return (async () => {
      try {
        await deps.flush();
        await deps.restore(step.taken);
      } catch (e) {
        // Not back: still redoable, unless a change came in (then its files go).
        if (!disposed && changes === at) {
          set({ ...history, future: [...history.future, step] });
        } else {
          void deps.drop(step.taken);
        }
        deps.failed('redo', e);
        return;
      }
      if (disposed) return;
      // Back in the draft: its undo step, under any change recorded meanwhile.
      putUnderChanges({ kind: 'added', ids: step.ids, taken: null }, below);
    })();
  };

  const step = (
    direction: 'undo' | 'redo',
    now: Present,
    apply: (diff: SnapshotDiff) => void,
  ): void => {
    if (running || disposed) return;
    const plan = planStep(history, direction, now);
    switch (plan.kind) {
      case 'none':
        set(plan.history);
        return;
      case 'state':
        apply(plan.diff);
        set(plan.history);
        return;
      case 'takeOut':
      case 'putBack': {
        const run =
          plan.kind === 'takeOut'
            ? takeOut(plan.history, plan.step, plan.ids)
            : putBack(plan.history, plan.step);
        running = run.finally(() => {
          running = null;
        });
        return;
      }
    }
  };

  return {
    getState: () => history,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** A change is about to be made: `before` is the draft as it is. */
    record: (before: Present, opKey: string | null) =>
      push({ kind: 'state', snapshot: snapshotOf(before) }, opKey),
    /** Clips were added to the draft (already in it): one step that takes them all out. */
    recordAdded: (ids: string[]) => {
      if (ids.length) push({ kind: 'added', ids, taken: null }, null);
    },
    close: () => set(closeCoalescing(history)),
    undo: (now: Present, apply: (diff: SnapshotDiff) => void) => step('undo', now, apply),
    redo: (now: Present, apply: (diff: SnapshotDiff) => void) => step('redo', now, apply),
    /** The undo or redo of an addition still running, if any (for tests). */
    settled: () => running ?? Promise.resolve(),
    /** The editor is open (again: React may close and reopen an effect in development). */
    open() {
      disposed = false;
    },
    /** The editor closed: nothing can be redone, so the clips undone out lose their files. */
    dispose() {
      if (disposed) return;
      disposed = true;
      dropAll(history.future);
      set({ ...history, future: [] });
    },
  };
}

export type EditorHistoryStore = ReturnType<typeof createEditorHistory>;
