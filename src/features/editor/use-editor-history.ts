import { useEffect, useRef, useState } from 'react';

import { dropTakenOut, restoreSegments, takeOutSegments } from '@/db/drafts';
import {
  closeCoalescing,
  emptyHistory,
  record as recordStep,
  type History,
} from '@/features/transcription/edit-history';

import {
  planStep,
  redoAdded,
  snapshotOf,
  takenOut,
  undoAdded,
  type Present,
  type Step,
} from './editor-history';
import type { EditorClip, EditValue } from './use-editor-draft';

/** Files of clips undone out of the draft, once no redo can bring them back. */
function dropAll(steps: readonly Step[]) {
  for (const taken of takenOut(steps)) void dropTakenOut(taken);
}

/**
 * Undo/redo for the editor: per-clip settings, captions, the order, and clips added (the + or a
 * recorder over the editor), over edit-history.ts with the steps and their rules in
 * editor-history.ts. A deleted clip isn't restored (delete has no undo): a step that only touched
 * deleted clips is dropped and the next one tried.
 *
 * Undoing an addition takes its clips out of the draft but keeps their files, so a redo puts them
 * back as they were (labels, edits, captions, transcripts). Their files go once no redo can: the
 * redo stack cleared by a new change, or the editor closing. History lives for the session.
 */
export function useEditorHistory(
  clips: EditorClip[],
  setValue: (id: string, value: EditValue) => void,
  reorder: (ids: string[]) => void,
  captions: ReadonlyMap<string, string | null>,
  setCaptions: (values: ReadonlyMap<string, string | null>) => void,
  captionY: number | null,
  setCaptionY: (y: number | null) => void,
) {
  const [history, setHistoryState] = useState<History<Step>>(emptyHistory);
  // The same history, for the async steps and the unmount (no stale closure).
  const latest = useRef(history);
  const setHistory = (next: History<Step>) => {
    latest.current = next;
    setHistoryState(next);
  };
  // An addition being taken out or put back: other steps wait for it.
  const busy = useRef(false);
  useEffect(() => () => dropAll(latest.current.future), []);

  const present = (): Present => ({ clips, captions, captionY });

  /** A new step: whatever the redo stack held is gone for good. */
  const push = (step: Step, opKey: string | null) => {
    const h = latest.current;
    dropAll(h.future);
    setHistory(recordStep(h, step, opKey, Date.now()));
  };

  const step = (direction: 'undo' | 'redo') => {
    if (busy.current) return;
    const plan = planStep(latest.current, direction, present());
    switch (plan.kind) {
      case 'none':
        setHistory(plan.history);
        return;
      case 'state': {
        const { diff } = plan;
        for (const [id, value] of diff.edits) setValue(id, value);
        if (diff.captions.size) setCaptions(diff.captions);
        if (diff.captionY !== undefined) setCaptionY(diff.captionY);
        if (diff.order) reorder(diff.order);
        setHistory(plan.history);
        return;
      }
      case 'takeOut': {
        setHistory(plan.history);
        busy.current = true;
        void takeOutSegments(plan.ids)
          .then((taken) => {
            const h = latest.current;
            // Nothing came out (gone meanwhile): the step has nothing left to undo.
            if (!taken) {
              if (h.past[h.past.length - 1] === plan.step) {
                setHistory({ ...h, past: h.past.slice(0, -1) });
              }
              return;
            }
            const next = undoAdded(h, plan.step, taken);
            // A change came in meanwhile and cleared the redo stack: the clips stay out.
            if (next) setHistory(next);
            else void dropTakenOut(taken);
          })
          .catch((e: unknown) => console.warn('[editor] undo of an addition failed', e))
          .finally(() => {
            busy.current = false;
          });
        return;
      }
      case 'putBack': {
        setHistory(plan.history);
        busy.current = true;
        void restoreSegments(plan.step.taken)
          .then(() => {
            const next = redoAdded(latest.current, plan.step);
            if (next) setHistory(next);
          })
          .catch((e: unknown) => console.warn('[editor] redo of an addition failed', e))
          .finally(() => {
            busy.current = false;
          });
        return;
      }
    }
  };

  return {
    /** Call before an edit. `opKey` (e.g. `speed:<id>`) merges quick repeats into one step. */
    record: (opKey: string | null) =>
      push({ kind: 'state', snapshot: snapshotOf(present()) }, opKey),
    /** Clips were added to the draft (already in it): one step that takes them all out. */
    recordAdded: (ids: string[]) => {
      if (ids.length) push({ kind: 'added', ids, taken: null }, null);
    },
    /** Ends a merge window (a drag let go). */
    close: () => setHistory(closeCoalescing(latest.current)),
    undo: () => step('undo'),
    redo: () => step('redo'),
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
