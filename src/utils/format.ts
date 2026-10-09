/** Milliseconds → "m:ss" (e.g. 72000 → "1:12"). */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** Milliseconds → zero-padded "mm:ss" (e.g. 7000 → "00:07"). */
export function formatDurationPadded(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (total % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/** "N clip" / "N clips". */
export function formatClipCount(count: number): string {
  return `${count} ${count === 1 ? 'clip' : 'clips'}`;
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
 * A host shortened in the middle for a sentence (toast, alert), where layout can't truncate it:
 * keeps both ends, so the domain ("…mieweb.org") stays readable. Labels use
 * `numberOfLines={1} ellipsizeMode="middle"` instead.
 */
export function shortHost(host: string, max = 32): string {
  if (host.length <= max) return host;
  const tail = Math.ceil((max - 1) / 2);
  return `${host.slice(0, max - 1 - tail)}…${host.slice(-tail)}`;
}
