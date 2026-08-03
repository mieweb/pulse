import type { CompressOptions, VideoProbeResult } from 'react-native-video-trim';

import { displaySize, effectiveFps, HDR_TRANSFERS, is10Bit } from './import-normalization';

/**
 * The upload contract (§ playback).
 *
 * Everything PulseCam uploads must satisfy:
 *
 *     H.264 · long edge <= 1920 · <= 5 Mbps · AAC · faststart
 *
 * This is not a new target — it is what the recorder already asks for
 * (`useVideoOutput` in use-recorder.ts) and what PulseClip's own exports already
 * produce. The difference is that this module *enforces* it.
 *
 * Why enforcement is needed at all, measured on real recordings from two builds:
 *
 *              resolution      bitrate      codec   faststart   container
 *   pre-07-21  3840x2160    28.80 Mbps       hevc          no          qt
 *   2026-07-29 1920x1080     8.24 Mbps       hevc          no          qt
 *
 * The resolution breach is fixed — VisionCamera 5.2.0 rescored the format vote that the
 * recorder's `targetResolution` participates in, so 1080p now wins it. Everything else
 * still breaches: the bitrate lands 65% over a pin that has been set since 07-20, the
 * codec is HEVC (fine on iOS, undecodable in Android Chrome), and the index is written
 * at the end of the file.
 *
 * That is the case for a gate rather than a set of settings. `targetResolution` was
 * silently ignored for weeks; `targetBitRate` and `fileType` still are. Each is a
 * request to a subsystem that may or may not honour it, on hardware we have not tested.
 * A probe-and-transcode gate does not ask.
 *
 * So: the recorder pin makes the common case FREE (a compliant file passes through
 * untouched), and this gate makes every case CORRECT. Keep both. Neither replaces
 * the other.
 *
 * How this differs from {@link decideImport}, which enforces a similar-looking policy
 * at the Photos-import boundary:
 *
 * - **HEVC is not acceptable here.** Imports may keep it (iOS decodes it natively and
 *   the merge engine's fast path likes format-uniform clips), but an upload is watched
 *   in a browser, and Android Chrome will not decode HEVC at any size. Uploads convert.
 * - **The bitrate ceiling is tighter** — an upload is streamed over a phone network,
 *   not read off local flash.
 *
 * Faststart is deliberately absent from the decision below: `moov` placement is not
 * visible in a `probeVideo()` result. It is guaranteed on the writing side instead —
 * the export/merge/compress paths emit it — because a file that is otherwise compliant
 * should not be re-encoded just to move its index.
 */

/** Long-edge cap. A 1080p long edge is 4x fewer pixels than 4K — the single biggest win. */
export const UPLOAD_MAX_LONG_EDGE = 1920;
/** Re-encode target when a clip breaches the contract. Matches the recorder's own pin. */
export const UPLOAD_TARGET_BITRATE = 5_000_000;
/**
 * Re-encode trigger, deliberately above {@link UPLOAD_TARGET_BITRATE}. A clip that is
 * already close to target is left alone: re-encoding 5.4 Mbps down to 5.0 costs a full
 * transcode and a generation of quality to save ~7% of the bytes. Only a real breach
 * (a 4K master at 23 Mbps) is worth the pass.
 */
export const UPLOAD_MAX_BITRATE = 6_500_000;
/** Frame-rate ceiling: passes 29.97/30 with margin, catches 60/120 (slo-mo, screen caps). */
export const UPLOAD_MAX_FPS = 33;
/** Re-encode target frame rate. */
export const UPLOAD_TARGET_FPS = 30;
/** The one codec that plays everywhere the browser lane cares about, Android Chrome included. */
export const UPLOAD_VIDEO_CODEC = 'h264';
/** The one audio codec that is MP4-muxable by stream copy across our paths. */
export const UPLOAD_AUDIO_CODEC = 'aac';

export type UploadContractDecision =
  | { action: 'passthrough' }
  | { action: 'normalize'; options: Partial<CompressOptions>; reasons: string[] };

/**
 * Effective video bitrate in bits per second.
 *
 * `probe.bitrate` is the *stream* bitrate and is `-1` when the container does not
 * declare one — which is exactly the case for some camera-written MP4s, i.e. the files
 * this gate exists to catch. Falling back to size/duration slightly overstates the
 * video rate (it includes audio and container overhead), but it overstates in the safe
 * direction: it can only push a borderline file towards being normalized, never away.
 *
 * Returns `-1` when neither source is usable, which the caller treats as "unknown" —
 * an unknown bitrate is not by itself grounds to re-encode.
 */
export function effectiveBitrate(probe: VideoProbeResult): number {
  if (probe.bitrate > 0) return probe.bitrate;
  const seconds = probe.duration / 1000;
  if (seconds > 0 && probe.fileSize > 0) return (probe.fileSize * 8) / seconds;
  return -1;
}

/**
 * Decide how a file must be conditioned before it is uploaded: send the original bytes,
 * conform only its audio, or re-encode it into the contract.
 *
 * Pure — feed it a `probeVideo()` result. The caller (`ensureUploadContract`) owns the
 * file I/O; keeping the policy pure is what makes it testable without a device.
 */
export function decideUploadContract(probe: VideoProbeResult): UploadContractDecision {
  // No video stream to constrain (audio-only artifacts ride other paths). Nothing to do.
  if (!probe.hasVideo) return { action: 'passthrough' };

  const reasons: string[] = [];

  if (probe.videoCodec !== UPLOAD_VIDEO_CODEC) {
    // Includes HEVC, which is the common case: it is what the iPhone records by default,
    // it is fine on iOS, and it is undecodable in Android Chrome.
    reasons.push(`video codec ${probe.videoCodec || 'unknown'}`);
  }

  const display = displaySize(probe);
  const longEdge = Math.max(display.width, display.height);
  const needsDownscale = longEdge > UPLOAD_MAX_LONG_EDGE;
  if (needsDownscale) {
    reasons.push(`${display.width}x${display.height} exceeds ${UPLOAD_MAX_LONG_EDGE}`);
  }

  const bitrate = effectiveBitrate(probe);
  if (bitrate > UPLOAD_MAX_BITRATE) {
    reasons.push(
      `${(bitrate / 1_000_000).toFixed(1)} Mbps exceeds ${UPLOAD_MAX_BITRATE / 1_000_000}`,
    );
  }

  const fps = effectiveFps(probe);
  if (fps > UPLOAD_MAX_FPS) {
    reasons.push(`${Math.round(fps)} fps exceeds ${UPLOAD_MAX_FPS}`);
  }

  // 10-bit / HDR: hardware H.264 encoders reject 10-bit input, and an HDR clip tone-maps
  // unpredictably in a browser. Both force the SDR 8-bit re-encode.
  if (is10Bit(probe.pixelFormat)) {
    reasons.push(`10-bit pixel format ${probe.pixelFormat}`);
  }
  if (HDR_TRANSFERS.has(probe.colorTransfer)) {
    reasons.push(`HDR transfer ${probe.colorTransfer}`);
  }

  const audioHostile = probe.hasAudio && probe.audioCodec !== UPLOAD_AUDIO_CODEC;

  if (reasons.length === 0) {
    if (audioHostile) {
      // Video already satisfies the contract — stream-copy it and pay only for the audio.
      return {
        action: 'normalize',
        options: { copyVideo: true },
        reasons: [`audio codec ${probe.audioCodec}`],
      };
    }
    return { action: 'passthrough' };
  }

  if (audioHostile) {
    reasons.push(`audio codec ${probe.audioCodec}`);
  }

  const options: Partial<CompressOptions> = {
    codec: UPLOAD_VIDEO_CODEC,
    bitrate: UPLOAD_TARGET_BITRATE,
    frameRate: UPLOAD_TARGET_FPS,
  };
  if (needsDownscale) {
    // FFmpeg auto-rotates before filters run, so the cap is applied against DISPLAY
    // orientation: pin the long edge, let the other follow the aspect ratio (-2). Pinning
    // width unconditionally would upscale a portrait clip to 1920 wide — 4x the pixels
    // the contract is trying to remove.
    if (display.width >= display.height) {
      options.width = UPLOAD_MAX_LONG_EDGE;
    } else {
      options.height = UPLOAD_MAX_LONG_EDGE;
    }
  }

  return { action: 'normalize', options, reasons };
}
