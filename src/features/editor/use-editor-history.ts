import { useState } from 'react';

import {
  closeCoalescing,
  emptyHistory,
  record as recordStep,
  redo as redoStep,
  undo as undoStep,
  type History,
} from '@/features/transcription/edit-history';

import type { EditorClip, EditValue } from './use-editor-draft';

/** The clips' order, every clip's stored edit and edited captions, by id: one undo step
 * (strings, so cheap). */
type Snapshot = {
  order: string[];
  edits: Record<string, EditValue>;
  captions: Record<string, string | null>;
};

/**
 * Undo/redo for the editor's per-clip settings and captions, over edit-history.ts. A step is
 * the draft's order and edits before a change; undoing writes back only what differs. A
 * deleted clip isn't restored (delete has no undo): its entries are skipped, and a step that
 * only touched deleted clips is dropped and the next one tried. History lives for the session.
 */
export function useEditorHistory(
  clips: EditorClip[],
  setValue: (id: string, value: EditValue) => void,
  reorder: (ids: string[]) => void,
  captions: ReadonlyMap<string, string | null>,
  setCaptions: (values: ReadonlyMap<string, string | null>) => void,
) {
  const [history, setHistory] = useState<History<Snapshot>>(emptyHistory);

  const snapshot = (): Snapshot => ({
    order: clips.map((c) => c.id),
    edits: Object.fromEntries(clips.map((c) => [c.id, c.editKey])),
    captions: Object.fromEntries(clips.map((c) => [c.id, captions.get(c.id) ?? null])),
  });

  /** Writes `target` where it differs from now; false when nothing did (a no-op step). */
  const apply = (target: Snapshot) => {
    let changed = false;
    for (const c of clips) {
      if (!(c.id in target.edits) || target.edits[c.id] === c.editKey) continue;
      setValue(c.id, target.edits[c.id]);
      changed = true;
    }
    const captionsBack = new Map<string, string | null>();
    for (const c of clips) {
      const value = target.captions?.[c.id];
      if (value === undefined || value === (captions.get(c.id) ?? null)) continue;
      captionsBack.set(c.id, value);
    }
    if (captionsBack.size) {
      setCaptions(captionsBack);
      changed = true;
    }
    // The order, among the clips still here.
    const ids = clips.map((c) => c.id);
    const order = target.order.filter((id) => ids.includes(id));
    const rest = ids.filter((id) => !order.includes(id));
    if (order.join() !== ids.filter((id) => order.includes(id)).join()) {
      reorder([...order, ...rest]);
      changed = true;
    }
    return changed;
  };

  const step = (direction: 'undo' | 'redo') => {
    let h = history;
    const now = snapshot();
    while (true) {
      const r = direction === 'undo' ? undoStep(h, now) : redoStep(h, now);
      if (!r) {
        setHistory(h);
        return;
      }
      if (apply(r.value)) {
        setHistory(r.history);
        return;
      }
      // Nothing left to change in that step: drop it, keep the other stack as it was.
      h =
        direction === 'undo' ? { ...r.history, future: h.future } : { ...r.history, past: h.past };
    }
  };

  return {
    /** Call before an edit. `opKey` (e.g. `speed:<id>`) merges quick repeats into one step. */
    record: (opKey: string | null) =>
      setHistory((h) => recordStep(h, snapshot(), opKey, Date.now())),
    /** Ends a merge window (a drag let go). */
    close: () => setHistory(closeCoalescing),
    undo: () => step('undo'),
    redo: () => step('redo'),
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
