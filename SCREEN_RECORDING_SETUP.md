# Audio-Gated Screen Recording Setup Guide

This guide explains how to complete the setup of the audio-gated screen recording feature in Pulse.

## Overview

The screen recording feature uses ReplayKit's Broadcast Upload Extension to capture the iOS screen and microphone audio. It only records video segments when audio is above a configurable threshold, effectively creating an "auto-edited" video that skips silent periods.

## Architecture

1. **Main App (pulse)**: Contains the UI and native module that triggers the broadcast picker
2. **Broadcast Extension**: Processes screen and audio samples in real-time, implementing the audio-gating logic
3. **App Group**: Shared container for communication between app and extension

## Manual Setup Required

Because Xcode project modifications require manual steps, you'll need to complete the following in Xcode:

### Step 1: Add Broadcast Upload Extension Target

1. Open `ios/pulse.xcworkspace` in Xcode
2. File → New → Target
3. Choose "Broadcast Upload Extension" template
4. Configure:
   - Product Name: `BroadcastExtension`
   - Language: Swift
   - Bundle Identifier: `com.mieweb.pulse.BroadcastExtension`
   - Embed In Application: `pulse`
5. Click Finish
6. Delete the automatically generated `SampleHandler.swift` file (we have our own)

### Step 2: Configure Broadcast Extension Target

1. Select the `BroadcastExtension` target in Xcode
2. **General Tab**:
   - Deployment Info → iOS 15.1 or higher
3. **Signing & Capabilities**:
   - Add Capability → App Groups
   - Enable: `group.com.mieweb.pulse.screenrecorder`
4. **Build Settings**:
   - Set `SWIFT_VERSION` to 5.0 or higher
5. **Build Phases** → Compile Sources:
   - Add `ios/BroadcastExtension/SampleHandler.swift`
6. **Info.plist**:
   - Use the file at `ios/BroadcastExtension/Info.plist`
7. **Entitlements**:
   - Use the file at `ios/BroadcastExtension/BroadcastExtension.entitlements`

### Step 3: Configure Main App Target

The main app target (`pulse`) should already have:
- App Groups capability with `group.com.mieweb.pulse.screenrecorder` (added to entitlements)
- The native module integrated via Expo autolinking

### Step 4: Install Dependencies

```bash
cd ios
pod install
cd ..
```

### Step 5: Build and Run

```bash
npm run ios
```

## Usage

1. Open the Pulse app
2. Navigate to the Profile tab
3. Tap "📹 Start Screen Recording"
4. In the system picker, select "Pulse Screen Recorder"
5. Tap "Start Broadcast"
6. The app will now record, but only when audio is detected
7. Stop recording via Control Center (tap the red recording indicator)
8. Tap "▶️ Play Last Recording" to view the result

## How It Works

### Audio-Gating Logic

The `SampleHandler` in the broadcast extension implements a state machine:

- **Silent State**: Audio is below threshold
  - Video and audio frames are dropped
  - Must detect audio above threshold for 0.3s to transition to active
  
- **Active State**: Audio is above threshold
  - Video and audio frames are written to output file
  - Must detect audio below threshold for 0.7s to transition back to silent

### Configuration

You can tune these values in `ios/BroadcastExtension/SampleHandler.swift`:

```swift
private let audioThreshold: Float = 0.02  // RMS threshold (0.02 = typical speech)
private let minActiveTransitionDuration: TimeInterval = 0.3  // Delay before starting to record
private let minSilentTransitionDuration: TimeInterval = 0.7  // Delay before stopping
```

### Audio Level Calculation

Audio level is calculated as RMS (Root Mean Square) of the audio samples:
- Typical background noise: 0.005 - 0.015
- Normal speech: 0.02 - 0.1
- Loud speech/music: 0.1 - 0.5

## Testing

### Test Scenario 1: Basic Recording
1. Start recording
2. Wait 2 seconds (should be silent → not recorded)
3. Speak for 3 seconds
4. Wait 2 seconds again
5. Speak for 3 seconds
6. Stop recording
7. Expected result: ~6 second video (two 3-second segments)

### Test Scenario 2: Threshold Tuning
- If too much silence is recorded: Increase `audioThreshold`
- If speech is being cut off: Decrease `audioThreshold`
- If transitions are too abrupt: Increase hysteresis durations

## Debugging

### Enable Debug Logging

The broadcast extension logs to the system console. To view:

1. Open Console.app on macOS
2. Connect your iOS device
3. Filter by process: `BroadcastExtension`
4. Look for logs like:
   ```
   [BroadcastExtension] Audio level: 0.0234, threshold: 0.0200, state: active
   [BroadcastExtension] State transition: silent -> active
   ```

### Common Issues

**"Screen Recorder module not available"**
- The native module isn't linked properly
- Run `pod install` in ios directory
- Clean and rebuild the app

**"No recordings found"**
- Check that app group is configured correctly on both targets
- Verify the extension is actually running (check Console.app)
- Make sure you spoke during recording (audio threshold met)

**Recording has no video**
- Audio threshold may be too high
- Check Console.app for audio level readings
- Verify you selected the correct extension in the broadcast picker

## File Locations

- Native Module: `modules/screen-recorder/ios/ScreenRecorderModule.swift`
- Broadcast Handler: `ios/BroadcastExtension/SampleHandler.swift`
- UI Component: `app/(tabs)/profile.tsx`
- Shared Recordings: App Group Container → `Recordings/` folder

## Future Enhancements (Out of Scope for PoC)

- [ ] Adjustable threshold via UI
- [ ] Visual feedback of audio levels during recording
- [ ] Gallery view of all recordings
- [ ] Share/export functionality
- [ ] Timeline view showing active/silent segments
- [ ] Android support via MediaProjection API
- [ ] More sophisticated audio analysis (VAD, silence detection)
