# Developer AI editing preview

The standalone iPhone editor can create a separate editable rough cut from timed speech.
It uses the existing Parakeet/Whisper recognizer and Apple's explicit on-device
`SystemLanguageModel`. The language model selects supplied passage IDs; application code owns
source timestamps, ordering, padding and the 115-second duration budget. Nothing is uploaded.

This is the first cut-focused checkpoint of [#341](https://github.com/mieweb/pulse/issues/341).
OmniShotCut conversion and written summaries remain follow-up experiments. Existing Summary
projects collect beats and continue to work separately.

## Enable and test

The feature defaults on in iOS development sessions. Offline Release builds require
`PULSE_DEVELOPER_BUILD=1`; CI/store builds ignore that opt-in. `PULSE_AI_EDIT=0` disables the
experiment in either build type. Both the editor action and the execution entry point check the
gate. Ordinary release builds expose no AI edit action.

The [phone handoff](testing/ai-edit-phone-build.md) records the installed build and its compatible
source baseline, verification and remaining acceptance checks.

Build with Node 24.3+ and Xcode 27+, using the repository's native build workflow. The local
`modules/expo-ai-editor` Expo module requires a native rebuild; a JavaScript reload cannot add it.
On a local phone handoff, set `PULSE_TEST_NOTES_FILE=docs/testing/ai-edit-test-notes.json` before
bundling. Notes must match that build's app version, including when integrating on a newer phone
baseline. Follow the shared iOS testing skill for simulator checks, exact bundled notes, device
leasing and verified release.

On an Apple Intelligence-capable iPhone with iOS 26+, enable Apple Intelligence and wait for its
system model to become available. Download the chosen speech model through On-device AI before
going offline. Open a spoken-video project, open the editor, and tap **AI edit** (the sparkle
button). The result opens as a new **AI cut** project. Review/trim/remove clips and export normally.

## Processing and persistence

```mermaid
flowchart LR
  source[Source project] --> words[Local timed transcript]
  words --> passages[Passages with source IDs]
  passages --> model[Local passage selection]
  model --> validate[Validate IDs and fit complete passages]
  validate --> copy[Stage independent media copies]
  copy --> commit[Atomically save a new editable draft]
```

Speech inference temporarily pauses the captions queue and waits for its in-flight job to stop.
Existing valid transcripts and caption corrections are reused. Speech weights are released before
language generation. Long inputs are shortlisted in bounded batches before a global selection.
Selected passages keep their source order, speed and picture transforms. Padding stays inside
source limits and adjacent word boundaries. Written model timestamps are never accepted.

Creation stages one independent copy per selected source segment and stores the excerpt windows
and copied transcripts in one transaction. Source changes, cancellation, copy failures and stale
timing reject the save and clean up the staged destination. No schema migration is needed. See
[persistence.md](persistence.md) for authoritative media ownership and recovery rules.

## Limits and verification

This first experiment targets English spoken video, foreground execution and projects under
twenty minutes. Muted source clips require unmuting; projects with separate voiceover takes or a
muted source track are rejected explicitly. The simulator verifies native UI and
unavailability handling; it cannot establish Apple Intelligence generation quality or phone
performance. The model can omit important context: review the result before sharing. A
punctuation-free transcript may require passage breaks at word boundaries. Excerpt exports use
the existing native rendering path and usually re-encode.

Regression coverage includes source timing, speed, padding, invalid IDs, duration fitting,
hierarchical selection, cancellation, independent copies, transcript remapping and failed-save
rollback. For acceptance, use an 8–12 minute recording with 5–8 preselected essential points;
compare the cut with a human reference, measure the actual exported duration and record ASR,
selection and export latency separately. Cold-launch offline execution, thermal behavior and
semantic quality require target-phone evidence.
