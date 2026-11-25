import { eq } from 'drizzle-orm';
import { File } from 'expo-file-system';

import { registerUndoWriter } from '@/core/undo-write-barrier';
import {
  draftWriteFailureVersion,
  flushDraftWrites,
  hasPendingDraftWrites,
} from '@/features/editor/draft-writes';
import {
  createEditorHistory,
  type EditorHistoryStore,
} from '@/features/editor/editor-history-store';
import type { Step } from '@/features/editor/editor-history';
import { emptyHistory, type History } from '@/features/transcription/edit-history';
import {
  historyMediaPaths,
  parsePersistedHistory,
  trimPersistedHistory,
  type PersistedHistory,
} from '@/db/persisted-history';
import { absolutize } from '@/utils/file-store';
import { dropClipJobs } from '@/features/transcription/clip-queue';

import { db, expoDb } from '@/db/client';
import {
  dropHistoryFiles,
  dropTakenOut,
  releaseHistoryHold,
  restoreSegments,
  takeOutSegments,
  type TakenOutClips,
} from '@/db/drafts';
import { drafts } from '@/db/schema';
import { liveDraftMediaPaths } from '@/db/media-refs';
import { historyCheckpoint } from '@/db/undo-history';
import { noteHeldFiles } from '@/db/held-files';

type Failure = (direction: 'undo' | 'redo' | 'save', error: unknown) => void;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const sessions = new Map<string, ReturnType<typeof createSession>>();
const sizeOf = (path: string) => {
  const file = new File(absolutize(path));
  return file.exists ? file.size : null;
};

function read(draftId: string): PersistedHistory | null {
  const row = db
    .select({ value: drafts.undoHistory })
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .get();
  return parsePersistedHistory(row?.value, draftId);
}

/** Used before automatic empty-draft cleanup; explicitly deleting a draft still deletes it. */
export function hasRetainedUndo(draftId: string): boolean {
  const active = sessions.get(draftId)?.store.getState();
  if (active?.keepEmptyOpen) return true;
  try {
    return read(draftId)?.future.some((step) => step.kind === 'added' && step.taken) ?? false;
  } catch {
    return true; // unreadable saved state is a recovery input, not permission to delete a draft
  }
}

function livePaths(draftId: string): Set<string> {
  return liveDraftMediaPaths(expoDb, draftId);
}

function createSession(draftId: string) {
  let saved: PersistedHistory | null = null;
  try {
    saved = read(draftId);
  } catch (e) {
    console.warn('[undo] invalid saved checkpoint', e);
  }
  const initial =
    saved?.checkpoint === historyCheckpoint(expoDb, draftId)
      ? trimPersistedHistory(saved, sizeOf, livePaths(draftId))
      : null;
  let previousPaths = saved ? historyMediaPaths(saved) : new Set<string>();
  const drops = new Set<TakenOutClips>();
  const failures = new Set<Failure>();
  let failureVersion = draftWriteFailureVersion();
  let revision = 0;
  let written = -1;
  let work: Promise<void> | null = null;
  let retaining = false;
  let readers = 0;
  let closing = false;
  const report: Failure = (direction, error) => {
    if (!failures.size) console.warn(`[undo] ${direction} failed`, error);
    for (const listener of failures) listener(direction, error);
  };

  /** Synchronous: can also run inside the addition's row transaction; a failure rolls it back. */
  const replaceCheckpoint = (tx: Tx, next: PersistedHistory | null) => {
    let before: PersistedHistory | null = null;
    try {
      before = read(draftId);
    } catch {
      /* Unknown recovery data never authorizes deletion. */
    }
    const retained = next ? historyMediaPaths(next) : new Set<string>();
    const removed = before
      ? [...historyMediaPaths(before)].filter((path) => !retained.has(path))
      : [];
    // A launch may already have cleared the original take-out's cleanup journal. Re-note evicted
    // files atomically, so a kill after this commit and before deletion is reclaimed next launch.
    if (removed.length) noteHeldFiles(tx, removed);
    tx.update(drafts)
      .set({
        undoHistory: next && (next.past.length || next.future.length) ? JSON.stringify(next) : null,
      })
      .where(eq(drafts.id, draftId))
      .run();
  };
  const checkpoint = (history: History<Step>, tx?: Tx) => {
    const next = trimPersistedHistory(
      {
        version: 1,
        checkpoint: historyCheckpoint(expoDb, draftId),
        past: history.past,
        future: history.future,
      },
      sizeOf,
      livePaths(draftId),
    );
    if (tx) replaceCheckpoint(tx, next);
    else db.transaction((target) => replaceCheckpoint(target, next));
    return next;
  };
  const checkpointAddition = (history: History<Step>, tx: Tx) => {
    // A concurrent optimistic change has not landed yet. Invalidate the old checkpoint in the
    // row transaction, then checkpoint the final stacks once every queued change settles.
    if (hasPendingDraftWrites() || failureVersion !== draftWriteFailureVersion()) {
      replaceCheckpoint(tx, null);
    } else checkpoint(history, tx);
  };

  const store: EditorHistoryStore = createEditorHistory({
    initial: initial
      ? { past: initial.past, future: initial.future, lastOp: null }
      : emptyHistory(),
    retainOnClose: true,
    flush: async () => {
      await flushDraftWrites();
      if (failureVersion !== draftWriteFailureVersion())
        throw new Error('An edit could not be saved.');
    },
    takeOut: takeOutSegments,
    restore: restoreSegments,
    takeOutAndCheckpoint: async (ids, splits, next) => {
      const taken = await takeOutSegments(ids, splits, (tx, value) => {
        checkpointAddition(next(value), tx);
      });
      if (taken) {
        const restored = new Set(splits.flatMap((s) => s.before.rows.map((r) => r.id)));
        dropClipJobs({
          segmentIds: taken.rows.filter((r) => !restored.has(r.id)).map((r) => r.id),
        });
      }
      return taken;
    },
    restoreAndCheckpoint: (taken, next) =>
      restoreSegments(taken, (tx) => {
        checkpointAddition(next(), tx);
      }),
    drop: async (taken) => {
      drops.add(taken);
    },
    failed: report,
  });

  const flush = (): Promise<void> => {
    if (work) return work;
    work = (async () => {
      // record() precedes the edit setter within the same event. Let that setter enqueue first.
      await Promise.resolve();
      while (written !== revision) {
        await store.settled();
        await flushDraftWrites();
        if (failureVersion !== draftWriteFailureVersion()) {
          failureVersion = draftWriteFailureVersion();
          store.reset();
        }
        const at = revision;
        const state = store.getState();
        const next = checkpoint(state);
        if (
          !state.batchOpen &&
          (next.past.length !== state.past.length || next.future.length !== state.future.length)
        ) {
          retaining = true;
          try {
            store.retain({ past: next.past, future: next.future, lastOp: null });
          } finally {
            retaining = false;
          }
        }
        written = at;
        const oldPaths = previousPaths;
        previousPaths = historyMediaPaths(next);
        const removed = [...drops];
        drops.clear();
        for (const taken of removed) await dropTakenOut(taken);
        await dropHistoryFiles([...oldPaths].filter((path) => !previousPaths.has(path)));
      }
    })()
      .finally(() => {
        work = null;
      })
      .then(() => {
        if (closing) retire();
      });
    return work;
  };
  const unsubscribe = store.subscribe(() => {
    if (retaining) return;
    revision++;
    void flush().catch((error: unknown) => report('save', error));
  });
  const unregister = registerUndoWriter(flush);
  const retire = () => {
    const state = store.getState();
    if (work || readers || state.busy || state.batchOpen || sessions.get(draftId)?.store !== store)
      return;
    for (const step of [...state.past, ...state.future]) {
      if (step.kind !== 'added') continue;
      if (step.taken) releaseHistoryHold(step.taken);
      for (const split of step.splits ?? []) releaseHistoryHold(split.before);
    }
    unsubscribe();
    unregister();
    sessions.delete(draftId);
  };
  return {
    store,
    changed() {
      revision++;
      void flush().catch((error: unknown) => report('save', error));
    },
    open(failed: Failure) {
      readers++;
      closing = false;
      failures.add(failed);
      store.open();
      // Checkpoint hydrated retention, including any stale/missing-media history discarded above.
      revision++;
      void flush().catch((error: unknown) => report('save', error));
      return () => {
        failures.delete(failed);
        readers--;
        if (readers) return;
        closing = true;
        store.dispose();
        void flush().catch((error: unknown) => report('save', error));
      };
    },
  };
}

/** Reopening during an asynchronous Undo reuses the same store until it commits. */
export function editorUndoSession(draftId: string) {
  let session = sessions.get(draftId);
  if (!session) {
    session = createSession(draftId);
    sessions.set(draftId, session);
  }
  return session;
}
