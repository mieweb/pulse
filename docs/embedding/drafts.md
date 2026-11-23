# Show and manage drafts from your app

Pulse has no drafts screen inside your app. Your own screens list the person's drafts for a place,
show their upload state, and rename, move, send or delete them. Reads come from a file Pulse keeps
current, so they don't open Pulse or start it: a list renders as fast as a local file read.

**Before you start:** `configure()` and `setAccount()` on the page ([README.md](README.md)). Every
call on this page rejects with `no_account` without an account.

## Read drafts

```ts
import { getPulse } from '@mieweb/pulse-embed';

const pulse = getPulse();

const forTicket = await pulse.listDrafts({ contextKey: 'ticket:th-482' });
const allTickets = await pulse.listDrafts({ contextKeyPrefix: 'ticket:' });
const sentThisWeek = await pulse.listDrafts({ states: ['sent'] });
const one = await pulse.getDraft(draftId); // null when it doesn't exist
```

- **Default filter:** every state except `'sent'`, newest change first. Pass `states` to choose;
  include `'sent'` to get receipts of sent videos (kept 7 days, without the video).
- **Each row** is a `DraftSummary`: `name` (never empty), `context` (the place you recorded it for,
  as you passed it), `state`, `clipCount`, `durationMs`, `poster` (an image your WebView can load),
  `upload` while it has an upload, `sent` for a receipt. [contract.md](contract.md) lists every
  field.
- **`poster.webUrl` and `export.webUrl`** stay valid until the next `draftsChanged` naming the
  draft. Load them in an `<img>` or `<video>`; don't write to them.

## Count drafts

```ts
const perTicket = await pulse.countDrafts({ by: 'contextKey' }); // { 'ticket:th-482': 2, ... }
const needsYou = await pulse.countDrafts({ by: 'contextKind', attentionOnly: true }); // { ticket: 1 }
```

- Counts leave out `'sent'` unless you pass `states`.
- `attentionOnly` counts what needs the person: failed uploads, and `kept` receipts not yet
  dismissed. Use it for a badge.
- Drafts without a place (made before your app set one) aren't counted.

`usage()` gives the totals for the signed-in account: bytes on the phone, drafts, unsent, uploading,
failed and receipts. Use `unsent` for "3 videos haven't been sent" at sign-out.

## Keep the list current

Subscribe to `draftsChanged`. It names the drafts that changed, after Pulse has written the new
state, so a read in the handler sees the change:

```ts
pulse.on('draftsChanged', ({ ids }) => {
  if (ids.some((id) => shown.has(id))) void refresh();
});
```

- `uploadProgress` (`{ draftId, fraction, bytesSent, bytesTotal }`) comes up to 4 times a second
  per draft while it uploads.
- In React, `useDrafts(filter)`, `useDraft(id)` and `useDraftCounts(options)` from
  `@mieweb/pulse-embed/react` re-read on both events. Each returns `{ data, loading, error,
refresh }`.

## Change a draft

| Call                           | Does                                                                        | Rejects with                                                          |
| ------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `renameDraft(id, name)`        | Sets the name the video is sent with.                                       | `not_found`, `draft.locked`                                           |
| `setDraftContext(id, context)` | Move to…: the draft now belongs to another place.                           | `not_found`, `draft.locked`                                           |
| `deleteDraft(id)`              | Deletes the draft and its clips from the phone.                             | `not_found`, `draft.locked`                                           |
| `upload(id)`                   | Send from your list: merges the clips if needed, then queues the upload.    | `not_found`, `draft.locked`, `upload.too_large`, `host_misconfigured` |
| `cancelUpload(id)`             | Takes a queued, uploading, paused or failed upload back to a draft.         | `not_found`, `draft.locked` (preparing or delivering)                 |
| `retireDraft(id)`              | File mode: deletes a draft whose MP4 you uploaded. Pulse mode: a hint only. | `not_found`                                                           |
| `dismissReceipt(id)`           | Stops a `kept` receipt counting for attention.                              | `not_found`                                                           |

> **Warning:** `deleteDraft` can't be undone; the video exists nowhere else. To offer Undo, hide
> the row for a few seconds and call `deleteDraft` only when the time is up.

- **Locked drafts.** While a draft is `preparing`, `uploading` or `delivering`, or open in the
  current flow, rename, move and delete reject with `draft.locked`. A `sent` row is a receipt, not
  a draft: those calls reject with `not_found`. A draft whose Send was confirmed by
  your server (a [`confirmSend`](uploads.md#types-with-confirmsend) type) can't be moved:
  `setDraftContext` rejects with `draft.locked` and `error.reason` `'clock_bound'`.
- **A waiting upload is canceled first.** Renaming, moving or deleting a draft that is `queued`,
  `needs_credentials` or `failed` cancels its upload; send it again afterwards.
- **`upload(id)` resolves once the upload is queued**, with `{ clientKey, draftKey, sentAt }`, not
  when it has finished. It needs `uploadMode: 'pulse'` (in `'file'` mode it rejects with
  `host_misconfigured`) and your [host services](uploads.md). Calling it again while the upload
  is `queued` or `needs_credentials` answers with the same keys and queues nothing; once it is
  `preparing`, `uploading` or `delivering`, it rejects with `draft.locked`.
- **What `upload(id)` checks.** The upload type's `maxBytes` (`upload.too_large`) and its
  `confirmSend`, which it asks your server for as Export does. `requireName` and `requireOnline`
  are Export's checks: check them in your own screen before you offer Send.
- **These calls run in Pulse.** When Pulse isn't running, a build without the `headless`
  capability shows a brief "Preparing…" screen until the call is answered
  ([uploads.md](uploads.md#paused-uploads)). Each waits up to 30 s, the start included, then
  rejects with `timeout`; `createPulseClient({ timeoutMs })` changes that. A `timeout` doesn't
  mean the change didn't happen: read the draft with `getDraft(id)` instead of retrying. After an
  `upload(id)` timeout the draft is usually `uploading` already, and a second `upload(id)` would
  reject with `draft.locked`.

## Open a draft in Pulse

- `pulse.edit(draftId)` opens the editor; `pulse.exportDraft(draftId)` opens Export.
- `pulse.record(context, { draft: { continue: draftId } })` opens the recorder on an unsent draft,
  for "Continue 'Fix login' (0:42) / New video".

## A library a newer PulseKit wrote

If your app goes back to an older PulseKit after a newer one opened the library, Pulse can still
list, send and delete, but anything that creates or edits a draft rejects with
`storage.newer_schema`. Ask the person to update the app.
