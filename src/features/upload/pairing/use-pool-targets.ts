import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useCallback, useMemo, useState } from 'react';

import { getDestination } from '@/db/destinations';
import { draftPlaceQuery } from '@/db/drafts';
import type { UploadTarget } from '@/features/upload/core/target-provider';

import { isSpentLink } from './destination-options';
import { returnToFor, uploadChoice } from './upload-choice';
import { useDestinations, usePlaceLabels } from './use-destinations';

/**
 * The export screen's pick from the Pulse app's pool of paired destinations: what it offers for
 * the draft, which one is picked, the line to show when the draft's own place has no link left
 * (`reopen`), and `resolve`, which reads the picked one back as the target to claim
 * (`useUpload`'s `claim`).
 */
export function usePoolTargets(draftId: string) {
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

  // The target to claim for a picked destination, or null when it's gone or spent.
  const resolve = useCallback(
    async (destinationId: string | null): Promise<UploadTarget | null> => {
      const option = destinationId
        ? (destinations.find((d) => d.id === destinationId) ?? null)
        : null;
      if (!option) return null;
      // The stored link, not the list's copy: a re-pair may have refreshed its token (or, for a
      // place, replaced its upload and its way back) a moment ago, before this screen's reload
      // (`reloadDestinationTokens`) landed. The copy only if it can't be read.
      const stored = await getDestination(option.id).catch(() => option);
      if (!stored || isSpentLink(stored.ref, stored.token, Date.now())) return null;
      const { server, token, artifactId } = stored;
      return {
        destinationId: option.id,
        destination: { server, token, artifactId },
        // The host page to go back to once it's in, from the same link: the row is gone from
        // here on, so the upload carries it.
        returnTo: returnToFor(draft, stored),
      };
    },
    [destinations, draft],
  );

  return { reopen, destinations, selectedId, setSelectedId, selectedDestination, resolve };
}
