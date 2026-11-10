import * as Crypto from 'expo-crypto';
import { and, desc, eq, type SQL, sql } from 'drizzle-orm';

import { db } from './client';
import { drafts, uploadDestinations } from './schema';
import { deleteDestinationToken, getDestinationToken, setDestinationToken } from './secure-token';

/**
 * A server the device has paired with (via a `pulsecam://` deep link) but no draft has
 * consumed yet. Device-wide, not per-draft — unlike `drafts.upload*` (drafts.ts), this
 * lives independently of any one draft so the user can pick *which* draft to send, and to
 * *which* destination, at upload time. A destination is single-use: a draft claiming it for
 * an upload, or the user deleting it, removes it here.
 */
export type PairedDestination = {
  server: string;
  token: string | null;
  artifactId: string;
};

/**
 * What a link says about the place its upload is for (its hints, see deep-link.ts). `ref` is the
 * host's key for the place: until a draft claims it there is one destination per `(server, ref)`,
 * and a newer link for the place replaces the older one's upload. Claimed, the row is gone like
 * any other; the next link for the place makes a new one.
 */
export type DestinationPlace = {
  ref: string;
  label: string | null;
  app: string | null;
  returnUrl: string | null;
};

/** The non-secret portion, persisted in the `upload_destinations` table. The token (a live
 * bearer credential) lives in expo-secure-store instead — see `secure-token.ts`. */
export type PairedDestinationMeta = Omit<PairedDestination, 'token'>;

/** Live-queryable pool of paired destinations, newest first. */
export const destinationsQuery = db
  .select({
    id: uploadDestinations.id,
    server: uploadDestinations.server,
    artifactId: uploadDestinations.artifactId,
    ref: uploadDestinations.ref,
    label: uploadDestinations.label,
    app: uploadDestinations.app,
    returnUrl: uploadDestinations.returnUrl,
    createdAt: uploadDestinations.createdAt,
  })
  .from(uploadDestinations)
  .orderBy(desc(uploadDestinations.createdAt));

/**
 * Pairing and the expiry sweep, one at a time. The sweep decides from a token it loaded earlier;
 * run alongside a re-pair of the same row, it could delete the row just after the re-pair gave it
 * a fresh token. In turn, the sweep reads the token again and sees the fresh one.
 */
let pairingQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const result = pairingQueue.then(run, run);
  pairingQueue = result.catch(() => {});
  return result;
}

/**
 * Add a paired destination to the pool. Deduped by `(server, artifactId)` — re-scanning the
 * same link (same server-minted artifact) refreshes that row's token in place instead of
 * piling up duplicates. A link that names its `place` is deduped by `(server, ref)` instead: the
 * place keeps its one row, which takes this link's upload, token and hints and moves to the front
 * of the pool — unless the link it has is the newer of the two (`supersedes`), which is then left
 * alone. Returns the row id (existing or freshly minted).
 *
 * `supersedes`: whether this link replaces the one the place's row holds, given that one's stored
 * token (`null` when it has none). A link opened again, or an older one opened late (a stale tab,
 * a replayed launch), must not take the place of a newer one.
 */
export function addDestination(
  dest: PairedDestination,
  place?: DestinationPlace,
  supersedes: (storedToken: string | null) => boolean = () => true,
): Promise<string> {
  return oneAtATime(() => (place ? upsertPlace(dest, place, supersedes) : insertOrRefresh(dest)));
}

async function insertOrRefresh(dest: PairedDestination): Promise<string> {
  const meta: PairedDestinationMeta = {
    server: dest.server,
    artifactId: dest.artifactId,
  };
  const existing = await db
    .select({ id: uploadDestinations.id })
    .from(uploadDestinations)
    .where(eq(uploadDestinations.artifactId, dest.artifactId));
  const match = existing.find(() => true); // artifactId is server-unique in practice
  const id = match?.id ?? Crypto.randomUUID();
  if (match) {
    await db
      .update(uploadDestinations)
      .set({ server: meta.server })
      .where(eq(uploadDestinations.id, id));
  } else {
    await db.insert(uploadDestinations).values({ id, ...meta });
  }
  await setDestinationToken(id, dest.token);
  return id;
}

async function upsertPlace(
  dest: PairedDestination,
  place: DestinationPlace,
  supersedes: (storedToken: string | null) => boolean,
): Promise<string> {
  const [match] = await db
    .select({ id: uploadDestinations.id })
    .from(uploadDestinations)
    .where(and(eq(uploadDestinations.server, dest.server), eq(uploadDestinations.ref, place.ref)));
  if (match && !supersedes(await getDestinationToken(match.id))) return match.id;
  const id = match?.id ?? Crypto.randomUUID();
  const link = { artifactId: dest.artifactId, ...place };
  // The row and its token live in two stores, so the two writes can't be one. The token goes
  // last, and the old one is cleared first: stopped anywhere in between, the row has no token
  // (and isn't offered, see `useDestinations`) rather than a new upload id with the old link's
  // token, which the server would refuse every time. Opening the link again completes it.
  if (match) {
    await setDestinationToken(id, null);
    await db
      .update(uploadDestinations)
      .set({ ...link, createdAt: sql`(unixepoch('subsec') * 1000)` })
      .where(eq(uploadDestinations.id, id));
  } else {
    await db.insert(uploadDestinations).values({ id, server: dest.server, ...link });
  }
  await setDestinationToken(id, dest.token);
  return id;
}

/** Fetch one destination (row + secure-stored token); `null` if it's gone. */
export async function getDestination(id: string): Promise<PairedDestination | null> {
  const rows = await db
    .select({
      server: uploadDestinations.server,
      artifactId: uploadDestinations.artifactId,
    })
    .from(uploadDestinations)
    .where(eq(uploadDestinations.id, id));
  const row = rows[0];
  if (!row) return null;
  return { ...row, token: await getDestinationToken(id) };
}

/**
 * Remove a destination from the pool (claimed by an upload, or deleted by the user). Returns
 * whether this call removed it — when two drafts claim the same link, only one gets `true`.
 */
export async function deleteDestination(id: string): Promise<boolean> {
  const removed = await removeRow(id);
  // Best-effort: once the row is gone the link is spent, whatever happens to its token.
  await deleteDestinationToken(id).catch(() => {});
  return removed;
}

async function removeRow(id: string, condition?: SQL): Promise<boolean> {
  const rows = await db
    .delete(uploadDestinations)
    .where(and(eq(uploadDestinations.id, id), condition))
    .returning({ id: uploadDestinations.id });
  return rows.length > 0;
}

/** A draft recorded for this row's place that hasn't been uploaded yet. */
const hasUnsentDraft = sql`exists (select 1 from ${drafts} where ${drafts.contextServer} = ${uploadDestinations.server} and ${drafts.contextRef} = ${uploadDestinations.ref} and ${drafts.uploadStatus} is not 'uploaded')`;

/**
 * The expiry sweep's delete: removes the row only if its token, read again now, is still
 * `expired` (see `oneAtATime`). A place's unclaimed row stays while a draft recorded for it is
 * unsent, so that draft keeps the place's label on Home; the next link for the place revives the
 * row. Returns whether it removed it.
 */
export function deleteDestinationIfExpired(
  id: string,
  expired: (token: string | null) => boolean,
): Promise<boolean> {
  return oneAtATime(async () => {
    const token = await getDestinationToken(id);
    if (!expired(token)) return false;
    // A row that stays keeps its token: the next link for the place is compared with it.
    if (!(await removeRow(id, sql`not ${hasUnsentDraft}`))) return false;
    await deleteDestinationToken(id).catch(() => {});
    return true;
  });
}
