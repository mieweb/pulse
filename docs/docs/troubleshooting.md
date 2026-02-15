---
sidebar_position: 10
---

# Troubleshooting

Common issues when integrating Pulse Cam and how to fix them.

## At a glance

| Symptom | Section |
|--------|---------|
| "Server not set up for upload" | [Deep link / launch → Server not set up](#server-not-set-up-for-upload) |
| App opens to home instead of camera | [Deep link → home screen](#deep-link-opens-but-app-goes-to-home-screen) |
| QR scan does nothing | [Deep link → QR code](#qr-code-scans-but-nothing-happens) |
| Cannot connect / network error on upload | [Upload → Cannot connect](#cannot-connect-to-server--network-request-failed) |
| Invalid or expired token | [Upload → Token](#upload-fails-with-invalid-or-expired-token) |
| Chunk upload failed | [Upload → Chunk](#chunk-upload-failed-after-retries) |
| Wrong HTTP/HTTPS in URLs | [Deployment → scheme](#wrong-scheme-http-vs-https-in-location-or-deep-link) |
| Can't bind to port 80/443 | [Deployment → ports](#port-80443-not-available-eg-proxmox-lxc) |

---

## Deep link / launch

### "Server not set up for upload" {#server-not-set-up-for-upload}

**When:** User opens the deep link and sees this message instead of the camera.

**Causes:**

- `draftId` is missing, or not a valid UUID v4.
- `server` or `token` is missing.
- Query params were truncated or malformed (e.g. URL too long, encoding issue).

**Fix:**

- Ensure all four params are present: `mode=upload`, `draftId` (UUID v4), `server` (URL-encoded), `token`.
- Generate `draftId` with a UUID v4 library (e.g. `uuid.v4()` or `crypto.randomUUID()`).
- URL-encode `server` when building the link (e.g. `encodeURIComponent(serverUrl)`).

See [Launching Pulse Cam](./launching) for the exact format and validation rules.

### Deep link opens but app goes to home screen

**When:** The app opens but shows the normal home screen, not the camera in upload mode.

**Cause:** `mode` is not `"upload"` or is missing.

**Fix:** Always include `mode=upload` in the query string.

### QR code scans but nothing happens

**When:** User scans the QR code and the device doesn’t open Pulse Cam.

**Causes:**

- Pulse Cam is not installed.
- OS or browser is blocking the custom URL scheme.

**Fix:** Ensure Pulse Cam is installed. On first use, you may need to tell the user to open the link from a browser or from your app’s “Open in Pulse Cam” button instead of a generic QR scanner that doesn’t handle custom schemes.

---

## Upload

### Cannot connect to server / Network request failed {#cannot-connect-to-server--network-request-failed}

**When:** User taps Upload and sees a connection error.

**Common causes:**

- **Physical device and `localhost`:** The deep link’s `server` URL uses `http://localhost:8080` (or `127.0.0.1`). The phone cannot reach the dev machine’s localhost.

**Fix:** Use your machine’s LAN IP in the `server` URL (e.g. `http://192.168.1.100:8080`). Regenerate the deep link/QR with that URL. See [Launching — Physical device testing](./launching#physical-device-testing).

- **Server not running or wrong port:** PulseVault or your upload server isn’t running, or is on a different port.

**Fix:** Start the server and confirm `GET /health` returns 200. Use the same base URL (including port) in the deep link.

- **Firewall or network:** Device and server on different networks, or firewall blocking the port.

**Fix:** Put device and server on the same network; allow the server port through the firewall.

### Upload fails with "Invalid or expired token" {#upload-fails-with-invalid-or-expired-token}

**When:** Finalize returns 401 or the server rejects the token.

**Causes:**

- Token expired (e.g. 24h expiry).
- Token was generated with a different secret or payload than the server expects.
- Clock skew between server and token generation.

**Fix:** Generate a fresh deep link (new token). If using PulseVault, ensure `HMAC_SECRET` is consistent and tokens are generated with the correct expiry. For custom backends, verify JWT/handler expiry and signature.

### Chunk upload failed (after retries) {#chunk-upload-failed-after-retries}

**When:** Upload progresses but then fails with a chunk error.

**Causes:**

- Network drop or server restart during upload.
- Server returned 4xx/5xx for a PATCH (e.g. offset mismatch, disk full).

**Fix:** Check server logs for the failing request. Ensure the server’s `Upload-Offset` matches what the client sent; fix storage or restart the server and have the user try again (TUS supports resume if the server kept state).

---

## Deployment (PulseVault)

### Wrong scheme (HTTP vs HTTPS) in Location or deep link {#wrong-scheme-http-vs-https-in-location-or-deep-link}

**When:** App or browser redirects to `http://` when the server is behind HTTPS.

**Fix:** Ensure the reverse proxy (Nginx, Proxmox, or load balancer) sends `X-Forwarded-Proto: https` so PulseVault can build correct URLs. See [PulseVault — Nginx and reverse proxy](./uploads/pulsevault#nginx-and-reverse-proxy-production).

### Port 80/443 not available (e.g. Proxmox LXC) {#port-80443-not-available-eg-proxmox-lxc}

**When:** Docker or host cannot bind to 80 or 443.

**Fix:** PulseVault’s default Compose already uses port 8080 for Nginx. Use that URL in the deep link (e.g. `http://your-host:8080`). For HTTPS, terminate SSL at the host or load balancer and set `X-Forwarded-Proto`. See [PulseVault — Proxmox / LXC](./uploads/pulsevault#proxmox--lxc-deployment).

---

## Still stuck?

- Re-check the [deep link format](./launching#deep-link-url-format) and [TUS sequence](./uploads/tus).
- For PulseVault: see the [PulseVault repository](https://github.com/mieweb/pulse-vault) (SETUP.md, issues).
- For the Pulse app: see the [Pulse repository](https://github.com/mieweb/pulse).
