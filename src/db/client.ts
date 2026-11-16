import { drizzle } from 'drizzle-orm/expo-sqlite';

import { readDurability } from './durability';
import * as schema from './schema';
import { openLibrary } from './snapshots';

/** This launch's library: opened, checked, and recovered or restored when it had to be. */
export const library = openLibrary(Date.now());
export const expoDb = library.conn; // opened with enableChangeListener: useLiveQuery works

if (!library.failed) console.log('[db] durability', JSON.stringify(readDurability(expoDb)));

export const db = drizzle(expoDb, { schema });
