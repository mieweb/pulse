# Add Pulse to a Cordova app

You add `@mieweb/pulse-embed` (the client your page calls) and `cordova-plugin-pulse` (the native
plugin). The plugin brings PulseKit in through CocoaPods: its `PulseKit.podspec` downloads one zip
of PulseKit's frameworks from the PulseKit GitHub Release.

**Before you start:** cordova-ios 8, an iOS deployment target of 16.4 or later, and the
[host checklist](README.md#host-checklist). None of the steps on this page have been run from a
published package yet; see the [support matrix](support-matrix.md).

## Install

```sh
npm install --save-exact @mieweb/pulse-embed@rc
npx cordova plugin add cordova-plugin-pulse@rc
npx cordova prepare ios
```

- Use `@latest` instead of `@rc` once a final release exists, and keep both packages at the same
  exact version.
- `cordova prepare ios` runs `pod install`, which downloads `PulseKit-xcframeworks.zip` (about
  70 MB in a test packaging run) and checks it against the SHA-256 the release lists.
- Cordova copies a plugin into both `plugins/` and `platforms/`. With PulseKit's frameworks that
  can be over 1 GB per copy; keep both, because `cordova prepare` copies from `plugins/` again.

## Set up your app

1. Set the deployment target and the `Info.plist` keys in `config.xml`:

   ```xml
   <preference name="deployment-target" value="16.4" />
   <platform name="ios">
     <config-file target="*-Info.plist" parent="NSCameraUsageDescription">
       <string>TimeHuddle records videos for your tickets and clock sessions.</string>
     </config-file>
     <config-file target="*-Info.plist" parent="NSMicrophoneUsageDescription">
       <string>TimeHuddle records sound with your videos.</string>
     </config-file>
     <config-file target="*-Info.plist" parent="NSPhotoLibraryUsageDescription">
       <string>TimeHuddle imports videos from Photos.</string>
     </config-file>
     <config-file target="*-Info.plist" parent="NSPhotoLibraryAddUsageDescription">
       <string>TimeHuddle saves videos to Photos.</string>
     </config-file>
     <edit-config file="*-Info.plist" mode="overwrite" target="UIViewControllerBasedStatusBarAppearance">
       <true />
     </edit-config>
   </platform>
   ```

2. Call the client from your page. The plugin sets `window.PulseKit`, and the client waits for
   `deviceready` before it answers `isAvailable()` (up to 10 s), so you can call it as your page
   starts. In a Meteor app, call it from `Meteor.startup`.

```ts
import { getPulse } from '@mieweb/pulse-embed';

const pulse = getPulse();
await pulse.configure({ uploadMode: 'file', hostName: 'TimeHuddle' });
```

The rest is the same for every host: [Record your first video](README.md#record-your-first-video).

## Files your page can load

A result's `export.webUrl` is already converted for the WebView: through Meteor's
`WebAppLocalServer.localFileSystemUrl` when it's there, otherwise `WkWebView.convertFilePath`. Load
it in a `<video>` or `fetch()` it; don't write to it. It stays valid until you `acknowledge()` the
result.

## Results while the page reloads

The plugin holds `flowResult` events while no page is subscribed and hands them over once the
reloaded page subscribes again. Draining `pendingResults()` on every page load covers the rest.

## Android

The Android side of `cordova-plugin-pulse` is a stub. It adds no permissions and no dependencies,
`getInfo()` answers `supported: false` with `unsupportedReason: 'device'`, and every other call
rejects with `unsupported`.

## Try it in the test host

`embed/hosts/cordova-host` in the Pulse repo is a one-page cordova-ios 8 app with the same
transport test page as the Capacitor host. Its [README](../../embed/hosts/cordova-host/README.md)
has the steps.

## Use a PulseKit you built

Set `PULSEKIT_LOCAL` to a folder of PulseKit `*.xcframework` files before `cordova prepare`. See
[dev-loop.md](dev-loop.md#cordova).
