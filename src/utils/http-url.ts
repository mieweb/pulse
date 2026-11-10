/** What `parseHttpUrl` reads from an `http(s)://` URL. */
export type HttpUrl = {
  protocol: 'https:' | 'http:';
  /** The host a request to this URL goes to, lowercased, with its port if it has one. */
  host: string;
  /** The same without the port. */
  hostname: string;
  /** Whether the URL carries a username or password before its host. */
  credentials: boolean;
};

/**
 * The scheme and host of an `http(s)://` URL, read by hand; `null` for anything else.
 *
 * Not `new URL()`: React Native's own `URL` is a set of regular expressions that accepts any
 * string and takes whatever follows the first `@` for the host — `https://evil.example/x@good.org`
 * reads as `good.org`, though every request to it goes to `evil.example`. A host that is shown to
 * a person to trust, or checked against a rule, has to be the host the request really goes to:
 * the part between `://` and the first `/`, `?` or `#`, after any `user:password@`.
 *
 * A URL two parsers could split differently is refused outright: one with whitespace, control
 * characters or a backslash (which browsers read as `/`).
 */
export function parseHttpUrl(raw: string): HttpUrl | null {
  if (/[\s\\\p{Cc}]/u.test(raw)) return null;
  const match = /^(https?):\/\/([^/?#]*)/i.exec(raw);
  if (!match) return null;
  const authority = match[2];
  const at = authority.lastIndexOf('@');
  const host = authority.slice(at + 1).toLowerCase();
  // `[::1]:8080` keeps its brackets; anything else ends at its port's colon.
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.replace(/:\d*$/, '');
  if (hostname === '') return null;
  return {
    protocol: match[1].toLowerCase() === 'https' ? 'https:' : 'http:',
    host,
    hostname,
    credentials: at >= 0,
  };
}
