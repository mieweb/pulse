# On-device AI editing module

This local Expo module selects existing transcript passages using Apple's on-device
`SystemLanguageModel.default` and guided generation. It creates a fresh session per selection and
contains no cloud fallback or app-managed model-download path.
[Generation implementation](ios/AiEditorEngine.swift#L165),
[Apple model reference](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel),
[guided generation guide](https://developer.apple.com/documentation/foundationmodels/generating-swift-data-structures-with-guided-generation).
The Swift bridge exposes these calls through a TypeScript wrapper using Expo's Module API.
[Bridge](ios/AiEditorModule.swift#L20), [wrapper](src/AiEditorModule.ts#L41),
[Expo reference](https://docs.expo.dev/modules/module-api/).

[Feature guide and pipeline](../../docs/ai-editing.md) ·
[Phone build and acceptance checks](../../docs/testing/ai-edit-phone-build.md) ·
[Simulator screenshots and results](../../screenshots/validation/ai-edit/editable-prompt/README.md)

The supported workflow is the [standalone iPhone preview](../../docs/ai-editing.md#enable-and-test).
The native availability check requires iOS 26+, rejects simulators and reports an ineligible device,
disabled Apple Intelligence or a model that is not ready.
[Availability implementation](ios/AiEditorEngine.swift#L30),
[Apple availability reasons](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/availability-swift.enum/unavailablereason).
The wrapper reports unavailable on Android/web and when its native module is absent.
[Platform/module guards](src/AiEditorModule.ts#L54). Apple explains device/region eligibility and
initial system-model preparation in its
[generation and availability guide](https://developer.apple.com/documentation/foundationmodels/generating-content-and-performing-tasks-with-foundation-models).

Call `availability()` before
`selectPassages([{ id, text, durationMs }], targetDurationMs, editingPrompt?)`. The public result is
`{ selectedIds: string[] }`. The native call also carries an internal request ID.
[Public signatures](src/AiEditorModule.ts#L31), [native signatures](src/AiEditorModule.ts#L41),
[bridge](ios/AiEditorModule.swift#L20). Native input guards accept 1–32 passages, at most 10,000
UTF-16 units of transcript text, unique nonempty IDs of at most 80 UTF-16 units and finite positive
passage durations and time budgets. [Input validation](ios/AiEditorEngine.swift#L97). The
application uses smaller batches of at most 24 passages and 7,000 estimated characters per batch.
Apple measures model context size in tokens.
[Batching implementation](../../src/features/ai-edit/selection.ts#L8),
[Apple context-size reference](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel).

[prompt.ts](src/prompt.ts) owns the default editorial text, Default/Highlights/Work update/Story
presets and `validateAiEditPrompt`. The validator trims outer whitespace, requires text and enforces
a 2,000 UTF-16-unit limit. The wrapper supplies that default when instructions are omitted. Swift
independently validates received instructions and appends its fixed selection protocol.
[Wrapper default](src/AiEditorModule.ts#L80),
[native prompt validation](ios/AiEditorEngine.swift#L83),
[fixed protocol](ios/AiEditorEngine.swift#L174). Regressions cover the default, presets, UTF-16
boundary, validation and forwarding. [Prompt tests](src/prompt.test.ts),
[wrapper tests](src/AiEditorModule.test.ts). The user-facing behavior is described in
[Editing instructions and styles](../../docs/ai-editing.md#editing-instructions-and-styles).

The native protocol asks for IDs ranked by editorial importance. The dynamic schema constrains
generated IDs to the supplied choices. The prompt asks for coherent passages and complete thoughts.
[Protocol](ios/AiEditorEngine.swift#L174), [schema](ios/AiEditorEngine.swift#L183),
[Apple dynamic-schema guide](https://developer.apple.com/documentation/foundationmodels/generating-swift-data-structures-with-guided-generation).
The planner rejects unknown/repeated IDs, fits whole candidate passages including padding and
restores source chronology. The save boundary revalidates source identity, timing and duration.
[ID validation](../../src/features/ai-edit/planner.ts#L153),
[fitting and ordering](../../src/features/ai-edit/planner.ts#L165),
[save validation](../../src/db/ai-edits.ts#L45). See the feature guide's
[limits and verification](../../docs/ai-editing.md#limits-and-verification) for review requirements
and [processing/persistence](../../docs/ai-editing.md#processing-and-persistence) for the complete
pipeline.

The wrapper and engine allow one request at a time. `cancel()` waits for that selection to settle.
Matching request IDs preserve cancellation before native registration.
[Wrapper request guard](src/AiEditorModule.ts#L80),
[wrapper cancellation](src/AiEditorModule.ts#L108),
[native request guard](ios/AiEditorEngine.swift#L94),
[native cancellation](ios/AiEditorEngine.swift#L142). Module destruction permanently closes the
engine and cancels its active work. [Destruction handler](ios/AiEditorModule.swift#L48),
[engine invalidation](ios/AiEditorEngine.swift#L159). The
[cancellation regressions](src/AiEditorModule.test.ts) exercise early cancellation and overlap.
Native errors report refusal, context limits, unsupported languages and other failures to
JavaScript. The caller surfaces a failed selection. [Error mapping](ios/AiEditorEngine.swift#L207),
[selection orchestration](../../src/features/ai-edit/selection.ts#L36),
[Apple generation error API](https://developer.apple.com/documentation/foundationmodels/languagemodelerror).

The [root dependency](../../package.json) is `file:modules/expo-ai-editor`. The
[module configuration](expo-module.config.json) registers the Apple bridge. Expo documents local
`modules/` discovery and exclusions in its
[autolinking reference](https://docs.expo.dev/modules/autolinking/). PulseKit excludes this module
in both its [dependency classification](../../embed/deps.json) and
[autolinking configuration](../../embed/package.json). Follow the
[project build setup](../../docs/ai-editing.md#enable-and-test) with Node 24.3+ and Xcode 27+.
Changing native code requires rebuilding the app. See
[Expo's rebuild guidance](https://docs.expo.dev/develop/development-builds/introduction/#rebuild-when-native-code-changes).
The podspec retains the iOS 16.4 deployment target and weakly links FoundationModels. The engine
guards generation at iOS 26 and newer error APIs at iOS 27. [Podspec](ios/AiEditor.podspec),
[CocoaPods weak-framework reference](https://guides.cocoapods.org/syntax/podspec.html#weak_frameworks),
[generation guard](ios/AiEditorEngine.swift#L115), [error guards](ios/AiEditorEngine.swift#L209).

Use the [recorded verification](../../docs/testing/ai-edit-phone-build.md) and
[simulator evidence](../../screenshots/validation/ai-edit/editable-prompt/README.md) to distinguish
build/UI checks from phone generation, semantic quality, offline execution and export evidence. The
[remaining phone acceptance checklist](../../docs/testing/ai-edit-phone-build.md) defines the
outstanding comparisons, timing, memory/thermal, cancellation and export checks.
