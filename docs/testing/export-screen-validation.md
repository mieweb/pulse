# Export screen (#333)

The export preview reserves the measured height of the actions, metadata, lower playback row and safe areas before
fitting its 9:16 video. The ordinary portrait layout keeps its controls together. Enlarged text,
host warnings and name entry can use a scrolling fallback with a keyboard-aware viewport;
the bottom Back control stays outside that scroll view. Secondary actions wrap and have 44-point tap targets.

The preview opens paused. The visible Play/Pause button has a native accessibility label and
works alongside the native seek controls. Leaving the screen, opening Share or Send, or
backgrounding the app pauses playback; returning waits for Play. Playback completion retains
the existing silent seek back to the start. Regeneration remounts a paused player. Captions and
export/send rules are unchanged.

## Source verification

Checked with Node 24.18.0 on 2026-11-25 in the isolated PR worktree, based on
`main` at `27e617a` (#327). The PR retains that base’s bottom Back footer. No unrelated
Summary/Voiceover changes, dependency upgrades or submodule changes are included.

| Command                                          | Result                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `npm test -- --runInBand`                        | 157 suites / 2,315 tests passed; the opt-in PulseVault integration suite and its 8 tests skipped |
| `npx tsc --noEmit`                               | Passed against the actual PR contents and base; no added exclusions                              |
| `npm run lint`                                   | Passed                                                                                           |
| `node scripts/gen-protocol-types.mjs --check`    | Passed                                                                                           |
| `npx tsc --noEmit -p embed`                      | Passed                                                                                           |
| `npx tsc --noEmit -p embed/packages/pulse-embed` | Passed                                                                                           |
| `npm run check:embed`                            | Passed; iOS/Android bundle and dependency checks                                                 |

All 22 layout/playback regressions passed in the full suite. Changed-file Prettier and
`git diff --check` also passed. Dependencies were reused from the existing installation after
confirming `package.json` and `package-lock.json` exactly match. Both pinned submodules were
checked out at the PR base’s commits in the isolated worktree.

Layout regressions cover residual height, variable action/metadata heights, narrow widths,
rotation and negative available space. Playback regressions exercise the real export and
parked-playback hooks with simulated native events: opening, manual Play/Pause, blur, background,
Share/Send blocking, regeneration, completion/replay and listener cleanup before native release.
These tests do not establish native decoder or screen-reader behavior.

## One-handed phone flow review

This changes a phone flow. Export retains the current main branch’s bottom Back control and
keeps the primary and secondary export actions below the preview. Loading, failure/retry,
host warnings/name entry, share sheets and the keyboard were reviewed in source. The
scrolling fallback preserves access when controls outgrow the available height.

The app-owned preview Play/Pause button sits below the video, alongside the export actions
in ordinary portrait layouts. Its measured row and spacing are reserved before fitting the
video. When name entry or enlarged text needs more room, the screen can scroll; the
keyboard’s Done button dismisses it and restores the full viewport. This does not establish
one-thumb reach in either hand. Native seek controls, keyboard, permission prompts and
sharing sheets are OS-owned.

At the largest system text size on iPhone SE, Play is at y=268–313, above the 333.5-point
midline, while primary and Back remain visible below it. This is an unresolved lower-half
placement exception; it is not accepted as proof of one-handed reach. Follow-up reach review
remains attached to #333. Actual left/right thumb reach, RTL presentation and VoiceOver
focus/announcements remain unverified. The simulator results below establish only their recorded layout and accessible
control labels. The existing [one-handed navigation audit](../one-handed-navigation.md)
remains authoritative for the surrounding flow.

## Final footer layout and phone handoff

The final three export runtime files match implementation commit `2a1804c`. The same Hermes
bundle was checked in the iOS 26.0 simulators and installed/launched as Pulse **2.7.0 (1)**
on the reporter’s phone. Its SHA-256 is
`ae62baffcf7503de859ff377b5d2540232d8429cbde21669e4882fa0e840fce2`.
The test artifact retains the earlier local Summary/Voiceover prototypes; those changes are
outside this PR. Its six test-note paragraphs begin **Export #333 phone test** in
**About → Release notes** and were verified in the packaged config and simulator.

| Final native check                                                                 | Result                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| iPhone SE, 375×667; iPhone 16e, 390×844; iPhone 17 Pro Max, 440×956; ordinary text | All applicable controls visible together; Play centers in the lower half; preview paused               |
| Largest accessibility text, all three sizes                                        | All controls visible; SE Play remains above the midpoint (exception below)                             |
| iPhone 17 Pro Max, dark, ordinary/largest text                                     | Black background verified; controls visible                                                            |
| Standalone iPhone 16e                                                              | Bottom Back, initial pause and manual Play/Pause passed                                                |
| Phone handoff                                                                      | Installed and launched; shared device guard verified released; no automation runner or capture started |

The user reported that the phone test worked and authorized merging with main. This records
general user acceptance; it does not infer unreported RTL, VoiceOver, audio, sharing or
both-hand reach checks. All owned simulator sessions/runners were ended and their dedicated
simulators shut down. No device, app-container or lease identifiers are published here.

Final screenshots: [SE ordinary](../../screenshots/validation/export-screen/footer-iphone-se-upload-light.png),
[16e ordinary](../../screenshots/validation/export-screen/footer-iphone16e-upload-light.png),
[Pro Max dark](../../screenshots/validation/export-screen/footer-iphone17promax-upload-dark.png),
[16e largest text](../../screenshots/validation/export-screen/footer-iphone16e-upload-largest-text.png),
[Pro Max dark/largest text](../../screenshots/validation/export-screen/footer-iphone17promax-upload-dark-largest-text.png),
[SE largest text](../../screenshots/validation/export-screen/footer-iphone-se-upload-largest-text.png),
[standalone](../../screenshots/validation/export-screen/footer-iphone16e-standalone-light.png).
The [report](../../screenshots/validation/export-screen/simulator-report.json) separates final
footer measurements from predecessor evidence and records the handoff and cleanup.

Final smoke did not repeat native Share return, end/replay, background, regeneration,
warning/keyboard, captions/voiceover audio or network delivery. Earlier evidence below and
unit tests remain separate. Both real PulseVault integration variants, JVM vectors, source
checks and embed bundles passed in [implementation CI](https://github.com/mieweb/pulse/actions/runs/45576392867).

## Predecessor native evidence

The screenshots and report below were captured from the predecessor checkout at `2467627`
plus the export fix, before porting it onto `main` at `27e617a`. They show a top Close control.
They establish the recorded predecessor behavior and are **not native verification of the
final PR’s bottom Back layout**. Final footer-layout evidence is recorded above.

Predecessor native before/after checks use isolated iOS simulators and synthetic 12-clip / 0:38 projects.
The pre-change screen in this checkout has a top Close button and no scrolling container,
whereas the issue references a newer layout with a return footer. Autoplay reproduced in the
baseline; Share and Photos alone fit in the baseline's ordinary small-phone portrait layout.

| Native check                                                              | Result                                                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| iPhone SE (3rd generation), 375×667, ordinary portrait with upload picker | All controls visible together; primary action at y=599–651, with 16 points below                                        |
| iPhone 16e, 390×844, light/dark and largest accessibility text            | Preview keeps its ratio; controls fit or remain reachable through scrolling                                             |
| iPhone 17 Pro Max, 440×956, light/dark and largest accessibility text     | Preview and controls visible; dark appearance checked visually                                                          |
| Host name requirement, size warning and keyboard at largest text          | Close and primary visible; typing a name enables Use this video, whose callback closes the flow                         |
| Newly ready, manual Play/Pause, background/foreground                     | Passed with native labels and frame comparisons 1.5 seconds apart; paused frames unchanged and playing frames different |
| Pre-port final app bundle, clip edit and regeneration                     | Merging observed, followed by a newly paused preview; return from the real editor also starts paused                    |
| Merge failure, dark appearance and largest text                           | Error and Try again visible; Close and disabled primary reachable; fixture restored                                     |
| Natural completion, replay and reopening                                  | Passed; completion parks paused, manual replay works, reopening starts paused                                           |

The predecessor normal app bundle exercised native file merging and playback. Pool/host layout checks use a
local fixture harness mounting the real `PulseCore`, `ToastProvider`, `ExportScreen` and
`DestinationSelector`, with synthetic target metadata. The reused simulator shell lacks working
keychain entitlements, so those layout checks bypass token lookup. They do **not** establish
network upload, host confirmation or a real host callback. No shipping code or user data was
changed to create the fixture contexts.

Selected native evidence:

- [Before: iPhone 16e, light, already playing](../../screenshots/validation/export-screen/before-iphone16e-light.png)
- [After: iPhone 16e, light, all upload controls](../../screenshots/validation/export-screen/after-iphone16e-upload-light.png)
- [After: iPhone SE, ordinary portrait](../../screenshots/validation/export-screen/after-iphone-se-upload-light.png)
- [After: iPhone 16e, dark, largest text](../../screenshots/validation/export-screen/after-iphone16e-upload-dark-largest-text.png)
- [After: iPhone 17 Pro Max, dark](../../screenshots/validation/export-screen/after-iphone17promax-upload-dark.png)
- [After: host warning and keyboard, largest text](../../screenshots/validation/export-screen/after-host-keyboard-largest-text.png)
- [After: regenerated preview, paused](../../screenshots/validation/export-screen/after-regenerated-paused.png)
- [After: merge error, dark, largest text](../../screenshots/validation/export-screen/after-error-dark-largest-text.png)

The [native report](../../screenshots/validation/export-screen/simulator-report.json) records
bundle identities, observations, frame comparisons and cleanup. All three owned automation
sessions were deleted, their runners exited and their dedicated simulators shut down.

Native Share opened its activity sheet, but accessibility inspection timed out on the reused
simulator shell. Dismissal/return remains unverified; unit checks cover pausing while the sharing
promise is pending and staying paused afterward.

The user’s general phone acceptance is recorded above. Specific physical-device audio,
sharing-return, RTL, VoiceOver and both-hand reach checks remain unverified. No physical
device was attached for the predecessor evidence in this section.
