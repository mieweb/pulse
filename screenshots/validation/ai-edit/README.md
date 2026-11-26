# Initial AI edit developer preview verification

This directory records the **initial automatic-start MVP** checked on 2026-11-25. Its final
payload was local phone integration `e5e80694145a6533c77bc42fc3d56256b1f403e5`, implementing feature
`fe06763`. The [initial handoff record at `3fb8ec8`][handoff] preserves that build's identities,
hashes, checks and limits. The earlier baseline editor image predates the final AI UI.

The later [editable-prompt evidence](editable-prompt/README.md) describes integration `7cf0425`;
its form opens before analysis. Use the [feature guide](../../../docs/ai-editing.md),
[native module reference](../../../modules/expo-ai-editor/README.md),
[AI cut persistence](../../../docs/persistence.md#ai-cut-projects) and
[phone handoff guide](../../../docs/testing/ai-edit-phone-build.md) for the current workflow.

The images were captured in a dedicated **iPhone 17 Pro / iOS 26.0 simulator**, using an isolated
synthetic project whose editor displays a 16-second timeline. They contain no user's recording.
The initial screen's automatic start is defined by its [versioned UI implementation][ui]; the
editable form supersedes that behavior.

| Evidence                                     | Screenshot                                                             | What it shows                                           |
| -------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| Baseline editor layout                       | [Before](before-editor.png)                                            | Editor command row before the AI action was added.      |
| Initial final JavaScript, developer flag off | [Ordinary release](ordinary-release-editor.png)                        | AI entry absent from the editor.                        |
| Initial final JavaScript, developer flag on  | [Developer editor](after-editor.png)                                   | AI action in the compatible editor's lower command row. |
| Native availability/error path               | [Simulator unavailable](unavailable.png)                               | Physical-iPhone requirement with retry/back controls.   |
| Initial build's bundled instructions         | [Release notes](release-notes.png), [bottom](release-notes-bottom.png) | Historical notes for e5e8069, before editable prompts.  |

The [initial handoff ledger][handoff] records identical phone/simulator JavaScript and config,
flag behavior, the native unavailable state, six release notes and native build/signature checks.
Native accessibility queries/taps exercised the editor action and Back; scrolling used the
accessible ScrollView. No coordinate fallback was used, and owned simulator automation stopped
after the checks.

The ledger records the separate phone installation/launch and compared library-metadata check,
with the physical device released and no phone UI automation or screen sharing. Its
`physicalInferenceVerified` and `physicalExportVerified` values are false. These images do not
establish generation, semantic quality, thermal behavior, cold-launch offline completion, export
or physical VoiceOver navigation. See the
[remaining phone acceptance](../../../docs/testing/ai-edit-phone-build.md#remaining-phone-acceptance).

[handoff]: https://github.com/mieweb/pulse/blob/3fb8ec8/docs/testing/ai-edit-phone-handoff.json
[ui]: https://github.com/mieweb/pulse/blob/fe06763ecdc9d27e0985e27d3f7b5f33609b2727/src/features/ai-edit/ai-edit-screen.tsx
