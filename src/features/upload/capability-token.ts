// Best-effort, client-side read of a pulsevault capability token's claims —
// for UX only (showing "expires in 4m", hiding a dead upload button before
// the user taps into a guaranteed-403, opening the recorder on the place a
// link is for). The server is the only authority on validity; this never
// verifies the HMAC signature, just decodes the unencrypted payload segment,
// exactly like reading a JWT's claims without verifying it. A token that
// doesn't match `issueCapabilityToken`'s `<base64url-json>.<signature>` shape
// (any other Pulse-compatible server is free to use its own opaque scheme per
// the protocol) decodes to `null` — callers must treat that as "validity
// unknown", not "expired".

import { codePointLength } from '@/utils/display-text';

/**
 * The two claims a client may read from a token, and the only ones it acts on (PROTOCOL.md §5.6).
 * Everything else in a token is the server's.
 */
export type ReadableClaims = {
  /** When the link stops working, in seconds since the Unix epoch. The server decides. */
  exp: number;
  /**
   * The place this upload is for, when the host named one: its opaque key (1–200 characters).
   * The only place a link's `ref` is read from (see deep-link.ts). The client can't check that
   * the server signed it; the server refuses a token whose `ref` was changed.
   */
  ref?: string;
};

const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Decodes base64url without padding (RFC 4648 §5) to a byte string (one char per byte; see
 * `utf8`). `null` for anything else: padding, the `+` and `/` of plain base64, a length no
 * encoding produces.
 */
function base64UrlDecode(input: string): string | null {
  if (input.length % 4 === 1) return null;
  let buffer = 0;
  let bits = 0;
  let output = '';
  for (const char of input) {
    const value = BASE64URL_CHARS.indexOf(char);
    if (value === -1) return null;
    buffer = ((buffer << 6) | value) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return output;
}

/** A byte string (from `base64UrlDecode`) read as UTF-8; `null` when it isn't valid UTF-8. */
function utf8(bytes: string): string | null {
  try {
    return decodeURIComponent(
      Array.from(bytes, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
    );
  } catch {
    return null;
  }
}

const MAX_REF_LENGTH = 200;

/** Half of a surrogate pair on its own: with the `u` flag a whole pair is one character. */
const UNPAIRED_SURROGATE = /\p{Cs}/u;

/**
 * A usable `ref` claim: a string of 1 to 200 characters (code points) with no unpaired surrogate,
 * so every client reads the same key from it. Any other reads as none.
 */
function isRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    !UNPAIRED_SURROGATE.test(value) &&
    // A code point is one or two UTF-16 units, so only a string between the two needs counting.
    (value.length <= MAX_REF_LENGTH ||
      (value.length <= 2 * MAX_REF_LENGTH && codePointLength(value) <= MAX_REF_LENGTH))
  );
}

/**
 * The claims a client reads from a token, as PROTOCOL.md §5.6 says to read them: the part before
 * the first `.`, base64url without padding, the UTF-8 text of one JSON object. Returns `null` —
 * a credential Pulse can't read: no known expiry, no place — for any other token rather than
 * throwing (see the module doc), and for one whose claims lack any of `artifactId`, `iat`, `exp`,
 * `kid` and `issuer`, the form a server that wants its claims read issues. `exp` has to be a whole
 * number of seconds: a token without one has no `ref` either (a place's links are ordered by it),
 * and `1e400`, which JSON reads as infinity, is no expiry at all.
 */
export function decodeCapabilityClaims(token: string): ReadableClaims | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const bytes = base64UrlDecode(token.slice(0, dot));
  const text = bytes === null ? null : utf8(bytes);
  if (!text) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) return null;
  const { artifactId, iat, exp, kid, issuer, ref } = claims as Record<string, unknown>;
  if (
    typeof artifactId !== 'string' ||
    typeof iat !== 'number' ||
    !Number.isSafeInteger(exp) ||
    typeof kid !== 'string' ||
    typeof issuer !== 'string'
  ) {
    return null;
  }
  // A `ref` that isn't a usable key reads as none: the token is then a plain upload's.
  return isRef(ref) ? { exp: exp as number, ref } : { exp: exp as number };
}

/**
 * Whether `claims.exp` has passed, with `bufferMs` of safety margin so we
 * stop offering an upload that would race the server's clock to a 403
 * rather than actually have time to send anything.
 */
export function isClaimsExpired(claims: ReadableClaims, bufferMs: number, nowMs: number): boolean {
  return nowMs >= claims.exp * 1000 - bufferMs;
}

// Safety margin before a token's real `exp` so we never start a request that would land at the
// server just past expiry. Also the cadence a caller should re-check expiry on its own, so a
// button that's still valid disappears within this long of going stale.
export const EXPIRY_BUFFER_MS = 10_000;
export const EXPIRY_CHECK_INTERVAL_MS = 15_000;

/**
 * Best-effort expiry check for a bearer token. A `null` token or an opaquely-shaped one (a
 * non-pulsevault server whose scheme we can't read) means "validity unknown" — treated as
 * NOT expired, never blocking on what we can't decode. Only a token we *can* decode and that
 * has actually lapsed (with `EXPIRY_BUFFER_MS` margin) returns true.
 */
export function isTokenExpired(token: string | null, nowMs: number): boolean {
  if (!token) return false;
  const claims = decodeCapabilityClaims(token);
  if (!claims) return false;
  return isClaimsExpired(claims, EXPIRY_BUFFER_MS, nowMs);
}

/** Millisecond `exp` for a decodable token, else `null` (tokenless / opaque = no known expiry). */
export function expiresAtMs(token: string | null): number | null {
  if (!token) return null;
  const claims = decodeCapabilityClaims(token);
  return claims ? claims.exp * 1000 : null;
}

/**
 * Whether the link with `token` is newer than the one whose token is `stored`: it stops working
 * later. Told from `exp`, which with `ref` is all a client reads from a token (PROTOCOL.md §5.6).
 * A stored token that is gone or can't be read is always replaced; a link that can't be read
 * never replaces one that can.
 */
export function expiresLater(token: string | null, stored: string | null): boolean {
  const storedExp = expiresAtMs(stored);
  if (storedExp === null) return true;
  const exp = expiresAtMs(token);
  return exp !== null && exp > storedExp;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Human label for a token's remaining validity, for the destination UI: `"No expiry"` (tokenless /
 * opaque), `"Expired"`, or `"Expires in"` the largest unit that reads naturally — seconds, then
 * minutes under an hour, hours under two days, else days (a 7-day link reads "7d", not "10079m").
 * Minutes and hours round down, so the label never promises time that isn't there; days round to
 * nearest, or a link minted seconds ago would read a day short ("6d") for most of its first day.
 */
export function formatExpiry(token: string | null, nowMs: number): string {
  const exp = expiresAtMs(token);
  if (exp === null) return 'No expiry';
  const remainingMs = exp - EXPIRY_BUFFER_MS - nowMs;
  if (remainingMs <= 0) return 'Expired';
  if (remainingMs >= 2 * DAY_MS) return `Expires in ${Math.round(remainingMs / DAY_MS)}d`;
  if (remainingMs >= HOUR_MS) return `Expires in ${Math.floor(remainingMs / HOUR_MS)}h`;
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes >= 1) return `Expires in ${minutes}m`;
  return `Expires in ${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
}
