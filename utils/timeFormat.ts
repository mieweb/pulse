/**
 * Formats milliseconds into a human-readable time string with centiseconds
 * @param ms - Time in milliseconds
 * @returns Formatted string in format "M:SS.cs" where cs represents 10ms units (hundredths of a second)
 */
export function formatTimeMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const centiseconds = Math.floor((ms % 1000) / 10); // Divide by 10 to get 10ms units
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${centiseconds
    .toString()
    .padStart(2, "0")}`;
}

/**
 * Formats seconds into a human-readable time string
 * @param seconds - Time in seconds
 * @returns Formatted string in format "M:SS"
 */
export function formatTimeSeconds(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Calculates the total duration of segments considering trim points
 * @param segments - Array of segments with optional inMs/outMs trim points
 * @returns Total duration in seconds
 */
export function calculateSegmentsDuration(
  segments: Array<{
    duration: number;
    inMs?: number;
    outMs?: number;
  }>
): number {
  return segments.reduce((total: number, seg) => {
    if (seg.inMs !== undefined || seg.outMs !== undefined) {
      const start = seg.inMs || 0;
      const end = seg.outMs || seg.duration * 1000;
      return total + (end - start) / 1000;
    }
    return total + seg.duration;
  }, 0);
}
