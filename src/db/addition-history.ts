import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { File } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';

import { undoAdditionBatch, undoAdditionSnapshot, type UndoStacks } from '@/core/undo-additions';
import type { AddedStep } from '@/core/types/editor-history';
import { absolutize } from '@/utils/file-store';
import type { db } from './client';
import type { SplitReceipt } from './drafts';
import { noteHeldFiles } from './held-files';
import { liveDraftMediaPaths } from './media-refs';
import {
  assertHistoryOwnership,
  historyMediaPaths,
  parsePersistedHistory,
  trimPersistedHistory,
  type PersistedHistory,
} from './persisted-history';
import { drafts } from './schema';
import { historyCheckpoint, historyOwners } from './undo-history';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type AdditionHistory = { stacks: UndoStacks; removed: string[] };

/** Read before changing rows; a stale or invalid checkpoint can never supply replay state. */
export function additionHistoryBefore(
  conn: SQLiteDatabase,
  draftId: string,
): PersistedHistory | null {
  try {
    const row = drizzle(conn)
      .select({ value: drafts.undoHistory })
      .from(drafts)
      .where(eq(drafts.id, draftId))
      .get();
    const stored = parsePersistedHistory(row?.value, draftId);
    if (stored) assertHistoryOwnership(stored, draftId, historyOwners(conn));
    const active = undoAdditionSnapshot(draftId);
    const history = active
      ? { version: 1 as const, checkpoint: historyCheckpoint(conn, draftId), ...active }
      : stored;
    if (history) assertHistoryOwnership(history, draftId, historyOwners(conn));
    return history?.checkpoint === historyCheckpoint(conn, draftId) ? history : null;
  } catch {
    return null;
  }
}

/** Additions and their resulting stacks are one SQLite commit, even without an editor mounted. */
export function checkpointInsertedClips(
  conn: SQLiteDatabase,
  tx: Tx,
  draftId: string,
  before: PersistedHistory | null,
  ids: string[],
  splits: readonly SplitReceipt[],
): AdditionHistory {
  const batchKey = undoAdditionBatch(draftId, ids);
  const past = [...(before?.past ?? [])];
  const at = batchKey
    ? past.findIndex((step) => step.kind === 'added' && step.batchKey === batchKey)
    : -1;
  const prior = at >= 0 ? (past[at] as AddedStep) : undefined;
  const step: AddedStep = {
    kind: 'added',
    ids: [...new Set([...(prior?.ids ?? []), ...ids])],
    taken: null,
    ...(prior?.splits?.length || splits.length
      ? { splits: [...(prior?.splits ?? []), ...splits] }
      : {}),
    ...(batchKey ? { batchKey } : {}),
  };
  if (at >= 0) past[at] = step;
  else past.push(step);
  const stacks: UndoStacks = { past, future: [] };
  const next = trimPersistedHistory(
    { version: 1, checkpoint: historyCheckpoint(conn, draftId), ...stacks },
    (path) => {
      const file = new File(absolutize(path));
      return file.exists ? file.size : null;
    },
    liveDraftMediaPaths(conn, draftId),
  );
  const retained = historyMediaPaths(next);
  const removed = before
    ? [...historyMediaPaths(before)].filter((path) => !retained.has(path))
    : [];
  if (removed.length) noteHeldFiles(tx, removed);
  tx.update(drafts)
    .set({ undoHistory: next.past.length || next.future.length ? JSON.stringify(next) : null })
    .where(eq(drafts.id, draftId))
    .run();
  return {
    stacks: undoAdditionSnapshot(draftId) ? stacks : { past: next.past, future: next.future },
    removed,
  };
}
