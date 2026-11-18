import type { BridgeEvent } from '../types';

/** Events a plugin keeps for a subscriber that isn't there yet (native-bridge.md §7). */
const RETAINED = new Set(['flowResult', 'hostRequest']);
const RETAINED_MAX = 64;

export interface FanoutOptions {
  /**
   * Attaches the one native listener; returns how to detach it. Called when the first subscriber
   * arrives (and again after the last one left, if `stop` was returned).
   */
  start(emit: (e: BridgeEvent) => void): (() => void) | void;
  /**
   * Keep flowResult and hostRequest events that arrive with no subscriber, and hand them to the
   * next one, once. For a plugin whose native side can't retain them again once its listener is
   * attached (Cordova's single keepCallback subscription).
   */
  retain?: boolean;
}

/**
 * One native listener shared by every subscriber of an adapter. A plugin that retains events
 * natively (Capacitor's retainUntilConsumed) delivers them to the first listener that attaches,
 * so there must be exactly one, or a second listener would miss what the first consumed.
 */
export function createFanout(o: FanoutOptions): (cb: (e: BridgeEvent) => void) => () => void {
  const subscribers = new Set<(e: BridgeEvent) => void>();
  const backlog: BridgeEvent[] = [];
  let stop: (() => void) | null = null;
  let started = false;

  function emit(e: BridgeEvent): void {
    if (subscribers.size === 0) {
      if (o.retain && RETAINED.has(e.name)) {
        backlog.push(e);
        if (backlog.length > RETAINED_MAX) backlog.shift();
      }
      return;
    }
    for (const cb of [...subscribers]) {
      try {
        cb(e);
      } catch (err) {
        console.error('[pulse-embed] an adapter subscriber threw', err);
      }
    }
  }

  return (cb) => {
    subscribers.add(cb);
    if (!started) {
      started = true;
      try {
        stop = o.start(emit) ?? null;
      } catch (err) {
        console.error('[pulse-embed] the plugin listener failed to attach', err);
      }
    }
    if (backlog.length > 0) {
      for (const e of backlog.splice(0)) emit(e);
    }
    return () => {
      if (!subscribers.delete(cb) || subscribers.size > 0 || !stop) return;
      // Detach, so the plugin retains its events natively again until the next subscriber.
      const s = stop;
      stop = null;
      started = false;
      try {
        s();
      } catch (err) {
        console.error('[pulse-embed] the plugin listener failed to detach', err);
      }
    };
  };
}
