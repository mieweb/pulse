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
iPhone (iOS 16.4 or later). Tap **Set account**, then **Record**: Pulse opens, and when the flow ends,
its reply and a `flowResult` event arrive. Without an account, **Record** and **Pending** answer
`no_account`. **Reload page** while a result is unacknowledged, then **Pending** lists it.
**Unknown method** answers `method.unsupported`.

The data API: tap **Set account** first (writes and `open` answer `no_account` without one), then
**Record** a draft. **List drafts** reads the catalog without starting Pulse. **Rename first**, **Send
first** and **Delete first** act on the newest draft, and **Resume outbox** runs the launch rule; each
runs in Pulse's JavaScript. With nothing open and a cold runtime, a PulseKit with the
`headless` capability (the default; `info` lists it) answers with nothing presented; a build made
with `PULSEKIT_HEADLESS=0 npm run prebuild` shows "Preparing…" briefly and closes it. **Send first** needs **Configure (pulse
mode)** first, on a cold or a warm runtime: in 'file' mode it answers `host_misconfigured`. A Send
that answers `timeout` may still be queued: tap **Send first** again, and it answers with the same
keys. This page has no host services, so a Send's `hostRequest` event shows in the log and the job
pauses after 20 s unanswered.

## The contract suite

`src/contract/` is a second page that runs the host contract (`runPulseContract`) against the real
plugin: build it with `node src/contract/build.mjs` before `npx cap sync ios`, then tap **Contract
suite** on the host page. [src/contract/README.md](src/contract/README.md) has the details.

## Android (the stub)

```sh
npx cap add android             # first time only
npx cap sync android
npx cap run android
```

What to look for: **Info** answers `"supported":false`, `"platform":"android"` and
`"unsupportedReason":"device"`; every other button answers `ok:false` with code `unsupported`. The app
asks for no permissions.
