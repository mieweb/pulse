---
sidebar_position: 2
---

# TUS Resumable Uploads

Pulse Cam uses the [TUS 1.0.0](https://tus.io/protocols/resumable-upload) protocol to upload videos. If you want to receive uploads on your own server (instead of PulseVault), you need to implement three HTTP endpoints.

## Protocol Summary

```
Pulse Cam                                   Your Server
    │                                            │
    │  POST /uploads                             │
    │  Upload-Length: 5242880                     │
    │  Tus-Resumable: 1.0.0                      │
    │ ──────────────────────────────────────────▶│
    │                                            │
    │  201 Created                               │
    │  Location: /uploads/abc-123                │
    │ ◀──────────────────────────────────────────│
    │                                            │
    │  PATCH /uploads/abc-123                    │
    │  Upload-Offset: 0                          │
    │  Content-Type: application/offset+octet-stream
    │  Tus-Resumable: 1.0.0                      │
    │  [1MB binary body]                         │
    │ ──────────────────────────────────────────▶│
    │                                            │
    │  204 No Content                            │
    │  Upload-Offset: 1048576                    │
    │ ◀──────────────────────────────────────────│
    │                                            │
    │  ... (repeat PATCH for each 1MB chunk) ... │
    │                                            │
    │  POST /uploads/finalize                    │
    │  X-Upload-Token: <token>                   │
    │  { uploadId, filename, uploadToken }       │
    │ ──────────────────────────────────────────▶│
    │                                            │
    │  200 OK                                    │
    │  { videoId, status, size, checksum }       │
    │ ◀──────────────────────────────────────────│
```

## Endpoints to Implement

### 1. Create Upload Session

```
POST /uploads
```

**Request Headers:**

| Header | Value |
|--------|-------|
| `Upload-Length` | Total file size in bytes |
| `Tus-Resumable` | `1.0.0` |

**Response:**

- **Status:** `201 Created`
- **Headers:**
  - `Location` — URL for subsequent PATCH requests (e.g. `/uploads/abc-123` or absolute URL)

**Your server should:**
- Generate a unique upload ID
- Allocate storage for receiving chunks
- Return the upload URL via `Location` header

```js
// Express example
app.post("/uploads", (req, res) => {
  const uploadId = crypto.randomUUID();
  const totalSize = parseInt(req.headers["upload-length"], 10);

  // Store session metadata
  uploads.set(uploadId, {
    totalSize,
    receivedBytes: 0,
    chunks: [],
    createdAt: new Date(),
  });

  res.status(201)
    .header("Location", `/uploads/${uploadId}`)
    .header("Tus-Resumable", "1.0.0")
    .end();
});
```

### 2. Upload Chunk

```
PATCH /uploads/:id
```

**Request Headers:**

| Header | Value |
|--------|-------|
| `Upload-Offset` | Byte offset of this chunk (starts at `0`) |
| `Content-Type` | `application/offset+octet-stream` |
| `Tus-Resumable` | `1.0.0` |

**Request Body:** Raw binary data (1 MB per chunk).

**Response:**

- **Status:** `204 No Content`
- **Headers:**
  - `Upload-Offset` — New byte offset after this chunk

```js
app.patch("/uploads/:id", (req, res) => {
  const upload = uploads.get(req.params.id);
  if (!upload) return res.status(404).end();

  const offset = parseInt(req.headers["upload-offset"], 10);
  if (offset !== upload.receivedBytes) {
    return res.status(409).json({ error: "Offset mismatch" });
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const data = Buffer.concat(chunks);
    upload.chunks.push(data);
    upload.receivedBytes += data.length;

    res.status(204)
      .header("Upload-Offset", upload.receivedBytes.toString())
      .header("Tus-Resumable", "1.0.0")
      .end();
  });
});
```

### 3. Finalize Upload

```
POST /uploads/finalize
```

**Request Headers:**

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `X-Upload-Token` | Auth token from the deep link |

**Request Body:**

```json
{
  "uploadId": "abc-123",
  "filename": "draft-f47ac10b-58cc-4372-a567-0e02b2c3d479.mp4",
  "userId": "anonymous",
  "uploadToken": "<token>"
}
```

**Response:**

```json
{
  "videoId": "abc-123",
  "status": "complete",
  "size": 5242880,
  "checksum": "sha256:e3b0c44298..."
}
```

```js
app.post("/uploads/finalize", async (req, res) => {
  const { uploadId, filename, uploadToken } = req.body;

  // Validate token
  const token = req.headers["x-upload-token"] || uploadToken;
  if (!verifyToken(token)) {
    return res.status(401).json({ error: "Invalid token" });
  }

  const upload = uploads.get(uploadId);
  if (!upload) return res.status(404).json({ error: "Upload not found" });

  // Assemble final file
  const finalBuffer = Buffer.concat(upload.chunks);
  const outputPath = path.join(UPLOAD_DIR, filename);
  await fs.writeFile(outputPath, finalBuffer);

  // Calculate checksum
  const hash = crypto.createHash("sha256").update(finalBuffer).digest("hex");

  // Cleanup
  uploads.delete(uploadId);

  res.json({
    videoId: uploadId,
    status: "complete",
    size: finalBuffer.length,
    checksum: `sha256:${hash}`,
  });
});
```

## Complete Server Example

```js
const express = require("express");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const app = express();
const uploads = new Map();
const UPLOAD_DIR = "./uploads";

// Ensure upload directory exists
fs.mkdir(UPLOAD_DIR, { recursive: true });

// TUS: Create session
app.post("/uploads", (req, res) => {
  const uploadId = crypto.randomUUID();
  const totalSize = parseInt(req.headers["upload-length"], 10);

  uploads.set(uploadId, {
    totalSize,
    receivedBytes: 0,
    chunks: [],
  });

  res.status(201)
    .header("Location", `/uploads/${uploadId}`)
    .header("Tus-Resumable", "1.0.0")
    .end();
});

// TUS: Receive chunk
app.patch("/uploads/:id", (req, res) => {
  const upload = uploads.get(req.params.id);
  if (!upload) return res.status(404).end();

  const offset = parseInt(req.headers["upload-offset"], 10);
  if (offset !== upload.receivedBytes) {
    return res.status(409).json({ error: "Offset mismatch" });
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const data = Buffer.concat(chunks);
    upload.chunks.push(data);
    upload.receivedBytes += data.length;

    res.status(204)
      .header("Upload-Offset", upload.receivedBytes.toString())
      .header("Tus-Resumable", "1.0.0")
      .end();
  });
});

// TUS: Resume support
app.head("/uploads/:id", (req, res) => {
  const upload = uploads.get(req.params.id);
  if (!upload) return res.status(404).end();

  res.status(200)
    .header("Upload-Offset", upload.receivedBytes.toString())
    .header("Upload-Length", upload.totalSize.toString())
    .header("Tus-Resumable", "1.0.0")
    .end();
});

// Finalize
app.post("/uploads/finalize", express.json(), async (req, res) => {
  const { uploadId, filename, uploadToken } = req.body;
  const token = req.headers["x-upload-token"] || uploadToken;

  // TODO: Validate token against your auth system

  const upload = uploads.get(uploadId);
  if (!upload) return res.status(404).json({ error: "Upload not found" });

  const finalBuffer = Buffer.concat(upload.chunks);
  const outputPath = path.join(UPLOAD_DIR, filename);
  await fs.writeFile(outputPath, finalBuffer);

  const hash = crypto.createHash("sha256").update(finalBuffer).digest("hex");
  uploads.delete(uploadId);

  res.json({
    videoId: uploadId,
    status: "complete",
    size: finalBuffer.length,
    checksum: `sha256:${hash}`,
  });
});

// Health check
app.get("/health", (req, res) => res.json({ status: "OK" }));

app.listen(8080, "0.0.0.0", () => {
  console.log("TUS upload server running on :8080");
});
```

## Chunk Behavior

- **Chunk size:** 1 MB (1,048,576 bytes)
- **Retry policy:** Each chunk is retried up to 3 times with a 1-second delay between attempts
- **Content type:** `application/offset+octet-stream`
- **Offset tracking:** The server's `Upload-Offset` response header drives the next chunk's offset

## CORS Headers

If your web application needs to poll or interact with the upload server, add CORS headers:

```js
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, HEAD, OPTIONS");
  res.header("Access-Control-Allow-Headers",
    "Content-Type, Upload-Length, Upload-Offset, Tus-Resumable, X-Upload-Token");
  res.header("Access-Control-Expose-Headers",
    "Location, Upload-Offset, Upload-Length, Tus-Resumable");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
```

## HTTPS / SSL Termination

If your server is behind a reverse proxy (e.g. nginx, Caddy) that terminates SSL, Pulse Cam will automatically upgrade `http://` Location headers to `https://` when the original server URL uses HTTPS. No special configuration is needed on the app side.
