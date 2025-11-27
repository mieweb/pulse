import { RecordingSegment } from "@/components/RecordingProgressBar";
import VideoConcatModule from "@/modules/video-concat";

/**
 * Gets exact duration from AVFoundation for a segment.
 * Handles both full duration and trimmed duration (when inMs/outMs are set).
 *
 * @param segment - The recording segment to get duration for
 * @returns Duration in seconds from AVFoundation
 */
export async function getExactSegmentDuration(
  segment: RecordingSegment
): Promise<number> {
  try {
    const duration = await VideoConcatModule.getVideoDuration(
      segment.uri,
      segment.inMs ?? null,
      segment.outMs ?? null
    );
    return duration;
  } catch (error) {
    console.error("Failed to get exact duration from AVFoundation:", error);
    // Fallback to calculated duration from segment
    if (segment.inMs !== undefined || segment.outMs !== undefined) {
      const start = segment.inMs ?? 0;
      const end = segment.outMs ?? segment.duration * 1000;
      return (end - start) / 1000;
    }
    return segment.duration;
  }
}

/**
 * Updates a segment with exact duration from AVFoundation.
 * This ensures segment.duration matches what merge will produce.
 *
 * @param segment - The recording segment to update
 * @returns Updated segment with exact duration
 */
export async function updateSegmentWithExactDuration(
  segment: RecordingSegment
): Promise<RecordingSegment> {
  const exactDuration = await getExactSegmentDuration(segment);
  return {
    ...segment,
    duration: exactDuration,
  };
}

/**
 * Formats duration for display in general UI (rounded to seconds).
 *
 * @param seconds - Duration in seconds
 * @returns Formatted string in "M:SS" format
 */
export function formatDurationForDisplay(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Formats duration for split/trim screens with milliseconds for precision.
 *
 * @param seconds - Duration in seconds
 * @returns Formatted string in "M:SS.mmm" format
 */
export function formatDurationForSplitTrim(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${mins}:${secs.toString().padStart(2, "0")}.${ms
    .toString()
    .padStart(3, "0")}`;
}

/**
 * Gets exact full duration (without trim points) from AVFoundation.
 *
 * @param uri - Video file URI
 * @returns Full duration in seconds from AVFoundation
 */
export async function getExactFullDuration(uri: string): Promise<number> {
  try {
    const duration = await VideoConcatModule.getVideoDuration(uri, null, null);
    return duration;
  } catch (error) {
    console.error("Failed to get full duration from AVFoundation:", error);
    throw error;
  }
}
