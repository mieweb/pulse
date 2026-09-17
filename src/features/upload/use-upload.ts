import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { type RefObject, useCallback, useMemo, useState } from 'react';

import { deleteDestination } from '@/db/destinations';
import { draftQuery, setUploadDestination } from '@/db/drafts';
import type { Segment } from '@/db/schema';


import { isTokenExpired } from './capability-token';
import { useDestinations } from './use-destinations';
import { uploads } from './upload-manager';
import type { Destination } from './types';
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
  const { data: draftRows } = useLiveQuery(draftQuery(draftId), [draftId]);
  const draft = draftRows[0];
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

  // The manager's live state for this draft (transient; this session only). Durable status is on
  // the drizzle row above.
  const state = useDraftUploadState(draftId);

  const acknowledgeDone = useCallback(() => uploads.acknowledge(draftId), [draftId]);

  const cancel = useCallback(() => {
    void uploads.cancel(draftId);
  }, [draftId]);

  // Commits this draft to a chosen pool destination and starts uploading in the same tap.
  // The pool row is CONSUMED here (single-shot): success or failure, this link is spent —
  // a terminal failure burns the pairing and the user scans a fresh one.
  const claim = useCallback(
    async (destinationId: string | null) => {
      const option = destinationId
        ? (destinations.find((d) => d.id === destinationId) ?? null)
        : null;
      if (!option || isTokenExpired(option.token, Date.now())) return;
      // The merged export is the upload's payload — without it there's nothing to enqueue
      // (the export screen only offers upload once the merge has landed).
      const merged = mergedRef.current;
      if (!merged) return;
      const destination: Destination = {
        server: option.server,
        token: option.token,
        artifactId: option.artifactId,
        directUpload: option.directUpload,
      };
      // Consume FIRST — the pool delete is the one-winner arbiter, so a double tap or a
      // second screen claiming the same link loses here instead of double-pairing. Then the
      // pairing lands durably as 'uploading' in one write: killed anywhere after this, the
      // launch sweep settles the draft (probe → uploaded or burn), never a stranded pairing.
      if (!(await deleteDestination(option.id))) return;
      await setUploadDestination(draftId, {
        server: option.server,
        token: option.token,
        artifactId: option.artifactId,
      });
      uploads.enqueue({ draftId, destination, segments, merged });
    },
    [destinations, draftId, segments, mergedRef],
  );

  // The destination whose host the UI should name right now: the draft's own claimed
  // destination once a run is underway/finished, otherwise the pool option currently selected.
  const activeServer: string | null =
    draft?.uploadServer && state.status !== 'idle'
      ? draft.uploadServer
      : (selectedDestination?.server ?? null);

  return {
    state,
    draft,
    destinations,
    selectedId,
    setSelectedId,
    selectedDestination,
    activeServer,
    cancel,
    claim,
    acknowledgeDone,
  };
}
