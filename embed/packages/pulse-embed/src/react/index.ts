import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { getPulse } from '../client';
import { stableStringify } from '../envelope';
import type {
  CountOptions,
  DraftFilter,
  DraftSummary,
  FlowResult,
  Loadable,
  OpenRequest,
  PulseClient,
} from '../types';
import {
  createAvailabilityStore,
  createDraftCountsStore,
  createDraftsStore,
  createDraftStore,
  createPresentStore,
  type Availability,
  type Store,
} from './stores';

/**
 * '@mieweb/pulse-embed/react': hooks over the stores in ./stores. Each takes an optional client
 * (default: the page-wide `getPulse()`); options are compared by value, so an inline filter
 * object doesn't restart the read on every render.
 */

function useStore<S>(store: Store<S>): S {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** `available` is false on web, without the plugin, when unsupported, or for an unknown contract major. */
export function usePulseAvailability(client?: PulseClient): Availability {
  const c = client ?? getPulse();
  const store = useMemo(() => createAvailabilityStore(c), [c]);
  return useStore(store);
}

/** Re-reads on `draftsChanged` and `uploadProgress`. */
export function useDrafts(filter?: DraftFilter, client?: PulseClient): Loadable<DraftSummary[]> {
  const c = client ?? getPulse();
  const key = stableStringify(filter ?? null);
  const store = useMemo(
    () => createDraftsStore(c, (JSON.parse(key) as DraftFilter | null) ?? undefined),
    [c, key],
  );
  return useStore(store);
}

export function useDraft(id: string | null, client?: PulseClient): Loadable<DraftSummary | null> {
  const c = client ?? getPulse();
  const store = useMemo(() => createDraftStore(c, id), [c, id]);
  return useStore(store);
}

export function useDraftCounts(
  o: CountOptions,
  client?: PulseClient,
): Loadable<Record<string, number>> {
  const c = client ?? getPulse();
  const key = stableStringify(o);
  const store = useMemo(() => createDraftCountsStore(c, JSON.parse(key) as CountOptions), [c, key]);
  return useStore(store);
}

/** One flow at a time; `open` while one is open resolves the same pending result. */
export function usePresent(client?: PulseClient): {
  open(r: OpenRequest): Promise<FlowResult>;
  isOpen: boolean;
  lastResult: FlowResult | null;
} {
  const c = client ?? getPulse();
  const store = useMemo(() => createPresentStore(c), [c]);
  const { isOpen, lastResult } = useStore(store);
  const open = useCallback((r: OpenRequest) => store.open(r), [store]);
  return { open, isOpen, lastResult };
}
