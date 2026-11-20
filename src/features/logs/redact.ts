/**
 * Blanks out credentials before a line reaches the log (C5). Logs get shared (About's Share logs,
 * the embed's `logFile()`), and a token in one is a live credential: an upload capability, a
 * host's bearer token. What goes:
 *
 * - the value of any field, header or parameter named like a credential (`token`,
 *   `uploadToken`, `access_token`, `secret`, `password`, `apiKey`, `cookie`, `signature`,
 *   `Authorization`), in JSON (`"token": "…"`), in a header line (`Authorization: Basic …`) or in
 *   a URL or form (`?token=…`, `#token=…`);
 * - a `Bearer` or `Basic` credential wherever it appears;
 * - anything shaped like a capability token or a JWT: `base64url(JSON claims).signature`, which
 *   starts `eyJ` (`{"` in base64url) and has a second dot-separated part.
 *
 * Redacting twice changes nothing, so a line read back from the log file can be redacted again.
 */

export const REDACTED = '[redacted]';

/**
 * Key names whose values are credentials. Matched at the end of a key: not `tokenExpiresAt`. The
 * part before the credential word is bounded (40 characters): unbounded, it was retried from every
 * word boundary to the end of a long token (base64url, joined UUIDs), which made one large logged
 * string take seconds.
 */
const SECRET_KEY = String.raw`[A-Za-z0-9_.-]{0,40}?(?:token|secret|password|passwd|api[_-]?key|cookie|signature|authorization|credential)`;

/** `"uploadToken": "…"` and `'token': '…'`: a quoted key, then a quoted value. */
const JSON_FIELD = new RegExp(
  String.raw`(["'])(${SECRET_KEY})\1(\s*:\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`,
  'gi',
);

/** `"token": eyJ…` style unquoted JSON values (a number, or a bare word). */
const JSON_BARE = new RegExp(
  String.raw`(["'])(${SECRET_KEY})\1(\s*:\s*)(?!["'\[{]|null\b|true\b|false\b)[^\s,}\]]+`,
  'gi',
);

/** `Authorization: Basic abc` as a header line: everything to the end of the line. */
const HEADER = /\b((?:proxy-)?authorization|cookie|set-cookie)(\s*:\s*)(?!["'\s])[^\r\n]+/gi;

/** `token: abc` in a plain log line (`console.log('token:', t)`), the value up to a separator. */
const KEY_COLON = new RegExp(String.raw`\b(${SECRET_KEY})(\s*:\s*)(?!["'\s\[{])[^\s,;}\]]+`, 'gi');

/** `token=…` in a URL query or fragment, a form body or a `key=value` log line. */
const PARAM = new RegExp(String.raw`(^|[?&#;\s,(])(${SECRET_KEY})(=)[^&\s"'<>#;,)]+`, 'gi');

/** `Bearer abc…` / `Basic abc…` wherever it appears: 8 characters or more, so prose ("Basic plan") stays. */
const SCHEME = /\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/g;

/** A capability token or JWT: base64url JSON (`eyJ…`) and at least one more dotted part. */
const TOKEN_SHAPED = /\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+){1,2}/g;

/** The longest entry kept (16 KB of text): a logged JSON dump or blob is cut to this. */
export const MAX_ENTRY_CHARS = 16 * 1024;

/**
 * An entry as the log keeps it: redacted, and cut to `MAX_ENTRY_CHARS`. Redaction runs on a
 * stretch twice that long before the cut, so a credential that crosses the cut is still found
 * whole and blanked rather than left half-matched; the rest of a huge string is never scanned.
 */
export function redactEntry(text: string): string {
  if (text.length <= MAX_ENTRY_CHARS) return redact(text);
  const cleaned = redact(text.slice(0, MAX_ENTRY_CHARS * 2));
  if (cleaned.length <= MAX_ENTRY_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_ENTRY_CHARS)}… [${text.length} characters, cut]`;
}

export function redact(text: string): string {
  return text
    .replace(
      JSON_FIELD,
      (_m, q: string, key: string, sep: string) => `${q}${key}${q}${sep}"${REDACTED}"`,
    )
    .replace(
      JSON_BARE,
      (_m, q: string, key: string, sep: string) => `${q}${key}${q}${sep}"${REDACTED}"`,
    )
    .replace(HEADER, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`)
    .replace(KEY_COLON, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`)
    .replace(PARAM, (_m, lead: string, key: string, eq: string) => `${lead}${key}${eq}${REDACTED}`)
    .replace(SCHEME, (_m, scheme: string, space: string) => `${scheme}${space}${REDACTED}`)
    .replace(TOKEN_SHAPED, REDACTED);
}
