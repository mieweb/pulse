# Screen Recorder Module

Audio-gated screen recording for iOS using ReplayKit.

## Overview

This native module enables screen recording on iOS that automatically skips silent periods. It uses ReplayKit's Broadcast Upload Extension to capture screen and audio in real-time, and only writes video frames when audio is above a configurable threshold.

## Features

- 🎙️ **Audio-Gated Recording**: Only records when you speak
- 🔇 **Auto-Skip Silence**: Silent periods are automatically removed from the final video
- ⚙️ **Configurable Thresholds**: Tune audio sensitivity and transition timings
- 📱 **System Integration**: Uses iOS native ReplayKit broadcast picker
- 🎬 **High Quality**: H.264 video with AAC audio
- 🔐 **Secure**: Uses app groups for data isolation

## API

### `startScreenRecording(): Promise<boolean>`

Presents the iOS system broadcast picker UI. User must select the Pulse Screen Recorder extension and start the broadcast.

```typescript
import ScreenRecorder from '@/modules/screen-recorder';

await ScreenRecorder.startScreenRecording();
```

### `getLastRecordingPath(): Promise<string | null>`

Returns the file path of the most recent recording, or null if no recordings exist.

```typescript
const path = await ScreenRecorder.getLastRecordingPath();
if (path) {
  console.log('Last recording:', path);
}
```

### `isRecording(): boolean`

Checks if a recording is currently in progress.

```typescript
const recording = ScreenRecorder.isRecording();
```

## Setup

See `SCREEN_RECORDING_SETUP.md` in the project root for complete setup instructions.

### Quick Start

1. Add Broadcast Extension target in Xcode
2. Configure app groups
3. Install pods: `cd ios && pod install`
4. Build and run

## Configuration

Edit `ios/BroadcastExtension/SampleHandler.swift` to tune these values:

```swift
// Audio threshold (RMS) - typical speech is 0.02-0.1
private let audioThreshold: Float = 0.02

// Time above threshold before starting to record (seconds)
private let minActiveTransitionDuration: TimeInterval = 0.3

// Time below threshold before stopping (seconds)
private let minSilentTransitionDuration: TimeInterval = 0.7
```

## Usage Example

```typescript
import React, { useState } from 'react';
import { Button, Alert } from 'react-native';
import ScreenRecorder from '@/modules/screen-recorder';

function RecordingButton() {
  const handleRecord = async () => {
    try {
      await ScreenRecorder.startScreenRecording();
      Alert.alert('Select Pulse Screen Recorder to begin');
    } catch (error) {
      Alert.alert('Error', 'Failed to start recording');
    }
  };
  
  const handlePlayback = async () => {
    const path = await ScreenRecorder.getLastRecordingPath();
    if (path) {
      // Play the video using your preferred video player
      console.log('Playing:', path);
    }
  };
  
  return (
    <>
      <Button title="Start Recording" onPress={handleRecord} />
      <Button title="Play Last Recording" onPress={handlePlayback} />
    </>
  );
}
```

## How It Works

### Architecture

1. **Main App**: Triggers the system broadcast picker
2. **Broadcast Extension**: Runs in a separate process, receives screen/audio samples
3. **App Group**: Shared container for storing recordings and state

### Audio Processing

The extension processes each audio buffer:
1. Calculate RMS (Root Mean Square) audio level
2. Compare to threshold
3. Apply hysteresis to prevent rapid state changes
4. Update recording state (active/silent)

### Video Processing

Video frames are only written when in "active" state. This creates a final video with silent periods removed.

### State Machine

```
         audio > threshold          
         (for 0.3s)
SILENT ──────────────────→ ACTIVE
       ←──────────────────
         audio < threshold
         (for 0.7s)
```

## Debugging

### View Logs

Open Console.app on macOS:
1. Connect iOS device
2. Filter by process: `BroadcastExtension`
3. Look for audio level logs

### Common Issues

**Module not found**
- Run `pod install` in ios directory
- Ensure expo autolinking is working

**No recordings created**
- Check audio threshold isn't too high
- Verify you spoke during recording
- Check Console.app for errors

**Poor audio detection**
- Adjust `audioThreshold` value
- Check RMS levels in Console logs
- Increase hysteresis durations for stability

## Technical Details

### Audio Level Calculation

```swift
// Calculate RMS of Int16 audio samples
let samples = UnsafeBufferPointer<Int16>(...)
var sum: Float = 0
for sample in samples {
    let normalized = Float(sample) / Float(Int16.max)
    sum += normalized * normalized
}
let rms = sqrt(sum / Float(samples.count))
```

### File Storage

Recordings are stored in:
```
App Group Container/Recordings/recording-<timestamp>.mp4
```

Format: `recording-2025-01-15T12:30:45Z.mp4`

### Limitations

- iOS only (ReplayKit is iOS-specific)
- Requires physical device (simulator doesn't support ReplayKit)
- Broadcast extension runs in separate process (limited memory)
- No access to camera or hardware buttons in extension

## Future Enhancements

- [ ] Adjustable threshold via UI
- [ ] Real-time audio level visualization
- [ ] Recording gallery/management
- [ ] Export/share functionality
- [ ] Timeline editor
- [ ] Android support
- [ ] More advanced audio analysis (VAD, spectral analysis)

## License

Same as parent project.
