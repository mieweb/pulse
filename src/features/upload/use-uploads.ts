import { useCallback, useSyncExternalStore } from 'react';

import { useNow } from '@/hooks/use-now';

import { EXPIRY_CHECK_INTERVAL_MS } from './capability-token';
import { isLinkLive, type UploadAnnouncement, type WatchLink, uploads } from './upload-manager';
import type { LiveUploadState } from './types';

/**
 * Subscribes a component to the background upload manager's live, per-draft
 * state (progress ticks and the transient uploading/done/error status). Uses
 * React's `useSyncExternalStore` — the correct primitive for an external mutable
 * store: it's tearing-safe and the manager returns a stable `===` reference for
 * an untouched draft, so idle drafts never cause spurious re-renders.
 *
 * This is the LIVE channel only (never persisted). Durable per-draft status
 * (uploading/uploaded) is read separately from SQLite via drizzle's `useLiveQuery`.
 */
export function useDraftUploadState(draftId: string): LiveUploadState {
  const getSnapshot = useCallback(() => uploads.getDraftState(draftId), [draftId]);
  return useSyncExternalStore(uploads.subscribe, getSnapshot);
}

/**
 * The draft's watch link while it still opens (see `WatchLink`), re-checked on a timer so an
 * expiring link drops out on its own. `null` otherwise.
 */
export function useWatchLink(draftId: string | null): WatchLink | null {
  const getSnapshot = useCallback(
    () => (draftId ? uploads.getWatchLink(draftId) : null),
    [draftId],
  );
  const link = useSyncExternalStore(uploads.subscribe, getSnapshot);
  const now = useNow(EXPIRY_CHECK_INTERVAL_MS);
  return isLinkLive(link, now) ? link : null;
}

/** The draft's last finished upload the user was told about this session (see `UploadAnnouncement`). */
export function useUploadAnnouncement(draftId: string | null): UploadAnnouncement | null {
  const getSnapshot = useCallback(
    () => (draftId ? uploads.getAnnouncement(draftId) : null),
    [draftId],
  );
  return useSyncExternalStore(uploads.subscribe, getSnapshot);
}
