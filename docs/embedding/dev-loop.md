# Work on Pulse and a host app together

When you change Pulse and want to see the change inside a host app before it's released, build
PulseKit on your Mac and point the host at it: with `PULSEKIT_LOCAL` on iOS, and with
`PULSEKIT_ANDROID_LOCAL` on Android ([below](#build-pulsekit-for-android)).

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
on by default (the release ships it on). To build without it, for example to see the "Preparing…" path:

```sh
cd embed
PULSEKIT_HEADLESS=0 npm run prebuild -- --platform ios
(cd ios && pod install)
npm run build:ios
```

`PULSEKIT_HEADLESS=0` lasts for that one prebuild; the next prebuild without it turns `headless`
on again. `getInfo().capabilities` lists `headless` exactly when the build has it. Android builds
never have it ([android.md](android.md#no-headless-on-android)).

### Build PulseKit for Android

You need JDK 17 or 21 and the Android SDK, and room for the build: about 10 GB free.

```sh
cd embed
npm run prebuild -- --platform android    # regenerates embed/android
npm run build:android                     # fused release AAR → embed/artifacts/android-maven
(cd android && ./gradlew :pulsekit:dependencies --configuration releaseRuntimeClasspath \
  --console=plain > /tmp/pulsekit-deps.txt)
cd ..
node embed/scripts/complete-android-metadata.mjs --maven embed/artifacts/android-maven \
  --resolved /tmp/pulsekit-deps.txt
npm run embed:package:android             # checks the AAR, zips it → embed/artifacts/pulsekit-android
```

- If `npm run build:android` says `expo-brownfield: command not found`, run
  `node ../node_modules/expo-brownfield/bin/cli.js build:android --release --fused` from `embed/`
  instead. Don't use `npx expo-brownfield`: it fetches another version.
- `embed/artifacts/android-maven` is the Maven repository a host points at. It holds
  `com.mieweb.pulse:pulsekit` at `embed/app.json`'s version.
- `complete-android-metadata.mjs` adds the runtime libraries the fused build leaves out of the
  POM and Gradle module (Guava, kotlinx coroutines, atomicfu, kotlinx serialization). Without it,
  `embed:package:android` refuses the build.
- `embed:package:android` refuses an AAR with other ABIs than `arm64-v8a` and `armeabi-v7a`, native
  libraries not aligned for 16 KB pages, a `minSdkVersion` above 24, a permission outside its list,
  a dependency it can't resolve, missing R8 rules or missing facade classes. `--dry-run` runs every
  check and writes nothing; `--help` lists the options.
- Run `gradle --stop` (or `./gradlew --stop` in `embed/android`) when you're done: idle Gradle
  daemons hold several GB of memory.

These are the steps the release workflow's Android job runs.

#### A debug PulseKit for Android

`npm run build:android:debug` (from `embed/`) builds a debug AAR that also carries x86_64, for
emulators. It is published as `com.mieweb.pulse:pulsekit-fused-debug`, which
`@mieweb/capacitor-pulse` doesn't pick up on its own, and `embed:package:android` refuses a debug
build. UNTESTED with a host.

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

### Android (Capacitor)

```sh
export PULSEKIT_ANDROID_LOCAL=/absolute/path/to/pulse/embed/artifacts/android-maven
npx cap sync android
npx cap run android
```

- `@mieweb/capacitor-pulse` reads `PULSEKIT_ANDROID_LOCAL` when Gradle configures it. With the
  plugin at `0.0.0-dev` (from the repo or a local tarball), it takes the one PulseKit version that
  repository holds; set the Gradle property `pulsekitAndroidVersion` to pick another.
- Your app's `android/build.gradle` has to list the same folder:
  `maven { url = uri('/absolute/path/to/pulse/embed/artifacts/android-maven') }` in
  `allprojects.repositories`. The reference host's `scripts/android-setup.sh` adds it for you.
- Gradle reads the variable from its own environment: start Android Studio from the same shell, or
  run `./gradlew --stop` after changing it, so a running daemon doesn't keep the old value.
- After you rebuild PulseKit at the same version, Gradle may keep its cached copy: build with
  `--refresh-dependencies`, or delete `~/.gradle/caches/modules-2/files-2.1/com.mieweb.pulse`.

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
  the call's `callId`: with the prefix `[PulseKit]` in Xcode's console or Console.app on iOS, and
  under the logcat tag `PulseKit` on Android (`adb logcat -s PulseKit Pulse`; `Pulse` is the
  Capacitor plugin's tag). A `callId` from a `PulseError` finds the matching lines.
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

When you change the Android facade's rules (`embed/native/android/src/main/java/com/mieweb/pulse/kit/core`),
run the same vectors, and the upload service's rules, on a JVM with JDK 17 or 21 (no Android
build; [embed/native/android/README.md](../../embed/native/android/README.md#running-the-vectors)):

```sh
gradle --offline -q -p embed/native/android/jvm-tests run --args="$PWD"
gradle --offline -q -p embed/native/android/jvm-tests run \
  -PmainClass=com.mieweb.pulse.kit.vectors.UploadRulesMain --args="$PWD"
gradle --stop
```

When you change upload code, also run the PulseVault integration suite
([README](../../README.md#testing)): `PULSE_INTEGRATION=1 npx jest pv-integration --forceExit`.
