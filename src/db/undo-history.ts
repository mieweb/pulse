import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';

import { drafts, segments } from './schema';

export function checkpointForRows(
  captionY: unknown,
  rows: readonly Record<string, unknown>[],
): string {
  return JSON.stringify([
    captionY ?? null,
    [...rows]
      .sort((a, b) => Number(a.order) - Number(b.order))
      .map((r) => ({
        id: r.id,
        order: r.order,
        originalFilename: r.originalFilename,
        durationMs: r.durationMs,
        editedFilename: r.editedFilename ?? null,
        editedDurationMs: r.editedDurationMs ?? null,
        editState: r.editState ?? null,
        captionEdit: r.captionEdit ?? null,
      })),
  ]);
}

/**
 * The authoritative state a saved stack belongs to. Derived covers and background transcripts
 * may finish later without changing an edit. Store the exact value rather than a lossy hash.
 * A kill between an ordinary queued edit and its checkpoint leaves the old checkpoint unusable,
 * never an undo stack paired with different rows. Addition undo/redo save inside their transaction.
 */
export function historyCheckpoint(conn: SQLiteDatabase, draftId: string): string {
  const d = drizzle(conn);
  const draft = d
    .select({ captionY: drafts.captionY })
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .get();
  const clips = d
    .select({
      id: segments.id,
      order: segments.order,
      originalFilename: segments.originalFilename,
      durationMs: segments.durationMs,
      editedFilename: segments.editedFilename,
      editedDurationMs: segments.editedDurationMs,
      editState: segments.editState,
      captionEdit: segments.captionEdit,
    })
    .from(segments)
    .where(eq(segments.draftId, draftId))
    .orderBy(asc(segments.order))
    .all();
  return checkpointForRows(draft?.captionY, clips);
}
