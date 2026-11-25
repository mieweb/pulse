# Summary usability verification

Captured on 2026-11-25 in a dedicated native iPhone 16e simulator running iOS 26.0.
All projects, cover images and media are synthetic. Native actions used accessibility labels,
roles, values and ScrollView scrolling, with no coordinate actions.

The existing release simulator shell (including the prior iOS startup repair) was reused.
Current Summary JavaScript and assets were rebuilt with `expo export:embed`; public Expo config
was generated with `PULSE_TEST_NOTES_FILE=docs/testing/summary-test-notes.json`, copied into
`EXConstants.bundle/app.config`, and the app was signed ad hoc. This verifies current native UI
and bundled test notes, rather than a newly compiled native archive.

## Results

- **Blank project** is a native button. One activation opens the empty recorder immediately;
  there is no initial submit footer and no draft is eagerly created. The same direct action
  works after opening the Summary form and at AX1 text size.
- Project checkboxes display the same first timeline clip covers as Home. Solid synthetic red
  and green cover pixels match Home exactly. Checked values, labels and beat counts still work.
- A source project's first clip is dated yesterday with a red cover; its newer clip is dated
  today with a blue cover. **Today** and **Since last summary** include the newer clip but show
  the familiar red project cover, matching Home. A missing-media source shows the video fallback
  and remains a usable, named checkbox.
- Light appearance and AX1 (`accessibility-medium`) retain visible thumbnails, wrapping names,
  native checkbox state and the sticky preview/Create action.
- **About → Release notes** displays all six exact notes from the local test-notes file, including
  the one-tap Blank action, thumbnail comparison and concrete Summary tests. They also wrap and
  scroll at AX1. The final embedded config was checked against the source notes before install.

The initial notes-check harness expected `Release notes`; the actual native heading is
`RELEASE NOTES`. The harness was corrected and the note content checks passed.

## Captures

| Capture                                              | Evidence                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| [Before kickoff](before-kickoff-dark.png)            | Original extra Blank submit action                              |
| [Before project list](before-projects-dark.png)      | Original text-only project list                                 |
| [Home](after-home-dark.png)                          | Source cover reference, including missing-cover fallback        |
| [Kickoff](after-kickoff-dark.png)                    | Direct buttons without a submit footer                          |
| [Checked projects](after-projects-selected-dark.png) | Covers with accessible checkboxes                               |
| [Date range](after-date-range-dark.png)              | Project cover retained when its first beat is outside the range |
| [Since last](after-since-last-dark.png)              | Familiar cover in incremental collection                        |
| [Blank recorder](after-blank-recorder-dark.png)      | Recorder reached by one activation                              |
| [Test notes](after-release-notes-top-dark.png)       | Current local-build testing instructions in About               |
| [AX1 projects](after-projects-ax1-light.png)         | Large text, thumbnails and sticky Create                        |
| [AX1 notes](after-release-notes-ax1-light.png)       | Large testing notes in About                                    |

## Source checks and limits

Root verification with Node 24.18.0: `npm test -- --runInBand` passed 152 suites / 2,169 tests;
one server integration suite / eight tests remains skipped. Lint, generated protocol freshness,
and changed-file Prettier checks passed. App TypeScript passed with the same temporary config
excluding the stale untracked `pulse-desktop/` former submodule; plain repository TypeScript
reports existing missing Tauri dependency/type errors there.

No physical device, real camera recording, Android UI or VoiceOver audio was tested in this
session. Phone installation and global lease release are owned and recorded separately by the
parent deployment task.

Cleanup verified: the owned WDA session was deleted, its supervisor and xcodebuild runner
exited, port 8341 closed, and the dedicated simulator shut down. The last test note was also
confirmed fully readable through native scrolling at AX1 ([capture](after-release-notes-bottom-ax1-light.png)).

## Phone handoff

The same tested JavaScript and assets, with the six exact local test notes in Expo config,
were signed into the existing iPhone shell and installed in place on the user's phone on
2026-11-25. Installation, launch without a debugger, and the running Pulse process were
verified. Existing app data was retained; no simulator fixtures were copied to the phone.

All owned deployment commands exited and the global device guard returned `released` before
handoff. No WDA/XCTest, screen sharing or keyboard capture was started. The signed artifact and
source manifest are stored locally under `/tmp/pulse-summary-usability-device/`. Physical UI
and real-camera testing remain for the user; test instructions are in **About → Release notes**.

## Merge preparation

The Summary change was isolated from concurrent Voiceover work and rebased onto main
`2aad841`. The feature runtime files were matched to the tested phone-build source manifest
before the rebase; the new base adds the already-used native startup repair and iOS build gates.
Independent scope and correctness reviews found no blocking issues.

Checks on the isolated rebased branch, with Node 24.18.0, passed:

- `npx tsc --noEmit` using the standard repository config, with no desktop-folder exclusion.
- `npm run lint`.
- `npm test -- --runInBand`: 152 suites / 2,169 tests passed; the opt-in server integration suite
  (eight tests) remains skipped locally and is covered separately by PR CI.
- `node scripts/gen-protocol-types.mjs --check`.
- `npm run check:embed`: both iOS and Android JS bundles and all dependency/boundary checks.
- Changed-file Prettier and Git whitespace checks.

The clean checkout contains no legacy untracked desktop folder. The earlier desktop-related
TypeScript limitation was local to the original shared checkout. Native UI/phone evidence and
remaining platform limits are as recorded above; no additional physical session was needed.
