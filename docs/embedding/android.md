# Add Pulse to an Android Capacitor app

On Android, `@mieweb/capacitor-pulse` runs Pulse from PulseKit's Android library: the same calls,
results, events and error codes as on an iPhone, so your page code doesn't change. This page has
what is different on Android: the library's repository, the settings your app's Android project
needs, and how Pulse behaves when Android stops or restarts your app.

Do [README.md](README.md#add-pulse-step-by-step) and [capacitor.md](capacitor.md) first; they cover
the page code. Cordova apps on Android still get a stub ([cordova.md](cordova.md#android)).

**Before you start:**

- Capacitor 8, with your Android project's `minSdkVersion` at 24 (Android 7.0) or higher.
- **Phones only.** On a tablet, `getInfo()` answers `supported: false` with
  `unsupportedReason: 'device'`. Android counts a screen whose smallest width is 600 dp or more as a
  tablet, so a foldable opened flat also answers `device` while it is open. A phone without a
  camera answers `device` too.
- **Release builds of PulseKit carry ARM code only** (`arm64-v8a` and `armeabi-v7a`), no x86_64.
  Test on a phone. On an x86_64 emulator, a release PulseKit is UNTESTED; a PulseKit you build in
  debug carries x86_64 too ([dev-loop.md](dev-loop.md#a-debug-pulsekit-for-android)).
- Only Android 16 on a Galaxy S24 has run Pulse in a host app. Android 7 to 15 are UNTESTED; see
  the [support matrix](support-matrix.md).

## Add PulseKit's repository

PulseKit's Android library isn't on Maven Central yet. Each PulseKit GitHub Release carries it as
`PulseKit-android-maven.zip`, a Maven repository in a zip.

1. Download `PulseKit-android-maven.zip` and `SHA256SUMS` from the release that matches your npm
   packages' version (the tag is `pulsekit-v<version>`), and check the zip:

   ```sh
   shasum -a 256 -c SHA256SUMS --ignore-missing
   ```

2. Unzip it into your app's Android project, for example into `android/pulsekit-maven/`:

   ```sh
   unzip PulseKit-android-maven.zip -d android/pulsekit-maven
   ```

3. List that folder in `android/build.gradle`, under `allprojects`:

   ```groovy
   allprojects {
       repositories {
           google()
           mavenCentral()
           maven { url = uri("$rootDir/pulsekit-maven") }
       }
   }
   ```

   Your app has to list the repository itself; the plugin can't do it for you, because a library's
   repositories don't apply to your app's own dependencies.

4. Set `minSdkVersion = 24` (or higher) in `android/variables.gradle`.
5. `npx cap sync android`.

The plugin depends on `com.mieweb.pulse:pulsekit` at its own version, so keep the zip's version and
the npm packages' version the same. PulseKit's published metadata lists everything else it needs
(React Native, Hermes, AndroidX, Guava, kotlinx coroutines, atomicfu and kotlinx serialization),
and Gradle fetches those from `google()` and `mavenCentral()`. You don't add any of them yourself.

The zip is about 170 MB, most of it native libraries. Rather than committing the folder, add it to
your `.gitignore` and have your build download and unzip it before Gradle runs. A checkout without
it fails with "Could not find com.mieweb.pulse:pulsekit".

## What PulseKit adds to your app

The library's manifest is merged into your app's when you build:

- **Pulse's screen**, `PulseActivity`: full screen and portrait, in a task of its own. It isn't
  exported.
- **The upload service**, `PulseUploadService`: a foreground service of type `dataSync` that keeps
  Pulse's uploads going after Pulse closes, with your app in the background or the screen locked.
- **Permissions:** `CAMERA`, `RECORD_AUDIO`, `INTERNET`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`,
  `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`, `VIBRATE`, `MODIFY_AUDIO_SETTINGS`, and
  `WRITE_EXTERNAL_STORAGE` up to Android 9 (for Save to Photos there). Pulse asks for the camera and
  the microphone when the recorder first opens.
- **Removed permissions:** Pulse's own dependencies would add photo, video and audio library reads,
  `READ_EXTERNAL_STORAGE`, `ACCESS_MEDIA_LOCATION`, overlays, screen capture, boot receivers and
  Play's install referrer. PulseKit's manifest removes them, and Pulse works without them.

If your app needs one of the removed permissions for its own features, declare it in your app's
manifest, then check Android Studio's Merged Manifest view that it is still there. UNTESTED.

PulseKit sets nothing on your `<application>`: backups, cleartext traffic and your theme stay
yours.

If your merged manifest loses `CAMERA` or `RECORD_AUDIO`, for example to a `tools:node="remove"` in
your app or another library, `open` rejects with `host_misconfigured` instead of opening a recorder
that can't record.

### Google Play's foreground service declaration

Because your app now declares `FOREGROUND_SERVICE_DATA_SYNC`, Play Console asks you to declare the
foreground service under App content › Foreground service permissions. Describe it as what the
person sees: the videos they sent upload in the background, with a "Sending N videos" notification,
until they finish.

On Android 15 and later, Android allows a `dataSync` service 6 hours in any 24. If an upload hits
that limit, Pulse stops it and resumes it from the server's offset the next time it runs.

## Show the upload notification

While Pulse uploads, `PulseUploadService` shows "Sending N videos" with a progress bar in the
notification channel "Pulse uploads". Tapping it opens your app.

Pulse never asks for the notification permission. On Android 13 and later, without
`POST_NOTIFICATIONS`, uploads still run and finish, but the notification shows only in the
Active apps list in quick settings. To show it in the notification shade, declare
`android.permission.POST_NOTIFICATIONS` in your app's manifest and ask for it at a moment that
makes sense in your app, for example the first time the person sends a video.

## Keep Pulse's videos out of Auto Backup

Pulse keeps each signed-in person's drafts, videos and pending results under your app's
`files/PulseKit/<namespace>/`, and its captions models under `files/PulseKit/.shared/`. Android's
Auto Backup includes `files/` unless your app excludes it, and a backup over 25 MB isn't made at
all, so a few videos can stop your app's whole backup. Pulse can't change your app's backup rules,
so exclude the folder yourself, in both rules files:

`android/app/src/main/res/xml/backup_rules.xml` (Android 11 and lower):

```xml
<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
    <exclude domain="file" path="PulseKit" />
</full-backup-content>
```

`android/app/src/main/res/xml/data_extraction_rules.xml` (Android 12 and later):

```xml
<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="file" path="PulseKit" />
    </cloud-backup>
    <device-transfer>
        <exclude domain="file" path="PulseKit" />
    </device-transfer>
</data-extraction-rules>
```

Point your `<application>` at them with `android:fullBackupContent="@xml/backup_rules"` and
`android:dataExtractionRules="@xml/data_extraction_rules"`. If your app already has these files,
add the `<exclude>` lines to them. If your app sets `android:allowBackup="false"`, nothing is backed
up and you can skip this. UNTESTED with Pulse.

Pulse's caches go in `cache/PulseKit/`, which Android never backs up.

## When Android stops or restarts your app

| What happens                                                                                                      | What Pulse does                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The person goes Home while recording                                                                              | The take stops and is kept as a clip. Coming back returns to the recorder.                                                                                                                                                   |
| Android destroys your app's screen while Pulse is open (low memory, or Developer options › Don't keep activities) | Pulse stays open, with its take. When it ends, your page has reloaded: the result reaches the new page as a `flowResult` event and through `pendingResults()`.                                                               |
| Android kills your app while Pulse is open in the background                                                      | On the next launch, the flow ends: `flowResult` with `status: 'canceled'` (`'closed'` for `edit` and `export`) and `reason: 'interrupted'`. Takes recorded before the kill are kept as drafts, so read `listDrafts()` again. |
| Your page calls `listDrafts()` right after such a restart                                                         | The first answer can miss drafts Pulse hadn't listed yet. Read the list again on the next `draftsChanged` event.                                                                                                             |
| Pulse was uploading when your app was killed or force-stopped                                                     | The upload resumes from the server's offset the next time Pulse runs; the bytes already sent aren't sent again. Android doesn't restart it on its own.                                                                       |
| Your app goes to the background during an upload                                                                  | The upload continues in `PulseUploadService`. With the screen locked for a long time, or after the person swipes your app away in Recents, it is meant to continue too; both are UNTESTED.                                   |

Capacitor's `appRestoredResult` (from `@capacitor/app`) isn't a way to get Pulse's result on
Android: Pulse runs in its own task, so Android answers the plugin's Activity result before the
flow ends. Use `flowResult` and `pendingResults()`, as on iOS.

### A link or a notification tap during a take

If a deep link or a notification tap opens your app while Pulse is recording, Android brings your
app's screen to the front. PulseKit puts Pulse back on top at once, but the camera stops while
Pulse's screen is behind yours, so the take ends there. It is kept as a clip, and the person can go
on recording. The flow stays open.

Queue the navigation instead of acting on it: while `isOpen()` is true, keep the link, and handle it
after the flow's result arrives.

## No `headless` on Android

On iPhone, a PulseKit with the `headless` capability runs drafts writes and `resumeOutbox()` with
nothing on screen. Android's PulseKit doesn't list `headless`:

- A drafts write, or `resumeOutbox()`, that has to start Pulse shows a brief "Preparing…" screen over
  your app, as an iOS build without `headless` does ([uploads.md](uploads.md#paused-uploads)).
- With your app in the background, such a call rejects with `runtime.paused`. Retry it from your app
  once it's on screen.
- Uploads Pulse already started carry on in the background either way.

Read `getInfo().capabilities` instead of checking the platform; a later PulseKit may add `headless`
on Android.

## Opt out on Android

To ship your app without Pulse on Android, for example before you set up the repository above, set
`pulsekitAndroid=false` in `android/gradle.properties` (or `ext { pulsekitAndroid = false }` in
`android/build.gradle`) and run `npx cap sync android`. The plugin then builds without PulseKit: no
dependency, no permissions, no repository needed. `getInfo()` answers `supported: false` with
`unsupportedReason: 'device'`, `isAvailable()` is false, and every other call rejects with
`unsupported`, so your page shows its fallback.

## Release builds and R8

PulseKit's library carries its own R8 keep rules, so a release build with `minifyEnabled true`
needs no rules from you. UNTESTED: no minified host build has run yet.

## Use a PulseKit you built

Build PulseKit for Android on your Mac ([dev-loop.md](dev-loop.md#build-pulsekit-for-android)), set
`PULSEKIT_ANDROID_LOCAL` to the Maven repository it wrote, and list the same folder in
`android/build.gradle` as above ([dev-loop.md](dev-loop.md#android-capacitor)).
