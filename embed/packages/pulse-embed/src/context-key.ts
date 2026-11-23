import type { PulseError } from './types';

/** A context key's longest length (huddle-server.md §2; Pulse stores and indexes it). */
export const CONTEXT_KEY_MAX = 128;

// The kind is the key's prefix, so it can't hold the ':' that separates it from the id. The id may
// (the day-scoped 'clock-plan' keys join team and date with one).
const KIND = /^[a-z0-9._-]+$/;
// Checked before lowercasing: toLowerCase() maps some non-ASCII letters to ASCII ones (KELVIN
// SIGN U+212A → 'k'), which would let them through changed.
const ID = /^[A-Za-z0-9._:-]+$/;

/**
 * `${kind}:${id.toLowerCase()}`, the one way a host builds `PulseContext.key` (AD11). The kind is
 * taken as written and must already be lowercase; the id keeps its case in `PulseContext.id`
 * and is lowercased only here. The result is 1–128 chars of [a-z0-9._:-].
 * Throws a PulseError `invalid_options` on a bad kind or id.
 */
export function contextKey(kind: string, id: string): string {
  if (typeof kind !== 'string' || !KIND.test(kind)) {
    throw invalidOptions(`contextKey: kind must be 1+ chars of [a-z0-9._-], got ${describe(kind)}`);
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw invalidOptions(`contextKey: id must be a non-empty string, got ${describe(id)}`);
  }
  if (!ID.test(id)) {
    throw invalidOptions(`contextKey: id must be chars of [A-Za-z0-9._:-], got ${describe(id)}`);
  }
  const key = `${kind}:${id.toLowerCase()}`;
  if (key.length > CONTEXT_KEY_MAX) {
    throw invalidOptions(`contextKey: key is ${key.length} chars, over ${CONTEXT_KEY_MAX}`);
  }
  return key;
}

function describe(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : typeof value;
}

// Thrown before any bridge call exists, so there is no native callId to correlate with.
function invalidOptions(message: string): PulseError {
  return Object.assign(new Error(message), {
    name: 'PulseError' as const,
    code: 'invalid_options' as const,
    recoverable: false,
    callId: 'local',
  });
}
