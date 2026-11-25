import { eq } from 'drizzle-orm';

import { deleteSegmentFile } from '@/utils/file-store';

import { db } from './client';
import { settings } from './schema';

/**
 * Explicit cleanup candidates: clips taken out for Redo, discarded history, or deletion deferred
 * by an active operation/shared source. They are noted when removed or deferred, and the next
 * launch deletes only candidates no live row or saved undo checkpoint uses (`dropHeldFiles`).
 * A file is never deleted just for lacking a row: a recovered library can have files its rows lost.
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

/** Note explicit deletion candidates in the owning mutation's transaction (synchronous). */
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
