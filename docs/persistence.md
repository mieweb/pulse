# Persistence

Pulse keeps its library in one place: the SQLite database `pulse.db`, plus the media files its
rows point to under `Documents/drafts/`. A `.pulse` file is a complete copy of drafts or of the
whole library, made on demand to share, back up or restore. The app never runs on that copy.

## Saves

`src/db/durability.ts` sets these pragmas when the database opens:

| Pragma | Value | Why |
|---|---|---|
| `journal_mode` | `WAL` | readers don't block the writer; a crash leaves the last committed state |
| `synchronous` | `FULL` | a commit is on disk before it returns |
| `fullfsync`, `checkpoint_fullfsync` | `ON` (iOS) | Apple's `fsync` doesn't flush the drive cache; `F_FULLFSYNC` does |
| `foreign_keys` | `ON` | cascade deletes |

The app logs the values it reads back as `[db] durability`.

## Launch and recovery

`openLibrary` (`src/db/snapshots.ts`) runs as `src/db/client.ts` loads, before migrations. Nothing
in it may stop the app from starting: every step that can fail is caught, and an unexpected
failure shows the recovery screen over an in-memory database without touching the files.

```mermaid
flowchart TD
  open[Open pulse.db] --> staged{Staged restore?}
  staged -- yes --> apply[Copy the staged database in, then move its deferred files into place]
  apply -- fails --> keep[Keep the library as it was; set the staged database aside; say so]
  staged -- no --> check
  apply --> check
  keep --> check{Passes quick_check, and has a schema or no usable snapshot exists?}
  check -- yes --> snap{Schema changed or newest snapshot older than a day?}
  check -- no --> usable{A snapshot passes quick_check and has a schema?}
  usable -- no --> fail[Recovery screen: nothing migrated or deleted]
  usable -- yes --> aside[Move damaged files to SQLite/backups/damaged-time-pulse.db] --> restore[Restore the snapshot into a fresh database] --> snap
  snap -- yes --> take[Snapshot to SQLite/backups/pulse-time.db, keep the newest three; a failure is only logged] --> migrate[Drizzle migrations, data migrations]
  snap -- no --> migrate
```

- **Snapshots** use expo-sqlite's `backupDatabaseSync` (SQLite's online backup API). Each is written
  as `pulse-<time>.db.part` and renamed when complete.
- **An empty database** passes `quick_check`. That's what an interrupted recovery leaves, so an
  empty database counts as damaged while a usable snapshot exists. A new install has none.

## Media

`referencedMediaPaths` (`src/db/media-refs.ts`) is the one list of files the library needs: stored
paths, derived ones (thumbnails, edited thumbnails, covers, `export.mp4`; see
`src/utils/media-paths.ts`), and the clip files that transcripts and caption edits were timed against.
It decides what goes into a `.pulse` file, and protects referenced files from the RNVT leftover
sweep. Media is only deleted with its draft. Nothing deletes a file for lacking a row, because a
damaged, empty or restored database would then delete videos.

## `.pulse` files

| | Draft transfer | Library backup |
|---|---|---|
| Contents | `project.json`: every row and column of the chosen drafts, built from `schema.ts` (`src/db/project.ts`), plus their media, each listed with its archive entry, size and MD5 | `pulse.db` (via the backup API), `manifest.json` (each file's library path, archive entry, size and MD5), and exactly the files the database references, except each draft's `export.mp4` |
| Import | copy with new ids (`unpack-project.ts`); a file two copies share is moved once and copied for the other; v1 bundles still go to the v1 importer | exact restore, staged for the next launch, then migrated (`library-backup.ts`) |
| Zip | native both ways (`react-native-zip-archive`; `native-zip.ts` writes): flat, each file under its base name; a second file with a taken name (a duplicated draft keeps a shared original's) goes in as a renamed copy. Import unzips beside `drafts/`, checks sizes and MD5s, then moves each file into place. Draft files from before entry names (`media/<path>`) still import | (same) |

**Coverage:** the export refuses a database column that `schema.ts` doesn't define, and a test fails
if a schema column is missing from the export.

**Integrity and safety**, checked before anything in the library is touched:
- Each file's MD5 is computed natively (`File.info({ md5: true })`) and checked on import.
- A draft file's child rows must have their parent in the file.
- A backup's manifest paths must stay under `drafts/` and be unique, and each entry must be a plain, unique name in the archive.
- The restored database's draft and clip ids and its stored paths must stay under `drafts/` too
  (`assertSafeLibrary`).
- A throwaway copy of the restored database is migrated, and must then hold this build's whole
  schema (`assertCurrentSchema`).
- Upload destinations are never restored: their tokens stay in this phone's secure store, keyed by
  id, so a backup must not pair one with another server.
- Only one restore waits at a time.

**Exports:** a draft's `export.mp4` is the one file rewritten in place, so:
- library backups leave it out and clear the copy's export signatures, so a restored draft merges
  its export again;
- going back to a snapshot also clears the signatures, since a newer export may be on disk.

**Restore order:**
1. The current library is snapshotted. From the recovery screen, where there's no sound library,
   it isn't; the damaged database is set aside at the next launch instead.
2. Files new to the phone move into place.
3. Files that differ from one already here wait in `Documents/.pulse-pending-media/`.
4. On the next launch, they are applied together with the database (only once a marker shows the
   database went in), so old rows never point at a restored file.
5. If a file can't be moved after the database went in, the library is held behind a message until
   a later launch finishes the move. The restore is never half undone.

**Free space and versions:**
- Export, import and restore check `Paths.availableDiskSpace` and refuse before writing anything.
- Each export builds its file in its own folder under `Caches/pulse-exports/`
  (`workspace.ts`), so a backup and a draft export never clear each other's files.
- A backup from a newer schema is refused; an older one is migrated after the swap.
