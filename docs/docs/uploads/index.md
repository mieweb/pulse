---
sidebar_position: 1
---

# Handling Uploads

After a user records and edits a video in Pulse Cam, the app uploads the merged video to the server URL specified in the deep link. This section covers the three supported upload strategies.

## Upload Flow Overview

```
┌─────────────┐                        ┌──────────────┐
│  Pulse Cam   │   1. POST /uploads     │  Your Server │
│  (merged     │ ─────────────────────▶ │              │
│   video)     │   ◀── Location header  │  (creates    │
│              │                        │   session)   │
│              │   2. PATCH /uploads/id  │              │
│              │ ─────────────────────▶ │  (receives   │
│              │   (1MB chunks)         │   chunks)    │
│              │                        │              │
│              │   3. POST /uploads/    │              │
│              │      finalize          │              │
│              │ ─────────────────────▶ │  (assembles  │
│              │                        │   video)     │
└─────────────┘                        └──────────────┘
```

## How Pulse Cam Uploads

Regardless of which strategy you choose, Pulse Cam always sends the upload to the `server` URL from the deep link. The `token` is sent during finalization for authentication.

### Default Protocol: TUS 1.0.0

By default, Pulse Cam uses the [TUS resumable upload protocol](https://tus.io/protocols/resumable-upload) (v1.0.0):

1. **Create session** — `POST /uploads` with `Upload-Length` header → server returns `Location` header with upload URL
2. **Upload chunks** — `PATCH` requests with `application/offset+octet-stream` body, 1 MB per chunk, with `Upload-Offset` header
3. **Finalize** — `POST /uploads/finalize` with JSON body containing `uploadId`, `filename`, and `uploadToken`

### Authentication

The `token` from the deep link is sent in two places during finalization:

- **Header:** `X-Upload-Token: <token>`
- **Body:** `{ "uploadToken": "<token>" }`

Your server should validate this token to ensure the upload is authorized.

## Strategies

| Strategy | Description | When to Use |
|----------|-------------|-------------|
| [**PulseVault**](./pulsevault) | Pre-built upload server with TUS support, Docker deployment | You want a turnkey upload solution |
| [**TUS**](./tus) | Implement TUS 1.0.0 endpoints on your own server | You want resumable uploads with your own infrastructure |
| [**Chunked**](./chunked) | Accept multipart/form-data or raw binary chunks | You have an existing upload API or can't use TUS |

:::tip
If you're starting from scratch, **PulseVault** is the fastest path. If you have an existing backend, implementing the **TUS** endpoints is straightforward (3 routes). If you need maximum flexibility, the **chunked** approach lets you adapt to any API.
:::

## Next steps

- **Turnkey server** → [PulseVault](./pulsevault) (Docker, `/qr/deeplink`, Proxmox/Nginx).
- **Your own TUS server** → [TUS Resumable Uploads](./tus) (3 endpoints, headers, examples).
- **Non-TUS or custom API** → [Chunked Uploads](./chunked) (multipart or binary facade).
- **Stuck?** → [Troubleshooting](../troubleshooting) (connection, token, chunk errors).
