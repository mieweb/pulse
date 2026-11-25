# Voiceover phase one validation

2026-11-25, iOS first, [issue #224](https://github.com/mieweb/pulse/issues/224).
Behavior and build instructions: [voiceover.md](../voiceover.md).

## Current PR checks

The PR starts from `main` after the Summary, persistent-history and one-handed-navigation
changes merged. It adds phase-one narration and tapping a saved take to reopen its controls.

| Check | Result |
| --- | --- |
| Final PR root/embed/client typechecks, lint and protocol generation | Pending final run after the take-entry change and native pin |
| Final PR complete Jest suite and both embed bundle checks | Pending final run after the take-entry change and native pin |
| Final PR native simulator take-entry regression | Pending fresh before-tap / after-tap evidence |
| Previously integrated source, `9cb7ac8`, before the take-entry change | Root/embed/client typechecks, lint, protocol generation and both embed bundle checks passed; 159 Jest suites / 2,327 tests passed; one integration suite / eight tests skipped |
| Native CAF writer checks | 14 continuous CAF cases passed at 44.1/48 kHz, including one minute and five successive takes; four missing/reordered timestamp rejection checks also passed |
| Native host AVFoundation mix harness | Passed one minute, five trimmed takes, gaps, track mutes and retimed video boundaries |
| Previous iOS Release native builds | Simulator and signed phone shells built with the microphone implementation and generated Nitro bindings; the final sample-continuity guard still needs its final native build/check record |
| Android native compilation and device behavior | Unverified: Android SDK/build environment unavailable; the Android JavaScript bundle check is a separate result |

All recorded source commands used Node 24.18.0; the native module used its own Yarn lockfile.
The eight skipped integration tests require a separate PulseVault server environment. They are
not counted as passes.

The migration fixture upgrades the prior `0022_persistent_undo` phone library to
`0023_voiceover_takes` using the actual migrator. It preserves exact stored history, current
video rows and retained Redo media, then verifies narration addition, Undo, mutes, reopening and
`.pulse` export. Media held by an active archive remains available after narration Undo.

## Historical prototype timing and audio evidence

These measurements belong to the earlier prototype runs, not to a controlled measurement of
the final take-entry change or physical touch/acoustic latency. Their UI predates the current
PR's final before/after images.

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

Final before-tap / after-tap images and the simulator report are pending under
[`screenshots/validation/voiceover/`](../../screenshots/validation/voiceover/). They will show the
current editor layout. Raw microphone audio is excluded from repository artifacts. The native mix harness and PCM writer checks are reproducible from the submodule;
generated media stays outside the repository.

Phase two's replacement, truncation and transcript assistance, plus narration Redo, remain
outside this implementation. Recording at an earlier position adds an independent overlapping
take rather than replacing existing narration.
