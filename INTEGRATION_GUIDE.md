# Audio-Gated Screen Recording - Integration Guide

## Quick Reference

This implementation provides iOS screen recording that automatically skips silent periods using ReplayKit.

### Files Added

```
modules/screen-recorder/
├── index.ts                           # Module entry point
├── package.json                       # Module metadata
├── expo-module.config.json           # Expo module configuration
├── README.md                         # Module documentation
├── src/
│   ├── ScreenRecorder.types.ts      # TypeScript types
│   └── ScreenRecorderModule.ts      # Native module bridge
└── ios/
    ├── ScreenRecorder.podspec        # CocoaPods spec
    └── ScreenRecorderModule.swift    # Main native module

ios/BroadcastExtension/
├── SampleHandler.swift               # Broadcast handler (audio-gating logic)
├── Info.plist                        # Extension configuration
└── BroadcastExtension.entitlements   # App group entitlements

ios/pulse/
└── pulse.entitlements                # Updated with app group

app/(tabs)/
└── profile.tsx                       # Updated with recording UI

SCREEN_RECORDING_SETUP.md             # Detailed setup instructions
scripts/add_broadcast_extension_target.py  # Setup helper script
```

## Implementation Status

✅ **Complete**
- Native module implementation
- Broadcast extension with audio-gating logic
- React Native UI integration
- Documentation and setup guides
- App group configuration files

⚠️ **Requires Manual Setup**
- Adding Broadcast Extension target in Xcode
- Configuring signing & capabilities
- Building the extension

## Next Steps

### For the Developer Integrating This Feature

1. **Review the Documentation**
   - Read `SCREEN_RECORDING_SETUP.md` for complete setup instructions
   - Review `modules/screen-recorder/README.md` for API documentation

2. **Complete Xcode Setup**
   ```bash
   # Open Xcode
   open ios/pulse.xcworkspace
   
   # Follow the steps in SCREEN_RECORDING_SETUP.md to:
   # - Add Broadcast Extension target
   # - Configure capabilities
   # - Link source files
   ```

3. **Install Dependencies**
   ```bash
   cd ios
   pod install
   cd ..
   ```

4. **Build and Test**
   ```bash
   npm run ios
   
   # Must use a physical iOS device (ReplayKit doesn't work on simulator)
   # Navigate to Profile tab
   # Try the recording buttons
   ```

### For Testing

**Test Scenario 1: Basic Functionality**
1. Start recording via Profile tab
2. Select "Pulse Screen Recorder" from system picker
3. Wait 2 seconds silently → should not be in final video
4. Speak for 3 seconds → should be in final video
5. Wait 2 seconds silently → should not be in final video
6. Speak for 3 seconds → should be in final video
7. Stop recording via Control Center
8. Play back via "Play Last Recording"
9. Expected: ~6 second video (only the speaking parts)

**Test Scenario 2: Threshold Tuning**
- If too much silence: Increase `audioThreshold` in SampleHandler.swift
- If speech is cut: Decrease `audioThreshold`
- If flapping between states: Increase hysteresis durations

**Debugging**
```bash
# View extension logs in real-time
# 1. Connect iOS device
# 2. Open Console.app on Mac
# 3. Filter: process:BroadcastExtension
# 4. Look for:
#    [BroadcastExtension] Audio level: 0.0234
#    [BroadcastExtension] State transition: silent -> active
```

## Code Review Checklist

- [x] TypeScript types defined
- [x] Native module follows Expo modules pattern
- [x] Swift code uses modern async/await patterns
- [x] Error handling in place
- [x] Platform checks in UI code
- [x] App groups configured for data sharing
- [x] Debug logging for troubleshooting
- [x] Documentation complete
- [x] No new linting errors

## Architecture Decisions

### Why ReplayKit?
- System-level screen capture (works across all apps)
- Built-in iOS support
- Handles screen orientation and resolution automatically

### Why Broadcast Upload Extension?
- Real-time access to screen and audio samples
- Can process samples before writing (enables audio-gating)
- Runs in separate process (doesn't impact app performance)

### Why RMS for Audio Level?
- Simple, fast calculation
- Good indicator of perceived loudness
- Standard approach for audio level metering

### Why Hysteresis?
- Prevents rapid state changes
- Avoids choppy video from brief pauses
- Creates more natural feeling transitions

## Limitations

1. **iOS Only**: ReplayKit is Apple-specific
2. **Physical Device Only**: Simulator doesn't support screen recording
3. **Manual Xcode Setup**: Cannot fully automate extension target creation
4. **No Camera Access**: Broadcast extensions can't access camera
5. **Memory Constraints**: Extension process has limited memory

## Future Improvements

### Short-term (Easy Wins)
- [ ] Add UI slider for threshold adjustment
- [ ] Show real-time audio level indicator during recording
- [ ] Add recording duration indicator
- [ ] Better error messages

### Medium-term (Enhanced Features)
- [ ] Recording gallery with thumbnails
- [ ] Share/export functionality
- [ ] Multiple quality presets
- [ ] Background audio mixing

### Long-term (Major Features)
- [ ] Timeline editor for recordings
- [ ] Android support via MediaProjection
- [ ] Cloud upload integration
- [ ] Advanced audio analysis (VAD, noise cancellation)
- [ ] Post-processing pipeline

## Support

### Common Issues

**"Module not found"**
- Ensure `pod install` was run
- Check that Expo autolinking is working
- Verify module appears in `ios/Pods`

**"Extension not appearing in picker"**
- Extension target must be built
- Bundle ID must match: `com.mieweb.pulse.BroadcastExtension`
- Extension must be embedded in app

**"No video created"**
- Audio threshold too high (lower it)
- No audio detected (check microphone permissions)
- Check Console.app for errors

**"Recording has silent parts"**
- Audio threshold too low (raise it)
- Hysteresis too long (shorten it)
- RMS calculation may need tuning

### Getting Help

1. Check Console.app logs for the extension
2. Review `SCREEN_RECORDING_SETUP.md`
3. Check module README for API examples
4. Verify all Xcode setup steps completed

## Credits

Implementation based on:
- Apple ReplayKit documentation
- Expo Modules Core patterns
- Best practices for audio level detection

## License

Same as parent Pulse project.
