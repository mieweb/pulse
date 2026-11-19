import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';

import type { PulseMode } from '@/core/recovery/types';
import { readDurability } from './durability';
import { markLibraryReadOnly } from './host-context';
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
 * The downgrade guard (C1). An embedded library a newer PulseKit already migrated is opened
 * read-only: its migrations are skipped (it has every one this build ships), SQLite refuses every
 * write on the connection (`query_only`), and the library's own writes reject with
 * `storage.newer_schema` (`assertWritable`). Returns whether it did; the caller then skips the
 * migrations. The Pulse app keeps its behaviour: this never applies to `standalone`.
 */
export function openReadOnlyIfNewer(mode: PulseMode, conn: SQLiteDatabase = expoDb): boolean {
  if (mode !== 'embedded' || !isNewerSchema(conn)) return false;
  conn.execSync('PRAGMA query_only = ON');
  markLibraryReadOnly();
  console.warn('[db] the library was written by a newer Pulse: opened read-only');
  return true;
}
