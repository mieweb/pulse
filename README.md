# Pulse

> **Short-form institutional video — record and edit on-device, upload to your own server.**

<div align="center">
  <img alt="Pulse Logo" height="200" src="./assets/images/pulse-logo.png" />

  <br />

  [![React Native](https://img.shields.io/badge/React%20Native-0.79.6-blue.svg?style=flat&logo=react)](https://reactnative.dev)
  [![Expo](https://img.shields.io/badge/Expo-53-white.svg?style=flat&logo=expo&logoColor=black)](https://expo.dev)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg?style=flat&logo=typescript)](https://www.typescriptlang.org/)
  [![AVFoundation](https://img.shields.io/badge/AVFoundation-iOS-green.svg?style=flat&logo=apple)](https://developer.apple.com/av-foundation/)
  [![Media3](https://img.shields.io/badge/Media3-Android-orange.svg?style=flat&logo=android)](https://developer.android.com/guide/topics/media/media3)
</div>

**Pulse** is a React Native (Expo) app for capturing institutional knowledge as short-form video. Drafts live on-device; finalized videos upload over the resumable [TUS protocol](https://tus.io/) to a Fastify server running the [`@mieweb/pulsevault`](https://github.com/mieweb/pulsevault) plugin — so organizations keep content on their own infrastructure and own auth, ownership, and quota decisions.

Typical uses: training documentation, process walkthroughs, knowledge transfer before staff changes, and compliance material.

## Features

### Recording & editing

- **Segmented recording** — record multiple clips that combine into one seamless video
- **Duration presets** — 15s / 30s / 1m / 3m
- **Hardware-accelerated concatenation** — AVFoundation on iOS, Media3 on Android
- **Drag-and-drop reordering** with live drop indicators
- **Per-segment trim** (in/out points) with undo/redo persisted across sessions

### Camera

- Flash, camera flip, zoom
- Cross-platform video stabilization (see [VIDEO_STABILIZATION.md](./VIDEO_STABILIZATION.md))
- Import clips from the photo library and mix with new recordings

### Drafts & upload

- **Auto-saved drafts** — pick up work across sessions
- **Per-draft upload destinations** — choose which PulseVault server a given draft targets
- **Resumable uploads** — TUS chunking survives flaky networks and backgrounded apps
- **Draft transfer** — export/import via AirDrop, iCloud Drive, or iOS device migration (see [DRAFT_TRANSFER.md](./DRAFT_TRANSFER.md))
- **Deep links** — `pulsecam://` URL scheme for direct app entry from external tools

## Backend: `@mieweb/pulsevault`

Pulse is a client for the [`@mieweb/pulsevault`](https://github.com/mieweb/pulsevault) Fastify plugin. Drop it into your own Fastify app to get TUS-compatible video ingestion with a pluggable storage adapter — `@mieweb/artipod`-backed local filesystem ships by default, or implement `PulseVaultStorage` for a custom backend.

The plugin mounts three routes under a configurable prefix:

| Method  | Path          | Description                              |
| ------- | ------------- | ---------------------------------------- |
| `POST`  | `/upload`     | Create a TUS upload session              |
| `PATCH` | `/upload/:id` | Stream chunks                            |
| `GET`   | `/:videoid`   | Stream or redirect to the uploaded video |

`POST /reserve` is **not** part of the plugin — your server implements it to attach auth, DB records, and quotas, and returns a `videoid` the client then streams to. Pulse calls `/reserve` before every upload.

## Installation

```bash
git clone https://github.com/mieweb/pulse.git
cd pulse
npm install
```

### Prerequisites

- Node.js 18+
- Expo CLI
- Xcode (iOS)
- Android Studio (Android)

### Running

```bash
# Metro / Expo
npx expo start

# iOS
npx expo prebuild
cd ios && pod install && open pulse.xcworkspace
# then build from Xcode

# Android
npx expo run:android
```

**Required permissions:** Camera, Microphone, Storage.

## Configuration

### Recording settings

```typescript
const defaultSettings = {
  maxIndividualDuration: 60, // max duration per segment (s)
  holdDelay: 500, // ms before hold-to-record engages
  progressUpdateInterval: 100, // progress tick (ms)
};
```

### Time options

```typescript
const timeOptions = [
  { label: "15s", value: 15 },
  { label: "30s", value: 30 },
  { label: "1m", value: 60 },
  { label: "3m", value: 180 },
];
```

### Video concatenation

```typescript
interface RecordingSegment {
  id: string;
  duration: number;
  uri: string;
  inMs?: number; // optional start trim
  outMs?: number; // optional end trim
}

const outputUri = await VideoConcatModule.export(segments);
```

### Video stabilization

- **iOS**: `off`, `standard`, `cinematic`, `cinematicExtended`, `auto`
- **Android**: on/off (iOS-specific modes map to "on")
- **Control**: tap to cycle, long-press for picker

See [VIDEO_STABILIZATION.md](./VIDEO_STABILIZATION.md) for details.

## Development

### Project structure

```
pulse/
├── app/          # Expo Router screens
├── components/   # Reusable UI
├── modules/      # Native modules (video-concat, etc.)
├── hooks/        # Custom React hooks
├── utils/        # Upload, draft storage, destinations
└── constants/    # App configuration
```

### Commands

```bash
npm run lint
npx tsc --noEmit
eas build --platform ios --profile production
eas build --platform android --profile production
```

### CodeQL

Automated CodeQL analysis runs against the iOS build. Workflow: `.github/workflows/codeql.yml`. If you rename the Xcode workspace or scheme, update the `-workspace` / `-scheme` parameters there. The workflow builds against the iPhone Simulator SDK with code signing disabled and Metro bundling skipped.

## Contributing

1. Fork and branch: `git checkout -b feature/your-change`
2. Make changes and test on both iOS and Android
3. `git commit -m 'feat: your change'`
4. Push and open a PR

## Research context

Pulse grew out of research into institutional knowledge management and video-based documentation — measuring how short-form video affects ticket resolution, knowledge adoption, and collaboration compared to traditional documentation. Partnerships welcome.

## Acknowledgments

- **Primary developer**: [Priyam More](https://github.com/morepriyam)
- **Institutional partner**: [Medical Informatics Engineering, Inc.](https://github.com/mieweb)
- **Research advisor**: [Doug Horner](https://github.com/horner)

Built on [React Native](https://reactnative.dev/), [Expo](https://expo.dev/), native [AVFoundation](https://developer.apple.com/av-foundation/) and [Media3](https://developer.android.com/guide/topics/media/media3), and the [`@mieweb/pulsevault`](https://github.com/mieweb/pulsevault) Fastify plugin.

## License

Source Available — see [LICENSE](LICENSE).

Free for non-commercial use (with attribution, and derivative works must be distributed under an OSI-approved open source license with source available). Commercial use requires a separate license from Medical Informatics Engineering, LLC. — contact https://www.mieweb.com or helpdesk@mieweb.com.
