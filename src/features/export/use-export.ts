import { useEffect, useState } from 'react';
import VideoTrim, { merge, type Spec } from 'react-native-video-trim';

import type { Segment } from '@/db/schema';
import { absolutize } from '@/utils/file-store';
import { canonicalEdit, effFile } from '@/utils/segment-window';

import { mergedSignature, REELS_TARGET } from './merge-signature';
import { resolveMergedExport } from './merged-export';

const Native = VideoTrim as Spec;

export type ExportState =
  | { status: 'merging'; progress: number }
  | { status: 'done'; outputPath: string; durationMs: number }
  | { status: 'error'; message: string };

/**
 * Headless concat of a draft's clips into a single mp4 via react-native-video-trim's `merge()`
 * (passthrough join for uniform pin-matching clips, selective outlier-conform for mixed,
 * re-encode fallback), always onto the pinned reels canvas (portrait 1080×1920 h264 — see
 * REELS_TARGET). Joins each clip's file in timeline order, with its edit (trim, rotate / flip /
 * crop, speed, mute) passed as `clipEdits` and rendered by the merge in the same pass — edits are
 * stored as settings, so this is the one place they're encoded.
 * Single-clip drafts go through the engine too: a lone conforming clip is a near-free passthrough
 * remux, a lone landscape import gets conformed to portrait like any outlier. The job re-runs only
 * when the clip set actually changes (keyed on a file signature, not array identity) or on `run`.
 *
 * The merge is persisted per draft (`drafts/{id}/export.mp4`, see `merged-export.ts`): when the
 * stored export still matches the clips, the hook goes straight to `done` with no re-encode, and
 * a fresh merge is moved into place for the next visit (and for an upload resumed after a kill).
 * The merge starts on mount; `run` retries it after an error.
 */
export function useExport(draftId: string, segments: Segment[]) {
  const [state, setState] = useState<ExportState>({ status: 'merging', progress: 0 });
  const [attempt, setAttempt] = useState(0);
  const run = () => setAttempt((n) => n + 1);

  // Stable across re-renders that don't change the actual clips, so the live query re-emitting
  // the same data doesn't kick off a second merge.
  const files = segments.map(effFile);
  // Each clip's edit, rendered by the merge itself ("" = none; legacy baked clips are already
  // rendered into their file).
  const clipEdits = segments.map((s) =>
    s.editedFilename ? '' : (canonicalEdit(s.editState) ?? ''),
  );
  const signature = mergedSignature(segments);

  useEffect(() => {
    if (segments.length === 0) return;

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
        const { path, durationMs } = await resolveMergedExport(draftId, segments, async () => {
          const urls = files.map(absolutize);
          // Single clips go through the engine too — not just for outlier conforming, but because
          // exported files must be faststart and the raw sources aren't (recorder files are
          // moov-at-end by AVFoundation constraint): the uniform fast path remuxes them
          // near-free on iOS with the moov relocated.
          const result = await merge(urls, { outputExt: 'mp4', ...REELS_TARGET, clipEdits });
          // Emergency encoder fallback missed the pin (Android broken-encoder devices) — the
          // export is playable but off-contract; the vault's web-ready backstop owns the re-encode.
          if (result.degraded) {
            console.warn('[export] merged output is degraded (missed the reels pin)');
          }
          return { path: result.outputPath, durationMs: result.duration };
        });
        if (current) setState({ status: 'done', outputPath: path, durationMs });
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
  }, [draftId, signature, attempt]);

  return { state, run };
}
