import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync } from 'expo-sqlite';

import { readDurability } from './durability';
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
