---
sidebar_position: 2
---

# React Integration with `@mieweb/ui`

The `@mieweb/ui` npm package provides ready-made React components for integrating Pulse Cam into your application. Instead of manually generating deep links and managing QR codes, you drop in a component and wire up callbacks.

## Installation

```bash
npm install @mieweb/ui
```

**Peer dependencies:**

```bash
npm install react react-dom
```

## Quick Start

```jsx
import { PulseRecordButton } from "@mieweb/ui";

function App() {
  return (
    <PulseRecordButton
      serverUrl="https://vault.example.com"
      userId="user-123"
      onComplete={(result) => {
        console.log("Video uploaded:", result.videoId);
        console.log("Size:", result.size);
      }}
      onError={(error) => {
        console.error("Error:", error.message);
      }}
    />
  );
}
```

This renders a button that:
1. Calls your server to create a recording session (draftId + token)
2. Displays a QR code for the user to scan
3. Polls for upload completion
4. Fires `onComplete` when the video is uploaded

## Components

### `<PulseRecordButton>`

An all-in-one button + modal component that handles the full flow.

#### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `serverUrl` | `string` | Yes | Base URL of your upload server or PulseVault instance |
| `userId` | `string` | Yes | User identifier in your system |
| `onComplete` | `(result: UploadResult) => void` | No | Called when upload finishes successfully |
| `onError` | `(error: Error) => void` | No | Called on failure |
| `onSessionCreated` | `(session: Session) => void` | No | Called when deep link is generated |
| `buttonText` | `string` | No | Custom button label (default: `"Record Video"`) |
| `buttonClassName` | `string` | No | CSS class for the trigger button |
| `modalClassName` | `string` | No | CSS class for the QR modal |
| `pollInterval` | `number` | No | Polling interval in ms (default: `3000`) |
| `sessionEndpoint` | `string` | No | Override the session creation endpoint (default: `/qr/deeplink`) |
| `disabled` | `boolean` | No | Disable the button |

#### Types

```ts
interface UploadResult {
  videoId: string;
  status: string;
  size: number;
  checksum: string;
}

interface Session {
  deeplink: string;
  draftId: string;
  qrData: string;
}
```

#### Example with Full Props

```jsx
<PulseRecordButton
  serverUrl="https://vault.example.com"
  userId="user-456"
  buttonText="📹 Record Training Video"
  buttonClassName="my-record-btn"
  pollInterval={2000}
  onSessionCreated={(session) => {
    console.log("Session started:", session.draftId);
    // Track in your analytics
  }}
  onComplete={(result) => {
    // Save video reference to your database
    saveVideoToDb({
      videoId: result.videoId,
      size: result.size,
    });
  }}
  onError={(error) => {
    showToast(`Recording failed: ${error.message}`);
  }}
/>
```

### `<PulseQrCode>`

A lower-level component that just renders the QR code. Use this when you want full control over the UI.

#### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `deeplink` | `string` | Yes | The `pulsecam://` deep link URL |
| `size` | `number` | No | QR code size in pixels (default: `256`) |
| `className` | `string` | No | CSS class for the container |

```jsx
import { PulseQrCode } from "@mieweb/ui";

function CustomRecordingUI({ deeplink }) {
  return (
    <div className="recording-panel">
      <h3>Scan to start recording</h3>
      <PulseQrCode deeplink={deeplink} size={300} />
      <p>Point your phone camera at the QR code</p>
    </div>
  );
}
```

### `usePulseSession()` Hook

For maximum flexibility, use the hook directly to manage the session lifecycle:

```ts
import { usePulseSession } from "@mieweb/ui";

function MyComponent() {
  const {
    session,        // { deeplink, draftId, qrData } | null
    status,         // "idle" | "creating" | "waiting" | "complete" | "error"
    result,         // UploadResult | null
    error,          // Error | null
    createSession,  // () => Promise<void>
    reset,          // () => void
  } = usePulseSession({
    serverUrl: "https://vault.example.com",
    userId: "user-789",
    pollInterval: 3000,
  });

  if (status === "idle") {
    return <button onClick={createSession}>Start Recording Session</button>;
  }

  if (status === "creating") {
    return <p>Creating session...</p>;
  }

  if (status === "waiting" && session) {
    return (
      <div>
        <PulseQrCode deeplink={session.deeplink} />
        <p>Waiting for recording & upload...</p>
        <button onClick={reset}>Cancel</button>
      </div>
    );
  }

  if (status === "complete" && result) {
    return (
      <div>
        <p>✅ Video uploaded! ({(result.size / 1024 / 1024).toFixed(1)} MB)</p>
        <button onClick={reset}>Record Another</button>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div>
        <p>❌ {error?.message}</p>
        <button onClick={createSession}>Retry</button>
      </div>
    );
  }

  return null;
}
```

## Full Application Example

A complete React app with a video list and recording flow:

```jsx
import React, { useState } from "react";
import { PulseRecordButton } from "@mieweb/ui";

const SERVER_URL = "https://vault.example.com";

function VideoLibrary() {
  const [videos, setVideos] = useState([]);

  const handleComplete = (result) => {
    setVideos((prev) => [
      {
        id: result.videoId,
        size: result.size,
        uploadedAt: new Date().toISOString(),
      },
      ...prev,
    ]);
  };

  return (
    <div className="app">
      <header>
        <h1>Training Videos</h1>
        <PulseRecordButton
          serverUrl={SERVER_URL}
          userId="trainer-1"
          buttonText="+ New Recording"
          onComplete={handleComplete}
          onError={(err) => alert(err.message)}
        />
      </header>

      <section>
        {videos.length === 0 ? (
          <p>No videos yet. Click "New Recording" to get started.</p>
        ) : (
          <ul>
            {videos.map((v) => (
              <li key={v.id}>
                <strong>{v.id}</strong> —{" "}
                {(v.size / 1024 / 1024).toFixed(1)} MB —{" "}
                {new Date(v.uploadedAt).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default VideoLibrary;
```

## Styling

Components use minimal default styles and accept `className` props for customization:

```css
/* Example: Custom button styling */
.my-record-btn {
  background: #0a84ff;
  color: white;
  border: none;
  border-radius: 8px;
  padding: 12px 24px;
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
}

.my-record-btn:hover {
  background: #0070e0;
}

.my-record-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

## Configuration

### Custom Session Endpoint

If your backend wraps the PulseVault API, override the session endpoint:

```jsx
<PulseRecordButton
  serverUrl="https://api.example.com"
  sessionEndpoint="/api/v1/recordings/session"
  userId="user-123"
/>
```

The component will `GET <serverUrl><sessionEndpoint>?userId=<userId>&server=<serverUrl>` and expect a `{ deeplink, qrData }` response.

### With Authentication Headers

If your backend requires auth, use the hook for full control:

```jsx
import { usePulseSession, PulseQrCode } from "@mieweb/ui";

function AuthenticatedRecorder({ authToken }) {
  const { session, status, createSession, result, reset } = usePulseSession({
    serverUrl: "https://vault.example.com",
    userId: "user-123",
    fetchOptions: {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    },
  });

  // ... render based on status
}
```

## Server Requirements

The `@mieweb/ui` components expect your server (or PulseVault) to implement:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/qr/deeplink` | GET | Generate deep link + QR data |
| `/uploads` | POST | TUS: create upload session |
| `/uploads/:id` | PATCH | TUS: receive chunk |
| `/uploads/finalize` | POST | TUS: finalize upload |
| `/api/pulse/status/:draftId` | GET | (Optional) Poll upload status |

See the [TUS Upload](../uploads/tus) guide for endpoint implementation details.

## Next Steps

- [Launching Pulse Cam](../launching) — deep link format and parameter reference
- [PulseVault](../uploads/pulsevault) — turnkey server setup
- [JavaScript Guide](./javascript) — vanilla JS integration without `@mieweb/ui`
