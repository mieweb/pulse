# cordova-host

A cordova-ios 8 app for trying the Pulse Cordova plugin (`embed/packages/cordova-plugin-pulse`). It
shows the same transport test page as `cap-host` (`www/host.js` is an identical copy), reaching the
plugin through `window.PulseKit` after `deviceready`.

Only the sources are committed. `node_modules/`, `platforms/` and `plugins/` are generated (see
`embed/hosts/.gitignore`). The plugin comes from this repo through a relative `file:` dependency, and
`config.xml` adds the Info.plist keys PulseKit needs.

None of the steps below have been run from this folder yet; they follow the spike's runs.

## iOS

PulseKit reaches the app through the plugin's `PulseKit.podspec`. Until the release workflow fills in
its download URL, point `PULSEKIT_LOCAL` at a folder of PulseKit `*.xcframework` files (the output of
`embed/scripts/package-ios.mjs`, or a staged `expo-brownfield` build). The podspec zips that folder
into the system temp folder and uses the zip.

```sh
cd embed/hosts/cordova-host
npm install
export PULSEKIT_LOCAL=/absolute/path/to/xcframeworks
npx cordova platform add ios    # first time only; installs the plugin and runs pod install
npx cordova build ios --emulator
open platforms/ios/App.xcworkspace
```

- After rebuilding PulseKit, run `pod cache clean PulseKit --all` and `npx cordova prepare ios`, so
  CocoaPods takes the new zip instead of its cached copy.

What to look for: the page logs `ready (Cordova)` and an `info` reply. Tap **Set account**, then
**Record**: Pulse opens, and when the flow ends, its reply and a `flowResult` event arrive. Without an
account, **Record** and **Pending** answer `no_account`. The data API buttons work as in
[cap-host](../cap-host/README.md#ios). **Reload page** while a result is
unacknowledged, then **Pending** lists it. A `flowResult` sent while the page was reloading reaches
the page once it subscribes again.
