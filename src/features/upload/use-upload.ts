import { type RefObject, useCallback, useMemo, useState } from 'react';

import type { Segment } from '@/db/schema';

import { isTokenExpired } from './capability-token';
import { useDestinations } from './use-destinations';
import { uploads } from './upload-manager';
import { useDraftUploadState } from './use-uploads';

/**
 * The export screen's binding to the background upload system — a thin
 * controller: pick a pool destination, `claim` it (spend the link, pair the
 * draft and start uploading, in one tap) and `cancel`. It hands the actual
 * upload to the module-scope `uploads` manager (see `upload-manager.ts`):
 * leaving the screen doesn't abort the upload. There is no retry: a failed
 * upload unpairs the draft, and scanning a new link is the retry. A finished
 * upload's Watch / Copy link live in the draft's ⋯ menu on Home.
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
  // The device-wide pool of paired-but-unconsumed destinations (non-expired only).
  const { destinations } = useDestinations();

  // Which pool destination the user has picked to upload to. Defaults to the most-recent
  // non-expired one, reconciled during render (adjust-state-during-render) as the pool changes.
  const [rawSelectedId, setSelectedId] = useState<string | null>(null);
  const selectedId =
    rawSelectedId && destinations.some((d) => d.id === rawSelectedId)
      ? rawSelectedId
      : (destinations[0]?.id ?? null);
  if (selectedId !== rawSelectedId) setSelectedId(selectedId);
  const selectedDestination = useMemo(
    () => destinations.find((d) => d.id === selectedId) ?? null,
    [destinations, selectedId],
  );

  // The manager's live state for this draft (transient; this session only). Durable status is
  // the draft row's `upload_status`.
  const state = useDraftUploadState(draftId);

  const cancel = useCallback(() => {
    void uploads.cancel(draftId);
  }, [draftId]);

  // Spends the chosen pool destination on this draft and starts uploading in the same tap.
  const claim = useCallback(
    async (destinationId: string | null) => {
      const option = destinationId
        ? (destinations.find((d) => d.id === destinationId) ?? null)
        : null;
      const merged = mergedRef.current;
      if (!option || !merged || isTokenExpired(option.token, Date.now())) return;
      await uploads.claim({
        draftId,
        destinationId: option.id,
        destination: { server: option.server, token: option.token, artifactId: option.artifactId },
        segments,
        merged,
      });
    },
    [destinations, draftId, segments, mergedRef],
  );

  return {
    state,
    destinations,
    selectedId,
    setSelectedId,
    selectedDestination,
    cancel,
    claim,
  };
}
