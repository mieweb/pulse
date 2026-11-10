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

/**
 * A host shortened in the middle for a sentence (toast, alert), where layout can't truncate it:
 * keeps both ends, so the domain ("…mieweb.org") stays readable. Labels use
 * `numberOfLines={1} ellipsizeMode="middle"` instead.
 */
export function shortHost(host: string, max = 32): string {
  if (host.length <= max) return host;
  const tail = Math.ceil((max - 1) / 2);
  return `${host.slice(0, max - 1 - tail)}…${host.slice(-tail)}`;
}
