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

// window → its Capacitor or cordova global → the adapter made for it. Each adapter attaches its own
// native listener (adapters/fanout.ts), and a plugin hands retained events to whichever listener
// attached first, so every default client on a page must share one adapter, not make its own.
const chosen = new WeakMap<object, WeakMap<object, PulseAdapter>>();

const PLATFORMS = [
  ['Capacitor', createCapacitorAdapter],
  ['cordova', createCordovaAdapter],
] as const;

function isObjectLike(v: unknown): v is object {
  return (typeof v === 'object' || typeof v === 'function') && v !== null;
}

/**
 * The adapter `createPulseClient` uses when none is passed (native-bridge.md §7.3), first match:
 *  1. `window.__PULSE_ADAPTER__` (test builds; Playwright installs the fake's adapter there),
 *  2. Capacitor, when `Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('Pulse')`,
 *  3. Cordova (`window.cordova`; the adapter waits for deviceready and the plugin),
 *  4. the null adapter: not present, every call `unavailable`.
 * A Capacitor or Cordova adapter is made once per page and shared by every client that selects it.
 * Never throws: whatever a stubbed or broken global does, the answer is at worst the null adapter.
 */
export function selectAdapter(g: PageGlobals = pageGlobals()): PulseAdapter {
  const injected = read(g, '__PULSE_ADAPTER__');
  if (isAdapter(injected)) return injected;
  for (const [name, make] of PLATFORMS) {
    const platform = read(g, name);
    if (!isObjectLike(platform)) continue;
    const made = isObjectLike(g) ? chosen.get(g) : undefined;
    const known = made?.get(platform);
    if (known) return known;
    try {
      const a = make(g);
      if (a) {
        if (isObjectLike(g)) {
          if (made) made.set(platform, a);
          else chosen.set(g, new WeakMap([[platform, a]]));
        }
        return a;
      }
    } catch {
      // A broken global counts as absent.
    }
  }
  return createNullAdapter();
}
