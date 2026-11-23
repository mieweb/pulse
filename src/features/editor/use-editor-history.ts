import { useEffect, useState, useSyncExternalStore } from 'react';

import { dropTakenOut, restoreSegments, takeOutSegments } from '@/db/drafts';
import { useToast } from '@/features/toast/toast-provider';
import { dropClipJobs } from '@/features/transcription/clip-queue';
import { userMessage } from '@/utils/user-message';

import { flushDraftWrites } from './draft-writes';
import type { Present, SnapshotDiff } from './editor-history';
import { createEditorHistory } from './editor-history-store';
import type { EditorClip, EditValue } from './use-editor-draft';

/**
 * Undo/redo for the editor: per-clip settings, captions, the order, and clips added (the + or a
 * recorder over the editor). The steps and their rules are editor-history.ts; the store that runs
 * them, the database work of an addition's undo and redo included, is editor-history-store.ts. A
 * deleted clip isn't restored (delete has no undo): a step that only touched deleted clips is
 * dropped and the next one tried.
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
  const { showToast } = useToast();
  const [store] = useState(() =>
    createEditorHistory({
      flush: flushDraftWrites,
      takeOut: (ids) => {
        // Their transcriptions stop, as a deleted clip's do.
        dropClipJobs({ segmentIds: ids });
        return takeOutSegments(ids);
      },
      restore: restoreSegments,
      drop: dropTakenOut,
      failed: (direction, e) =>
        showToast({
          kind: 'error',
          title: direction === 'undo' ? 'Couldn’t undo' : 'Couldn’t redo',
          message: userMessage(e, 'Try again.', `${direction} added clips`),
        }),
    }),
  );
  useEffect(() => {
    store.open();
    return () => store.dispose();
  }, [store]);
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
    record: (opKey: string | null) => store.record(present(), opKey),
    /** Clips were added to the draft (already in it): one step that takes them all out. */
    recordAdded: store.recordAdded,
    /** Ends a merge window (a drag let go). */
    close: store.close,
    undo: () => store.undo(present(), apply),
    redo: () => store.redo(present(), apply),
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
