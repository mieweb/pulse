# Embedding Pulse in a host app

PulseKit is Pulse packaged for another iOS app. Your web page asks for a task (record a video for a
place, edit a draft, export a draft), Pulse opens full screen over your app, and you get one result
back when the person is done. The result carries the finished MP4, which your app uploads its own
way.

This page is the integration path for a Capacitor or a Cordova app, from install to a first
result. Follow it top to bottom; it links to [capacitor.md](capacitor.md) and
[cordova.md](cordova.md) for what is specific to each host.

| Page                                     | Read it when you want to                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| This page                                | Add Pulse to your app and record your first video.                              |
| [capacitor.md](capacitor.md)             | See what is specific to a Capacitor 8 app.                                      |
| [cordova.md](cordova.md)                 | See what is specific to a Cordova (cordova-ios 8) app, including Meteor's.      |
| [timehuddle-ios.md](timehuddle-ios.md)   | Wire Pulse into TimeHuddle's iOS project (SwiftPM patch and native-sync check). |
| [contract.md](contract.md)               | Look up a method, a result, an error code or the versioning rules.              |
| [dev-loop.md](dev-loop.md)               | Build PulseKit yourself, run your app against it, and read its logs.            |
| [releasing.md](releasing.md)             | Cut a PulseKit release or release candidate, or symbolicate a crash.            |
| [troubleshooting.md](troubleshooting.md) | Find out what an error code means and what to do about it.                      |
| [support-matrix.md](support-matrix.md)   | See which platforms and hosts have been tried, and which haven't.               |

The Pulse repo has two reference hosts: [`embed/hosts/cap-host`](../../embed/hosts/cap-host/) and
[`embed/hosts/cordova-host`](../../embed/hosts/cordova-host/). Each is a one-page app with the
plugin installed and the `Info.plist` keys set. Their page sends raw requests to the plugin instead
of using `@mieweb/pulse-embed`, so copy their project setup, not their page code.

## What you get, and what you don't

- **Three entries.** `record` (the recorder for a place you name), `edit` (the editor on a draft)
  and `export` (Export on a draft). The person can move between recorder, editor and Export inside
  one flow. There is no Pulse home screen and no drafts list inside your app.
- **One flow at a time, one result per flow**: completed (with the video), closed (the take was
  kept as a draft), canceled (nothing was kept) or failed (with an error code).
- **Results survive a reload.** Pulse writes each result to disk before it tells your page. If
  your page reloads while Pulse is open, or your app is killed before your page handled a result,
  the result waits in `pendingResults()` until you `acknowledge()` it. A flow cut short by the app
  being killed has no result.
- **iPhone only.** iOS 16.4 or later. iPad, Mac (Designed for iPad) and Android report
  `supported: false`. Both plugins have an Android side, but it is a stub: `isAvailable()` is false
  there and every other call rejects with `unsupported`.
- **Not in this version:** Pulse uploading the video for you (`uploadMode: 'pulse'`), the drafts
  API (`listDrafts` and the other [minor-1 methods](contract.md#minor-1-not-in-this-version)), and
  accounts. A call to one of those methods rejects with `method.unsupported`.

## Versions

PulseKit is published as release candidates, which are prereleases: GitHub tags
`pulsekit-v<x.y.z>-rc.<n>`, and the npm dist-tag `rc`. Install with `@rc`. A final release goes to
the npm `latest` tag ([releasing.md](releasing.md#tags-and-versions)).

The three npm packages are released together with the same version. Install them at the same
exact version (`--save-exact`). `npm view @mieweb/pulse-embed dist-tags` lists what is published.

## Before you start

| You need              | Capacitor app                                       | Cordova app                                      |
| --------------------- | --------------------------------------------------- | ------------------------------------------------ |
| Framework             | Capacitor 8, iOS project on Swift Package Manager   | cordova-ios 8 or later                           |
| iOS deployment target | 16.4 or later                                       | 16.4 or later                                    |
| Node                  | 22 or later (Capacitor 8's CLI)                     | 20.17 or later (cordova 13 and cordova-ios 8)    |
| Mac tools             | Xcode 26                                            | Xcode 26 and CocoaPods                           |
| To see Pulse run      | An iPhone or iPhone Simulator, iOS 16.4 or later    | An iPhone or iPhone Simulator, iOS 16.4 or later |
| npm packages          | `@mieweb/pulse-embed` and `@mieweb/capacitor-pulse` | `@mieweb/pulse-embed` and `cordova-plugin-pulse` |

- Releases are built with Xcode 26. An older Xcode is UNTESTED.
- The plugins themselves declare iOS 15, because Capacitor does, and Pulse checks for 16.4 when
  your page calls it. The Cordova reference host sets 16.4; a lower deployment target is UNTESTED.
- A Capacitor iOS project on CocoaPods (an `ios/App/Podfile` and no `ios/App/CapApp-SPM` folder)
  can't use the plugin: `@mieweb/capacitor-pulse` ships a `Package.swift` and no podspec.
- Your app needs somewhere to send the finished MP4 (your own upload endpoint), and a fallback for
  where Pulse isn't available: a desktop browser, Android, an iPad.

## Add Pulse, step by step

> **UNTESTED from npm.** These steps have not been run from a published release candidate yet.
> The [support matrix](support-matrix.md) says which pieces have run, and where.

### 1. Install the packages

Capacitor, from your app's root:

```sh
npm install --save-exact @mieweb/pulse-embed@rc @mieweb/capacitor-pulse@rc
npx cap sync ios
```

Cordova, from your app's root:

```sh
npm install --save-exact @mieweb/pulse-embed@rc
npx cordova plugin add cordova-plugin-pulse@rc
```

The plugin brings in PulseKit's frameworks from the PulseKit GitHub Release: through Swift Package
Manager for Capacitor (one zip per framework), through CocoaPods for Cordova (one zip of them all),
about 70 MB either way. Each download is checked against the SHA-256 the release lists. To build
against a PulseKit you built yourself, see
[Use a local build instead of npm](#use-a-local-build-instead-of-npm).

### 2. Add the `Info.plist` keys

| Key                                                | Without it                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `NSCameraUsageDescription`                         | `open` rejects with `host_misconfigured`.                          |
| `NSMicrophoneUsageDescription`                     | `open` rejects with `host_misconfigured`.                          |
| `NSPhotoLibraryAddUsageDescription`                | Export hides Save to Photos.                                       |
| `NSPhotoLibraryUsageDescription`                   | PulseKit doesn't check it; the recorder's import from Photos does. |
| `UIViewControllerBasedStatusBarAppearance` = `YES` | Pulse can't set the status bar while it's open.                    |

- **Capacitor:** add them to `ios/App/App/Info.plist`. The reference host's
  [`scripts/ios-info-plist.sh`](../../embed/hosts/cap-host/scripts/ios-info-plist.sh) does it
  with `PlistBuddy`.
- **Cordova:** add `<config-file>` entries to `config.xml`, so `cordova prepare` writes them, and
  set the deployment target there too. The block is in [cordova.md](cordova.md#set-up-your-app).

Name your own app's places in the purpose strings ("TimeHuddle records videos for tickets and
clock sessions"), because the person sees them as your app's request.

Your `AppDelegate` needs no change. PulseKit has a hook for background upload events, but this
version doesn't upload, so a host that doesn't forward to it loses nothing.

### 3. Configure Pulse on every page load

Call `configure()` once per page load, before any other Pulse call, with `uploadMode: 'file'`. The
default, `'pulse'`, isn't available in this version: without `'file'`, every flow ends `failed`
with `unsupported`.

```ts
import { getPulse } from '@mieweb/pulse-embed';

const pulse = getPulse();
await pulse.configure({ uploadMode: 'file', hostName: 'TimeHuddle' });
```

`getPulse()` finds the plugin itself (Capacitor's `Pulse` plugin, then Cordova's
`window.PulseKit`, otherwise none), so the same page code runs in a desktop browser. On Cordova it
waits for `deviceready`, up to 10 s, before it answers. The other options (`theme`, `policy`,
`hostId`) are in [contract.md](contract.md#configureoptions).

### 4. Open Pulse where it can run

`isAvailable()` is false in a desktop browser, on Android, on an iPad and on iOS before 16.4. Show
your fallback there: a link, a QR code to the Pulse app, a file input.

Where it's true, open one of the three entries. Each resolves with a `FlowResult` when the flow
ends, which can be minutes later:

| Call                         | Opens                                          |
| ---------------------------- | ---------------------------------------------- |
| `pulse.record(context)`      | The recorder, on a new draft for `context`.    |
| `pulse.edit(draftId)`        | The editor, on a draft from an earlier result. |
| `pulse.exportDraft(draftId)` | Export, on a draft from an earlier result.     |

`context` is the place in your app the video is for: `key` (build it with
`contextKey(kind, id)`), `kind`, `id`, `label` (what the recorder shows, up to 120 characters), and
an optional `data` that Pulse hands back unchanged in the result.

Only one flow is open at a time. A second call while one is open rejects with `busy`.

### 5. Handle the result, then acknowledge it

A result can reach your page three ways: the promise from `record`, `edit` or `exportDraft`; a
`flowResult` event; and `pendingResults()`. The same result can come through more than one of
them, so send all three to one handler that ignores a result it has already handled.

| `status`      | What your app does                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `'completed'` | Upload `result.export`, keep `draftId`, then acknowledge.                                               |
| `'closed'`    | The take was kept as a draft. Keep `draftId` if you offer "continue", then acknowledge.                 |
| `'canceled'`  | Nothing was kept. Acknowledge.                                                                          |
| `'failed'`    | Show your message for `result.error.code` ([troubleshooting.md](troubleshooting.md)), then acknowledge. |

`acknowledge(requestId)` deletes the stored result and its MP4 copy, so read or upload the file
first. `result.export.webUrl` is a URL your WebView can load in a `<video>` or with `fetch()`;
don't write to it.

### 6. Read pending results on every page load

The `record()` promise belongs to the page that called it. If the page reloads while Pulse is
open, or the app is killed before your page acknowledged a result, the result comes through
`pendingResults()` or a `flowResult` event instead. Subscribe to `flowResult` and call
`pendingResults()` after `configure()` on every page load.

### The code for steps 3 to 6

```ts
import { contextKey, getPulse, isPulseError, type FlowResult } from '@mieweb/pulse-embed';

// showFallback, uploadVideo and saveDraftId are your app's own code.
const pulse = getPulse();

export async function startPulse() {
  await pulse.configure({ uploadMode: 'file', hostName: 'TimeHuddle' });
  pulse.on('flowResult', (result) => void handleResult(result));
  for (const result of await pulse.pendingResults()) await handleResult(result);
}

export async function recordForTicket(ticketId: string, title: string) {
  if (!(await pulse.isAvailable())) return showFallback();
  try {
    const context = {
      key: contextKey('ticket', ticketId),
      kind: 'ticket',
      id: ticketId,
      label: title,
    };
    await handleResult(await pulse.record(context));
  } catch (e) {
    if (isPulseError(e) && e.code === 'busy') return; // Pulse is already open
    throw e;
  }
}

const seen = new Map<string, FlowResult['status']>();

async function handleResult(result: FlowResult) {
  if (seen.get(result.requestId) === result.status) return; // already handled
  seen.set(result.requestId, result.status);
  if (result.status === 'completed' && result.mode === 'file') {
    const video = await (await fetch(result.export.webUrl)).blob();
    await uploadVideo(result.context?.key, video, result.durationMs);
    await saveDraftId(result.context?.key, result.draftId);
  } else if (result.status === 'closed') {
    await saveDraftId(result.context?.key, result.draftId);
  }
  await pulse.acknowledge(result.requestId);
}
```

- If the upload throws, the result isn't acknowledged: it stays in `pendingResults()` and your
  next page load retries it.
- In rare cases PulseKit ends a flow itself and Pulse's own result for the same `requestId` arrives
  later, with another status. The handler above treats it as new; act on the latest one
  ([contract.md](contract.md#results)).

### 7. Build and run

- **Capacitor:** `npx cap sync ios`, then `npx cap open ios` and run the `App` scheme on an iPhone
  or an iPhone Simulator.
- **Cordova:** `npx cordova build ios --emulator` (or `--device`), or open
  `platforms/ios/App.xcworkspace` in Xcode and run it there.

The first build downloads PulseKit's frameworks; later builds use the Swift Package Manager or
CocoaPods cache.

## What your app keeps

| Keep                              | From                                    | Why                                                                       |
| --------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| The video                         | `result.export` of a `completed` result | Pulse deletes its copy when you acknowledge.                              |
| `draftId`, next to your own place | `completed` and `closed` results        | To reopen the draft later with `edit(draftId)` or `exportDraft(draftId)`. |

Drafts stay on the phone, in PulseKit's own folder. If a draft no longer exists, `edit` or
`exportDraft` ends `failed` with `not_found`; drop your `draftId` then.

## Use a local build instead of npm

Use this before a release exists, or to try a change to Pulse in your app.

1. Build PulseKit on a Mac: [dev-loop.md](dev-loop.md#build-pulsekit). The frameworks land in
   `embed/artifacts/pulsekit-ios/xcframeworks/` in the Pulse repo.
2. Pack the npm packages, from the Pulse repo's root. `npm pack` builds `@mieweb/pulse-embed`
   first.

   ```sh
   mkdir -p /tmp/pulsekit-packs
   for p in pulse-embed capacitor-pulse cordova-plugin-pulse; do
     (cd embed/packages/$p && npm pack --pack-destination /tmp/pulsekit-packs)
   done
   ```

   This writes `mieweb-pulse-embed-0.0.0-dev.tgz`, `mieweb-capacitor-pulse-0.0.0-dev.tgz` and
   `cordova-plugin-pulse-0.0.0-dev.tgz`. Copy the ones you need into your app, for example into
   `vendor/`, so your lockfile doesn't point at `/tmp`.

3. Install them in your app:
   - Capacitor:
     `npm install --save-exact ./vendor/mieweb-pulse-embed-0.0.0-dev.tgz ./vendor/mieweb-capacitor-pulse-0.0.0-dev.tgz`
   - Cordova: `npm install --save-exact ./vendor/mieweb-pulse-embed-0.0.0-dev.tgz`, then
     `npx cordova plugin add /absolute/path/to/pulse/embed/packages/cordova-plugin-pulse`

4. Point the plugin at your frameworks with `PULSEKIT_LOCAL`. The repo's `Package.swift` and
   `PulseKit.podspec` are placeholders for version `0.0.0-dev` and can't download anything, so a
   local build always needs it:
   - Capacitor: [dev-loop.md](dev-loop.md#capacitor). Xcode has to be started with the variable.
   - Cordova: [dev-loop.md](dev-loop.md#cordova). Set it before `cordova prepare ios`.

> **UNTESTED** as a whole. Packing has been run, and the reference hosts take the plugins from the
> repo the same way, but these steps haven't been run in a separate app.

## Test without a phone

`@mieweb/pulse-embed/testing` has a scripted in-memory Pulse, `createFakePulse`, and the host
contract as one test suite, `runPulseContract`.

In a test or a dev build, install the fake's adapter before the page's first `getPulse()`. Your
page code then runs against it unchanged:

```ts
import { createFakePulse } from '@mieweb/pulse-embed/testing';

const fake = createFakePulse({
  flows: [{ result: 'file' }], // what each open does, in order; the last one repeats
  // The methods this PulseKit answers; without this list the fake also answers minor-1 methods.
  info: {
    methods: [
      'info',
      'configure',
      'prewarm',
      'open',
      'close',
      'isOpen',
      'pendingResults',
      'acknowledge',
      'logFile',
    ],
  },
});
window.__PULSE_ADAPTER__ = fake.adapter;
```

- Other steps: `{ result: 'kept' }` ends `closed`, `{ result: 'discarded' }` ends `canceled`,
  `{ result: 'failed', code: 'storage.full' }` ends `failed`. `afterMs` on a step keeps that flow
  open that long.
- `fake.dropNextResult()` sends the next result only to the inbox, as if the page had reloaded
  while Pulse was open; `fake.reload()` returns the new page's client. Use them to test step 6.
- The fake's `export.webUrl` is a `fakepulse://local/...` URL, which `fetch()` can't load. If your
  code reads the file, pass `toWebUrl: (path) => ...` to `createFakePulse` and return a URL your
  test server answers.
- On a page, install only `fake.adapter`; don't also use `fake.client` there, or the page gets two
  subscribers.

To run the host contract against the fake in Jest or Vitest:

```ts
import { describe, expect, it } from '@jest/globals'; // or 'vitest'
import { createFakePulse, runPulseContract } from '@mieweb/pulse-embed/testing';

runPulseContract((setup) => createFakePulse(setup), { describe, it, expect });
```

The suite runs under Jest on every Pulse PR; under Vitest it is UNTESTED.

## Done when

Check each of these in your app:

- [ ] `package.json` has `@mieweb/pulse-embed` and your host's plugin at the same exact version
      (or the local tarballs).
- [ ] Capacitor: after `npx cap sync ios`, `ios/App/CapApp-SPM/Package.swift` names
      `MiewebCapacitorPulse`. Cordova: after `npx cordova prepare ios`, `plugins/cordova-plugin-pulse/`
      exists and `platforms/ios/Podfile` has `pod 'PulseKit'`.
- [ ] The iOS deployment target is 16.4 or later.
- [ ] The app's `Info.plist` has `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`,
      `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription`, and
      `UIViewControllerBasedStatusBarAppearance` set to `YES`.
- [ ] Your page calls `configure({ uploadMode: 'file' })` once per load, before any other Pulse
      call.
- [ ] Your page subscribes to `flowResult` and handles `pendingResults()` on every load.
- [ ] Every path through your result handler ends in `acknowledge(requestId)`, and a `completed`
      result is acknowledged only after its upload succeeded.
- [ ] A result handled twice does nothing the second time.
- [ ] Where `isAvailable()` is false, your fallback shows and your Pulse button doesn't.
- [ ] Your tests pass against `createFakePulse` with `flows: [{ result: 'file' }]`, including a
      dropped result read back with `pendingResults()` after `fake.reload()`.
- [ ] On an iPhone or Simulator: `getInfo()` answers `supported: true`, `record()` opens the
      recorder, and "Use this video" on Export gives a `completed` result whose `export.webUrl`
      plays in a `<video>`.
