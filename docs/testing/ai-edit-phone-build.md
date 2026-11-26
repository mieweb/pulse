# AI editing phone test build

The 2026-11-25 editable-prompt handoff installed **Pulse 2.8.0 (1)** from local compatibility
integration `7cf04259a3462be6d2b7bc6083bd6f88ce612775`. At handoff, installation and launch passed,
the app was verified running and left open, and the device guard returned `released`. No phone UI
automation or screen sharing was started. The [versioned handoff record][handoff] preserves the
artifact hashes, compared library metadata and release evidence.

Use the [feature guide](../ai-editing.md) for behavior and limits, the
[native module reference](../../modules/expo-ai-editor/README.md) for its API/runtime requirements,
and [AI cut persistence](../persistence.md#ai-cut-projects) for media ownership and recovery.
[Current simulator evidence](../../screenshots/validation/ai-edit/editable-prompt/README.md) records
the editable form; the [initial MVP evidence](../../screenshots/validation/ai-edit/README.md) is
historical.

## Where to start

Open a project, enter its editor and tap **AI edit**, the sparkle beside Export in this phone
integration. The form opens before analysis starts. **Default** contains the original MVP
editorial text; **Highlights**, **Work update** and **Story** replace the editable field. **Reset to
default** restores the original. **Create AI cut** validates and saves instructions locally before
starting analysis; closing without Create does not save edits. These behaviors are defined by the
[form][form], [preferences][preferences] and [prompt constants][prompts], and were exercised in the
[native accessibility report](../../screenshots/validation/ai-edit/editable-prompt/simulator-report.json).

On successful completion, the [result route][route] opens a separate AI-cut project in Timeline
view. The [save implementation][save] preserves the source project. Generation and export on this
editable-prompt build remain acceptance work below; the simulator checked its real unavailable-model
response. The six build-specific instructions were bundled and checked under **About → Release
notes**, as recorded in the [handoff][handoff]. Prepare the downloaded speech model and eligible
Apple Intelligence system model before offline testing; see the
[native availability requirements](../../modules/expo-ai-editor/README.md).

## Source and phone compatibility

The published feature checkpoint is [AI branch commit `6ee6c27`][feature]. Its history includes
[the initial MVP `e3b99d5`][initial] and [cancellation fix `fe06763`][cancellation]. The clean source
checks below used that checkpoint and its committed submodule pins, excluding unrelated
shared-workspace changes.

The phone library already contained persistent-history and voiceover migrations newer than the
feature branch's base. The handoff therefore used local branch `codex/ai-prompt-phone-test` at
`7cf0425`, combining compatible bases `646f309` and `d3a853e` with the AI changes. It retained
`0022_persistent_undo`, `0023_voiceover_takes` and native editor `306ff1d`; these identities are
recorded in the [handoff][handoff]. The clean feature checkout and compatible phone integration
are distinct validation targets.

The compatible editor puts AI edit in its lower command row; the older feature editor places the
same gated callback in its header. Compare the [compatible editor image](../../screenshots/validation/ai-edit/after-editor.png)
with the [feature editor button][editor-button] and [route wiring][editor-route]. Future phone updates must retain the installed
history/voiceover schema and recovery inputs. Use a compatible integration or newer base and the
[persistence rules](../persistence.md), rather than deploying the older feature base over that
library.

The 7cf0425 artifact contained freshly compiled native AI code, a Hermes bundle, six exact test
notes and the explicit developer-build flag. App/extension entitlements and signatures were
verified; the simulator used identical JavaScript/config bytes. The [handoff's build and bundle
checks][handoff] record those results and artifact hashes. The
[native module reference](../../modules/expo-ai-editor/README.md) links the bridge, Apple/Expo APIs
and native rebuild requirements.

## Verification

These are recorded results from the 2026-11-25 handoff, not new application runs during this
documentation update.

| Target                           | Recorded result                                                                                                                                                                                                                            | Evidence and limit                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean feature `6ee6c27`          | Root/embed/client TypeScript, lint, protocol generation, both embed bundles/dependency rules, changed-file formatting and whitespace passed. Jest: **162 suites / 2,230 tests passed**.                                                    | [Commands, counts and source identity][handoff]. One opt-in PulseVault suite containing eight tests was skipped; no upload-integration pass is claimed. These full-suite counts describe the feature checkout.                                                   |
| Compatible integration `7cf0425` | iOS Simulator and signed iPhone Release native builds passed, including the editable-prompt bridge. Exact final simulator payload passed the UI checks below.                                                                              | [Native/bundle records][handoff] and [simulator report](../../screenshots/validation/ai-edit/editable-prompt/simulator-report.json). The full feature-branch test count is not attributed to this integration.                                                   |
| Exact final simulator payload    | Flag-off hid the entry. Flag-on checks covered prefill, four presets/selected states, editing, Reset, keyboard dismissal, no automatic start, prompt preservation after an error, saved prompts after Create/relaunch and six exact notes. | [Report](../../screenshots/validation/ai-edit/editable-prompt/simulator-report.json) and [screenshots](../../screenshots/validation/ai-edit/editable-prompt/README.md). Create reached the native simulator-unavailable response; no generation pass is claimed. |
| Brief guarded phone deployment   | A private SQLite backup preceded installation. Compared draft/segment metadata, persistent-history hashes and schema version matched afterward. Launch/running-app checks passed and the guard released the device.                        | [Physical checks and release fields][handoff]. No phone UI automation, generation, export or VoiceOver pass was recorded.                                                                                                                                        |

[Prompt regressions][prompt-tests], [frozen-job prompt regressions][job-tests] and
[selection regressions][selection-tests] provide source-level coverage for validation, forwarding
and duration fitting. Their existence does not establish model quality on a recording.

## Remaining phone acceptance

The [handoff's remaining checks][handoff] and [feature-guide limits](../ai-editing.md#limits-and-verification)
remain open. Compare Default, another preset and custom instructions on the same real 8–12 minute
English talking-head recording. Review retained meaning, complete thoughts, joins and editable
source windows; measure the exported MP4 and require a duration below 120 seconds. Repeat after a
cold launch in airplane mode with Wi-Fi off and all required assets local. Record transcription,
selection and export times separately, plus memory/thermal behavior, cancellation and backgrounding.

Installation and simulator UI evidence do not establish those outcomes or physical VoiceOver
navigation. Issue [#341](https://github.com/mieweb/pulse/issues/341) tracks OmniShotCut and written summaries. The feature guide records the separate [proposal for editing the audible mix](../ai-editing.md#audio-support-follow-up--proposed-not-implemented).

[handoff]: https://github.com/mieweb/pulse/blob/0159d4e/docs/testing/ai-edit-phone-handoff.json
[feature]: https://github.com/mieweb/pulse/tree/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354
[initial]: https://github.com/mieweb/pulse/commit/e3b99d5
[cancellation]: https://github.com/mieweb/pulse/commit/fe06763ecdc9d27e0985e27d3f7b5f33609b2727
[form]: https://github.com/mieweb/pulse/blob/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354/src/features/ai-edit/ai-edit-screen.tsx
[preferences]: https://github.com/mieweb/pulse/blob/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354/src/features/ai-edit/preferences.ts
[prompts]: https://github.com/mieweb/pulse/blob/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354/modules/expo-ai-editor/src/prompt.ts
[prompt-tests]: https://github.com/mieweb/pulse/blob/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354/modules/expo-ai-editor/src/prompt.test.ts
[job-tests]: https://github.com/mieweb/pulse/blob/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354/src/features/ai-edit/run-ai-edit.test.ts
[selection-tests]: https://github.com/mieweb/pulse/blob/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354/src/features/ai-edit/selection.test.ts
[route]: https://github.com/mieweb/pulse/blob/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354/src/app/ai-edit.tsx
[editor-route]: https://github.com/mieweb/pulse/blob/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354/src/app/editor.tsx
[save]: https://github.com/mieweb/pulse/blob/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354/src/db/ai-edits.ts
[editor-button]: https://github.com/mieweb/pulse/blob/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354/src/features/editor/editor-screen.tsx#L922-L943
