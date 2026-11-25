# Persistence

Pulse keeps its library in one place: the SQLite database `pulse.db`, plus the media files its
rows point to under `Documents/drafts/`. A `.pulse` file is a complete copy of drafts or of the
whole library, made on demand to share, back up or restore. The app never runs on that copy.

PulseKit, Pulse inside another app, keeps one such library per signed-in person, each in a folder
of its own (a namespace), and adds three tables that never leave the phone: the upload outbox, the
receipts of sent videos and this install's own settings. Those are covered from
[Namespaces](#namespaces-pulsekit) on; everything before them applies to both shells.

## Saves

`src/db/durability.ts` sets these pragmas when the database opens:

| Pragma | Value | Why |
|---|---|---|
| `journal_mode` | `WAL` | readers don't block the writer; a crash leaves the last committed state |
| `synchronous` | `FULL` | a commit is on disk before it returns |
| `fullfsync`, `checkpoint_fullfsync` | `ON` (iOS) | Apple's `fsync` doesn't flush the drive cache; `F_FULLFSYNC` does |
| `foreign_keys` | `ON` | cascade deletes |

The app logs the values it reads back as `[db] durability`.

## Editor operations and Undo

The editor has **one sticky + at the right edge of the clip row**, visible in both editor views
and while a clip is selected. Its target is captured when an action is chosen and depends on the
current view:

- **Clips (beat list):** use the nearest clip boundary without splitting. A playhead in the first
  half of a clip inserts before it; the second half inserts after it. An exact midpoint inserts
  after the clip.
- **Timeline:** use the exact playhead position. Inside clip A, a successful addition of X commits
  **A-left → X → A-right** in one SQLite transaction.

At an existing boundary, either view inserts there; at the end it appends a new clip/beat to the
existing Pulse. In Timeline, A stays unsplit until the first new clip commits, so canceling or
rejecting media before that leaves it unchanged. If A's source or edits change before that commit,
the insertion is rejected instead of moving to another position. A canceled batch keeps clips
already committed. The recorder retains its explicit insert cursor; opening it from the editor
passes the chosen position through.

Splitting changes rows and edit settings, with no source-video rewrite or re-encode. The halves
share the effective source file and retain their trim, speed, transforms, crop, mute and captions.
Their `editState` includes a `baseWindow` source interval: trim handles and Reset stay inside that
half. Reset clears transforms and speed while preserving this interval. Splitting a legacy baked
clip uses its effective baked file as the halves' source; the original row is retained for Undo.

**Cut speech** in Captions uses the same transaction and history receipt to remove one selected
word's source interval. Previous/Next word buttons provide a native accessible selection path.
The kept ranges share the unchanged media file, retain effects and caption corrections, and have
separate `baseWindow` bounds so Reset cannot reveal the removed speech. Source word timing is
converted from centiseconds to milliseconds and snapped to the probed source frame rate. This
quick action requires at least one frame on each side of the cut; use **Transcript** for larger
selections, edge cuts and whole-beat removal.
Caption **Edit** and **Hide word** continue to change captions only. Preview and export consume
the saved kept ranges, and one Undo/Redo restores/reapplies the cut across reopening and transfer.
Separate draft narration keeps its timeline placement, following the existing voiceover contract;
the speech cut affects the selected source video's picture and sound.

**Transcript** opens a frozen review of the current source words. Select multiple words or use
**Range** to select a passage, in **This beat** or **Whole Pulse**. **Clean up → Analyze** proposes
conservative transcript fillers and actual low-energy audio pauses, with adjustable minimum pause
length and retained breathing space. Transcription models may omit fillers; meaningful words such
as “like” and “so” are not selected by default. Muted/no-audio beats are skipped, and entirely quiet
sources require explicit review. Each candidate can be excluded or auditioned before applying.

Applying unions overlapping, frame-snapped source cuts and stores every retained range in one
SQLite transaction and one persistent Undo step. Source/render, caption-edit and model-transcript
snapshots are checked before any write. A changed review input rejects the whole operation.
Original rows and media remain retained even when every live clip is removed, so Undo still works
after reopening or `.pulse` transfer. Reset cannot expand a retained range through a removed gap.
Separate draft narration remains anchored as above. Quiet-audio detection is not a semantic speech
classifier; review very quiet speech and music-backed recordings before applying its proposals.

One Undo step owns a Timeline split and insertion together. Undo takes the inserted clips and
halves out and restores the unsplit original in one transaction; Redo restores the applied rows,
including their edits, captions and transcripts. Media needed by either form stays held while a
live clip or retained Undo/Redo step references it. A batch uses one split and keeps its additions
in order. Removing the last added clips through Undo keeps the editor open for Redo, with video
export disabled while empty. Draft transfer still carries an empty draft when its Redo stack
retains an addition.

The main toolbar's **Split** tool commits just the two halves at the exact playhead in either
view, without inserting media or entering Edit. It is also available in the selected clip's toolbar.
It is unavailable at existing clip boundaries or the end. This uses
the same metadata transaction and retained original as split-and-insert: one Undo rejoins the
original and one Redo restores the halves, including their captions, transcripts and settings.

Split availability, captured insertion anchors and storage share a 1 ms timeline tolerance at
both clip edges, after applying speed. Positions within that tolerance use the existing boundary;
direct storage splits reject them. This prevents floating-point reconstruction of a fractional
boundary from producing a fragment whose stored duration rounds to zero.

An image batch creates its history step with the first committed clip and extends that same step
beneath any intervening edits. Undo and Redo remain unavailable until the batch finishes or is
canceled. A canceled partial batch keeps one history step for the clips already committed. The
active step stays retained even if intervening edits exceed the normal 100-step history limit;
the limit applies again when the batch closes. Addition Undo checks every recorded clip ID against
storage, so a delayed live-query update cannot discard or partly undo the operation.

Migration 0022 adds `drafts.undo_history`: version 1 JSON containing both stacks and a checkpoint
of the current clip order, sources, edits, edited captions and draft caption position. A draft
without the column's value starts with empty stacks. The checkpoint excludes regenerable covers
and background transcript results, which can finish without changing the edited state. The format
and retention rules live in [`src/db/persisted-history.ts`](../src/db/persisted-history.ts), the
checkpoint in [`src/db/undo-history.ts`](../src/db/undo-history.ts), and the per-draft session in
[`src/features/editor/persistent-editor-history.ts`](../src/features/editor/persistent-editor-history.ts).

- **Close and reopen:** completed stacks survive editor close and app restart. An editor reopened
  while its writes, an image batch or an addition Undo/Redo are still running reuses the same
  per-draft store. Closing the screen does not abandon a partly committed image batch's Undo step.
  PulseKit waits for pending Undo/Redo checkpoints before returning a file-mode project or closing
  its namespace's database. A failed shutdown checkpoint leaves the library open for a retry.
  Automatic close or failure cleanup keeps an empty draft with a retained Redo addition and names
  it in the host result. Explicitly discarding a draft made by the current flow still deletes it.
  A recorder can reopen that empty draft in the editor for Redo; video export requires live clips.
- **Addition Undo/Redo:** the clip rows, their transcripts and the resulting stacks commit in the
  same SQLite transaction. A failed transaction leaves both at the previous state. Dormant Redo
  rows retain their edits, labels, captions and transcripts; split receipts also retain the
  original rows needed to reverse the compound insertion. If another optimistic edit is still
  queued, the row transaction clears the older checkpoint instead of binding the new stacks to
  uncommitted changes; the session saves the resulting stacks once all queued writes settle.
- **Creating additions:** inserting clips or splitting a clip also records its Undo step in the
  row transaction, including recording into an existing draft while its editor is closed. Earlier
  Undo steps survive and the new addition clears Redo. An open editor adopts the committed stacks
  before its UI journal arrives; that journal groups recorder/image additions without recording
  them twice. The database-side writer is in
  [`src/db/addition-history.ts`](../src/db/addition-history.ts).
  Creating a summary establishes its collected clips as the initial baseline with empty stacks;
  subsequent additions and edits use the same durable history as other drafts.
- **Ordinary edits:** edits, reorder and caption writes finish before the stacks are checkpointed.
  A failed queued write invalidates that draft's optimistic stacks. If Pulse is interrupted after a row
  changes but before the checkpoint commits, the stored checkpoint no longer matches the draft:
  the next open discards that stack and keeps the current rows. It never replays a stack against
  different stored edits. This interruption can lose Undo/Redo, but does not roll back saved edits.
- **Transfer:** `.pulse` draft files and library backups carry the saved stacks and every source
  file they require. Export waits for editor checkpoints. A copied/imported draft gets fresh IDs
  throughout the live rows, snapshots, dormant rows and split receipts, and new media references,
  then gets a checkpoint of those new rows in the import transaction. Its Undo/Redo affects only
  the copy. Older files without history remain importable.

The parser rejects unsupported history versions, malformed steps, unsafe paths and dormant rows
owned by another draft. History references are also checked against the owners of live and dormant
clip IDs, so a valid checkpoint for one draft cannot authorize Undo against another draft's clips.
An addition's dormant replay rows must belong to its recorded additions or split receipts;
unrelated rows cannot be replayed under another clip's identity. Recorded additions may already
have been deleted, so a valid replay can contain fewer rows than its original ID list.
A draft transfer with history but missing required video, caption or
transcript source media is refused. Optional thumbnails may be regenerated. When loading or saving
local history, a missing required source removes its step and the farther steps on that stack,
leaving a contiguous usable chain closest to the current draft.

### Undo retention

Each draft retains at most **100 steps across both stacks**, **256 MiB of unique media referenced
only by history**, and **2 MiB of UTF-8 JSON including its checkpoint**. Shared media is counted
once, and a file still used by live rows does not consume the history-only media budget. Eviction
removes the oldest Undo step first, then the farthest Redo step, until all limits hold. An open
image batch can temporarily exceed the step limit in memory; saved checkpoints still enforce all
limits, and the in-memory limit applies again when the batch closes. A single addition that
exceeds the media budget can therefore lose its Redo.

The replacement checkpoint commits before evicted or invalidated history releases its files.
It records eviction candidates in the cleanup list in that same transaction, so a kill before
file deletion leaves a cleanup retry for the next launch.
`referencedMediaPaths` includes the saved stacks, and explicit file deletion checks retained
history as well as live rows and active holds. The launch cleanup list also checks these durable
references, so closing the editor or restarting cannot delete a file that Redo still needs.
History eviction only cleans up files explicitly retained for history; there is no general sweep
of unreferenced library files.

## Summary projects

Home’s **+ → Summary** collects beats from checked projects, an inclusive **From / Through**
calendar date range, or **Since last summary**. The screen previews the included projects
with the same first-clip cover thumbnails as Home, plus their beat count and duration.
With no earlier summary, choose projects or dates first. The last
summary reminder opens that existing project in the editor; a new summary opens in the recorder,
ready to record more beats or export as one update. Blank project creation opens the usual
recorder immediately when **Blank project** is tapped, without another submit step.

The source query excludes every summary project, including duplicates of summaries. Beats
are grouped by source project and keep that project’s timeline order. Files, edit settings,
clip captions and transcripts are copied under fresh IDs and paths; edits and deletion in
either project do not affect the other’s copies. A summary is a collection of existing beats,
with an editable name; this first pass does not generate a written or AI summary.

`segments.addedAt` records when a beat was added. Renaming, editing, reordering, splitting
and Undo/Redo preserve this timestamp; copying a beat into an ordinary project is a new
addition. Date boundaries use the device’s native time zone, including daylight saving
changes. Migration `0021` approximates older beats’ addition dates using their project’s
last-modified timestamp at upgrade, because earlier versions did not record beat timestamps.
Legacy draft imports use the available saved draft date. Exact historical dates cannot be
reconstructed.

`drafts.isSummary` identifies collected projects. A successful collection also stores
`summaryCutoffAt`, frozen when collection starts. **Since last summary** uses the greatest
saved cutoff and includes beat additions in `[previous cutoff, new cutoff)`, so a beat added
in the cutoff’s millisecond waits for the next summary. All collection modes stop at the new
cutoff; their selected project/date restrictions still apply. Creating a summary from only
some projects advances the same checkpoint. Editing that summary does not advance it.
A duplicate keeps the summary marker without a new cutoff. Deleting the most recent summary
falls back to the latest remaining checkpoint; there is no separate hidden checkpoint.

`src/db/summaries.ts` stages all selected media using the recorder’s clip-copy routine, then
commits the new draft, beats, transcripts and cutoff in one SQLite transaction. Missing source
videos, a failed copy or a failed transaction reject the entire collection and clean up the
copies; the previous checkpoint remains. Killing the app while staging may leave unreferenced
files, but cannot leave a partial summary or advance its checkpoint. As with other media,
unreferenced files are preserved for recovery rather than removed by a general sweep.

These schema columns travel automatically in `.pulse` project transfers and library backups.
Imported summary checkpoints participate in the restored library’s next collection.
The first-pass request is tracked in [#331](https://github.com/mieweb/pulse/issues/331);
native UI checks and screenshots are in the [Summary verification record](../screenshots/validation/summary/README.md).

## Voiceover takes

iOS editor **+ → Voiceover** stores narration as independent draft-level audio takes with source
trims and saved video/narration track mutes. Migration `0023`, whole-take Undo, full-draft transfer
and recovery behavior are described in [voiceover.md](voiceover.md). Video clip edits retain the
take's absolute draft position; copying selected clips does not copy narration.

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
sweep. Explicit clip edits/deletions and discarded Undo/Redo steps remove obsolete media only
after checking the live rows, saved Undo/Redo stacks and active history holds; split siblings can
share a file. Files explicitly retained for history are recorded for cleanup on a later launch,
which preserves those still referenced by a saved stack. Draft deletion and, in PulseKit,
[retirement](#retirement-receipt-driven-deletion) remove only unreferenced files in that draft's
folder: another draft can still use its sources in live rows or saved Redo. Active Undo operations
and archives also hold their captured paths. A named deletion journals protected files for a
precise cleanup retry after their last owner releases them. There is
no general deletion sweep for files lacking a row: a damaged, empty or restored database must not
cause videos to be deleted.

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

Draft and library archives hold their exact captured source set before hashing yields to the UI,
through completion of native ZIP creation. Concurrent history eviction or draft deletion cannot
remove those files. Cover generation, including Reset, writes a fresh revision rather than
overwriting a thumbnail already captured by an archive. Deferred explicit deletion candidates
are retried by the launch cleanup journal; unrelated recovery files are never swept.

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

## Namespaces (PulseKit)

Each signed-in person in a host app gets a namespace: `<hostId>-<16 hex>`, where the hex is the
start of SHA-256 over the server origin and the user id (`PulseKitAccounts.swift`; Node computes the
same values in `embed/native/ios/namespace-vectors.json`). The host's `setAccount` picks it; the
facade creates the folders before Pulse's JavaScript starts, and hands their paths to
`setStorageRoots` (`src/utils/storage-root.ts`) as the runtime's initial props.

```
Library/PulseKit/<ns>/            documents root: SQLite/pulse.db, drafts/, results/,
                                  catalog.json, account.json, logs/pulse.log
Library/Caches/PulseKit/<ns>/     caches root
Library/PulseKit/.shared/models/  captions models, shared by every namespace
```

- **One namespace per runtime.** The storage roots and the open database are fixed for the life of
  Pulse's React Native runtime. `setAccount` for another person after the runtime started answers
  `restart_required`; the facade's own reads switch to the new namespace at once, so a shared phone
  never shows the last person's drafts.
- **Backups and file protection.** `Library/PulseKit` is excluded from iCloud and device backups.
  Every folder and file in it is `NSFileProtectionCompleteUntilFirstUserAuthentication`, whatever
  the host's default, so a background upload can read a video with the phone locked.
- **The facade never opens SQLite.** It reads `catalog.json`, `results/` and `account.json`, which
  Pulse's JavaScript writes, and `npm run check:embed` fails on `sqlite3_open` in native code.
- **Purge** (`purge({ namespace })`) deletes a namespace's two folders. If the runtime has that
  library open, the facade first asks Pulse's JavaScript to close it (`releaseLibrary`) and starts a
  fresh runtime for whatever comes next. Release pauses uploads, waits for every upload pass
  (including one awaiting a host reply), then flushes edits and Undo checkpoints before closing
  SQLite. A failed checkpoint leaves the library open for retry. The shared models go only with
  the last namespace.
- **PR1's `<hostId>-local`** (the single namespace before accounts) is never adopted into an
  account. It is deleted when empty, and otherwise listed by `listNamespaces` for the host to purge.

### `catalog.json`

The facade answers `listDrafts`, `getDraft`, `countDrafts` and `usage` from `catalog.json`, without
starting Pulse. Pulse's embedded runtime writes it (`src/features/drafts/catalog-writer.ts`) at boot
and 250 ms after a change to a table it is projected from: drafts, clips, transcripts, jobs,
receipts and the settings that decide `ready` and `hasCaptions`. Only the embedded runtime writes
it; the Pulse app has none.

Each write goes to `catalog.json.part` and is then moved over `catalog.json`. expo-file-system's
move deletes the target first, so in that gap, or after a kill inside it, the `.part` is the only
whole catalog: the reader takes `catalog.json`, else the `.part`, and the next write moves a whole
`.part` back into place before it starts. The rule is `readCatalogFile` in
`src/features/drafts/catalog-filter.ts`, and the Swift reader passes the same vectors
(`src/features/drafts/__vectors__/catalog.json`).

## Host context on drafts

Migration 0020 gives each draft the host place it was recorded for: `context_key` (indexed),
`context_label`, `context_json` and `upload_type_json`, plus `created_via` (`app` or `host`),
`host_confirmed_at` and `sent_at`. `src/db/host-context.ts` checks a context before it is stored:
the key at most 128 characters, the label at most 120, each JSON column at most 8 KB.

- A `.pulse` draft file carries `created_via` but not the place, the confirm or the Send time:
  a draft opened on another phone, or duplicated, is a plain draft again.
- A draft whose Send was confirmed by the host (a clock type, `host_confirmed_at` set) can't be
  moved to another place: `setDraftContext` answers `draft.locked` with reason `clock_bound`.

## Local tables

`upload_jobs`, `upload_receipts` and `local_settings` belong to this phone (`LOCAL_TABLES` in
`src/db/project.ts`):

| Table             | Holds                                                                            | Restore                         |
| ----------------- | -------------------------------------------------------------------------------- | ------------------------------- |
| `upload_jobs`     | One row per sent draft that hasn't retired: the outbox. Cascades with its draft. | Goes with the replaced drafts.  |
| `upload_receipts` | A retired draft's name, place, outcome and dates, for 7 days. No media.          | Kept.                           |
| `local_settings`  | The installation id (made on first use) and the Wi-Fi-only choice.               | Kept.                           |

- No `.pulse` file or library backup carries them, and an import that names one is refused as
  damaged. A backup restored on another phone must not give two phones one installation id, or
  send the first phone's uploads again.
- The export coverage check still covers their columns, so a new column needs a scope like any
  other.

## Upload outbox (PulseKit)

An embedded draft's upload state is its `upload_jobs` row and nothing else (the Pulse app keeps
using `drafts.upload_status`). Every change is an event decided by the pure `nextJobState` and
written with the draft's `sent_at` / `host_confirmed_at` in one synchronous transaction
(`src/features/upload/core/outbox.ts`). The job loop (`runner.ts`) and the host's commands send the
events.

```mermaid
stateDiagram-v2
  direction LR
  [*] --> preparing: Send
  preparing --> queued: merged, files written (host confirmed, for confirmSend types)
  preparing --> [*]: confirm failed, or over maxBytes
  preparing --> failed: merge failed
  queued --> uploading: host gave a target
  queued --> delivering: server already has the video (a resend after a kill)
  uploading --> queued: network or server error (backoff 5 s doubling, at most 15 min)
  uploading --> delivering: video bytes landed
  queued --> needs_credentials: host silent 20 s, signed out, or token expired
  uploading --> needs_credentials: host silent 20 s, signed out, or token expired
  needs_credentials --> queued: resume
  queued --> failed: destination.gone, upload.refused, upload.too_large
  uploading --> failed: destination.gone, upload.refused, upload.too_large
  delivering --> Retired: the host's outcome (done or kept)
  queued --> [*]: cancel, rename, edit, Move to, delete
  uploading --> [*]: cancel
  needs_credentials --> [*]: cancel, rename, edit, Move to, delete
  failed --> preparing: Send again
  failed --> [*]: cancel, rename, edit, Move to, delete
```

- **Keys.** `draftKey` is `<installationId>:<draftId>`, the same for every Send of the draft.
  `clientKey` adds the first 16 hex of SHA-256 over the merged signature, so an edit makes a new
  one. The server cancels an older `clientKey` with the same `draftKey`.
- **The lock.** While a job is `preparing`, `uploading` or `delivering`, a rename, an edit, Move to
  and Delete refuse with `draft.locked` (`cancelUpload` still works while `uploading`). On a
  `queued`, `needs_credentials` or `failed` job they first take the job out (`cancelJob`): the
  host's target is released and the job's TUS uploads are deleted.
- **What a Send freezes.** The merged signature, and the send files under `drafts/<id>/send/`
  (captions, beat manifest, thumbnail), so a resumed upload sends the bytes the person sent.
- **Tokens stay in memory.** A job stores the token's expiry, never the token. After a relaunch the
  loop asks the host again (`refreshUploadToken`).
- **The launch rule** runs at boot and on `resumeOutbox`: a Send stopped while `preparing` never
  happened (its job is removed); unfinished retirements are finished; background PATCHes iOS kept
  running are waited for; then each job asks PulseVault's status route before it HEADs and resumes.
  A job whose namespace isn't the signed-in one doesn't run.

## Retirement: receipt-driven deletion

A sent draft's media is deleted only after PulseVault's status route reports the host's outcome
(`done`, or `kept` in the person's library). The draft then becomes a receipt
(`src/features/upload/core/retire.ts`):

```mermaid
flowchart TD
  outcome[Status route reports done or kept] --> tx[One transaction: insert the receipt, delete the draft; the cascade takes its clips, transcripts and job]
  tx --> folder[Delete unreferenced files in drafts/id/]
  folder -- deleted --> mark[Receipt records media_deleted_at]
  folder -- shared files remain, deletion fails or app is killed --> launch[Next launch: retry every receipt without media_deleted_at]
  launch --> folder
  mark --> expire[After 7 days the receipt is deleted]
```

- Nothing deletes a folder that no receipt names, and nothing retires a draft before the host has
  the video. A kill between the transaction and the folder is finished at the next launch.
  Shared sources and active archive/Undo holds keep cleanup pending until those references are
  gone; `media_deleted_at` is recorded only when the folder is completely removed.
- In `uploadMode: 'file'`, the host's `retireDraft` retires the draft the same way, with outcome
  `done`, as soon as it asks; in `'pulse'` mode it is only a hint, and the status route decides.
- `dismissReceipt` stops a `kept` receipt counting for attention; it doesn't shorten its 7 days.

## A library a newer PulseKit migrated

PulseKit may meet a library that a newer PulseKit already migrated (a host downgraded its
plugin). In the embed, Pulse then runs no migrations and no housekeeping on it
(`guardNewerSchema`, `src/db/client.ts`): it still lists, sends and deletes, while every write that
creates or edits a draft rejects with `storage.newer_schema`. The catalog says `readOnly`. The Pulse
app is unchanged: it refuses a newer backup and migrates an older one.
