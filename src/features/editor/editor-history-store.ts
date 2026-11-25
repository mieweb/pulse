import type { SplitReceipt, TakenOutClips } from '@/db/drafts';
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
  hasRestorableClips,
  type AddedStep,
  type Present,
  type SnapshotDiff,
  type Step,
} from './editor-history';

/** What the history does to the draft, so it runs (and is tested) without the database. */
export type HistoryDeps = {
  initial?: History<Step>;
  /** Durable sessions retain redo when React closes; completed operations still checkpoint. */
  retainOnClose?: boolean;
  /** Save the resulting stacks in the same transaction as moving addition rows. */
  takeOutAndCheckpoint?: (
    ids: string[],
    splits: readonly SplitReceipt[],
    next: (taken: TakenOutClips | null) => History<Step>,
  ) => Promise<TakenOutClips | null>;
  restoreAndCheckpoint?: (taken: TakenOutClips, next: () => History<Step>) => Promise<void>;
  /** Every edit asked for is stored (draft-writes.ts): an addition's rows are read after them. */
  flush: () => Promise<void>;
  /** Take an addition's clips out (`takeOutSegments`, then their transcription jobs dropped). */
  takeOut: (ids: string[], splits?: readonly SplitReceipt[]) => Promise<TakenOutClips | null>;
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
 * - Closed (`dispose`): durable sessions retain both stacks and finish pending operations.
 *   Session-only callers discard redo files once pending operations finish.
 */
export function createEditorHistory(deps: HistoryDeps) {
  let history: History<Step> = deps.initial ?? emptyHistory<Step>();
  /** Counts recorded changes, so a step finishing knows whether one came in meanwhile. */
  let changes = 0;
  let running: Promise<void> | null = null;
  let pendingAddition = false;
  const openBatches = new Set<string>();
  let snapshot = {
    ...history,
    keepEmptyOpen: hasRestorableClips(history),
    batchOpen: false,
    busy: false,
  };
  let disposed = false;
  const discarded = () => disposed && !deps.retainOnClose;
  const listeners = new Set<() => void>();

  const set = (next: History<Step>) => {
    history = next;
    snapshot = {
      ...history,
      keepEmptyOpen: pendingAddition || openBatches.size > 0 || hasRestorableClips(history),
      batchOpen: openBatches.size > 0,
      busy: pendingAddition,
    };
    for (const l of listeners) l();
  };
  const dropAll = (steps: readonly Step[]) => {
    for (const taken of takenOut(steps)) void deps.drop(taken);
    dropOriginals(steps);
  };
  const dropOriginals = (steps: readonly Step[]) => {
    const originals = new Set(
      steps.flatMap((step) =>
        step.kind === 'added' ? (step.splits ?? []).map((s) => s.before) : [],
      ),
    );
    for (const before of originals) void deps.drop(before);
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

  // A slow import can span more than 100 edits. Keep its step until it closes so a later
  // committed image cannot accidentally create a new step above those intervening edits.
  const keepOpenBatches = (past: readonly Step[], retained: readonly Step[]) => [
    ...past.filter(
      (s) =>
        s.kind === 'added' && s.batchKey && openBatches.has(s.batchKey) && !retained.includes(s),
    ),
    ...retained,
  ];

  const push = (step: Step, opKey: string | null) => {
    if (discarded()) return;
    changes++;
    dropAll(history.future);
    const recorded = recordStep(history, step, opKey, Date.now());
    const next = { ...recorded, past: keepOpenBatches(history.past, recorded.past) };
    dropOriginals(history.past.filter((s) => !next.past.includes(s)));
    set(next);
  };

  const takeOut = (
    h: History<Step>,
    step: AddedStep,
    ids: string[],
    nextUndo: () => Promise<void> | null,
  ) => {
    // Off the undo stack while it runs.
    set({ ...h, past: h.past.slice(0, -1), lastOp: null });
    const below = h.past[h.past.length - 2];
    const at = changes;
    return (async () => {
      let taken: TakenOutClips | null = null;
      try {
        await deps.flush();
        taken = deps.takeOutAndCheckpoint
          ? await deps.takeOutAndCheckpoint(ids, step.splits ?? [], (value) =>
              value && !discarded() && changes === at
                ? { ...history, future: [...history.future, { ...step, taken: value }] }
                : history,
            )
          : step.splits?.length
            ? await deps.takeOut(ids, step.splits)
            : await deps.takeOut(ids);
      } catch (e) {
        // Nothing came out: the step goes back where it was, under any change recorded meanwhile.
        if (!discarded()) putUnderChanges(step, below);
        else dropOriginals([step]);
        deps.failed('undo', e);
        return;
      }
      // Nothing left to take out (gone meanwhile): the step is done with.
      if (!taken) {
        dropOriginals([step]);
        // Only storage can confirm that an addition disappeared. Skip it on this Undo tap,
        // unless a newer change or an open image batch has superseded the request.
        if (!discarded() && changes === at && openBatches.size === 0) await nextUndo();
        return;
      }
      if (discarded() || changes !== at) {
        void deps.drop(taken);
        dropOriginals([step]);
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
        if (deps.restoreAndCheckpoint) {
          await deps.restoreAndCheckpoint(step.taken, () => {
            const past = [...history.past];
            past.splice(below ? past.lastIndexOf(below) + 1 : 0, 0, { ...step, taken: null });
            return { ...history, past };
          });
        } else await deps.restore(step.taken);
      } catch (e) {
        // Not back: still redoable, unless a change came in (then its files go).
        if (!discarded() && changes === at) {
          set({ ...history, future: [...history.future, step] });
        } else {
          void deps.drop(step.taken);
          dropOriginals([step]);
        }
        deps.failed('redo', e);
        return;
      }
      if (discarded()) {
        dropOriginals([step]);
        return;
      }
      // Back in the draft: its undo step, under any change recorded meanwhile.
      putUnderChanges({ ...step, taken: null }, below);
    })();
  };

  const runStep = (
    direction: 'undo' | 'redo',
    now: Present,
    apply: (diff: SnapshotDiff) => void,
  ): Promise<void> | null => {
    const plan = planStep(history, direction, now);
    const retained = new Set([...plan.history.past, ...plan.history.future]);
    dropOriginals([...history.past, ...history.future].filter((s) => !retained.has(s)));
    switch (plan.kind) {
      case 'none':
        set(plan.history);
        return null;
      case 'state':
        apply(plan.diff);
        set(plan.history);
        return null;
      case 'takeOut':
      case 'putBack': {
        // Set before either operation publishes an empty stack or the database removes rows.
        pendingAddition = true;
        return plan.kind === 'takeOut'
          ? takeOut(plan.history, plan.step, plan.ids, () => runStep(direction, now, apply))
          : putBack(plan.history, plan.step);
      }
    }
  };

  const step = (direction: 'undo' | 'redo', now: Present, apply: (diff: SnapshotDiff) => void) => {
    if (running || pendingAddition || disposed || openBatches.size > 0) return;
    const run = runStep(direction, now, apply);
    if (run) {
      running = run.finally(() => {
        running = null;
        pendingAddition = false;
        set(history);
      });
    }
  };

  return {
    getState: () => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** A change is about to be made: `before` is the draft as it is. */
    record: (before: Present, opKey: string | null) =>
      push({ kind: 'state', snapshot: snapshotOf(before) }, opKey),
    /** Added clips and/or a standalone split committed: one step reverses the whole operation. */
    recordAdded: (ids: string[], splits: readonly SplitReceipt[] = [], batchKey?: string) => {
      if (!ids.length && !splits.length) return;
      const step: AddedStep = {
        kind: 'added',
        ids,
        taken: null,
        ...(splits.length ? { splits } : {}),
        ...(batchKey ? { batchKey } : {}),
      };
      if (discarded()) {
        dropOriginals([step]);
        return;
      }
      // The row transaction already recorded this addition. The UI journal still groups a
      // recorder's committed clips and places the playhead, but must not create another step.
      const idsWanted = new Set(ids);
      const splitWanted = new Set(splits.map((split) => split.rightId));
      const matching = history.past.filter(
        (candidate): candidate is AddedStep =>
          candidate.kind === 'added' &&
          ((batchKey !== undefined && candidate.batchKey === batchKey) ||
            candidate.ids.some((id) => idsWanted.has(id)) ||
            (candidate.splits ?? []).some((split) => splitWanted.has(split.rightId))),
      );
      const knownIds = new Set(matching.flatMap((candidate) => candidate.ids));
      const knownSplits = new Set(
        matching.flatMap((candidate) => (candidate.splits ?? []).map((split) => split.rightId)),
      );
      const undone = history.future.filter(
        (candidate): candidate is AddedStep => candidate.kind === 'added',
      );
      const undoneIds = new Set(undone.flatMap((candidate) => candidate.ids));
      const undoneSplits = new Set(
        undone.flatMap((candidate) => (candidate.splits ?? []).map((split) => split.rightId)),
      );
      // A delayed journal delivery can follow an Undo of the already committed addition.
      // It must not turn that old event into a new edit that clears the retained Redo.
      if (
        (ids.some((id) => undoneIds.has(id)) ||
          splits.some((split) => undoneSplits.has(split.rightId))) &&
        ids.every((id) => knownIds.has(id) || undoneIds.has(id)) &&
        splits.every((split) => knownSplits.has(split.rightId) || undoneSplits.has(split.rightId))
      )
        return;
      if (batchKey) openBatches.add(batchKey);
      if (
        matching.length &&
        ids.every((id) => knownIds.has(id)) &&
        splits.every((split) => knownSplits.has(split.rightId))
      ) {
        if (matching.length === 1 && (!batchKey || matching[0].batchKey === batchKey)) return;
        const first = matching[0];
        const allSplits = [
          ...new Map(
            matching.flatMap((candidate) =>
              (candidate.splits ?? []).map((split) => [split.rightId, split] as const),
            ),
          ).values(),
        ];
        const grouped: AddedStep = {
          ...first,
          ids: [...knownIds],
          ...(allSplits.length ? { splits: allSplits } : {}),
          ...(batchKey ? { batchKey } : {}),
        };
        const combined = new Set(matching);
        changes++;
        set({
          ...history,
          past: history.past.flatMap((candidate) =>
            candidate === first
              ? [grouped]
              : combined.has(candidate as AddedStep)
                ? []
                : [candidate],
          ),
          lastOp: null,
        });
        return;
      }
      if (batchKey) {
        const existing = history.past.find(
          (s): s is AddedStep => s.kind === 'added' && s.batchKey === batchKey,
        );
        if (existing) {
          changes++;
          dropAll(history.future);
          // Preserve the step's identity and position, including async operations' `below`
          // references. Publishing a new store snapshot still notifies React subscribers.
          existing.ids = [...new Set([...existing.ids, ...ids])];
          if (splits.length) existing.splits = [...(existing.splits ?? []), ...splits];
          set({ ...history, future: [], lastOp: null });
          return;
        }
      }
      push(step, null);
    },
    /** Lock history while a batch prepares; its first commit, not the picker, creates a step. */
    beginBatch: (key: string): Promise<void> => {
      if (disposed) return Promise.resolve();
      openBatches.add(key);
      set({ ...history, lastOp: null });
      return running ?? Promise.resolve();
    },
    endBatch: (key: string) => {
      if (!openBatches.delete(key)) return;
      const past = keepOpenBatches(history.past, history.past.slice(-100));
      dropOriginals(history.past.filter((s) => !past.includes(s)));
      set({ ...history, past, lastOp: null });
    },
    close: () => set(closeCoalescing(history)),
    undo: (now: Present, apply: (diff: SnapshotDiff) => void) => step('undo', now, apply),
    redo: (now: Present, apply: (diff: SnapshotDiff) => void) => step('redo', now, apply),
    /** The undo or redo of an addition still running, if any (for tests). */
    settled: () => running ?? Promise.resolve(),
    /** Adopt stacks whose addition and rows just committed atomically, before UI journal drain. */
    acceptAddition(next: { past: Step[]; future: Step[] }) {
      changes++;
      const past = keepOpenBatches(next.past, next.past.slice(-100));
      const retained = new Set([...past, ...next.future]);
      dropAll([...history.past, ...history.future].filter((candidate) => !retained.has(candidate)));
      set({ past, future: next.future, lastOp: null });
    },
    /** Apply storage retention, after its replacement checkpoint has committed. */
    retain(next: History<Step>) {
      const kept = new Set([...next.past, ...next.future]);
      dropAll([...history.past, ...history.future].filter((s) => !kept.has(s)));
      set(next);
    },
    /** A failed queued edit cannot bind the optimistic stacks to different stored values. */
    reset() {
      dropAll([...history.past, ...history.future]);
      changes++;
      set(emptyHistory<Step>());
    },
    /** The editor is open (again: React may close and reopen an effect in development). */
    open() {
      disposed = false;
    },
    /** The editor closed; durable sessions retain their stacks and any pending batch. */
    dispose() {
      if (disposed) return;
      disposed = true;
      if (deps.retainOnClose) {
        set(closeCoalescing(history));
        return;
      }
      openBatches.clear();
      dropAll(history.future);
      dropOriginals(history.past);
      set({ ...history, future: [] });
    },
  };
}

export type EditorHistoryStore = ReturnType<typeof createEditorHistory>;
