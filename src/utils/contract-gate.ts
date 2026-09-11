import { compress, probeVideo } from 'react-native-video-trim';

import { decideImport } from './import-normalization';

/**
 * Enforce the portrait reels contract on a clip FILE (probe + the import-normalization policy,
 * re-encoding when off-contract). Resolves to the conformed output's path — written to the
 * OS-purgeable cache dir, so callers must move it into place — or `null` when the clip already
 * conforms. Throws when the clip can't be probed or conformed: callers fail closed.
 *
 * Guards the two ingress/egress points that bypass `importClip`'s gate: `.pulse` bundle media
 * (foreign installs can ship pre-contract clips) and segment-unit uploads (stored files can
 * predate the contract — old drafts, iOS codec-pin races).
 */
export async function conformToContract(uri: string): Promise<string | null> {
  const probe = await probeVideo(uri);
  const decision = decideImport(probe);
  if (decision.action === 'passthrough') return null;
  const result = await compress(uri, decision.options);
  return result.outputPath;
}
