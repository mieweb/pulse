# PulseKit for Android

The Android side of PulseKit, the facade a host app talks to through one JSON transport
(native-bridge §8). It speaks the same contract as the Swift facade in `embed/native/ios`: the same
envelopes, methods, error codes, events and internal messages.

## Layout

- **`src/main/java/com/mieweb/pulse/kit/core/`** holds the facade's pure rules in plain Kotlin:
  only `kotlin.*` and `java.*`, with no `android.*`, no `org.json`, no React and no expo. The files
  are `PulseJson` (the one JSON type), `PulseEnvelope` (contract, requests, replies, events,
  errors), `PulseRouter`, `PulseBusy` (the one-flow gate), `PulseInboxRules`, `PulseValidation`
  (`open` and `configure` checks, the 8 KB context rule), `PulseNamespace` (origins, namespaces,
  `setAccount`'s arguments, `account.json`) and `PulseCatalogReader`. Each file names the Swift
  file it mirrors. The shared vectors check them on a JVM (below).
- **`jvm-tests/`** is a standalone JVM-only Gradle build (Kotlin JVM plugin and `application`; no
  Android Gradle Plugin, no expo, no JUnit). It compiles `core/` with the runners in
  `jvm-tests/src/main/kotlin`.
- **Everything else under `src/main/java/com/mieweb/pulse/kit/`** is Android code: the facade,
  `PulseActivity`, the upload service and their seams. It uses Android and React Native APIs, so
  it first compiles in the integrator's Android build, and device runs check it.

The facade does the IO (listing `results/`, reading `catalog.json`, writing `account.json`) and
hands what it read to `core/`, so every rule a vector can pin lives in `core/`.

## Running the vectors

From the repository root, with JDK 17 or newer:

```sh
gradle --offline -q -p embed/native/android/jvm-tests run --args="$PWD"
rm -rf embed/native/android/jvm-tests/build embed/native/android/jvm-tests/.gradle embed/native/android/jvm-tests/.kotlin
```

`--offline` uses the Gradle cache (Kotlin JVM plugin 2.1.20 and kotlin-stdlib); drop it on a machine
that hasn't fetched them yet. The runner, `com.mieweb.pulse.kit.vectors.VectorsMain`, takes the
repository root and checks three files the way their other runners check them, so the counts line
up:

| File                                           | Other runners                                                       | Checks |
| ---------------------------------------------- | ------------------------------------------------------------------- | ------ |
| `embed/native/ios/vectors/envelope.json`       | `tests/EnvelopeVectorsMain.swift`, jest (`envelope-vectors.test.ts`) | 65     |
| `src/features/drafts/__vectors__/catalog.json` | `tests/CatalogVectorsMain.swift`, jest (`catalog-filter.test.ts`)    | 58     |
| `embed/native/ios/namespace-vectors.json`      | jest (`namespace-vectors.test.ts`)                                  | 31     |

Then 33 `kotlin:` checks for what only this core has: forwarded routing with the full method list,
the JSON parser and writer, the 8 KB context rule, `setAccount`'s arguments and `account.json`. It
prints one line per check (`ok` or `FAIL <section>: <name>: <detail>`), the counts per file and
section, and exits 1 when any check fails.

`-PmainClass=<fully qualified name>` runs another runner in `jvm-tests/src/main/kotlin` without
editing the build file.

## Frozen names

PR4's packages code against these names. They don't change without the owner.

| Name                                                                                                                                                                                                                                                        | Where                                     | Who uses it                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `com.mieweb.pulse.kit.PulseKit`: `@JvmStatic shared(context: Context)`, `@JvmStatic prepareBackgroundUploads(context: Context)`, `call(activity: Activity?, json: String, reply: PulseReply)`, `call(activity: Activity?, json: String, launcher: PulseOpenLauncher?, reply: PulseReply)`, `setEventListener(listener: PulseEventListener?)`, `internal val flows: FlowPort` | PulseKit.kt (PR4-C)                       | PR4-D, PR4-G, PR4-J, hosts                                                                      |
| `fun interface PulseReply { onReply(json) }`, `PulseEventListener { onEvent(json) }`, `PulseOpenLauncher { launch(activity, intent) }`                                                                                                                      | PulseKitApi.kt (PR4-B)                    | PR4-C, PR4-G                                                                                    |
| `FlowLaunch(requestId, mode, requestJson, props: Bundle)`, `UiState(statusBar, statusBarHidden, hasTake)`, `PresenterPort { launch, dismiss, applyUi, state, currentActivity }`, `FlowPort { onShown, onViewGone, onRecreatedWithoutFlow, onFatal }`         | PulseKitSeams.kt (PR4-B)                  | PR4-C implements FlowPort; PR4-D implements PresenterPort as `internal object PulseKitPresenter` |
| `core.PresenterState { NONE, IDLE, PRESENTING, DETACHED }`, `core.PulseRouter.route`, `core.PulseContract`                                                                                                                                                  | core/ (PR4-A)                             | PR4-C, PR4-D                                                                                    |
| `PulseActivity.EXTRA_REQUEST_ID` `"com.mieweb.pulse.kit.requestId"`, `EXTRA_MODE` (`"flow"` / `"preparing"`), `EXTRA_REQUEST`, `EXTRA_PROPS`, `RESULT_EXTRA_JSON` `"json"`                                                                                    | PulseActivity.kt (PR4-D)                  | PR4-C, PR4-G                                                                                    |
| `internal object PulseKitUploads { fun start(context: Context) }`                                                                                                                                                                                           | PulseKitUploads.kt (PR4-E)                | PR4-C                                                                                           |
| Manifest: `com.mieweb.pulse.kit.PulseActivity`, `com.mieweb.pulse.kit.PulseUploadService` (`foregroundServiceType="dataSync"`, `stopWithTask="false"`)                                                                                                       | library AndroidManifest.xml (PR4-B)       | PR4-D, PR4-E                                                                                    |
| BuildConfig (package `com.mieweb.pulse.kit`): `PULSEKIT_VERSION`, `PULSEKIT_BUILD`, `PULSEKIT_GIT_SHA`, `PULSEKIT_CONTRACT_MINOR`, `PULSEKIT_FORMAT_VERSION`, `PULSEKIT_DB_SCHEMA`                                                                           | with-pulsekit-android.js (PR4-B)          | PR4-C                                                                                           |
| `ReactNativeHostManager.release(reason)` (added to the generated file)                                                                                                                                                                                      | with-pulsekit-android.js (PR4-B)          | PR4-C                                                                                           |
| Resources: `@style/Theme.PulseKit`, `pulsekit_preparing`, `pulsekit_upload_channel_name`, `pulsekit_upload_channel_description`, plurals `pulsekit_upload_title`, `pulsekit_upload_paused`, `@drawable/pulsekit_ic_upload`; notification channel id `pulsekit.uploads` | res/ (PR4-B)                              | PR4-D, PR4-E                                                                                    |
| Maven coordinates `com.mieweb.pulse:pulsekit:<npm version>` (S1-a)                                                                                                                                                                                          | embed/app.json (PR4-B)                    | PR4-G, PR4-H, PR4-J, PR5                                                                        |
| Gradle switch `pulsekitAndroid` (`false` = the stub); env `PULSEKIT_ANDROID_LOCAL` (a local Maven repository)                                                                                                                                               | capacitor-pulse/android/build.gradle (PR4-G) | hosts, PR4-F                                                                                    |

### What `core/` exposes

- `PulseContract`: `MAJOR` 1, `MINOR` 1 (what `info()` reports), `ENVELOPE_VERSION` 1,
  `VECTORS_MINOR` 0 (the minor envelope.json was written for), `nativeMethods`, `minor1Methods`,
  `readMethods`, `forwardedMethods`, `methods` (PulseKit.swift's list, in its order),
  `vectorMethods` and `entries`.
- `PulseRouter.route(text, supported, methods, forwarded)` gives `PulseRoute.Native(request)`,
  `PulseRoute.Forward(request)` or `PulseRoute.Reply(reply)`. `supported` defaults to true,
  `methods` to `PulseContract.vectorMethods` and `forwarded` to `PulseContract.forwardedMethods`.
  The facade passes `methods = PulseContract.methods`.
- `PulseBusy.decideOpen(openRequestId, requestId, presenter, pendingInInbox)` gives an
  `OpenDecision`: `START`, `JOIN`, `BUSY`, `NO_PRESENTER` or `DELIVERED`. On Android,
  `PresenterState` means the following:
  - `NONE`: no Activity was passed.
  - `IDLE`: the Activity is resumed and not finishing.
  - `PRESENTING`: the host Activity is paused under another Activity of the host.
  - `DETACHED`: the Activity is finishing or destroyed.
- `PulseReply.success` / `failure` / `parse` / `serialized`, `PulseEvent.serialized` and
  `PulseError(code, message, recoverable, callId, extra)`. A reply that fails before a callId is
  known carries `callId: ""`.

### Where the core differs from the Swift files

These differences are internal; a host sees the same answers.

- `PulseJson` objects keep insertion order. `serialized` sorts keys, as Swift's `.sortedKeys` does,
  so the text is the same. A lone UTF-16 surrogate, which a Swift String can't hold, is written as
  `\uXXXX`.
- `PulseValidation.checkContextSize` is Pulse JS's 8 KB rule (`src/db/host-context.ts`) in Kotlin.
  `open`'s checks don't call it, because the Swift facade leaves that rule to Pulse JS.
- `PulseAccountArgs.parse` is the argument half of Swift's `PulseKitAccounts.set`. The facade
  checks `busy` before it and handles the folders and `restart_required` after it.
