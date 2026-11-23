# The host contract

What your page can call, what comes back, and which rules keep old and new versions working
together. The types themselves are in
[`embed/packages/pulse-embed/src/types.ts`](../../embed/packages/pulse-embed/src/types.ts); when
this page and that file disagree, the file is right.

## Versions

`getInfo()` reports `contract: { major, minor }`. This version is contract 1.1.

- **Major** changes only for a breaking change. The client refuses a PulseKit with another major
  (`contract.unsupported`). This contract is major 1.
- **Minor** counts additions. Minor 0 is the flows, `info`, the results inbox and `close`. Minor 1
  adds accounts, the drafts API, Pulse uploads (`uploadMode: 'pulse'`) and host services.
- **Check for a method, not a minor**: `(await pulse.getInfo()).methods.includes('listDrafts')`.
  The client already rejects a method PulseKit doesn't list with `method.unsupported`, without
  calling native.
- **Check for a capability** the same way: `getInfo().capabilities` lists what this build can do:
  `upload.pulse`, `upload.file`, `upload.background`, `captions`, `share`, `saveToPhotos`, and
  `headless` when host writes and uploads run with nothing on screen
  ([uploads.md](uploads.md#paused-uploads)).
- Error codes, draft states, entry names, event names and fields are only ever added, never renamed
  or reused. Treat an error code you don't know as `unknown` (the client does: it keeps the
  original in `reason`), a draft state you don't know as `draft`, and ignore events you don't know.
- Unknown fields are ignored both ways: PulseKit drops request fields it doesn't know, and the
  client passes result fields it doesn't know through unchanged. A missing required field, or a
  field of the wrong type, is `invalid_options`.
- Everything is JSON. Times are integer milliseconds since the epoch, in UTC.

PulseKit's version (`getInfo().sdkVersion`) and the three npm packages always carry the same
version.

## Methods

"Starts Pulse" means the call runs in Pulse's JavaScript: if Pulse isn't running, it starts, with
nothing on screen in a `headless` build and under a brief "Preparing…" screen otherwise. Every other
call is answered by PulseKit from files, without starting Pulse.

| Method                         | Minor | Resolves with                     | Rejects with (besides `unavailable`, `unsupported`, `contract.unsupported`, `invalid_options`) |
| ------------------------------ | ----- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `isAvailable()`                | 0     | `boolean`; never rejects          | —                                                                                              |
| `getInfo()`                    | 0     | `PulseInfo`                       | Works even when `supported` is false.                                                          |
| `configure(options)`           | 0     | nothing                           | —                                                                                              |
| `prewarm()`                    | 0     | nothing                           | — Starts Pulse's runtime without showing anything, so the next `open` is faster.               |
| `open(request)`                | 0     | `FlowResult`, when the flow ends  | `busy`, `no_account`, `host_misconfigured`, `restart_required`                                 |
| `record(context, options?)`    | 0     | `FlowResult`                      | as `open`                                                                                      |
| `edit(draftId, options?)`      | 0     | `FlowResult`                      | as `open`                                                                                      |
| `exportDraft(draftId, opts?)`  | 0     | `FlowResult`                      | as `open`                                                                                      |
| `close({ discard? })`          | 0     | nothing                           | — No-op when nothing is open.                                                                  |
| `isOpen()`                     | 0     | `boolean`                         | —                                                                                              |
| `pendingResults()`             | 0     | `FlowResult[]`, oldest first      | `no_account`                                                                                   |
| `acknowledge(requestId)`       | 0     | nothing                           | — An unknown `requestId` is a no-op.                                                           |
| `logFile()`                    | 0     | `FileRef` to Pulse's log          | `not_found` when `policy.logs` is `'off'`, or before any account is set                        |
| `on(event, callback)`          | 0     | an unsubscribe function           | —                                                                                              |
| `setAccount(account \| null)`  | 1     | `{ namespace }`                   | `busy`, `restart_required` ([accounts.md](accounts.md))                                        |
| `listDrafts(filter?)`          | 1     | `DraftSummary[]`                  | `no_account`                                                                                   |
| `getDraft(id)`                 | 1     | `DraftSummary` or `null`          | `no_account`                                                                                   |
| `countDrafts(options)`         | 1     | `{ [key]: number }`               | `no_account`                                                                                   |
| `usage()`                      | 1     | `Usage`                           | `no_account`                                                                                   |
| `listNamespaces()`             | 1     | `NamespaceInfo[]`                 | —                                                                                              |
| `purge({ namespace? })`        | 1     | nothing                           | `busy`, `no_account`                                                                           |
| `renameDraft(id, name)`        | 1     | nothing; starts Pulse             | `no_account`, `not_found`, `draft.locked`, `storage.newer_schema`, `timeout`                   |
| `setDraftContext(id, context)` | 1     | nothing; starts Pulse             | `no_account`, `not_found`, `draft.locked`, `storage.newer_schema`, `timeout`                   |
| `deleteDraft(id)`              | 1     | nothing; starts Pulse             | `no_account`, `not_found`, `draft.locked`, `timeout`                                           |
| `upload(id)`                   | 1     | `{ clientKey, draftKey, sentAt }` | `no_account`, `not_found`, `draft.locked`, `upload.too_large`, `host_misconfigured`, `timeout` |
| `cancelUpload(id)`             | 1     | nothing; starts Pulse             | `no_account`, `not_found`, `draft.locked`, `timeout`                                           |
| `retireDraft(id)`              | 1     | nothing; starts Pulse             | `no_account`, `not_found`, `draft.locked`, `timeout`                                           |
| `dismissReceipt(id)`           | 1     | nothing; starts Pulse             | `no_account`, `not_found`, `timeout`                                                           |
| `resumeOutbox()`               | 1     | nothing; starts Pulse             | `no_account`, `timeout`                                                                        |
| `setHostServices(services)`    | 1     | nothing (local to the client)     | —                                                                                              |

[drafts.md](drafts.md) explains the drafts calls and their lock rules, [uploads.md](uploads.md) the
uploads and host services, and [accounts.md](accounts.md) the account calls.

### Timeouts

- A call that starts Pulse waits 30 s by default, a cold start included, then rejects with
  `timeout`. `createPulseClient({ timeoutMs })` changes the wait; the client sends it with each
  call, and PulseKit waits as long, from 1 s to 10 minutes.
- A `timeout` doesn't mean the change didn't happen: Pulse may still finish it. Read the draft with
  `getDraft(id)` before you retry. `upload(id)` called again answers with the same keys only while
  the upload is `queued` or `needs_credentials`; once it is `preparing`, `uploading` or
  `delivering` it rejects with `draft.locked`, which after a timeout usually means the Send worked.
- `open` has no timeout: it resolves when the person finishes, minutes later.
- A host request ([uploads.md](uploads.md)) has 20 s to be answered.

### `configure(options)`

Call it once per page load, before anything else. Calling it again replaces the options.

| Option       | What it does                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uploadMode` | `'pulse'` (default): Export's primary action is Send, and Pulse uploads through your host services. `'file'`: it is "Use this video" and the result carries the MP4.             |
| `hostName`   | Your app's name where Pulse means "the app" ("Back to TimeHuddle").                                                                                                              |
| `hostId`     | Prefix of the folders Pulse stores each account's drafts in. Default: your bundle id. `[a-z0-9.-]`, up to 40 characters.                                                         |
| `theme`      | `appearance` (`'light'`, `'dark'`, `'system'`), `accent` and `destructive` (`'#rrggbb'`), `buttonRadius` in points. A request's own `theme` overrides it for that flow.          |
| `policy`     | `allowShare`, `allowSaveToPhotos` (both default true), `tips` (default true), `logs` (`'host'` or `'off'`), `wifiOnlyUploads` (default false: uploads also use cellular).        |
| `captions`   | `autoDownload`: `'wifi'` (default: the captions model downloads on Wi-Fi the first time; on cellular Pulse asks) or `'never'`. `autoGenerate` (default true): captions per take. |
| `models`     | `{ baseUrl }`: where the captions models download from, `https` only. Default: Pulse's own source.                                                                               |

Save to Photos also needs `NSPhotoLibraryAddUsageDescription` in your `Info.plist`; without it the
button is hidden whatever `policy` says.

### `open(request)`

| `entry`    | Fields                                                                      | First screen |
| ---------- | --------------------------------------------------------------------------- | ------------ |
| `'record'` | `context` (required), `draft`: `'new'` (default) or `{ continue: draftId }` | Recorder     |
| `'edit'`   | `draftId`, optional `clipId`                                                | Editor       |
| `'export'` | `draftId`                                                                   | Export       |

Every request takes an optional `requestId` (default: a new UUID) and an optional `theme`. A
`requestId` is 1–64 of `[A-Za-z0-9._-]`, not `.` or `..`, and doesn't end in `.project`
(`<id>.project.json` is a project document's name in the inbox).

- **One flow at a time.** While a flow is open, `open` with the same `requestId` resolves with the
  same result; any other `requestId` rejects with `busy`. `open` is also `busy` while your app is
  presenting another screen.
- **A finished request answers from the inbox.** While a `requestId`'s result is unacknowledged,
  `open` with that `requestId` resolves with that result at once and shows nothing. Acknowledge it
  before reusing the id.
- **`context`** names the place the video is for: `key` (build it with `contextKey(kind, id)`:
  1–128 characters of `[a-z0-9._:-]`), `kind`, `id`, and `label` (what the recorder shows, up to
  120 characters). `data` is yours; Pulse hands it back unchanged in results, drafts and upload
  requests. `uploadType` sets what Send asks for ([uploads.md](uploads.md#upload-types)). The
  whole object must be under 8 KB of JSON.
- **A draft that can't open** ends the flow `failed`: `not_found` when it doesn't exist,
  `draft.locked` while it is sending, `storage.newer_schema` in a library a newer PulseKit wrote.
- `open` has no timeout. If your page reloads first, the promise is lost and the result arrives
  through `pendingResults()`.

### `close(options)`

Ends the open flow without asking the person. A new take is kept as a draft (`closed`,
`reason: 'host'`). With `discard: true`, for shared phones, a draft this flow made is deleted and
the flow ends `canceled`; a draft the flow opened (`edit`, `export`, `record` with `continue`) is
never deleted. A take being recorded is stopped first, and a Send in progress is finished first. If
Pulse doesn't end the flow within 5 seconds (30 while a Send is running), PulseKit dismisses it and
writes the result itself.

## Results

Every flow ends with exactly one `FlowResult`. Each has `requestId`, `entry`, `endedOn` (the screen
it ended on, or null if none appeared), `stage` (`'none'`, `'recorded'`, `'edited'`,
`'exported'`), `context` and `endedAt`.

| `status`      | When                                                      | Extra fields                                                                                                          |
| ------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `'completed'` | Send on Export (`mode: 'pulse'`).                         | `draftId`, `sentAt` (the tap), `clientKey`, `draftKey`, `confirmedAt` for a `confirmSend` type. The upload is queued. |
| `'completed'` | "Use this video" on Export (`mode: 'file'`).              | `draftId`, `export` (the MP4), `durationMs`, `project` (the draft's `.pulse` project document)                        |
| `'closed'`    | X, then Keep draft; or your `close()`.                    | `reason` (`'user'`, `'host'`, `'interrupted'`), `draftId`                                                             |
| `'canceled'`  | X, then Discard video; or closed before any clip existed. | `reason`; `draftId` when an existing draft was opened and left unchanged                                              |
| `'failed'`    | Something stopped the flow.                               | `error` (see below); `draftId` when the draft had a clip (it survives)                                                |

- **The MP4 and project document** in a file-mode `completed` result are copies under PulseKit's
  `results/` folder. They are yours until you call `acknowledge(requestId)`, which deletes them.
- **A result can arrive more than once.** If PulseKit had to end a flow itself (your `close()` got
  no answer in 5 s, or your app dismissed Pulse) and Pulse's own result arrives later, you get a
  second `flowResult` for the same `requestId`. Act on the latest one; `pendingResults()` always
  returns the file as it is now.
- When PulseKit ends a flow itself, it reports `closed` only if the request named an existing draft
  and a take existed; a fresh take reads `canceled`, even though Pulse may still keep it as a draft.

## Drafts

A `DraftSummary` has `id`, `draftKey`, `name`, `context`, `state`, `clipCount`, `durationMs`,
`bytes`, `hasCaptions`, `confirmedAt`, `poster`, `export`, `upload`, `sent`, `createdVia`
(`'app'` or `'host'`), `createdAt` and `updatedAt`.

| `state`             | Means                                                                       |
| ------------------- | --------------------------------------------------------------------------- |
| `draft`             | Not sent; its video isn't merged, or changed since.                         |
| `ready`             | Not sent; merged and ready to send.                                         |
| `preparing`         | Send is merging it. Locked.                                                 |
| `queued`            | Waiting to upload.                                                          |
| `waiting_network`   | Queued, but offline (or Wi-Fi only on cellular).                            |
| `uploading`         | Bytes are going up; `upload.progress` says how far. Locked.                 |
| `delivering`        | All bytes are on the server; waiting for its outcome. Locked.               |
| `needs_credentials` | Paused: your page didn't answer, nobody is signed in, or the token expired. |
| `failed`            | Not sent; `upload.error` says why.                                          |
| `sent`              | A receipt for 7 days: `sent.outcome` is `done` or `kept`. No video.         |

## Events

| Event            | Payload                                        | Sent in this version                                            |
| ---------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `flowResult`     | `FlowResult`                                   | Yes, for every result, including ones a reloaded page missed.   |
| `draftsChanged`  | `{ namespace, ids }`                           | Yes, after the new state is readable.                           |
| `uploadProgress` | `{ draftId, fraction, bytesSent, bytesTotal }` | Yes, at most 4 a second per draft.                              |
| `log`            | `{ level, line, callId?, at }`                 | No. Read `logFile()` instead ([dev-loop.md](dev-loop.md#logs)). |

`hostRequest` events also cross the plugin; the client handles them for you through
`setHostServices()`.

## Errors

A call rejects with a `PulseError`: an `Error` with `name: 'PulseError'`, `code`, `message`
(English, for logs; show your own text keyed by `code`), `recoverable` (true when the same call may
work later with no change by the person) and `callId` (it appears in PulseKit's log lines). Use
`isPulseError(e)` to tell one apart. A `failed` result, and an upload's `upload.error`, carry the
same shape.

| Code                   | Where                                       | Meaning                                                                                                                            |
| ---------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `unavailable`          | any call                                    | No Pulse plugin on this page (a browser, or the plugin isn't installed or linked).                                                 |
| `unsupported`          | any call but `getInfo`; a `failed` result   | This device can't run Pulse; or, in a result, the options ask for something this PulseKit can't do.                                |
| `contract.unsupported` | any call                                    | PulseKit's contract major isn't the client's.                                                                                      |
| `method.unsupported`   | any call                                    | This PulseKit doesn't list the method.                                                                                             |
| `busy`                 | `open`, `setAccount`, `purge`               | A flow is open (with another `requestId`), or your app is presenting something.                                                    |
| `invalid_options`      | any call; a `failed` result                 | A required field is missing or has the wrong type.                                                                                 |
| `no_account`           | `open`, `pendingResults`, drafts calls      | No `setAccount()` yet, or after `setAccount(null)`.                                                                                |
| `restart_required`     | `setAccount`, then `open` and drafts writes | Another person's library is open in this app session.                                                                              |
| `not_found`            | drafts calls, `logFile`; a `failed` result  | No such draft (or it was sent), or logs are off.                                                                                   |
| `draft.locked`         | drafts writes; a `failed` result            | The draft is sending, open in the current flow, or bound to a confirmed Send (`reason: 'clock_bound'`).                            |
| `host_misconfigured`   | `open`, `upload`; an upload's error         | A purpose string is missing, no view controller to present from, `upload` in file mode, or a target that doesn't echo `clientKey`. |
| `timeout`              | calls that start Pulse                      | Pulse didn't answer in time (30 s by default).                                                                                     |
| `storage.full`         | `failed` result                             | The phone is out of space. The videos are still there.                                                                             |
| `storage.damaged`      | `failed` result                             | Pulse couldn't open or update its library on this phone.                                                                           |
| `storage.newer_schema` | drafts writes; a `failed` result            | A newer PulseKit wrote this library; lists, sends and deletes still work.                                                          |
| `export.failed`        | `failed` result                             | After "Use this video", the video couldn't be copied out for your app. The draft is kept.                                          |
| `runtime.error`        | `failed` result                             | A JavaScript error inside Pulse. Your app keeps running, and the next `open` starts fresh.                                         |
| `upload.too_large`     | `upload`; an upload's error                 | Over the upload type's `maxBytes` or your server's limit.                                                                          |
| `upload.refused`       | an upload's error                           | Your server or PulseVault refused the upload for good.                                                                             |
| `upload.failed`        | an upload's error                           | A network or server failure; Pulse retries it.                                                                                     |
| `destination.gone`     | an upload's error                           | Your server said the place is gone or the person lost access.                                                                      |
| `host.unavailable`     | an upload's error                           | Your page didn't answer a host request within 20 s, or refused it without a code.                                                  |
| `credentials.expired`  | an upload's error                           | The upload's token expired and couldn't be refreshed.                                                                              |
| `unknown`              | anywhere                                    | Anything else, including a code this client doesn't know (see `reason`).                                                           |

The contract defines three codes this PulseKit never sends: `permission.camera`,
`permission.microphone` (without camera or microphone access, the recorder shows its own permission
screen instead of ending the flow) and `runtime.paused`. [troubleshooting.md](troubleshooting.md)
says what to do about each code.

## On the wire

The client sends each call as one JSON request envelope through the plugin and gets one reply
envelope back; events come as event envelopes. You only need this when you write an adapter or
read the test host's log:

```json
{ "v": 1, "callId": "c-7f3a9e01b2c4", "method": "open", "args": { "entry": "record", "requestId": "6f1c2d0e-8b4a-4c55-9a77-0d3e5b2f9c41", "context": { "key": "ticket:th-482", "kind": "ticket", "id": "TH-482", "label": "Fix login" } }, "client": { "contract": { "major": 1, "minor": 1 }, "version": "0.1.0" } }
{ "v": 1, "callId": "c-7f3a9e01b2c4", "ok": false, "error": { "code": "busy", "message": "Pulse is already open, or the app is showing another screen.", "recoverable": true, "callId": "c-7f3a9e01b2c4" } }
{ "v": 1, "callId": "c-0b4d61e9a2f7", "method": "renameDraft", "args": { "id": "5d2c8e3a-71b0-4f6e-9c1d-2a8b7e4f0c13", "name": "Login fix demo" }, "client": { "contract": { "major": 1, "minor": 1 }, "version": "0.1.0" }, "timeoutMs": 30000 }
{ "v": 1, "name": "flowResult", "payload": { "requestId": "6f1c2d0e-8b4a-4c55-9a77-0d3e5b2f9c41", "entry": "record", "status": "canceled", "reason": "user", "endedOn": "recorder", "stage": "none", "context": { "key": "ticket:th-482", "kind": "ticket", "id": "TH-482", "label": "Fix login" }, "endedAt": 1763571234567 } }
```

- **`timeoutMs`** sits at the top of a request envelope, next to `client`: how long the client waits
  for the reply. A call that starts Pulse waits as long in PulseKit (clamped to 1 s–10 minutes);
  without it, 30 s. The client leaves it out for `open`. A value that isn't a positive whole number
  is ignored.
- A Pulse error is a reply with `ok: false`, never a rejected plugin call. A plugin call rejects
  only when the transport itself failed, and the client turns that into `unavailable`.

The cases both sides must agree on are pinned in
[`embed/native/ios/vectors/envelope.json`](../../embed/native/ios/vectors/envelope.json), which the
Swift facade and the client's Jest tests both run.

## Inside PulseKit: the facade and Pulse's JavaScript

Hosts never see these; they are for working on PulseKit itself. The facade
(`embed/native/ios/PulseKit.swift`) and Pulse's JavaScript (`embed/src/shell/messaging.ts`,
`embed/src/commands/runtime.ts`) talk over expo-brownfield's `BrownfieldMessaging`:

| `type`                                      | Direction   | Fields                                                        | Meaning                                                                                                                                                                            |
| ------------------------------------------- | ----------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pulse.cmd`                                 | native → JS | `callId, method, args`                                        | A forwarded host write, or an internal command (below).                                                                                                                            |
| `pulse.reply`                               | JS → native | `callId, ok, result \| error`                                 | The answer to a `pulse.cmd` that expects one.                                                                                                                                      |
| `pulse.event`                               | JS → native | `name, payload`                                               | `draftsChanged`, `uploadProgress`, `hostRequest`; the facade forwards each to the host.                                                                                            |
| `pulse.respond`                             | native → JS | `hostCallId, result \| error`                                 | The host's `respondHostRequest`.                                                                                                                                                   |
| `pulse.ready`                               | JS → native | `namespace`                                                   | The runtime's command handlers are up. The facade sends `accountActive {active:false}` if the runtime's account isn't the signed-in one, then `configure`, then the calls it held. |
| `pulse.released`                            | JS → native | `namespace`                                                   | The runtime closed its library for good; the facade sends it nothing more and starts a fresh one next.                                                                             |
| `pulse.result`                              | JS → native | `requestId`                                                   | The flow's result file is written; the facade reads it, resolves `open` and dismisses.                                                                                             |
| `pulse.error`                               | JS → native | `requestId, message`                                          | The embed root couldn't start; the flow ends `failed{runtime.error}`.                                                                                                              |
| `pulse.ui`                                  | JS → native | `statusBar?, statusBarHidden?, hasTake?, sending?`            | The container's status bar and swipe-to-dismiss, and whether a Send is running (the `close` watchdog waits for it); each field sticks until set again.                              |
| `pulse.upload`                              | JS → native | `op` (`hello`, `patch`, `attach`, `cancel`, `sweep`), `id`, … | A TUS PATCH for PulseKit's background session (`PulseKitBackground.swift`).                                                                                                        |
| `pulse.upload.progress`, `pulse.upload.end` | native → JS | `id, sent` / `id, ok, status?, …`                             | That PATCH's progress and end.                                                                                                                                                     |

Internal `pulse.cmd` methods:

| `method`         | Args                          | Reply         | When                                                                                                                                          |
| ---------------- | ----------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `close`          | `{ reason, discard? }`        | yes           | The host's `close()`.                                                                                                                         |
| `configure`      | the host's options            | none          | The host's latest `configure` options, on each `pulse.ready` and each later `configure`.                                                      |
| `accountActive`  | `{ active }`                  | none          | `setAccount` made the runtime's account the signed-in one, or not; the job loop pauses while it isn't.                                        |
| `network`        | `{ online, wifi, expensive }` | none          | Every reachability change PulseKit's path monitor sees.                                                                                       |
| `hostTimeout`    | `{ hostCallId }`              | none          | A host request reached its 20 s deadline unanswered.                                                                                          |
| `releaseLibrary` | `{ namespace }`               | yes           | A purge of the runtime's namespace: stop the job loop and close the database, then `pulse.released`.                                          |
| `memoryWarning`  | `{}`                          | `{ release }` | A memory warning with nothing open. Pulse lets go of the captions models, and of the whole runtime only with no flow, command or live upload. |

The root component's initial props are
`{ requestId, request, documentsDir, cachesDir, modelsDir, namespace, config, headless, network }`.
A flow's root has its `request`; the root a host write starts has `request: null`, with `headless`
saying whether it has a screen. `network` seeds reachability until the first `pulse.cmd network`.
