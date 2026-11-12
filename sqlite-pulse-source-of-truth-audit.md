# SQLite and Pulse archive source of truth audit

**At the audited baseline, SQLite was authoritative and could not be discarded without losing data.** The v1 `.pulse` draft archive was an explicitly requested transfer snapshot, not an automatically maintained project file. It omitted manual caption corrections, caption placement, generated transcripts, clip labels, historical badge counters, identities, app preferences and upload associations. Its importer also changed some state that the archive did contain.

The required end state is: **every acknowledged save is durable in canonical Pulse files; SQLite is a disposable projection that can be rebuilt offline without losing project or application state.** Recomputable caches may be recreated, but regenerating a transcript is not equivalent to preserving the transcript the person edited.

**Current implementation priority:** the ordered [canonical Pulse persistence checklist](./sqlite-pulse-implementation-plan.md) turns this audit into implementation work. Complete its standalone migration, canonical-write coverage and offline rebuild release gate before native or browser embedding implementation. The milestones below remain acceptance requirements, not completed work; record implementation evidence in that checklist. The repository rules are in [AGENTS.md](./AGENTS.md).

**Implementation update:** this branch now contains a [live YAML/media package, typed document and SQLite projection design](./sqlite-pulse-persistence-design.md), with targeted codec, transaction, transfer and isolated rebuild tests. The findings below retain their recorded baseline meaning; they do not describe the updated v2 serializer or claim that the remaining native release gates have passed.

Audited 2026-11-12 against Pulse application source at `26bd538b145c94ee55f8e3355496a39a63782760` (Pulse 2.6.0; `.pulse` draft-bundle version 1). This is a schema and persistence-code audit, with all 20 SQL migrations replayed into an empty in-memory database. It does not enumerate rows from an installed phone or modify a user's database/media. The companion plans are [native embedding](./native-embed-component-plan.md) and [browser embedding](./html-embed-editor.md).

## What the current Pulse files contain

Two different artifacts currently use the `.pulse` extension:

- **Draft transfer:** a ZIP containing `manifest.json` and `media/*.mp4`, identified by `format: "pulse-draft-bundle"`, `version: 1`. This is the archive compared with SQLite throughout this audit.
- **Uploaded beat manifest:** a JSON file named `<draftId>-beats.pulse`, identified by `type: "beat-manifest"`. It contains clip boundaries on the finished video's timeline. It is not a complete project or a database backup.

Sources: [draft manifest](./src/features/draft-transfer/manifest.ts), [packer](./src/features/draft-transfer/pack.ts), [upload artifact creation](./src/features/upload/upload-manager.ts), [beat manifest](./src/features/upload/beat-manifest.ts).

The draft ZIP has equivalents for only eight database columns. That is field coverage, not a guarantee that those values or their media restore unchanged.

| Current application table | Columns | Manifest equivalents | Omitted columns |
| ------------------------- | ------: | -------------------: | --------------: |
| `drafts`                  |      13 |                    2 |              11 |
| `segments`                |      11 |                    6 |               5 |
| `draft_transcripts`       |       8 |                    0 |               8 |
| `clip_transcripts`        |       6 |                    0 |               6 |
| `settings`                |       2 |                    0 |               2 |
| `upload_destinations`     |       8 |                    0 |               8 |
| **Total**                 |  **48** |                **8** |          **40** |

These are the six application tables after migrations `0000` through `0019`. Drizzle's separate schema journal and SQLite internals are addressed below. The column source is [schema.ts](./src/db/schema.ts), checked against the actual migrated schema rather than counting TypeScript declarations alone.

## Every application column and its archive coverage

“Durable” means the information needs an authority outside SQLite to meet the requested guarantee. “Derived” means it may be recreated from preserved inputs; its old SQL value need not survive. Device and upload state are included explicitly: excluding them would narrow the guarantee to projects rather than making the whole database disposable.

### drafts

| SQLite column        | Current archive and restore                            | Required treatment                                                                                                           |
| -------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | Omitted; import mints a timestamp-based draft ID.      | Preserve canonical project identity. Stable IDs also reconnect saved viewing links.                                          |
| `name`               | `drafts[].name`; restored.                             | Durable user title, including null versus an explicit value.                                                                 |
| `upload_server`      | Omitted.                                               | Durable destination/receipt association; not a rendering cache.                                                              |
| `upload_artifact_id` | Omitted.                                               | Durable external artifact identity.                                                                                          |
| `upload_status`      | Omitted.                                               | Preserve completed upload history. Recover/reconcile an interrupted `uploading` operation rather than blindly restarting it. |
| `context_server`     | Omitted.                                               | Durable host/place association used to reopen the correct unsent draft.                                                      |
| `context_ref`        | Omitted.                                               | Preserve with its server; the pair identifies the host's place.                                                              |
| `merged_signature`   | Omitted.                                               | Derived export-validity key; rebuild/invalidate from canonical media and edits.                                              |
| `merged_duration_ms` | Omitted.                                               | Derived measured export duration; reprobe/recompute for that export revision.                                                |
| `caption_y`          | Omitted; import uses default placement.                | Durable user-dragged caption position; preserve null/default semantics.                                                      |
| `last_clip_number`   | Omitted; import replaces it with surviving clip count. | Durable monotonic counter, including numbers belonging to deleted clips. Cannot infer from remaining clips.                  |
| `created_at`         | `drafts[].createdAt`; numeric values restored.         | Durable creation metadata.                                                                                                   |
| `last_modified`      | Omitted; replaced with import time.                    | Durable modification metadata; rebuilding an index must not make every draft newly modified.                                 |

### segments

| SQLite column        | Current archive and restore                                                                 | Required treatment                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | Omitted; import creates a new ID per archive slot.                                          | Stable canonical clip identity.                                                                                                                     |
| `draft_id`           | Relationship represented by nesting; original ID omitted.                                   | Restore the same project/clip relationship and identity.                                                                                            |
| `sort_order`         | `segments[].order`; import sorts, then renumbers to `0…n-1`.                                | Preserve logical order. Preserve numeric slots too if exact row reconstruction is required.                                                         |
| `label`              | Omitted; recreated as `"1"…"n"`.                                                            | Durable badge/name, including gaps and future renames.                                                                                              |
| `original_filename`  | Media copied to an archive path, then to a newly named local file; import can re-encode it. | Preserve immutable original bytes and canonical asset identity. Physical sandbox paths may be derived. Shared source references must remain shared. |
| `duration_ms`        | `durationMs` is written; import replaces it with a native duration probe.                   | Keep source timing metadata needed for edit interpretation. Distinguish canonical source metadata from backend measurements.                        |
| `edited_filename`    | Baked media included only when `editedFilename && !editState`; otherwise omitted.           | A legacy baked asset can be authoritative and unreproducible. Preserve it whenever selected/referenced; see the confirmed loss case below.          |
| `edited_duration_ms` | Serialized only for included baked media; ignored/recomputed on import.                     | Derive settings-based timeline duration; preserve/probe the selected legacy asset's source duration without changing edit meaning.                  |
| `edit_state`         | Serialized as a string; import can null invalid settings, clamp trims or remove crop.       | Durable non-destructive edit instructions. Restore must preserve accepted instructions and their source, not silently normalize them.               |
| `thumbnail`          | Omitted; regenerated.                                                                       | Derived under current behavior: no separate user-selected poster field was found. Exact old JPEG bytes are not guaranteed.                          |
| `caption_edit`       | Omitted.                                                                                    | Durable manual text, timing, deletion and sentence-boundary corrections, plus the media they describe. An empty word list can be intentional.       |

Sources for draft/clip behavior: [draft mutations and import insertion](./src/db/drafts.ts), [caption writes](./src/db/captions.ts), [media paths](./src/utils/file-store.ts), [render precedence](./src/utils/segment-window.ts), [unpacker](./src/features/draft-transfer/unpack.ts).

### draft_transcripts

All eight columns are omitted. This legacy table may still hold manual edits awaiting adoption into per-clip captions; exporting cannot assume adoption has happened.

| SQLite column  | Meaning and required treatment                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draft_id`     | Identity of the project whose merged timeline was transcribed; retain its canonical relationship.                                                                                                       |
| `signature`    | Validity discriminator binding transcript/corrections to a particular timeline. Preserve enough revision/source provenance to interpret old edits safely; the cache-key string can later be recomputed. |
| `model`        | Transcript model provenance; preserve for faithful recovery.                                                                                                                                            |
| `status`       | `processing`/`done`/`error`; runtime state can be reconciled, but do not turn failed/unfinished work into an accepted empty transcript.                                                                 |
| `lines`        | Generated merged transcript, including optional word timings. Preserve accepted output for exact/offline recovery.                                                                                      |
| `edited_lines` | Hand-edited merged captions. Preserve before migration; stale edits must not be silently destroyed during a claimed lossless rebuild.                                                                   |
| `duration_ms`  | Measured merged duration used to interpret timeline timestamps; retain the relevant timing context.                                                                                                     |
| `created_at`   | Transcript creation/provenance timestamp; not inferable exactly from media.                                                                                                                             |

[adoptMergedCaptionEdit](./src/db/transcripts.ts) migrates matching-signature edits to clips and deletes the old row. It can discard stale rows; that is existing application behavior, not proof that an archive already preserved them. A zero-loss migration must retain original legacy data or record an explicit migration outcome before disposal.

### clip_transcripts

All six columns are omitted. Although AI output is computationally derived, rerunning inference may be unavailable offline or produce different text/timings with another model, engine or version. A strict recovery guarantee must preserve the accepted generated baseline as well as manual corrections.

| SQLite column | Meaning and required treatment                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `segment_id`  | Clip relationship; map to a stable canonical clip/source identity.                                                |
| `model`       | Model identity; retain provenance and distinguish multiple model outputs.                                         |
| `file`        | The actual original or baked source whose timebase the words use; retain a stable asset reference.                |
| `status`      | `done`/`error`; completed empty output differs from a failed job. Preserve/reconcile that distinction.            |
| `words`       | Generated word text and source timestamps; preserve accepted output, including an intentionally speech-free `[]`. |
| `created_at`  | Creation/provenance timestamp; preserve for complete record restoration.                                          |

Sources: [clip transcript persistence](./src/db/clip-transcripts.ts), [native transcript units](./src/features/transcription/whisper.ts).

### settings

| SQLite column | Current archive and restore | Required treatment                                                                                                                                              |
| ------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`         | Entire table omitted.       | Preserve app preferences and operational records in an authoritative library/app-state document. Do not silently discard unknown/retired keys during migration. |
| `value`       | Entire table omitted.       | Preserve values with their keys; reconstruct derived/migration values through a documented policy.                                                              |

There are **19 concrete keys currently referenced by the application**: 12 fixed keys, four tip keys and three migration keys. Generic setters accept arbitrary strings, so an installed database may contain additional historical keys.

| Key                                  | Stored information                                           | Consequence of losing it                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `transcription.model`                | Selected transcription model ID.                             | Loses user choice; can change whether/how captions are generated.                                                                                |
| `onboarding.complete`                | First-run flow completed/skipped.                            | Repeats onboarding and affects deferred pairing logic.                                                                                           |
| `appearance.theme`                   | System/light/dark preference.                                | Loses preference.                                                                                                                                |
| `camera.facing`                      | Front/back preference.                                       | Changes recorder behavior.                                                                                                                       |
| `camera.stabilization`               | Stabilization preference.                                    | Changes recorder behavior; platform validation still applies on another device.                                                                  |
| `camera.muted`                       | Recorder audio preference.                                   | Changes recorder behavior.                                                                                                                       |
| `editor.view`                        | Clips/timeline preference.                                   | Changes editor's initial view.                                                                                                                   |
| `editor.customSpeeds`                | Legacy custom-speed menu entries.                            | Loses user choices; current code reads but no longer writes this key.                                                                            |
| `recorder.format.v2`                 | Device-learned video/audio compatibility profile.            | Relearnable derived configuration, but not exactly recoverable from an arbitrary project archive. Do not apply another device's profile blindly. |
| `pairing.trustedServers`             | Explicit trusted hostname choices.                           | Loses “Don't ask again” decisions. Preserve for same-install recovery; portable import must not silently grant a new device trust.               |
| `pairing.handledLinks`               | Last 200 paired/refused artifact outcomes.                   | Loses replay/idempotency history; an old Android launch intent can be processed again.                                                           |
| `pairing.deferredChecked`            | Install-referrer/pasteboard check completion or retry count. | Repeats an external check or changes retry behavior.                                                                                             |
| `tip.record`                         | Tip retired/seen.                                            | Tip can reappear.                                                                                                                                |
| `tip.clips`                          | Tip retired/seen.                                            | Tip can reappear.                                                                                                                                |
| `tip.edit`                           | Tip retired/seen.                                            | Tip can reappear.                                                                                                                                |
| `tip.captions`                       | Tip retired/seen.                                            | Tip can reappear.                                                                                                                                |
| `dataMigration.legacy-drafts-import` | Legacy storage migration completed.                          | May rerun a file-moving/deleting migration. Rebuild needs authoritative migration/version context.                                               |
| `dataMigration.drop-baked-edits`     | Baked-edit migration completed.                              | May rerun asset cleanup; an empty index is not deletion authorization.                                                                           |
| `dataMigration.drop-draft-tokens`    | Retired token cleanup completed.                             | May rerun credential cleanup.                                                                                                                    |

Sources: [settings helpers](./src/db/settings.ts), [custom speeds](./src/features/editor/editor-speeds.ts), [recorder profile](./src/features/recorder/recorder-format.ts), [trusted servers](./src/features/upload/trusted-servers.ts), [handled links](./src/features/upload/handled-links.ts), [deferred pairing](./src/features/upload/deferred-pairing.ts), [tip IDs](./src/features/tips/tips.ts), [data migrations](./src/db/data-migrations.ts).

### upload_destinations

All eight columns are omitted. This is a device-wide pool of paired, unconsumed destinations, not information owned by a single project.

| SQLite column | Meaning and required treatment                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `id`          | Stable local destination UUID and lookup key for its separately secured token. Preserve the binding. |
| `server`      | Destination server. Preserve non-secret metadata.                                                    |
| `artifact_id` | Server-minted, single-use upload identity. Preserve and reconcile whether consumed.                  |
| `ref`         | Optional host place identifier; preserve together with server.                                       |
| `label`       | Place display name. Preserve.                                                                        |
| `app`         | Host application name. Preserve.                                                                     |
| `return_url`  | Host page to return to after upload. Preserve.                                                       |
| `created_at`  | Destination creation/order metadata. Preserve.                                                       |

Source: [destination claims, replacement and expiry](./src/db/destinations.ts). A per-project `.pulse` alone cannot restore this global pool. The literal whole-database guarantee needs a canonical library/app-state record, for example a private library `.pulse` profile containing projects plus device metadata.

## Migration journal and internal database state

Drizzle creates an additional `__drizzle_migrations` table with `id`, `hash` and `created_at`. These three columns record applied schema migrations, not user/project state, and are outside the 48 application-column count. They can be recreated when constructing a new index from the shipped schema. The separate `dataMigration.*` settings above govern file/credential operations and require recovery-aware handling; recreating a schema journal does not make those operations safe to replay.

The two explicit unique indexes are `segments_draft_order_unique(draft_id, sort_order)` and `upload_destinations_server_ref_unique(server, ref)`. Primary-key indexes, SQLite catalogs/rowids/statistics and database/WAL/SHM representation are implementation details. Recreate required constraints and enable `PRAGMA foreign_keys = ON` on each connection.

Historical `projects`, `transcripts` and `upload_artifacts` tables do not remain after the current migrations. The temporary `segment_ranked` table is also dropped. Removed legacy columns, including old plaintext token/resumable-upload fields, are not hidden current columns; still-present legacy input belongs in the migration inventory rather than being assumed to exist in the current schema.

Sources: [migration imports](./drizzle/migrations.js), [schema migrations](./drizzle), [connection initialization](./src/db/client.ts), installed Drizzle SQLite dialect/migrator code. The in-memory replay confirmed the current application table/column set.

## State outside SQLite that recovery depends on

| Storage                                         | State                                                                      | Recovery requirement                                                                                                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document files                                  | Original videos and unreproducible legacy baked edits.                     | Preserve bytes, stable asset IDs, hashes and reference relationships. Settings alone cannot recreate an arbitrary baked file.                                                                                                                                    |
| Document/cache derivatives                      | Thumbnails, merged `export.mp4`, waveform/filmstrip caches.                | Generally rebuildable from authoritative media/settings; regenerated export bytes need not be identical across encoder versions. Preserve a previously published exact artifact separately if exact bytes are required.                                          |
| SecureStore `upload.dest.token.<destinationId>` | Destination capability.                                                    | Preserve canonical destination IDs/references so retained credentials remain reachable. Credentials remain in protected storage rather than being silently copied into a shared plaintext project.                                                               |
| SecureStore `upload.view.<draftId>`             | Saved viewing URL and expiry.                                              | Preserve project IDs and completed-upload metadata; startup currently finds these links by enumerating SQL drafts marked uploaded.                                                                                                                               |
| SecureStore `upload.token.<draftId>`            | Retired draft tokens, cleanup only.                                        | Treat as legacy migration input, not a current project field.                                                                                                                                                                                                    |
| Model files                                     | Downloaded speech models.                                                  | Re-downloadable when available; preserving transcript output avoids needing inference/model downloads just to rebuild SQLite.                                                                                                                                    |
| Legacy AsyncStorage/files                       | `recording_drafts`, `upload_config_*`, `redo_stack`, old media tree.       | Migration inputs are moved/deleted; they are not a surviving backup of the current database.                                                                                                                                                                     |
| Process memory                                  | Pending editor writes, current undo/redo stacks, upload run/session state. | Not currently durable. Define acknowledged-save and undo guarantees; queued-but-uncommitted actions must not be presented as durable saves. In-flight network work needs a durable intent/receipt record plus server reconciliation if resumability is required. |

Sources: [file store](./src/utils/file-store.ts), [secure references](./src/db/secure-token.ts), [model storage](./src/features/transcription/model.ts), [legacy migration](./src/db/legacy-migration.ts), [pending writes](./src/features/editor/draft-writes.ts), [session history](./src/features/editor/use-editor-history.ts), [upload recovery](./src/features/upload/upload-manager.ts).

The goal “delete SQLite and recover” can retain OS-protected credentials while rebuilding their index references. The broader goal “restore everything from one shared file on a fresh device” requires an explicit protected credential migration/re-pairing policy; a project ZIP does not currently provide it. Device preferences and completed history must not be called caches merely because they are outside the editing timeline.

## Confirmed fidelity and durability gaps

### The archive is not the live save target

[shareDrafts](./src/features/draft-transfer/use-draft-transfer.ts) creates `.pulse` only on explicit Share. [pack.ts](./src/features/draft-transfer/pack.ts) writes to `Paths.cache/pulse-exports` and deletes that directory on the next export. Sharing does not ensure a durable external copy was saved. There is no canonical `.pulse` autosave path updating after each edit.

[useEditorDraft](./src/features/editor/use-editor-draft.ts) explicitly says the database stays the truth. [draft-writes.ts](./src/features/editor/draft-writes.ts) queues edits/orders in memory and persists through SQL helpers. A database loss after an ordinary edit can lose that edit even if an older `.pulse` exists. A richer manifest alone does not fix this.

Recording persists a file before inserting its clip row; deletions remove rows before media cleanup. There is no canonical document revision coordinating the two. Durable staged commits and recovery are required, including when a crash occurs between file and metadata operations.

### Selected legacy media can be omitted

The current renderer selects `editedFilename` whenever present, including when `editState` is also truthy. The packer includes that baked file only if `!editState`. The baked migration deliberately retains a baked file when its settings cannot reproduce it.

Confirmed fixture: a clip has an original, a baked edit, and truthy invalid settings. The actual renderer selects the baked edit; the actual packer emits only the original and invalid settings. Import rejects those settings and restores the original. The active video edit is lost. Valid both-field states can also select a different rendering path after transfer.

Sources: [clipRender](./src/utils/segment-window.ts), [baked migration](./src/db/baked-edits-migration.ts), [packer](./src/features/draft-transfer/pack.ts), [import settings precedence](./src/features/draft-transfer/unpack.ts).

### Importing a copy changes identity and timing

The importer creates new draft/clip IDs, renames media, renumbers order slots, regenerates labels/counters and resets modification times. Shared originals are packed and written separately per segment, losing the original asset-sharing relationship. Empty drafts are dropped.

It can conform/re-encode original and baked files in place, reprobe durations, remove crop, clamp trim endpoints or replace an invalid range with the entire clip. Original archive bytes are not retained as an untouched canonical original in the imported library. Adding transcripts to this importer without handling timing changes can misalign words.

A restore/rebuild operation must preserve accepted media and logical state. “Import a copy” can retain its separate, intentional transformations, but cannot be reused as exact cache hydration. Source: [unpack.ts](./src/features/draft-transfer/unpack.ts), [normalization policy](./src/utils/import-normalization.ts), [duration probes](./src/utils/video.ts).

### Partial success can hide omissions

- Export skips missing drafts/originals, drops empty drafts and can omit a missing baked file while retaining the original. It can produce a successful but incomplete archive.
- Import skips missing/unreadable/nonconformable clips and commits per draft. General draft-level exceptions are logged without adding a corresponding skipped-draft entry; another successful draft can make the overall result appear successful without reporting that omitted draft.
- Export has no matching 1 GiB limit, while import rejects both archive size and declared expanded total above 1 GiB. Export can therefore produce an archive this importer refuses. The current implementation also holds media/ZIP data in memory.
- Manifest validation accepts any numeric version, including `999`; there is no version-specific restore dispatcher. It has no explicit asset hash/size manifest or complete field validation. ZIP checks alone do not establish a complete project snapshot.
- Export does not explicitly flush the editor's pending-write queue or acquire one consistent metadata/media revision. Draft and clip rows are queried separately and files are read later. The transfer busy flag gates transfers, not all project mutations.

Sources: [pack.ts](./src/features/draft-transfer/pack.ts), [unpack.ts](./src/features/draft-transfer/unpack.ts), [manifest validation](./src/features/draft-transfer/manifest.ts), [export reads](./src/db/drafts.ts), [editor MP4 export flush](./src/app/editor.tsx).

### Migration and cleanup need a rebuild mode

SQLite opens at module import. Schema/data migrations and a legacy `trimmedVideo*` file sweep run before normal UI; migration completion markers are themselves in SQLite. Some migrations move/delete old files or baked media. A rebuild must first establish canonical project/library state and must not interpret missing cache rows as deletion intent.

No generic startup sweep deleting all current raw drafts merely because SQLite is empty was found. The identified risk is replaying migration/cleanup paths without authoritative version/reference information, not an observed universal delete-on-empty operation.

Sources: [client](./src/db/client.ts), [startup gate](./src/db/migrate.tsx), [migration completion](./src/db/data-migrations.ts), [legacy cleanup](./src/db/legacy-migration.ts), [baked cleanup](./src/db/baked-edits-migration.ts).

## What is safely disposable

- SQLite table/index structures, row layout, foreign-key connection configuration and the schema migration journal.
- Thumbnails and filmstrip/waveform derivatives under current product behavior.
- Merge validity keys and regenerable export caches, provided source media, edits, output configuration and accepted transcripts are already preserved.
- Processing flags that are reconciled into explicit retry/interrupted states rather than mistaken for completed output.

Generated transcript baselines, user edits, label/counter history, preferences, host context, paired destinations and completed upload history are not safely disposable without another authoritative copy. Session undo is currently not persisted in SQLite either; preserving it requires a new explicit contract rather than claiming it already round-trips.

## Required source of truth design

1. **Canonical project files.** Persist complete versioned documents, accepted transcripts/corrections, immutable media and stable identities in durable document storage. Keep SQLite as an index/projection of those files. Save success means the canonical revision has committed, even if an index update later fails.
2. **Canonical library and app state.** Preserve project discovery, deletions/tombstones, settings, destination metadata and upload intents/receipts outside SQLite. To satisfy the literal all-database goal, define a private library `.pulse` profile containing these records; individual project archives provide project recovery only. Preserve unknown historical settings/legacy records through migration before any deliberate retirement.
3. **File durability protocol.** Stage media, validate complete references, commit the new document/archive revision with verified platform-appropriate atomic replacement/recovery, then update SQLite. Rebuild a stale index from the latest valid revision. Garbage collection follows committed tombstones/reference checks, never absence from an empty index.
4. **Literal ZIP guarantee.** If the `.pulse` ZIP file itself must contain every acknowledged save, update that file durably before acknowledging each save. Benchmark archive rewrite/append/compaction cost with large/shared assets. An external authoritative journal or unpacked live package would need to be explicitly part of the format/guarantee; it cannot be hidden behind a claim that an older ZIP alone is current.
5. **Separate restore and import.** Restore retains identities, original bytes and timing. Portable import-copy may create identities or normalized working derivatives, but retains the original canonical source and reports all changes. Unknown versions, missing assets or corruption must not yield a claimed complete recovery.
6. **Shared transcript data.** Base the new neutral transcript schema on MediaEditor's millisecond word shape, adding stable IDs, source/model provenance and sentence boundaries. Preserve generated baseline, corrections and media-edit instructions distinctly. Convert legacy native centiseconds at the boundary without discarding canonical millisecond precision; core must not depend on UI runtime code.
7. **Recovery before side effects.** Pause migration cleanup, transcription, upload recovery and GC until canonical files have been validated and a temporary index rebuilt. On a failed rebuild retain canonical files and offer recovery; never replace them with an empty library. Reconnect retained SecureStore references using canonical IDs.

The existing embedding estimates predate this broader persistence work. Re-estimate after the canonical-save/large-media spike; do not represent adding manifest fields as completing this design.

## Three acceptance milestones

### Milestone 1 Complete format and read only recovery proof

- [ ] Account for every column and setting above in a versioned project/library schema or an explicit derived-state policy. Preserve legacy raw records until migration is verified.
- [ ] Specify source IDs, media hashes/byte sizes, shared assets, generated transcripts, corrections, caption position, labels/counters, timestamps and app state. Specify credentials as protected references and define the limits of fresh-device recovery.
- [ ] Keep importing v1 with an explicit “transcript and other state absent” result. Reject unsupported newer formats rather than accepting and discarding fields.
- [ ] Implement a non-mutating reader/validator and a temporary-index builder. Demonstrate reconstruction of fixtures without calling the copy/conforming importer or modifying originals.
- [ ] Benchmark durable saves for the literal ZIP requirement, including a large project, shared originals and a metadata-only edit. Publish measured save latency/memory and revised estimates.

### Milestone 2 Canonical writes and crash recovery

- [ ] Route every durable mutation through canonical commit: recording/import, edits/order, captions/model output, labels/counters, rename, preferences, host/destination state, upload completion and deletion.
- [ ] Resolve a save only after authoritative commit; update/invalidate SQLite afterward. Report disk-full/write failure without falsely acknowledging the edit.
- [ ] Preserve original and active legacy baked assets, including both-field/invalid-settings cases. Fix and regression-test the confirmed packer omission.
- [ ] Preserve empty drafts, explicit empty corrections, unknown retained metadata and all shared asset references. No successful snapshot silently skips expected records.
- [ ] Introduce crash-safe revision selection and tombstones. Verify file staging, canonical commit, index update and post-commit cleanup interruptions independently.
- [ ] Gate old migrations and GC on canonical version/reference state; prevent an absent index from triggering destructive reconciliation.

### Milestone 3 Delete SQLite and prove zero logical data loss

- [ ] Create fixtures exercising all six tables, all current setting keys, unknown historical settings, generated/manual/legacy captions, accepted fractional-millisecond word timings, deleted badge gaps, empty drafts, shared originals and legacy baked assets.
- [ ] After acknowledged saves, close database/process handles, remove the disposable database plus WAL/SHM in an isolated test sandbox, and rebuild offline from canonical files. Never run this against a user's current library.
- [ ] Compare canonical IDs/revisions, project/app state, word timings, edits, labels/counters, timestamps, context/history and exact original/legacy media hashes. Derived images/merge caches may be regenerated under documented rules.
- [ ] Repeat for corrupt/stale SQLite, interrupted rebuilds, disk-full, missing/corrupt assets and unsupported schema versions. Canonical files remain intact; incomplete recovery is explicit.
- [ ] Verify deletion tombstones prevent resurrection and stable IDs reconnect retained SecureStore links/tokens. Reconcile interrupted uploads without duplicating completed artifacts or presenting a stale `uploading` flag as a live session.
- [ ] Run native/browser fixture parity and archive export → restore → canonical re-export comparisons. Do not claim this milestone from existing unit tests alone.

## Validation completed for this audit

- Replayed all 20 committed SQL migrations into `node:sqlite` `:memory:` with foreign keys enabled: six application tables, 48 columns, current foreign keys and unique indexes confirmed.
- Executed the actual TypeScript packer, manifest validator and render-selection helper in a synthetic Node fixture with mocked Expo filesystem/database reads. Confirmed that an active baked asset is omitted when invalid settings are truthy; the resulting ZIP contains the original only. Also confirmed acceptance of numeric manifest version `999` and deletion of the previous export cache directory. This validates packing/selection logic, not native decoding or an end-to-end device restore.
- Passed seven existing suites, **84 tests**, using Node 24: SQL migrations, baked migrations, draft-place selection, destinations, SecureStore helpers, draft mutations and segment-window math.
- Found no dedicated draft ZIP manifest/pack/unpack round-trip tests. The importer transformation findings above are source-audited; full device/browser crash/rebuild acceptance tests remain implementation work.

Repeat the existing relevant test set with:

```bash
npm test -- --runInBand --runTestsByPath \
  src/db/migrations.test.ts \
  src/db/baked-edits-migration.test.ts \
  src/db/draft-places.test.ts \
  src/db/destinations.test.ts \
  src/db/secure-token.test.ts \
  src/db/drafts.test.ts \
  src/utils/segment-window.test.ts
```

**Audited baseline result: the requested zero-loss rebuild guarantee failed.** The implementation checklist now tracks the replacement and its test evidence. Retain first-upgrade legacy data and keep the native release gate open until device durability, performance and workflow checks pass; the historical findings alone do not establish the updated implementation's release status.
