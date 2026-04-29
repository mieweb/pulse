# Video Postprocess Module

Native Expo module for post-processing video clips with silence removal and pitch-preserving speed adjustment.

## Features

- **Silence Removal**: Automatically detects and removes silent portions of video clips using audio amplitude analysis
- **Pitch-Preserving Speed Adjustment**: Speed up or slow down video while maintaining natural audio pitch
- **Batch Processing**: Process multiple clips at once
- **Progress Events**: Real-time progress updates during processing
- **Configurable**: Customize silence threshold, minimum silence duration, and speed factor

## Usage

### Process a Single Clip

```typescript
import VideoPostprocess from '@/modules/video-postprocess';

const result = await VideoPostprocess.processClip(
  inputURL,
  outputURL,
  {
    speedFactor: 1.15,        // 1.0-2.0x speed (default: 1.15)
    silenceThreshold: -40,     // dB (default: -40)
    minSilenceDuration: 500    // ms (default: 500)
  }
);
```

### Process Multiple Clips

```typescript
const results = await VideoPostprocess.processClips(
  [inputURL1, inputURL2, inputURL3],
  outputDirectory,
  {
    speedFactor: 1.2,
    silenceThreshold: -35,
    minSilenceDuration: 400
  }
);
```

### Listen to Progress Events

```typescript
VideoPostprocess.addListener('onProgress', (event) => {
  console.log(`Progress: ${event.progress * 100}%`);
  console.log(`Phase: ${event.phase}`);
});
```

## Progress Phases

- `analyzing`: Analyzing audio for silence periods
- `removing_silence`: Removing detected silence from the clip
- `adjusting_speed`: Applying speed adjustment with pitch preservation
- `finalizing`: Exporting the final processed video

## Parameters

### PostprocessOptions

- **speedFactor** (optional): Speed multiplier (1.0-2.0)
  - `1.0` = normal speed
  - `1.15` = 15% faster (default)
  - `2.0` = 2x speed
  
- **silenceThreshold** (optional): Audio threshold in dB for silence detection
  - Default: `-40` dB
  - Lower values = more aggressive silence removal
  
- **minSilenceDuration** (optional): Minimum duration of silence to remove (in milliseconds)
  - Default: `500` ms
  - Prevents choppy micro-cuts

## Implementation Details

### Silence Detection

The module uses AVAssetReader to analyze audio samples and detect silence based on RMS (Root Mean Square) amplitude. Silence periods are detected with hysteresis to avoid choppy cuts.

### Speed Adjustment

Speed adjustment is applied using AVFoundation's time scaling capabilities:
- Video track is time-scaled
- Audio track is time-scaled while preserving pitch
- Natural sounding audio at different speeds

### Processing Pipeline

1. **Load asset**: Load the input video file
2. **Analyze silence**: Process audio to detect silent periods
3. **Remove silence**: Create composition excluding silent segments
4. **Apply speed**: Scale time while preserving pitch
5. **Export**: Save the processed video to output URL

## Platform Support

- ✅ iOS (AVFoundation)
- ❌ Android (not implemented)
- ❌ Web (not supported)

## Testing

Run the test suite:

```bash
cd test/video
swift RunPostprocessTests.swift
```

Test files should be placed in the `test/video/` directory and named `recording1.mov`, etc.
