# Video Orientation Fix Test Plan

## Issue Fixed
Fixed merged video orientation not being correct when concatenating multiple video segments with different orientations.

## Key Changes Made

### 1. Added Per-Segment Metadata Collection
- Added `SegmentMetadata` structure to track individual segment properties:
  - `timeRange`: The time range of the segment in the final composition
  - `preferredTransform`: The original video transform (contains orientation info)
  - `naturalSize`: The natural dimensions of the video

### 2. Modified Segment Processing
- Updated `processVideoSegment` function to collect and return metadata for each segment
- Each segment now preserves its individual orientation information

### 3. Per-Segment Video Composition Instructions
- Updated `createVideoComposition` to create individual `AVMutableVideoCompositionInstruction` objects
- Each instruction applies the correct transform for its specific time range
- No more single transform applied to entire composition

## Testing the Fix

### Prerequisites
1. Two or more video files with different orientations (e.g., one portrait, one landscape)
2. Videos should be accessible to the VideoConcatModule

### Test Steps
1. **Record/Prepare Test Videos:**
   - Video 1: Portrait orientation (e.g., recorded holding phone vertically)
   - Video 2: Landscape orientation (e.g., recorded holding phone horizontally)

2. **Use VideoConcatModule to Merge:**
   ```typescript
   import { VideoConcat } from './modules/video-concat';
   
   const segments = [
     { id: '1', uri: 'file://path/to/portrait-video.mov', duration: 5.0 },
     { id: '2', uri: 'file://path/to/landscape-video.mov', duration: 3.0 }
   ];
   
   const mergedVideoPath = await VideoConcat.export(segments);
   ```

3. **Verify Results:**
   - Each segment in the merged video should maintain its original orientation
   - Portrait segments should appear correctly oriented (not sideways)
   - Landscape segments should appear correctly oriented
   - No rotation artifacts or incorrect orientations

### Expected Behavior

#### Before Fix:
- All segments would inherit the orientation of the first video
- Segments with different orientations would appear rotated incorrectly
- E.g., if first video was portrait, all landscape segments would appear sideways

#### After Fix:
- Each segment maintains its individual orientation
- Portrait videos appear in correct portrait orientation
- Landscape videos appear in correct landscape orientation
- Smooth transitions between different orientations

## Technical Details

The fix works by:
1. **Collecting Transform Data**: During segment processing, we extract each video's `preferredTransform` which contains the rotation/orientation information
2. **Creating Per-Segment Instructions**: Instead of one composition instruction for the entire video, we create separate instructions for each segment's time range
3. **Applying Individual Transforms**: Each instruction applies the specific transform needed for that segment's orientation

This approach ensures that AVFoundation applies the correct orientation transform to each segment independently, preserving the original orientations in the final merged video.