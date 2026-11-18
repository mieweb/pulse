import { describe, expect, it, jest } from '@jest/globals';

import { createPulseClient, type PulseAdapter } from '@mieweb/pulse-embed';

import type { PageGlobals } from './globals';
import { createNullAdapter } from './null';
import { selectAdapter } from './select';

const injected: PulseAdapter = {
  kind: 'fake',
  present: async () => true,
  call: async () => ({ v: 1, callId: 'c', ok: true, result: null }),
  subscribe: () => () => {},
  toWebUrl: (p) => p,
};

function nativeCapacitor(over: Record<string, unknown> = {}) {
  return {
    isNativePlatform: () => true,
    isPluginAvailable: (name: string) => name === 'Pulse',
    registerPlugin: () => ({ call: async () => ({ json: '{}' }), addListener: () => {} }),
    convertFileSrc: (u: string) => u,
    ...over,
  };
}

const cordova = { exec: () => {}, plugins: {} };

// TimeHuddle's web build aliases @capacitor/core to src/lib/capacitor-stubs.ts: a web Capacitor and
// a registerPlugin whose proxy answers every property (`then` included) with () => Promise.resolve().
const huddleStub = {
  getPlatform: () => 'web',
  isNativePlatform: () => false,
  isPluginAvailable: () => false,
  registerPlugin: () => new Proxy({}, { get: () => () => Promise.resolve() }),
};

describe('selectAdapter', () => {
  it('takes window.__PULSE_ADAPTER__ first', () => {
    const g: PageGlobals = { __PULSE_ADAPTER__: injected, Capacitor: nativeCapacitor(), cordova };
    expect(selectAdapter(g)).toBe(injected);
  });

  it('then native Capacitor with the Pulse plugin', () => {
    expect(selectAdapter({ Capacitor: nativeCapacitor(), cordova }).kind).toBe('capacitor');
  });

  it('then Cordova, when Capacitor is absent or not native', () => {
    expect(selectAdapter({ cordova }).kind).toBe('cordova');
    expect(selectAdapter({ Capacitor: huddleStub, cordova }).kind).toBe('cordova');
  });

  it('skips native Capacitor without the Pulse plugin', () => {
    const cap = nativeCapacitor({ isPluginAvailable: () => false });
    expect(selectAdapter({ Capacitor: cap }).kind).toBe('none');
  });

  it('else the null adapter', () => {
    expect(selectAdapter({}).kind).toBe('none');
  });

  it("ignores an injected value that isn't an adapter", () => {
    const g = { __PULSE_ADAPTER__: { kind: 'half' } as unknown as PulseAdapter };
    expect(selectAdapter(g).kind).toBe('none');
  });

  it("gives the null adapter for TimeHuddle's stubbed Capacitor on the web", () => {
    const register = jest.fn(huddleStub.registerPlugin);
    expect(selectAdapter({ Capacitor: { ...huddleStub, registerPlugin: register } }).kind).toBe(
      'none',
    );
    expect(register).not.toHaveBeenCalled();
  });

  it.each([
    [
      'registerPlugin throws',
      {
        Capacitor: nativeCapacitor({
          registerPlugin: () => {
            throw new Error('"Pulse" plugin is not implemented on web');
          },
        }),
      },
    ],
    [
      'registerPlugin returns nothing',
      { Capacitor: nativeCapacitor({ registerPlugin: () => undefined }) },
    ],
    [
      'isNativePlatform throws',
      {
        Capacitor: nativeCapacitor({
          isNativePlatform: () => {
            throw new Error('x');
          },
        }),
      },
    ],
    [
      'the Capacitor global is a throwing getter',
      Object.defineProperty({}, 'Capacitor', {
        get() {
          throw new Error('no');
        },
      }),
    ],
    [
      'every global access throws',
      new Proxy(
        {},
        {
          get() {
            throw new Error('no');
          },
        },
      ),
    ],
    [
      'the Capacitor global is a throwing proxy',
      {
        Capacitor: new Proxy(
          {},
          {
            get() {
              throw new Error('no');
            },
          },
        ),
      },
    ],
  ])('never throws: %s → the null adapter', (_name, g) => {
    expect(() => selectAdapter(g as PageGlobals)).not.toThrow();
    expect(selectAdapter(g as PageGlobals).kind).toBe('none');
  });
});

describe('the null adapter', () => {
  it('is not present, and a client over it is unavailable', async () => {
    const a = createNullAdapter();
    await expect(a.present()).resolves.toBe(false);
    await expect(a.call('info', {}, 'c-1')).rejects.toThrow();
    const client = createPulseClient({ adapter: a });
    await expect(client.isAvailable()).resolves.toBe(false);
    await expect(client.prewarm()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(client.getInfo()).rejects.toMatchObject({ code: 'unavailable' });
  });
});
