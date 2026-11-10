import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import {
  deleteDestination,
  deleteDestinationIfExpired,
  destinationsQuery,
} from '@/db/destinations';
import { getDestinationToken } from '@/db/secure-token';
import { useNow } from '@/hooks/use-now';

import { EXPIRY_CHECK_INTERVAL_MS } from './capability-token';
import {
  type DestinationOption,
  destinationOptions,
  isSpentLink,
  placeLabelLookup,
  tokensKey,
} from './destination-options';

export type { DestinationOption };

/**
 * Bumped when a pairing rewrites the token of a row that already existed (the same link again
 * keeps its row id). Each `useDestinations` loads tokens only when its rows change (`tokensKey`),
 * which a plain link's refreshed token doesn't, so without this a screen already open would keep
 * the row's old token; a bump makes every one reload them from secure-store.
 */
let tokensVersion = 0;
const tokensListeners = new Set<() => void>();

export function reloadDestinationTokens() {
  tokensVersion += 1;
  for (const listener of tokensListeners) listener();
}

function subscribeTokens(listener: () => void) {
  tokensListeners.add(listener);
  return () => {
    tokensListeners.delete(listener);
  };
}

/**
 * Shared read model over the device-wide destination pool (`upload_destinations`). Live-queries
 * the rows, loads each row's bearer token from expo-secure-store (which has no live-query
 * equivalent), filters out expired ones, and re-evaluates on a timer so expiry countdowns tick
 * and a token that lapses while the user is just sitting on screen drops out on its own.
 *
 * Consumed by both the home float (view/delete) and the export selector (select-and-upload), so
 * both surfaces agree on exactly which destinations are live. `ready` says whether `destinations`
 * is the pool as it stands, or still loading.
 */
export function useDestinations() {
  const { data: rows, updatedAt } = useLiveQuery(destinationsQuery);
  // Reactive wall-clock so expiry filtering/labels re-evaluate as time passes, even without a DB
  // write — a token can lapse while the user just sits on the screen.
  const now = useNow(EXPIRY_CHECK_INTERVAL_MS);
  const version = useSyncExternalStore(subscribeTokens, () => tokensVersion);

  // Tokens live in secure-store keyed by row id; load them into a map keyed on id. Re-fires only
  // when a row is added, removed or takes a newer link (`tokensKey`) or a pairing rewrote a token
  // (`version`), not on every render.
  const rowsKey = useMemo(() => tokensKey(rows), [rows]);
  const loadKey = `${rowsKey}|${version}`;
  const [loaded, setLoaded] = useState<{ key: string; tokens: Record<string, string | null> }>({
    key: '',
    tokens: {},
  });
  const tokens = loaded.tokens;
  useEffect(() => {
    let cancelled = false;
    const ids = rows.map((r) => r.id);
    // Each row on its own: a token that can't be read hides that row, not the whole pool.
    void Promise.all(
      ids.map((id) =>
        getDestinationToken(id).then(
          (token) => [[id, token] as const],
          () => [],
        ),
      ),
    ).then((entries) => {
      if (!cancelled) setLoaded({ key: loadKey, tokens: Object.fromEntries(entries.flat()) });
    });
    return () => {
      cancelled = true;
    };
    // `loadKey` stands for `rows` (`tokensKey`) and `version` together.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);
  // Whether `destinations` is the pool as it stands: the rows have been read and the tokens of
  // exactly these rows loaded. Until then an empty list means "not known yet", not "none".
  const ready = updatedAt !== undefined && loaded.key === loadKey;

  const destinations: DestinationOption[] = useMemo(
    () => destinationOptions(rows, tokens, now),
    // `now` intentionally in deps so an expiry that passes between ticks re-filters the list.
    [rows, tokens, now],
  );

  // Garbage-collect rows whose link is spent (its token lapsed, or a place's row left without
  // one) so they don't linger as dead state. Only acts on tokens we've loaded and can decode as
  // expired (never on "unknown").
  useEffect(() => {
    for (const r of rows) {
      const token = tokens[r.id];
      if (token !== undefined && isSpentLink(r.ref, token, now)) {
        // Decided again from the stored token when it runs: a re-pair may have refreshed it.
        void deleteDestinationIfExpired(r.id, (stored) =>
          isSpentLink(r.ref, stored, Date.now()),
        ).catch(() => {});
      }
    }
  }, [rows, tokens, now]);

  return { destinations, ready, deleteDestination };
}

/**
 * What each place in the pool is called (`placeLabelLookup`), live: it follows the pool's rows, so
 * a draft's title changes the moment its place's row is added, relabelled or removed.
 */
export function usePlaceLabels(): (server: string | null, ref: string | null) => string | null {
  const { data: rows } = useLiveQuery(destinationsQuery);
  return useMemo(() => placeLabelLookup(rows), [rows]);
}
