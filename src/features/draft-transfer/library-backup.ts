import { Directory, File, Paths } from 'expo-file-system';
import { backupDatabaseSync, openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import { listContents, unzip, zip } from 'react-native-zip-archive';

import { quickCheckOk } from '@/db/durability';
import { referencedMediaPaths } from '@/db/media-refs';
import { APP_SCHEMA_VERSION, KNOWN_SCHEMA_VERSIONS, schemaVersion } from '@/db/project';
import { backupsPath, PENDING_RESTORE, takeSnapshot } from '@/db/snapshots';
import { ensureFreeSpace, nativeMd5 } from '@/utils/disk-space';
import { absolutize, toFileUri } from '@/utils/file-store';

// A library backup: the database as a SQLite file (copied with the online backup API), every file
// its rows need, and a manifest listing each with its size and native MD5. Zipping and unzipping
// run in native code (react-native-zip-archive): a multi-GB library never streams through JS,
// so memory stays flat and the UI stays responsive. Media is zipped straight from `drafts/`, never
// copied first. Restoring unzips into a folder beside `drafts/` (same volume, so moving each file
// into place is a rename), checks every file's MD5, and stages the database for the next launch
// (`openLibrary` copies it into the live database there).
//
// Archive layout (what native zip produces for [pulse.db, manifest.json, Documents/drafts]):
//   pulse.db, manifest.json, and the contents of drafts/ (`<draftId>/segments/…`).

export const BACKUP_FORMAT = 'pulse-library-backup';
const MANIFEST = 'manifest.json';
const DATABASE = 'pulse.db';
const DRAFTS = 'drafts/';

export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  version: 2;
  /** The newest migration applied to the backed-up database (drizzle journal `when`). */
  schemaVersion: number;
  createdAt: number;
  /** `pulse.db`, and each media file by its library path (`drafts/…`), with its native MD5. */
  files: { path: string; size: number; md5: string }[];
};

/** A file:// URI as the plain path native code (expo-sqlite's `directory`, zip) takes. */
const plainPath = (uri: string) =>
  decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/\/$/, '');

/** Where a manifest file sits in the archive. */
const entryName = (path: string) => (path.startsWith(DRAFTS) ? path.slice(DRAFTS.length) : path);

/** Let a frame through between native calls that each take a moment (hashing a clip). */
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Write the whole library to a `.pulse` backup in the cache and return its URI for sharing. */
export async function createLibraryBackup(conn: SQLiteDatabase, now: number): Promise<string> {
  const dir = new Directory(Paths.cache, 'pulse-exports');
  if (dir.exists) dir.delete(); // these are transient share files
  const stage = new Directory(dir, `stage-${now}`);
  stage.create({ intermediates: true });
  try {
    const copy = openDatabaseSync(DATABASE, { useNewConnection: true }, plainPath(stage.uri));
    let version: number | null;
    let media: string[];
    try {
      backupDatabaseSync({ sourceDatabase: conn, destDatabase: copy });
      copy.execSync('PRAGMA journal_mode = DELETE;'); // one self-contained file, no -wal beside it
      version = schemaVersion(copy);
      // The files the COPY's rows reference, so the manifest matches the database in it.
      media = [...referencedMediaPaths(copy)].filter((p) => new File(absolutize(p)).exists).sort();
    } finally {
      copy.closeSync();
    }
    if (version == null) throw new Error('There is no library to back up yet.');

    const sources = [new File(stage, DATABASE), ...media.map((p) => new File(absolutize(p)))];
    const paths = [DATABASE, ...media];
    // The archive is about the size of what goes in it (entries are stored, not compressed).
    ensureFreeSpace(sources.reduce((sum, f) => sum + (f.size ?? 0), 0));
    const files: BackupManifest['files'] = [];
    for (const [i, file] of sources.entries()) {
      files.push({ path: paths[i], size: file.size ?? 0, md5: nativeMd5(file) });
      await yieldToUi();
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: 2,
      schemaVersion: version,
      createdAt: now,
      files,
    };
    new File(stage, MANIFEST).write(JSON.stringify(manifest));

    const out = new File(dir, `pulse-library-${now}.pulse`);
    const draftsDir = new Directory(Paths.document, 'drafts');
    await zip(
      [
        plainPath(new File(stage, DATABASE).uri),
        plainPath(new File(stage, MANIFEST).uri),
        ...(draftsDir.exists ? [plainPath(draftsDir.uri)] : []),
      ],
      plainPath(out.uri),
      { compressionLevel: 0 }, // media is already compressed
    );
    return out.uri;
  } finally {
    if (stage.exists) stage.delete();
  }
}

/** Whether a zip's entry names look like a library backup (its manifest is checked on restore). */
export async function looksLikeLibraryBackup(fileUri: string): Promise<boolean> {
  const names = new Set((await listContents(plainPath(fileUri))).map((e) => e.path));
  return names.has(MANIFEST) && names.has(DATABASE);
}

const DAMAGED = 'This backup is damaged.';
const NOT_A_BACKUP = 'This isn’t a Pulse library backup.';

/** Restore folders are beside `drafts/`, so files move into place by rename. */
const restoreDir = (now: number) => new Directory(Paths.document, `.pulse-restore-${now}`);

function removeLeftoverRestores(): void {
  for (const entry of new Directory(Paths.document).list()) {
    if (entry instanceof Directory && entry.name.startsWith('.pulse-restore-')) {
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
  if (manifest?.format !== BACKUP_FORMAT || manifest.version !== 2) throw new Error(NOT_A_BACKUP);
  if (!KNOWN_SCHEMA_VERSIONS.has(manifest.schemaVersion)) {
    throw new Error(
      manifest.schemaVersion > APP_SCHEMA_VERSION
        ? 'This backup was made by a newer version of Pulse. Update Pulse, then restore it.'
        : 'This backup was made by a version of Pulse this one doesn’t know.',
    );
  }
  for (const f of manifest.files) {
    const ok =
      f.path === DATABASE || (f.path.startsWith(DRAFTS) && !f.path.split('/').includes('..'));
    if (!ok || typeof f.md5 !== 'string') throw new Error(DAMAGED);
  }
  return manifest;
}

/**
 * Check a library backup and stage it: media moved back in place, the database left as
 * `backups/restore-pending.db` for the next launch (the app reloads to finish). Refuses a backup
 * from a newer Pulse, a damaged one (any file whose MD5 differs) and one the phone has no room
 * for — before anything in the library is touched. The current library is snapshotted first, so
 * the restore can be undone.
 */
export async function restoreLibraryBackup(
  conn: SQLiteDatabase,
  fileUri: string,
  now: number,
): Promise<void> {
  removeLeftoverRestores();
  const archive = plainPath(fileUri);
  const entries = await listContents(archive);
  if (!entries.some((e) => e.path === MANIFEST)) throw new Error(NOT_A_BACKUP);
  // The unzipped copy sits beside the library until each file is moved into place.
  ensureFreeSpace(entries.reduce((sum, e) => sum + (e.isDirectory ? 0 : e.size), 0));

  const stage = restoreDir(now);
  stage.create({ intermediates: true });
  try {
    await unzip(archive, plainPath(stage.uri));
    const manifest = readManifest(stage);
    const staged = (path: string) => new File(stage, ...entryName(path).split('/'));
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
    } finally {
      db.closeSync();
    }

    takeSnapshot(conn, now);
    for (const f of manifest.files) {
      if (f.path === DATABASE) continue;
      const dest = new File(absolutize(f.path));
      if (dest.exists) dest.delete();
      dest.parentDirectory.create({ intermediates: true, idempotent: true });
      staged(f.path).moveSync(dest);
    }
    const pending = new File(toFileUri(`${backupsPath()}/${PENDING_RESTORE}`));
    if (pending.exists) pending.delete();
    staged(DATABASE).moveSync(pending);
  } finally {
    if (stage.exists) stage.delete(); // a refused or failed restore leaves nothing behind
  }
}
