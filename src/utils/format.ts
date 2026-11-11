/**
 * Milliseconds → "m:ss", or "h:mm:ss" from an hour up (72000 → "1:12", 4_325_000 → "1:12:05").
 * `pad` zero-pads the minutes under an hour ("00:07"); `floor` truncates instead of rounding
 * (a playhead shouldn't read a second ahead).
 */
export function formatDuration(
  ms: number,
  { pad = false, floor = false }: { pad?: boolean; floor?: boolean } = {},
): string {
  const total = Math.max(0, (floor ? Math.floor : Math.round)(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = (total % 60).toString().padStart(2, '0');
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds}`;
  return `${pad ? minutes.toString().padStart(2, '0') : minutes}:${seconds}`;
}

/** Milliseconds → zero-padded "mm:ss" (7000 → "00:07"), "h:mm:ss" from an hour up. */
export function formatDurationPadded(ms: number): string {
  return formatDuration(ms, { pad: true });
}

const numberFormat = new Intl.NumberFormat();

/** A count with its noun, grouped for the locale: "1 clip", "1,284 clips". */
export function formatCount(count: number, one: string, other: string): string {
  return `${numberFormat.format(count)} ${count === 1 ? one : other}`;
}

/** "N clip" / "N clips". */
export function formatClipCount(count: number): string {
  return formatCount(count, 'clip', 'clips');
}

/** A server URL → its host for display (e.g. "vault.example.org"); the raw string if unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Whether a host has characters outside ASCII. A look-alike ("miеweb.org" with a Cyrillic "е")
 * renders the same as the real domain, so a prompt asking someone to trust a host flags these.
 */
export function hasNonAsciiHost(host: string): boolean {
  return /[^\x00-\x7F]/.test(host);
}

/** A second-level label that, under a two-letter country code, is part of the public suffix. */
const TWO_PART_SUFFIX = /^(?:ac|co|com|edu|gov|net|org)\.[a-z]{2}$/i;

/**
 * A host shortened for a sentence (toast, alert, the Back button), where layout can't truncate
 * it. The registrable domain and the port are always kept whole: only subdomains before them are
 * dropped, whole labels nearest the domain kept while they fit, so a long host can never show a
 * misleading prefix ("timehuddle.com.…") or a cut domain. The registrable domain is the last two
 * labels, or three under a two-part suffix such as `co.uk`. An IP address is never shortened.
 */
export function shortHost(host: string, max = 32): string {
  if (host.length <= max) return host;
  // What follows the last label is kept as it is: a final dot, and the port.
  const [, name, end] = /^(.*?)(\.?(?::\d+)?)$/.exec(host)!;
  if (name.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(name)) return host;
  const labels = name.split('.');
  const shown = (count: number) => `….${labels.slice(-count).join('.')}${end}`;
  let kept = Math.min(labels.length, TWO_PART_SUFFIX.test(labels.slice(-2).join('.')) ? 3 : 2);
  while (kept < labels.length - 1 && shown(kept + 1).length <= max) kept++;
  return kept < labels.length ? shown(kept) : host;
}
