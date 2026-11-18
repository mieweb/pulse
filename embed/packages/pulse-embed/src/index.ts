import type { PulseError } from './types';

export type * from './types';
export { CONTEXT_KEY_MAX, contextKey } from './context-key';
export { CONTRACT } from './envelope';
export { createPulseClient, getPulse } from './client';

/** True for a PulseError from any call, also one rebuilt from a bridge reply (no class check). */
export function isPulseError(e: unknown): e is PulseError {
  if (typeof e !== 'object' || e === null) return false;
  const x = e as Partial<Record<'name' | 'code' | 'message' | 'callId', unknown>>;
  return (
    x.name === 'PulseError' &&
    typeof x.code === 'string' &&
    typeof x.message === 'string' &&
    typeof x.callId === 'string'
  );
}
