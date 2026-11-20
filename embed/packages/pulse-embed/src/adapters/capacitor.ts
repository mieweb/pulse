import { buildRequest, parseEvent, parseReply } from '../envelope';
import type { BridgeReply, PulseAdapter } from '../types';
import { createFanout } from './fanout';
import { fileUrl, invoke, pageGlobals, read, type PageGlobals } from './globals';

/**
 * The Capacitor adapter (native-bridge.md §7.1) over the `window.Capacitor` global only: no
 * @capacitor/core import, so a host's web build that aliases @capacitor/core to stubs can't hand us
 * a stub plugin. Every access is guarded: a stub, a missing function or a throwing getter means
 * "no Capacitor plugin" (null), never a throw.
 */

const PLUGIN = 'Pulse';

// registerPlugin twice for one name logs a warning and returns the first proxy, so keep ours.
const registered = new WeakMap<object, unknown>();

function nativePulse(cap: unknown): boolean {
  return (
    invoke(cap, 'isNativePlatform', [], false) === true &&
    invoke(cap, 'isPluginAvailable', [PLUGIN], false) === true
  );
}

function registerPulse(cap: object): unknown {
  if (registered.has(cap)) return registered.get(cap);
  const register = read(cap, 'registerPlugin');
  if (typeof register !== 'function') return null;
  let plugin: unknown;
  try {
    plugin = (register as (name: string) => unknown).call(cap, PLUGIN);
  } catch {
    return null;
  }
  if ((typeof plugin !== 'object' && typeof plugin !== 'function') || plugin === null) return null;
  registered.set(cap, plugin);
  return plugin;
}

/** The adapter, or null when this page has no native Capacitor with the Pulse plugin. */
export function createCapacitorAdapter(g: PageGlobals = pageGlobals()): PulseAdapter | null {
  const cap = read(g, 'Capacitor');
  if ((typeof cap !== 'object' && typeof cap !== 'function') || cap === null) return null;
  if (!nativePulse(cap)) return null;
  const plugin = registerPulse(cap);
  if (!plugin) return null;
  // Never hand `plugin` to a Promise (resolve/await): Capacitor's proxy, and stubs like it, answer
  // every property, `then` included, so the promise would adopt it and never settle.

  const subscribe = createFanout({
    start(emit) {
      const handle = invoke(
        plugin,
        'addListener',
        [
          'event',
          (data: unknown) => {
            const e = parseEvent(read(data, 'json'));
            if (e) emit(e);
          },
        ],
        undefined,
      );
      return () => {
        // Capacitor ≥ 3 returns a Promise of the handle; older ones the handle itself.
        const remove = (h: unknown) => void invoke(h, 'remove', [], undefined);
        if (handle instanceof Promise) handle.then(remove, () => {});
        else remove(handle);
      };
    },
  });

  return {
    kind: 'capacitor',
    present: () => Promise.resolve(nativePulse(cap)),
    async call(method, args, callId, options): Promise<BridgeReply> {
      const fn = read(plugin, 'call');
      if (typeof fn !== 'function') throw new Error('The Pulse plugin has no call method.');
      const json = JSON.stringify(buildRequest(method, args, callId, options?.timeoutMs));
      const out: unknown = await (fn as (o: { json: string }) => unknown).call(plugin, { json });
      const text = read(out, 'json');
      if (typeof text !== 'string') throw new Error('The Pulse plugin answered without json.');
      const reply = parseReply(text, callId);
      if (!reply) throw new Error("The Pulse plugin's answer isn't a reply envelope.");
      return reply;
    },
    subscribe,
    toWebUrl(path) {
      const url = invoke(cap, 'convertFileSrc', [fileUrl(path)], null);
      return typeof url === 'string' && url !== '' ? url : fileUrl(path);
    },
  };
}
