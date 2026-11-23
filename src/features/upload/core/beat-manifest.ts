import type { Segment } from '@/db/schema';
import { effMs, segmentOffsets } from '@/utils/segment-window';

import type { BeatManifest } from './protocol.gen';

/**
 * The manifest's shape comes from the protocol (`beat-manifest.schema.json` in the pinned
 * pulsevault, generated into `protocol.gen.ts`), so the app can't drift from what servers expect.
 */
export type { BeatManifest };

/** One recorded clip's placement on the video's timeline (for future HLS deep-links). */
export type Beat = BeatManifest['beats'][number];

/**
 * Build the video's beat manifest: precise per-segment start/end timecodes on the video's
 * timeline, reconciled to the video's REAL duration.
 *
 * `segmentOffsets` sums each clip's `effMs` (the DB-recorded, decoder-derived per-clip durations),
 * which can drift a few ms from the actual concatenated file after container/re-encode framing.
 * We scale the cumulative boundaries by `trueDurationMs / Σ effMs` so they distribute that drift
 * proportionally and land on the true timeline — the head is pinned to 0 and the tail exactly to
 * `trueDurationMs`, so the beats stay contiguous (`beats[i].endMs === beats[i+1].startMs`) and sum
 * exactly to the video's duration. A single-clip draft skips the merge, so `k = 1`.
 */
export function buildBeatManifest(clips: Segment[], trueDurationMs: number): BeatManifest {
  const offsets = segmentOffsets(clips); // prefix sums of effMs
  const last = clips[clips.length - 1];
  const rawTotal = clips.length > 0 ? offsets[offsets.length - 1] + effMs(last) : 0;
  const k = rawTotal > 0 ? trueDurationMs / rawTotal : 1;

  // One shared, monotonic boundary array → contiguity AND an exact total by construction.
  const boundary = clips.map((_, i) => Math.round(offsets[i] * k));
  boundary.push(trueDurationMs); // pin the tail exactly
  if (boundary.length > 0) boundary[0] = 0; // pin the head exactly

  const beats: Beat[] = clips.map((s, i) => ({
    segmentId: s.id,
    order: i,
    startMs: boundary[i],
    endMs: boundary[i + 1],
  }));

  return { version: 1, type: 'beat-manifest', durationMs: trueDurationMs, beats };
}
