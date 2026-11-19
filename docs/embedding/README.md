# Embedding Pulse in a host app

PulseKit is Pulse packaged for another iOS app. Your web page asks for a task (record a video for a
place, edit a draft, export a draft), Pulse opens full screen over your app, and you get one result
back when the person is done. With `uploadMode: 'file'` the result carries the finished MP4, which
your app uploads its own way.

These pages are for mieweb host apps (Capacitor and Cordova, iOS first).

| Page                                     | Read it when you want to                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| This page                                | Check what your app needs, then record your first video.                        |
| [capacitor.md](capacitor.md)             | Add Pulse to a Capacitor 8 app.                                                 |
| [cordova.md](cordova.md)                 | Add Pulse to a Cordova (cordova-ios 8) app, including Meteor's Cordova build.   |
| [timehuddle-ios.md](timehuddle-ios.md)   | Wire Pulse into TimeHuddle's iOS project (SwiftPM patch and native-sync check). |
| [contract.md](contract.md)               | Look up a method, a result, an error code or the versioning rules.              |
| [dev-loop.md](dev-loop.md)               | Run your app against a PulseKit you built yourself, and read its logs.          |
| [releasing.md](releasing.md)             | Cut a PulseKit release or release candidate, or symbolicate a crash.            |
| [troubleshooting.md](troubleshooting.md) | Find out what an error code means and what to do about it.                      |
| [support-matrix.md](support-matrix.md)   | See which platforms and hosts have been tried, and which haven't.               |

## What you get, and what you don't

- **Three entries.** `record` (recorder for a place you name), `edit` (the editor on a draft) and
  `export` (Export on a draft). The person can move between recorder, editor and Export inside one
  flow. There is no Pulse home screen and no drafts list inside your app.
- **One result per flow**: completed (with the video), closed (the take was kept as a draft),
  canceled (nothing was kept) or failed (with an error code).
- **Results survive a reload.** Pulse writes each result to disk before it tells your page. If your
  page reloads while Pulse is open, or your app is killed before your page handled a result, the
  result waits for you in `pendingResults()`. A flow cut short by the app being killed has no
  result.
- **iPhone only.** iOS 16.4 or later. iPad, Mac (Designed for iPad) and Android report
  `supported: false`; the Android plugin is a stub that answers `unsupported` to every call.
- **Not yet:** Pulse uploading the video for you (`uploadMode: 'pulse'`), a drafts API
  (`listDrafts` and the other contract-minor-1 methods), and accounts. A call to one of those
  methods rejects with `method.unsupported`.

## Host checklist

Before your first `record()`:

1. **iOS deployment target 16.4 or later**, iPhone. Pulse refuses older systems at run time with
   `unsupported`.
2. **Install the client and one plugin**:
   - Capacitor: `@mieweb/pulse-embed` and `@mieweb/capacitor-pulse` ([capacitor.md](capacitor.md)).
   - Cordova: `@mieweb/pulse-embed` and `cordova-plugin-pulse` ([cordova.md](cordova.md)).
3. **Add these keys to your app's `Info.plist`.** Pulse checks them when it opens.

   | Key                                                | Without it                                                       |
   | -------------------------------------------------- | ---------------------------------------------------------------- |
   | `NSCameraUsageDescription`                         | `open` fails with `host_misconfigured`.                          |
   | `NSMicrophoneUsageDescription`                     | `open` fails with `host_misconfigured`.                          |
   | `NSPhotoLibraryUsageDescription`                   | The recorder's import from Photos has no purpose string to show. |
   | `NSPhotoLibraryAddUsageDescription`                | Export hides Save to Photos.                                     |
   | `UIViewControllerBasedStatusBarAppearance` = `YES` | Pulse can't set the status bar while it's open.                  |

   Name your own app's places in the purpose strings ("TimeHuddle records videos for tickets and
   clock sessions"), because the person sees them as your app's request.

4. **Call `configure()` once per page load**, before anything else, with `uploadMode: 'file'`.
   The default upload mode, `'pulse'`, isn't available yet: every flow would end `failed` with
   `unsupported`.
5. **Show your own fallback when Pulse isn't available.** `isAvailable()` is false in a desktop
   browser, on Android, on iPad and on old iOS.
6. **Drain the inbox on every page load.** Call `pendingResults()`, handle each result, then
   `acknowledge()` it.
7. **Acknowledge every result once you've acted on it**, whichever way it reached you (the `open`
   promise, a `flowResult` event or `pendingResults()`). Handling the same `requestId` twice must be
   harmless.

## Record your first video

```ts
import { contextKey, getPulse, isPulseError, type FlowResult } from '@mieweb/pulse-embed';

// showQrFallback and uploadTicketVideo are your app's own code.
const pulse = getPulse();

export async function startPulse() {
  await pulse.configure({ uploadMode: 'file', hostName: 'TimeHuddle' });
  if (!(await pulse.isAvailable())) return showQrFallback();

  try {
    const result = await pulse.record({
      key: contextKey('ticket', 'TH-482'),
      kind: 'ticket',
      id: 'TH-482',
      label: 'Fix login',
    });
    await handleResult(result);
  } catch (e) {
    if (isPulseError(e) && e.code === 'busy') return; // Pulse is already open
    throw e;
  }
}

async function handleResult(result: FlowResult) {
  if (result.status === 'completed' && result.mode === 'file') {
    // result.export.webUrl loads in your WebView; upload it before acknowledging.
    await uploadTicketVideo('TH-482', result.export.webUrl, result.durationMs);
  }
  await pulse.acknowledge(result.requestId);
}

// On every page load, after configure():
for (const result of await pulse.pendingResults()) await handleResult(result);
```

- `context` is the place the video is for. `contextKey(kind, id)` builds its `key`; `label` is
  what Pulse shows on the recorder.
- `acknowledge(requestId)` deletes the result and its MP4 copy. Read or upload the file first.
- `record()` resolves only when the flow ends, which can be minutes later. If the page reloads in
  between, the promise is gone; the result arrives through `pendingResults()` instead.

## Test your integration without a phone

`@mieweb/pulse-embed/testing` has a scripted in-memory Pulse:

```ts
import { createFakePulse, runPulseContract } from '@mieweb/pulse-embed/testing';

// In a test or dev build, before the page's first getPulse():
const fake = createFakePulse({ flows: [{ result: 'file' }] });
window.__PULSE_ADAPTER__ = fake.adapter;

// In Jest or Vitest, the contract as one suite:
runPulseContract((setup) => createFakePulse(setup), { describe, it, expect });
```

Install only `fake.adapter` on a page; don't also use `fake.client` there, or the page gets two
subscribers. Parts of the fake that cover the drafts API and Pulse uploads follow a contract that
PulseKit doesn't implement yet ([contract.md](contract.md#minor-1-not-in-this-version)).
