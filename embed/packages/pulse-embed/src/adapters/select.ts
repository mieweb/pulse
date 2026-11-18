import type { PulseAdapter } from '../types';
import { createCapacitorAdapter } from './capacitor';
import { createCordovaAdapter } from './cordova';
import { pageGlobals, read, type PageGlobals } from './globals';
import { createNullAdapter } from './null';

function isAdapter(a: unknown): a is PulseAdapter {
  return (
    typeof a === 'object' &&
    a !== null &&
    typeof read(a, 'present') === 'function' &&
    typeof read(a, 'call') === 'function' &&
    typeof read(a, 'subscribe') === 'function' &&
    typeof read(a, 'toWebUrl') === 'function'
  );
}

/**
 * The adapter `createPulseClient` uses when none is passed (native-bridge.md §7.3), first match:
 *  1. `window.__PULSE_ADAPTER__` (test builds; Playwright installs the fake's adapter there),
 *  2. Capacitor, when `Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('Pulse')`,
 *  3. Cordova (`window.cordova`; the adapter waits for deviceready and the plugin),
 *  4. the null adapter: not present, every call `unavailable`.
 * Never throws: whatever a stubbed or broken global does, the answer is at worst the null adapter.
 */
export function selectAdapter(g: PageGlobals = pageGlobals()): PulseAdapter {
  const injected = read(g, '__PULSE_ADAPTER__');
  if (isAdapter(injected)) return injected;
  for (const make of [createCapacitorAdapter, createCordovaAdapter]) {
    try {
      const a = make(g);
      if (a) return a;
    } catch {
      // A broken global counts as absent.
    }
  }
  return createNullAdapter();
}
