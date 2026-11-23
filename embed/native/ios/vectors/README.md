# PulseKit shared vectors

`envelope.json` pins the facade's pure rules, so the Swift facade and the JS client
(`@mieweb/pulse-embed`) are checked against the same cases. The contract they follow is
native-bridge.md §2 (envelopes), §3 (methods and the busy matrix) and §6.2 (results inbox).

## Who runs them

- **Swift**, on a Mac, with no iOS build. `tests/EnvelopeVectorsMain.swift` compiles together with
  `PulseKitEnvelope.swift` (Foundation only) into a command-line binary:

  ```sh
  xcrun swiftc -o "$TMPDIR/pk-envelope-vectors" \
    embed/native/ios/PulseKitEnvelope.swift embed/native/ios/tests/EnvelopeVectorsMain.swift
  "$TMPDIR/pk-envelope-vectors" embed/native/ios/vectors/envelope.json
  ```

  It prints one line per vector and exits 1 when any fails.

- **Jest**, in `embed/packages/pulse-embed/src/envelope-vectors.test.ts`, through the client's
  envelope and validation code.

- **Kotlin**, on a JVM, with no Android build. `embed/native/android/jvm-tests` compiles the
  Android facade's plain-Kotlin core (`embed/native/android/src/main/java/com/mieweb/pulse/kit/core`)
  and runs this file, `namespace-vectors.json` and the catalog vectors with the same checks:
  `gradle --offline -q -p embed/native/android/jvm-tests run --args="$PWD"` from the repository
  root (see `embed/native/android/README.md`).

## Sections

| Section       | Each case                                                                   | Checks                                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract`    | `{major, minor}`                                                            | The contract version the vectors were written for.                                                                                                                                                       |
| `methods`     | `native`, `minor1` name lists                                               | What the facade answers itself (minor 0), and what minor 1 adds (passed on to Pulse; the facade checks only that the list matches).                                                                                                       |
| `requests`    | `request` (object) or `requestText` (raw text), optional `supported: false` | Routing: `expect.route` is `native` (with `method` and the `args` it gets) or `reply` (with `callId` and `error.code` / `error.recoverable`). Unknown fields are ignored; major mismatch wins over everything after the callId. |
| `replies`     | `build` + `expectText`, or `parse` + `expect`                               | Reply envelopes: `result: null` for void methods, integers stay integers, an error carries the callId, and unknown result fields pass through.                                                           |
| `open`        | `args`                                                                      | `open`'s argument checks before anything is presented (`invalid_options`).                                                                                                                               |
| `busy`        | `open` (the open requestId or null), `requestId`, `presenter`, optional `pending` | The one-flow gate: `start`, `join` (same requestId), `busy`, `noPresenter`, or `delivered` (the requestId's result is still unacknowledged in the inbox: the open is answered with it and nothing is presented). `presenter` is `none`, `idle`, `presenting` or `detached` (not in a window); `pending` (default false) says the inbox holds a result for `requestId`. |
| `inbox`       | `files` (`name`, `modified` in seconds)                                     | `pendingResults` order: `*.json` except `*.project.json`, oldest first, ties by name; names that aren't plain ids are skipped.                                                                           |
| `acknowledge` | `requestId`                                                                 | The files `acknowledge` deletes.                                                                                                                                                                         |
| `namespace`   | `bundleId`                                                                  | PR1's namespace, `<sanitised bundle id>-local`.                                                                                                                                                          |
| `configure`   | `args`                                                                      | `configure`'s checks: `ok` or `invalid_options`.                                                                                                                                                         |

Error `message` texts are English for logs and are not pinned. A reply that fails before a callId
is known carries `callId: ""`.

## Facade rules the vectors don't pin

These are PR1 additions to native-bridge.md; the contract doesn't carry them yet.

### `pulse.ui` (Pulse JS → facade, over BrownfieldMessaging)

A seventh message beside §8.1's six. Only the container view controller can change the status bar
and swipe-to-dismiss (AD22), so Pulse JS's status-bar port and its "a take exists" state reach
native through it:

```ts
{ type: 'pulse.ui', statusBar?: 'light' | 'dark' | 'auto', statusBarHidden?: boolean, hasTake?: boolean }
```

- Every field is optional and stays as last set; unknown fields are ignored.
- `statusBar`: `light` → light text, `dark` → dark text, `auto` (or anything else) → the system
  default for the appearance. Until the first message the container shows light text over its
  dark skeleton.
- `hasTake: true` turns swipe-to-dismiss off (`isModalInPresentation`). The facade also uses the
  last value when it has to end a flow itself (below).
- No reply. A message while no flow is open is dropped.

### Results the facade writes itself, and double delivery

When `close` gets no `pulse.result` within 5 s, or the host dismisses Pulse itself, the facade
writes the result: `closed` (`reason` `host` or `interrupted`, `stage: 'recorded'`) when the last
`pulse.ui` said `hasTake` and the request names a draft (`draftId` or `draft.continue`), otherwise
`canceled` with `stage: 'none'`. `closed` needs a draftId, which the facade doesn't know for a new
recording, so a forced close of a fresh take reads `canceled` even though Pulse JS may still keep
the take.

That result is a fallback. If Pulse JS writes its own `results/<requestId>.json` later, it replaces
the facade's file and the facade emits a second `flowResult` for the same requestId (the `open`
reply has already gone with the first). Hosts treat `flowResult` as idempotent by requestId and
act on the latest; `pendingResults` always returns the file as it is now.

### `open` with a requestId whose result is still in the inbox

§3 makes `open` idempotent per requestId while the flow is open; the facade keeps that until the
host acknowledges the result. While `results/<requestId>.json` exists, `open` with that requestId
replies with that result at once and presents nothing (the `delivered` busy vectors), even if the
presenter is busy or missing. Presenting again would answer the new flow with the old file, skip
the facade's own fallback result, and let the new flow's result replace one the host hasn't seen
(AD15). To record again under the same requestId, acknowledge it first. Nothing is emitted:
`flowResult` already went out when the flow ended.

### Where PR1 differs from the contract's wording

- `logFile` with `policy.logs: 'off'` replies `not_found` ("Logs are off"). §3 lists no errors for
  `logFile`, but the d.ts says `'off'` means neither `log` events nor `logFile()`, so there is no
  file to hand out.
- `info().namespace` is PR1's real namespace, `<hostId>-local`, not `null`. The d.ts says "null
  before `setAccount` (PR2)", but PR1 has no accounts and already stores everything under that
  namespace, so the facade reports where the files are. PR2 replaces it with the account's.

## Changing them

Append cases; don't rewrite old ones (AD18: names and codes are append-only). A new contract minor
adds its methods to `methods.native` in the same change as the facade.
