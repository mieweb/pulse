import { merge, type MergeClip } from '@mieweb/pulse-editor';

import type { Segment } from '@/db/schema';
import { getRecorderFormat } from '@/features/recorder/recorder-format';
import type { MergedOutput } from '@/features/upload/types';
import { absolutize } from '@/utils/file-store';
import { clipRender } from '@/utils/segment-window';

import { REELS_TARGET } from './merge-signature';

/** Export video bitrate: the target the recorder is set to. Recordings land a little above it
 * (#241), within the merge's allowance, so a recorded draft joins without re-encoding. */
export const EXPORT_BITRATE = 5_000_000;

/**
 * A clip as pulse-editor's merge takes it: its media file and its saved edit as typed fields.
 * The editor stores rotation as counter-clockwise quarter turns; pulse-editor takes clockwise
 * degrees.
 */
export function toMergeClip(s: Segment): MergeClip {
  const r = clipRender(s);
  return {
    uri: absolutize(r.file),
    startMs: r.inMs,
    endMs: r.outMs,
    speed: r.speed,
    muted: r.muted,
    rotation: ((4 - r.rotation) % 4) * 90,
    flipped: r.flipped,
    crop: r.crop ?? undefined,
  };
}

/** Merge a draft's clips with pulse-editor onto the reels canvas, in the recorder's audio layout. */
export async function mergeWithEditor(
  segments: Segment[],
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<MergedOutput> {
  const recorder = await getRecorderFormat();
  const started = Date.now();
  const result = await merge(
    segments.map(toMergeClip),
    {
      width: REELS_TARGET.targetWidth,
      height: REELS_TARGET.targetHeight,
      fps: REELS_TARGET.targetFps,
      bitrate: EXPORT_BITRATE,
      audio: { sampleRate: recorder.audioSampleRate, channels: recorder.audioChannels },
    },
    { onProgress, signal },
  );
  console.info(
    `[export] merged ${segments.length} clips with pulse-editor in ${Date.now() - started} ms ` +
      `(${result.encoded ? 'encoded' : 'joined without re-encoding'}, ` +
      `${(result.durationMs / 1000).toFixed(1)}s)`,
  );
  return { path: result.uri, durationMs: result.durationMs };
}
