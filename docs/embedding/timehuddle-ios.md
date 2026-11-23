# Wire Pulse into TimeHuddle's iOS project

TimeHuddle is a Capacitor app, so [capacitor.md](capacitor.md) applies. This page covers what is
different about TimeHuddle's project: its SwiftPM patch, its native-sync check, its `AppDelegate`
and what its first device build showed.

**Status:** a TimeHuddle iOS Debug build with `pulsekit-v0.1.0-rc.4` built on the first try,
installed on an iPhone 17 Pro Max, and signed in to a local TimeHuddle server (2026-11-20). Pulse
did not open: rc.4 lacks PulseKit's native class, so `isAvailable()` was false and "Clock in with
Pulse" fell back to the Pulse app link. A PulseKit built with the fix (mieweb/pulse#307, also on
this branch) has not been tried in TimeHuddle yet.

## What TimeHuddle already has

On TimeHuddle's Pulse branch (draft PR mieweb/timehuddle#881):

- **`Info.plist`** has the camera, microphone, Photos and Photos-add purpose strings, and
  `UIViewControllerBasedStatusBarAppearance` is `YES`. It also has `NSAllowsLocalNetworking` and
  `NSLocalNetworkUsageDescription`, which a dev build against a server on the local network needs.
- **`AppDelegate.swift`** forwards `application(_:handleEventsForBackgroundURLSession:completionHandler:)`
  to PulseKit, looked up by its Objective-C name at run time, so the app builds with or without
  PulseKit. PulseKit runs each upload in its own background session
  (`com.mieweb.pulsekit.upload.<namespace>`), and this forwarding is how iOS hands those sessions'
  events back after it relaunched the app. PulseKit answers `true` for its own sessions and calls
  the completion handler once their events are delivered; the app handles any other session.
- **Not there yet (recommended):** a call to `PulseKit.prepareBackgroundUploads` (the class
  method, by selector like `shared`) from `application(_:didFinishLaunchingWithOptions:)`. It
  reattaches uploads iOS kept running even in a launch where Pulse never opens. The first
  `PulseKit.shared` access does the same, so the hook is a safeguard, not a requirement.
- **`@mieweb/pulse-embed` and `@mieweb/capacitor-pulse`** come from vendored tarballs in `vendor/`,
  through `file:` dependencies, the same way as `@mieweb/ui`.
- **The page** calls `configure()`, then `setAccount()` for the signed-in person, before its first
  `record()`. Without the account, `record()` rejects with `no_account`.

## Add or update the plugin

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
   PulseKit needs no section in it: Xcode resolved all 18 of the plugin's remote binary targets
   through the local CapApp-SPM package, checked their checksums and embedded them in the app.

4. Check that the committed native files match the plugins:

   ```sh
   bash scripts/check-native-sync.sh
   ```

   It runs the sync and the patch again and fails if any of these changed:
   `android/capacitor.settings.gradle`, `android/app/capacitor.build.gradle`,
   `ios/App/CapApp-SPM/Package.swift`. Commit the files it prints.

## A dev build against a local server

TimeHuddle's `scripts/local-ios.sh` builds the web app against a server on your network. For a
Pulse upload to reach it, the phone must also reach the PulseVault `endpoint` that
`pulseUploads.begin` returns, so that server's `ROOT_URL` has to be an address the phone can use.

To check the result on the phone: sign in, open a ticket or the Clock page, and tap the Pulse
button. Pulse should open on the recorder with the place's banner. If the app opens the Pulse app
or its store page instead, `isAvailable()` is false: see
[troubleshooting.md](troubleshooting.md#pulse-doesnt-open).

## Open questions

- **CI.** The `ios` job in `checks.yml` runs `cap sync ios`, `patch-ios-spm.py` and a Simulator
  `xcodebuild`. With the plugin added, it downloads PulseKit's frameworks (about 70 MB) on every
  run unless SwiftPM's caches are kept.
- **Android.** The plugin's Android stub adds no permissions and no Maven dependency, but
  `cap sync` still lists it in the two Gradle files above, so they change once.

## Work against a local PulseKit

To try a PulseKit you built before it's released, set `PULSEKIT_LOCAL` and start Xcode with it.
See [dev-loop.md](dev-loop.md#capacitor).
