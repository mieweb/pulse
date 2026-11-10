import { hostOf } from '@/utils/format';

import { expiresAtMs, formatExpiry, isTokenExpired } from './capability-token';
import { cleanApp, cleanLabel, readReturnUrl } from './deep-link';

/** A row of the pool (`upload_destinations`), as `destinationsQuery` reads it. */
export type DestinationRow = {
  id: string;
  server: string;
  artifactId: string;
  ref: string | null;
  label: string | null;
  app: string | null;
  returnUrl: string | null;
};

/** One live destination in the pool, ready to render (host/expiry) or upload to. */
export type DestinationOption = {
  id: string;
  server: string;
  artifactId: string;
  /** Set when the link named the place its upload is for: the host's key for that place. */
  ref: string | null;
  /**
   * The link's names for the place and the host page to return to (links with a `ref` only):
   * unsigned text from whoever built the link, cleaned for display.
   */
  label: string | null;
  app: string | null;
  returnUrl: string | null;
  token: string | null;
  /** Millisecond `exp` for a decodable token, else `null` (tokenless = no known expiry). */
  expiresAtMs: number | null;
  /** Preformatted expiry label ("No expiry" / "Expires in 4m" / …), so views don't read the clock. */
  expiryLabel: string;
};

/**
 * Whether a row's link can no longer be uploaded with: its token has expired, or it is a place's
 * row with no token at all. A place's link always has one (its `ref` is read from it), so a row
 * without it is one whose pairing was cut short between its two writes (see `upsertPlace`).
 */
export function isSpentLink(ref: string | null, token: string | null, nowMs: number): boolean {
  return isTokenExpired(token, nowMs) || (ref !== null && token === null);
}

/**
 * The pool as the app offers it: the rows whose token has loaded (`tokens`, by row id) and whose
 * link still works, in the rows' order. A row's names and return URL are cleaned again here, so
 * what is shown is safe whatever version of the app stored it.
 */
export function destinationOptions(
  rows: readonly DestinationRow[],
  tokens: Readonly<Record<string, string | null>>,
  nowMs: number,
): DestinationOption[] {
  return (
    rows
      // Only once its token has loaded: before that it would read as a tokenless link, and
      // uploading with it would spend the link on a certain 401.
      .filter((r) => r.id in tokens)
      .map((r) => ({ ...r, token: tokens[r.id] ?? null }))
      .filter((r) => !isSpentLink(r.ref, r.token, nowMs))
      .map((r) => ({
        id: r.id,
        server: r.server,
        artifactId: r.artifactId,
        ref: r.ref,
        label: cleanLabel(r.label),
        app: cleanApp(r.app),
        returnUrl: readReturnUrl(r.returnUrl)?.url ?? null,
        token: r.token,
        expiresAtMs: expiresAtMs(r.token),
        expiryLabel: formatExpiry(r.token, nowMs),
      }))
  );
}

/**
 * What each place in the pool is called: a lookup from a draft's place (`contextServer`,
 * `contextRef`) to its row's label. Every row counts, whether or not its link still works — an
 * expired row is kept for exactly this while a draft recorded for it is unsent. `null` for a
 * draft with no place, or whose place has no row (it was claimed) or no label.
 */
export function placeLabelLookup(
  rows: readonly Pick<DestinationRow, 'server' | 'ref' | 'label'>[],
): (server: string | null, ref: string | null) => string | null {
  const labels = new Map<string, string>();
  for (const row of rows) {
    const label = row.ref === null ? null : cleanLabel(row.label);
    if (label !== null) labels.set(JSON.stringify([row.server, row.ref]), label);
  }
  return (server, ref) =>
    server !== null && ref !== null ? (labels.get(JSON.stringify([server, ref])) ?? null) : null;
}

/**
 * A destination as a screen reader says it. A place's label is the link's own word for it, not
 * the server's, so the host is always said with it: where the video goes is the host.
 */
export function destinationSpokenName(
  destination: Pick<DestinationOption, 'server' | 'label'>,
): string {
  const host = hostOf(destination.server);
  return destination.label ? `${destination.label} on ${host}` : host;
}
