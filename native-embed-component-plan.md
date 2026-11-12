# Native Pulse component for Capacitor and Cordova

**Review-stack phase: Planning only.** This layer contains plans and repository requirements only. It does not change production persistence. SQLite and the v1 transfer format remain the application baseline; the architecture below is the planned target. See [merge order and layer validation](./review-stack.md).

This is an implementation plan, not an implemented SDK. Its source baseline is Pulse `495b382` on `main`. Package names, new files, scripts and APIs below are proposals. Confirm package-name availability before publication. The companion browser plan is [html-embed-editor.md](html-embed-editor.md).

**Prerequisite and current priority:** complete the [canonical Pulse persistence implementation checklist](./sqlite-pulse-implementation-plan.md) in standalone Pulse before starting this embedding implementation. Its milestone-3 offline database-deletion/rebuild release gate is still open. Defer native packaging, shared UI extraction and plugin implementation until that gate passes. Then consume the tested canonical format/coordinator, revise estimates and run this plan; do not create a competing storage design. Milestone review records evidence and does not require an automatic permission wait.

- [ ] Prerequisite: persistence release gate passed on iOS and Android; record its implementation/evidence revision before starting native embedding milestone 1.

The result is one reusable native recording/editing flow, backed by the existing Swift/Kotlin media engines, with thin Capacitor and Cordova adapters. A host opens Pulse, receives an exported MP4 and optional caption sidecars, and owns uploading. Canonical Pulse files hold durable state; SQLite becomes their disposable local index. No server or remote database is required for recording, editing or export.

## Required durability boundary

The [SQLite and Pulse source of truth audit](./sqlite-pulse-source-of-truth-audit.md) found that the recorded baseline did not meet this requirement: 40 of 48 application columns had no draft-archive equivalent, and import could transform media/state. The [current persistence design](./sqlite-pulse-persistence-design.md) implements a live canonical package and SQL projection with targeted recovery tests; its native release gate remains open. Every acknowledged save must commit to canonical Pulse files before the index commits. Preserve complete projects and an authoritative library/app-state record; settings, destination metadata and completed upload history cannot remain SQLite-only. Protected credentials retain stable references to SecureStore.

The default `sqlite` profile proposed below means canonical file persistence plus a SQLite projection, not SQL as authority. Memory profiles are explicitly volatile test/host-owned modes. Require the audit's offline delete-SQLite/WAL/SHM → rebuild → compare gate, and separate exact restore from importing a transformed copy. If the literal ZIP is the single source of truth, its revision must be durably updated before save success; benchmark that cost in the persistence prerequisite's milestone 1. The estimates below predate this persistence expansion and must be revised after that spike.

## Scope, deliverables and estimates

V1 supports iOS and Android, full-screen presentation, one active session, recording or opening an existing project, non-destructive clip edits, local draft persistence, MP4 export, caption corrections and caption sidecars. On-device transcription is an explicitly enabled capability and uses the existing model downloader/engine; an embedded session must not start a model download unexpectedly. Existing standalone Pulse keeps its current defaults.

V1 does not require the host to use PulseVault, does not open the standalone Home/onboarding flow, does not render Pulse inside an HTML element, and does not replace AVFoundation/Media3. PulseVault pairing/uploads can be added later behind explicit host configuration. Returning MP4 plus caption data does not imply captions are burned into the MP4; a burn-in mode needs a separately verified renderer/export feature.

| Milestone | Deliverable                                                                                  | Experienced-engineer estimate |
| --------- | -------------------------------------------------------------------------------------------- | ----------------------------- |
| 1         | Versioned shared contracts and fixtures; SDK 57 native packaging/lifecycle proof             | 3–5 working days              |
| 2         | Reusable native flow, shared editor UI, SQLite and memory adapters; standalone compatibility | 5–8 working days              |
| 3         | Thin plugins, four host/platform demos, release packaging and regression evidence            | 5–8 working days              |

Allow roughly 3–5 weeks for this native track with a mobile engineer and regular review; a junior implementing it should budget 5–8 weeks with senior help at the packaging and lifecycle checkpoints. These are planning estimates, not measured build times or commitments. They exclude browser implementation, store submission and a future remote-sync service. A failing packaging spike changes the estimate before more extraction work is committed.

Each milestone ends with runnable software and recorded evidence. Check-ins are review points: continue authorized implementation after demonstrating the gate; do not add an automatic permission wait. Stop dependent work only for a concrete failed acceptance criterion or a product decision that changes scope.

## Existing code to understand before moving it

This table describes the recorded embedding baseline. The newer canonical persistence implementation is documented in the [current design](./sqlite-pulse-persistence-design.md); use that implementation during extraction rather than reinstating the older SQL-authority behavior below.

| Existing path                                                                        | Why it matters                                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                                                       | Expo SDK 57, React Native 0.86.3, Node ≥24.3.0, native dependencies, patch-package; app entry is `expo-router/entry`.                                                                       |
| `app.json`, `app.config.ts`, `plugins/`, `patches/`                                  | Native generation, permissions, linking, signing, foreground-service configuration and patched dependencies. These effects must be audited in the final host, not only in standalone Pulse. |
| `metro.config.js`, `tsconfig.json`                                                   | Resolve the local `@mieweb/pulse-editor` submodule directly from source.                                                                                                                    |
| `src/app/_layout.tsx`                                                                | Starts global logging/client identity and providers for migration, theme, navigation, pairing links and uploads. It is not a safe SDK entry without configuration.                          |
| `src/app/{recorder,editor,export}.tsx`                                               | Current route-driven flow. Closing currently navigates to Pulse Home instead of resolving a host session.                                                                                   |
| `src/features/editor/`                                                               | Timeline, crop UI, edit history, coalesced writes, filmstrip/waveform caches and preview transport.                                                                                         |
| `src/features/export/{use-export,editor-merge,merged-export}.ts`                     | Existing cancellable merge, output path/duration and persistent export cache.                                                                                                               |
| `src/db/{client,schema,drafts,captions,clip-transcripts,settings}.ts`                | SQLite holds authoritative editing state; many read helpers expose Drizzle queries to `useLiveQuery`.                                                                                       |
| `src/db/migrate.tsx`, `src/utils/file-store.ts`                                      | Migration and root-directory cleanup; media locations must be scoped for an SDK.                                                                                                            |
| `src/features/draft-transfer/{manifest,pack,unpack}.ts`                              | `.pulse` transfer includes video edits/order but omits caption corrections and caption placement. It is not the new complete project serializer.                                            |
| `modules/pulse-editor/`                                                              | Separate Git submodule. Existing Nitro module and preview use AVFoundation on iOS and Media3 on Android. Preserve these implementations.                                                    |
| `modules/expo-call-detector/`, `src/features/recorder/use-call-state.ts`             | Native capture interruption handling and iOS background-task integration.                                                                                                                   |
| `src/features/upload/{keep-alive,native-chunk-upload,upload-deep-link-provider}.ts*` | Standalone upload lifecycle must be absent by default in embedded sessions. Audit `react-native-background-actions` even if no upload is started.                                           |

README references to FFmpeg describe older behavior; use current imports and the pinned `pulse-editor` source as the implementation authority.

## Concurrent work and package ownership

After the persistence prerequisite passes, use separate branches/worktrees for native and browser work. Do not have both tracks modify `package.json`, a lockfile or the shared packages simultaneously. Neither track should reset the other's checkout or change the `pulse-editor` submodule pointer as an incidental dependency update.

| Proposed package/path                                                     | Owner and responsibility                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pulse-core` / `@mieweb/pulse-core`                              | Native track owns extraction of the tested canonical format, pure reducers/math, store/media interfaces and shared fixtures. Preserve the persistence prerequisite's format/recovery contract. No React, Expo, Drizzle, DOM, Nitro or Skia runtime imports.       |
| `packages/pulse-editor-ui` / `@mieweb/pulse-editor-ui`                    | Native track owns initial mechanical extraction of editor view model and common RN/Skia renderer. Browser track contributes coordinated `.web` input/font changes. No direct SQLite, Expo filesystem or Nitro dependencies. React/RN/Skia are peers where needed. |
| `packages/pulse-native` / `@mieweb/pulse-native`                          | Native flow, native media adapters, SQLite integration, runtime/session coordinator and native SDK packaging.                                                                                                                                                     |
| `packages/capacitor-pulse` / proposed `@mieweb/capacitor-pulse`           | Capacitor bridge and installation metadata; delegates to native SDK.                                                                                                                                                                                              |
| `packages/cordova-plugin-pulse` / proposed `@mieweb/cordova-plugin-pulse` | Cordova bridge and installation metadata; delegates to the same native SDK.                                                                                                                                                                                       |
| `examples/capacitor-pulse-host`, `examples/cordova-pulse-host`            | Small independent hosts demonstrating installation, open/result, draft save, cancellation and file handoff.                                                                                                                                                       |

Once the persistence release gate passes, browser work can begin concurrently on its own branch with fixture proposals, a contract-only test stub, CanvasKit/UI-loading and media-backend experiments. Do not copy editing reducers or the production timeline into that branch. The stub contains interface/fixture data only and is deleted when the actual package is consumed.

At the first handoff, native produces `artifacts/core/mieweb-pulse-core-0.1.0-dev.1.tgz`, its SHA-256 and fixture results. Browser pins that exact tarball and checksum until the next coordinated version; it does not import an uncommitted sibling checkout. Use the same handoff for `pulse-editor-ui` as soon as its extraction is buildable. For changes to a shared package, designate one owner for the commit, review the contract in both tracks, publish a new development version and update consumers deliberately. Do not fork reducers or maintain two project schemas.

Keep the existing root npm installation and lockfile unless a concrete build requirement demands a reviewed change. Individual package manifests/build scripts and tarballs are sufficient to start; a monorepo/package-manager migration is not a prerequisite.

### Shared contract to settle in milestone 1

The authoritative proposed package files are `packages/pulse-core/src/project-document.ts`, `project-commands.ts`, `draft-store.ts` and `media-asset-store.ts`. Extract them from the persistence prerequisite's tested contract; reconcile the proposals below with that implementation before freezing the package API. Both embedding plans refer to those definitions instead of independently maintaining formal interfaces.

Current persistence uses `PulseDocument` format version 2 with exact legacy row collections and opaque transcript JSON. The neutral `ProjectDocument`/millisecond word model below is proposed extraction work, with a separate schema version. Introduce it through a lossless codec/migration that retains the library/app state and original legacy payloads; do not treat the current v2 document as already implementing these neutral types.

- `ProjectDocument` fields: `schemaVersion: 1`, `id`, `name: string | null`, `revision`, `createdAtMs`, `updatedAtMs`, `lastClipNumber`, `assets`, ordered `clips`, and `captions: { positionY }`. Renaming must survive JSON/native/browser round trips; it is not merely a view label.
- Preserve the nonnegative integer `lastClipNumber` from the current draft schema. Adding a clip advances it atomically; deleting/reordering clips never decrements it. Include a delete → JSON save/reload → add fixture assertion so a storage adapter cannot reuse a previously minted clip badge by recomputing the counter from only the remaining clips.
- `assets` descriptors: `id`, `mimeType`, `byteLength`, `contentHash`. Canonical archive validation verifies byte counts/hashes. `mediaId` references an asset's stable opaque ID. Never persist native paths, Blob URLs, platform handles, credentials or media bytes in the document. IDs must resolve only within the configured asset store; import/export code chooses safe physical paths.
- Each clip: stable `id`, pristine-original `mediaId`, nullable `label`, original `sourceDurationMs`, nullable `edit`, nullable `legacyBaked: { mediaId, durationMs }`, optional `captions`. The clips array is the canonical order; adapters translate SQLite's `sort_order` without introducing a second competing order field. Preserve both original and baked asset references in JSON; one effective media ID cannot preserve the current reset behavior.
- `edit` is `null` for an unedited original, otherwise `{ startMs, endMs, rotationQuarterTurnsCCW, flipped, crop, muted, speed }`, with nullable normalized `crop`. Quarter turns are 0–3, matching the existing app; only the native-engine adapter maps to clockwise degrees. Validate ranges using existing semantics rather than inventing another edit language.
- Non-null `legacyBaked` selects the baked asset's full span with identity transforms, even when historical `edit` settings also exist. This matches `src/utils/segment-window.ts:101` giving `editedFilename` priority; do not apply the settings a second time. Re-edit/reset clears `legacyBaked` and returns to the pristine `mediaId`; reset also clears `edit`. Release unreferenced baked assets only after the project commit and reference checks. Caption media references remain tied to the actual source they describe; reset must not silently relabel baked-file caption timings as original-file timings.
- Clip captions: `{ mediaId, modelId, generatedWords, correctionWords }`, retaining additional accepted transcript metadata/model outputs during migration. Base words on UI's `{ text, startMs, endMs, speakerId?, confidence?, wordType? }` in finite source **milliseconds**, preserving accepted fractional values, with stable word IDs and optional `sentenceStart`. Preserve supplied speaker/segment metadata and provenance in the complete transcript record. Convert legacy `t0`/`t1` centiseconds exactly by multiplying by 10 and map legacy `start` sentence markers once at the boundary. A legacy engine projection may quantize, but must not overwrite the canonical millisecond data. `correctionWords: null` means use generated words; `[]` is an intentional removal of all captions. Preserve sentence boundaries and corrections across trims, speed, reorders and save/reopen.
- `captions.positionY` is normalized 0–1; `null` means the default. Map current `captionY` at the boundary. Include it in serialization and undo/redo.
- `createdAtMs`/`updatedAtMs` are integer epoch milliseconds. Stored edit trim boundaries use integer source milliseconds, preserving current `snapToFrame`/ceil/floor behavior. Derived timeline lengths can be fractional after speed changes; accumulate them before rounding a renderer/codec boundary. Do not round every clip prefix. Keep probed source duration/frame-rate metadata precise enough to preserve existing frame behavior.
- Shared timeline/caption functions accept an optional measured `TimelineLayout: { clipStartsMs, totalMs }` for the exact project revision/media configuration. Prefer the engine's positions over summed probe durations when that layout is valid. The current iOS preview ends an untrimmed clip at its video-track end while Android can use its file end; preserve this distinction and test an audio-tail mismatch. Reject stale layout data after edits instead of applying it to a new revision.
- `revision` is a nonnegative monotonically increasing integer. `DraftStore` exposes asynchronous `create`, `load`, `list`, `apply(id, changes, { expectedRevision })` and `remove(id, { expectedRevision })`, plus `subscribe(id, listener)` returning a synchronous unsubscribe function. `ProjectChangeSet` uses domain commands and a shared pure reducer. `apply` atomically validates revision, applies all changes, persists and returns the immutable committed snapshot with its new revision. Both `apply` and `remove` reject their Promise with a typed `REVISION_CONFLICT` error containing `currentRevision` and `currentSnapshot` when the expected revision is stale; use a documented null snapshot/revision for an already removed project. A conflict makes no partial change and emits no commit notification. Notify subscribers once after a successful commit, in revision order, and never announce an uncommitted state. The local memory reference adapter must behave like SQLite for these rules.
- `MediaAssetStore` exposes asynchronous `import`, `resolve`, `read` and `remove`. Define resolver handles with explicit `release` ownership. Media lifetime/reference counting is distinct from project metadata; split clips may share one asset. Native files, browser Files/Blobs and host copies are adapter concerns. Secrets use a separate optional `SecretStore` and never a plain project or JSON adapter.
- Fixtures under `packages/pulse-core/fixtures/`: `empty-v1`, `one-clip-v1`, `edited-three-clips-v1`, `captions-corrected-v1`, `reordered-v1`, `missing-media-v1`, `revision-conflict-v1`, `legacy-caption-position-v0`, `audio-tail-mismatch-v1`. Store project input and expected logical output; use small deterministic media references. Include muted/speed-adjusted clips, a shared original, both pristine and legacy baked asset references, caption corrections/sentence breaks and normalized positioning. Round-trip a legacy-selected clip with historical edit settings, verify full-span identity rendering, then reset/re-edit to its original and verify cleanup ordering. The `v0` fixture tests the SQLite/legacy conversion, not a claim that a public ProjectDocument v0 already exists. The audio-tail fixture specifies measured backend layouts and caption/beat expectations rather than assuming nominal durations add up identically.

## Milestone 1 — prove the build boundary and freeze the first shared contracts

Goal: demonstrate that SDK 57 plus the actual native dependency stack can be presented and dismissed from an existing native host, and establish the packages that unblock the browser track.

### 1.1 Establish a reproducible baseline

- [ ] Work from a clean branch based on `495b382` or a specifically recorded newer main commit. Record `git rev-parse HEAD`, `git status --short`, submodule commits, Node/npm versions, Xcode, Java and Android SDK/NDK versions in `docs/native-embed/baseline.md` when implementing.
- [ ] Check repository instructions and `git status` before changing dependencies. Preserve unrelated work. Initialize the pinned submodules; do not update them to their latest remote branches.
- [ ] Use Node 24.3.0 or newer. Run the existing install and checks below; record failures and skipped suites separately from regressions introduced later. `npm ci` applies the repository's patch-package postinstall.
- [ ] Fetch/check Git LFS media needed for the demos; verify files are playable MP4s rather than LFS pointer text. Do not regenerate the large fixture set merely to start the spike.
- [ ] Run standalone Pulse on one iOS simulator/device and one Android emulator/device. Capture the existing recording/editor/export behavior. Real camera/audio interruption checks require devices; simulator seeded-media checks do not prove camera behavior.

Existing baseline commands, run from the repository root:

```bash
git status --short
git rev-parse HEAD
git submodule update --init --recursive
git submodule status
node --version
npm --version
npm ci
git lfs pull
npx tsc --noEmit
npm run lint
npm test -- --runInBand
npm run ios
npm run android
```

Read test output: the PulseVault integration suite can skip when the pinned server is not built. A local component spike does not need a backend. If claiming that integration coverage passed, separately run `npm ci` and `npm run build` inside `pulsevault-mieweb`, then rerun the suite; do not equate a skip with a pass.

### 1.2 Extract contracts and a small amount of pure logic first

- [ ] Create `packages/pulse-core` with a public `src/index.ts`, the contract files above, isolated TypeScript build configuration and package-local `build`/`test` scripts. Give the package a development version. Use package-local Jest configurations for the `test` scripts shown with `--runInBand`; do not inherit the current root `src/**/*.test.ts` pattern and accidentally run zero package tests. If a different runner is chosen, change the commands and recorded instructions to its actual flags. Scripts and outputs named below are new work, not existing repository commands.
- [ ] Build the first shared fixtures before moving UI. Validate names/renames, IDs, time units, edits, caption corrections and complete serialization; reject unknown future schema versions with an actionable error. Include accepted fractional-millisecond word timings in `captions-corrected-v1`; prove legacy engine projection does not round/overwrite canonical values.
- [ ] Verify the completed persistence prerequisite's column/key mapping, canonical format, protected references, tombstones, exact restore and save benchmarks. Preserve that behavior during core extraction and rerun its codec/rebuild fixtures against the packed core; do not define a second format or reopen SQL-only writes.
- [ ] Move pure `segment-window`, timeline geometry and history/caption helpers into core without changing behavior. Move parsing out of `src/db/captions.ts` before importing it into shared caption composition. Separate plain style values from RN/OS imports.
- [ ] Review the [browser plan's existing UI editor reuse decision](./html-embed-editor.md#existing-browser-transcript-editor-reuse-before-building) before freezing transcript contracts. UI already has Pulseclip-derived `MediaEditor`/`useTranscriptEdits` and a local Whisper demo. Coordinate source IDs and milliseconds/centiseconds conversion; distinguish caption corrections from transcript-driven media cuts. Preserve native caption-correction behavior. Before adding transcript-driven recuts, review their mapping to split/repeated clip ranges, source provenance and shared fixtures; extend/version the schema only where necessary. Core must not import UI or its browser AI worker.
- [ ] Leave compatibility reexports at the current `src/` paths so standalone imports and existing tests continue working. Do not move the whole database helper layer or app screens at this stage.
- [ ] Add an asynchronous in-memory `DraftStore` reference adapter and fixture-driven contract tests for apply/CAS, ordering, subscriptions, deep-copy isolation and caption round trips. UI optimistic state is distinct from committed store state.
- [ ] Reserve the shared UI package and publish an interface-only development skeleton if the browser spike needs it. The initial real renderer extraction remains native-owned in milestone 2.
- [ ] Add fixture comparison commands and run them from a packed package, not only TypeScript aliases pointing at source. Ensure no runtime import of Expo, Drizzle, RN, Skia, Nitro or DOM enters core.
- [ ] Pack core and give the browser owner the tarball, checksum, fixture names and API change log. Record the actual artifact filename if the chosen version differs.

Commands after those package scripts exist:

```bash
npm --prefix packages/pulse-core run build
npm --prefix packages/pulse-core test -- --runInBand
mkdir -p artifacts/core
npm pack ./packages/pulse-core --pack-destination ./artifacts/core
shasum -a 256 artifacts/core/mieweb-pulse-core-0.1.0-dev.1.tgz
```

### 1.3 Spike SDK 57 brownfield artifacts and lifecycle before committing to distribution

- [ ] In the native worktree, add SDK-compatible `expo-brownfield` using `npx expo install expo-brownfield`; inspect the resulting SDK 57 version/lockfile. Do not upgrade Expo/RN or replace the root dependency set to follow a latest-version tutorial.
- [ ] Add a reviewed brownfield config for a separately named library target. Keep standalone bundle IDs/signing out of host identity. Make release-signing plugins inapplicable to the library target if needed.
- [ ] Generate/build native library targets using the installed CLI's `--help`; record exact successful commands and artifact contents. The commands below use documented SDK 57 options, but generated scheme/module names must be recorded from the actual configuration.
- [ ] Link the artifacts into a minimal native iOS host and Android host, present a simple RN test screen, pass a session ID in, receive an event and dismiss it. This test host is disposable spike scaffolding, not a fifth production adapter.
- [ ] Extend the test screen to load a bundled clip through the existing Nitro preview, seek, export, then close. Ensure VisionCamera, Skia, Nitro, Whisper and the local call-detector module are autolinked and load without missing native-module errors. Captions may be disabled, but package initialization must be tested.
- [ ] Audit iOS launch/foreground/background/URL events and audio session handoff now. Test close/reopen and foreground/background before adding the complete flow. Preserve host lifecycle delegates; do not replace its AppDelegate/SceneDelegate wholesale with Pulse's generated app delegate.
- [ ] Audit Android Application/activity integration now. In particular, determine whether `react-native-background-actions` assumes its Application implements React interfaces; do not wait for final host demos to discover a cast failure. For host-owned uploads, remove/disable the unused Pulse foreground-service startup and manifest/service wiring in the embedded target. If a required retained dependency still assumes a React Application, implement the supported host integration and document it in both adapters.
- [ ] Inspect final manifests/Info.plist, duplicate native symbols/libraries, resources, privacy manifests and permissions. Record the actual minimum OS/SDK constraints from the built targets/dependencies. `pulse-editor` targets Android API 29+ and documents iOS 16.4+, but the complete current dependency stack may require higher host targets.
- [ ] Test a Release bundle with Metro stopped. A Debug-only screen loading from Metro is not the artifact proof.

```bash
npx expo install expo-brownfield
npx expo-brownfield --help
npx expo prebuild --platform ios
npx expo-brownfield build:ios --release
npx expo prebuild --platform android
npx expo-brownfield build:android --release
```

Use generated native directories in the dedicated worktree; do not hand-maintain SDK changes solely inside generated files. If one platform is unavailable on the current machine, produce a reproducible CI/other-machine job and label that platform unverified until its output is run.

### Check-in 1: contracts plus a real native launch/return

- [ ] Demo the minimal native host opening a release RN media view, seeking/exporting the fixture and returning to the host with Metro stopped; show lifecycle test results for both OSes.
- [ ] Hand off the core tarball/checksum and passing shared fixture report to the browser owner. Browser can continue media/rendering spikes if packaging is still being resolved.
- [ ] Save build logs, dependency manifests, artifact checksums, host change list, short device recordings and failures in a checkpoint report.
- [ ] Decide **artifact approach** or **integrated fallback** based on evidence. An Android AAR is not promised to contain every transitive dependency: preserve/publish its Maven metadata and dependencies; distribute iOS Hermes/dependencies and assets as required by the verified build.
- [ ] If isolated artifacts fail on SDK 57/custom native dependencies, time-box diagnosis to two working days. Then use the official integrated brownfield approach: host Gradle/Pods integrate the shared RN/Expo project and bundle JS/assets at release. Keep the same public API and core packages. Record the extra host setup instead of quietly increasing scope to an Expo upgrade or replacing engines.
- [ ] Do not start broad native-flow extraction until each target platform has either working isolated packaging or a working integrated fallback. A root-app build alone does not satisfy this gate.

## Milestone 2 — extract one reusable native flow and storage boundary

Goal: standalone Pulse and an embedded native host use the same editor logic/UI and native media engine. The default project store persists canonical Pulse files with a replaceable SQLite index; no route, upload listener or global filesystem sweep decides host behavior.

### 2.1 Implement the project/storage adapters

- [ ] Adapt the tested canonical-file coordinator to `DraftStore` and add `packages/pulse-native/src/storage/sqlite-draft-store.ts` as its projection. Reuse the verified migration/recovery path; preserve IDs, order, trims/transforms, selected legacy assets, labels, captions/corrections/position, every accepted model output and provenance. Preserve all referenced media and keep secure credentials out of project JSON.
- [ ] Serialize expected-revision checks and durable commits at the canonical file authority; then update the SQLite projection in a transaction, preserving index constraints. An index failure after canonical commit marks the index stale and triggers rebuild; it must not discard a committed revision. Replace `src/db/client.ts` import-time `openDatabaseSync('pulse.db')` with configured lazy/factory initialization and recovery gating, so importing a package cannot open/migrate/clean the wrong namespace or run cleanup before canonical recovery.
- [ ] Replace Drizzle query objects exposed to the extracted editor with plain async snapshots/subscriptions. Keep existing `src/db/` helpers as compatibility facades for standalone code until each call site is migrated. Inventory the remaining `useLiveQuery` imports; embedded project UI must not rely on a global Drizzle singleton. All writes to canonical project fields, including standalone recorder/editor and background caption updates, must pass through the revisioned store by this milestone's end; direct SQL writes cannot bypass revision/subscription guarantees. Non-project preferences and derived cache records stay separate.
- [ ] Implement native `MediaAssetStore` for imports, resolver handles, reads and cleanup. Default embedded storage to an explicit Pulse namespace under the host sandbox; separate its DB/media/cache directories. Do not sweep the host's documents/cache root. Offer a configured store path only with validation and ownership documentation.
- [ ] Separate draft commands from media jobs: prepare a thumbnail/file, commit metadata, then release old unreferenced resources. Keep the current race protection for superseded covers, shared originals, delete-during-transcription and export-signature updates. A metadata transaction does not make filesystem writes atomic.
- [ ] Run identical store contract tests against SQLite and memory implementations. Rename and round-trip an existing SQLite draft through JSON into memory and back, including its name, manual captions, `positionY`, pristine original and selected legacy baked asset; compare logical state, not transient cache paths. Verify reset/re-edit returns to the original without double-applying historical edits. Test stale apply and remove both reject `REVISION_CONFLICT` with the current snapshot/revision and do not notify or delete media.
- [ ] Implement the complete versioned `.pulse` format and exact restore separately from import-copy. Read old v1 as explicitly incomplete, preserve untouched original/active baked media, and reject unsupported newer versions. Fix the audit's baked-plus-invalid-settings omission and add round-trip tests. Never silently skip expected drafts/assets in a claimed complete save/restore.
- [ ] Run the audit's isolated offline rebuild and crash-injection suite: after acknowledged saves remove SQLite/WAL/SHM, rebuild from canonical files and compare all durable project/app state and media hashes. Include interrupted writes/rebuilds, stale indexes, disk-full, deletions, shared assets and stable SecureStore references. Canonical recovery precedes migrations/GC/uploads/transcription.

### 2.2 Extract common editor UI and native media adapters

- [ ] Create real `packages/pulse-editor-ui` exports for a controlled editor/view model receiving project snapshot, commands, preview slot/controller, frame/image cache services, waveform peaks and capability flags. Move logic mechanically first; no desktop redesign or new edit feature in this commit.
- [ ] Reuse the existing Skia timeline/caption renderer, geometry and undo/redo. Move filesystem decoding, native preview creation, audio session and SQL queries out of the shared UI. Keep platform input/typography adaptations explicit and inject media resources rather than importing the native engine from shared UI.
- [ ] Inject theme and editor preference state rather than reading global SQLite settings from shared UI. Resolve initial asynchronous preference loads explicitly; do not keep `getEditorView()`'s synchronous SQL read as a hidden requirement of interchangeable stores.
- [ ] Use compatibility reexports at the existing `src/features/editor/` paths and a thin `src/app/editor.tsx` wrapper. Standalone routing can continue while the component accepts controlled inputs.
- [ ] Browser owner reviews the shared UI interface and submits `.web` gesture/font/CanvasKit changes through one shared package commit. Pack and hand off the UI artifact; no second production renderer/reducer is introduced in the browser package.
- [ ] Create `packages/pulse-native/src/media/` adapters around the existing `@mieweb/pulse-editor` API and native preview. Preserve cancellation/progress and convert core media IDs to native URIs at this boundary.
- [ ] Keep the source engine submodule pinned. If extraction reveals a real native-engine defect, use a separate reviewed submodule change with its own tests/commit and deliberately update the parent pointer. Do not silently modify vendor/native sources to make a demo work.
- [ ] Reuse recorder hooks/VisionCamera and export pipeline behind the native component. Keep capture finalization, write flushing, camera release and playback audio-session handoff explicit at every transition.

### 2.3 Define and implement one session API

Expose the same types to the native host, Capacitor and Cordova. The following names define proposed behavior; implement the authoritative types in `packages/pulse-native/src/session-types.ts` and export them for adapter consumers.

Initialize the configured runtime before opening a session. Internal RN code uses a proposed `createPulseRuntime({ mode: 'embedded', storageNamespace, draftStoreFactory, mediaAssetStoreFactory, secretStoreFactory })` in `packages/pulse-native/src/runtime.ts`. Those factories are compiled JavaScript implementations selected from an internal adapter registry; they are called only after configuration is validated. The lightweight RN bootstrap must receive configuration before dynamically importing the feature flow, opening a database or starting any jobs/listeners.

Capacitor and Cordova expose the same JSON-only initialization request:

```ts
initialize({
  apiVersion: 1,
  storageNamespace: 'host-demo',
  storeProfile: 'sqlite', // or 'memory'
  mediaProfile: 'native-files',
  secretProfile: 'none', // optional 'secure-native' when a feature needs it
}) -> Promise<{ runtimeId: string, capabilities: PulseCapabilities }>
```

Profile names map to the registered internal factories in the shared native SDK. No JS function, `DraftStore` object or filesystem service crosses a Capacitor/Cordova serialized bridge. A custom host store requires a compiled registered adapter and installation work, or a separately designed future asynchronous RPC adapter; accepting an arbitrary JSON object does not create dependency injection. Validate `storageNamespace` as an opaque safe namespace, never an arbitrary physical path, and use it consistently for the configured DB, media and cache scope.

- Repeated or concurrent `initialize` with the same normalized configuration coalesces and returns the same `runtimeId`; it does not reopen/migrate the DB or reinstall listeners. A failed initialization returns a typed error and leaves no partially active runtime.
- `open` before successful initialization rejects `NOT_INITIALIZED`. Unknown profiles reject `UNKNOWN_PROFILE`. One initialized runtime and one active session are supported in V1.
- A different configuration rejects `INITIALIZATION_CONFLICT` while initialized. Reconfiguration requires explicit `dispose({ runtimeId })` and a fresh initialize. Disposing/reconfiguring during an active or closing session rejects `SESSION_BUSY`; the caller must cancel and await its terminal outcome first. Disposal releases runtime resources without deleting durable drafts or unadopted export handoffs, which retain their documented ownership.
- Direct RN consumers can provide factories to `createPulseRuntime`; bridge consumers select JSON profiles only. Both use the same coordinator and store contracts. Standalone bootstrap explicitly creates its own standalone-mode runtime; it must not accidentally reuse embedded profiles or host namespaces.

After initialization:

```ts
open({ apiVersion: 1, runtimeId, sessionId, mode, projectId?, project?, assets?, captions? })
  -> Promise<PulseSessionResult>
```

- `runtimeId` must identify the successfully initialized runtime. `sessionId` is a caller-generated unique string; `mode` is `record` or `edit`. Imported assets are host-local handles/URIs mapped to media IDs by `MediaAssetStore`; they are not embedded inside ProjectDocument as paths.
- The request must say whether it opens a stored `projectId`, imports a provided `project`, or creates a new recording. Validate conflicting fields. An `edit` request with missing media returns a typed error before changing host navigation.
- `captions` defaults to `off`; `on-device` enables existing transcription UI and explicit model preparation. Project caption corrections remain editable/serializable when generation is off.
- Result variants: `{ status: 'completed', outcome: 'exported', sessionId, project, output, captions? }`; `{ status: 'completed', outcome: 'draft-saved', sessionId, project }`; or `{ status: 'cancelled', sessionId, projectId?, savedRevision? }`.
- `output` contains a file handle/URI, MIME type, byte length, true `durationMs`, measured `layout: { clipStartsMs, totalMs }` and `projectRevision`. Return the immutable `project` snapshot for that exact revision; edits committed during an export cannot silently change what the result claims. `captions` identifies caption-track JSON/WebVTT sidecar output and ownership for the same revision/layout. `draft-saved` has no fabricated video output. Internal autosave or a progress event is not export completion.
- Failures reject with a serializable `{ code, message, retryable? }`. Define at least unsupported API/schema, session busy, invalid input, missing media, permission denied, revision conflict, capture/export failure and host interruption. A user pressing Cancel resolves the cancellation variant; it is not an error.
- Resolve/reject each session exactly once. A second `open` returns `SESSION_BUSY`; a late native callback from an old session cannot finish a new one. Provide `cancel({ sessionId })` and scoped progress/state subscriptions that are removed when the session finishes.
- Define Close, Save draft and Use video distinctly. Close cancels the host operation while keeping already-autosaved draft state according to the configured store; Save draft waits for writes and returns `draft-saved`; Use video finalizes recording, flushes edits, exports the exact committed revision and returns `exported`. Back/swipe/host destruction follow the same rules.

Implementation checklist:

- [ ] Create a single shared native session coordinator plus platform presentation/lifecycle wrappers. Plugins delegate to it instead of maintaining their own camera, exporter or project state.
- [ ] Implement the runtime factory, JSON profile registry, initialize/dispose bridge methods and configuration-before-import bootstrap. Test idempotent/concurrent initialize, unknown profiles, open-before-initialize, differing configuration, active-session rejection and clean retry after initialization failure. Do not serialize internal factories/store instances into plugin calls.
- [ ] Implement measured export layout using the engine's actual composition positions, not a sum of nominal probe durations or stale preview status. Reuse a preview layout only when it is proven to describe the exported composition/revision. If the current native API needs to expose those positions, make the smallest separately reviewed `pulse-editor` change and parent-pointer update with native timing fixtures; do not fabricate a measurement in JavaScript.
- [ ] Create an embedded entry alongside the standalone entry. Reuse providers needed for gestures, safe areas, theme and controlled navigation; parameterize initialization and lifecycle. Configure embedded mode before importing modules with initialization effects. Split standalone bootstrap modules from component exports so an import cannot install global logging/link listeners, open/migrate a global DB, start upload/model queues, request notifications or activate keep-alive before the request's options exist. Hiding buttons or skipping a provider after a top-level import is insufficient.
- [ ] Keep standalone onboarding, Home navigation, pairing/deferred-pairing, global URL listeners, root file sweeps, upload manager and notification/foreground-service startup absent from the embedded bootstrap. When captions generation is off, importing/rendering the editor must not start transcription/model-download jobs. Audit splash/signing/linking config plugins separately: the host owns launch UI, signing and URL registration, even when the SDK uses Expo modules internally.
- [ ] Keep host navigation and deep links under host ownership. Preserve the host's status bar/orientation/audio state on dismissal. Do not hijack the `pulsecam` scheme or register Pulse associated domains in every host.
- [ ] Make resource cleanup idempotent: finalize/cancel capture, stop preview/audio/model jobs that belong to the session, cancel export if requested, flush or report pending writes, unsubscribe callbacks and release handles. Keep long-lived RN runtime reuse separate from session resource ownership.
- [ ] Make output readable after dismissal: copy/move successful exports and sidecars to an SDK-owned handoff directory, issue an opaque output handle, and guarantee its lifetime until explicit `releaseOutput(handle)`/host adoption. The host can copy through the native adapter; an uninstall/site clear is outside this lifetime. Never clear handed-off outputs as part of transient cache cleanup.
- [ ] Return URIs/handles instead of bridge-encoded base64 video. Document that a URI is not automatically readable by a WebView; the host adapter supplies its supported file conversion/read/copy method. Confirm host copying works with the RN view already closed and the next session open.
- [ ] Optional PulseVault behavior remains disabled in V1. If preserved behind configuration, keep credentials in a distinct SecretStore and rerun lifecycle/Android foreground-service checks; do not accidentally ship active standalone upload services.

### Check-in 2: real flow, no host-specific editing implementation

- [ ] Demo record/import → reorder/trim/rotate/crop/speed/mute → caption correction/placement → Use video → host preview, once on each OS.
- [ ] Demo Save draft followed by reopen; show caption corrections/position survive. Demo Close/cancel and re-open without duplicate camera/audio sessions.
- [ ] Run the same complete fixture through SQLite and memory stores and compare JSON/edit/caption expectations. Show revision-conflict and missing-media behavior.
- [ ] Initialize namespace A, save a draft, dispose, initialize namespace B and verify A's drafts/media are not opened or swept; return to A and reopen the original. Repeat identical initialization and show no duplicate DB migration, listener or job. Verify changing profiles while a session is active fails without disturbing it.
- [ ] Demonstrate standalone Pulse still opens and exports its existing drafts. Record intentional behavior changes separately; extraction should preserve edit output.
- [ ] Hand the browser owner pinned core/UI tarballs and checksums, schema fixtures and expected results. Confirm neither shared package imports the native engine/database.
- [ ] Stop plugin-specific implementation if the shared session cannot release camera/audio or cannot guarantee output ownership. Resolve that once in `pulse-native` rather than putting compensating code into both plugins.

## Milestone 3 — ship the two thin adapters and prove all four combinations

Goal: a host team installs a documented package and native artifacts, invokes the same API, and gets the same project/result semantics on both OSes. No host rebuilds Pulse's feature logic or calls standalone routes.

### 3.1 Implement bridge adapters and installation metadata

- [ ] Add Capacitor TS registration and Swift/Kotlin bridge code under `packages/capacitor-pulse`. Convert calls/results/events to the shared session API and delegate presentation/dismissal to the native SDK.
- [ ] Add Cordova JS/TS wrapper, `plugin.xml`, Swift/Objective-C bridge and Android bridge under `packages/cordova-plugin-pulse`. Preserve callbacks until one terminal result, then release them. Use the same session/error/result types; wrap `cordova.exec` in the public Promise API.
- [ ] Keep bridge code limited to validation/serialization, SDK initialization, presentation and result/event delivery. Add a review checklist rejecting copied recorder/editor/export/store logic in either adapter.
- [ ] Declare verified host versions, native artifact versions, OS minimums, permission strings, privacy manifests and any host lifecycle integration. Capacitor's support for Cordova plugins is not proof this custom plugin works in both; test the two explicit adapters.
- [ ] Package iOS frameworks/Hermes/resources and Android artifacts with their tested transitive dependency metadata. Keep Debug/Release selection explicit. Do not claim a lone AAR is a complete fused SDK unless the artifact inspection proves it.
- [ ] For the integrated fallback, supply versioned Podfile/Gradle/JS-bundle instructions or reviewed setup tooling for each host. State plainly that the host needs RN/Expo build tooling. Do not hide unsupported host edits in install hooks.
- [ ] Generate TS types from the shared source/exported contracts; do not maintain four copies of the shape. Verify platform errors can be serialized without stacks, native classes or secret data in the public API.

### 3.2 Build small reproducible example hosts

- [ ] Pin Capacitor/Cordova platform and CLI versions in each example. Create an independent npm manifest/lockfile per example. Avoid widening/upgrading the root app's dependencies to scaffold demos.
- [ ] Example UI has only Open recorder, Open editable fixture, Save/reopen draft, Cancel, and a result panel with returned metadata, host playback and Copy/exported-file verification. It contains no Pulse editing logic.
- [ ] Both examples first call `Pulse.initialize({ apiVersion: 1, storageNamespace: 'example-host', storeProfile: 'sqlite', mediaProfile: 'native-files', secretProfile: 'none' })`, await its returned `runtimeId`, then call `Pulse.open({ apiVersion: 1, runtimeId, sessionId, mode: 'record', captions: 'off' })`. Show initialization failure/retry distinctly from a session result. Include a memory-profile demo and a namespace-isolation test; keep factory objects entirely inside the RN bootstrap.
- [ ] Create package scripts: each plugin gets `build`, `test`, `pack:check`; native gets `build`, `test`, `test:contracts`; shared UI gets `build`, `test`; examples get `build`, `sync`, `open:ios`, `open:android`, `build:ios`, `build:android`. The shown `test -- --runInBand` commands assume the package-local Jest configuration selected in milestone 1; bridge unit tests do not replace device lifecycle tests. Implement scripts as wrappers around pinned framework tooling and record their exact native target/scheme names.
- [ ] Capacitor `sync` wraps `cap sync`; open commands wrap `cap open ios/android`. Cordova `sync` wraps `cordova prepare`; build commands wrap `cordova build ios/android` with the documented configuration. Do not label a web bundle build as a native release build.
- [ ] Install packed plugins/native artifacts into examples, not aliases to unbuilt source. Verify a clean second checkout can install from the documented artifact registry/local artifact bundle without the original developer's caches.
- [ ] Add smoke/regression test instructions that work on physical devices. A teammate unfamiliar with Pulse follows the instructions and records any undocumented steps.

Commands after package/example scripts are implemented:

```bash
npm --prefix packages/pulse-core test -- --runInBand
npm --prefix packages/pulse-editor-ui test -- --runInBand
npm --prefix packages/pulse-native run test:contracts
npm --prefix packages/pulse-native test -- --runInBand
npm --prefix packages/capacitor-pulse run build
npm --prefix packages/capacitor-pulse test -- --runInBand
npm --prefix packages/capacitor-pulse run pack:check
npm --prefix packages/cordova-plugin-pulse run build
npm --prefix packages/cordova-plugin-pulse test -- --runInBand
npm --prefix packages/cordova-plugin-pulse run pack:check
npm --prefix examples/capacitor-pulse-host ci
npm --prefix examples/capacitor-pulse-host run build
npm --prefix examples/capacitor-pulse-host run sync
npm --prefix examples/capacitor-pulse-host run build:ios
npm --prefix examples/capacitor-pulse-host run build:android
npm --prefix examples/cordova-pulse-host ci
npm --prefix examples/cordova-pulse-host run build
npm --prefix examples/cordova-pulse-host run sync
npm --prefix examples/cordova-pulse-host run build:ios
npm --prefix examples/cordova-pulse-host run build:android
npx tsc --noEmit
npm run lint
npm test -- --runInBand
```

Run `npm ci` separately in each new package only if its chosen packaging layout has its own lockfile/dependencies; document this setup before the commands above. Package scripts must fail on a skipped required test. Preserve the baseline checks and failures from milestone 1 rather than claiming pre-existing failures were introduced or fixed by the SDK work.

### 3.3 Required demo/test matrix and evidence

| Host              | OS                      | Required proof                                                                                                                                         |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Capacitor example | iOS physical device     | Release install, camera/audio permissions, capture/edit/export, caption sidecars, host playback/copy after dismissal, lifecycle and 20 session cycles. |
| Capacitor example | Android physical device | Same, plus activity recreation/back button and no unused Pulse upload service or React Application cast crash.                                         |
| Cordova example   | iOS physical device     | Same, plus callback lifetime, host lifecycle coexistence and native dismissal behavior.                                                                |
| Cordova example   | Android physical device | Same, plus callback lifetime, activity recreation/back button and service/Application audit.                                                           |

Use simulators/emulators for reproducibility and seeded fixtures in addition to these device rows. Record OS/device model, plugin/SDK/app/core revisions, build configuration, artifact hashes and exact commands for every row. A successful Capacitor iOS run does not satisfy any of the other three rows.

- [ ] For every row test JSON-only initialization, identical initialization idempotency, open-before-initialize, conflicting namespace/profile, initial permission grant, denial, cancellation, another `open` while busy, Save draft, export failure and missing media. Every session returns exactly one terminal outcome; no unresolved callback or orphan view remains. Reconfiguration cannot bypass the active-session gate.
- [ ] Background/foreground during preview/capture/export; incoming audio interruption; host navigation after result; Android Back and iOS dismissal; host process termination/relaunch. Define interrupted-session recovery rather than promising a Promise survives process death. Persistent drafts reopen; a killed session does not silently report export success.
- [ ] Repeat open/close 20 times. Log camera/audio/model/runtime ownership and measure memory before/after so an obvious upward leak or retained camera can be diagnosed. Establish a device-specific tolerance from baseline instead of inventing a universal memory number.
- [ ] Export deterministic multi-clip fixtures containing reorder, trim, quarter-turns, flip, crop, mute and 0.5×/2× speed. Include video/audio tracks with different ends and verify returned measured layout, sidecar timing and true duration agree with the exported project revision. Compare expected durations/geometry and sampled frames to standalone Pulse. Native decoder timing may differ by a frame: document tolerances from actual engine behavior, and fail larger unexplained differences.
- [ ] Export flash/click synchronization samples from `assets/dev/sync/` where available; inspect audio/video timing and silence/mute intervals. FFmpeg/ffprobe may be QA tools; this does not reintroduce FFmpeg into the app. Record the analysis command and input/output hashes. Do not regenerate the fixture scripts unless their inputs are actually needed.
- [ ] Round-trip generated captions, corrected/deleted words, sentence breaks, canonical source-millisecond timestamps, legacy centisecond conversion, speed/reorder mapping and caption position. Verify sidecar contents separately from MP4 playback and ensure the host can copy/read them after dismissal.
- [ ] Round-trip both original and selected legacy baked media references, including a legacy clip that also carries historical edit settings. Confirm selected playback/export is full-span identity, then reset/re-edit from the pristine original and only release the baked asset after a successful commit/reference check. A revision-conflicted operation changes neither asset selection nor files and emits no commit notification.
- [ ] Verify output lifetime: keep output A, finish session B, copy/play A, explicitly release A, then verify the released handle reports the documented state. No transient cache cleanup can erase A early.
- [ ] Verify embedded defaults make no PulseVault request, pair no server, register no standalone global link handler and start no upload foreground service. The offline recording/editing/export demo runs without a backend; model download is a separately requested action.
- [ ] Verify standalone upgrade/migration paths using copied test data, preserving current media and caption edits. Never use a person's only draft library as destructive migration test data.
- [ ] Inspect release packages for duplicate React runtimes/symbols, missing resources, accidental developer paths, signing credentials and debug-only assets. License/notice artifacts match redistributed dependencies.

### Check-in 3: release candidate another developer can install

- [ ] Demo the four rows from built release artifacts with Metro stopped and show the returned file playing in the host.
- [ ] Deliver the two plugin tarballs, native artifact bundle/Maven coordinates with transitive metadata, core/UI tarballs, checksums, source revisions and exact install instructions.
- [ ] Deliver the complete shared fixture/store reports, bridge tests, standalone regression summary, device matrix and known limitations. A missing row is explicitly incomplete, not “covered by shared code.”
- [ ] Deliver a small host-integration guide explaining initialization, lifecycle/deep-link ownership, permissions, store/asset/secret configuration, saved-draft versus exported completion, cancellation, file adoption/release and interrupted-session recovery.
- [ ] Browser owner reruns its contract fixtures against the final pinned core/UI versions. Any incompatible shared change gets a coordinated version bump and migration before either track is called complete.
- [ ] Stop release publication if any row loses manual captions, misreports completion, leaves camera/audio active, cannot read a returned file, or requires undocumented host changes. Fix the shared layer or adapter responsible and rerun only the affected checks plus shared regressions. Mark complete after these gates pass.

## Reference documentation

Read the versioned SDK page before following generic examples that may target a newer Expo release. The custom Pulse stack still needs the milestone-1 spike; documentation support is not a successful build.

- [Expo SDK 57 Brownfield API and artifact CLI](https://docs.expo.dev/versions/v57.0.0/sdk/brownfield/) — SDK-compatible toolkit, communication, dismissal and native artifact build options.
- [Expo existing-native-app overview](https://docs.expo.dev/brownfield/overview/) — integration models and current compatibility limits; brownfield support is described as alpha.
- [Expo isolated approach](https://docs.expo.dev/brownfield/isolated-approach/) — packaging separate native libraries; verify dependency/resource distribution in the actual outputs.
- [Expo integrated approach](https://docs.expo.dev/brownfield/integrated-approach/) — fallback when prebuilt artifact integration is unsuitable.
- [React Native existing-app integration](https://reactnative.dev/docs/integration-with-existing-apps) — native host integration concepts; use APIs compatible with the pinned RN release.
- [Capacitor iOS plugins](https://capacitorjs.com/docs/plugins/ios) and [Android plugins](https://capacitorjs.com/docs/plugins/android) — native screens, calls and event delivery.
- [Cordova plugin development](https://cordova.apache.org/docs/en/latest/guide/hybrid/plugins/index.html) — shared JS surface with per-platform bridges and plugin metadata.
- [Capacitor Cordova compatibility](https://capacitorjs.com/docs/plugins/cordova) — install hooks/configuration are not automatically portable; the four-combination matrix remains required.
