import { useEffect, useState, useSyncExternalStore } from 'react';

import { editorUndoSession } from '@/features/editor/persistent-editor-history';
import { useToast } from '@/features/toast/toast-provider';
import { userMessage } from '@/utils/user-message';

import type { Present, SnapshotDiff } from './editor-history';
import type { EditorClip, EditValue } from './use-editor-draft';

/**
 * Undo/redo for the editor: per-clip settings, captions, the order, and clips added (the + or a
 * recorder over the editor). The steps and their rules are editor-history.ts; the store that runs
 * them, the database work of an addition's undo and redo included, is editor-history-store.ts. A
 * deleted clip isn't restored (delete has no undo): a step that only touched deleted clips is
 * dropped and the next one tried.
 *
 * Undoing an addition takes its clips out of the draft but keeps their files, so a redo puts them
 * back as they were (labels, edits, captions, transcripts). A versioned checkpoint retains both
 * stacks across closing and restart; files are reclaimed after durable invalidation or eviction.
 */
export function useEditorHistory(
  draftId: string,
  ready: boolean,
  clips: EditorClip[],
  setValue: (id: string, value: EditValue) => void,
  reorder: (ids: string[]) => void,
  captions: ReadonlyMap<string, string | null>,
  setCaptions: (values: ReadonlyMap<string, string | null>) => void,
  captionY: number | null,
  setCaptionY: (y: number | null) => void,
) {
  const { showToast } = useToast();
  const [session] = useState(() => editorUndoSession(draftId));
  const store = session.store;
  useEffect(() => {
    return session.open((direction, e) =>
      showToast({
        kind: 'error',
        title:
          direction === 'undo'
            ? 'Couldn’t undo'
            : direction === 'redo'
              ? 'Couldn’t redo'
              : 'Couldn’t save Undo',
        message: userMessage(e, 'Try again.', `${direction} undo history`),
      }),
    );
  }, [session, showToast]);
  // Deletion has no Undo step, but changes the state the existing stacks are saved against.
  useEffect(() => {
    session.changed();
  }, [session, clips, captions, captionY]);
  const history = useSyncExternalStore(store.subscribe, store.getState);

  const present = (): Present => ({ clips, captions, captionY });
  const apply = (diff: SnapshotDiff) => {
    for (const [id, value] of diff.edits) setValue(id, value);
    if (diff.captions.size) setCaptions(diff.captions);
    if (diff.captionY !== undefined) setCaptionY(diff.captionY);
    if (diff.order) reorder(diff.order);
  };

  return {
    /** Call before an edit. `opKey` (e.g. `speed:<id>`) merges quick repeats into one step. */
    record: (opKey: string | null) => {
      if (ready) store.record(present(), opKey);
    },
    /** Clips were added to the draft (already in it): one step that takes them all out. */
    recordAdded: store.recordAdded,
    beginBatch: store.beginBatch,
    endBatch: store.endBatch,
    /** Ends a merge window (a drag let go). */
    close: store.close,
    undo: () => {
      if (ready) store.undo(present(), apply);
    },
    redo: () => {
      if (ready) store.redo(present(), apply);
    },
    canUndo: ready && history.past.length > 0 && !history.batchOpen && !history.busy,
    canRedo: ready && history.future.length > 0 && !history.batchOpen && !history.busy,
    busy: history.busy,
    /** An addition is moving through the database or its clips are retained for redo. */
    keepEmptyOpen: history.keepEmptyOpen,
  };
}
