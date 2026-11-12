# Canonical Pulse files and disposable SQLite implementation checklist

**Current review: canonical Pulse persistence.** [PR #296](https://github.com/mieweb/pulse/pull/296) contains the complete persistence implementation, including v2 transfer, exact restore and library backup. Native crash/relaunch, durability, workflow and performance release checks remain open. See [review scope and validation](./review-stack.md).

**Status: canonical runtime, v2 transfer and targeted recovery proof are present; the native release gate remains open.** This is the active prerequisite for the [native embedding plan](./native-embed-component-plan.md) and [browser embedding plan](./html-embed-editor.md). The [design](./sqlite-pulse-persistence-design.md) describes the complete implementation and remaining native release requirements. The [audit](./sqlite-pulse-source-of-truth-audit.md) describes the earlier baseline and required state coverage. Checked items below name implemented behavior and its test evidence; they do not imply completion of device, durability or performance acceptance.

The required outcome is that every acknowledged save survives removal of SQLite, WAL and SHM. Canonical Pulse files, referenced immutable media and retained protected credentials provide the authority needed to rebuild the library offline. SQLite supplies queries and subscriptions as a disposable projection. Regenerable derivatives may change under documented policies; user state and original/selected legacy media must not be lost.

Implement this in standalone Pulse first. The order is milestone 1 → milestone 2 → milestone 3 → embedding implementation. Necessary format/recovery work can later be extracted into the shared core; do not make packaging, a second database adapter, a UI extraction or a browser codec engine a prerequisite for proving native persistence. After this gate, both embedding tracks consume the tested format/coordinator instead of creating competing persistence implementations.

## Tracking and working rules

- All implementation items start unchecked. Check an item only with a source commit and test/result reference recorded in this document or a linked implementation report. Keep partial work unchecked and describe the remaining part.
- Use an isolated worktree/branch, Node 24 and the existing npm installation. Record the application/submodule revisions and platform/tool versions used for device evidence. Preserve existing media and databases while developing the migration.
- Assign one owner to the canonical codec/coordinator, one to projection/bootstrap migration, and one to fixture/fault-injection work if those tasks run concurrently. Agree interfaces and fixture IDs first. Avoid simultaneous writes to the same source, migration, lockfile or checklist section; hand off committed changes deliberately.
- A save may have an optimistic pending UI state. Its durable success/notification must follow canonical commit. Propagate failures through flush/close/export paths rather than silently resolving a failed pending write.
- Milestone checkpoints document evidence and remaining scope. They do not add a permission wait to already authorized implementation. Re-estimate after measuring canonical save and rebuild costs; the older embedding estimates exclude this prerequisite.

## Milestone 1 — complete format and a non-mutating rebuild proof

Goal: represent all durable state and prove that an isolated SQLite projection can be created from canonical fixtures without changing their contents. First-upgrade SQLite must be retained; after runtime activation and successful publication, the live Pulse package supplies the authority. Native release validation remains separate.

### 1.1 Record the format and durability protocol

- [x] Record module boundaries, paths, format versions and the library/selection relationship in the [design](./sqlite-pulse-persistence-design.md). The live package is under durable `Documents/library.pulse`; share artifacts remain separate caches.
- [x] Choose and document the live-package authority: both YAML slots, publication markers and immutable referenced assets survive database deletion. A downloadable ZIP is a snapshot, not the current sole authority. Evidence: [file-storage.test.ts](./src/pulse/file-storage.test.ts), [recovery.test.ts](./src/pulse/recovery.test.ts).
- [x] Preserve project/clip identities, composite transcript identities, logical media paths, shared bytes, timestamps, ordering and protected-credential references; use SHA-256 and byte counts. Keep historical document revision separate from physical publication generation. Evidence: [document.test.ts](./src/pulse/document.test.ts), [sqlite-state.test.ts](./src/pulse/sqlite-state.test.ts), [file-storage.test.ts](./src/pulse/file-storage.test.ts).
- [ ] Design versioned tombstones and retention/compaction before introducing canonical asset GC. Current implementation retains accepted descriptors/assets and represents library membership in its latest complete snapshot.
- [x] Map every one of the 48 application columns and every settings row, including unknown keys. The [audit inventory](./sqlite-pulse-source-of-truth-audit.md#every-application-column-and-its-archive-coverage), [explicit SQL mapping](./src/pulse/sqlite-state.ts) and [design policies](./sqlite-pulse-persistence-design.md#settings-derived-state-and-secrets) cover the 19 baseline keys; bootstrap additionally uses `pulse.legacyUpgrade.pending`. Evidence: [sqlite-state.test.ts](./src/pulse/sqlite-state.test.ts).
- [x] Preserve project membership, app preferences, destination/context/upload metadata and migration markers in one typed document/state commit. Evidence: [recovery.test.ts](./src/pulse/recovery.test.ts), [sqlite-state.test.ts](./src/pulse/sqlite-state.test.ts).
- [x] Document the protected-secret boundary and same-install stable references. Existing SecureStore values are excluded from the canonical row object; full fresh-device credentials and network reconciliation are not claimed. See the [design](./sqlite-pulse-persistence-design.md#settings-derived-state-and-secrets).
- [ ] Define save success, cancellation, revision conflict, stale-index handling, interrupted operation recovery and retention/GC rules. Name the actual platform operations used for staging/replacement; verify their durability behavior rather than assuming a rename makes every write durable.

### 1.2 Implement the complete codec and legacy readers

- [x] Implement pure v2 validation/YAML/ZIP codecs, explicit version dispatch, strict keys/references, safe paths, checksums and symmetric archive limits. Evidence: [document.test.ts](./src/pulse/document.test.ts), [archive.test.ts](./src/pulse/archive.test.ts), [manifest.test.ts](./src/features/draft-transfer/manifest.test.ts).
- [x] Retain all current row values: null names, IDs, order slots, label/counter gaps, timestamps, caption position, opaque edit instructions and both original/baked sources. Evidence: [document.test.ts](./src/pulse/document.test.ts), [sqlite-state.test.ts](./src/pulse/sqlite-state.test.ts), [pack.test.ts](./src/features/draft-transfer/pack.test.ts).
- [x] Preserve legacy transcript/correction JSON verbatim, including native centiseconds, empty output, invalid historical text, model/source/status and creation metadata. This is lossless legacy preservation, not the future neutral millisecond-schema migration. Evidence: [document.test.ts](./src/pulse/document.test.ts), [sqlite-state.test.ts](./src/pulse/sqlite-state.test.ts).
- [ ] At shared-core extraction, introduce/review the neutral UI-based millisecond transcript record with stable word IDs and an explicit legacy codec. Preserve fractional precision and original legacy input. This follow-up must not be confused with the current opaque-payload implementation.
- [x] Keep v1 explicitly incomplete and copy-only, reject future versions, and make v2 sharing retain original plus selected baked media even with invalid historical settings. Evidence: [manifest.test.ts](./src/features/draft-transfer/manifest.test.ts), [pack.test.ts](./src/features/draft-transfer/pack.test.ts).
- [x] Separate exact full-library restore from identity-remapping copy import; preserve exact bytes/timing without conforming or reprobe during restore. Evidence: [native-archive.test.ts](./src/features/draft-transfer/native-archive.test.ts), [transfer.test.ts](./src/pulse/transfer.test.ts), [file-storage.test.ts](./src/pulse/file-storage.test.ts).

### 1.3 Build fixtures and a read-only recovery path

- [ ] Build a fixture library covering all six application tables, every current key plus an unknown historical key, multiple model outputs, manual and legacy merged captions, empty projects, explicit empty words/corrections, fractional-ms words, names, label gaps, shared originals and selected baked assets with invalid historical settings.
- [x] Build a canonical reader and transactional projection builder that retains full header/array ordering and never calls the copying importer or native inference. Evidence: [sqlite-state.test.ts](./src/pulse/sqlite-state.test.ts), [recovery.test.ts](./src/pulse/recovery.test.ts).
- [x] Compare complete typed objects and exact asset bytes after isolated rebuild; preserve accepted source timing without reprobe. Evidence: [recovery.test.ts](./src/pulse/recovery.test.ts), [sqlite-state.test.ts](./src/pulse/sqlite-state.test.ts), [file-storage.test.ts](./src/pulse/file-storage.test.ts).
- [x] Reject unknown versions, malformed/duplicate data, invalid hashes, damaged committed YAML/markers, missing required assets and existing nonempty packages with no committed head. Retain recovery inputs. Evidence: [archive.test.ts](./src/pulse/archive.test.ts), [repository.test.ts](./src/pulse/repository.test.ts), [file-storage.test.ts](./src/pulse/file-storage.test.ts).
- [ ] Benchmark a metadata-only edit and a media-adding save with small/large projects and shared originals. Record duration, peak memory, bytes rewritten and recovery/compaction cost on iOS and Android. Include the literal ZIP cost if that is the chosen sole authority.

**Milestone 1 evidence:** design record and complete mapping, codec/fixture test results, isolated rebuild comparison, platform durability findings and measured/revised estimates. A passing codec alone does not authorize deleting the existing durable database.

## Milestone 2 — canonical writes, migration and recovery-aware bootstrap

Goal: the standalone application acknowledges a durable mutation only after canonical commit; SQLite can be repaired afterward. Existing installed state moves without losing its only durable copy.

### 2.1 Implement one commit coordinator

- [x] Implement the single-runtime synchronous commit boundary and expected-publication-generation conflict token, separate from historical document revision. Reject stale operations before asset staging/publication. Evidence: [repository.test.ts](./src/pulse/repository.test.ts), [sqlite-guard.test.ts](./src/pulse/sqlite-guard.test.ts).
- [x] Stage/verify canonical media and publish before SQL commits. Keep canonical success when the index commit fails and gate the poisoned projection for recovery. Evidence: [file-storage.test.ts](./src/pulse/file-storage.test.ts), [sqlite-guard.test.ts](./src/pulse/sqlite-guard.test.ts), [recovery.test.ts](./src/pulse/recovery.test.ts).
- [x] Test publication write/rename interruptions, immutable-name conflicts and generation/YAML marker integrity. Preserve the other committed slot and staging evidence at the exercised boundaries. Evidence: [file-storage.test.ts](./src/pulse/file-storage.test.ts).
- [x] Return isolated committed document objects, preserve collection ordering and make queued edit/reset/reorder flushes reject failed newest writes. Evidence: [repository.test.ts](./src/pulse/repository.test.ts), [state-order.test.ts](./src/pulse/state-order.test.ts), [draft-writes.test.ts](./src/features/editor/draft-writes.test.ts).
- [ ] Verify native power-loss/fsync/replacement behavior on both platforms, including publication-head failure cases. Node filesystem faults do not complete this criterion.
- [ ] Commit tombstones and reference changes before GC. Protect shared media, active exports and retained recovery revisions; never infer deletion from missing SQL rows. An interrupted cleanup remains safe and retryable.

### 2.2 Route every durable mutation through canonical state

- [x] Record the [mutation inventory](./sqlite-pulse-persistence-design.md#commit-guard-and-mutation-inventory) and guard existing Drizzle mutation/result/transaction paths, including raw guarded SQL and nested savepoints. Keep the native raw client private. Evidence: [sqlite-guard.test.ts](./src/pulse/sqlite-guard.test.ts), [recovery.test.ts](./src/pulse/recovery.test.ts).
- [x] Capture every settings row and SQL destination/context/upload association through that same boundary. Preserve unknown keys and current values rather than dropping device-specific records. Evidence: [sqlite-state.test.ts](./src/pulse/sqlite-state.test.ts), [recovery.test.ts](./src/pulse/recovery.test.ts).
- [ ] Verify protected-secret replacement/claim/expiry together with canonical metadata and interrupted network completion. Current SQL/file transactions do not provide SecureStore/server atomicity or a new resumable-upload journal.
- [ ] Preserve current playback/edit/export behavior and source timing while routing persistence. Keep derived thumbnail/export/waveform caches separate and validate them against the canonical revision they describe.
- [x] Export from an immutable canonical document after queued writes flush; include empty projects and all declared library assets, or fail rather than silently skipping them. Evidence: [pack.test.ts](./src/features/draft-transfer/pack.test.ts), [archive.test.ts](./src/pulse/archive.test.ts).

### 2.3 Migrate and gate startup safely

- [x] Validate canonical state before disposable-cache reset, hydrate state/header before enabling writes and gate application providers on recovery. A corrupt legacy database is retained. Evidence: [client.test.ts](./src/db/client.test.ts), [recovery.test.ts](./src/pulse/recovery.test.ts).
- [x] Seed the initial canonical package from a consistent complete SQLite snapshot before normal providers/data cleanup; retain `pulse.db` and source media. Evidence: [recovery.test.ts](./src/pulse/recovery.test.ts), [client.test.ts](./src/db/client.test.ts). Installed-library/device migration verification remains below.
- [x] Make the source-level initial capture retryable with verified `initial-upgrade.json` before asset capture, retain the legacy database, and revoke seed permission before successful publication returns. Test asset-copy/publication failure, marker-staging failure, retirement failure with a recoverable committed document, and refusal to reseed a later damaged saved package. Evidence: [file-storage.test.ts](./src/pulse/file-storage.test.ts), [recovery.test.ts](./src/pulse/recovery.test.ts).
- [ ] Verify both initial-seed retry and historical-upgrade continuation with installed iOS/Android libraries and process termination/power loss. Include legacy AsyncStorage inputs; the source-level tests do not prove complete Pulse ≤1.2 semantic migration.
- [x] Await schema migration, distinguish fresh-index construction from historical transformations, and run shipped legacy tasks only while canonical `pulse.legacyUpgrade.pending` exists. Keep it and block startup until completion markers prove success; do not replay those tasks on normal restored canonical state. Evidence: [bootstrap.test.ts](./src/pulse/bootstrap.test.ts), [recovery.test.ts](./src/pulse/recovery.test.ts).
- [x] Protect every canonical asset path during legacy-output sweeps and all active canonical references during shared working-file/directory cleanup; defer cleanup if recovery is unavailable. Preserve canonical deletion success if postcommit cleanup fails. Evidence: [cleanup.test.ts](./src/pulse/cleanup.test.ts), [file-store.test.ts](./src/utils/file-store.test.ts), [drafts.test.ts](./src/db/drafts.test.ts).
- [x] Make ancient-storage migration copy media and retain raw AsyncStorage trim/redo/config input on success/failure/retry, without reading legacy bearer configuration into the document. Evidence: [legacy-migration.test.ts](./src/db/legacy-migration.test.ts). Complete old-format semantic conversion remains in the native matrix.
- [x] Keep normal UI/providers disabled when bootstrap or a later projection fails; retain canonical files and expose recovery status instead of seeding an empty document. Evidence: [client.test.ts](./src/db/client.test.ts), [recovery.test.ts](./src/pulse/recovery.test.ts). The historical-migration and cleanup criteria above require their dedicated checks too.
- [ ] Test real standalone save/relaunch/edit/export flows with existing v1 import compatibility and newly complete restore. Record an iOS and Android smoke result; mocked filesystem behavior does not prove native atomicity.

**Milestone 2 evidence:** mutation coverage inventory, coordinator/fault tests, legacy migration fixtures, native relaunch evidence and remaining limitations. Until every durable mutation is covered, SQLite must not be described as disposable.

## Milestone 3 — isolated database deletion and release gate

Goal: prove the guarantee after actual acknowledged application saves, rather than only reconstructing hand-authored canonical fixtures.

- [ ] Create an isolated test library through the real mutation paths with all milestone-1 state variants. Save, close process/database handles, and retain only the documented canonical files/media and protected credentials.
- [x] In isolated Node fixtures, remove a real SQLite database plus WAL/SHM and rebuild offline; compare the complete document, all 48 application fields and immutable source bytes. Evidence: [recovery.test.ts](./src/pulse/recovery.test.ts). Repeat on installed native applications before release.
- [x] Exercise corrupt indexes, failed hydration/materialization and canonical-publication versus projection-commit failures without changing saved canonical state. Evidence: [recovery.test.ts](./src/pulse/recovery.test.ts), [client.test.ts](./src/db/client.test.ts), [sqlite-guard.test.ts](./src/pulse/sqlite-guard.test.ts).
- [ ] Inject disk-full/write failures, process termination at commit boundaries, invalid/newer formats and missing/corrupt assets. A failed save is never acknowledged; failed recovery retains evidence and does not silently skip state or normalize sources.
- [x] Delete a project through guarded mutations, rebuild from its latest canonical snapshot and verify it stays deleted while retained immutable source bytes remain available. Evidence: [recovery.test.ts](./src/pulse/recovery.test.ts).
- [ ] Before adding canonical GC, prove versioned tombstones/retention prevent resurrection and protect shared sources/active exports. Exercise restored baked selection and reset/re-edit on native devices.
- [ ] Verify stable IDs reconnect retained SecureStore tokens/viewing links. Missing protected credentials produce an explicit recoverable/re-pairing state; no stale `uploading` value claims an active session or silently duplicates a completed upload.
- [x] Compare the complete typed object through YAML/ZIP/SQLite and exact restore, including historical revision, custom/extra asset descriptors and original byte hashes. Keep selection/copy/library scope explicit. Evidence: [archive.test.ts](./src/pulse/archive.test.ts), [sqlite-state.test.ts](./src/pulse/sqlite-state.test.ts), [native-archive.test.ts](./src/features/draft-transfer/native-archive.test.ts), [file-storage.test.ts](./src/pulse/file-storage.test.ts).
- [x] Run focused persistence regressions, typecheck, lint, unit tests and protocol-generation checks; record skipped integration coverage accurately. The complete implementation passed 58 suites / 647 tests; one integration suite containing six tests was skipped locally. Source and command results are recorded in [review-stack.md](./review-stack.md).
- [ ] Run device-specific crash/relaunch checks on both iOS and Android and preserve their commands/configuration/results.
- [ ] Publish a release evidence report naming the tested source/platform revisions, canonical layout, recovery procedure, derived-state policies, measured save/rebuild limits and any excluded scope. Update the audit's status only when the evidence supports it.
- [ ] Mark the persistence gate complete and update both embedding plans to the tested format/coordinator/API revision. Re-estimate those projects and resume their implementation; do not redesign storage independently in either track.

**Release gate:** every durable mutation has canonical coverage, existing-library migration preserves data, and database deletion/rebuild passes offline on both native platforms with the comparisons above. Until then, keep the old durable data and describe the guarantee as incomplete.

## Recorded implementation evidence

See [review-stack.md](./review-stack.md) for the single persistence PR, validated implementation commit and command results. The PR includes the complete persistence source tree. Check an implementation item only when its complete behavior is present and its validation is recorded; keep mixed or partially verified criteria unchecked.

The native release gate remains open. Node fixtures and JavaScript bundle exports do not prove native power-loss/process-kill behavior, installed-library workflows, save/rebuild performance or protected-secret/network coordination. Preserve the retained legacy input and canonical package while those checks remain open.

## Repeatable checks

These commands exist now; they are useful regressions, not substitutes for the new recovery suite:

```bash
npx tsc --noEmit
npm run lint
npm test -- --runInBand
node scripts/gen-protocol-types.mjs --check
```

Use the validation record in [review-stack.md](./review-stack.md) for each completed section. Link the implementation commit and command/test result; keep native platform limitations explicit.
