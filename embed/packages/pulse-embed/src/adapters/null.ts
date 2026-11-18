import type { PulseAdapter } from '../types';

/**
 * The adapter for a page with no Pulse plugin (the web build, a browser, an Android build before
 * the pilot): `present()` is false, so the client answers `isAvailable()` false and rejects every
 * other call `unavailable`.
 */
export function createNullAdapter(): PulseAdapter {
  return {
    kind: 'none',
    present: () => Promise.resolve(false),
    call: () => Promise.reject(new Error('No Pulse plugin on this page.')),
    subscribe: () => () => {},
    toWebUrl: (path) => path,
  };
}
