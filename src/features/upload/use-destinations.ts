import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { deleteDestination, destinationsQuery } from '@/db/destinations';
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
 * Destinations removed in the sheet whose Undo toast is still up: left out of the pool everywhere
 * (the sheet, the home pill, export's chips) but not deleted until the toast goes, so Undo only
 * shows them again and an upload can't pick one that's about to go. Module-level, not sheet
 * state: the toast outlives the sheet, which closes when its last row goes.
 */
let pendingRemoval: ReadonlySet<string> = new Set();
const pendingListeners = new Set<() => void>();

export function setPendingRemoval(update: (ids: Set<string>) => void) {
  const next = new Set(pendingRemoval);
  update(next);
  pendingRemoval = next;
  for (const listener of pendingListeners) listener();
}

// Pool writes that race each other (an Undo's delete, a re-pair's add) run one at a time, in the
// order they were asked for: a delete then decides what to remove only when its turn comes, after
// any re-pair before it took its row back out of `pendingRemoval`.
let poolWrites: Promise<unknown> = Promise.resolve();

/** Runs `write` after every pool write queued before it; its result (or error) is the caller's. */
export function queuePoolWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = poolWrites.then(write);
  poolWrites = run.catch(() => {});
  return run;
}

// A deleted row stays in `pendingRemoval` a beat after it's gone: the live query re-reads only
// after the delete lands, and dropping it from the set before that would flash the row back.
const FORGET_AFTER_MS = 2000;

/**
 * Delete the removed destinations that are still waiting on their Undo when the write's turn
 * comes (a re-pair of the same link takes its row back out of the set, and it's kept). Rows whose
 * delete failed come back at once, the rest a beat after they're gone; any failure is rethrown.
 */
export function commitRemoval(ids: string[]): Promise<void> {
  return queuePoolWrite(async () => {
    const still = ids.filter((id) => pendingRemoval.has(id));
    const results = await Promise.allSettled(still.map((id) => deleteDestination(id)));
    const unhide = (gone: string[]) =>
      setPendingRemoval((pending) => gone.forEach((id) => pending.delete(id)));
    const failed = still.filter((_, i) => results[i].status === 'rejected');
    const deleted = still.filter((_, i) => results[i].status === 'fulfilled');
    unhide(failed);
    setTimeout(() => unhide(deleted), FORGET_AFTER_MS);
    const error = results.find((r) => r.status === 'rejected');
    if (error) throw (error as PromiseRejectedResult).reason;
  });
}

function subscribePendingRemoval(listener: () => void) {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
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
  const pending = useSyncExternalStore(subscribePendingRemoval, () => pendingRemoval);

  // Tokens live in secure-store keyed by row id; load them into a map keyed on id. Re-fires only
  // when the set of ids changes, not on every render.
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
  }, [idsKey]);

  const destinations: DestinationOption[] = useMemo(
    () =>
      rows
        // Only once its token has loaded: before that it would read as a tokenless link, and
        // uploading with it would spend the link on a certain 401.
        .filter((r) => r.id in tokens && !pending.has(r.id))
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
    [rows, tokens, now, pending],
  );

  // Garbage-collect rows whose token has actually lapsed so they don't linger as dead state.
  // Only acts on tokens we've loaded and can decode as expired (never on "unknown"). Queued with
  // the other pool writes, and re-read on its turn: re-pairing the same link gives that row a
  // fresh token, which must not be deleted on the strength of the old one.
  useEffect(() => {
    for (const r of rows) {
      const token = tokens[r.id];
      if (token !== undefined && isTokenExpired(token, now)) {
        void queuePoolWrite(async () => {
          if (isTokenExpired(await getDestinationToken(r.id), Date.now())) {
            await deleteDestination(r.id);
          }
        }).catch(() => {});
      }
    }
  }, [rows, tokens, now]);

  // The pool plus the rows an Undo can still bring back: what the destinations sheet sizes itself
  // for when it opens, so an Undo while it's open can't outgrow a fitted sheet.
  const countWithPending = destinations.length + rows.filter((r) => pending.has(r.id)).length;

  return { destinations, countWithPending, deleteDestination };
}
