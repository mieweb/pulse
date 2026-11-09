import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { type RefObject, useCallback, useMemo, useState } from 'react';

import { getDestination } from '@/db/destinations';
import { draftContextQuery } from '@/db/drafts';
import type { Segment } from '@/db/schema';
import { hostOf } from '@/utils/format';

import { isTokenExpired } from './capability-token';
import { type DestinationOption, useDestinations } from './use-destinations';
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
  const { destinations: pool } = useDestinations();

  // The place the draft was recorded for (a link that names one opened its recorder), if any.
  // No row yet = still loading: nothing is preselected until it's known.
  const { data: contextRows } = useLiveQuery(draftContextQuery(draftId), [draftId]);
  const context = contextRows[0];
  const hasContext = !!(context?.server && context.ref);
  const ownDestination = hasContext
    ? (pool.find((d) => d.server === context.server && d.ref === context.ref) ?? null)
    : null;
  // The draft's own destination first, then the pool's order.
  const destinations = useMemo(
    () => (ownDestination ? [ownDestination, ...pool.filter((d) => d !== ownDestination)] : pool),
    [pool, ownDestination],
  );
  // A draft recorded for a place never falls back to another destination: with its own gone
  // (expired, removed), the person opens the place's link again, named by its label while the
  // expired row is still kept for it, else by host. Not once it's uploaded: the destination is
  // gone because the upload went through.
  const missingContext =
    hasContext && !ownDestination && context.uploadStatus !== 'uploaded'
      ? (context.label ?? hostOf(context.server!))
      : null;

  // Which pool destination the user has picked to upload to, while it's still in the pool. Until
  // they pick: the draft's own destination if it has a place, else the most-recent non-expired one
  // — derived, so the draft's place still wins when it loads after the pool.
  const [pickedId, setSelectedId] = useState<string | null>(null);
  const defaultId = !context
    ? null
    : hasContext
      ? (ownDestination?.id ?? null)
      : (destinations[0]?.id ?? null);
  const selectedId = pickedId && destinations.some((d) => d.id === pickedId) ? pickedId : defaultId;
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

  // The destination the last Upload tap used, for what follows a finished upload ("Back to …").
  const [claimed, setClaimed] = useState<DestinationOption | null>(null);

  // Spends the chosen pool destination on this draft and starts uploading in the same tap (a
  // place's destination is kept until the upload succeeds, see `uploads.claim`).
  const claim = useCallback(
    async (destinationId: string | null) => {
      const option = destinationId
        ? (destinations.find((d) => d.id === destinationId) ?? null)
        : null;
      const merged = mergedRef.current;
      if (!option || !merged) return;
      // The stored link, not the list's copy: a re-pair may have refreshed its token (or, for a
      // place, replaced its upload) a moment ago, before this screen's reload
      // (`reloadDestinationTokens`) landed. The copy only if it can't be read.
      const destination = await getDestination(option.id).catch(() => ({
        server: option.server,
        token: option.token,
        artifactId: option.artifactId,
      }));
      if (!destination || isTokenExpired(destination.token, Date.now())) return;
      setClaimed(option);
      await uploads.claim({
        draftId,
        destinationId: option.id,
        destination,
        segments,
        merged,
        keep: option.ref !== null,
      });
    },
    [destinations, draftId, segments, mergedRef],
  );

  // The host page to go back to after an upload ("Back to <app>"): the return URL of the
  // destination this screen just uploaded to, and only when that is the draft's own place (the
  // same server AND ref) — a host's return page is for the place its link was opened from.
  const returnUrl =
    claimed && hasContext && claimed.server === context.server && claimed.ref === context.ref
      ? claimed.returnUrl
      : null;
  const returnTo = returnUrl
    ? { url: returnUrl, app: claimed?.app ?? hostOf(returnUrl), host: hostOf(returnUrl) }
    : null;

  return {
    state,
    missingContext,
    returnTo,
    destinations,
    selectedId,
    setSelectedId,
    selectedDestination,
    cancel,
    claim,
  };
}
