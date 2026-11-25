import { eq } from 'drizzle-orm';

import { deleteSegmentFile } from '@/utils/file-store';

import { db } from './client';
import { settings } from './schema';

/**
 * The files of clips the editor's undo took out (`takeOutSegments`), kept on disk for a redo. The
 * history checkpoint can be interrupted or evicted, so they're noted here as they're taken out,
 * and the next launch deletes those no live row or saved undo checkpoint uses
 * (`dropHeldFiles`). Only these: a file is never deleted just for lacking a row (a library
 * recovered from an older copy has files of clips its rows lost).
 */
const HELD_KEY = 'drafts.heldForRedo';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function read(value: string | null | undefined): string[] {
  try {
    const list: unknown = value ? JSON.parse(value) : [];
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Note `files` as held for a redo, in the take-out's own transaction (synchronous). */
export function noteHeldFiles(tx: Tx, files: readonly string[]): void {
  const row = tx.select().from(settings).where(eq(settings.key, HELD_KEY)).get();
  const value = JSON.stringify([...new Set([...read(row?.value), ...files])]);
  tx.insert(settings)
    .values({ key: HELD_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

/**
 * At launch, before anything can hold a file again: delete the files noted as held that no row
 * uses (`referenced`, `referencedMediaPaths`: a saved history, a clip put back, or a shared file
 * keeps it), and
 * forget the list. `referenced` null forgets it without deleting (a library recovered or restored
 * this launch: its rows may not be the ones the list was written against). Returns how many noted
 * files no row used.
 */
export function dropHeldFiles(referenced: ReadonlySet<string> | null): number {
  const row = db.select().from(settings).where(eq(settings.key, HELD_KEY)).get();
  if (!row) return 0;
  let removed = 0;
  for (const rel of referenced ? read(row.value) : []) {
    if (referenced?.has(rel)) continue;
    try {
      deleteSegmentFile(rel, referenced ?? undefined);
      removed++;
    } catch {}
  }
  db.delete(settings).where(eq(settings.key, HELD_KEY)).run();
  return removed;
}
