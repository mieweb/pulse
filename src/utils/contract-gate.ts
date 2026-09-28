import { compress, deleteFile, probeVideo, type CompressResult } from 'react-native-video-trim';

import { checkConform } from './conform-verify';
import { decideImport, type RecorderFormat } from './import-normalization';

/** A clip conformed by `conformToContract`. */
export type ConformOutcome = {
  /** The conformed file, in the OS-purgeable cache dir — callers move it into place. */
  path: string;
  /** Engine that produced it (`avfoundation` | `ffmpeg`). */
  engine: string;
  /** Whether it also carries the recorder's signature (joins recordings with no re-encode). */
  mergeMatch: boolean;
  /** One-line facts for the debug log: fallbacks, dropped audio, partial output, merge misses. */
  notes: string[];
};

function describe(e: unknown): string {
  return e instanceof Error ? e.message.split('\n')[0] : String(e);
}

/**
 * Enforce the portrait reels contract on a clip FILE (probe + the import-normalization policy,
 * re-encoding when off-contract). Resolves to the conformed output, or `null` when the clip
 * already conforms (and, with a `target`, already matches the recorder). Throws when the clip
 * has no video stream or can't be probed/conformed: callers fail closed.
 *
 * With a `target` (imports), off-signature clips are written in the recorder's exact format so
 * a draft mixing recordings and imports merges without re-encoding. Without one (the `.pulse`
 * unpack gate), only the display-level contract is enforced.
 *
 * Engines: `auto` runs the platform engine (AVFoundation on iOS — hardware decode/encode, real
 * HDR tone mapping) with FFmpeg as the module's own fallback. Every output is verified here
 * (contract, audio kept, full length); a native result that fails verification is retried once
 * on FFmpeg. A short result from the last-resort engine is accepted — a truncated source only
 * holds that much — and reported in `notes`.
 *
 * Container layout (faststart) is deliberately NOT part of this gate: raw recorder files are
 * moov-at-end by AVFoundation constraint (see the codec-pin note in use-recorder.ts) and the
 * vault's web-ready backstop owns progressive-playback normalization for raw segments; every
 * locally re-encoded artifact (this gate's conforms, merges, imports) does carry faststart.
 */
export async function conformToContract(
  uri: string,
  target?: RecorderFormat,
): Promise<ConformOutcome | null> {
  const probe = await probeVideo(uri);
  // decideImport passes no-video files through (audio-only is fine for a library), but a
  // SEGMENT without a video stream can never satisfy the portrait contract — fail closed.
  if (!probe.hasVideo) throw new Error('Clip has no video stream.');
  const decision = decideImport(probe, target);
  if (decision.action === 'passthrough') return null;

  const failures: string[] = [];
  const notes: string[] = [`conform: ${decision.reasons.join('; ')}`];
  let lastEngine = '';
  for (const engine of ['auto', 'ffmpeg']) {
    // `auto` already ended on FFmpeg: re-running the same engine can't change the outcome.
    if (engine === 'ffmpeg' && lastEngine === 'ffmpeg') break;
    let result: CompressResult;
    try {
      result = await compress(uri, { ...decision.options, engine });
    } catch (e) {
      // A rejection means every engine inside the module (FFmpeg included) already failed.
      failures.push(`${engine}: ${describe(e)}`);
      lastEngine = 'ffmpeg';
      continue;
    }
    lastEngine = result.engine;
    if (result.fallbackReason) notes.push(`native engine fell back: ${result.fallbackReason}`);

    const output = await probeVideo(result.outputPath).catch(() => null);
    const check = output
      ? checkConform(probe, output, result, target)
      : { fatal: ['output unreadable'], short: null, mergeMatch: false, mergeMisses: [] };
    const lastResort = result.engine === 'ffmpeg';
    if (check.fatal.length > 0 || (check.short && !lastResort)) {
      failures.push(
        `${result.engine}: ${check.fatal.length ? check.fatal.join('; ') : `short output (${check.short})`}`,
      );
      void deleteFile(result.outputPath).catch(() => {});
      continue;
    }

    if (check.short) notes.push(`partial output ${check.short} (source truncated?)`);
    if (result.audioDropped) notes.push('source audio undecodable — imported without sound');
    if (target && !check.mergeMatch)
      notes.push(`merge signature missed: ${check.mergeMisses.join('; ')}`);
    return { path: result.outputPath, engine: result.engine, mergeMatch: check.mergeMatch, notes };
  }
  throw new Error(`Could not convert this video (${failures.join(' | ')})`);
}
