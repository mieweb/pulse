# Editable AI prompt verification

These images record the 2026-11-25 **iPhone 17 Pro / iOS 26.0 simulator** checks of local phone
integration `7cf04259a3462be6d2b7bc6083bd6f88ce612775`, corresponding to feature
[`6ee6c27`][feature]. The simulator used an isolated synthetic project and the identical
JavaScript/config payload recorded for the phone artifact in the
[versioned handoff ledger][handoff]. Its separate phone checks establish installation, launch and
compared library metadata; generation/export were not recorded as passes.

Use the [feature guide](../../../../docs/ai-editing.md) for the workflow and limits,
[native module reference](../../../../modules/expo-ai-editor/README.md) for model/bridge behavior,
[AI cut persistence](../../../../docs/persistence.md#ai-cut-projects) for ownership/recovery and
[phone handoff guide](../../../../docs/testing/ai-edit-phone-build.md) for source compatibility and
remaining acceptance. The [parent images](../README.md) are the older automatic-start MVP.

| Evidence                                                             | Screenshot                         | Supporting check in the report                                                                    |
| -------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| Original MVP text prefilled; four presets, Reset and explicit Create | [Default](default.png)             | `defaultPrefilled`, `doesNotAutoRun`.                                                             |
| Preset selected and its instructions visible                         | [Highlights](highlights.png)       | Each `presets` entry records exact text and exclusive native selected state.                      |
| Custom text with software keyboard and accessible Done               | [Keyboard](keyboard.png)           | `customTextEditable`, `customDeselectsPresets`, `keyboardVisibleAndDismissedViaAccessibleButton`. |
| Updated app-visible instructions                                     | [Release notes](release-notes.png) | `allSixExactNotesVerifiedInNativeAccessibility`, `lastReleaseNoteScrolledVisible`.                |

The field/style behavior comes from the [form][form], [prompt constants and validation][prompts]
and [local preferences][preferences]. **Create** saves valid instructions before analysis;
closing without Create does not save edits. The [sanitized simulator report](simulator-report.json)
records Reset, prompt preservation after the real native simulator-unavailable response, and
saved instructions after closing/reopening and a full app relaunch. It also records the ordinary
release configuration hiding the AI action. These were native accessibility queries/actions;
no coordinate fallback or substitute generation result was used.

The [handoff ledger][handoff] records full source checks and 2,230 passing tests for clean feature
commit 6ee6c27, separately from the native/bundle checks on compatibility integration 7cf0425.
[Prompt regressions][prompt-tests] and [frozen-job regressions][job-tests] provide source-level
coverage for the default, presets, validation and forwarding. The
[main guide](../../../../docs/ai-editing.md#editing-instructions-and-styles) explains the fixed
output rules and application-owned duration/order checks.

The [report](simulator-report.json) records cleanup: the owned session ended, host runner exited,
simulator runner disappeared and its endpoint stopped. The fixture prompt was restored to Default.
These checks do not establish physical VoiceOver behavior, model generation, style quality,
offline completion or export. Those remain in the
[phone acceptance checklist](../../../../docs/testing/ai-edit-phone-build.md#remaining-phone-acceptance).

[feature]: https://github.com/mieweb/pulse/tree/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354
[handoff]: https://github.com/mieweb/pulse/blob/0159d4e/docs/testing/ai-edit-phone-handoff.json
[form]: https://github.com/mieweb/pulse/blob/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354/src/features/ai-edit/ai-edit-screen.tsx
[prompts]: https://github.com/mieweb/pulse/blob/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354/modules/expo-ai-editor/src/prompt.ts
[preferences]: https://github.com/mieweb/pulse/blob/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354/src/features/ai-edit/preferences.ts
[prompt-tests]: https://github.com/mieweb/pulse/blob/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354/modules/expo-ai-editor/src/prompt.test.ts
[job-tests]: https://github.com/mieweb/pulse/blob/6ee6c27a6ea43eb17f37d273ee21d619b7c4a354/src/features/ai-edit/run-ai-edit.test.ts
