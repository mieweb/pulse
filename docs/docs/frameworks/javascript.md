---
sidebar_position: 1
---

# JavaScript Integration

This guide shows how to integrate Pulse Cam into a web application using vanilla JavaScript — no frameworks or npm packages required.

## End-to-End Flow

```
┌──────────────────────────────────────────────────────────┐
│  Your Web App (JavaScript)                               │
│                                                          │
│  1. Call backend → get draftId + token                   │
│  2. Build deep link URL                                  │
│  3. Show QR code or "Open in Pulse Cam" button           │
│  4. (Optional) Poll server for upload completion         │
└──────────────────────────────────────────────────────────┘
        │                              ▲
        │ deep link                    │ upload complete
        ▼                              │
┌──────────────────┐           ┌──────────────────┐
│  Pulse Cam       │──────────▶│  Your Upload     │
│  (record & edit) │   TUS     │  Server          │
└──────────────────┘           └──────────────────┘
```

## Step 1: Create a Recording Session (Backend)

Your backend generates a `draftId` and `token`, then returns the deep link:

```js
// server.js (Express)
const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const app = express();
const UPLOAD_SERVER = process.env.UPLOAD_SERVER || "https://vault.example.com";
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

app.post("/api/pulse/session", (req, res) => {
  const userId = req.user?.id || "anonymous";
  const draftId = crypto.randomUUID();

  const token = jwt.sign(
    { userId, draftId, purpose: "pulse-upload" },
    JWT_SECRET,
    { expiresIn: "24h" }
  );

  const params = new URLSearchParams({
    mode: "upload",
    draftId,
    server: UPLOAD_SERVER,
    token,
  });

  const deeplink = `pulsecam://?${params.toString()}`;

  res.json({ deeplink, draftId, token });
});
```

## Step 2: Display the Deep Link (Frontend)

### Option A: QR Code

Best for desktop → mobile workflows (kiosk, admin dashboard, etc.):

```html
<!DOCTYPE html>
<html>
<head>
  <title>Record with Pulse Cam</title>
  <script src="https://cdn.jsdelivr.net/npm/qrcode@1/build/qrcode.min.js"></script>
</head>
<body>
  <h2>Scan to Record</h2>
  <canvas id="qr-canvas"></canvas>
  <p id="status">Generating QR code...</p>

  <script>
    async function createSession() {
      const res = await fetch("/api/pulse/session", { method: "POST" });
      const { deeplink, draftId } = await res.json();

      // Render QR code
      QRCode.toCanvas(document.getElementById("qr-canvas"), deeplink, {
        width: 300,
        margin: 2,
      });

      document.getElementById("status").textContent = "Scan with your phone";

      // Optional: poll for upload completion
      pollForCompletion(draftId);
    }

    async function pollForCompletion(draftId) {
      const interval = setInterval(async () => {
        try {
          const res = await fetch(`/api/pulse/status/${draftId}`);
          const { status } = await res.json();

          if (status === "complete") {
            clearInterval(interval);
            document.getElementById("status").textContent =
              "✅ Video uploaded successfully!";
          }
        } catch (e) {
          // Server not ready yet, keep polling
        }
      }, 3000);
    }

    createSession();
  </script>
</body>
</html>
```

### Option B: Direct Link Button

Best for mobile web — the user's phone opens Pulse Cam directly:

```html
<button id="record-btn" disabled>Open Pulse Cam</button>

<script>
  let deeplink = null;

  async function init() {
    const res = await fetch("/api/pulse/session", { method: "POST" });
    const data = await res.json();
    deeplink = data.deeplink;

    const btn = document.getElementById("record-btn");
    btn.disabled = false;
    btn.onclick = () => {
      window.location.href = deeplink;
    };
  }

  init();
</script>
```

### Option C: Iframe Fallback

If the app isn't installed, you may want to redirect to the App Store:

```js
function openPulseCam(deeplink) {
  const start = Date.now();

  // Try the deep link
  window.location.href = deeplink;

  // If still here after 1.5s, app probably isn't installed
  setTimeout(() => {
    if (Date.now() - start < 2000) {
      const userChoice = confirm(
        "Pulse Cam doesn't seem to be installed. Open the App Store?"
      );
      if (userChoice) {
        // Replace with actual App Store / Play Store link
        window.location.href =
          "https://apps.apple.com/app/pulse-cam/id0000000000";
      }
    }
  }, 1500);
}
```

## Step 3: Implement Upload Endpoints

Your server needs the three TUS endpoints that Pulse Cam talks to. Here's a minimal standalone server:

```js
// upload-server.js
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const jwt = require("jsonwebtoken");

const app = express();
const sessions = new Map();
const completedUploads = new Map();
const UPLOAD_DIR = "./uploads";
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

fsPromises.mkdir(UPLOAD_DIR, { recursive: true });

// CORS for web clients
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, HEAD, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Upload-Length, Upload-Offset, Tus-Resumable, X-Upload-Token"
  );
  res.header(
    "Access-Control-Expose-Headers",
    "Location, Upload-Offset, Upload-Length, Tus-Resumable"
  );
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Health check
app.get("/health", (req, res) => res.json({ status: "OK" }));

// TUS: Create upload session
app.post("/uploads", (req, res) => {
  const uploadId = crypto.randomUUID();
  const totalSize = parseInt(req.headers["upload-length"], 10);
  const filePath = path.join(UPLOAD_DIR, `${uploadId}.partial`);

  sessions.set(uploadId, { totalSize, receivedBytes: 0, filePath });
  fs.writeFileSync(filePath, Buffer.alloc(0));

  res.status(201)
    .header("Location", `/uploads/${uploadId}`)
    .header("Tus-Resumable", "1.0.0")
    .end();
});

// TUS: Receive chunk
app.patch("/uploads/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).end();

  const offset = parseInt(req.headers["upload-offset"], 10);
  if (offset !== session.receivedBytes) {
    return res.status(409).json({ error: "Offset mismatch" });
  }

  const writeStream = fs.createWriteStream(session.filePath, { flags: "a" });
  req.pipe(writeStream);

  writeStream.on("finish", () => {
    session.receivedBytes += writeStream.bytesWritten;
    res.status(204)
      .header("Upload-Offset", session.receivedBytes.toString())
      .header("Tus-Resumable", "1.0.0")
      .end();
  });
});

// TUS: Check offset (resume support)
app.head("/uploads/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).end();

  res.status(200)
    .header("Upload-Offset", session.receivedBytes.toString())
    .header("Upload-Length", session.totalSize.toString())
    .header("Tus-Resumable", "1.0.0")
    .end();
});

// Finalize upload
app.post("/uploads/finalize", express.json(), async (req, res) => {
  const { uploadId, filename, uploadToken } = req.body;
  const token = req.headers["x-upload-token"] || uploadToken;

  // Validate JWT token
  try {
    jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const session = sessions.get(uploadId);
  if (!session) return res.status(404).json({ error: "Upload not found" });

  const finalPath = path.join(UPLOAD_DIR, filename);
  await fsPromises.rename(session.filePath, finalPath);

  const stat = await fsPromises.stat(finalPath);
  const fileBuffer = await fsPromises.readFile(finalPath);
  const hash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

  const result = {
    videoId: uploadId,
    status: "complete",
    size: stat.size,
    checksum: `sha256:${hash}`,
  };

  // Track completion for polling
  const draftId = filename.match(/draft-(.+)\.mp4/)?.[1];
  if (draftId) completedUploads.set(draftId, result);

  sessions.delete(uploadId);
  res.json(result);
});

// Status endpoint for web app polling
app.get("/api/pulse/status/:draftId", (req, res) => {
  const result = completedUploads.get(req.params.draftId);
  if (result) {
    res.json({ status: "complete", ...result });
  } else {
    res.json({ status: "pending" });
  }
});

app.listen(8080, () => console.log("Upload server running on :8080"));
```

## Complete Working Example

Putting it all together — a single-page app that lets users record via Pulse Cam and see when the upload completes:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pulse Cam Integration Demo</title>
  <script src="https://cdn.jsdelivr.net/npm/qrcode@1/build/qrcode.min.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 2rem; text-align: center; }
    #qr-canvas { margin: 1rem 0; }
    .status { padding: 0.5rem 1rem; border-radius: 8px; margin-top: 1rem; }
    .status.pending { background: #fff3cd; }
    .status.complete { background: #d4edda; }
    button { padding: 0.75rem 1.5rem; font-size: 1rem; border-radius: 8px; border: none; background: #0a84ff; color: white; cursor: pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Record a Video</h1>
    <p>Scan this QR code with your phone to open Pulse Cam</p>
    <canvas id="qr-canvas"></canvas>
    <div id="status" class="status pending">Waiting for recording...</div>
    <br />
    <button onclick="createSession()">Generate New QR Code</button>
  </div>

  <script>
    let pollInterval = null;

    async function createSession() {
      if (pollInterval) clearInterval(pollInterval);

      const res = await fetch("/api/pulse/session", { method: "POST" });
      const { deeplink, draftId } = await res.json();

      QRCode.toCanvas(document.getElementById("qr-canvas"), deeplink, {
        width: 280,
        margin: 2,
      });

      document.getElementById("status").className = "status pending";
      document.getElementById("status").textContent = "Waiting for recording...";

      // Poll every 3 seconds
      pollInterval = setInterval(async () => {
        const statusRes = await fetch(`/api/pulse/status/${draftId}`);
        const data = await statusRes.json();

        if (data.status === "complete") {
          clearInterval(pollInterval);
          const el = document.getElementById("status");
          el.className = "status complete";
          el.textContent = `✅ Video uploaded! (${(data.size / 1024 / 1024).toFixed(1)} MB)`;
        }
      }, 3000);
    }

    createSession();
  </script>
</body>
</html>
```

## Next Steps

- See the [TUS Upload](../uploads/tus) guide for detailed upload endpoint specs
- See the [Chunked Upload](../uploads/chunked) guide if your server can't use TUS directly
- See the [React `@mieweb/ui`](./react-mieweb-ui) guide for a component-based approach
