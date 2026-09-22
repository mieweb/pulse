import { getDraftUploadStatus, getMergedExport, setMergedExport } from '@/db/drafts';
import type { Segment } from '@/db/schema';
import type { MergedOutput } from '@/features/upload/types';
import { absolutize, exportFileExists, exportRelPath, persistExportFile } from '@/utils/file-store';

import { currentExportDuration, mergedSignature } from './merge-signature';

/**
 * The draft's persisted export, if it is a valid export of exactly `segments` (file on disk AND
 * stored signature matches) — else `null`, meaning a merge is needed.
 */
export async function loadMergedExport(
  draftId: string,
  segments: Segment[],
): Promise<MergedOutput | null> {
  const record = await getMergedExport(draftId);
  if (!record) return null;
  const durationMs = currentExportDuration(
    { fileExists: exportFileExists(draftId), ...record },
    segments,
  );
  return durationMs == null ? null : { path: absolutize(exportRelPath(draftId)), durationMs };
}

// Persists run one at a time: each is clear-row → replace file → write-row, and two interleaved
// persists could otherwise leave one merge's file under the other's signature.
let persistQueue: Promise<unknown> = Promise.resolve();

/**
 * The draft's merged video for `segments`: the persisted export when it still matches, else a
 * fresh `mergeClips()` made the persisted export for next time. Every merge is persisted —
 * including a degraded one (Android emergency encoder): re-merging on a device whose H.264
 * encoder is broken would just degrade again, the vault re-encodes it anyway, and a `MERGE_VERSION`
 * bump still forces a fresh merge after an app update.
 *
 * Persisted even if the caller has moved on (unmounted / clips changed) — the stored signature is
 * of the clips that were merged, so a stale one just won't match on the next read.
 */
export async function resolveMergedExport(
  draftId: string,
  segments: Segment[],
  mergeClips: () => Promise<MergedOutput>,
): Promise<MergedOutput> {
  const persisted = await loadMergedExport(draftId, segments);
  if (persisted) return persisted;
  const signature = mergedSignature(segments);
  const merged = await mergeClips();
  return {
    path: await persistMergedExport(draftId, signature, merged),
    durationMs: merged.durationMs,
  };
}

/**
 * Make a finished merge the draft's persisted export: clear the row, move the output into
 * `export.mp4`, then record its signature (file first, row second — a crash in between reads as a
 * mismatch and costs one re-merge). Resolves to the path to use from here on: the persisted
 * file, or the untouched cache output when persisting was skipped (the draft is uploading — the
 * run is reading `export.mp4`, so it is never overwritten) or failed.
 */
function persistMergedExport(
  draftId: string,
  signature: string,
  output: MergedOutput,
): Promise<string> {
  const run = persistQueue.then(async () => {
    if ((await getDraftUploadStatus(draftId)) === 'uploading') return output.path;
    let persisted: string | null = null;
    try {
      await setMergedExport(draftId, null);
      persisted = await persistExportFile(draftId, output.path);
      await setMergedExport(draftId, { signature, durationMs: output.durationMs });
      return persisted;
    } catch (e) {
      // Draft deleted mid-merge, disk full, … — whichever file exists still plays (the move
      // consumes the cache output); with no signature recorded the next visit merges again.
      console.warn('[export] could not persist the merged export', e);
      return persisted ?? output.path;
    }
  });
  persistQueue = run.catch(() => {});
  return run;
}
