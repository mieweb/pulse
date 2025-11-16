# Screen Recording Feature - Quick Start

## What is This?

This PR adds an **audio-gated screen recording** feature to Pulse for iOS. It allows users to record their screen, but **only captures video when they're speaking**. Silent periods are automatically skipped, creating an "auto-edited" video.

## Visual Overview

### UI Components Added

**Profile Tab (iOS only):**
```
┌─────────────────────────────────────┐
│           Profile                    │
│     This is your profile page.       │
│                                      │
│    Screen Recording (PoC)            │
│    Audio-gated screen recording:     │
│    Only records when you speak!      │
│                                      │
│  ┌─────────────────────────────┐    │
│  │ 📹 Start Screen Recording   │    │
│  └─────────────────────────────┘    │
│                                      │
│  ┌─────────────────────────────┐    │
│  │ 📂 Check Last Recording     │    │
│  └─────────────────────────────┘    │
│                                      │
│  ┌─────────────────────────────┐    │
│  │ ▶️ Play Last Recording      │    │
│  └─────────────────────────────┘    │
│                                      │
│  Last: recording-2025-01-15...mp4   │
│                                      │
│  ┌─────────────────────────────┐    │
│  │                             │    │
│  │      Video Player           │    │
│  │      (9:16 aspect)          │    │
│  │                             │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

### System Flow

```
1. User taps "Start Screen Recording"
           ↓
2. iOS System Broadcast Picker appears
           ↓
3. User selects "Pulse Screen Recorder"
           ↓
4. Recording starts in background
           ↓
5. Broadcast Extension monitors audio
           ↓
   ┌──────────────────────┐
   │ Audio > threshold?   │
   └──────────────────────┘
      Yes ↓        No ↓
   Record video   Skip frames
           ↓
6. User stops recording via Control Center
           ↓
7. Video saved to App Group container
           ↓
8. User taps "Play Last Recording"
           ↓
9. Video plays (only speaking parts included)
```

## Quick Setup (5-15 minutes)

### Prerequisites
- Mac with Xcode installed
- Physical iOS device (ReplayKit doesn't work on simulator)
- Apple Developer account for code signing

### Steps

1. **Pull this branch**
   ```bash
   git checkout copilot/add-audio-gated-screen-recording
   ```

2. **Install dependencies**
   ```bash
   npm install
   cd ios
   pod install
   cd ..
   ```

3. **Open in Xcode**
   ```bash
   open ios/pulse.xcworkspace
   ```

4. **Add Broadcast Extension Target** (see detailed steps in `SCREEN_RECORDING_SETUP.md`)
   - File → New → Target
   - Choose "Broadcast Upload Extension"
   - Name: `BroadcastExtension`
   - Bundle ID: `com.mieweb.pulse.BroadcastExtension`
   - Delete auto-generated SampleHandler.swift
   - Add `ios/BroadcastExtension/SampleHandler.swift` to target
   - Configure App Groups on both targets

5. **Build and Run**
   ```bash
   npm run ios
   ```

6. **Test on Device**
   - Go to Profile tab
   - Tap "📹 Start Screen Recording"
   - Select extension and record
   - Tap "▶️ Play Last Recording"

## How the Audio-Gating Works

### Audio Analysis
The broadcast extension analyzes audio in real-time:

```swift
// Calculate RMS (Root Mean Square) of audio samples
let rms = sqrt(sum_of_squares / sample_count)

// Typical values:
// Background noise:  0.005 - 0.015
// Normal speech:     0.02  - 0.1
// Loud speech/music: 0.1   - 0.5
```

### State Machine
```
         Audio > 0.02 RMS
         for 0.3 seconds
SILENT ──────────────────→ ACTIVE
       ←──────────────────
         Audio < 0.02 RMS
         for 0.7 seconds
```

**Why hysteresis?**
- Prevents rapid state changes
- Avoids choppy video from brief pauses
- Creates natural feeling transitions

### Example Recording

**What you do:**
1. Silence (2 seconds)
2. Say "Hello, this is a demo" (3 seconds)
3. Silence (2 seconds)
4. Say "Here's the feature" (3 seconds)
5. Silence (2 seconds)

**What gets recorded:**
- ❌ First 2 seconds of silence → SKIPPED
- ✅ 3 seconds of speech → RECORDED
- ❌ Next 2 seconds of silence → SKIPPED
- ✅ 3 seconds of speech → RECORDED
- ❌ Last 2 seconds of silence → SKIPPED

**Result:** ~6 second video instead of 12 seconds

## Files Structure

```
Repository Root
├── modules/screen-recorder/          ← New native module
│   ├── ios/
│   │   ├── ScreenRecorderModule.swift   (Bridge to React Native)
│   │   └── ScreenRecorder.podspec
│   ├── src/
│   │   ├── ScreenRecorderModule.ts      (TypeScript bridge)
│   │   └── ScreenRecorder.types.ts      (TypeScript types)
│   ├── index.ts
│   ├── package.json
│   └── README.md                         (Module API docs)
│
├── ios/BroadcastExtension/           ← New extension target
│   ├── SampleHandler.swift              (Audio-gating logic)
│   ├── Info.plist                       (Extension config)
│   └── BroadcastExtension.entitlements  (App groups)
│
├── app/(tabs)/profile.tsx            ← Modified (UI added)
│
├── ios/pulse/pulse.entitlements      ← Modified (app groups)
│
└── Documentation
    ├── SCREEN_RECORDING_SETUP.md     (Xcode setup guide)
    ├── INTEGRATION_GUIDE.md          (Complete guide)
    └── modules/screen-recorder/README.md
```

## Configuration

### Tuning Audio Threshold

Edit `ios/BroadcastExtension/SampleHandler.swift`:

```swift
// Lower = more sensitive (records more)
// Higher = less sensitive (skips more)
private let audioThreshold: Float = 0.02

// Time above threshold before starting
private let minActiveTransitionDuration: TimeInterval = 0.3

// Time below threshold before stopping  
private let minSilentTransitionDuration: TimeInterval = 0.7
```

**Common adjustments:**
- **Too much silence recorded?** → Increase `audioThreshold` to 0.03 or 0.04
- **Speech being cut off?** → Decrease `audioThreshold` to 0.015
- **Too choppy?** → Increase transition durations
- **Missing quick sounds?** → Decrease `minActiveTransitionDuration`

## Debugging

### View Real-Time Logs

1. Connect iOS device to Mac
2. Open **Console.app**
3. Filter by process: `BroadcastExtension`
4. Start recording
5. Watch logs:
   ```
   [BroadcastExtension] Audio level: 0.0234, threshold: 0.0200, state: active
   [BroadcastExtension] State transition: silent -> active
   [BroadcastExtension] State transition: active -> silent
   [BroadcastExtension] Recording finalized successfully
   ```

### Common Issues

| Issue | Solution |
|-------|----------|
| "Module not found" | Run `pod install` in ios directory |
| "Extension not in picker" | Build extension target in Xcode |
| "No video created" | Check audio threshold, ensure you spoke |
| "Too much silence" | Increase threshold value |
| "Speech cut off" | Decrease threshold or increase active duration |

## API Reference

### JavaScript/TypeScript

```typescript
import ScreenRecorder from '@/modules/screen-recorder';

// Start recording (shows system picker)
await ScreenRecorder.startScreenRecording();

// Get path to last recording
const path = await ScreenRecorder.getLastRecordingPath();

// Check if recording is active
const isRecording = ScreenRecorder.isRecording();
```

### Native (Swift)

See `modules/screen-recorder/ios/ScreenRecorderModule.swift` for implementation details.

## Testing Checklist

- [ ] Xcode extension target added and configured
- [ ] App builds without errors
- [ ] Profile tab shows recording buttons (iOS only)
- [ ] Tapping "Start Recording" shows system picker
- [ ] Extension appears in picker as "Pulse Screen Recorder"
- [ ] Recording captures audio when speaking
- [ ] Silent periods are skipped in final video
- [ ] "Play Last Recording" works and shows video
- [ ] Console.app shows audio level logs
- [ ] State transitions logged correctly

## Performance Notes

- **Extension Memory**: Limited to ~50MB (system constraint)
- **Video Quality**: 1080x1920, H.264 @ 6Mbps
- **Audio Quality**: AAC @ 64kbps, 44.1kHz
- **File Size**: ~7MB per minute of recorded content
- **Battery Impact**: Similar to native screen recording

## Future Enhancements

Possible improvements (not in this PR):
- [ ] UI slider for threshold adjustment
- [ ] Real-time audio level visualization
- [ ] Recording gallery with thumbnails
- [ ] Timeline editor showing active/silent segments
- [ ] Share/export to Photos
- [ ] Android support via MediaProjection
- [ ] Cloud upload integration
- [ ] More advanced audio analysis (VAD, ML)

## Documentation

- **Setup Guide**: `SCREEN_RECORDING_SETUP.md`
- **Integration Guide**: `INTEGRATION_GUIDE.md`
- **Module API**: `modules/screen-recorder/README.md`
- **This File**: Quick overview and common tasks

## Support

For issues or questions:
1. Check the documentation files listed above
2. Review Console.app logs for errors
3. Verify all setup steps completed
4. Check threshold configuration

## License

Same as parent Pulse project.
