import { type RefObject, useCallback } from 'react';

import type { Segment } from '@/db/schema';

import { startUpload, type UploadTarget, useUploadStrategy } from './target-provider';
import { uploads } from './upload-manager';
import { useDraftUploadState } from './use-uploads';

/**
 * The export screen's binding to the background upload system — a thin
 * controller: `claim` a target the person picked (spend it, pair the draft and
 * start uploading, in one tap) and `cancel`. Which targets there are and how one
 * is spent is the shell's (`UploadStrategyContext`); picking one is the screen's
 * (the Pulse app's pool: `usePoolTargets` in upload/pairing). It hands the actual
 * upload to the module-scope `uploads` manager (see `upload-manager.ts`):
 * leaving the screen doesn't abort the upload. There is no retry: a failed
 * upload unpairs the draft, and a new target is the retry.
 *
 * `state` is the manager's LIVE per-draft state (uploading, this session only)
 * via `useSyncExternalStore`. `mergedRef` is read only at claim time — the merge
 * is done by the time Upload is tappable — and captured into the session the
 * manager runs.
 */
export function useUpload(
  draftId: string,
  segments: Segment[],
  mergedRef: RefObject<{ path: string; durationMs: number } | null>,
) {
  const provider = useUploadStrategy();

  // The manager's live state for this draft (transient; this session only). Durable status is
  // the draft row's `upload_status`.
  const state = useDraftUploadState(draftId);

  const cancel = useCallback(() => {
    void uploads.cancel(draftId);
  }, [draftId]);

  // Spends the picked target on this draft and starts uploading in the same tap.
  const claim = useCallback(
    async (target: UploadTarget | null) => {
      await startUpload(provider, { draftId, target, segments, merged: mergedRef.current });
    },
    [provider, draftId, segments, mergedRef],
  );

  return { state, cancel, claim };
}
