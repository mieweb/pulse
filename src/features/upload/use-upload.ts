import { type RefObject, useCallback, useMemo, useRef, useState } from 'react';

import { deleteDestination, type PairedDestination } from '@/db/destinations';
import { burnUploadPairing, setUploadDestination } from '@/db/drafts';
import type { Segment } from '@/db/schema';

import { isTokenExpired } from './capability-token';
import { useDestinations } from './use-destinations';
import { uploads } from './upload-manager';
import { useDraftUploadState } from './use-uploads';

/**
 * The export screen's binding to the background upload system — a thin
 * controller over the single-shot model: pick a pool destination, `claim` it
 * (consume the pool row + pair the draft + enqueue, one tap), `cancel`, and
 * acknowledge the done prompt. There is no retry surface: a terminal failure
 * burns the pairing (manager-side) and the user scans a fresh link.
 *
 * `state` is the manager's LIVE per-draft state (uploading/done, this session
 * only) via `useSyncExternalStore`; durable status lives in the drizzle
 * `draft` row. `mergedRef` is read only at claim time — the merge is done by
 * the time Upload is tappable — and captured into the session the manager runs.
 */
export function useUpload(
  draftId: string,
  segments: Segment[],
  mergedRef: RefObject<{ path: string; durationMs: number } | null>,
) {
  // The device-wide pool of paired-but-unconsumed destinations (non-expired only —
  // useDestinations re-filters on a timer, so lapsed options drop out on their own).
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
  // the `upload_status` column on the draft row.
  const state = useDraftUploadState(draftId);

  const acknowledgeDone = useCallback(() => uploads.acknowledge(draftId), [draftId]);

  const cancel = useCallback(() => {
    void uploads.cancel(draftId);
  }, [draftId]);

  // Commits this draft to a chosen pool destination and starts uploading in the same tap.
  // The pool row is CONSUMED here (single-shot): success or failure, this link is spent —
  // a terminal failure burns the pairing and the user scans a fresh one.
  const claiming = useRef(false);
  const claim = useCallback(
    async (destinationId: string | null) => {
      // One claim per draft at a time: a double tap on THIS draft is refused here (the ref
      // covers the awaits below; the live state covers a run already underway). Two DRAFTS
      // racing for the same link are arbitrated by the pool delete further down.
      if (claiming.current || state.status !== 'idle') return;
      const option = destinationId
        ? (destinations.find((d) => d.id === destinationId) ?? null)
        : null;
      if (!option || isTokenExpired(option.token, Date.now())) return;
      // The merged export is the upload's payload — without it there's nothing to enqueue
      // (the export screen only offers upload once the merge has landed).
      const merged = mergedRef.current;
      if (!merged) return;
      claiming.current = true;
      try {
        const destination: PairedDestination = {
          server: option.server,
          token: option.token,
          artifactId: option.artifactId,
          directUpload: option.directUpload,
        };
        // Pair FIRST — the row lands 'uploading' before the link is spent, so a kill at any
        // later point leaves a marker the launch sweep settles (probe → uploaded or burn),
        // never a consumed link with nothing to show for it. THEN consume: the pool delete
        // is the one-winner arbiter across drafts — a second draft claiming the same link
        // loses here and burns its own pairing instead of double-pairing.
        await setUploadDestination(draftId, destination);
        if (!(await deleteDestination(option.id))) {
          await burnUploadPairing(draftId);
          return;
        }
        uploads.enqueue({ draftId, destination, segments, merged });
      } finally {
        claiming.current = false;
      }
    },
    [destinations, draftId, segments, mergedRef, state.status],
  );

  return {
    state,
    destinations,
    selectedId,
    setSelectedId,
    selectedDestination,
    cancel,
    claim,
    acknowledgeDone,
  };
}
