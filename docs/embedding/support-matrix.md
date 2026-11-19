# Support matrix

**TESTED** means the row was run and passed, as the Evidence column says. **UNTESTED** means it
was built and reviewed but not run there; treat it as unknown. Update a row when you run it, with
the build and the date.

## Hosts and platforms

| Host or platform                                        | Status   | Evidence                                                                                                                                                                          |
| ------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capacitor 8, iPhone (`@mieweb/capacitor-pulse`)         | UNTESTED | This version's facade and plugin have not run on a device or Simulator. An earlier prototype facade and plugin passed record → Export → result on the iOS Simulator (2026-11-17). |
| Cordova, cordova-ios 8, iPhone (`cordova-plugin-pulse`) | UNTESTED | As above: the prototype passed on the iOS Simulator (2026-11-17); this version hasn't run.                                                                                        |
| Meteor's Cordova build                                  | UNTESTED | The client's Meteor file URLs (`WebAppLocalServer`) are covered by Jest only.                                                                                                     |
| TimeHuddle iOS                                          | UNTESTED | See [timehuddle-ios.md](timehuddle-ios.md).                                                                                                                                       |
| iPad, Mac (Designed for iPad), iOS before 16.4          | UNTESTED | Reported as `supported: false` by the facade's code; not run on such a device.                                                                                                    |
| Android (Capacitor and Cordova stubs)                   | UNTESTED | The stubs answer `supported: false` and `unsupported`, by code reading; not run on a device.                                                                                      |
| A desktop browser (no plugin)                           | TESTED   | Jest: the client picks its null adapter, `isAvailable()` is false and calls reject `unavailable`.                                                                                 |

## Pieces

| Piece                                                                 | Status              | Evidence                                                                                                                                                             |
| --------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mieweb/pulse-embed` client, adapters, React hooks                   | TESTED              | Jest, in Node, on every PR.                                                                                                                                          |
| `@mieweb/pulse-embed/testing` (`createFakePulse`, `runPulseContract`) | TESTED              | Jest runs the contract suite against the fake on every PR. Not yet run under Vitest.                                                                                 |
| The facade's envelope, busy and inbox rules                           | TESTED              | Shared vectors: the Swift rules compiled into a Mac command-line binary, and the client's Jest tests, run the same cases. Not run on a device.                       |
| PulseKit's JS bundles (iOS and Android)                               | TESTED              | `npm run check:embed` on every PR: no excluded package or Pulse-app-only code in either bundle.                                                                      |
| Router-free flow stack (react-native-screens without a navigator)     | UNTESTED            | A spike of the same approach passed on a Galaxy S24 Ultra and the iOS Simulator (2026-11-19). The shell built on it has not run on a device.                         |
| Recorder, editor and Export screens, shared with the Pulse app        | TESTED              | In the Pulse app with this branch's JavaScript, on an iPhone 17 Pro Max and a Galaxy S24 Ultra (2026-11-19): record, edit, Export, Share, Save to Photos, Add clips. |
| Upload from Export (`uploadMode: 'pulse'`)                            | Not in this version | —                                                                                                                                                                    |
| Packaging (`npm run embed:package:ios`)                               | TESTED              | Run on a Mac against a local PulseKit build; `shasum -c SHA256SUMS` passed and the privacy manifests were in every slice.                                            |
| Generated `Package.swift` and `PulseKit.podspec`                      | TESTED              | `swift package dump-package` in release and `PULSEKIT_LOCAL` modes, `ruby -c` on the podspec. Not yet resolved from a real release.                                  |
| Release workflow (`pulsekit-v*` tags)                                 | UNTESTED            | No run has finished green yet. See [releasing.md](releasing.md).                                                                                                     |
| Installing the packages from npm                                      | UNTESTED            | Waits for the first published release candidate.                                                                                                                     |
| Symbolication with the release's dSYMs and source map                 | UNTESTED            | See [releasing.md](releasing.md#symbolicate-a-crash).                                                                                                                |
| Debug PulseKit with Metro                                             | UNTESTED            | See [dev-loop.md](dev-loop.md#a-debug-pulsekit).                                                                                                                     |
