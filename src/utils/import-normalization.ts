import type { ProbeAudio, ProbeResult, ProbeVideo } from 'pulse-editor';
import type { CompressOptions } from 'react-native-video-trim';

/**
 * Import normalization policy (§ imports).
 *
 * Two jobs, one decision:
 *
 * 1. The REELS CONTRACT (display-level) — every stored clip must be something the merge,
 *    upload and every browser can take: H.264, 8-bit SDR, AAC, displaying exactly the 1080×1920
 *    portrait canvas, ≤30 fps (after the merge pin's rounding), a bounded bitrate. Hostile
 *    inputs are re-encoded:
 *    - non-H.264 video — HEVC included: iPhone Photos imports are HEVC, which Firefox never
 *      decodes and Chrome usually can't
 *    - 10-bit / HDR (HLG, PQ) — tone-mapped to SDR BT.709 (not just re-tagged: an 8-bit
 *      file still tagged HLG fails this very contract)
 *    - display geometry off the canvas — scale-fit + letterboxed onto 1080×1920 once
 *    - frame rates that round past 30 (slo-mo, 60 fps, screen recordings)
 *    - bitrate far above the recorder's own
 *    - non-AAC audio — conformed audio-only when the video is otherwise fine
 *
 * 2. MERGE MATCHING (optional `target`) — the recorder's exact copy-compatibility signature:
 *    coded size + rotation tag, rounded fps, AAC sample rate + channel count. The merge engine
 *    joins clips with identical signatures by pure sample copy; anything else is re-encoded
 *    AT MERGE (every export). Conforming imports to the recorder's own signature at import
 *    time — once — is what keeps a draft mixing recordings and imports on the zero-re-encode
 *    path. The recorder writes portrait as a coded-landscape buffer plus a rotation tag, so a
 *    matching import is written the same way (the conform engine supports rotation output).
 *
 * The contract alone gates what may be stored/uploaded (the upload and .pulse unpack gates
 * call this without a target); the merge target only decides how far an import is conformed.
 */

/** The app's fixed portrait canvas — every stored segment displays exactly this
 * (reels contract; mirrors REELS_TARGET in use-export.ts). */
export const CANVAS_WIDTH = 1080;
export const CANVAS_HEIGHT = 1920;
/** Re-encode target: the recorder's own frame rate. Also the passthrough gate: a clip whose
 * effective fps ROUNDS past this (the same rounding the merge pin compares with) is normalized
 * at import — 29.97 NTSC rounds to 30 and passes; 30.51+ (and exactly 30.5, which rounds to 31)
 * conforms once here instead of on every merge. */
export const NORMALIZE_TARGET_FPS = 30;
/** Re-encode target: the recorder's own bitrate (5 Mbps, see use-recorder.ts). */
export const NORMALIZE_TARGET_BITRATE = 5_000_000;
/** Sources above this keep their size advantage from a re-encode; ~1.6x recorder rate. */
export const NORMALIZE_MAX_BITRATE = 8_000_000;

/** Video codecs allowed through untouched. H.264 only: the whole pipeline (recorder, merge
 * output, uploads) is standardized on H.264 for universal browser playback — HEVC imports
 * are re-encoded once at import time rather than leaking into merged artifacts. */
const NATIVE_VIDEO_CODECS = new Set(['h264']);

/**
 * The recorder's copy-compatibility signature on this device (see recorder-format.ts): what
 * an import must look like, byte-layout-wise, to join recorded clips with no re-encode. The
 * display it describes is always the portrait canvas.
 */
export type RecorderFormat = {
  /** Coded (pre-rotation) size, e.g. 1920×1080 for a portrait recording. */
  width: number;
  height: number;
  /** Clockwise display rotation (pulse-editor `probe` convention): 0, 90, 180 or 270. */
  rotation: number;
  /** The recorder's AAC track. */
  audioSampleRate: number;
  audioChannels: number;
};

export type ImportDecision =
  | { action: 'passthrough' }
  | { action: 'normalize'; options: Partial<CompressOptions>; reasons: string[] };

/** True when the video is HDR (HLG or PQ): the conform must tone-map it, not just re-tag it. */
function isHdr(video: ProbeVideo): boolean {
  return video.transfer !== 'sdr';
}

/** Display (post-rotation) dimensions: a 90/270 rotation swaps coded width/height. */
export function displaySize(video: Pick<ProbeVideo, 'width' | 'height' | 'rotation'>): {
  width: number;
  height: number;
} {
  const swapped = video.rotation % 180 !== 0;
  return {
    width: swapped ? video.height : video.width,
    height: swapped ? video.width : video.height,
  };
}

/** True when a recorder format displays exactly the portrait canvas (a usable merge target). */
export function isCanvasFormat(f: Pick<RecorderFormat, 'width' | 'height' | 'rotation'>): boolean {
  const swapped = f.rotation % 180 !== 0;
  const w = swapped ? f.height : f.width;
  const h = swapped ? f.width : f.height;
  return w === CANVAS_WIDTH && h === CANVAS_HEIGHT;
}

/** Contract violations of the VIDEO stream (display-level; see module docs). */
function contractVideoReasons(video: ProbeVideo): string[] {
  const reasons: string[] = [];
  if (!NATIVE_VIDEO_CODECS.has(video.codec)) {
    reasons.push(`video codec ${video.codec || 'unknown'}`);
  }
  if (video.bitDepth > 8) {
    reasons.push(`${video.bitDepth}-bit video`);
  }
  if (isHdr(video)) {
    reasons.push(`HDR transfer ${video.transfer}`);
  }
  // A mirroring matrix displays fine in players but nothing downstream honors it (the merge
  // engine only understands pure rotations): bake the flip into the pixels once.
  if (video.mirrored) {
    reasons.push('mirrored display matrix');
  }
  const display = displaySize(video);
  if (display.width !== CANVAS_WIDTH || display.height !== CANVAS_HEIGHT) {
    reasons.push(
      `${display.width}x${display.height} off the ${CANVAS_WIDTH}x${CANVAS_HEIGHT} canvas`,
    );
  }
  // Round exactly like the merge pin does, so import passthrough and merge lossless-match can
  // never disagree about a clip's rate (fps -1 = unknown → rounds negative → passes).
  if (Math.round(video.fps) > NORMALIZE_TARGET_FPS) {
    reasons.push(`${Math.round(video.fps)} fps rounds past the ${NORMALIZE_TARGET_FPS}-fps target`);
  }
  if (video.bitrate > NORMALIZE_MAX_BITRATE) {
    reasons.push(
      `${Math.round(video.bitrate / 1_000_000)} Mbps exceeds ${NORMALIZE_MAX_BITRATE / 1_000_000}`,
    );
  }
  return reasons;
}

/** Where an otherwise-contract-clean video still differs from the recorder's signature. */
function mergeVideoReasons(video: ProbeVideo, target: RecorderFormat): string[] {
  const reasons: string[] = [];
  if (
    video.width !== target.width ||
    video.height !== target.height ||
    video.rotation !== target.rotation
  ) {
    reasons.push(
      `coded ${video.width}x${video.height} r${video.rotation} differs from the recorder's ` +
        `${target.width}x${target.height} r${target.rotation}`,
    );
  }
  const fps = Math.round(video.fps);
  if (fps !== NORMALIZE_TARGET_FPS) {
    reasons.push(
      `${fps > 0 ? fps : 'unknown'} fps differs from the recorder's ${NORMALIZE_TARGET_FPS}`,
    );
  }
  return reasons;
}

/** Why the audio track needs a conform (empty when it's fine, or when there is none). */
function audioReasons(audio: ProbeAudio | undefined, target?: RecorderFormat): string[] {
  if (!audio) return [];
  if (audio.codec !== 'aac') return [`audio codec ${audio.codec || 'unknown'}`];
  if (
    target &&
    (audio.sampleRate !== target.audioSampleRate || audio.channels !== target.audioChannels)
  ) {
    return [
      `audio ${audio.sampleRate} Hz/${audio.channels} ch differs from the recorder's ` +
        `${target.audioSampleRate} Hz/${target.audioChannels} ch`,
    ];
  }
  return [];
}

/**
 * Decide how an imported clip enters the draft: byte-for-byte passthrough, an audio-only
 * conform (video samples copied), or a full re-encode. Pure — feed it a `probe()` result.
 *
 * Without `target`, only the reels contract is enforced (upload / unpack gates). With it, the
 * clip must also match the recorder's signature to pass through, and every conform writes that
 * signature (rotation tag, AAC rate/channels) so the merge can join it by copy.
 */
export function decideImport(probe: ProbeResult, target?: RecorderFormat): ImportDecision {
  const { video } = probe;
  if (!video) return { action: 'passthrough' };

  const videoReasons = contractVideoReasons(video);
  if (target && videoReasons.length === 0) videoReasons.push(...mergeVideoReasons(video, target));
  const audio = audioReasons(probe.audio, target);
  const audioTarget: Partial<CompressOptions> = target
    ? { audioSampleRate: target.audioSampleRate, audioChannels: target.audioChannels }
    : {};

  if (videoReasons.length === 0) {
    if (audio.length === 0) return { action: 'passthrough' };
    // Video is fine — conform only the audio track (e.g. Opus → AAC, 44.1 → 48 kHz) and
    // copy the video samples, so the cost is audio-sized.
    return {
      action: 'normalize',
      options: { engine: 'auto', copyVideo: true, ...audioTarget },
      reasons: audio,
    };
  }

  return {
    action: 'normalize',
    options: {
      engine: 'auto',
      // Explicit h264: never rely on the native default staying H.264 — this is the
      // pipeline-wide codec guarantee for everything that gets re-encoded.
      codec: 'h264',
      bitrate: NORMALIZE_TARGET_BITRATE,
      frameRate: NORMALIZE_TARGET_FPS,
      // Bake the portrait canvas on every full re-encode: scale-fit + centered letterbox to
      // exactly CANVAS_WxH (display). With a merge target the pixels are written in the
      // recorder's coded orientation under its rotation tag.
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      letterbox: true,
      // RNVT's compress still takes FFmpeg's counter-clockwise display-matrix degrees.
      rotation: target ? (360 - target.rotation) % 360 : 0,
      hdrToSdr: isHdr(video),
      ...audioTarget,
    },
    reasons: [...videoReasons, ...audio],
  };
}
