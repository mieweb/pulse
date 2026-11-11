import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { type RefObject, useCallback, useMemo, useState } from 'react';

import { getDestination } from '@/db/destinations';
import { draftPlaceQuery } from '@/db/drafts';
import type { Segment } from '@/db/schema';

import { isSpentLink } from './destination-options';
import { returnToFor, uploadChoice } from './upload-choice';
import { useDestinations, usePlaceLabels } from './use-destinations';
import { uploads } from './upload-manager';
import { useDraftUploadState } from './use-uploads';

/**
 * The export screen's binding to the background upload system — a thin
 * controller: pick a pool destination, `claim` it (spend the link, pair the
 * draft and start uploading, in one tap) and `cancel`. It hands the actual
 * upload to the module-scope `uploads` manager (see `upload-manager.ts`):
 * leaving the screen doesn't abort the upload. There is no retry: a failed
 * upload unpairs the draft, and a new link is the retry — for a draft recorded
 * for a place, the place's link opened again (`reopen`). A finished
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
  const { destinations: pool, ready: poolReady } = useDestinations();
  const placeLabels = usePlaceLabels();

  // The place the draft was recorded for (a link that names one opened its recorder), if any.
  // No row yet = still loading: nothing is preselected until it's known.
  const { data: draftRows } = useLiveQuery(draftPlaceQuery(draftId), [draftId]);
  const draft = draftRows[0];

  // Which pool destination the user has picked to upload to, while it's still in the pool. Until
  // they pick: the draft's own destination if it has a place, else the most-recent non-expired one
  // — derived (see `uploadChoice`), so the draft's place still wins when it loads after the pool.
  const [pickedId, setSelectedId] = useState<string | null>(null);
  const { destinations, selectedId, reopen } = useMemo(
    () =>
      uploadChoice({
        draft,
        pool,
        poolReady,
        placeLabel: draft ? placeLabels(draft.server, draft.ref) : null,
        pickedId,
      }),
    [draft, pool, poolReady, placeLabels, pickedId],
  );
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
      if (!option || !merged) return;
      // The stored link, not the list's copy: a re-pair may have refreshed its token (or, for a
      // place, replaced its upload and its way back) a moment ago, before this screen's reload
      // (`reloadDestinationTokens`) landed. The copy only if it can't be read.
      const stored = await getDestination(option.id).catch(() => option);
      if (!stored || isSpentLink(stored.ref, stored.token, Date.now())) return;
      const { server, token, artifactId } = stored;
      await uploads.claim({
        draftId,
        destinationId: option.id,
        destination: { server, token, artifactId },
        segments,
        merged,
        // The host page to go back to once it's in, from the same link: the row is gone from
        // here on, so the upload carries it.
        returnTo: returnToFor(draft, stored),
      });
    },
    [destinations, draft, draftId, segments, mergedRef],
  );

  return {
    state,
    reopen,
    destinations,
    selectedId,
    setSelectedId,
    selectedDestination,
    cancel,
    claim,
  };
}
