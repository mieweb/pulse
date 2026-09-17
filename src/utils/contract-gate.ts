import { compress, probeVideo } from 'react-native-video-trim';

import { decideImport } from './import-normalization';

/**
 * Enforce the portrait reels contract on a clip FILE (probe + the import-normalization policy,
 * re-encoding when off-contract). Resolves to the conformed output's path — written to the
 * OS-purgeable cache dir, so callers must move it into place — or `null` when the clip already
 * conforms. Throws when the clip has no video stream or can't be probed/conformed: callers
 * fail closed.
 *
 * Guards the ingress point that bypasses `importClip`'s gate: `.pulse` bundle media
 * (foreign installs can ship pre-contract clips).
 *
 * Container layout (faststart) is deliberately NOT part of this gate: raw recorder files are
 * moov-at-end by AVFoundation constraint (see the codec-pin note in use-recorder.ts) and the
 * vault's web-ready backstop owns progressive-playback normalization for raw segments; every
 * locally re-encoded artifact (this gate's conforms, merges, imports) does carry faststart.
 */
export async function conformToContract(uri: string): Promise<string | null> {
  const probe = await probeVideo(uri);
  // decideImport passes no-video files through (audio-only is fine for a library), but a
  // clip without a video stream can never satisfy the portrait contract — fail closed.
  if (!probe.hasVideo) throw new Error('Clip has no video stream.');
  const decision = decideImport(probe);
  if (decision.action === 'passthrough') return null;
  const result = await compress(uri, decision.options);
  // Verify the conform actually landed on-contract: the pinned Android compress falls back to
  // MPEG-4 / a capped long side when the H.264 hardware encoder fails to configure, and
  // CompressResult carries no degraded flag. The output must satisfy the same policy this
  // gate enforces — anything else fails closed rather than persisting/uploading it.
  const verify = await probeVideo(result.outputPath);
  if (!verify.hasVideo) {
    throw new Error('Converted clip failed contract verification: no video stream in output.');
  }
  const recheck = decideImport(verify);
  if (recheck.action !== 'passthrough') {
    // Surface WHY — device encoders fall back in ways CompressResult doesn't
    // report (e.g. HDR color that compress() can't tone-map — fork#8), and
    // "failed verification" alone is undiagnosable from a phone.
    throw new Error(`Converted clip failed contract verification: ${recheck.reasons.join('; ')}.`);
  }
  return result.outputPath;
}
