import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { type ReactNode, useCallback, useMemo, useState } from 'react';

import { getDestination } from '@/db/destinations';
import { draftPlaceQuery } from '@/db/drafts';
import { type UploadTargets, UploadTargetsContext } from '@/features/upload/core/target-provider';
import { hostOf } from '@/utils/format';

import { destinationSpokenName, isSpentLink } from './destination-options';
import { DestinationSelector } from './destination-selector';
import { shareUploadLink, watchUpload } from './link-actions';
import { backToHost } from './link-messages';
import { returnToFor, uploadChoice } from './upload-choice';
import { useDestinations, usePlaceLabels } from './use-destinations';

/**
 * The pool provider's `Targets` (`pool-provider.ts`): the Pulse app's pool of paired destinations
 * for one draft, for the export screen under it.
 */
export function PoolTargets({ draftId, children }: { draftId: string; children: ReactNode }) {
  const targets = usePoolTargets(draftId);
  return <UploadTargetsContext.Provider value={targets}>{children}</UploadTargetsContext.Provider>;
}

/**
 * The export screen's pick from the Pulse app's pool of paired destinations: what it offers for
 * the draft, the picker and which one is picked, the line to show when the draft's own place has
 * no link left (`reopen`), and `resolvePicked`, which reads the picked one back as the target to
 * claim (`useUpload`'s `claim`).
 */
export function usePoolTargets(draftId: string): UploadTargets {
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
  const selected = useMemo(
    () => destinations.find((d) => d.id === selectedId) ?? null,
    [destinations, selectedId],
  );

  // The target to claim for the picked destination, or null when it's gone or spent.
  const resolvePicked = useCallback(async () => {
    if (!selected) return null;
    // The stored link, not the list's copy: a re-pair may have refreshed its token (or, for a
    // place, replaced its upload and its way back) a moment ago, before this screen's reload
    // (`reloadDestinationTokens`) landed. The copy only if it can't be read.
    const stored = await getDestination(selected.id).catch(() => selected);
    if (!stored || isSpentLink(stored.ref, stored.token, Date.now())) return null;
    const { server, token, artifactId } = stored;
    return {
      destinationId: selected.id,
      destination: { server, token, artifactId },
      // The host page to go back to once it's in, from the same link: the row is gone from
      // here on, so the upload carries it.
      returnTo: returnToFor(draft, stored),
    };
  }, [selected, draft]);

  return useMemo(
    () => ({
      available: destinations.length > 0,
      picker:
        destinations.length > 0 ? (
          <DestinationSelector
            destinations={destinations}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        ) : null,
      // What the Upload button is called: the place's own label when its link gave one, else the
      // server's host. The label is the link's word, not the server's: the chip above the button
      // shows the host under it, and the button says both to a screen reader.
      picked: selected
        ? {
            name: selected.label ?? hostOf(selected.server),
            spokenName: destinationSpokenName(selected),
          }
        : null,
      // Only while nothing is picked: the draft's own destination is gone, and it never falls
      // back to another one.
      reopen: selected ? null : reopen,
      resolvePicked,
      backToHost,
      watch: watchUpload,
      share: (url: string) => shareUploadLink(url),
    }),
    [destinations, selectedId, selected, reopen, resolvePicked],
  );
}
