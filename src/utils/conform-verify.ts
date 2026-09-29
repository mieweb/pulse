import type { ProbeResult } from '@mieweb/pulse-editor';
import type { CompressResult } from 'react-native-video-trim';

import { decideImport, type RecorderFormat } from './import-normalization';

/** Verdict on one conform output (see `checkConform`). */
export type ConformCheck = {
  /** Reasons the output must NOT be stored: it breaks the reels contract or lost the audio. */
  fatal: string[];
  /** Set when the picture is materially shorter than the source's — a truncated source, or
   * an engine that stopped early without reporting an error. */
  short: string | null;
  /** Whether the output also carries the recorder's signature (joins recordings by copy). */
  mergeMatch: boolean;
  mergeMisses: string[];
};

/** Picture duration: the video stream's own when known (audio can outlast it), else the file's. */
function pictureMs(p: ProbeResult): number {
  return p.video && p.video.durationMs > 0 ? p.video.durationMs : p.durationMs;
}

/**
 * Check a conform output against its source. Pure — the app's contract gate and the import
 * e2e test (import-pipeline.e2e.test.ts) both use it, so the test enforces exactly what the
 * app does.
 */
export function checkConform(
  source: ProbeResult,
  output: ProbeResult,
  result: Pick<CompressResult, 'audioDropped'>,
  target?: RecorderFormat,
): ConformCheck {
  const fatal: string[] = [];
  if (!output.video) {
    fatal.push('no video stream in the output');
  } else {
    const contract = decideImport(output);
    if (contract.action !== 'passthrough') fatal.push(...contract.reasons);
  }
  if (source.audio && !output.audio && !result.audioDropped) fatal.push('audio lost');

  let short: string | null = null;
  const want = pictureMs(source);
  const got = pictureMs(output);
  if (want > 300 && got < want * 0.9 - 50) {
    short = `${(got / 1000).toFixed(2)}s of ${(want / 1000).toFixed(2)}s`;
  }

  let mergeMisses: string[] = [];
  if (target && output.video) {
    const merge = decideImport(output, target);
    if (merge.action !== 'passthrough') mergeMisses = merge.reasons;
  }
  return { fatal, short, mergeMatch: mergeMisses.length === 0, mergeMisses };
}
