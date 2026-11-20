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

The data API: tap **Set account** first (writes and `open` answer `no_account` without one), then
**Record** a draft. **List drafts** reads the catalog without starting Pulse. **Rename first**, **Send
first** and **Delete first** act on the newest draft, and **Resume outbox** runs the launch rule; each
runs in Pulse's JavaScript. With nothing open and a cold runtime, a PulseKit built with
`PULSEKIT_HEADLESS` (`PULSEKIT_HEADLESS=1 npm run prebuild` in `embed/`, then pods and
`npm run build:ios`; `info` then lists the `headless` capability) answers with nothing presented;
any other build shows "Preparing…" briefly and closes it. **Send first** needs **Configure (pulse
mode)** first, on a cold or a warm runtime: in 'file' mode it answers `host_misconfigured`. A Send
that answers `timeout` may still be queued: tap **Send first** again, and it answers with the same
keys. With **Host services: test server** off, a Send's `hostRequest` event shows in the log and the
job pauses after 20 s unanswered; turn it on to upload to the test server (see "The test server" below).

## Android

Not run yet: none of the steps in this section or the two below have been run.

You need PulseKit's local Maven repository: the folder `embed/package.json`'s `build:android`
publishes to (`embed/artifacts/android-maven`), or an unzipped `PulseKit-android-maven.zip`.

```sh
cd embed/hosts/cap-host
npm install
npx cap add android                 # first time only
export PULSEKIT_ANDROID_LOCAL=/absolute/path/to/android-maven
sh scripts/android-setup.sh         # after every `cap add android`
npx cap sync android
npx cap run android
```

`scripts/android-setup.sh` changes the generated `android/` project and prints each change (a second
run prints `unchanged`):

- `allprojects.repositories` in `android/build.gradle` gets `maven { url '<PULSEKIT_ANDROID_LOCAL>' }`.
  The plugin lists that repository too, but the app has to list it as well. Without
  `PULSEKIT_ANDROID_LOCAL` the file is left alone.
- `minSdkVersion = 24` in `android/variables.gradle`.
- `android:usesCleartextTraffic="true"` on the application, so the app can reach the http test server.
  This is for the test host only.
- An intent filter for `caphost://` links on `MainActivity`.

`capacitor.config.json` sets `android.allowMixedContent`, because the page (`https://localhost`) calls
the http test server.

What to look for: the page logs `ready (Capacitor)` and **Info** answers `"platform":"android"`.
With the plugin's stub (before the PulseKit build, or with `pulsekitAndroid=false`), **Info** answers
`"supported":false` with `"unsupportedReason":"device"`, and every other Pulse button answers
`ok:false` with code `unsupported`. A link sent with
`adb shell am start -a android.intent.action.VIEW -d "caphost://nav?to=x"` is logged
(`🔗 deep link caphost://nav?to=x`, then `🧭 navigated at once`).

## The test server

`scripts/pv-test-server.mjs` (at the repo root) runs a PulseVault server with capability tokens and
local storage, so **Send first** uploads end to end. It needs PulseVault's build
(`pulsevault-mieweb/dist`, or `PV_CORE=<path to core.js>`).

```sh
# repo root; tail keeps stdin open, and the server exits when stdin closes
PV_TEST_PORT=8787 tail -f /dev/null | node scripts/pv-test-server.mjs
adb reverse tcp:8787 tcp:8787       # Android: the phone's 127.0.0.1:8787 is the Mac's
```

- The page's **Test server** field defaults to `http://127.0.0.1:8787` and is kept between launches.
  For a LAN address instead of `adb reverse`, start the server with `PV_TEST_HOST=0.0.0.0` and enter
  `http://<Mac IP>:8787`.
- To throttle uploads, put the S5 spike's `proxy.mjs` in front. It listens on :3200 and forwards to
  :3201, at the bytes/s written in the file named by `S5_RATE_FILE`. Start the server with
  `PV_TEST_PORT=3201`, run `adb reverse tcp:3200 tcp:3200`, and enter `http://127.0.0.1:3200`.
- iOS: the Simulator shares the Mac's network, so `127.0.0.1` should work there. A phone needs the
  Mac's LAN address; the S5 spike needed an App Transport Security exception for http and Local
  Network access for that.

## The Android check buttons

The page is the same on iOS, so these buttons are there too.

- **Host services: test server** (on/off, kept between launches): while on, the page answers each
  `hostRequest`. `getUploadTarget` calls `GET /pair` for a new artifact and `GET /token` for a 2 h
  token for it. `refreshUploadToken` calls `GET /token`. `releaseUploadTarget` answers `null`, and
  `confirmSend` (only clock-style types ask it) answers `confirmedAt` = now. If the server fails, the
  answer is `host.unavailable`. Each request and answer is logged with `🛎`, with tokens cut to 6
  characters. Use it with **Configure (pulse mode)** and **Send first**.
- **Check test server**: calls `GET /pair` once and logs the artifact id, or the error. Use it to
  check `adb reverse` or the address.
- **Open/close ×10**: 10 rounds of opening Record, waiting 3 s, closing it, and waiting for the result.
  It logs each round's status and time, then a count per status (`×10 done: {"closed":10}`).
- **Deep link during a take**: opens Record, and 3 s later sends the app a `caphost://` link.
  Expected: the take continues, the page logs the link as queued, and it logs
  `🧭 navigated after the flow result` once Pulse closes. On iOS this needs a `caphost` URL type in
  Info.plist, which `ios-info-plist.sh` doesn't add. Use `adb shell am start -d` for links from
  outside the app.

With `@capacitor/app` installed, the page also logs every `appUrlOpen` link and every
`appRestoredResult` event (`♻️`, logged in full: Capacitor delivers a plugin result there when Android
restored the app after destroying it while Pulse was open). Links that arrive while a flow is open
are queued until its result.
