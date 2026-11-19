import { Directory, File } from 'expo-file-system';
import { backupDatabaseSync, openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';

import { toFileUri } from '@/utils/file-store';
import { applyDurability, quickCheckOk } from './durability';
import { APP_SCHEMA_VERSION, carryLocalTables, schemaVersion } from './project';
import { documentDir } from '@/utils/storage-root';
import { databaseDir } from './database-dir';

// Recovery snapshots: copies of the database (SQLite's online backup API, through expo-sqlite's
// backupDatabaseSync) in `SQLite/backups/pulse-<ms>.db`, the newest three kept. Each is written
// under a `.part` name and renamed only once complete, so an interrupted copy is never a candidate.
// One is taken before migrations and once a day. At launch, a database that fails `quick_check`,
// or that is empty while a usable snapshot exists (a recovery that was interrupted), is replaced
// by the newest usable snapshot. Nothing here deletes media, and nothing here may stop the app
// from starting: every step that can fail is caught and reported through `OpenedLibrary`.

export const DB_NAME = 'pulse.db';
const KEEP = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A library backup's database, staged by `restoreLibraryBackup` for the next launch. */
export const PENDING_RESTORE = 'restore-pending.db';
/**
 * A library backup's files that differ from ones already on the phone, staged by
 * `restoreLibraryBackup` and moved into place here, after the database, so the library never
 * pairs old rows with a restored file (or the reverse). Laid out like the documents folder.
 */
export const pendingMediaDir = () => new Directory(documentDir(), '.pulse-pending-media');

const dbDir = (): string => databaseDir();
export const backupsPath = () => `${dbDir()}/backups`;
const backupsDir = () => new Directory(toFileUri(backupsPath()));
const SNAPSHOT = /^pulse-(\d+)\.db$/;

/** Snapshot names, newest first. */
function snapshots(): string[] {
  const dir = backupsDir();
  if (!dir.exists) return [];
  return dir
    .list()
    .map((e) => e.name)
    .filter((n) => SNAPSHOT.test(n))
    .sort((a, b) => Number(b.match(SNAPSHOT)![1]) - Number(a.match(SNAPSHOT)![1]));
}

/** Copy `source` into `dest` (both open) with SQLite's online backup API. */
function copyDatabase(source: SQLiteDatabase, dest: SQLiteDatabase): void {
  backupDatabaseSync({ sourceDatabase: source, destDatabase: dest });
}

/** Open a database in the backups folder on its own connection. */
const openBackup = (name: string) =>
  openDatabaseSync(name, { useNewConnection: true }, backupsPath());

function removeDbFiles(dir: Directory, name: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const f = new File(dir, name + suffix);
    if (f.exists) f.delete();
  }
}

/**
 * Snapshot `conn` as `pulse-<now>.db` (written as `.part`, renamed when complete), then drop all
 * but the newest three. Returns its name.
 */
export function takeSnapshot(conn: SQLiteDatabase, now: number): string {
  const dir = backupsDir();
  dir.create({ intermediates: true, idempotent: true });
  let name = `pulse-${now}.db`;
  while (new File(dir, name).exists) name = `pulse-${++now}.db`; // never overwrite one
  const part = `${name}.part`;
  removeDbFiles(dir, part);
  const dest = openBackup(part);
  try {
    copyDatabase(conn, dest);
    dest.execSync('PRAGMA journal_mode = DELETE;'); // one self-contained file to rename
  } finally {
    dest.closeSync();
  }
  new File(dir, part).moveSync(new File(dir, name));
  for (const old of snapshots().slice(KEEP)) removeDbFiles(dir, old);
  return name;
}

/** Copies a crash or kill cut short (`*.part`): nothing is mid-write when the app launches. */
function removePartials(): void {
  const dir = backupsDir();
  if (!dir.exists) return;
  for (const entry of dir.list()) {
    if (entry instanceof File && /\.part(-wal|-shm|-journal)?$/.test(entry.name)) entry.delete();
  }
}

/** A routine snapshot: worth having, never worth failing a launch over (a full phone, say). */
function trySnapshot(conn: SQLiteDatabase, now: number): void {
  try {
    takeSnapshot(conn, now);
  } catch (e) {
    console.warn('[db] snapshot failed', e);
  }
}

function isSound(conn: SQLiteDatabase): boolean {
  try {
    return quickCheckOk(conn);
  } catch {
    return false; // a damaged header throws instead of reporting
  }
}

/** Sound and migrated at least once: an interrupted copy leaves a sound but empty database. */
function isUsable(conn: SQLiteDatabase): boolean {
  try {
    return isSound(conn) && schemaVersion(conn) != null;
  } catch {
    return false;
  }
}

/** The newest usable snapshot, open on its own connection; null when none is. */
function newestUsableSnapshot(): { at: number; db: SQLiteDatabase } | null {
  for (const name of snapshots()) {
    let db: SQLiteDatabase | undefined;
    try {
      db = openBackup(name);
      if (isUsable(db)) return { at: Number(name.match(SNAPSHOT)![1]), db };
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
 * a new file. If that copy is interrupted, the next launch finds the new file empty while a usable
 * snapshot exists, and recovers again.
 */
function setAsideDamaged(conn: SQLiteDatabase, now: number, ios: boolean): SQLiteDatabase {
  try {
    conn.closeSync();
  } catch {}
  const dir = backupsDir();
  dir.create({ intermediates: true, idempotent: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const file = new File(toFileUri(`${dbDir()}/${DB_NAME}${suffix}`));
    if (file.exists) file.moveSync(new File(dir, `damaged-${now}-${DB_NAME}${suffix}`));
  }
  const fresh = openDatabaseSync(DB_NAME, { enableChangeListener: true }, databaseDir());
  try {
    applyDurability(fresh, ios); // foreign keys and durability are per connection
  } catch {}
  return fresh;
}

/**
 * Written into `pendingMediaDir()` once its database has been applied. Without it the folder is
 * left from a restore that never finished staging, and must not touch the library.
 */
const APPLY_MARK = '.apply';

/**
 * Move every deferred restore file into the documents folder, replacing what's there. `applied`:
 * its database went in on this launch. Otherwise only a folder with the marker is applied; one
 * without it was never committed and is discarded. A failed move throws and leaves the rest (and
 * the marker) in place, so the next launch finishes the job.
 */
function applyPendingMedia(applied: boolean): void {
  const root = pendingMediaDir();
  if (!root.exists) return;
  if (!applied && !new File(root, APPLY_MARK).exists) {
    root.delete();
    return;
  }
  const move = (dir: Directory, rel: string[]) => {
    for (const entry of dir.list()) {
      if (entry instanceof Directory) {
        move(entry, [...rel, entry.name]);
        continue;
      }
      if (rel.length === 0 && entry.name === APPLY_MARK) continue;
      const dest = new File(documentDir(), ...rel, entry.name);
      dest.parentDirectory.create({ intermediates: true, idempotent: true });
      if (dest.exists) dest.delete();
      entry.moveSync(dest);
    }
  };
  move(root, []);
  root.delete();
}

/**
 * After going back to a snapshot: `export.mp4` is rewritten in place, so a draft's file may be
 * newer than the snapshot's signature for it. Clear the signatures so each export merges again.
 */
function forgetExports(conn: SQLiteDatabase): void {
  try {
    const columns = conn.getAllSync<{ name: string }>('PRAGMA table_info("drafts")');
    if (columns.some((c) => c.name === 'merged_signature')) {
      conn.execSync('UPDATE drafts SET merged_signature = NULL, merged_duration_ms = NULL');
    }
  } catch (e) {
    console.warn('[db] clearing export signatures failed', e);
  }
}

export type OpenedLibrary = {
  conn: SQLiteDatabase;
  /** The snapshot time the library was recovered from, when it failed its check. */
  recoveredFrom: number | null;
  /** A staged library backup became the library on this launch. */
  restored: boolean;
  /** A staged library backup couldn't be applied; the library is as it was. */
  restoreFailed: boolean;
  /**
   * A restored database went in, but not all of its files could be moved into place. Hold the
   * library until a later launch finishes the move (the files and marker are kept for it).
   */
  restoreIncomplete: boolean;
  /** Unusable and no snapshot helped: show the recovery screen, migrate nothing. */
  failed: boolean;
};

/**
 * Open the library for this launch: apply a staged restore, check the file, recover it from the
 * newest usable snapshot if it needs it, and snapshot it before migrations or once a day.
 */
export function openLibrary(now: number, ios = Platform.OS === 'ios'): OpenedLibrary {
  let conn = openDatabaseSync(DB_NAME, { enableChangeListener: true }, databaseDir());
  const result = {
    recoveredFrom: null as number | null,
    restored: false,
    restoreFailed: false,
    restoreIncomplete: false,
  };
  try {
    applyDurability(conn, ios);
  } catch {}
  try {
    removePartials();
  } catch {}

  const pendingDb = () => new File(backupsDir(), PENDING_RESTORE);
  let committed = false;
  if (pendingDb().exists) {
    // The restore already snapshotted the library it replaces when it was staged. A damaged
    // library (restoring from the recovery screen) can't be written through: set it aside first.
    try {
      if (!isSound(conn)) conn = setAsideDamaged(conn, now, ios);
      const source = openBackup(PENDING_RESTORE);
      try {
        carryLocalTables(conn, source); // this phone's receipts and local settings stay
        copyDatabase(source, conn); // one transaction: the old library or the new one, never half
      } finally {
        source.closeSync();
      }
      committed = true;
    } catch (e) {
      console.warn('[db] staged restore failed', e);
      result.restoreFailed = true;
      try {
        pendingDb().moveSync(new File(backupsDir(), `restore-failed-${now}.db`)); // tried once
      } catch {}
    }
  }
  if (committed) {
    // The restored rows are live: from here on, finish the restore; never undo half of it.
    result.restored = true;
    try {
      const media = pendingMediaDir();
      if (media.exists) new File(media, APPLY_MARK).write(String(now)); // lets a later launch finish
    } catch (e) {
      console.warn('[db] marking the restore applied failed', e);
    }
    try {
      pendingDb().delete();
    } catch {
      try {
        // Left in place it would be applied again, over whatever changes come after.
        pendingDb().moveSync(new File(backupsDir(), `restore-applied-${now}.db`));
      } catch {}
    }
  }
  if (result.restoreFailed) {
    // Those files belong to the backup that wasn't applied; nothing references them.
    try {
      const media = pendingMediaDir();
      if (media.exists) media.delete();
    } catch {}
  } else {
    // After the database (also finishes a move an earlier launch couldn't).
    try {
      applyPendingMedia(committed);
    } catch (e) {
      console.warn('[db] moving restored files into place failed', e);
      result.restoreIncomplete = true;
    }
  }

  let needsRecovery = !isSound(conn);
  let snap: ReturnType<typeof newestUsableSnapshot> = null;
  if (!needsRecovery && !isUsable(conn)) {
    // Empty: a new install, or a recovery cut short. Only the second has a snapshot.
    snap = newestUsableSnapshot();
    needsRecovery = snap != null;
  }
  if (needsRecovery) {
    snap ??= newestUsableSnapshot();
    // No usable snapshot: leave the damaged file exactly where it is for the recovery screen.
    if (!snap) return { conn, ...result, failed: true };
    try {
      conn = setAsideDamaged(conn, now, ios);
      copyDatabase(snap.db, conn);
    } catch (e) {
      console.warn('[db] recovery failed', e);
      return { conn, ...result, failed: true };
    } finally {
      snap.db.closeSync();
    }
    if (!isUsable(conn)) return { conn, ...result, failed: true };
    result.recoveredFrom = snap.at;
    forgetExports(conn);
    try {
      applyDurability(conn, ios);
    } catch {}
  }

  try {
    const version = schemaVersion(conn);
    const newest = snapshots()[0];
    const stale = !newest || now - Number(newest.match(SNAPSHOT)![1]) > DAY_MS;
    if (version != null && (version !== APP_SCHEMA_VERSION || stale)) trySnapshot(conn, now);
  } catch (e) {
    console.warn('[db] snapshot check failed', e);
  }
  return { conn, ...result, failed: false };
}
