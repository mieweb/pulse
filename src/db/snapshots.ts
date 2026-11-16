import { Directory, File } from 'expo-file-system';
import {
  backupDatabaseSync,
  defaultDatabaseDirectory,
  openDatabaseSync,
  type SQLiteDatabase,
} from 'expo-sqlite';
import { Platform } from 'react-native';

import { toFileUri } from '@/utils/file-store';
import { applyDurability, quickCheckOk } from './durability';
import { sweepHold } from './media-refs';
import { APP_SCHEMA_VERSION, schemaVersion } from './project';

// Recovery snapshots: copies of the database (SQLite's online backup API, through expo-sqlite's
// backupDatabaseSync) in `SQLite/backups/pulse-<ms>.db`, the newest three kept. One is taken
// before migrations and once a day; a database that fails `quick_check` at launch is replaced
// by the newest snapshot that passes. Media is never touched here.

export const DB_NAME = 'pulse.db';
const KEEP = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A library backup's database, staged by `restoreLibraryBackup` for the next launch. */
export const PENDING_RESTORE = 'restore-pending.db';

const dbDir = (): string => defaultDatabaseDirectory;
export const backupsPath = () => `${dbDir()}/backups`;
const backupsDir = () => new Directory(toFileUri(backupsPath()));

/** Snapshot names, newest first. */
function snapshots(): string[] {
  const dir = backupsDir();
  if (!dir.exists) return [];
  return dir
    .list()
    .map((e) => e.name)
    .filter((n) => /^pulse-\d+\.db$/.test(n))
    .sort((a, b) => Number(b.slice(6, -3)) - Number(a.slice(6, -3)));
}

/** Copy `source` into `dest` (both open) with SQLite's online backup API. */
function copyDatabase(source: SQLiteDatabase, dest: SQLiteDatabase): void {
  backupDatabaseSync({ sourceDatabase: source, destDatabase: dest });
}

/** Open a database in the backups folder on its own connection. */
const openBackup = (name: string) =>
  openDatabaseSync(name, { useNewConnection: true }, backupsPath());

/** Snapshot `conn` as `pulse-<now>.db`, then drop all but the newest three. Returns its name. */
export function takeSnapshot(conn: SQLiteDatabase, now: number): string {
  backupsDir().create({ intermediates: true, idempotent: true });
  const name = `pulse-${now}.db`;
  const dest = openBackup(name);
  try {
    copyDatabase(conn, dest);
  } finally {
    dest.closeSync();
  }
  for (const old of snapshots().slice(KEEP)) {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = new File(backupsDir(), old + suffix);
      if (f.exists) f.delete();
    }
  }
  return name;
}

function isSound(conn: SQLiteDatabase): boolean {
  try {
    return quickCheckOk(conn);
  } catch {
    return false; // a damaged header throws instead of reporting
  }
}

/** The newest snapshot that passes its check, open on its own connection; null when none does. */
function newestSoundSnapshot(): { at: number; db: SQLiteDatabase } | null {
  for (const name of snapshots()) {
    let db: SQLiteDatabase | undefined;
    try {
      db = openBackup(name);
      if (isSound(db)) return { at: Number(name.slice(6, -3)), db };
    } catch {}
    try {
      db?.closeSync();
    } catch {}
  }
  return null;
}

/**
 * Close the damaged library and move its files (and any -wal/-shm) into the backups folder as
 * `damaged-<now>-pulse.db…` — kept, never deleted — then open a fresh, empty database in its place.
 * SQLite can't write through a file whose header is gone, so a snapshot can only be restored into
 * a new file.
 */
function setAsideDamaged(conn: SQLiteDatabase, now: number): SQLiteDatabase {
  try {
    conn.closeSync();
  } catch {}
  backupsDir().create({ intermediates: true, idempotent: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const file = new File(toFileUri(`${dbDir()}/${DB_NAME}${suffix}`));
    if (file.exists) file.moveSync(new File(backupsDir(), `damaged-${now}-${DB_NAME}${suffix}`));
  }
  return openDatabaseSync(DB_NAME, { enableChangeListener: true });
}

/** Keep media that lost its rows (a recovery or a restore went back in time) for a week. */
function holdSweep(now: number): void {
  const hold = sweepHold();
  hold.parentDirectory.create({ intermediates: true, idempotent: true });
  hold.write(String(now + 7 * DAY_MS));
}

export type OpenedLibrary = {
  conn: SQLiteDatabase;
  /** The snapshot time the library was recovered from, when it failed its check. */
  recoveredFrom: number | null;
  /** A staged library backup became the library on this launch. */
  restored: boolean;
  /** Unusable and no snapshot helped: show the recovery screen, migrate and sweep nothing. */
  failed: boolean;
};

/**
 * Open the library for this launch: apply a staged restore, check the file, recover it from the
 * newest sound snapshot if it fails, and snapshot it before migrations or once a day.
 */
export function openLibrary(now: number, ios = Platform.OS === 'ios'): OpenedLibrary {
  let conn = openDatabaseSync(DB_NAME, { enableChangeListener: true });
  let recoveredFrom: number | null = null;
  let restored = false;
  try {
    applyDurability(conn, ios);
  } catch {}

  const staged = new File(backupsDir(), PENDING_RESTORE);
  if (staged.exists) {
    if (isSound(conn)) takeSnapshot(conn, now); // the library being replaced, to undo the restore
    const source = openBackup(PENDING_RESTORE);
    try {
      copyDatabase(source, conn);
    } finally {
      source.closeSync();
    }
    staged.delete();
    holdSweep(now);
    restored = true;
  }

  if (!isSound(conn)) {
    // No usable snapshot: leave the damaged file exactly where it is for the recovery screen.
    const snap = newestSoundSnapshot();
    if (!snap) return { conn, recoveredFrom, restored, failed: true };
    try {
      conn = setAsideDamaged(conn, now);
      copyDatabase(snap.db, conn);
    } finally {
      snap.db.closeSync();
    }
    if (!isSound(conn)) return { conn, recoveredFrom, restored, failed: true };
    recoveredFrom = snap.at;
    holdSweep(now);
    applyDurability(conn, ios);
  }

  const version = schemaVersion(conn);
  const newest = snapshots()[0];
  const stale = !newest || now - Number(newest.slice(6, -3)) > DAY_MS;
  if (version != null && (version !== APP_SCHEMA_VERSION || stale)) takeSnapshot(conn, now);
  return { conn, recoveredFrom, restored, failed: false };
}
