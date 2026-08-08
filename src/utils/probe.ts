import type { VideoProbeResult } from 'react-native-video-trim';

/**
 * Shared readers for `probeVideo()` results.
 *
 * Both policy modules that interpret a probe — `import-normalization.ts` (what may enter a
 * draft) and `features/upload/upload-contract.ts` (what may leave the device) — need the same
 * low-level answers: real display geometry, effective frame rate, bit depth, HDR-ness. They
 * live here so the upload contract does not have to reach into the import pipeline for them,
 * and so the two policies cannot silently drift apart on how they read the same probe.
 */

/** HDR transfer functions: HLG (iPhone camera default) and PQ (HDR10 / Dolby Vision 8.x). */
export const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']);

/**
 * True for 10-bit pixel formats. FFmpeg names these with a `10`/`10le`/`10be` bit-depth
 * suffix (yuv420p10le, p010le, ...) — matching the suffix rather than a bare `includes('10')`
 * keeps 8-bit chroma-subsampling names like `yuv410p` from being misclassified.
 */
export function is10Bit(pixelFormat: string): boolean {
  return /10(le|be)?$/.test(pixelFormat);
}

/** Effective fps for the decision: average when known (catches VFR), else nominal. */
export function effectiveFps(probe: VideoProbeResult): number {
  return probe.averageFps > 0 ? probe.averageFps : probe.nominalFps;
}

/** Display (post-rotation) dimensions: a 90/270 rotation swaps coded width/height. */
export function displaySize(probe: VideoProbeResult): { width: number; height: number } {
  const swapped = probe.rotation % 180 !== 0;
  return {
    width: swapped ? probe.height : probe.width,
    height: swapped ? probe.width : probe.height,
  };
}
