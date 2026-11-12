# Canonical Pulse persistence design

**Review-stack phase: Canonical runtime cutover.** This layer activates canonical package saves, guarded SQLite projections and recovery-aware startup in the standalone application. Portable sharing/import still uses the existing incomplete v1 path. V2 transfer, explicit archive restore and the library-backup UI are the next layer. See [merge order and layer validation](./review-stack.md).

This document describes the complete target architecture and its phase boundaries, not a completed native release guarantee. The [implementation checklist](./sqlite-pulse-implementation-plan.md) records remaining work. The [audit](./sqlite-pulse-source-of-truth-audit.md) describes the earlier SQLite-authoritative baseline and the state that must survive recovery. Native device crash tests, filesystem durability verification and large-media benchmarks remain release gates; embedding implementation remains deferred.

## Authority and module boundaries

The canonical unit is a **live `library.pulse` directory**, containing YAML revisions, publication markers and immutable media. SQLite indexes that package. A shareable `.pulse` ZIP is a snapshot of the same typed document and asset bytes; it is not rewritten after every edit and is not the live authority.

| Module                                                                                                                                                                                                                                                               | Responsibility                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [document.ts](./src/pulse/document.ts)                                                                                                                                                                                                                               | `PulseDocument`, all six `PulseState` row types, asset descriptors, exact-key validation and YAML parsing/serialization. No Expo or ORM runtime.                                                                    |
| [sqlite-state.ts](./src/pulse/sqlite-state.ts)                                                                                                                                                                                                                       | Explicit mapping of all 48 application columns; consistent reads; foreign-key-safe transactional projection replacement; schema coverage checks; complete document header and collection-order projection.          |
| [repository.ts](./src/pulse/repository.ts)                                                                                                                                                                                                                           | Loaded in-memory document, immutable copies, expected-version conflict checking, canonical publication and exact restore. Physical publication order is independent of the restored document's historical revision. |
| [file-storage.ts](./src/pulse/file-storage.ts)                                                                                                                                                                                                                       | Native package layout, bounded SHA-256 reads, immutable media staging/import, commit-marker checks and working-file materialization.                                                                                |
| [sqlite-guard.ts](./src/pulse/sqlite-guard.ts)                                                                                                                                                                                                                       | Synchronous Drizzle transaction boundary: publish pending state before SQL commit; block writes when recovery fails; preserve canonical success if the projection commit fails.                                     |
| [recovery.ts](./src/pulse/recovery.ts), [runtime.ts](./src/pulse/runtime.ts), [bootstrap.ts](./src/pulse/bootstrap.ts), [cleanup.ts](./src/pulse/cleanup.ts)                                                                                                         | Canonical-to-index hydration, guarded runtime, awaited bootstrap/legacy-upgrade gating, canonical-aware cleanup and recovery status.                                                                                |
| [state-order.ts](./src/pulse/state-order.ts)                                                                                                                                                                                                                         | Preserve accepted collection ordering while taking updated SQL values, removing deleted identities and incorporating new identities.                                                                                |
| [archive.ts](./src/pulse/archive.ts), [transfer.ts](./src/pulse/transfer.ts)                                                                                                                                                                                         | Verified v2 STORE ZIP codec, selection snapshots and explicit copy policy.                                                                                                                                          |
| [native-archive.ts (prototype)](https://github.com/mieweb/pulse/blob/aa16e08be00efc23195fed7894daaf69c02dd7b1/src/features/draft-transfer/native-archive.ts), [pack.ts](./src/features/draft-transfer/pack.ts), [unpack.ts](./src/features/draft-transfer/unpack.ts) | Planned backup-layer integration: v1 import dispatch, v2 copy import, library export and explicit exact-restore entry.                                                                                              |

The raw native SQLite connection remains private to bootstrap and projection code. Application helpers keep using the existing Drizzle database, whose synchronous execution/transaction boundary is guarded. This avoids extracting editor UI, changing native media engines or creating embedding packages as a prerequisite for persistence.

## The lossless typed object

The same `PulseDocument` object can be parsed from YAML, restored into SQLite and reconstructed from SQLite without discarding header fields or accepted array order. Row definitions preserve current application data directly; this is not yet the proposed embedding core's neutral `ProjectDocument` schema.

```ts
type PulseDocument = {
  format: 'pulse-document';
  version: 2;
  scope: 'library' | 'selection';
  revision: number;
  state: PulseState;
  assets: PulseAsset[];
};

type PulseState = {
  drafts: PulseDraft[];
  segments: PulseSegment[];
  draftTranscripts: PulseDraftTranscript[];
  clipTranscripts: PulseClipTranscript[];
  settings: PulseSetting[];
  uploadDestinations: PulseUploadDestination[];
};

type PulseAsset = {
  path: string; // Logical document-relative working path.
  archivePath: string; // Safe package/ZIP path under assets/.
  byteLength: number;
  sha256: string; // Lowercase SHA-256 of the immutable bytes.
};
```

The complete exported row types and validators are in [document.ts](./src/pulse/document.ts). The field-by-field inventory is in the [audit](./sqlite-pulse-source-of-truth-audit.md#every-application-column-and-its-archive-coverage); [sqlite-state.ts](./src/pulse/sqlite-state.ts) is the explicit executable camelCase ↔ SQL column mapping.

| State collection     | SQLite table          | Columns | Identity                         |
| -------------------- | --------------------- | ------: | -------------------------------- |
| `drafts`             | `drafts`              |      13 | `id`                             |
| `segments`           | `segments`            |      11 | `id`; unique draft/order slot    |
| `draftTranscripts`   | `draft_transcripts`   |       8 | `draftId`                        |
| `clipTranscripts`    | `clip_transcripts`    |       6 | `segmentId` + `model`            |
| `settings`           | `settings`            |       2 | `key`                            |
| `uploadDestinations` | `upload_destinations` |       8 | `id`; unique non-null server/ref |

Unknown application tables/columns fail schema coverage instead of being silently excluded. The known projection-only `__pulse_document` table stores one JSON header plus collection-order keys; it is regenerated from the canonical document. Its exact schema is checked. Drizzle's schema journal and SQLite internal tables are derived implementation state, outside the 48-column application model.

`readPulseState` returns deterministic query ordering. `replacePulseDocument` and `readPulseDocumentFromDatabase` additionally retain the file's accepted collection ordering, complete `assets`, `scope` and `revision` through the header projection. SQL restore uses parameterized values and savepoints, including inside an existing caller-owned transaction.

The object-equivalence boundary is `parsePulseYaml(yaml)` → `replacePulseDocument(rawDb, document)` → `readPulseDocumentFromDatabase(rawDb)`. Projection replacement is a controlled bootstrap/recovery operation; normal application mutations go through the guarded runtime, rather than calling the raw adapter.

### Example YAML

This complete example contains an empty draft and an app preference. Empty projects are valid and survive serialization; there is no required media until a segment references it.

```yaml
format: pulse-document
version: 2
scope: library
revision: 1
state:
  drafts:
    - id: draft-example
      name: 'A saved empty draft'
      uploadServer: null
      uploadArtifactId: null
      uploadStatus: null
      contextServer: null
      contextRef: null
      mergedSignature: null
      mergedDurationMs: null
      captionY: null
      lastClipNumber: 0
      createdAt: 1794492000000
      lastModified: 1794492000000
  segments: []
  draftTranscripts: []
  clipTranscripts: []
  settings:
    - key: appearance.theme
      value: dark
  uploadDestinations: []
assets: []
```

Use `parsePulseYaml`/`stringifyPulseYaml` and `validatePulseDocument` as the format boundary. Unsupported versions, unknown document/row fields, duplicate identities, invalid references and unsafe paths fail explicitly. YAML aliases, duplicate keys and warnings are rejected. Media descriptors are checked against exact byte counts and hashes.

### Transcript precision and legacy payloads

Current `words`, `lines`, `editedLines`, `captionEdit` and `editState` remain their original nullable strings. The codec does not parse, rewrite or discard malformed historical text. Native word timestamps inside legacy transcript JSON remain centiseconds; sentence markers and null versus deliberately empty word/correction arrays retain their existing representation. Re-running transcription is not recovery.

The future neutral shared-core transcript schema uses finite source milliseconds, stable word/source/model identities and the existing UI shape. That is a separate explicit migration, not a conversion already performed by this persistence implementation. Preserve fractional milliseconds when that schema is introduced, convert native centiseconds ×10 at its boundary and retain original legacy input until migration is verified.

## On-disk layout and publication

```text
Documents/
  library.pulse/
    pulse-0.yaml
    pulse-0.commit
    pulse-1.yaml
    pulse-1.commit
    initial-upgrade.json    # Temporary, verified permission to retry the retained legacy seed.
    assets/<sha256>          # New captured immutable content.
    assets/<imported-path>  # Exact restore may retain other safe member names.
    *.tmp                   # Unpublished staging/recovery evidence, when interrupted.
  drafts/...                # Existing working media and derived editor/export files.

SQLite directory/
  pulse.db                  # Retained original first-upgrade database.
  pulse-cache.db            # Disposable connection used after canonical package discovery.
  <database>-wal/-shm       # Disposable sidecars of that database.

Cache/
  pulse-exports/<uuid>/...  # Independent temporary share ZIPs.
  pulse-imports/<uuid>/...  # Copy-import staging/rollback files.
```

The package must be retained as a unit: YAML alone is not a complete backup. Newly captured media is addressed by hash; distinct logical paths may share one physical asset if hash and size agree. Exact restore retains supplied safe descriptors, including custom `archivePath` values and extra assets. Unrelated edits retain these descriptor values and order. Working assets cannot target the canonical package itself.

After a required source path is canonicalized, its working copy is a projection. An unrelated edit must reuse the verified saved descriptor even if that working original was damaged or changed; it must not promote changed working bytes into a new authoritative original. Introducing a new source or explicitly restoring another validated document is a separate operation. Optional regenerated thumbnail/export derivatives follow their cache policy.

Publication stages and verifies media, writes/verifies the next slot's YAML and marker, replaces the older slot and publishes by moving the final marker. Marker integrity binds physical generation, YAML digest and slot. The other committed slot remains during a normal replacement. Corrupt present markers, corrupt committed YAML/assets, orphaned committed YAML without final/staged marker evidence and an unrecognized nonempty package with no committed markers cause recovery failure rather than empty-library initialization. Staging evidence is retained.

The first legacy capture has a narrow retry protocol. Before copying assets, `prepareInitialMigration` writes/verifies `initial-upgrade.json` (`format: pulse-initial-upgrade`, version 1). With no committed head, that marker permits retry from retained `pulse.db`; a directory containing only its staged `.tmp` marker is also retryable before assets were captured. No ordinary saved package receives this permission. The marker must be retired before the first publication returns success. Retirement failure gates bootstrap while preserving the already committed document; a later canonical hydration retries retirement. After successful first-save acknowledgement, missing committed markers cannot use this exception to reseed from old SQL.

The document's `revision` is part of the lossless object. Exact restore may therefore restore a historical revision. The monotonic physical publication generation selects the latest publication and supplies the concurrency token; it must not be confused with the restored revision. A historical revision must not create an ABA conflict-check bypass. The runtime exposes `getPulsePublicationGeneration()`, `commitPulseState(state, expectedGeneration?)` and `restorePulseDocument(document, expectedGeneration?, incomingBytes?)`; the repository exposes `getPublicationGeneration()`. Capture the generation before asynchronous work and check it at commit/restore.

A real native rename/disk-cache/power-loss guarantee has not been measured. The two-slot implementation and Node fault tests establish the tested program ordering, not a universal filesystem durability claim. Complete canonical metadata loss cannot be repaired from a disposable database guarantee alone.

## Commit guard and mutation inventory

For an application write, the guarded SQLite transaction holds pending row changes while the runtime reads the complete state, preserves collection order, stages the header and publishes canonical YAML/media. Only then does SQLite commit. Failed canonical publication rolls back pending SQL. If canonical publication succeeds but SQLite commit fails, the runtime gates application access for recovery; callers must not delete media or report the canonical revision as unsaved.

The guard handles ordinary mutations, `RETURNING` through `run`/`all`/`get`/`values`, raw SQL through the guarded Drizzle session and nested synchronous transactions/savepoints. Read-only work does not publish. Async transaction callbacks and writes re-entering a canonical callback are rejected; poisoned projections require disabled-mode rehydration before reuse. Raw bootstrap/rebuild access is deliberately outside the guard and must never become an application-write escape hatch.

| Existing mutation surface                                                                                                                                  | Current boundary and retained state                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [drafts.ts](./src/db/drafts.ts)                                                                                                                            | Creation, recording/import insertion, rename, order, edit/reset, labels/counters, deletion, host context and upload metadata through guarded Drizzle. |
| [captions.ts](./src/db/captions.ts)                                                                                                                        | Corrections and placement, including explicit empty words.                                                                                            |
| [clip-transcripts.ts](./src/db/clip-transcripts.ts), [transcripts.ts](./src/db/transcripts.ts)                                                             | Generated outputs/status/model/source and retained legacy merged transcript data; adoption is a subsequent guarded mutation.                          |
| [settings.ts](./src/db/settings.ts), [data-migrations.ts](./src/db/data-migrations.ts)                                                                     | App preferences, generic/unknown keys and data-migration completion markers.                                                                          |
| [destinations.ts](./src/db/destinations.ts)                                                                                                                | Destination metadata insert/replace/claim/expiry/delete; protected token operations remain a separate boundary.                                       |
| [draft-writes.ts](./src/features/editor/draft-writes.ts)                                                                                                   | Coalesced edits/order stay pending until actual completion; flush rejects observed newest failures and blocks false save/export/navigation success.   |
| [native transfer (prototype)](https://github.com/mieweb/pulse/blob/aa16e08be00efc23195fed7894daaf69c02dd7b1/src/features/draft-transfer/native-archive.ts) | Copy imports and exact restores validate all incoming assets and commit through the repository/runtime.                                               |

[file-store.ts](./src/utils/file-store.ts) additionally gates working-file/directory cleanup on canonical references, including shared originals, baked files, thumbnails and cross-draft source directories. Recovery failure defers cleanup. Postcommit cleanup errors are logged and deferred, preserving the saved deletion result. Evidence: [file-store.test.ts](./src/utils/file-store.test.ts), [drafts.test.ts](./src/db/drafts.test.ts).

This inventory is a driver-level coverage argument plus targeted tests, not evidence that every camera/upload workflow has been exercised on devices. Adding a raw connection or a new persistence mechanism requires updating it and the rebuild regressions.

## Settings, derived state and secrets

All `settings` rows survive, including unknown historical keys. The 19 baseline keys and their meanings are enumerated in the [audit settings section](./sqlite-pulse-source-of-truth-audit.md#settings): transcription model, onboarding, theme, three camera preferences, editor view/custom speeds, recorder format, three pairing records, four tips and three data-migration markers. This implementation adds `pulse.legacyUpgrade.pending` for initial-upgrade recovery, bringing the explicitly known set to 20. A key is not silently dropped because it is obsolete or device-specific.

| State                                                                                                      | Current policy                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original and selected legacy baked media                                                                   | Required immutable bytes; missing/corrupt media fails complete recovery.                                                                                                      |
| Transcript baselines/corrections, identities, labels/counters, timestamps, context/history and preferences | Preserve their accepted values; do not regenerate or normalize during exact restore.                                                                                          |
| Thumbnail/export metadata                                                                                  | Preserve all SQL values. Include available thumbnail/export bytes; absence of an optional cache is allowed. Rebuild/invalidate from canonical inputs under existing behavior. |
| Extra/unreferenced accepted asset descriptors                                                              | Retain across unrelated commits until an explicit GC policy exists. Current implementation performs no canonical asset GC.                                                    |
| Filmstrip/waveform and model downloads                                                                     | Regenerable caches. Generated transcript output is retained so rebuilding does not require model download/inference.                                                          |
| Recorder compatibility and trust preferences                                                               | Retained for same-install recovery. Copy import keeps the receiving device's settings/trust; another device's recorder profile must not be applied implicitly.                |
| Undo/redo and uncommitted UI actions                                                                       | Existing process/session state; not a newly durable history contract. A pending action is not an acknowledged save.                                                           |

SecureStore destination tokens and saved viewing links remain protected, addressed through stable destination/project identities: `upload.dest.token.<destinationId>` and `upload.view.<draftId>`. YAML preserves their index associations rather than reading/copying protected values. SQL/file publication does not make SecureStore writes, token replacement or remote upload completion atomic. Fresh-device credential recovery, a durable upload intent/receipt protocol and server reconciliation remain separate work; a restored `uploading` row is not proof of a live resumable run. See [secure-token.ts](./src/db/secure-token.ts) and [destinations.ts](./src/db/destinations.ts).

## Bootstrap, retention and transfer modes

1. Validate canonical package/markers/assets before deciding whether a cache database can be discarded. A canonical recovery failure retains files and enters the recovery screen.
2. On first upgrade, retain `pulse.db`; await schema creation/migrations, read the complete legacy state, prepare the verified initial-seed marker and publish its initial canonical document with `pulse.legacyUpgrade.pending: "true"` before file-moving data migrations or application providers. Retire seed permission before acknowledging success. The first process can keep using that retained file as its guarded projection; later launches use the cache database. This file is retained, not promised to be an unchanged historical backup.
3. When a valid canonical library is found, open a fresh `pulse-cache.db`, apply schema migrations, materialize working assets and replace the complete state/header projection. Recreated schema journals are distinct from retained `dataMigration.*` records.
4. Run shipped historical data migrations only while the canonical pending flag exists. Require every shipped `dataMigration.*` completion marker to be `"true"` before clearing the pending key through a canonical commit. Swallowed/incomplete migration failures keep the flag and block application startup so the next launch can retry. An ordinary restored canonical library without that flag does not replay historical transformations because its SQL cache is new.
5. Run legacy-output cleanup only after recovery/upgrade completion, protecting every canonical asset logical path including retained extras. Only completed bootstrap mounts normal providers. A projection error after publication keeps canonical success and gates further unsafe work.

The old database and superseded canonical assets are retained. There is no canonical asset compactor or deletion-tombstone schema. The verified initial-seed marker makes interrupted, unacknowledged first capture retryable from retained SQL; the separate canonical pending setting makes the later shipped legacy-upgrade stage retryable. Other nonempty/no-head packages fail closed. These source-level retry paths still need native process-kill/power-loss and installed-library validation. Retention makes later reviewed cleanup possible but consumes disk space, including bytes no longer referenced by active projects.

Working-file and whole-directory deletion also checks canonical asset references; a source shared across draft directories must survive another draft's cleanup. The separate historical AsyncStorage/media tree remains migration input, not proof of a complete lossless Pulse ≤1.2 semantic migration. Installed legacy libraries and interrupted historical transformations still need their dedicated verification.

The updated ancient-storage importer copies media and retains its raw AsyncStorage trim/redo/config inputs on success, failure and retry. It does not read/serialize legacy bearer configuration into the canonical document. These retention regressions are covered by [legacy-migration.test.ts](./src/db/legacy-migration.test.ts); full old-format semantic conversion remains a separate native gate.

The backup layer’s `exportPulseLibrary` will emit every row and every canonical descriptor with `scope: library`. Backup-layer selected-draft sharing will emit `scope: selection`, preserves selected project/transcript state and includes the global non-secret SQLite metadata in that document; it is not a full-library backup. Both use a checksummed YAML entry plus all declared asset bytes. The ZIP codec rejects missing/extra members, unsafe/duplicate entries, unknown formats and mismatched hashes, and bounds both encoded and expanded data to 1 GiB. The synchronous in-memory ZIP implementation still needs large-media measurement.

Normal import is a **copy**: create fresh project/clip IDs, remap media paths under an import namespace, keep the receiving device's preferences/destination pool, and clear imported upload/context pairing and merged-export cache associations. Preserve editing data, labels/counters and transcript content according to that explicit mapping. Legacy v1 uses its separate incomplete copy reader and reports absent transcript/other state.

**Exact restore** in the full stack accepts a complete library document, preserves its object/descriptor identity and revision, verifies incoming bytes into immutable canonical storage and publishes before working-media/index replacement. It does not conform/re-encode originals, mint IDs or reuse the v1 copying importer. Working materialization/projection failure after publication is a recovery condition, not permission to remove already committed assets. Exact restore is an explicit API, not the normal selected-draft import behavior.

## Performance and remaining release proof

Warm saves reuse in-memory size/mtime/expected-hash fingerprints for app-owned immutable files. Missing metadata or changed size/mtime forces hashing. Every package load fully hashes each distinct canonical asset, even if that storage instance has a warm cache. Same-size/same-mtime out-of-band tampering is detected by the next full load, not guaranteed by a warm metadata-only save. Hashing reads at most 1 MiB per chunk; ZIP encode/decode still buffers whole archives.

Tests cover the codec, complete SQL projection, guard, repository, native filesystem operations through real temporary Node files, transfer policy and isolated database/WAL/SHM deletion/rebuild. The test files and exact completion status are linked in the [checklist](./sqlite-pulse-implementation-plan.md). No test here establishes iOS/Android physical power-loss durability, native memory/latency limits, all user workflows, protected-secret/network atomicity or browser filesystem behavior. Those gates remain open before claiming a native zero-loss release or starting embeddings.
