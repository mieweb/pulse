# Configurable upload destinations (Pulse + Pulse Vault)

## Summary

Allow users to **configure upload destinations** in the Pulse app so one app can upload to multiple, separately hosted Pulse Vault servers. Users add a vault once (e.g. via a “setup your app” QR from the vault), manage destinations in the app, and at upload time choose where to send the video—including for camera-mode drafts where the draft ID is created by the app.

## Background

- **Pulse** = single mobile app (record/edit, upload).
- **Pulse Vault** = upload server anyone can host (own domain); implements TUS and provides QR/deeplinks for the app.

Today, upload is **per-draft only**: the user scans a QR from a vault that encodes a specific draft ID; that draft is tied to that server. To upload to a different vault, they must scan that vault’s QR for a (different) draft. There is no way to “save” a vault and later choose it when uploading a video whose draft was created in the app (e.g. in camera mode).

## Desired behavior

### Pulse app

- User can **add** an upload destination (e.g. by scanning a “setup your app” QR or opening a link from a Pulse Vault).
- User can **see and manage** saved destinations (list, remove). No duplicate entries for the same server.
- On the **upload screen** (e.g. after merging a video), if the user has no per-draft config for that draft:
  - If they have saved destinations, they can **choose one** from a list.
  - Upload then goes to the selected destination using the **current draft’s ID** (created by the app).
- So: camera-mode drafts (and any draft without a per-draft QR) can still be uploaded by picking a configured destination.

### Pulse Vault

- A **“Setup your app” / “Configure app”** flow on the vault’s upload page:
  - Generates a **long-lived** upload token (e.g. valid 30 days) that is **not** tied to a specific draft ID.
  - Presents a **QR code** and a **“Configure app”** button that open a deeplink the Pulse app understands.
- When the user scans/clicks, the Pulse app adds this vault as a saved destination (server + token).
- For uploads using this token, the **draft ID is sent by the app** at finalize time (e.g. the draft they just recorded in camera mode). The vault backend must accept a token without a draft ID and use the client-supplied draft ID as the video ID when finalizing.

## Acceptance criteria

### Pulse

- [ ] New deeplink (e.g. `mode=configure_destination`) is handled when app is opened (cold start, background, foreground); app adds the destination and navigates to the destinations screen with feedback (e.g. “Destination added”).
- [ ] Destinations screen (e.g. “Upload” tab): list all saved destinations (name/server, expiry if available), remove with confirmation, no duplicates by server.
- [ ] Upload screen: when draft has no per-draft config but user has saved destinations, show a destination picker; user selects one and taps Upload; upload succeeds to selected vault using current draft ID.
- [ ] Tab bar: destinations screen is reachable (e.g. “Upload” tab with appropriate icon).

### Pulse Vault

- [ ] New endpoint (e.g. `/qr/configure-destination`) that returns a long-lived token (no draft ID) and a deeplink URL for the Pulse app (and optionally QR payload).
- [ ] Finalize endpoint accepts uploads where the token has no draft ID: in that case, `draftId` must be provided in the request body and is used as the video ID.
- [ ] Upload page includes a “Setup your app” section: generate configure-destination deeplink, show QR, and “Configure app” button that opens the deeplink.

## Technical notes

- **Destination token**: Token payload has no `draftId`; app sends `draftId` in the finalize request body when using a saved destination.
- **No duplicates**: Destinations are deduped by normalized server URL (e.g. same host = update existing entry).
- **Existing flow unchanged**: Per-draft QR (draft ID in token, in deeplink) continues to work as today; this adds a second path (saved destination + app-supplied draft ID).

## Scope

- **Pulse**: deeplink handling, destinations storage, destinations UI (list/remove), upload-screen destination picker, TUS finalize with optional client `draftId`.
- **Pulse Vault**: configure-destination endpoint, finalize with body `draftId`, frontend “Setup your app” QR + button.
