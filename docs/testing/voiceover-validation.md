# Voiceover phase one validation

2026-11-25, iOS first, [issue #224](https://github.com/mieweb/pulse/issues/224).
Behavior and build instructions: [voiceover.md](../voiceover.md).

## Review follow-up

The review follow-up fixes interrupted save/Retry serialization and adds a standard **Start** /
**Stop** button alongside the hold shortcut. App source `b39ff55` passes root, embed and client
TypeScript checks, `npm run lint -- --no-cache`, protocol generation and `npm run check:embed`.
`npm test -- --runInBand` passes 162 suites / 2,376 tests; eight integration tests remain skipped
locally. The previous PR head's CI also passed both real PulseVault integration jobs.

Deferred-promise regressions reproduce the original overlapping writes and verify that Retry
waits for an interrupted save, writes again only after failure, and handles another interruption
during Retry without concurrent writes. Workflow disposal waits before discarding a failed
capture, and stale microphone readiness/errors cannot overwrite a newer interruption.

The controls' interaction tests cover standard activation, Stop during native startup, blocked
Start during preparation/save/Undo, and hold ownership across cancellation. The delayed
Pressability release callback is removed so it cannot stop a newer take.

Native follow-up `306ff1d` transfers completed-file ownership to the host before resolving Stop.
Its real-file regression delays copying a delivered take until after cancellation and a new take:
the original file and copied bytes survive, while unclaimed replacement/drop/cancelled-completion
files are reclaimed. This covers reopening Voiceover while a prior session still saves its CAF.
The native PCM checks, simulator SDK typecheck, TypeScript, lint and formatting also pass.
The Pulse Release Simulator build at parent `4dbf8e7`, pinned to `306ff1d`, passed after refreshing
Pods to include the new ownership helper. No JavaScript API or generated binding changed.
Its exact-binary smoke also passed: tapping a saved take opened Start/Stop without adding one;
standard activation saved a 1.48-second take; Undo restored the original four takes, unchanged
video rows and the displayed 0.6-second cursor for the 621.204458 ms target. The controls report
below records matching built/installed executable and Hermes hashes plus verified cleanup.

Native simulator checks of this app source with the previously built `305239a6` native shell
passed: Start/Stop exposes a native button with explicit labels and an 80×45-point frame; Stop
remains enabled while recording, and Start is disabled while saving. Start/Stop saved a 1.59-second
take, the hold shortcut saved a 505 ms take, and each Undo restored the original four takes and
cursor. [Controls report](../../screenshots/validation/voiceover/review-controls-simulator.json)
records source hashes, artifact provenance and verified automation cleanup. Actual screen-reader
and Switch Control use, large-text/RTL layout and physical reach remain unverified.
Screenshots show the [ready controls](../../screenshots/validation/voiceover/review-start-ready.png)
and [Stop during recording](../../screenshots/validation/voiceover/review-stop-recording.png).

## Initial submitted PR checks

Source checks ran on candidate `403304c`, based on `main` at `d4b5312` after the existing
Summary, persistent-history, one-handed-navigation and export-screen changes merged. The native
pin is `305239a6f52f6c379d2d4c52043ce090ad688988` from
[morepriyam/pulse-editor#24](https://github.com/morepriyam/pulse-editor/pull/24).

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Passed on the actual PR source |
| `npm run lint -- --no-cache` | Passed |
| `npx tsc --noEmit -p embed` | Passed |
| `npx tsc --noEmit -p embed/packages/pulse-embed` | Passed |
| `node scripts/gen-protocol-types.mjs --check` | Passed |
| `npm test -- --runInBand` | 161 suites / 2,355 tests passed; eight integration tests skipped |
| `npm run check:embed` | iOS and Android JavaScript bundle/dependency checks passed |
| Simulator UI regression | First microphone permission grant, take entry, scroll/pinch, capture and Undo passed; fresh images/report linked below |
| Pinned native Release Simulator build | Passed from the PR's native project with pin `305239a6`; exact-binary take-entry/capture/Undo smoke passed |
| Native CAF writer checks | 14 continuous CAF cases passed at 44.1/48 kHz, including one minute and five successive takes; four missing/reordered timestamp rejection checks passed |
| Native host AVFoundation mix harness | Passed one minute, five trimmed takes, gaps, track mutes and retimed video boundaries |
| Android native compilation and device behavior | Unverified: Android SDK/build environment unavailable; the Android JavaScript bundle check is a separate result |

All recorded source commands used Node 24.18.0; the native module used its own Yarn lockfile.
The eight skipped integration tests require a separate PulseVault server environment. They are
not counted as passes.

The migration fixture upgrades the prior `0022_persistent_undo` phone library to
`0023_voiceover_takes` using the actual migrator. It preserves exact stored history, current
video rows and retained Redo media, then verifies narration addition, Undo, mutes, reopening and
`.pulse` export. Media held by an active archive remains available after narration Undo.

## Current take-entry regression

The iPhone 17 Pro / iOS 26.0 simulator fixture has three synthetic video clips and four saved
narration takes. A native tap on a painted narration bar reopened Voiceover ready to record,
with the displayed playhead moving from 0.0 to 0.2 seconds. Video and saved-take rows were
unchanged. A timeline pan moved 0.2 to 3.9 seconds, and a 2× pinch widened the bar from 28 to
56 points; neither gesture opened Voiceover or changed stored data.

A subsequent 1,504.5625 ms recording saved independently. Take controls were disabled during
capture, and Undo restored the original takes and moved to the previous take's end at the
readout's 0.1-second resolution. This checked semantic disabled controls; a second simultaneous
touch was not injected. Resetting only the owned simulator's microphone permission reproduced
an initial-prompt lifecycle bug. The fix was retested: accepting Allow automatically readied
the microphone, a 504.791667 ms take saved, and Undo restored the original takes.

The first UI run used the PR JavaScript in a stable Scene-native simulator shell. The final
Release Simulator artifact was then rebuilt from the PR's native project at source `403304c`
and native pin `305239a6`. Its exact-binary smoke passed: tapping a saved take opened the ready
controls without adding a take, a 506.958333 ms recording increased the take count from four to
five, and Undo restored the original four takes and video rows. The displayed cursor returned
to 0.6 seconds for the 621.204458 ms target at 0.1-second readout resolution. Fresh permission
was not reset again on this exact binary; the same JavaScript permission code passed that check
in the earlier fixed-artifact run.

The [report](../../screenshots/validation/voiceover/tap-simulator-report.json) records artifact
provenance and verified simulator-runner cleanup. Fresh images show
[before tapping](../../screenshots/validation/voiceover/timeline-before-tap.png) and
[after tapping](../../screenshots/validation/voiceover/timeline-after-tap.png).

## Historical prototype timing and audio evidence

These measurements belong to the earlier prototype runs, not to a controlled measurement of
the final take-entry change or physical touch/acoustic latency. The
[historical numerical record](../../screenshots/validation/voiceover/prototype-timing-report.json)
preserves their build hashes, timing values and limitations without carrying the old UI images
or microphone media.

The dedicated iPhone 17 Pro simulator ran iOS 26.0 with three synthetic 25-second animated
videos carrying a 330 Hz source tone. A live 60-second microphone hold crossed the 25-second
and 50-second video boundaries without stalling. Its CAF contained 60,010.229167 ms of mono
48 kHz float PCM, and release paused the video at the take's end. This minute run preceded
the final readiness and seek-ownership fixes; the historical report identifies its builds.

| Native clock measurement | Observed |
| --- | ---: |
| Start command → first moving video frame | 16.210 ms |
| Start command → first retained input sample | 0.015875 ms |
| Captured duration minus corresponding paused timeline interval | −0.421754 ms |

These exclude React Native touch delivery and acoustic microphone/speaker latency. Five short
takes saved independently and paused at successive ends, with measured placement gaps of
0.009–0.146 ms. A take begun after seeking to 24.5 seconds crossed the first video boundary and
ended at 25.705740 seconds. Reopening retained takes and both saved mute flags.

Native export produced a 75,000 ms H.264 1080×1920 MP4 with mono 48 kHz AAC. Its cache signature
included saved take positions, source trims and mutes. The source tone remained present within
narration windows and gaps, with measured amplitude 0.12478–0.12564.

The separate host AVFoundation mix harness compares the shipping preview composition's audio
with export. All sampled decoded PCM windows matched (maximum RMS difference 0) for one-minute
narration, five short takes and mute combinations. All five take starts had 0 ms measured error
at 5 ms inspection resolution. A 2× middle clip preserved narration across the changed 20/30-second
boundaries. The 60-second output's picture, audio stream and container were each 60 seconds;
FFmpeg's decoded AAC samples included 9.333 ms of encoder padding.

Repeated simulator Undo testing exposed preview-swap ordering races. Fixes serialize swaps and
explicit seeks, retain the newest requested position through replacement, ignore callbacks from
replaced items, and seek immediately after audio-only Undo. Historical final-prototype checks
passed 13 Undos, including two complete five-take/five-Undo loops. Each removed one whole take
and returned to the preceding retained take's end within the display's 0.1-second precision,
with video rows unchanged. Immediate Undo after release also passed. A 0.1-second touch saved a
122.25 ms take.

## Phone feedback and remaining acceptance

A test build was installed on the user's phone. User feedback identified that tapping an
existing narration take did not reopen Voiceover controls; this PR adds that entry. A phone
handoff and this feedback do not establish controlled tactile latency, acoustic offset, lip sync,
headphone/Bluetooth behavior, phone-call interruption or one-minute hardware drift. Those checks
remain unverified. Cancellation/retry has source coverage; controlled native lifecycle behavior
still needs hardware review.

Fresh before-tap / after-tap images and the simulator report are linked above. Raw microphone
audio is excluded from repository artifacts. The native mix harness and PCM writer checks are
reproducible from the submodule; generated media stays outside the repository.

Phase two's replacement, truncation and transcript assistance, plus narration Redo, remain
outside this implementation. Recording at an earlier position adds an independent overlapping
take rather than replacing existing narration.
