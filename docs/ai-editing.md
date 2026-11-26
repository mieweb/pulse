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
button). Review or edit **Editing instructions**, then tap **Create AI cut**. The result opens as a
new **AI cut** project. Review/trim/remove clips and export normally.

## Editing instructions and styles

The editable field starts with the successful original editorial instructions. **Default**,
**Highlights**, **Work update** and **Story** fill that same field with a complete prompt, which can
then be edited. **Reset to default** restores the original. The app remembers the last used
instructions in its local settings when a cut is started; no database migration is needed.

Instructions must contain text and fit within 2,000 UTF-16 code units (the field's character
counter uses the same limit). One validated copy is captured when the job starts and used for
every shortlist and final selection call. Changing a later run's preference cannot change an
in-flight edit. Missing or invalid restored preferences fall back to the original default.

`modules/expo-ai-editor/src/prompt.ts` is the authoritative source for the default editorial text,
presets and JavaScript validation. Swift validates the received text independently and appends the
existing fixed output protocol. The default editorial text plus that protocol reproduces the
original full instructions exactly. Selection IDs, source ranges, ordering and duration remain
enforced by the existing schema and planner. Style preferences guide selection of original speech;
they do not synthesize a new voice or rewrite the recorded words.

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
twenty minutes. Muted playable source clips require unmuting. Projects with a muted source track
or any saved voiceover take are rejected, including when the voiceover track itself is muted.
These guards prevent the source-speech-only pipeline from silently discarding narration or
changing the saved audio mix. They run before analysis and are rechecked during draft creation;
see [audio support guards](../src/db/ai-edits.ts) and [analysis](../src/features/ai-edit/run-ai-edit.ts).

Beats with zero effective duration are excluded from analysis and the generated cut. They remain
in the original project and in the complete source-change signature checked before saving. This
is intentional: a zero-length beat has no playable interval and can represent a failed native
duration read. It follows the editor's existing [playable timeline rule](../src/utils/segment-window.ts).
If every beat is empty, AI editing stops with an actionable message instead of creating an empty cut.

The simulator verifies native UI and unavailability handling; it cannot establish Apple Intelligence generation quality or phone
performance. The model can omit important context: review the result before sharing. A
punctuation-free transcript may require passage breaks at word boundaries. Excerpt exports use
the existing native rendering path and usually re-encode.

Regression coverage includes source timing, speed, padding, invalid IDs, duration fitting,
hierarchical selection, cancellation, independent copies, transcript remapping and failed-save
rollback. For acceptance, use an 8–12 minute recording with 5–8 preselected essential points;
compare the cut with a human reference, measure the actual exported duration and record ASR,
selection and export latency separately. Cold-launch offline execution, thermal behavior and
semantic quality require target-phone evidence.

## Audio support follow-up — proposed, not implemented

The audio restrictions above are MVP limits. The following plan supplements the broader
[#341](https://github.com/mieweb/pulse/issues/341) effort; these tasks have no committed delivery
date, and the current guards remain in place until the relevant behavior is verified.

- [ ] **Analyze the audible timeline.** Build on the compatible voiceover/history schema described
      in the [phone handoff](testing/ai-edit-phone-build.md). Define the AI input from the saved audio
      mix, honoring clip mute, source-track mute and voiceover-track mute. Transcribe audible speech
      with timing mapped to the original timeline. Include audio settings and narration edits in cache
      keys and source-change checks. Use the same composed timeline clock and frame-snapped clip
      starts as native preview/export so joins do not drift. Do not select speech that the user has muted; report when no
      audible speech is available.
- [ ] **Preserve narration through the cuts.** Map selected timeline ranges to the new project's
      video and audio. Intersect, split, trim and retime voiceover takes across removed ranges, retain
      mute settings, and keep muted picture when it accompanies selected narration. Voiceovers are
      already timed on the draft clock: map them from the old draft to the new draft without applying
      source-clip speed a second time. Copy required
      media independently and save video, narration, transcripts and editable state atomically using
      the existing ownership, recovery and history conventions.
- [ ] **Verify before widening support.** Cover muted clips, both track-level mutes, mixed source
      speech/narration, overlapping takes, speed changes and narration crossing a cut boundary.
      Check cancellation, source changes during analysis, rollback, reopening and undo/redo. Verify
      offline preview/export on a phone with preserved audio and an exported duration below 120 seconds.
      Remove each rejection only when its supported cases pass.
- [ ] **Keep empty-beat handling explicit.** Retain zero-length skipping. Add a clear notice when
      beats are skipped and distinguish intentionally empty beats from failed duration reads; offer
      metadata retry/recovery for the latter. Do not invent duration or delete the original beat.
      Extend regressions for mixed empty/playable beats, all-empty input and source changes to skipped beats.
