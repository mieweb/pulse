# Voiceover prototype (iOS)

[Issue #224](https://github.com/mieweb/pulse/issues/224), phase one, adds narration to the
whole draft rather than individual video clips. Android capture and phase two's replacement
and transcript assistance are deferred.

## Using it

Open a draft in the editor, tap **+ → Voiceover**, and scrub the timeline to choose a position.
To return to saved narration, tap a take in the narration lane: the Voiceover controls reopen
and the playhead moves to the tapped position. Screen-reader activation opens at the take's start.
After the microphone is ready, hold **Hold to record** to narrate while the picture plays.
Release to pause the picture and save one take. The playhead stays at that take's end. Repeat
for several short takes, or hold for a continuous narration spanning clip boundaries.
Alternatively, tap **Start**, then **Stop** to save the take. This standard
button activation is also available to screen readers and Switch Control, without a sustained
touch. Both controls use the same recording and save workflow.

**Undo take** removes the most recently added entire take, leaving the video unchanged. Repeated
Undo removes earlier takes in reverse recording order. The playhead returns to the end of the
previous retained take, or to the first removed take's start when none remain. Undo accepts a
tap while the released take is saving and applies after that commit. There is no narration Redo
in this prototype. Narration Undo is in the lower Voiceover panel; the usual editor toolbar
returns when that panel closes. Tapping a take does not change which take Undo removes.

The narration lane uses the same ruler, scroll and pinch scale as the video. Seeking backward
and recording adds another independent take; overlapping takes play together. It does not
truncate or replace earlier narration. Use Undo for an immediate retake.

**Video audio** and **Narration** independently mute those tracks in preview and export.
Unmuted video audio continues under narration and in gaps. Recording temporarily silences
preview monitoring without changing either saved mute setting. Tap **✓** to leave the workflow,
then export normally. Takes and mute settings survive reopening the draft.

## Storage and rendering

Migration `0023` adds draft track mutes and `voiceover_takes`. Each take stores its own relative
CAF path, draft timeline start, source duration and source trim interval, plus its recording
sequence. Video edits do not move narration: placement remains on the draft clock. Trims and
shorter video timelines clip playback/export at the draft end without deleting narration media.

The file is copied into `drafts/<draftId>/voiceovers/` before its row commits. A failed commit
keeps the original capture available for Retry, and leaves earlier takes unchanged. Undo deletes
one row transactionally before removing its file. Full-draft duplication, `.pulse` transfer,
backup and recovery include narration and mute settings. Copying selected video clips, including
the Summary workflow, does not copy this separate draft-level narration.

`core/media/voiceover.ts` maps saved takes into the same native options for editor preview,
Export and Send. The export cache signature includes take placement, source trims and both track
mutes. AVFoundation inserts narration after video speed retiming, mixes independent audio tracks,
and encodes one continuous audio stream while preserving the existing video merge paths.
Android refuses audible narration preview/export instead of silently dropping it.

## Capture and synchronization

The native microphone is prepared before enabling the hold control and stays warm between takes.
The native player and timestamped input samples share the host clock. A press starts playback
and selects input samples; release pauses playback and closes the sample interval. The saved
start comes from the first included input sample, and the end is bounded by both the paused
player and available samples. File I/O runs off the main thread. A new take waits for the saved
mix's composition swap and playhead seek before becoming recordable again.

Backgrounding, audio interruptions, lost routes, playback stalls and unexpected seeks cancel
unfinished recording and preserve earlier takes. Capture rejects incomplete input and timestamp
gaps rather than saving a take with a missing tail or compressed timing. Retry re-prepares the
microphone. A failed durable save can retry the original capture after any in-flight save
finishes; repeated interruptions and Retry cannot save the same capture concurrently. Leaving
the workflow discards that unsaved capture.

Each saved take logs `[voiceover] capture timing` with timeline bounds and these native metrics:

| Field | Meaning |
| --- | --- |
| `pressToPlaybackMs` | Native start anchor to the first observed moving video frame; `-1` if none |
| `pressToCaptureMs` | Native start anchor to the first included input sample's host timestamp |
| `stopAlignmentMs` | Captured sample duration minus the paused timeline interval |
| `audioVideoOffsetMs` | Input sample-clock offset from the scheduled video clock |

These measure native command and sample timing. They do not measure touch delivery through
React Native, acoustic input latency, or lip sync. Those measurements and a real one-minute
microphone drift review remain prototype acceptance work; host sample/mix tests cannot establish
them. A phone test build was installed for user testing; user feedback identified the missing
way to reopen controls by tapping a saved take. Controlled physical timing measurements have
not been recorded.

## Reproducing checks

Use Node 24. The standard source checks and embed checks are in [AGENTS.md](../AGENTS.md).
Focused regressions include `src/db/voiceovers.test.ts`, the persistence/migration suites,
`src/features/editor/voiceover-session.test.ts`, and the export/signature/mapping suites.

The pinned `modules/pulse-editor` submodule has native implementation and generated Nitro binding
changes. They must travel with the parent change. From that submodule, use its own Yarn lockfile:

```sh
yarn install --immutable
yarn nitrogen
yarn typecheck
sh scripts/check-voiceover-samples.sh
tests/voiceover-mix/run.sh /tmp/pulse-voiceover-mix
```

The sample test exercises the shipping CAF writer with timestamped synthetic PCM at 44.1 and
48 kHz, a full minute, five successive takes and a seek/retake. The mix harness compares preview
composition audio against the exported MP4 for a one-minute take, five trimmed takes crossing
video boundaries, gaps, track mutes and a sped-up video clip. See its
[README](https://github.com/morepriyam/pulse-editor/blob/305239a6f52f6c379d2d4c52043ce090ad688988/tests/voiceover-mix/README.md) for the evidence limits.

Rebuild the native app after these changes; a JS refresh cannot add microphone methods:

```sh
npx expo prebuild --platform ios --no-install
cd ios && pod install
```

Then build the `Pulse` scheme in Xcode for an iOS simulator or follow the shared iOS testing skill
for a physical test. Physical handoffs also require app-visible notes for that exact build.
