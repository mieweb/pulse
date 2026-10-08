import { useEffect, useState } from 'react';

import type { Segment } from '@/db/schema';
import { describeError } from '@/features/upload/upload-log';

import { mergeWithEditor } from './editor-merge';
import { mergedSignature } from './merge-signature';
import { resolveMergedExport } from './merged-export';

export type ExportState =
  | { status: 'merging'; progress: number }
  | { status: 'done'; outputPath: string; durationMs: number }
  | { status: 'error'; message: string };

/**
 * What the export screen says when the merge fails. The native text ("Clip 3 (<file>.mp4): …",
 * sometimes with encoder fallbacks appended) goes to the log, not the screen. A failing clip is
 * named by its badge (the number on its thumb), not its position in the merge: badges are kept
 * across deletes and reorders, and zero-length clips are left out of the merge.
 */
function exportFailureCopy(why: string, segments: Segment[]): string {
  const position = Number(/\bClip (\d+) \(/.exec(why)?.[1]);
  const seg = Number.isInteger(position) ? segments[position - 1] : undefined;
  if (seg) {
    const clip = seg.label ? `clip ${seg.label}` : 'one of the clips';
    return `Pulse couldn’t add ${clip} to the video. Try again; if it fails again, replace or remove that clip.`;
  }
  return 'Pulse couldn’t put your clips together. Try again.';
}

/**
 * Merges a draft's clips into a single mp4 with pulse-editor's `merge()` (see `editor-merge.ts`),
 * always onto the pinned reels canvas (portrait 1080×1920 H.264 — see REELS_TARGET). Joins each
 * clip's file in timeline order, with its edit (trim, rotate / flip / crop, speed, mute) passed as
 * typed fields and rendered by the merge in the same pass — edits are stored as settings, so this
 * is the one place they're encoded. Single-clip drafts go through the merge too, so the export is
 * always faststart. The job re-runs only when the clip set actually changes (keyed on a file
 * signature, not array identity) or on `run`; leaving the screen or changing the clips cancels it.
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
  const signature = mergedSignature(segments);

  useEffect(() => {
    if (segments.length === 0) return;

    // A late merge resolving after this effect re-ran (or the screen unmounted) must not clobber
    // newer state — only the most recent run is allowed to commit.
    let current = true;
    // Leaving the screen or changing the clips cancels the merge in flight.
    const abort = new AbortController();

    void (async () => {
      // Inside the async body (not the effect's synchronous path) so re-running on a clip change
      // flips back to the loader without a cascading-render warning.
      if (current) setState({ status: 'merging', progress: 0 });
      try {
        const { path, durationMs } = await resolveMergedExport(draftId, segments, () =>
          mergeWithEditor(segments, abort.signal, (progress) => {
            if (current) setState({ status: 'merging', progress });
          }),
        );
        if (current) setState({ status: 'done', outputPath: path, durationMs });
      } catch (e) {
        if (abort.signal.aborted) return; // cancelled: the screen left or the clips changed
        const why = describeError(e);
        console.warn(`[export] merge failed: ${why}`);
        if (current) setState({ status: 'error', message: exportFailureCopy(why, segments) });
      }
    })();

    return () => {
      current = false;
      abort.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, signature, attempt]);

  return { state, run };
}
