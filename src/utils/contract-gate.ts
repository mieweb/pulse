import { compress, probeVideo } from 'react-native-video-trim';

import { decideImport } from './import-normalization';

/**
 * Enforce the portrait reels contract on a clip FILE (probe + the import-normalization policy,
 * re-encoding when off-contract). Resolves to the conformed output's path — written to the
 * OS-purgeable cache dir, so callers must move it into place — or `null` when the clip already
 * conforms. Throws when the clip has no video stream or can't be probed/conformed: callers
 * fail closed.
 *
 * Guards the two ingress/egress points that bypass `importClip`'s gate: `.pulse` bundle media
 * (foreign installs can ship pre-contract clips) and segment-unit uploads (stored files can
 * predate the contract — old drafts, iOS codec-pin races).
 *
 * Container layout (faststart) is deliberately NOT part of this gate: raw recorder files are
 * moov-at-end by AVFoundation constraint (see the codec-pin note in use-recorder.ts) and the
 * vault's web-ready backstop owns progressive-playback normalization for raw segments; every
 * locally re-encoded artifact (this gate's conforms, merges, imports) does carry faststart.
 */
export async function conformToContract(uri: string): Promise<string | null> {
  const probe = await probeVideo(uri);
  // decideImport passes no-video files through (audio-only is fine for a library), but a
  // SEGMENT without a video stream can never satisfy the portrait contract — fail closed.
  if (!probe.hasVideo) throw new Error('Clip has no video stream.');
  const decision = decideImport(probe);
  if (decision.action === 'passthrough') return null;
  const result = await compress(uri, decision.options);
  return result.outputPath;
}
