# Add Pulse to a Capacitor app

You add two npm packages: `@mieweb/pulse-embed` (the client your page calls) and
`@mieweb/capacitor-pulse` (the native plugin). The plugin pulls PulseKit's frameworks from the
PulseKit GitHub Release through Swift Package Manager.

**Before you start:** Capacitor 8, an iOS deployment target of 16.4 or later, and the
[host checklist](README.md#host-checklist). None of the steps on this page have been run from a
published package yet; see the [support matrix](support-matrix.md).

## Install

```sh
npm install --save-exact @mieweb/pulse-embed@rc @mieweb/capacitor-pulse@rc
npx cap sync ios
```

- Use `@latest` instead of `@rc` once a final release exists. Release candidates are published
  under the npm `rc` tag; `npm view @mieweb/pulse-embed dist-tags` lists both.
- Keep both packages at the same exact version. They are released together, and each version of
  `@mieweb/capacitor-pulse` names the PulseKit release its frameworks come from.
- `npx cap sync ios` adds the plugin to `ios/App/CapApp-SPM/Package.swift`. Xcode then downloads
  PulseKit's frameworks from the GitHub Release (about 70 MB of zips in a test packaging run) and
  checks each one against the SHA-256 the release lists.
- The plugin's `Package.swift` declares iOS 15, because Capacitor's own package does. Pulse itself
  needs iOS 16.4 and reports `supported: false` below it.

## Set up your app

1. Add the `Info.plist` keys from the [host checklist](README.md#host-checklist). In a Capacitor
   project they go in `ios/App/App/Info.plist`.
2. Call the client from your page. The client finds the plugin when
   `Capacitor.isNativePlatform()` and `Capacitor.isPluginAvailable('Pulse')` are both true, so the
   same page code runs in a desktop browser (where `isAvailable()` is false).

```ts
import { getPulse } from '@mieweb/pulse-embed';

const pulse = getPulse();
await pulse.configure({ uploadMode: 'file', hostName: 'TimeHuddle' });
```

The rest is the same for every host: [Record your first video](README.md#record-your-first-video).

## Files your page can load

A result's `export.webUrl` is already converted with `Capacitor.convertFileSrc`, with `?v=` added
so a re-export at the same path isn't served from the WebView's cache. Load it in a `<video>` or
`fetch()` it; don't write to it. It stays valid until you `acknowledge()` the result.

## Android

The Android side of `@mieweb/capacitor-pulse` is a stub. It adds no permissions and no
dependencies, `getInfo()` answers `supported: false` with `unsupportedReason: 'device'`, and every
other call rejects with `unsupported`. Show your Android fallback when `isAvailable()` is false.

## Try it in the test host

`embed/hosts/cap-host` in the Pulse repo is a one-page Capacitor 8 app that sends raw requests
through the plugin and prints every reply and event. Its
[README](../../embed/hosts/cap-host/README.md) has the steps; use it to tell a plugin problem from
a problem in your page.

## Use a PulseKit you built

Set `PULSEKIT_LOCAL` to a folder of PulseKit `*.xcframework` files and start Xcode with it. See
[dev-loop.md](dev-loop.md#capacitor).
