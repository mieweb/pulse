import { decodeCapabilityClaims } from './capability-token';

// Bump when the pairing link shape changes incompatibly — a client that
// doesn't recognize `v` refuses the link outright instead of misparsing it.
const SUPPORTED_LINK_VERSION = '1';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UploadDeepLink = {
  artifactId: string;
  /**
   * The full base URL to upload to — origin *plus* whatever path prefix the
   * operator mounted `pulsevault` at (e.g. `https://vault.example.org/pulsevault`),
   * not just the bare origin. Every route is `${server}/<path>` (`/capabilities`,
   * `/upload`, `/artifacts/:id`) — there is no separate "prefix" concept on the
   * client side, the server value already includes it.
   */
  server: string;
  token: string | null;
  /** Set when the link's token names the place its upload is for; absent on a plain link. */
  place?: LinkPlace;
};

/**
 * The place a link's upload is for. `ref` is the host's opaque key for the place, read from the
 * token's signed `ref` claim (the URL has no such param). The names and the return URL are the
 * link's own params: unsigned display hints.
 */
export type LinkPlace = {
  /** Pulse matches destinations and drafts on `(server, ref)`. */
  ref: string;
  /** What the host calls the place ("Team · Huddle"), ≤ 60 chars; `null` when not given. */
  label: string | null;
  /** The name for a new draft made from this link ("Huddle update"), ≤ 80 chars; `null` = none. */
  name: string | null;
  /** The host app's name ("TimeHuddle"), ≤ 30 chars. */
  app: string | null;
  /** The host page to go back to after the upload (https, or http for a private/dev origin). */
  returnUrl: string | null;
};

/** Display caps for a link's host-supplied names (longer ones are cut, not refused). */
const MAX_LABEL_LENGTH = 60;
const MAX_NAME_LENGTH = 80;
const MAX_APP_LENGTH = 30;

export type DeepLinkResult =
  | { ok: true; link: UploadDeepLink }
  | { ok: false; reason: 'unsupported-version' | 'invalid-link' };

/**
 * Private/dev origins allowed over plain http — never extended beyond
 * non-globally-routable address space (RFC 1918 private ranges, RFC 6598
 * carrier-grade-NAT shared space used by some mesh routers/ISP setups, and
 * link-local) plus loopback/localhost. Never extended to a public IP or
 * domain just because it "looks internal."
 */
function isPrivateDevOrigin(url: URL): boolean {
  if (url.protocol !== 'http:') return false;
  const host = url.hostname;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    /^10\.\d+\.\d+\.\d+$/.test(host) ||
    /^192\.168\.\d+\.\d+$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host) || // RFC 6598, 100.64.0.0/10
    /^169\.254\.\d+\.\d+$/.test(host) // link-local
  );
}

/** An https URL, or an http one on a private/dev origin; `null` for anything else. */
function parseAllowedUrl(raw: string | null): URL | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === 'https:' || isPrivateDevOrigin(url) ? url : null;
}

/** A host-supplied display name, trimmed and capped; empty is `null`. */
function displayName(raw: string | null, max: number): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** Path of the https pairing link on the link host (#252). */
export const PAIRING_LINK_PATH = '/pulse/open';

/**
 * The parameter string of a pairing link, or `null` when `url` isn't one. Two forms carry the
 * same parameters:
 * - `pulsecam://?<params>`: everything after `?`.
 * - `https://<linkHost>/pulse/open#<params>`: the Universal Link / App Link form (#252). The
 *   parameters ride in the fragment, so the link host never receives the token.
 *
 * Parsed by hand (not via expo-linking or `URL`) so this stays a dependency-free pure function —
 * React Native's `URL` cuts `hash` at the first `/`, which an unencoded `server=https://…` has.
 */
export function pairingLinkParams(url: string, linkHost?: string | null): string | null {
  if (url.startsWith('pulsecam://')) {
    const queryIndex = url.indexOf('?');
    return queryIndex >= 0 ? url.slice(queryIndex + 1) : '';
  }
  if (!linkHost) return null;
  const match = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?(?:#(.*))?$/i.exec(url);
  if (!match || match[1].toLowerCase() !== linkHost.toLowerCase()) return null;
  if ((match[2] ?? '').replace(/\/$/, '') !== PAIRING_LINK_PATH) return null;
  return match[3] ?? '';
}

/**
 * Parse and validate an upload pairing link, in either form `pairingLinkParams` takes. Rejects
 * anything the app can't safely act on — an unrecognized version, a malformed artifactId, a
 * server origin that isn't HTTPS (except the explicit localhost/private-IP dev allowance) —
 * rather than guessing. A token with a `ref` claim makes it a link for that place (`place`), with
 * the link's naming hints; without one it is a plain one-use upload, exactly as before.
 */
export function parseUploadDeepLink(url: string, linkHost?: string | null): DeepLinkResult {
  const query = pairingLinkParams(url, linkHost);
  if (query === null) return { ok: false, reason: 'invalid-link' };

  // An ordinary query string `URLSearchParams` handles regardless of the link's form.
  const params = new URLSearchParams(query);
  const param = (key: string): string | null => params.get(key);

  if (param('v') !== SUPPORTED_LINK_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }

  const artifactId = param('artifactId');
  if (!artifactId || !UUID_REGEX.test(artifactId)) {
    return { ok: false, reason: 'invalid-link' };
  }

  const rawServer = param('server');
  if (!rawServer || !parseAllowedUrl(rawServer)) return { ok: false, reason: 'invalid-link' };
  // Keep the full base URL (origin + path prefix), trailing slash stripped —
  // collapsing to just `.origin` would silently drop the prefix the operator
  // mounted pulsevault at, breaking every subsequent request.
  const server = rawServer.replace(/\/$/, '');
  const token = param('token');

  // Any other param (e.g. `uploadUnit` from an older server) is ignored, not rejected (PROTOCOL §3).
  // The place this upload is for is read from the token's signed `ref` claim, never from the URL:
  // it decides which draft the recorder opens on. Without one (an older server, an opaque token,
  // no token) the link is a plain one-use upload, and its naming hints are ignored.
  const ref = token ? decodeCapabilityClaims(token)?.ref : undefined;
  if (!ref) return { ok: true, link: { artifactId, server, token } };

  const returnUrl = param('return');
  return {
    ok: true,
    link: {
      artifactId,
      server,
      token,
      place: {
        ref,
        label: displayName(param('label'), MAX_LABEL_LENGTH),
        name: displayName(param('name'), MAX_NAME_LENGTH),
        app: displayName(param('app'), MAX_APP_LENGTH),
        // An unusable return URL is dropped, not a reason to refuse the link.
        returnUrl: parseAllowedUrl(returnUrl) ? returnUrl : null,
      },
    },
  };
}
