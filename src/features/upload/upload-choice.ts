import { hostOf, shortHost } from '@/utils/format';

import type { DestinationOption } from './destination-options';
import { openNewLink } from './link-messages';
import type { ReturnTo } from './types';

/** What the export screen knows of the draft (`draftPlaceQuery`): its place, if it has one. */
export type DraftPlace = {
  server: string | null;
  ref: string | null;
  name: string | null;
  uploadStatus: 'uploading' | 'uploaded' | null;
};

export type UploadChoice = {
  /** The pool as the picker lists it: the draft's own destination first. */
  destinations: DestinationOption[];
  /** The destination for the place the draft was recorded for, while one is in the pool. */
  ownDestination: DestinationOption | null;
  /** The destination Upload uses: the person's pick, else the default. */
  selectedId: string | null;
  /**
   * What to say when the draft was recorded for a place and that place has no destination to
   * upload to (its link expired, was spent on an upload that failed or was cancelled, or was
   * removed); `null` otherwise.
   */
  reopen: string | null;
};

/**
 * Which destination a draft's Upload uses.
 *
 * A draft recorded for a place (a link that named one opened its recorder) uploads to that
 * place's destination, preselected. It never falls back to another one by itself: with its own
 * gone, nothing is selected and the screen says to open a new link for the place — named by the
 * draft's own name, else by the place's label while its expired row is still in the pool
 * (`placeLabel`), else by the server's host. The person can still pick another destination.
 *
 * Any other draft defaults to the newest destination, as it always has.
 *
 * Nothing is decided before it is known: no default until the draft has loaded (`draft`
 * undefined), and no "open a new link" until the pool has (`poolReady`) — an empty pool that
 * is only still loading isn't a missing link.
 */
export function uploadChoice(args: {
  draft: DraftPlace | undefined;
  pool: readonly DestinationOption[];
  poolReady: boolean;
  placeLabel: string | null;
  pickedId: string | null;
}): UploadChoice {
  const { draft, pool, poolReady, placeLabel, pickedId } = args;
  const place = draft?.server && draft.ref ? { server: draft.server, ref: draft.ref } : null;
  const ownDestination = place
    ? (pool.find((d) => d.server === place.server && d.ref === place.ref) ?? null)
    : null;
  const destinations = ownDestination
    ? [ownDestination, ...pool.filter((d) => d !== ownDestination)]
    : [...pool];
  const defaultId = !draft ? null : place ? (ownDestination?.id ?? null) : (pool[0]?.id ?? null);
  const selectedId = pickedId && pool.some((d) => d.id === pickedId) ? pickedId : defaultId;
  // Only an unsent draft: uploading, its link was just claimed; uploaded, it needs none.
  const reopen =
    place && poolReady && !ownDestination && draft?.uploadStatus == null
      ? openNewLink({
          label: draft?.name || placeLabel,
          host: shortHost(hostOf(place.server)),
        })
      : null;
  return { destinations, ownDestination, selectedId, reopen };
}

/**
 * The way back to offer after uploading `draft` to `destination`: the destination's return URL,
 * and only when it is the draft's own place (the same server AND ref) — a host's return page is
 * for the place its link was opened from, not for whatever was uploaded to it.
 */
export function returnToFor(
  draft: DraftPlace | undefined,
  destination: Pick<DestinationOption, 'server' | 'ref' | 'returnUrl' | 'app'>,
): ReturnTo | null {
  if (!draft?.server || !draft.ref || !destination.returnUrl) return null;
  if (destination.server !== draft.server || destination.ref !== draft.ref) return null;
  return { url: destination.returnUrl, app: destination.app };
}
