import { stableStringify } from './envelope';
import type { PulseEventName, PulseEvents } from './types';

/** The event names this client delivers. Anything else from the facade is dropped (AD18 rule 4). */
export const EVENT_NAMES: readonly PulseEventName[] = Object.freeze([
  'draftsChanged',
  'uploadProgress',
  'flowResult',
  'log',
]);

export function isEventName(name: unknown): name is PulseEventName {
  return typeof name === 'string' && (EVENT_NAMES as readonly string[]).includes(name);
}

type Listener<E extends PulseEventName> = (payload: PulseEvents[E]) => void;

// A flowResult that arrives with nobody listening waits here, as the plugins retain it natively until
// a subscriber attaches (native-bridge.md §7). It goes out a microtask after the first listener
// attaches, to every flowResult listener there by then, so a host handler and a usePresent store that
// attach in the same turn both get it. The inbox keeps it anyway; this only saves the host a
// pendingResults round trip after a reload.
const RETAINED_MAX = 32;
// How many flowResults are remembered for de-duplication.
const SEEN_MAX = 64;

export interface Emitter {
  on<E extends PulseEventName>(event: E, cb: Listener<E>): () => void;
  /** Delivers one event. Unknown names are dropped; a repeated identical flowResult is dropped. */
  emit(name: string, payload: unknown): void;
}

function report(e: unknown): void {
  // A host listener that throws must not stop the others or the bridge.
  console.error('[pulse-embed] an event listener threw', e);
}

export function createEmitter(): Emitter {
  const listeners = new Map<PulseEventName, Set<(p: unknown) => void>>();
  const retained: unknown[] = [];
  // True from the first flowResult listener's `on` until the backlog has gone out.
  let draining = false;
  // requestId → the last flowResult delivered for it, as text. The facade may send a result twice
  // (the open reply's echo, a retained copy after a reload); the same text again is dropped. A
  // *different* result for the same requestId still goes out: the facade replaces its own fallback
  // result with Pulse JS's later one, and hosts act on the latest (vectors/README.md).
  const seen = new Map<string, string>();

  function deliver(name: PulseEventName, payload: unknown): void {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      try {
        cb(payload);
      } catch (e) {
        report(e);
      }
    }
  }

  function drainSoon(): void {
    if (draining) return;
    draining = true;
    // Not inside `on`: a React subscribe or a store must finish attaching first, and the others
    // attaching in the same turn should get the backlog too.
    void Promise.resolve().then(() => {
      draining = false;
      if ((listeners.get('flowResult')?.size ?? 0) === 0) return;
      for (const p of retained.splice(0)) deliver('flowResult', p);
    });
  }

  function firstSeen(payload: unknown): boolean {
    const requestId = (payload as { requestId?: unknown }).requestId;
    if (typeof requestId !== 'string') return true;
    const text = stableStringify(payload);
    if (seen.get(requestId) === text) return false;
    seen.delete(requestId);
    seen.set(requestId, text);
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value as string);
    return true;
  }

  return {
    on(event, cb) {
      if (!isEventName(event) || typeof cb !== 'function') return () => {};
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      const fn = cb as (p: unknown) => void;
      set.add(fn);
      if (event === 'flowResult' && retained.length > 0) drainSoon();
      return () => {
        set.delete(fn);
      };
    },
    emit(name, payload) {
      if (!isEventName(name)) return;
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
      if (name === 'flowResult') {
        if (!firstSeen(payload)) return;
        // While a backlog waits to go out, a newer result queues behind it, in order.
        if (draining || (listeners.get('flowResult')?.size ?? 0) === 0) {
          retained.push(payload);
          if (retained.length > RETAINED_MAX) retained.shift();
          return;
        }
      }
      deliver(name, payload);
    },
  };
}
