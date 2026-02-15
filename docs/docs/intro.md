---
slug: /
sidebar_position: 1
---

# Getting Started

**Pulse Cam** is a mobile video capture app built for institutional knowledge sharing. Developers can integrate Pulse Cam into their own applications to let users **record**, **edit**, and **upload** short-form video content — without building a camera or upload pipeline from scratch.

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
| [**PulseVault**](./uploads/pulsevault) | TUS + managed server | Turnkey solution — deploy PulseVault and go |
| [**TUS**](./uploads/tus) | TUS 1.0.0 | Resumable uploads to your own TUS-compatible server |
| [**Chunked**](./uploads/chunked) | multipart/form-data or application/octet-stream | Custom servers without TUS support |

## Choose Your Framework

| Framework | Guide |
|-----------|-------|
| Vanilla JavaScript | [JavaScript Guide](./frameworks/javascript) |
| React with `@mieweb/ui` | [React `@mieweb/ui` Guide](./frameworks/react-mieweb-ui) |

## Requirements

- **Pulse Cam** installed on the user's device (iOS or Android)
- A server that accepts video uploads via one of the supported protocols
- Ability to generate UUID v4 identifiers and authentication tokens
