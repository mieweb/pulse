# cap-host

A Capacitor 8 app for trying the Pulse plugin (`embed/packages/capacitor-pulse`) on a Simulator or a
phone. Its one page (`www/`) sends raw request envelopes through the plugin and prints every reply and
event ([the wire format](../../../docs/embedding/contract.md#on-the-wire)), so it tests the transport
without `@mieweb/pulse-embed`.

Only the sources are committed. `node_modules/`, `ios/` and `android/` are generated (see
`embed/hosts/.gitignore`). The plugin comes from this repo through a relative `file:` dependency.

None of the steps below have been run from this folder yet; they follow the spike's runs.

## iOS

You need a folder of PulseKit `*.xcframework` files: the output of `embed/scripts/package-ios.mjs`, or
any staged copy of an `expo-brownfield` build.

```sh
cd embed/hosts/cap-host
npm install
npx cap add ios                 # first time only
sh scripts/ios-info-plist.sh    # after every `cap add ios`: camera, microphone, Photos, status bar
export PULSEKIT_LOCAL=/absolute/path/to/xcframeworks
npx cap sync ios
open -a Xcode --env PULSEKIT_LOCAL="$PULSEKIT_LOCAL" ios/App/App.xcodeproj
```

- The plugin's `Package.swift` reads `PULSEKIT_LOCAL` when Xcode resolves packages, so Xcode must be
  started with it (quit Xcode first). After pointing it at another folder, use File › Packages ›
  Reset Package Caches.
- Without `PULSEKIT_LOCAL` the package asks for the release zips, which don't resolve until the release
  workflow writes their real URLs.

What to look for: the page logs `ready (Capacitor)` and an `info` reply with `"supported":true` on an
iPhone (iOS 16.4 or later). **Record** opens Pulse; when the flow ends, its reply and a `flowResult`
event arrive. **Reload page** while a result is unacknowledged, then **Pending** lists it.
**Unknown method** answers `method.unsupported`.

## Android (the stub)

```sh
npx cap add android             # first time only
npx cap sync android
npx cap run android
```

What to look for: **Info** answers `"supported":false`, `"platform":"android"` and
`"unsupportedReason":"device"`; every other button answers `ok:false` with code `unsupported`. The app
asks for no permissions.
