import { Directory, File } from 'expo-file-system';
import { backupDatabaseSync, openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import { listContents, unzip } from 'react-native-zip-archive';

import { quickCheckOk } from '@/db/durability';
import { assertSafeLibrary, isSafeMediaPath, referencedMediaPaths } from '@/db/media-refs';
import {
  APP_SCHEMA_VERSION,
  assertCurrentSchema,
  clearLocalTables,
  KNOWN_SCHEMA_VERSIONS,
  schemaVersion,
} from '@/db/project';
import {
  backupsPath,
  DB_NAME,
  PENDING_RESTORE,
  pendingMediaDir,
  takeSnapshot,
} from '@/db/snapshots';
import { ensureFreeSpace, nativeMd5 } from '@/utils/disk-space';
import { absolutize, toFileUri } from '@/utils/file-store';
import migrations from '../../../drizzle/migrations';
import { plainPath, yieldToUi, zipFlat } from './native-zip';
import { exportWorkspace } from './workspace';
import { documentDir } from '@/utils/storage-root';
import { databaseDir } from '@/db/database-dir';

// A library backup: the database as a SQLite file (copied with the online backup API), exactly the
// files its rows need, and a manifest listing each with its library path, size and native MD5.
// Zipping and unzipping run in native code (react-native-zip-archive): a multi-GB library never
// streams through JS, so memory stays flat. Media is zipped straight from `drafts/`, never copied.
//
// Native zip stores each listed file under its base name, so the archive is flat and the manifest
// maps each entry back to its path. Media names carry their segment id, so they're nearly always
// unique; a second file with a name already taken (a duplicated draft keeps a shared original's
// name) goes in as a copy under a name of its own. Each draft's `export.mp4` is left out (it's
// derived, and the only file rewritten in place, so a backup can't race a re-export) and the
// copy's export signatures are cleared, so a restored draft merges its export again.
//
// A restore never brings back upload destinations: their tokens stay in this phone's secure
// store, keyed by id, and a backup must not be able to pair one of them with another server.
//
// Restoring unzips beside `drafts/` (same volume, so moving a file into place is a rename), checks
// every listed file's MD5 and the database's ids and paths, snapshots the current library, then:
// files new to this phone move into place now; files that differ from one already here wait in
// `pendingMediaDir()` with the database, and both are applied on the next launch (`openLibrary`),
// so the library never pairs the old rows with a restored file.

export const BACKUP_FORMAT = 'pulse-library-backup';
const MANIFEST = 'manifest.json';
const DATABASE = 'pulse.db';

export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  version: 3;
  /** The newest migration applied to the backed-up database (drizzle journal `when`). */
  schemaVersion: number;
  createdAt: number;
  /**
   * `pulse.db`, and each media file by its library path (`drafts/…`): its archive `entry` (base
   * name), size and native MD5.
   */
  files: { path: string; entry: string; size: number; md5: string }[];
};

/** Each draft's merged export: derived, rewritten in place, and left out of library backups. */
const isExport = (path: string) => /^drafts\/[^/]+\/export\.mp4$/.test(path);

/** The live database's files (with its WAL), roughly what its copy will take. */
function databaseBytes(): number {
  return ['', '-wal'].reduce((sum, suffix) => {
    const f = new File(toFileUri(`${databaseDir()}/${DB_NAME}${suffix}`));
    return sum + (f.exists ? (f.size ?? 0) : 0);
  }, 0);
}

/** Write the whole library to a `.pulse` backup in the cache and return its URI for sharing. */
export async function createLibraryBackup(conn: SQLiteDatabase, now: number): Promise<string> {
  // The database copy is written first; the room for the media is checked once it's listed.
  ensureFreeSpace(2 * databaseBytes());
  const dir = exportWorkspace('library', now);
  const stage = new Directory(dir, 'stage');
  stage.create({ intermediates: true, idempotent: true });
  const out = new File(dir, `pulse-library-${now}.pulse`);
  let done = false;
  try {
    const copy = openDatabaseSync(DATABASE, { useNewConnection: true }, plainPath(stage.uri));
    let version: number | null;
    let media: string[];
    try {
      backupDatabaseSync({ sourceDatabase: conn, destDatabase: copy });
      copy.execSync('PRAGMA journal_mode = DELETE;'); // one self-contained file, no -wal beside it
      // Exports aren't carried: a restored draft merges again instead of trusting a stale one.
      copy.execSync('UPDATE drafts SET merged_signature = NULL, merged_duration_ms = NULL');
      clearLocalTables(copy); // this phone's outbox, receipts and installation id stay here
      version = schemaVersion(copy);
      // The files the COPY's rows reference, so the manifest matches the database in it.
      media = [...referencedMediaPaths(copy)]
        .filter((p) => !isExport(p) && new File(absolutize(p)).exists)
        .sort();
    } finally {
      copy.closeSync();
    }
    if (version == null) throw new Error('There is no library to back up yet.');
    const schemaVersionOfCopy = version;

    const sources = [
      { path: DATABASE, file: new File(stage, DATABASE) },
      ...media.map((p) => ({ path: p, file: new File(absolutize(p)) })),
    ];
    await zipFlat(sources, stage, out, {
      names: [MANIFEST],
      write: (files) => {
        const manifest: BackupManifest = {
          format: BACKUP_FORMAT,
          version: 3,
          schemaVersion: schemaVersionOfCopy,
          createdAt: now,
          files,
        };
        new File(stage, MANIFEST).write(JSON.stringify(manifest));
      },
    });
    done = true;
    return out.uri;
  } finally {
    if (stage.exists) stage.delete();
    if (!done && dir.exists) dir.delete(); // a half-written backup is no use to anyone
  }
}

/** Whether a zip's entry names look like a library backup (its manifest is checked on restore). */
export async function looksLikeLibraryBackup(fileUri: string): Promise<boolean> {
  const names = new Set((await listContents(plainPath(fileUri))).map((e) => e.path));
  return names.has(MANIFEST) && names.has(DATABASE);
}

const DAMAGED = 'This backup is damaged.';
const NOT_A_BACKUP = 'This isn’t a Pulse library backup.';
/** Unzipped `.pulse` files (a restore, or a draft import) are staged in folders named so. */
export const RESTORE_PREFIX = '.pulse-restore-';

/** Remove unzipped restores and imports a crash or kill left behind (each can be large). */
export function removeLeftoverRestores(): void {
  for (const entry of new Directory(documentDir()).list()) {
    if (entry instanceof Directory && entry.name.startsWith(RESTORE_PREFIX)) {
      try {
        entry.delete();
      } catch {}
    }
  }
}

function readManifest(stage: Directory): BackupManifest {
  const file = new File(stage, MANIFEST);
  if (!file.exists) throw new Error(NOT_A_BACKUP);
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(file.textSync()) as BackupManifest;
  } catch {
    throw new Error(DAMAGED);
  }
  if (manifest?.format !== BACKUP_FORMAT || manifest.version !== 3) throw new Error(NOT_A_BACKUP);
  if (!KNOWN_SCHEMA_VERSIONS.has(manifest.schemaVersion)) {
    throw new Error(
      manifest.schemaVersion > APP_SCHEMA_VERSION
        ? 'This backup was made by a newer version of Pulse. Update Pulse, then restore it.'
        : 'This backup was made by a version of Pulse this one doesn’t know.',
    );
  }
  if (!Array.isArray(manifest.files)) throw new Error(DAMAGED);
  const paths = new Set<string>();
  const entries = new Set<string>([MANIFEST]);
  for (const f of manifest.files) {
    const ok =
      typeof f?.path === 'string' &&
      typeof f.entry === 'string' &&
      typeof f.md5 === 'string' &&
      typeof f.size === 'number' &&
      /^[^/\\]+$/.test(f.entry) && // a plain name in the flat archive, never a path
      !['.', '..'].includes(f.entry) &&
      (f.path === DATABASE ? f.entry === DATABASE : isSafeMediaPath(f.path));
    if (!ok || paths.has(f.path) || entries.has(f.entry)) throw new Error(DAMAGED);
    paths.add(f.path);
    entries.add(f.entry);
  }
  if (!paths.has(DATABASE)) throw new Error(DAMAGED);
  return manifest;
}

/**
 * Migrate a throwaway copy of a backup's database and check it holds this build's whole schema: a
 * file with a valid migration log but missing tables would otherwise replace a working library
 * and fail on the next launch.
 */
async function assertCompleteOnceMigrated(db: SQLiteDatabase, stage: Directory): Promise<void> {
  const check = openDatabaseSync('check.db', { useNewConnection: true }, plainPath(stage.uri));
  try {
    backupDatabaseSync({ sourceDatabase: db, destDatabase: check });
    await migrate(drizzle(check), migrations);
    assertCurrentSchema(check);
  } finally {
    check.closeSync();
  }
}

/**
 * Check a library backup and stage it for the next launch (the app reloads to finish). Refuses a
 * backup from a newer Pulse, a damaged or unsafe one (any listed file whose MD5 differs; ids or
 * paths that reach outside `drafts/`) and one the phone has no room for — before anything in the
 * library is touched. The current library is snapshotted first, unless `snapshotCurrent` is false
 * (the recovery screen: there's no sound library to snapshot).
 */
export async function restoreLibraryBackup(
  conn: SQLiteDatabase,
  fileUri: string,
  now: number,
  { snapshotCurrent = true }: { snapshotCurrent?: boolean } = {},
): Promise<void> {
  // A second restore would replace the first one's deferred files before its database went in.
  if (
    new File(toFileUri(`${backupsPath()}/${PENDING_RESTORE}`)).exists ||
    pendingMediaDir().exists
  ) {
    throw new Error('A restore is already waiting. Close Pulse and open it again to finish it.');
  }
  removeLeftoverRestores();
  const archive = plainPath(fileUri);
  const entries = await listContents(archive);
  if (!entries.some((e) => e.path === MANIFEST)) throw new Error(NOT_A_BACKUP);
  // The unzipped copy sits beside the library until each file is moved into place.
  ensureFreeSpace(entries.reduce((sum, e) => sum + (e.isDirectory ? 0 : e.size), 0));

  const stage = new Directory(documentDir(), `${RESTORE_PREFIX}${now}`);
  stage.create({ intermediates: true });
  try {
    await unzip(archive, plainPath(stage.uri));
    const manifest = readManifest(stage);
    const entryOf = new Map(manifest.files.map((f) => [f.path, f.entry]));
    const staged = (path: string) => new File(stage, entryOf.get(path)!);
    for (const f of manifest.files) {
      const file = staged(f.path);
      if (!file.exists || file.size !== f.size || nativeMd5(file) !== f.md5) {
        throw new Error(DAMAGED);
      }
      await yieldToUi();
    }

    // The database is checked on its own connection before the library is touched.
    const db = openDatabaseSync(DATABASE, { useNewConnection: true }, plainPath(stage.uri));
    try {
      if (!quickCheckOk(db) || schemaVersion(db) !== manifest.schemaVersion) {
        throw new Error(DAMAGED);
      }
      assertSafeLibrary(db);
      await assertCompleteOnceMigrated(db, stage);
      const tables = db.getAllSync<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'upload_destinations'",
      );
      if (tables.length > 0) db.execSync('DELETE FROM upload_destinations');
    } catch (e) {
      throw e instanceof Error && e.message === DAMAGED ? e : new Error(DAMAGED);
    } finally {
      db.closeSync();
    }

    if (snapshotCurrent) takeSnapshot(conn, now);
    const pending = pendingMediaDir();
    if (pending.exists) pending.delete(); // from an earlier restore that never launched
    for (const f of manifest.files) {
      if (f.path === DATABASE) continue;
      const source = staged(f.path);
      const dest = new File(absolutize(f.path));
      if (!dest.exists) {
        dest.parentDirectory.create({ intermediates: true, idempotent: true });
        source.moveSync(dest);
      } else if (dest.size !== f.size || nativeMd5(dest) !== f.md5) {
        // Replaced together with the database on the next launch, never before it.
        const later = new File(pending, ...f.path.split('/'));
        later.parentDirectory.create({ intermediates: true, idempotent: true });
        source.moveSync(later);
      }
      await yieldToUi();
    }
    const next = new File(toFileUri(`${backupsPath()}/${PENDING_RESTORE}`));
    next.parentDirectory.create({ intermediates: true, idempotent: true }); // none without a snapshot
    if (next.exists) next.delete();
    staged(DATABASE).moveSync(next);
  } finally {
    if (stage.exists) stage.delete(); // a refused or failed restore leaves nothing in the library
  }
}
