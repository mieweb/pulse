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

When the deep link opens:

1. **Config is stored** — the `server`, `token`, and `draftId` are persisted to local storage (AsyncStorage), keyed by `draftId`.
2. **Camera opens** — the user is taken to the recording screen in upload mode.
3. **User records & edits** — they can record segments, trim, reorder, undo/redo.
4. **Upload** — when satisfied, the user taps Upload. Pulse Cam sends the merged video to `server` using [TUS protocol](./uploads/tus) or the endpoint you configure.
5. **Completion** — a success alert is shown and Pulse Cam navigates back.

:::caution Physical Device Testing
If your server is on `localhost`, deep links will fail on physical devices. Always use your machine's network IP address (e.g. `192.168.1.100`) when testing on real devices.
:::
