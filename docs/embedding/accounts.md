# Keep each person's videos apart

Pulse keeps a separate library for each person who signs in to your app on the phone: their own
drafts, uploads, results and log. Your page says who is signed in with `setAccount()`, and Pulse
shows and sends only that person's videos. On a shared phone, the next person never sees the last
one's drafts.

## Set the account

Call `setAccount()` after `configure()`, on sign-in and whenever your page restores a session:

```ts
const { namespace } = await pulse.setAccount({
  serverOrigin: 'https://timehuddle.mieweb.org',
  userId: 'u_8Kq2fd',
  label: 'Front desk account', // optional, shown to you by listNamespaces()
});
```

- **`serverOrigin`** is your server's origin: `http` or `https`, a host name or IPv4 address, and a
  port if it isn't the default. A path is ignored. Use the same origin every time; another origin
  is another library.
- **`userId`** is your server's id for the person. It is hashed into the library's name and never
  stored in the clear.
- Until an account is set, `open`, `pendingResults` and every drafts call reject with
  `no_account`. `getInfo()`, `configure()`, `prewarm()` and `listNamespaces()` work without one.
- Setting the same account again does nothing.
- While a flow is open, `setAccount` rejects with `busy`.

## Sign out

Call `setAccount(null)`. Drafts and unfinished uploads stay on the phone, and uploads pause until
the same person signs in again.

Before a sign-out the person starts, `usage()` tells you whether they have videos that haven't
been sent (`unsent`), so you can offer to send them, keep them for next time, or delete them.

On a shared phone, delete the person's videos instead: close an open flow with
`close({ discard: true })`, then call `purge()` for the active account, then `setAccount(null)`.

> **Warning:** `purge()` deletes the account's drafts, receipts, uploads and results from the
> phone. Videos that weren't sent are gone for good.

## Switch to another person

Pulse can only switch libraries before its runtime starts in this app session. Once Pulse has
opened or answered a drafts write, `setAccount()` for a different person rejects with
`restart_required`:

- Reads (`listDrafts`, `countDrafts`, `usage`) already answer for the new person.
- `open` and drafts writes keep failing until the app restarts. Ask the person to close and reopen
  the app.
- On a shared phone, purging the previous person's library also clears it: Pulse lets go of that
  library, and the next `open` starts for the new person without a restart.

## Clean up old accounts

`listNamespaces()` lists every library on the phone: its `hostId`, `serverOrigin`, your `label`,
`bytes`, `unsent` count, `lastUsedAt` and whether it is `active`. Use it to find libraries of people
who no longer use the phone, and delete one with `purge({ namespace })`.

- A library named `<hostId>-local` comes from a PulseKit before accounts. Pulse never moves its
  drafts into an account, because on a shared phone they could belong to anyone. It is deleted
  automatically when empty; otherwise it shows in `listNamespaces()` until you purge it.
- `purge` rejects with `busy` while a flow is open.

## Where the files are

Each library lives under `Library/PulseKit/<namespace>/` in your app's container, with caches under
`Library/Caches/PulseKit/<namespace>/`. The captions models are shared by every library and deleted
with the last one. `Library/PulseKit` is excluded from device and iCloud backups, so reinstalling
the app or restoring the phone from a backup leaves no drafts behind. Pulse's files stay readable
while the phone is locked after its first unlock, so uploads can carry on in the background.
