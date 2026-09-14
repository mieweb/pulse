import { useEffect, useState } from 'react';
import VideoTrim, { merge, type Spec } from 'react-native-video-trim';

import type { Segment } from '@/db/schema';
import { absolutize } from '@/utils/file-store';
import { effFile, segmentSignature } from '@/utils/segment-window';

const Native = VideoTrim as Spec;

// The app's export contract: reels-style portrait 1080×1920 H.264 30fps, on every platform.
// Pinned so the canvas is never inferred from the clips — recorder clips and normalized imports
// already match (lossless fast path); anything else (e.g. a landscape library import) conforms.
const REELS_TARGET = {
  targetWidth: 1080,
  targetHeight: 1920,
  targetFps: 30,
  targetCodec: 'h264',
} as const;

export type ExportState =
  | { status: 'idle' }
  | { status: 'merging'; progress: number }
  | { status: 'done'; outputPath: string; durationMs: number }
  | { status: 'error'; message: string };

/**
 * Headless concat of a draft's clips into a single mp4 via react-native-video-trim's `merge()`
 * (passthrough join for uniform pin-matching clips, selective outlier-conform for mixed,
 * re-encode fallback), always onto the pinned reels canvas (portrait 1080×1920 h264 — see
 * REELS_TARGET). Joins each clip's EFFECTIVE file (edited ?? original) in timeline order.
 * Single-clip drafts go through the engine too: a lone conforming clip is a near-free passthrough
 * remux, a lone landscape import gets conformed to portrait like any outlier. The job re-runs only
 * when the clip set actually changes (keyed on a file signature, not array identity) or on `run`.
 *
 * `options.auto` (default `true`) controls whether the merge starts on mount. Pass `false` for a
 * segmented upload destination — `uploadSegments` never touches the merged file, so merging eagerly
 * would just be wasted CPU/battery blocking the screen for no reason. The hook stays `idle` until
 * something (Share, Save, Preview) calls `run()` on demand.
 */
export function useExport(segments: Segment[], options?: { auto?: boolean }) {
  const auto = options?.auto ?? true;
  // Lazy initializer, snapshotted once at mount — just avoids a one-frame "idle" flash for the
  // common case where `auto` doesn't change over the component's lifetime. The effect below is
  // what actually corrects state if `auto` changes later (e.g. a destination resolves after mount).
  const [state, setState] = useState<ExportState>(() =>
    auto ? { status: 'merging', progress: 0 } : { status: 'idle' },
  );
  const [attempt, setAttempt] = useState(0);
  const run = () => setAttempt((n) => n + 1);

  // Not auto-running and nobody has explicitly called `run()` yet — the merge below never runs.
  const shouldRun = auto || attempt > 0;

  // Stable across re-renders that don't change the actual clips, so the live query re-emitting
  // the same data doesn't kick off a second merge.
  const files = segments.map(effFile);
  const signature = segmentSignature(segments);

  useEffect(() => {
    if (segments.length === 0 || !shouldRun) return;

    // A late merge resolving after this effect re-ran (or the screen unmounted) must not clobber
    // newer state — only the most recent run is allowed to commit.
    let current = true;

    // Native emits normalized merge progress in [0,1]; reflect it into the loader. Subscribed for
    // the lifetime of this run and torn down in cleanup.
    const sub = Native.onMergeProgress(({ progress }) => {
      if (current) setState({ status: 'merging', progress });
    });

    void (async () => {
      // Inside the async body (not the effect's synchronous path) so re-running on a clip change
      // flips back to the loader without a cascading-render warning.
      if (current) setState({ status: 'merging', progress: 0 });
      try {
        const urls = files.map(absolutize);
        // Single clips go through the engine too — not just for outlier conforming, but because
        // exported files must be faststart and the raw sources aren't (recorder files are
        // moov-at-end by AVFoundation constraint): the uniform fast path remuxes them
        // near-free on iOS with the moov relocated.
        const result = await merge(urls, { outputExt: 'mp4', ...REELS_TARGET });
        // Emergency encoder fallback missed the pin (Android broken-encoder devices) — the
        // export is playable but off-contract; the vault's web-ready backstop owns the re-encode.
        if (result.degraded) console.warn('[export] merged output is degraded (missed the reels pin)');
        if (current) {
          setState({ status: 'done', outputPath: result.outputPath, durationMs: result.duration });
        }
      } catch (e) {
        console.warn('[export] merge failed', e);
        if (current) {
          setState({
            status: 'error',
            message: e instanceof Error ? e.message : 'Could not merge the clips.',
          });
        }
      }
    })();

    return () => {
      current = false;
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, attempt, shouldRun]);

  // Derived, not stored: overrides a stale `merging`/`done`/`error` value left over from a
  // previous render where `auto` was true (e.g. the destination changed shape) without needing a
  // corrective `setState` inside the effect above.
  return { state: shouldRun ? state : { status: 'idle' as const }, run };
}
