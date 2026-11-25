# On-device AI editing module

Developer experiment for selecting existing transcript passages with Apple's
`SystemLanguageModel` and guided generation. Requires an eligible physical iPhone,
iOS 26 or later, Apple Intelligence enabled, and its system model ready. Android,
web, simulators, older iOS versions and builds without this module return an
unavailable status. The module uses no cloud model or app-managed model downloads.

Import `src/AiEditorModule.ts` and call `availability()` before
`selectPassages([{ id, text, durationMs }], targetDurationMs)`. The result is
`{ selectedIds: string[] }`, ranked by descending editorial importance. The caller
restores source chronology after fitting the duration budget. Each call uses a fresh
local session and accepts at most
32 passages, 10,000 UTF-16 units of transcript text, unique IDs of at most 80 UTF-16
units and finite positive durations. These bounds reduce context use but do not
guarantee that every language fits the system model's context. The JavaScript
planner owns batching and validates IDs, order and the actual final duration.

One request runs at a time. `cancel()` requests Swift task cancellation and resolves
after that request settles; the engine rejects a cancelled result and releases its
busy state before allowing a new request.
Model refusal, context limits, unsupported languages, unavailability and failures
are reported to JavaScript without substituting synthetic selections.

The root package references this module as `file:modules/expo-ai-editor`, and Expo
discovers it under the root `modules/` directory. It is classified as excluded in
`embed/deps.json` and explicitly excluded from PulseKit's native autolinking.
Rebuild the iOS app
after adding it; a Metro reload cannot install a native module. FoundationModels is
weak-linked, preserving the app's iOS 16.4 deployment target. This version uses the
iOS 27 error APIs behind availability checks, so building requires Xcode 27 or
later; runtime generation remains available on eligible iOS 26 devices.

References: [guided generation](https://developer.apple.com/documentation/foundationmodels/generating-swift-data-structures-with-guided-generation),
[model availability](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/availability-swift.enum).

Native compilation checks do not verify model quality, latency, offline inference,
memory use, battery use or behavior on a physical device. Those checks remain
required before claiming on-device support for the experiment.
