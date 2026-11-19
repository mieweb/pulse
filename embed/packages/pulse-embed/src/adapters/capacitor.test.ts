import { describe, expect, it, jest } from '@jest/globals';

import { createPulseClient, type BridgeEvent, type FlowResult } from '@mieweb/pulse-embed';

import { buildReply, routeRequest } from '../envelope';
import { createCapacitorAdapter } from './capacitor';
import { selectAdapter } from './select';

const INFO = {
  sdkVersion: '2.8.0',
  contract: { major: 1, minor: 0 },
  methods: ['info', 'open', 'pendingResults', 'acknowledge', 'isOpen'],
  supported: true,
};

const result = {
  requestId: 'r-1',
  entry: 'record',
  endedOn: 'export',
  stage: 'exported',
  context: null,
  endedAt: 1763400000000,
  status: 'completed',
  mode: 'file',
  draftId: 'd-1',
  durationMs: 4200,
  export: { rel: 'results/r-1.mp4', path: '/var/Library/PulseKit/ns/results/r-1.mp4', webUrl: '' },
};

type Listener = (data: { json: string }) => void;

/**
 * A native Capacitor with a `Pulse` plugin that behaves like PulsePlugin.swift: `call({json})`
 * resolves `{json}`, and `notifyListeners("event", …, retainUntilConsumed)` keeps flowResult and
 * hostRequest until a listener attaches, then hands them to it once.
 */
function fakeCapacitor() {
  let listeners: Listener[] = [];
  const retained: string[] = [];
  const requests: unknown[] = [];
  const removed = jest.fn();
  const plugin = {
    call: jest.fn(async ({ json }: { json: string }) => {
      requests.push(JSON.parse(json));
      const routed = routeRequest(json, { methods: INFO.methods });
      if (routed.route === 'reply') return { json: JSON.stringify(routed.reply) };
      const out =
        routed.method === 'info'
          ? INFO
          : routed.method === 'pendingResults'
            ? [result]
            : routed.method === 'isOpen'
              ? false
              : null;
      return { json: JSON.stringify(buildReply({ ok: true, callId: routed.callId, result: out })) };
    }),
    addListener: jest.fn((name: string, cb: Listener) => {
      if (name === 'event') {
        listeners.push(cb);
        for (const json of retained.splice(0)) cb({ json });
      }
      return Promise.resolve({
        remove: async () => {
          removed();
          listeners = listeners.filter((l) => l !== cb);
        },
      });
    }),
  };
  const Capacitor = {
    isNativePlatform: () => true,
    isPluginAvailable: (n: string) => n === 'Pulse',
    registerPlugin: jest.fn((_name: string) => plugin),
    convertFileSrc: (url: string) =>
      url.replace('file://', 'capacitor://localhost/_capacitor_file_'),
  };
  function notify(
    name: string,
    payload: unknown,
    retain = name === 'flowResult' || name === 'hostRequest',
  ) {
    const json = JSON.stringify({ v: 1, name, payload });
    if (listeners.length === 0) {
      if (retain) retained.push(json);
      return;
    }
    for (const l of [...listeners]) l({ json });
  }
  return { Capacitor, plugin, requests, notify, removed, listenerCount: () => listeners.length };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the Capacitor adapter', () => {
  it('sends call({json}) with the request envelope and parses the {json} reply', async () => {
    const cap = fakeCapacitor();
    const a = createCapacitorAdapter({ Capacitor: cap.Capacitor })!;
    expect(a.kind).toBe('capacitor');
    await expect(a.present()).resolves.toBe(true);
    const reply = await a.call('isOpen', {}, 'c-0123456789ab');
    expect(reply).toEqual({ v: 1, callId: 'c-0123456789ab', ok: true, result: false });
    expect(cap.requests[0]).toEqual({
      v: 1,
      callId: 'c-0123456789ab',
      method: 'isOpen',
      args: {},
      client: { contract: { major: 1, minor: 0 }, version: '0.0.0-dev' },
    });
  });

  it('passes a Pulse error through as an ok:false reply, not a rejection', async () => {
    const cap = fakeCapacitor();
    const a = createCapacitorAdapter({ Capacitor: cap.Capacitor })!;
    const reply = await a.call('listDrafts', {}, 'c-1');
    expect(reply).toMatchObject({
      ok: false,
      error: { code: 'method.unsupported', callId: 'c-1' },
    });
  });

  it('rejects when the plugin answers without json (a transport failure)', async () => {
    const cap = fakeCapacitor();
    cap.plugin.call.mockImplementation(async () => ({}) as { json: string });
    const a = createCapacitorAdapter({ Capacitor: cap.Capacitor })!;
    await expect(a.call('info', {}, 'c-1')).rejects.toThrow('without json');
    cap.plugin.call.mockImplementation(async () => ({ json: '{not json' }));
    await expect(a.call('info', {}, 'c-1')).rejects.toThrow('reply envelope');
  });

  it('listens on the "event" listener and hands out event envelopes', async () => {
    const cap = fakeCapacitor();
    const a = createCapacitorAdapter({ Capacitor: cap.Capacitor })!;
    const got: BridgeEvent[] = [];
    a.subscribe((e) => got.push(e));
    cap.notify('draftsChanged', { namespace: 'n', ids: ['d-1'] });
    expect(cap.plugin.addListener).toHaveBeenCalledWith('event', expect.any(Function));
    expect(got).toEqual([
      { v: 1, name: 'draftsChanged', payload: { namespace: 'n', ids: ['d-1'] } },
    ]);
  });

  it('delivers a retained flowResult and hostRequest once, on the first subscribe', async () => {
    const cap = fakeCapacitor();
    cap.notify('flowResult', result);
    cap.notify('hostRequest', { hostCallId: 'h-1', method: 'getUploadTarget', args: {} });
    cap.notify('draftsChanged', { namespace: 'n', ids: [] }); // not retained
    const a = createCapacitorAdapter({ Capacitor: cap.Capacitor })!;
    const first: string[] = [];
    const second: string[] = [];
    a.subscribe((e) => first.push(e.name));
    a.subscribe((e) => second.push(e.name));
    expect(first).toEqual(['flowResult', 'hostRequest']);
    expect(second).toEqual([]);
    // One native listener for every subscriber.
    expect(cap.plugin.addListener).toHaveBeenCalledTimes(1);
  });

  it('detaches the native listener after the last unsubscribe, so the plugin retains again', async () => {
    const cap = fakeCapacitor();
    const a = createCapacitorAdapter({ Capacitor: cap.Capacitor })!;
    const got: string[] = [];
    const off1 = a.subscribe((e) => got.push(`1:${e.name}`));
    const off2 = a.subscribe((e) => got.push(`2:${e.name}`));
    off1();
    await tick();
    expect(cap.removed).not.toHaveBeenCalled();
    off2();
    await tick();
    expect(cap.removed).toHaveBeenCalledTimes(1);
    expect(cap.listenerCount()).toBe(0);
    cap.notify('flowResult', result);
    a.subscribe((e) => got.push(`3:${e.name}`));
    expect(got).toEqual(['3:flowResult']);
  });

  it('a client gets a retained flowResult once, with the FileRef made loadable by convertFileSrc', async () => {
    const cap = fakeCapacitor();
    cap.notify('flowResult', result);
    const client = createPulseClient({
      adapter: createCapacitorAdapter({ Capacitor: cap.Capacitor })!,
    });
    const got: FlowResult[] = [];
    client.on('flowResult', (r) => got.push(r));
    await tick();
    cap.notify('flowResult', result); // the same result again (e.g. the open reply's echo)
    expect(got).toHaveLength(1);
    expect((got[0] as typeof result).export.webUrl).toBe(
      'capacitor://localhost/_capacitor_file_/var/Library/PulseKit/ns/results/r-1.mp4?v=1763400000000',
    );

    const [pending] = (await client.pendingResults()) as unknown as (typeof result)[];
    expect(pending.export.webUrl).toBe(
      'capacitor://localhost/_capacitor_file_/var/Library/PulseKit/ns/results/r-1.mp4?v=1763400000000',
    );
  });

  it('toWebUrl falls back to file:// without convertFileSrc', () => {
    const cap = fakeCapacitor();
    const { convertFileSrc: _gone, ...noConvert } = cap.Capacitor;
    const a = createCapacitorAdapter({ Capacitor: noConvert })!;
    expect(a.toWebUrl('/x/y.mp4')).toBe('file:///x/y.mp4');
  });

  it('registers the plugin once per Capacitor', () => {
    const cap = fakeCapacitor();
    createCapacitorAdapter({ Capacitor: cap.Capacitor });
    createCapacitorAdapter({ Capacitor: cap.Capacitor });
    expect(cap.Capacitor.registerPlugin).toHaveBeenCalledTimes(1);
    expect(cap.Capacitor.registerPlugin).toHaveBeenCalledWith('Pulse');
  });

  it('a registerPlugin stub that throws gives no adapter, and selection falls back to null', () => {
    const cap = fakeCapacitor();
    const Capacitor = {
      ...cap.Capacitor,
      registerPlugin: () => {
        throw new Error('stub');
      },
    };
    expect(createCapacitorAdapter({ Capacitor })).toBeNull();
    expect(selectAdapter({ Capacitor }).kind).toBe('none');
  });

  it('a registerPlugin that returns an answer-everything stub fails calls as unavailable, never hangs', async () => {
    const stub = new Proxy({}, { get: () => () => Promise.resolve() });
    const Capacitor = { ...fakeCapacitor().Capacitor, registerPlugin: () => stub };
    const a = createCapacitorAdapter({ Capacitor })!;
    a.subscribe(() => {});
    const client = createPulseClient({ adapter: a });
    await expect(client.getInfo()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(client.isAvailable()).resolves.toBe(false);
  });
});
