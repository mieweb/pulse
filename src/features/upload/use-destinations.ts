import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import {
  deleteDestination,
  deleteDestinationIfExpired,
  destinationsQuery,
} from '@/db/destinations';
import { getDestinationToken } from '@/db/secure-token';
import { useNow } from '@/hooks/use-now';

import {
  EXPIRY_CHECK_INTERVAL_MS,
  expiresAtMs,
  formatExpiry,
  isTokenExpired,
} from './capability-token';

/** One non-expired destination in the pool, ready to render (host/expiry) or upload to. */
export type DestinationOption = {
  id: string;
  server: string;
  artifactId: string;
  token: string | null;
  /** Millisecond `exp` for a decodable token, else `null` (tokenless = no known expiry). */
  expiresAtMs: number | null;
  /** Preformatted expiry label ("No expiry" / "Expires in 4m" / …), so views don't read the clock. */
  expiryLabel: string;
};

/**
 * Bumped when a pairing rewrites the token of a row that already existed (the same link again
 * keeps its row id). Each `useDestinations` loads tokens only when its set of row ids changes, so
 * without this a screen already open would keep the row's old token; a bump makes every one
 * reload them from secure-store.
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
 * both surfaces agree on exactly which destinations are live.
 */
export function useDestinations() {
  const { data: rows } = useLiveQuery(destinationsQuery);
  // Reactive wall-clock so expiry filtering/labels re-evaluate as time passes, even without a DB
  // write — a token can lapse while the user just sits on the screen.
  const now = useNow(EXPIRY_CHECK_INTERVAL_MS);
  const version = useSyncExternalStore(subscribeTokens, () => tokensVersion);

  // Tokens live in secure-store keyed by row id; load them into a map keyed on id. Re-fires only
  // when the set of ids changes or a pairing rewrote a token (`version`), not on every render.
  const idsKey = useMemo(() => rows.map((r) => r.id).join(','), [rows]);
  const [tokens, setTokens] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let cancelled = false;
    const ids = idsKey ? idsKey.split(',') : [];
    // Each row on its own: a token that can't be read hides that row, not the whole pool.
    void Promise.all(
      ids.map((id) =>
        getDestinationToken(id).then(
          (token) => [[id, token] as const],
          () => [],
        ),
      ),
    ).then((entries) => {
      if (!cancelled) setTokens(Object.fromEntries(entries.flat()));
    });
    return () => {
      cancelled = true;
    };
  }, [idsKey, version]);

  const destinations: DestinationOption[] = useMemo(
    () =>
      rows
        // Only once its token has loaded: before that it would read as a tokenless link, and
        // uploading with it would spend the link on a certain 401.
        .filter((r) => r.id in tokens)
        .map((r) => ({ ...r, token: tokens[r.id] ?? null }))
        .filter((r) => !isTokenExpired(r.token, now))
        .map((r) => ({
          id: r.id,
          server: r.server,
          artifactId: r.artifactId,
          token: r.token,
          expiresAtMs: expiresAtMs(r.token),
          expiryLabel: formatExpiry(r.token, now),
        })),
    // `now` intentionally in deps so an expiry that passes between ticks re-filters the list.
    [rows, tokens, now],
  );

  // Garbage-collect rows whose token has actually lapsed so they don't linger as dead state.
  // Only acts on tokens we've loaded and can decode as expired (never on "unknown").
  useEffect(() => {
    for (const r of rows) {
      const token = tokens[r.id];
      if (token !== undefined && isTokenExpired(token, now)) {
        // Decided again from the stored token when it runs: a re-pair may have refreshed it.
        void deleteDestinationIfExpired(r.id, (stored) => isTokenExpired(stored, Date.now())).catch(
          () => {},
        );
      }
    }
  }, [rows, tokens, now]);

  return { destinations, deleteDestination };
}
