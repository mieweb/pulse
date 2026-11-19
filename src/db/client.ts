import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';

import type { PulseMode } from '@/core/recovery/types';
import { readDurability } from './durability';
import { markNewerSchema } from './host-context';
import { isNewerSchema } from './project';
import * as schema from './schema';
import { openLibrary, type OpenedLibrary } from './snapshots';

/**
 * This launch's library: opened, checked, and recovered or restored when it had to be. Runs while
 * this module loads, so nothing it throws may escape: an unexpected failure shows the recovery
 * screen over an empty in-memory database, and the files on disk are left as they are.
 */
function open(): OpenedLibrary {
  try {
    return openLibrary(Date.now());
  } catch (e) {
    console.error('[db] could not open the library', e);
    const conn = openDatabaseSync(':memory:', { enableChangeListener: true });
    return {
      conn,
      recoveredFrom: null,
      restored: false,
      restoreFailed: false,
      restoreIncomplete: false,
      failed: true,
    };
  }
}

export const library = open();
export const expoDb = library.conn; // opened with enableChangeListener: useLiveQuery works

if (!library.failed) console.log('[db] durability', JSON.stringify(readDurability(expoDb)));

export const db = drizzle(expoDb, { schema });

/**
 * The downgrade guard (C1, AD34). An embedded library a newer PulseKit already migrated keeps
 * working with what its additive migrations allow: its migrations are skipped (it has every one
 * this build ships), listing, sending and deleting go on as before, and only the writes that
 * create or edit a draft reject with `storage.newer_schema` (`assertEditable`). A read-only
 * library would strand the unsent videos in it. Returns whether it applied; the caller then skips
 * the migrations. The Pulse app keeps its behaviour: this never applies to `standalone`.
 */
export function guardNewerSchema(mode: PulseMode, conn: SQLiteDatabase = expoDb): boolean {
  if (mode !== 'embedded' || !isNewerSchema(conn)) return false;
  markNewerSchema();
  console.warn('[db] the library was written by a newer Pulse: editing is off');
  return true;
}
