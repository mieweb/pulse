/**
 * Whether the phone is online, and on Wi-Fi, as the upload outbox reads it. The source is injected:
 * the Pulse app keeps the default (online, Wi-Fi unknown), so an upload simply tries and a failed
 * fetch drives its retries, as before; the embed sets one fed by PulseKit's network events (its
 * NWPathMonitor), so Pulse JS and the facade decide `waiting_network` from the same values. No
 * native dependency of its own.
 */
export interface NetworkSource {
  isOnline(): boolean;
  /** True on Wi-Fi, false on cellular or another metered link, null when the source can't tell. */
  isWifi(): boolean | null;
  /** Calls `onChange` whenever either value changes; returns the function that stops. */
  subscribe(onChange: () => void): () => void;
}

/** The Pulse app's source: always online, Wi-Fi unknown, never changes. */
export const DEFAULT_NETWORK_SOURCE: NetworkSource = {
  isOnline: () => true,
  isWifi: () => null,
  subscribe: () => () => {},
};

let source: NetworkSource = DEFAULT_NETWORK_SOURCE;
let stopSource: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (e) {
      console.warn('[network] a listener failed', e);
    }
  }
}

function attach(): void {
  stopSource?.();
  stopSource = listeners.size > 0 ? source.subscribe(notify) : null;
}

/**
 * Use `next` from now on (null: back to the default). Subscribers are told at once, since the
 * values may differ from the previous source's.
 */
export function setNetworkSource(next: NetworkSource | null): void {
  const wanted = next ?? DEFAULT_NETWORK_SOURCE;
  if (wanted === source) return;
  source = wanted;
  attach();
  notify();
}

export function isOnline(): boolean {
  return source.isOnline();
}

export function isWifi(): boolean | null {
  return source.isWifi();
}

/**
 * Whether an upload has to wait for the network: offline, or Wi-Fi-only and known to be on
 * something else. Wi-Fi unknown doesn't hold an upload back (the default source never knows).
 */
export function waitingForNetwork(wifiOnly: boolean): boolean {
  return !source.isOnline() || (wifiOnly && source.isWifi() === false);
}

/** Calls `onChange` when the network changes or the source is swapped; returns the unsubscribe. */
export function subscribeNetwork(onChange: () => void): () => void {
  listeners.add(onChange);
  if (listeners.size === 1) attach();
  return () => {
    if (!listeners.delete(onChange)) return;
    if (listeners.size === 0) attach();
  };
}
