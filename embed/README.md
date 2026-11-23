# embed/

PulseKit: Pulse built to run inside another iOS or Android app. This folder is an Expo project of its own
(`app.json`, `package.json`) that bundles the app's `src/` with the root `node_modules`, plus the
native facade, the host packages and the scripts that build and release them.

How the pieces fit is in [docs/architecture.md](../docs/architecture.md); how a host app uses
PulseKit is in [docs/embedding/](../docs/embedding/README.md).

| Folder or file     | What it holds                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`, `src/` | The PulseKit shell: `embed-root.tsx` (the entry), `shell/` (entries, the flow stack, results, messages to the facade, theme, status bar), `flow/` (the pure flow reducer, result builder and request check), `stubs/` (no-op modules for what PulseKit leaves out).                                                                                                    |
| `native/ios/`      | The Swift facade (`PulseKit*.swift`), PulseKit's privacy manifest, and the shared envelope vectors with their Mac runner (`vectors/README.md`).                                                                                                                                                                                                                        |
| `native/android/`  | The Kotlin facade, `PulseActivity`, the upload service, the library manifest and R8 rules, and `jvm-tests/`, which runs the shared vectors on a JVM (`README.md`).                                                                                                                                                                                                     |
| `plugins/`         | `with-pulsekit-facade.js`, the prebuild plugin that adds the facade and its privacy manifest to the PulseKit target; `with-pulsekit-android.js` and `pulsekit-android-gradle.js`, which do the same for the Android library and its fused AAR.                                                                                                                         |
| `packages/`        | What hosts install: `pulse-embed` (client, types, hooks, test fake), `capacitor-pulse`, `cordova-plugin-pulse`. Each has a README.                                                                                                                                                                                                                                     |
| `hosts/`           | `cap-host` and `cordova-host`, one-page test apps for the plugins. Their native folders are generated, not committed.                                                                                                                                                                                                                                                  |
| `scripts/`         | `package-ios.mjs` and `package-android.mjs` (package a build into release assets), `complete-android-metadata.mjs`, `publish-maven-central.mjs`, `write-package-swift.mjs`, `write-podspec.mjs`, `third-party-notices.mjs`, their libraries in `lib/`, the pure checks behind `npm run check:embed` in `bundle-check/`, and the extra privacy manifests in `privacy/`. |
| `deps.json`        | Every native dependency of the root `package.json`, as included in or excluded from PulseKit. `npm run check:embed` keeps it and `package.json` in step.                                                                                                                                                                                                               |
| `package.json`     | The native modules PulseKit links (versions come from the root), and the `prebuild` / `build:ios` / `build:android` scripts.                                                                                                                                                                                                                                           |
| `metro.config.js`  | Bundles `../src` and the pulse-editor submodule, and maps excluded modules to `src/stubs/`.                                                                                                                                                                                                                                                                            |

Generated and git-ignored: `ios/`, `android/` (from `npm run prebuild`) and `artifacts/` (build
output and packaged releases).

## Commands

From the repo root:

```sh
npm run check:embed            # PulseKit's JS bundles and dependency rules; no native build
npm run embed:package:ios      # package embed/artifacts into embed/artifacts/pulsekit-ios
npm run embed:package:android  # check the AAR in embed/artifacts/android-maven, zip it
npx tsc --noEmit -p embed      # typecheck with the embed's path map
gradle --offline -q -p embed/native/android/jvm-tests run --args="$PWD"   # Android core vectors (JDK 17 or 21)
```

Building PulseKit itself is in [docs/embedding/dev-loop.md](../docs/embedding/dev-loop.md):

```sh
# iOS (dev-loop.md#build-pulsekit)
npm run prebuild -- --platform ios && (cd ios && pod install) && npm run build:ios
# Android (dev-loop.md#build-pulsekit-for-android): fused release AAR → artifacts/android-maven
npm run prebuild -- --platform android && npm run build:android
```

Both run from this folder. On Android, complete the AAR's metadata with
`complete-android-metadata.mjs` before packaging; dev-loop.md has the full sequence.
