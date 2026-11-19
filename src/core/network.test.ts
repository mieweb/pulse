import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  isOnline,
  isWifi,
  setNetworkSource,
  subscribeNetwork,
  waitingForNetwork,
  type NetworkSource,
} from './network';

/** A source a test drives: `set` changes its values and tells its subscribers. */
function fakeSource(online: boolean, wifi: boolean | null) {
  const subs = new Set<() => void>();
  const state = { online, wifi };
  const source: NetworkSource = {
    isOnline: () => state.online,
    isWifi: () => state.wifi,
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
  const set = (next: Partial<typeof state>) => {
    Object.assign(state, next);
    for (const cb of subs) cb();
  };
  return { source, set, subscribers: () => subs.size };
}

afterEach(() => setNetworkSource(null));

describe('network source', () => {
  it('reports online with Wi-Fi unknown by default, so nothing waits for the network', () => {
    expect(isOnline()).toBe(true);
    expect(isWifi()).toBeNull();
    expect(waitingForNetwork(false)).toBe(false);
    expect(waitingForNetwork(true)).toBe(false);
  });

  it('tells subscribers when the source is swapped, and reads the new one', () => {
    const onChange = jest.fn();
    const stop = subscribeNetwork(onChange);
    const fake = fakeSource(false, null);
    setNetworkSource(fake.source);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(isOnline()).toBe(false);
    expect(waitingForNetwork(false)).toBe(true);

    setNetworkSource(null);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(isOnline()).toBe(true);
    stop();
  });

  it('forwards the source’s own changes, and only from the current source', () => {
    const onChange = jest.fn();
    const stop = subscribeNetwork(onChange);
    const first = fakeSource(true, true);
    const second = fakeSource(true, false);
    setNetworkSource(first.source);
    first.set({ online: false });
    expect(onChange).toHaveBeenCalledTimes(2);

    setNetworkSource(second.source);
    expect(first.subscribers()).toBe(0);
    first.set({ online: true });
    expect(onChange).toHaveBeenCalledTimes(3);
    second.set({ wifi: true });
    expect(onChange).toHaveBeenCalledTimes(4);

    stop();
    expect(second.subscribers()).toBe(0);
    second.set({ wifi: false });
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('holds a Wi-Fi-only upload back on cellular, not when Wi-Fi is unknown', () => {
    const fake = fakeSource(true, false);
    setNetworkSource(fake.source);
    expect(waitingForNetwork(true)).toBe(true);
    expect(waitingForNetwork(false)).toBe(false);
    fake.set({ wifi: null });
    expect(waitingForNetwork(true)).toBe(false);
    fake.set({ wifi: true });
    expect(waitingForNetwork(true)).toBe(false);
  });
});
