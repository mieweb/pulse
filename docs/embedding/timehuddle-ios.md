# Wire Pulse into TimeHuddle's iOS project

> **UNTESTED.** These steps come from TimeHuddle's `scripts/patch-ios-spm.py` and
> `scripts/check-native-sync.sh` and from the Capacitor test host's runs. They have not been run in
> TimeHuddle's own iOS project yet. Update this page with the findings from the first TimeHuddle
> dev build against a PulseKit release candidate (milestones M1 and V0.4).

TimeHuddle is a Capacitor app, so [capacitor.md](capacitor.md) applies. This page covers what is
different about TimeHuddle's project: its SwiftPM patch, its native-sync check and its CI.

## What TimeHuddle already has

On TimeHuddle's Pulse branch (draft PR mieweb/timehuddle#881):

- **`Info.plist`** has the camera, microphone, Photos and Photos-add purpose strings, and
  `UIViewControllerBasedStatusBarAppearance` is `YES`.
- **`AppDelegate.swift`** forwards `application(_:handleEventsForBackgroundURLSession:completionHandler:)`
  to PulseKit, looked up by its Objective-C name at run time, so the app builds with or without
  PulseKit. PulseKit doesn't upload in the background yet; the forwarding is in place for when it
  does.
- **`@mieweb/pulse-embed`** comes from a vendored tarball, `vendor/mieweb-pulse-embed.tgz`, through
  a `file:` dependency, the same way as `@mieweb/ui`.

## Add the plugin

1. Pin `@mieweb/capacitor-pulse` the same way as the client: a vendored tarball through `file:`, or
   an exact npm version once it's published. Use the same version as `@mieweb/pulse-embed`.
2. Update the lockfile without installing scripts:

   ```sh
   npm install --package-lock-only --ignore-scripts
   ```

3. Build the web app, sync, and re-apply TimeHuddle's SwiftPM patch:

   ```sh
   npm run build
   npx cap sync
   python3 scripts/patch-ios-spm.py
   ```

   `cap sync` regenerates `ios/App/CapApp-SPM/Package.swift` and drops the transitive packages
   that `patch-ios-spm.py` adds back for CapgoCapacitorUpdater. Run the patch after every sync.

4. Check that the committed native files match the plugins:

   ```sh
   bash scripts/check-native-sync.sh
   ```

   It runs the sync and the patch again and fails if any of these changed:
   `android/capacitor.settings.gradle`, `android/app/capacitor.build.gradle`,
   `ios/App/CapApp-SPM/Package.swift`. Commit the files it prints.

## Open questions for the first build

- **Remote binary targets through a local package.** `@mieweb/capacitor-pulse`'s `Package.swift`
  declares PulseKit's frameworks as remote binary targets, and CapApp-SPM reaches the plugin as a
  local-path package. Xcode's build planner didn't follow remote package dependencies through
  nested local packages for CapgoCapacitorUpdater, which is why `patch-ios-spm.py` exists. Whether
  remote binary targets need the same treatment is not known yet. If they do, the patch gains a
  PulseKit section.
- **CI.** The `ios` job in `checks.yml` runs `cap sync ios`, `patch-ios-spm.py` and a Simulator
  `xcodebuild`. With the plugin added, it needs a published PulseKit release for the binary targets
  to resolve, and it downloads them on every run unless SwiftPM's caches are kept.
- **Android.** The plugin's Android stub adds no permissions and no Maven dependency, but
  `cap sync` still lists it in the two Gradle files above, so they change once.

## Work against a local PulseKit

To try a PulseKit you built before it's released, set `PULSEKIT_LOCAL` and start Xcode with it.
See [dev-loop.md](dev-loop.md#capacitor).
