# Summary first-pass verification

[Issue #331](https://github.com/mieweb/pulse/issues/331). Captured on 2026-11-25 using a dedicated
native iPhone 16e simulator running iOS 26.0, in dark and light appearance at default text size and
AX1 (`accessibility-medium`). All projects, dates and media in these screenshots are synthetic.
Later thumbnail and one-tap creation changes are covered in the [usability verification](../summary-usability/README.md).

## Native provenance

The native app shell was copied from the release simulator build used for #330. It contains the
existing iOS startup repair. The Summary branch's current JavaScript and assets were rebuilt with
`expo export:embed`, the public Expo config was updated, and the shell was signed ad hoc and
installed on the dedicated simulator. These checks exercise native React Native controls and
SQLite, but do not establish a fresh native archive. The baseline Home uses the same Home UI as
base commit `2467627`.

Native actions used WDA accessibility labels, roles, values, selected/disabled traits, calendar
date buttons and ScrollView scrolling. No coordinate actions were used. The Summary radio exposes
`Selected`; source checkboxes expose `checkbox, checked`; unavailable creation actions expose
`NotEnabled`. VoiceOver audio was not tested.

## Checked behavior

- Home's + opens Blank project / Summary. Blank opens an empty recorder and does not eagerly
  create a library row.
- Before the first summary, Since last summary is disabled and the first-summary reminder is
  shown. Today collects four beats from two projects; Yesterday collects one beat from an older
  project. Calendar date buttons work, and a reversed range shows an error and disables creation.
- Selecting two project checkboxes previews four beats. A custom name creates one normal editable
  summary project with four independent media copies. It opens in the recorder with four clips,
  Edit clips and Export available.
- The latest summary's name and cutoff survive reinstall/restart. View last summary opens it;
  closing the recorder returns to the kickoff screen with its name, mode and checked projects
  preserved. With no new beats, the caught-up message appears and Create is disabled.
- Appending one synthetic fresh beat to an older source project and restarting produces a
  one-beat Since last summary preview. Creating the next summary copies only that beat. SQLite
  contains two summary projects with counts `[4, 1]` and increasing cutoff timestamps.
- All five original source beat rows and media SHA256 hashes remain unchanged after both
  summaries. Selecting all source projects totals six source beats, excluding the five copies
  now held in the two summaries.
- In light appearance at AX1, project checkboxes, calendar date selection, the preview, the
  sticky Create action and caught-up state remain reachable by native scrolling. Yesterday
  previews one beat, and Today previews five after the new source beat was added.

The synthetic fresh beat was inserted into the simulator fixture database to exercise the
incremental collection window. It was not recorded with a camera. App-level insertion timestamps,
copy failure handling, migration/backfill and document round-trips are covered by the source tests.

## Screenshot map

| Capture                                               | Evidence                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| [Before Home](before-home-dark.png)                   | Original + action and synthetic source projects               |
| [Kickoff](after-kickoff-dark.png)                     | Blank project / Summary choice                                |
| [First summary](after-first-summary-dark.png)         | Name, first-summary reminder and collection modes             |
| [Date range](after-date-range-dark.png)               | Matching source projects and beat count                       |
| [Project selection](after-project-selection-dark.png) | Two checked sources and four-beat preview                     |
| [Latest summary](after-last-summary-dark.png)         | Persisted name/cutoff and View last summary                   |
| [New beat](after-new-beat-since-last-dark.png)        | One new beat from an existing source project                  |
| [Next summary](after-next-summary-recorder-dark.png)  | One copied beat in the editable recorder                      |
| [Light checklist](after-project-selection-light.png)  | Six source beats, three projects; previous summaries excluded |
| [AX1 checklist](after-projects-ax1-light.png)         | Wrapping source rows and sticky preview/action                |
| [AX1 calendar](after-calendar-ax1-light.png)          | Calendar remains operable at accessibility text size          |
| [AX1 caught up](after-caught-up-ax1-light.png)        | Empty incremental window and disabled Create                  |

Dark input captures precede the final same-millisecond preview boundary adjustment, which does
not change their appearance. The light and AX1 captures use the exact final source bundle.

## Source checks and limits

Run with Node 24.18.0:

- `npm test -- --runInBand`: 152 suites / 2,165 tests passed; one server integration suite / eight
  tests skipped.
- `npm run lint`, `node scripts/gen-protocol-types.mjs --check`, and changed-file Prettier checks
  passed.
- App TypeScript check passed using a temporary config that extends the repository config and
  excludes the stale untracked `pulse-desktop/` folder left by the former submodule. Plain
  `npx tsc --noEmit` reports 14 errors only in that old desktop folder (missing Tauri dependencies
  and their inferred types).
- Exact final source exported successfully as a native iOS JavaScript bundle.

No fresh native archive, Android UI, physical-device session, real camera recording or VoiceOver
speech verification was performed. Only this task's simulator and WDA runner were used; no
physical iPhone or iPad was attached.

Cleanup verified: the owned WDA session was deleted, the owned runner and supervisor exited,
port 8331 closed, and the dedicated simulator shut down. No physical device session was started.

## Subsequent phone handoff

At the user's request on 2026-11-25, the current Summary JavaScript, assets and Expo config
were bundled into the existing signed iPhone shell described above and installed in place on
the user's iPhone. The installed app was launched without a debugger, and its running process
was verified. Existing app data was retained; simulator fixtures were not installed on the phone.
This was an installation handoff, not a physical-device UI or camera test.

No WDA/XCTest, screen sharing or keyboard capture was started. All owned deployment commands
exited, and the global device guard returned `released` before handoff. The local signed build
and source manifest are in `/tmp/pulse-summary-device/`; raw device identifiers and lease data
are excluded from this repository.
