# Work on Pulse and a host app together

When you change Pulse and want to see the change inside a host app before it's released, build
PulseKit on your Mac and point the host at it with `PULSEKIT_LOCAL`.

**You need** a Mac with Xcode, the Pulse repo with its submodules (`git submodule update --init`)
and `npm install` done at the repo root, and at least 15 GB of free disk: the build folder alone
grows past 12 GB.

## Build PulseKit

From the Pulse repo:

```sh
cd embed
npm run prebuild -- --platform ios     # expo prebuild --clean: regenerates embed/ios
(cd ios && pod install)
npm run build:ios                      # expo-brownfield, Release → embed/artifacts
cd ..
npm run embed:package:ios              # → embed/artifacts/pulsekit-ios
```

- `embed:package:ios` keeps the device and Simulator slices, adds the frameworks the brownfield
  build leaves out, strips the binaries, stamps `PulseKit.framework`'s `Info.plist` with the
  version and git SHA, and writes the privacy manifests. `node embed/scripts/package-ios.mjs --help`
  lists its options; `--dry-run` prints every step and writes nothing.
- The frameworks your host links are in `embed/artifacts/pulsekit-ios/xcframeworks/`.
- `embed/ios`, `embed/android` and `embed/artifacts` are generated and git-ignored.

These are the same commands the release workflow runs, without signing.

### With the `headless` capability

A build with `headless` runs host writes and uploads with nothing on screen; without it, they show
a brief "Preparing…" screen ([uploads.md](uploads.md#paused-uploads)). It is a build-time switch,
off by default. Turn it on at prebuild:

```sh
cd embed
PULSEKIT_HEADLESS=1 npm run prebuild -- --platform ios
(cd ios && pod install)
npm run build:ios
```

A prebuild without the variable turns it off again. `getInfo().capabilities` lists `headless`
exactly when the build has it.

## Point a host at it

### Capacitor

```sh
export PULSEKIT_LOCAL=/absolute/path/to/pulse/embed/artifacts/pulsekit-ios/xcframeworks
npx cap sync ios
open -a Xcode --env PULSEKIT_LOCAL="$PULSEKIT_LOCAL" ios/App/App.xcodeproj
```

- `@mieweb/capacitor-pulse`'s `Package.swift` reads `PULSEKIT_LOCAL` when Xcode resolves packages,
  so Xcode has to be started with it. Quit Xcode first.
- After you rebuild PulseKit into the same folder, or point the variable somewhere else, use
  File › Packages › Reset Package Caches.
- Without the variable, the package downloads the release named in its `Package.swift`.

### Cordova

```sh
export PULSEKIT_LOCAL=/absolute/path/to/pulse/embed/artifacts/pulsekit-ios/xcframeworks
npx cordova prepare ios
```

- `PulseKit.podspec` zips the folder into the system temp folder and installs that zip. A `.zip`
  of the frameworks works as the value too.
- After you rebuild PulseKit, run `pod cache clean PulseKit --all` and `npx cordova prepare ios`
  again, so CocoaPods doesn't reuse its cached copy.

## A Debug PulseKit

`npx expo-brownfield build:ios --debug` (from `embed/`) builds a Debug variant instead of Release.

> **UNTESTED** with PulseKit. Like any React Native debug build, it is expected to load its
> JavaScript from a Metro server you start in `embed/` (`npx expo start`), so JS changes show up
> without a native rebuild.

A Debug PulseKit behaves differently from a release in one way that matters: a fatal JavaScript
error shows React Native's red error screen instead of ending the flow `failed` with
`runtime.error`. Test error handling with a Release build.

## Logs

- **Native lines.** The facade logs each open, its result, refused calls and commands to Pulse with
  the prefix `[PulseKit]` and the call's `callId`. Read them in Xcode's console or Console.app. A `callId` from a `PulseError`
  finds the matching lines.
- **Pulse's own log.** `logFile()` returns a `FileRef` to the signed-in account's `logs/pulse.log`,
  where Pulse keeps its recent console output, including the upload loop's lines when Pulse runs
  with nothing on screen. Tokens, credentials and anything shaped like a capability token are
  redacted as each line is recorded. `fetch(ref.webUrl)` reads it from your page. With
  `configure({ policy: { logs: 'off' } })`, `logFile()` rejects with `not_found`.
- **`on('log')`** is in the contract but this version doesn't send `log` events. Use `logFile()`.

## Check your change before you push

From the Pulse repo root:

```sh
npx tsc --noEmit && npx tsc --noEmit -p embed
npm run lint
npm test -- --runInBand
npm run check:embed        # PulseKit's JS bundles, about 1.5 minutes, no native build
```

When you change the facade's envelope rules, also run the shared vectors on the Mac
([embed/native/ios/vectors/README.md](../../embed/native/ios/vectors/README.md)):

```sh
xcrun swiftc -o "$TMPDIR/pk-envelope-vectors" \
  embed/native/ios/PulseKitEnvelope.swift embed/native/ios/tests/EnvelopeVectorsMain.swift
"$TMPDIR/pk-envelope-vectors" embed/native/ios/vectors/envelope.json
```

When you change how drafts are listed or counted, run the catalog vectors the same way:

```sh
xcrun swiftc -o "$TMPDIR/pk-catalog-vectors" \
  embed/native/ios/PulseKitCatalog.swift embed/native/ios/tests/CatalogVectorsMain.swift
"$TMPDIR/pk-catalog-vectors" src/features/drafts/__vectors__/catalog.json
```

When you change upload code, also run the PulseVault integration suite
([README](../../README.md#testing)): `PULSE_INTEGRATION=1 npx jest pv-integration --forceExit`.
