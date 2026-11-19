# The host contract

What your page can call, what comes back, and which rules keep old and new versions working
together. The types themselves are in
[`embed/packages/pulse-embed/src/types.ts`](../../embed/packages/pulse-embed/src/types.ts); when
this page and that file disagree, the file is right.

## Versions

`getInfo()` reports `contract: { major, minor }`.

- **Major** changes only for a breaking change. The client refuses a PulseKit with another major
  (`contract.unsupported`). This contract is major 1.
- **Minor** counts additions. Minor 0 is the flows, `info`, the results inbox and `close`; minor 1
  adds the drafts API, accounts and Pulse uploads.
- **Check for a method, not a minor**: `(await pulse.getInfo()).methods.includes('listDrafts')`.
  The client already rejects a method PulseKit doesn't list with `method.unsupported`, without
  calling native.
- Error codes, draft states, entry names, event names and fields are only ever added, never renamed
  or reused. Treat an error code you don't know as `unknown` (the client does: it keeps the
  original in `reason`), and ignore events you don't know.
- Unknown fields are ignored both ways: PulseKit drops request fields it doesn't know, and the
  client passes result fields it doesn't know through unchanged. A missing required field, or a
  field of the wrong type, is `invalid_options`.
- Everything is JSON. Times are integer milliseconds since the epoch, in UTC.

PulseKit's version (`getInfo().sdkVersion`) and the three npm packages always carry the same
version.

## Methods in this version (minor 0)

| Method                        | Resolves with                    | Rejects with (besides `unavailable`, `unsupported`, `contract.unsupported`, `invalid_options`) |
| ----------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `isAvailable()`               | `boolean`; never rejects         | —                                                                                              |
| `getInfo()`                   | `PulseInfo`                      | Works even when `supported` is false.                                                          |
| `configure(options)`          | nothing                          | —                                                                                              |
| `prewarm()`                   | nothing                          | — Starts Pulse's runtime without showing anything, so the next `open` is faster.               |
| `open(request)`               | `FlowResult`, when the flow ends | `busy`, `host_misconfigured`                                                                   |
| `record(context, options?)`   | `FlowResult`                     | as `open`                                                                                      |
| `edit(draftId, options?)`     | `FlowResult`                     | as `open`                                                                                      |
| `exportDraft(draftId, opts?)` | `FlowResult`                     | as `open`                                                                                      |
| `close({ discard? })`         | nothing                          | — No-op when nothing is open.                                                                  |
| `isOpen()`                    | `boolean`                        | —                                                                                              |
| `pendingResults()`            | `FlowResult[]`, oldest first     | —                                                                                              |
| `acknowledge(requestId)`      | nothing                          | — An unknown `requestId` is a no-op.                                                           |
| `logFile()`                   | `FileRef` to Pulse's log         | `not_found` when `policy.logs` is `'off'`                                                      |
| `on(event, callback)`         | an unsubscribe function          | —                                                                                              |

### `configure(options)`

Call it once per page load, before anything else. Calling it again replaces the options.

| Option       | What it does                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uploadMode` | `'file'`: Export's primary action is "Use this video" and the result carries the MP4. Required in this version; the default `'pulse'` isn't available yet.              |
| `hostName`   | Your app's name where Pulse means "the app" ("Back to TimeHuddle").                                                                                                     |
| `hostId`     | Prefix of the folder Pulse stores drafts in. Default: your bundle id. `[a-z0-9.-]`, up to 40 characters.                                                                |
| `theme`      | `appearance` (`'light'`, `'dark'`, `'system'`), `accent` and `destructive` (`'#rrggbb'`), `buttonRadius` in points. A request's own `theme` overrides it for that flow. |
| `policy`     | `allowShare`, `allowSaveToPhotos` (both default true), `tips` (default true), `logs` (`'host'` or `'off'`).                                                             |

Save to Photos also needs `NSPhotoLibraryAddUsageDescription` in your `Info.plist`; without it the
button is hidden whatever `policy` says.

### `open(request)`

| `entry`    | Fields                                                                      | First screen |
| ---------- | --------------------------------------------------------------------------- | ------------ |
| `'record'` | `context` (required), `draft`: `'new'` (default) or `{ continue: draftId }` | Recorder     |
| `'edit'`   | `draftId`, optional `clipId`                                                | Editor       |
| `'export'` | `draftId`                                                                   | Export       |

Every request takes an optional `requestId` (default: a new UUID) and an optional `theme`.

- **One flow at a time.** While a flow is open, `open` with the same `requestId` resolves with the
  same result; any other `requestId` rejects with `busy`. `open` is also `busy` while your app is
  presenting another screen.
- **A finished request answers from the inbox.** While a `requestId`'s result is unacknowledged,
  `open` with that `requestId` resolves with that result at once and shows nothing. Acknowledge it
  before reusing the id.
- **`context`** names the place the video is for: `key` (build it with
  `contextKey(kind, id)`), `kind`, `id`, and `label` (what the recorder shows, up to 120
  characters). `data` is yours; Pulse hands it back unchanged. The whole object must be under
  8 KB of JSON.
- `open` has no timeout: it resolves when the person finishes, minutes later. If your page reloads
  first, the promise is lost and the result arrives through `pendingResults()`.

### `close(options)`

Ends the open flow without asking the person. A new take is kept as a draft (`closed`,
`reason: 'host'`). With `discard: true`, for shared phones, a draft this flow made is deleted and
the flow ends `canceled`; a draft the flow opened (`edit`, `export`, `record` with `continue`) is
never deleted. If Pulse doesn't end the flow within 5 seconds, PulseKit dismisses it and writes the
result itself.

## Results

Every flow ends with exactly one `FlowResult`. Each has `requestId`, `entry`, `endedOn` (the screen
it ended on, or null if none appeared), `stage` (`'none'`, `'recorded'`, `'edited'`,
`'exported'`), `context` and `endedAt`.

| `status`      | When                                                      | Extra fields                                                                                   |
| ------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `'completed'` | "Use this video" on Export (`mode: 'file'`).              | `draftId`, `export` (the MP4), `durationMs`, `project` (the draft's `.pulse` project document) |
| `'closed'`    | X, then Keep draft; or your `close()`.                    | `reason` (`'user'`, `'host'`, `'interrupted'`), `draftId`                                      |
| `'canceled'`  | X, then Discard video; or closed before any clip existed. | `reason`; `draftId` when an existing draft was opened and left unchanged                       |
| `'failed'`    | Something stopped the flow.                               | `error` (see below); `draftId` when the draft had a clip (it survives)                         |

- **The MP4 and project document** in a `completed` result are copies under PulseKit's `results/`
  folder. They are yours until you call `acknowledge(requestId)`, which deletes them.
- **A result can arrive more than once.** If PulseKit had to end a flow itself (your `close()` got
  no answer in 5 s, or your app dismissed Pulse) and Pulse's own result arrives later, you get a
  second `flowResult` for the same `requestId`. Act on the latest one; `pendingResults()` always
  returns the file as it is now.
- When PulseKit ends a flow itself, it reports `closed` only if the request named an existing draft
  and a take existed; a fresh take reads `canceled`, even though Pulse may still keep it as a draft.

## Events

| Event            | Payload                                        | Sent in this version                                            |
| ---------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `flowResult`     | `FlowResult`                                   | Yes, for every result, including ones a reloaded page missed.   |
| `draftsChanged`  | `{ namespace, ids }`                           | No (drafts API)                                                 |
| `uploadProgress` | `{ draftId, fraction, bytesSent, bytesTotal }` | No (Pulse uploads)                                              |
| `log`            | `{ level, line, callId?, at }`                 | No. Read `logFile()` instead ([dev-loop.md](dev-loop.md#logs)). |

## Errors

A call rejects with a `PulseError`: an `Error` with `name: 'PulseError'`, `code`, `message`
(English, for logs; show your own text keyed by `code`), `recoverable` (true when the same call may
work later with no change by the person) and `callId` (it appears in PulseKit's log lines). Use
`isPulseError(e)` to tell one apart. A `failed` result carries the same shape in `error`.

| Code                   | Where                                     | Meaning                                                                                             |
| ---------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `unavailable`          | any call                                  | No Pulse plugin on this page (a browser, or the plugin isn't installed).                            |
| `unsupported`          | any call but `getInfo`; a `failed` result | This device can't run Pulse; or, in a result, the options ask for something this PulseKit can't do. |
| `contract.unsupported` | any call                                  | PulseKit's contract major isn't the client's.                                                       |
| `method.unsupported`   | any call                                  | This PulseKit doesn't list the method.                                                              |
| `busy`                 | `open`                                    | A flow is open with another `requestId`, or your app is presenting something.                       |
| `invalid_options`      | any call; a `failed` result               | A required field is missing or has the wrong type.                                                  |
| `not_found`            | `logFile`; a `failed` result              | Logs are off; or the draft to edit or export doesn't exist.                                         |
| `host_misconfigured`   | `open`                                    | A camera or microphone purpose string is missing, or `open` had no view controller to present from. |
| `storage.full`         | `failed` result                           | The phone is out of space. The videos are still there.                                              |
| `storage.damaged`      | `failed` result                           | Pulse couldn't open or update its library on this phone.                                            |
| `export.failed`        | `failed` result                           | After "Use this video", the video couldn't be copied out for your app. The draft is kept.           |
| `runtime.error`        | `failed` result                           | A JavaScript error inside Pulse. Your app keeps running, and the next `open` starts fresh.          |
| `unknown`              | anywhere                                  | Anything else, including a code this client doesn't know (see `reason`).                            |

The contract defines more codes than this version produces. `permission.camera`,
`permission.microphone`, `storage.newer_schema`, `timeout` and the minor-1 codes (`draft.locked`,
`host.unavailable`, `restart_required`, `no_account`, `runtime.paused`, `upload.*`,
`destination.gone`, `credentials.expired`) are in the types so your code can handle them, but this
PulseKit never sends them. Without camera or microphone access, the recorder shows its own
permission screen instead of ending the flow.
[troubleshooting.md](troubleshooting.md) says what to do about each code.

## Minor 1 (not in this version)

These are in the types so hosts can be written against them, but this PulseKit doesn't list them in
`info().methods`, so each rejects with `method.unsupported`:

- Accounts: `setAccount`, `listNamespaces`, `purge`, `usage`.
- Drafts: `listDrafts`, `getDraft`, `countDrafts`, `renameDraft`, `deleteDraft`, `setDraftContext`.
- Pulse uploads: `upload`, `cancelUpload`, `retireDraft`, `dismissReceipt`, `resumeOutbox`,
  `setHostServices` (and the `getUploadTarget`, `refreshUploadToken`, `releaseUploadTarget` and
  `confirmSend` requests it answers).

The React hooks for them (`useDrafts`, `useDraft`, `useDraftCounts` in
`@mieweb/pulse-embed/react`) load nothing useful until then; `usePulseAvailability` and
`usePresent` work now.

## On the wire

The client sends each call as one JSON request envelope through the plugin and gets one reply
envelope back; events come as event envelopes. You only need this when you write an adapter or
read the test host's log:

```json
{ "v": 1, "callId": "c-7f3a9e01b2c4", "method": "open", "args": { "entry": "record", "requestId": "6f1c2d0e-8b4a-4c55-9a77-0d3e5b2f9c41", "context": { "key": "ticket:th-482", "kind": "ticket", "id": "TH-482", "label": "Fix login" } }, "client": { "contract": { "major": 1, "minor": 0 }, "version": "0.1.0" } }
{ "v": 1, "callId": "c-7f3a9e01b2c4", "ok": false, "error": { "code": "busy", "message": "Pulse is already open, or the app is showing another screen.", "recoverable": true, "callId": "c-7f3a9e01b2c4" } }
{ "v": 1, "name": "flowResult", "payload": { "requestId": "6f1c2d0e-8b4a-4c55-9a77-0d3e5b2f9c41", "entry": "record", "status": "canceled", "reason": "user", "endedOn": "recorder", "stage": "none", "context": { "key": "ticket:th-482", "kind": "ticket", "id": "TH-482", "label": "Fix login" }, "endedAt": 1763571234567 } }
```

A Pulse error is a reply with `ok: false`, never a rejected plugin call. A plugin call rejects only
when the transport itself failed, and the client turns that into `unavailable`.

The cases both sides must agree on are pinned in
[`embed/native/ios/vectors/envelope.json`](../../embed/native/ios/vectors/envelope.json), which the
Swift facade and the client's Jest tests both run.
