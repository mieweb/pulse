/** Keep enough video for native controls when enlarged text or the keyboard requires scrolling. */
const MIN_VIDEO_HEIGHT = 160;

/**
 * Fit a portrait export into the space left after the actual export controls and safe area.
 * Chrome includes measured metadata and the lower playback row, with their gaps to the video.
 * The minimum is only a scrolling fallback: ordinary portrait layouts use the remaining space.
 */
export function exportPreviewSize(width: number, availableHeight: number, chromeHeight: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(availableHeight) ||
    !Number.isFinite(chromeHeight) ||
    width <= 0 ||
    chromeHeight < 0
  ) {
    return { width: 0, height: 0 };
  }
  const videoHeight = Math.max(MIN_VIDEO_HEIGHT, availableHeight - chromeHeight);
  const videoWidth = Math.max(0, Math.min(width, (videoHeight * 9) / 16));
  return { width: videoWidth, height: (videoWidth * 16) / 9 };
}
