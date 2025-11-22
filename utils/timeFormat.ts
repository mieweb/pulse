/**
 * Formats milliseconds into a human-readable time string with milliseconds
 * @param ms - Time in milliseconds
 * @returns Formatted string in format "M:SS.mm" where mm is centiseconds (hundredths)
 */
export function formatTimeMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = Math.floor((ms % 1000) / 10);
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${milliseconds
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
