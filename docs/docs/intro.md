---
slug: /
sidebar_position: 1
---

# Getting Started

**Pulse Cam** is a mobile video capture app for institutional knowledge sharing. Integrate it into your app so users can **record**, **edit**, and **upload** short-form video — without you building a camera or upload pipeline.

## Quick path

1. **Pick an upload strategy** — [PulseVault](./uploads/pulsevault) (turnkey), [TUS](./uploads/tus) (your server), or [Chunked](./uploads/chunked) (custom API).
2. **Generate a deep link** — Your backend creates a `pulsecam://` URL with `draftId`, `server`, and `token`. See [Launching Pulse Cam](./launching).
3. **Show the link or a QR code** — User opens it on their phone; Pulse Cam opens in upload mode and sends the video to your server.

New to the stack? Read **How it works** and **Deep link format** below, then follow [Launching](./launching) and your chosen upload guide. Hit a snag? See [Troubleshooting](./troubleshooting).

## How It Works

```
┌─────────────────┐     deep link      ┌─────────────┐     upload    ┌──────────────┐
│  Your App / Web │ ──────────────────▶│  Pulse Cam  │ ─────────────▶│  Your Server │
│                 │  pulsecam://...    │  (Record &  │  TUS / Chunk  │  (PulseVault │
│                 │                    │   Edit)     │               │   or custom) │
└─────────────────┘                    └─────────────┘               └──────────────┘
```

1. **Your application generates a deep link** with a `draftId`, upload server URL, and auth token.
2. **Pulse Cam opens** in upload mode — the user records and edits video segments.
3. **When the user taps Upload**, Pulse Cam sends the merged video to your server using the protocol you implement (TUS resumable uploads, chunked binary uploads, or via PulseVault).

## Integration Overview

| Step | What you build | What Pulse Cam does |
|------|---------------|-------------------|
| **1. Launch** | Generate a `pulsecam://` deep link | Opens in upload mode with your config |
| **2. Record** | Nothing — Pulse Cam handles it | User records, trims, reorders segments |
| **3. Upload** | Implement an upload endpoint | Sends merged video to your server |

## Deep Link Format

```
pulsecam://?mode=upload&draftId=<uuid>&server=<url>&token=<token>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | string | Yes | Must be `"upload"` |
| `draftId` | UUID v4 | Yes | Unique identifier for this recording session |
| `server` | URL | Yes | Base URL of your upload server |
| `token` | string | Yes | Authentication token for upload authorization |

:::info
All four parameters are required. If `draftId` is missing or not a valid UUID v4, Pulse Cam will display a "Server not set up for upload" error.
:::

## Choose Your Upload Strategy

| Strategy | Protocol | Best For |
|----------|----------|----------|
| [**PulseVault**](./uploads/pulsevault) | TUS + managed server | Turnkey — deploy and go; includes Nginx, Proxmox/LXC notes |
| [**TUS**](./uploads/tus) | TUS 1.0.0 | Resumable uploads on your own server (3 endpoints) |
| [**Chunked**](./uploads/chunked) | multipart or raw binary | Existing upload API; TUS-compatible facade |

## Choose Your Framework

| Framework | Guide |
|-----------|-------|
| Vanilla JavaScript | [JavaScript Guide](./frameworks/javascript) |
| React with `@mieweb/ui` | [React `@mieweb/ui` Guide](./frameworks/react-mieweb-ui) |

## Requirements

- **Pulse Cam** installed on the user's device (iOS or Android) — distributed via App Store, Play Store, or your organization
- A server that accepts video uploads via one of the supported protocols (e.g. [PulseVault](./uploads/pulsevault))
- Ability to generate UUID v4 identifiers and authentication tokens

## Security and production

- **HTTPS:** Use HTTPS for the upload server URL in production so the token and video are not sent over plain HTTP.
- **Token expiry:** Issue short-lived tokens (e.g. 24 hours). PulseVault and the examples use expiring tokens; your custom backend should too.
- **Validate on finalize:** Your server must validate the token on `POST /uploads/finalize` and associate the upload with the correct user or session.

For deployment (Proxmox, Nginx, SSL), see [PulseVault — Deployment](./uploads/pulsevault#deployment). For common errors, see [Troubleshooting](./troubleshooting).

## Terms you'll see

| Term | Meaning |
|------|---------|
| **draftId** | A UUID v4 you generate for each recording session; ties the upload to your system. |
| **Deep link** | A `pulsecam://` URL that opens Pulse Cam in upload mode with your `server` and `token`. |
| **TUS** | Resumable upload protocol (1.0.0) used by Pulse Cam: `POST /uploads`, `PATCH /uploads/:id`, `POST /uploads/finalize`. |
| **PulseVault** | Reference upload server (Docker, Nginx, `/qr/deeplink` API); use it as-is or implement TUS yourself. |

## Next steps

- **First time?** → [Launching Pulse Cam](./launching) (deep link format, QR workflow, testing).
- **Using PulseVault?** → [PulseVault](./uploads/pulsevault) (deploy, `/qr/deeplink`, Proxmox/Nginx).
- **Building your own server?** → [TUS](./uploads/tus) or [Chunked](./uploads/chunked).
- **Web integration?** → [JavaScript](./frameworks/javascript) or [React @mieweb/ui](./frameworks/react-mieweb-ui).
- **Something broken?** → [Troubleshooting](./troubleshooting).
