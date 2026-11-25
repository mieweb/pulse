# Editor toolbar (#337)

[Issue #337](https://github.com/mieweb/pulse/issues/337), based on main
`6e74151dfcfd1c465228b929d9f00090a461c18b` (2026-11-25), including the merged navigation,
persistent history, export, Voiceover and 2.8.0 release changes.

The clip tools occupy a full-width lower row above Close, Undo, Redo and Export. Their order is
**Delete, Split, Speed, Reset, Crop, Mute/Unmute, Flip, Rotate**. Done scrolls with the tools.
The row, glyph area and footer use minimum heights so enlarged labels can grow. The footer is a
plain container; swipes and taps in gaps no longer leave Edit.

Overflow supports swiping or the **More** button. Half-page overlap keeps enlarged choices fully
reachable between pages, including long speed menus. At the end, **First** returns to Done and
the common tools. Clip, speed and caption tools share this behavior. Text-scale caps, destructive
styling, disabled/busy states and operation callbacks are preserved. Tool targets retain at least
52-point widths and 44-point heights; Done retains its 44-point square target.

This changes a phone flow. Commands stay lower, and overflow has a button alternative. Simulator
layout does not establish actual thumb reach in either hand; that remains part of the phone test.
Caption entry and Voiceover retain their dedicated lower controls and safe-area handling.

## Source verification

Checks used Node 24.18.0, npm and the existing root lockfile. No dependency versions changed.

| Command                                                              | Result                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm test -- --runInBand`                                            | 162 suites / 2,376 tests passed; one opt-in suite / eight integration tests skipped        |
| `npm run lint -- --no-cache`                                         | Passed                                                                                     |
| `npx tsc --noEmit`                                                   | Same 14 pre-existing diagnostics under untracked `pulse-desktop/`; unchanged from baseline |
| App-only TypeScript with only `pulse-desktop/` additionally excluded | Passed; external temporary config, tracked config unchanged                                |
| `npx tsc --noEmit -p embed`                                          | Passed                                                                                     |
| `npx tsc --noEmit -p embed/packages/pulse-embed`                     | Passed                                                                                     |
| `npm run check:embed`                                                | iOS/Android bundles and boundaries passed                                                  |
| `node scripts/gen-protocol-types.mjs --check`                        | Passed                                                                                     |
| Changed-source/notes Prettier, ESLint and `git diff --check`         | Passed                                                                                     |

The root TypeScript failure is not counted as a pass. The desktop tree is preserved. The skipped
integration suite needs its server environment. After the paging-overlap repair, source-dependent
checks were repeated; the pure-logic Jest result was reused because it does not render/import
this toolbar. The subsequent 2.8 merge changed version metadata only; version/config/notes checks
passed and historical release entries were preserved. Logs: `/tmp/pulse-337-main-checks/`.

## Clean PR verification and RTL follow-up

A clean PR worktree at `8d51b81` passed standard root TypeScript without additional exclusions,
lint, embed/client typing, iOS/Android embed bundles, protocol and changed-file formatting.
Its full Jest run passed **162 suites / 2,376 tests**, with one suite / eight integration tests
skipped locally. All **nine GitHub CI checks** passed at that head, including two integration
cases. The original shared-checkout desktop diagnostics above remain historical context.

Independent source review then found that Android RTL scrolling uses physical offsets while
iOS Fabric already normalizes them. The helper now normalizes Android RTL incoming offsets and
mirrors outgoing targets, preserving logical More/First paging. This source-only correction was
reviewed against React Native's native implementation. All 24 actual-handler coordinate cases
passed across Android/iOS, RTL/LTR, More/First and boundary dimensions. Root/embed/client typing,
lint, both embed bundles and changed-source formatting passed again after the correction.
Android/RTL native interaction remains unverified; iOS paging behavior is unchanged. The installed combined build **3371 predates this follow-up**;
its recorded source/payload hashes and native results remain associated with that original build.

## Native verification (menu-only build)

Both Release native shells were built with the exact main engine pin
`306ff1d999589be6615275c60567ba371f073efd`, including its ownership helper. Version 2.8 packaging
then refreshed app/extension versions, Expo configuration and notes; native code did not change.
Phone JavaScript/config/assets were copied into the simulator shell and verified byte for byte.
Both signatures passed. No dependency versions or native pointers changed in this fix.

A dedicated fresh iPhone SE (third generation), iOS 26.0, 375×667, used synthetic clips and three
legacy custom speeds. The earlier prototype database was not reused.

| Native check            | Result                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| Normal portrait         | Delete, Split, Speed and Reset fully visible; global commands remain in the lower half                     |
| Swipe navigation        | Three cycles reveal Rotate and return to Done without leaving Edit                                         |
| More/First              | Button path reaches later tools and returns to Done                                                        |
| Eleven speeds           | All eight standard and three custom choices fully reachable with buttons, including at largest system text |
| Speed/Reset             | 0.5× and 3.5× selection, Done and Reset passed                                                             |
| History                 | Speed Undo/Redo and Split Undo/Redo passed; Delete preserves existing no-Undo semantics                    |
| Dark/largest text       | Labels fit vertically; later tools, Done and lower commands remain reachable                               |
| Menu-only phone payload | Version 2.8.0, all six notes, paging, Done and Close verified in the simulator                             |

The largest-text test exposed a speed choice clipped between pages. Half-page overlap repaired
that boundary, and every speed was then verified fully visible through the button path. Operation
checks preceded only that paging refinement; menu-only payload checks repeated layout, all speeds
and completion. The 2.8 refresh changed release/version metadata only.

Evidence: [reporter screenshot](../../screenshots/validation/editor-toolbar/reporter-before.jpg),
[normal layout](../../screenshots/validation/editor-toolbar/after-light.png),
[scrolled tools](../../screenshots/validation/editor-toolbar/after-scrolled.png),
[largest dark text](../../screenshots/validation/editor-toolbar/after-dark-largest-text.png),
[largest scrolled tools](../../screenshots/validation/editor-toolbar/after-dark-largest-scrolled.png),
[speed menu](../../screenshots/validation/editor-toolbar/after-speed-picker.png),
[release notes](../../screenshots/validation/editor-toolbar/release-notes.png) and
[native report](../../screenshots/validation/editor-toolbar/simulator-report.json).

Native RTL, Android, spoken VoiceOver navigation and caption selection/keyboard remain unverified.
All owned simulator sessions ended, runners exited and the dedicated simulator was shut down.

## Phone handoff

The earlier handoff attribution was incorrect: a later Bulk Transcript installation replaced the
initial toolbar-only build, and the subsequent unlocked launch started that Bulk build. The launch
claim recorded in `005879b` therefore did not establish that the toolbar payload was running.

The corrected handoff is **Pulse 2.8.0 (3371)**, with native and Expo build numbers both **3371**.
It uses the [separate combined test integration](https://github.com/mieweb/pulse/commit/d3a853e46005237a8cfb6c828caa82b8fa75f9e3)
on committed [PR #339](https://github.com/mieweb/pulse/pull/339) head `34f8191`; the menu review
branch remains independent. All recorded installed-Bulk source hashes matched that committed base.
The combined source preserves everything except the two toolbar files and adds explicit test notes.
Its root typing, lint, protocol, embed typing/bundles and **167 suites / 2,434 tests** passed;
one integration suite / eight tests were skipped. The exact combined payload passed simulator
checks for the four priority tools, More/First, all eleven speeds, Transcript entry/controls,
Done/Cancel/Close and all six release notes.

The final phone installation, launch and running application were matched to the same new install
receipt. Every pre-existing project/segment column and persistent-history payload was unchanged;
the schema remained at migration 23. Pulse was left running for user testing. The device guard
returned `released`; no debugger, WDA/XCTest or screen sharing was started. Private installation
identifiers, process identities and library data are excluded from this record.

Start at **Home → open a project → Edit**. In **About → Release notes**, verify the first note is
**Toolbar #337 + Bulk Transcript #339 test**. Try both hands, More/First, swiping and enlarged text;
use spare footage for Delete, which has no Undo. The [combined About view](../../screenshots/validation/editor-toolbar/combined-about.png)
and [combined toolbar](../../screenshots/validation/editor-toolbar/combined-toolbar.png) are
simulator captures, not photographs or captures of the user's library. Actual thumb reach and
spoken VoiceOver behavior remain user checks.
