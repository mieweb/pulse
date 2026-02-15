---
sidebar_position: 3
---

# Chunked Uploads

If your server doesn't support the TUS protocol, you can implement a **chunked upload** endpoint that accepts video data as `multipart/form-data` or raw binary (`application/octet-stream`). This approach wraps the TUS endpoints with a simpler interface while maintaining the same three-step flow.

:::info
Pulse Cam natively speaks TUS. To use chunked uploads instead, you implement a **TUS-compatible facade** — the same three endpoints (`POST /uploads`, `PATCH /uploads/:id`, `POST /uploads/finalize`) but your server internally handles the data however you like.
:::

## Option A: `multipart/form-data` Chunks

Accept each chunk as a form file upload. This is the simplest approach if your backend already handles multipart uploads (e.g. via multer, Django, Rails).

### Server Implementation (Node.js + multer)

```js
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const app = express();
const UPLOAD_DIR = "./uploads";
const sessions = new Map();

fs.mkdir(UPLOAD_DIR, { recursive: true });

// Multer configured for chunk storage
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 } });

// 1. Create session — same as TUS
app.post("/uploads", express.json(), (req, res) => {
  const sessionId = crypto.randomUUID();
  const totalSize = parseInt(req.headers["upload-length"], 10);

  sessions.set(sessionId, {
    totalSize,
    receivedBytes: 0,
    filePath: path.join(UPLOAD_DIR, `${sessionId}.partial`),
  });

  // Create empty file
  fs.writeFile(path.join(UPLOAD_DIR, `${sessionId}.partial`), Buffer.alloc(0));

  res.status(201)
    .header("Location", `/uploads/${sessionId}`)
    .header("Tus-Resumable", "1.0.0")
    .end();
});

// 2. Receive chunk as multipart/form-data
//    Pulse Cam sends application/offset+octet-stream by default, so this
//    endpoint handles BOTH content types.
app.patch("/uploads/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const offset = parseInt(req.headers["upload-offset"], 10);
  if (offset !== session.receivedBytes) {
    return res.status(409).json({ error: "Offset mismatch" });
  }

  const contentType = req.headers["content-type"] || "";

  if (contentType.includes("multipart/form-data")) {
    // Handle multipart/form-data
    upload.single("chunk")(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });

      const chunkData = req.file.buffer;
      await fs.appendFile(session.filePath, chunkData);
      session.receivedBytes += chunkData.length;

      res.status(204)
        .header("Upload-Offset", session.receivedBytes.toString())
        .header("Tus-Resumable", "1.0.0")
        .end();
    });
  } else {
    // Handle application/offset+octet-stream (TUS default)
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const data = Buffer.concat(chunks);
      await fs.appendFile(session.filePath, data);
      session.receivedBytes += data.length;

      res.status(204)
        .header("Upload-Offset", session.receivedBytes.toString())
        .header("Tus-Resumable", "1.0.0")
        .end();
    });
  }
});

// 3. Finalize
app.post("/uploads/finalize", express.json(), async (req, res) => {
  const { uploadId, filename, uploadToken } = req.body;
  const token = req.headers["x-upload-token"] || uploadToken;

  // TODO: Validate token
  const session = sessions.get(uploadId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  // Rename partial file to final filename
  const finalPath = path.join(UPLOAD_DIR, filename);
  await fs.rename(session.filePath, finalPath);

  const stat = await fs.stat(finalPath);
  const fileBuffer = await fs.readFile(finalPath);
  const hash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

  sessions.delete(uploadId);

  res.json({
    videoId: uploadId,
    status: "complete",
    size: stat.size,
    checksum: `sha256:${hash}`,
  });
});

app.get("/health", (req, res) => res.json({ status: "OK" }));

app.listen(8080, () => console.log("Chunked upload server on :8080"));
```

## Option B: Direct Binary Transfer (`application/octet-stream`)

This is the most minimal approach — each chunk is the raw body with no multipart wrapping. This is actually what Pulse Cam sends by default (`application/offset+octet-stream` per TUS spec), so **this is the native format**.

### Server Implementation (Node.js)

```js
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");

const app = express();
const UPLOAD_DIR = "./uploads";
const sessions = new Map();

fsPromises.mkdir(UPLOAD_DIR, { recursive: true });

app.post("/uploads", (req, res) => {
  const sessionId = crypto.randomUUID();
  const totalSize = parseInt(req.headers["upload-length"], 10);
  const filePath = path.join(UPLOAD_DIR, `${sessionId}.partial`);

  sessions.set(sessionId, { totalSize, receivedBytes: 0, filePath });
  fs.writeFileSync(filePath, Buffer.alloc(0));

  res.status(201)
    .header("Location", `/uploads/${sessionId}`)
    .header("Tus-Resumable", "1.0.0")
    .end();
});

app.patch("/uploads/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).end();

  const offset = parseInt(req.headers["upload-offset"], 10);
  if (offset !== session.receivedBytes) {
    return res.status(409).json({ error: "Offset mismatch" });
  }

  // Stream raw binary body directly to disk
  const writeStream = fs.createWriteStream(session.filePath, { flags: "a" });

  req.pipe(writeStream);

  writeStream.on("finish", () => {
    const written = writeStream.bytesWritten;
    session.receivedBytes += written;

    res.status(204)
      .header("Upload-Offset", session.receivedBytes.toString())
      .header("Tus-Resumable", "1.0.0")
      .end();
  });

  writeStream.on("error", (err) => {
    console.error("Write error:", err);
    res.status(500).json({ error: "Failed to write chunk" });
  });
});

app.post("/uploads/finalize", express.json(), async (req, res) => {
  const { uploadId, filename, uploadToken } = req.body;
  const token = req.headers["x-upload-token"] || uploadToken;

  // TODO: Validate token

  const session = sessions.get(uploadId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const finalPath = path.join(UPLOAD_DIR, filename);
  await fsPromises.rename(session.filePath, finalPath);

  const stat = await fsPromises.stat(finalPath);
  const fileBuffer = await fsPromises.readFile(finalPath);
  const hash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

  sessions.delete(uploadId);

  res.json({
    videoId: uploadId,
    status: "complete",
    size: stat.size,
    checksum: `sha256:${hash}`,
  });
});

app.get("/health", (req, res) => res.json({ status: "OK" }));
app.listen(8080, () => console.log("Binary upload server on :8080"));
```

## Comparison

| Aspect | `multipart/form-data` | `application/octet-stream` |
|--------|-----------------------|----------------------------|
| **Content-Type** | `multipart/form-data` | `application/offset+octet-stream` |
| **Body format** | Encoded with boundary | Raw binary |
| **Overhead** | Slight — multipart headers per chunk | Minimal — raw bytes |
| **Server dependencies** | Needs multipart parser (e.g. multer) | No extra dependencies |
| **Native to Pulse Cam** | No — needs adapter | Yes — default TUS format |
| **Best for** | Servers already handling file form uploads | New servers, minimal setups |

:::tip
Since Pulse Cam sends `application/offset+octet-stream` by default, **Option B** (direct binary) is the path of least resistance — you don't need to convert or wrap anything. Option A is useful when you have middleware that already handles multipart uploads.
:::

## Chunk Details

| Property | Value |
|----------|-------|
| Chunk size | 1 MB (1,048,576 bytes) |
| Final chunk | May be smaller than 1 MB |
| Retry | 3 attempts per chunk, 1 second delay |
| Ordering | Sequential — `Upload-Offset` must match server state |

## Adapting an Existing API

If your existing API expects a different endpoint structure, you can create a thin adapter:

```js
// Adapter: map TUS endpoints to your existing upload API
app.post("/uploads", async (req, res) => {
  // Call your existing API to create an upload session
  const session = await yourApi.createUploadSession({
    size: parseInt(req.headers["upload-length"], 10),
  });

  res.status(201)
    .header("Location", `/uploads/${session.id}`)
    .header("Tus-Resumable", "1.0.0")
    .end();
});

app.patch("/uploads/:id", async (req, res) => {
  // Collect raw body, then call your existing chunk upload API
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const data = Buffer.concat(chunks);

    const result = await yourApi.uploadChunk(req.params.id, data, {
      offset: parseInt(req.headers["upload-offset"], 10),
    });

    res.status(204)
      .header("Upload-Offset", result.newOffset.toString())
      .header("Tus-Resumable", "1.0.0")
      .end();
  });
});

app.post("/uploads/finalize", express.json(), async (req, res) => {
  const result = await yourApi.finalizeUpload(req.body.uploadId, {
    filename: req.body.filename,
    token: req.headers["x-upload-token"],
  });

  res.json(result);
});
```
