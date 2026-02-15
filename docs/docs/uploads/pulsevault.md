---
sidebar_position: 1
---

# PulseVault

**PulseVault** is the reference upload server for Pulse Cam. It implements the TUS 1.0.0 protocol, handles video storage, and provides the `/qr/deeplink` API for generating deep links with QR codes.

## Architecture

```
┌───────────────┐         ┌──────────────┐         ┌────────────────┐
│  Your Web App │ ──API──▶│  PulseVault  │◀──TUS──│  Pulse Cam     │
│               │         │  (Docker)    │         │  (mobile app)  │
└───────────────┘         └──────────────┘         └────────────────┘
```

PulseVault acts as the bridge: your application calls PulseVault APIs to create recording sessions, and Pulse Cam uploads completed videos back to PulseVault.

## Deployment

PulseVault is deployed as a Docker container. See the [PulseVault repository](https://github.com/mieweb/pulse-vault) for full setup instructions.

### Quick Start

```bash
git clone https://github.com/mieweb/pulse-vault.git
cd pulse-vault
docker compose up -d
```

Default port: **8080** (configurable via `PULSEVAULT_PORT` environment variable).

### Proxmox / LXC Deployment

For non-privileged containers (e.g. Proxmox LXC), use the alternate compose file:

```bash
docker compose -f docker-compose.yml -f docker-compose.proxmox.yml up -d
```

This binds to port 8080 (HTTP) and 8443 (HTTPS) instead of the standard 80/443.

## API Endpoints

### Health Check

```
GET /health
```

Returns `{ "status": "OK" }` if the server is running.

### Generate Deep Link

```
GET /qr/deeplink?userId=<userId>&server=<serverUrl>[&draftId=<draftId>]
```

**Query Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `userId` | Yes | Identifier for the user in your system |
| `server` | Yes | The PulseVault server URL (used in the deep link) |
| `draftId` | No | Pre-existing draft ID — omit to create a new one |

**Response:**

```json
{
  "deeplink": "pulsecam://?mode=upload&draftId=abc-123&server=https%3A%2F%2Fvault.example.com&token=eyJ...",
  "qrData": "pulsecam://?mode=upload&draftId=abc-123&server=https%3A%2F%2Fvault.example.com&token=eyJ..."
}
```

### TUS Upload Endpoints

PulseVault implements the standard TUS 1.0.0 protocol:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/uploads` | Create a new upload session |
| `PATCH` | `/uploads/:id` | Upload a chunk |
| `HEAD` | `/uploads/:id` | Check upload offset (for resuming) |
| `POST` | `/uploads/finalize` | Finalize and process the upload |

See the [TUS Upload](./tus) page for full protocol details.

## Integration Example

### JavaScript

```js
// 1. Generate a deep link via your backend → PulseVault
const response = await fetch(
  `${PULSEVAULT_URL}/qr/deeplink?userId=${userId}&server=${PULSEVAULT_URL}`
);
const { deeplink, qrData } = await response.json();

// 2. Display QR code for user to scan
const qrImage = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qrData)}`;
document.getElementById("qr").src = qrImage;

// 3. Pulse Cam handles recording + upload back to PulseVault
// No further client-side work needed!
```

### React (`@mieweb/ui`)

```jsx
import { PulseRecordButton } from "@mieweb/ui";

function RecordingPanel({ userId }) {
  return (
    <PulseRecordButton
      serverUrl="https://vault.example.com"
      userId={userId}
      onComplete={(result) => {
        console.log("Upload complete:", result.videoId);
      }}
      onError={(error) => {
        console.error("Upload failed:", error);
      }}
    />
  );
}
```

The `@mieweb/ui` `PulseRecordButton` component handles deep link generation, QR display, and upload status polling — see the [React `@mieweb/ui` Guide](../frameworks/react-mieweb-ui) for details.

## Testing with `test-deeplink.sh`

The Pulse repo includes a test script that exercises the PulseVault deep link flow:

```bash
# Uses auto-detected local IP, port 8080
./test-deeplink.sh

# Override server URL
PULSEVAULT_URL=http://192.168.1.50:8080 ./test-deeplink.sh

# With a specific draft ID
./test-deeplink.sh f47ac10b-58cc-4372-a567-0e02b2c3d479
```

The script:
1. Checks server connectivity
2. Generates a deep link via `GET /qr/deeplink`
3. Creates a QR code image at `/tmp/pulse-qr.png`
4. Auto-opens in iOS Simulator if one is booted

## Monitoring Uploads

After Pulse Cam uploads a video, your application can query PulseVault for the status. The finalize response includes:

```json
{
  "videoId": "abc-123",
  "status": "complete",
  "size": 5242880,
  "checksum": "sha256:..."
}
```

Use `videoId` to track the asset in your own system.
