import type { SQLiteDatabase } from 'expo-sqlite';

/**
 * Durability settings, applied on every open (pragmas are per connection):
 *   - WAL (https://www.sqlite.org/wal.html): a commit appends to the -wal file, readers don't
 *     block the writer, and a crash mid-write leaves the last committed state.
 *   - synchronous = FULL (https://www.sqlite.org/pragma.html#pragma_synchronous): in WAL mode the
 *     WAL is synced on every commit, so a committed edit survives power loss, not only a crash
 *     (NORMAL can lose the last commits). expo-sqlite builds SQLite with the default FULL, but
 *     nothing in it turns WAL on, so both are set here rather than relied on.
 *   - fullfsync / checkpoint_fullfsync (https://www.sqlite.org/pragma.html#pragma_fullfsync): on
 *     Apple platforms fsync() only reaches the drive's cache; these make SQLite use F_FULLFSYNC
 *     for commits and checkpoints. They do nothing elsewhere.
 */
export function applyDurability(conn: SQLiteDatabase, ios: boolean): void {
  conn.execSync('PRAGMA journal_mode = WAL;');
  conn.execSync('PRAGMA synchronous = FULL;');
  if (ios) {
    conn.execSync('PRAGMA fullfsync = ON;');
    conn.execSync('PRAGMA checkpoint_fullfsync = ON;');
  }
  conn.execSync('PRAGMA foreign_keys = ON;'); // per-connection; required for cascade deletes
}

const PRAGMAS = [
  'journal_mode',
  'synchronous',
  'fullfsync',
  'checkpoint_fullfsync',
  'foreign_keys',
] as const;

export type Durability = Record<(typeof PRAGMAS)[number], string | number | null>;

/** What the connection actually runs with (synchronous 2 = FULL), for the log and device checks. */
export function readDurability(conn: SQLiteDatabase): Durability {
  const out = {} as Durability;
  for (const name of PRAGMAS) {
    const row = conn.getFirstSync<Record<string, string | number>>(`PRAGMA ${name};`);
    out[name] = row ? Object.values(row)[0] : null;
  }
  return out;
}

/** Whether `PRAGMA quick_check` finds the database file sound. */
export function quickCheckOk(conn: SQLiteDatabase): boolean {
  const rows = conn.getAllSync<{ quick_check: string }>('PRAGMA quick_check;');
  return rows.length === 1 && rows[0].quick_check === 'ok';
}
