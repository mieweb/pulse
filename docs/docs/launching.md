---
sidebar_position: 2
---

# Launching Pulse Cam

To launch Pulse Cam from your application, you open a deep link using the `pulsecam://` URL scheme. When the link is opened, Pulse Cam starts in **upload mode** — the user records video, edits it, and uploads the result to your server.

## Deep Link URL Format

```
pulsecam://?mode=upload&draftId=<uuid>&server=<url>&token=<token>
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | `"upload"` | Yes | Activates upload mode in Pulse Cam |
| `draftId` | UUID v4 | Yes | A unique identifier you generate for this recording session. Pulse Cam uses this to associate the recording with your system. |
| `server` | URL-encoded string | Yes | The base URL of your upload server (e.g. `https://vault.example.com`) |
| `token` | string | Yes | An auth token that Pulse Cam sends back when uploading. Your server validates this. |

### Validation Rules

- `draftId` **must** be a valid UUID v4 (e.g. `f47ac10b-58cc-4372-a567-0e02b2c3d479`). If it fails validation, Pulse Cam shows a "Server not set up for upload" screen.
- `server` should be URL-encoded if it contains special characters.
- `token` is opaque to Pulse Cam — it is stored and sent back verbatim during upload.

## Example: Complete Deep Link

```
pulsecam://?mode=upload&draftId=f47ac10b-58cc-4372-a567-0e02b2c3d479&server=https%3A%2F%2Fvault.example.com&token=eyJhbGciOiJIUzI1NiJ9...
```

## Generating the Deep Link

### Server-Side (Node.js)

Your backend should generate the `draftId` and `token`, then return the deep link to your frontend:

```js
const { v4: uuidv4 } = require("uuid");
const jwt = require("jsonwebtoken");

function generatePulseCamLink(userId, serverUrl) {
  const draftId = uuidv4();
  const token = jwt.sign(
    { userId, draftId, purpose: "pulse-upload" },
    process.env.JWT_SECRET,
    { expiresIn: "24h" }
  );

  const params = new URLSearchParams({
    mode: "upload",
    draftId,
    server: serverUrl,
    token,
  });

  return {
    deeplink: `pulsecam://?${params.toString()}`,
    draftId,
    token,
  };
}
```

### QR Code Workflow

A common pattern is to display a QR code on a desktop or kiosk screen that the user scans with their phone:

```
┌──────────────┐    QR code    ┌──────────────┐
│  Your Web UI │ ────────────▶ │  User's Phone│
│  (generates  │               │  (scans QR,  │
│   deep link) │               │  opens Pulse │
│              │               │  Cam)        │
└──────────────┘               └──────────────┘
```

```js
// Example: Generate QR code on your web page
import QRCode from "qrcode";

const { deeplink } = await fetch("/api/pulse/create-session", {
  method: "POST",
}).then((r) => r.json());

const qrDataUrl = await QRCode.toDataURL(deeplink, { width: 400 });
document.getElementById("qr").src = qrDataUrl;
```

## Opening the Deep Link

### From a Web Page

```html
<a href="pulsecam://?mode=upload&draftId=...&server=...&token=...">
  Open in Pulse Cam
</a>
```

Or via JavaScript:

```js
window.location.href = deeplink;
```

### From a Native App

**iOS (Swift):**

```swift
if let url = URL(string: "pulsecam://?mode=upload&draftId=...&server=...&token=...") {
    UIApplication.shared.open(url)
}
```

**Android (Kotlin):**

```kotlin
val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pulsecam://?mode=upload&draftId=...&server=...&token=..."))
startActivity(intent)
```

## Testing Deep Links

### iOS Simulator

```bash
xcrun simctl openurl booted "pulsecam://?mode=upload&draftId=f47ac10b-58cc-4372-a567-0e02b2c3d479&server=http%3A%2F%2F192.168.1.100%3A8080&token=test-token"
```

### Android Emulator

```bash
adb shell am start -W -a android.intent.action.VIEW \
  -d "pulsecam://?mode=upload&draftId=f47ac10b-58cc-4372-a567-0e02b2c3d479&server=http%3A%2F%2F192.168.1.100%3A8080&token=test-token"
```

### Using the Test Script

The Pulse repository includes a test script that generates deep links against a running PulseVault server:

```bash
# Auto-detect local IP, default port 8080
./test-deeplink.sh

# Override server URL
PULSEVAULT_URL=http://192.168.1.50:8080 ./test-deeplink.sh

# Include a specific draft ID
./test-deeplink.sh f47ac10b-58cc-4372-a567-0e02b2c3d479
```

## What Happens in Pulse Cam

When the deep link opens, Pulse Cam processes it in two phases — **validation** and **recording**.

### Phase 1: Parameter Validation (Immediate)

Pulse Cam validates the deep link parameters before doing anything else:

1. **Parse URL** — the query string is extracted and parsed for `mode`, `draftId`, `server`, and `token`.
2. **Validate `mode`** — must be `"upload"`. Any other value (or missing) is ignored and the app opens normally to the home screen.
3. **Validate `draftId`** — must be a valid UUID v4 (regex: `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`). If the `draftId` is missing or malformed, the app shows a **"Server not set up for upload"** error screen with a button to go home.
4. **Check `server` and `token`** — both must be present. If either is missing while `draftId` is valid, the error screen is shown.

If all four parameters pass validation:

5. **Store config** — the `server`, `token`, and `draftId` are persisted to local storage (AsyncStorage), keyed by `draftId`. This allows the upload config to survive app restarts or backgrounding.
6. **Redirect to camera** — the app navigates to the recording screen in upload mode.

:::info No Server Connectivity Check at Launch
Pulse Cam does **not** test the server URL when the deep link opens. The `server` URL is stored as-is and only contacted later when the user taps Upload. This means an invalid or unreachable server URL won't cause an error until upload time. If you want immediate validation, your deep link generation endpoint should verify the upload server is healthy before returning the link.
:::

### Phase 2: Record, Edit, Upload

7. **Camera opens** — the user is taken to the recording screen in upload mode. An upload-specific close button replaces the normal back button.
8. **User records & edits** — they can record segments, trim, reorder, undo/redo. The draft is auto-saved throughout.
9. **Preview** — the user views the merged video and sees an Upload button (only visible for drafts created via deep link).
10. **Upload begins** — Pulse Cam sends the merged video to `server` using the [TUS protocol](./uploads/tus):
    - **Localhost detection** — if the server URL contains `localhost` or `127.0.0.1`, Pulse Cam attempts to auto-replace it with the Expo dev server's IP (best-effort; may not work on production builds).
    - **Session creation** — `POST /uploads` with the file size.
    - **Chunked transfer** — 1 MB chunks via `PATCH`, with up to 3 retries per chunk.
    - **Finalization** — `POST /uploads/finalize` with the auth token.
11. **Completion** — a success alert shows the video ID and file size. The app navigates back.

### Error Handling

| Error | When | User Sees |
|-------|------|-----------|
| Missing or invalid `draftId` | Deep link parse | "Server not set up for upload" screen |
| Missing `server` or `token` | Deep link parse | "Server not set up for upload" screen |
| Server unreachable | Upload tap | Alert with connection troubleshooting steps |
| `localhost` on physical device | Upload tap | Alert suggesting to use the machine's IP address |
| Chunk upload failure (after retries) | During upload | Alert with error details |

:::caution Physical Device Testing
If your server is on `localhost`, deep links will open Pulse Cam successfully but **uploads will fail** on physical devices. Always use your machine's network IP address (e.g. `192.168.1.100`) when testing on real devices.
:::
