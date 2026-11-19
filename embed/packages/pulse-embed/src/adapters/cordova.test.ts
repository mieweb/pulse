import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createPulseClient, type BridgeEvent } from '@mieweb/pulse-embed';

import { buildReply, routeRequest } from '../envelope';
import { createCordovaAdapter } from './cordova';

type Ok = (v: unknown) => void;

/**
 * A Cordova page with cordova-plugin-pulse: `exec(ok, fail, 'Pulse', 'call', [json])` answers the
 * reply envelope as text, `subscribe` keeps its callback for every event, and deviceready fires
 * when the test says so (sticky, like Cordova's).
 */
function fakeCordova(o: { plugin?: boolean } = {}) {
  let ready = false;
  const waiting: (() => void)[] = [];
  let onEvent: Ok | null = null;
  const execs: { action: string; args: unknown[] }[] = [];
  const exec = jest.fn((ok: Ok, _fail: Ok, service: string, action: string, args: unknown[]) => {
    execs.push({ action, args });
    if (service !== 'Pulse') return;
    if (action === 'subscribe') {
      onEvent = ok;
      return;
    }
    const routed = routeRequest(args[0], { methods: ['info', 'isOpen'] });
    if (routed.route === 'reply') return ok(JSON.stringify(routed.reply));
    const result =
      routed.method === 'info'
        ? { contract: { major: 1, minor: 0 }, methods: ['info', 'isOpen'], supported: true }
        : true;
    ok(JSON.stringify(buildReply({ ok: true, callId: routed.callId, result })));
  });
  const g = {
    cordova: { exec, plugins: {} },
    ...(o.plugin === false ? {} : { PulseKit: {} }),
    document: {
      addEventListener: (name: string, cb: () => void) => {
        if (name !== 'deviceready') return;
        if (ready) cb();
        else waiting.push(cb);
      },
    },
    WkWebView: { convertFilePath: (p: string) => `app://localhost/_app_file_${p}` },
  };
  return {
    g,
    execs,
    fireDeviceReady() {
      ready = true;
      for (const cb of waiting.splice(0)) cb();
    },
    event(name: string, payload: unknown) {
      onEvent?.(JSON.stringify({ v: 1, name, payload }));
    },
  };
}

describe('the Cordova adapter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('is null without window.cordova', () => {
    expect(createCordovaAdapter({})).toBeNull();
  });

  it('waits for deviceready before it is present and before it calls', async () => {
    const f = fakeCordova();
    const a = createCordovaAdapter(f.g)!;
    let present: boolean | null = null;
    void a.present().then((v) => (present = v));
    const reply = a.call('isOpen', {}, 'c-1');
    await jest.advanceTimersByTimeAsync(100);
    expect(present).toBeNull();
    expect(f.execs).toEqual([]);
    f.fireDeviceReady();
    await jest.advanceTimersByTimeAsync(0);
    expect(present).toBe(true);
    await expect(reply).resolves.toEqual({ v: 1, callId: 'c-1', ok: true, result: true });
    expect(JSON.parse(f.execs[0].args[0] as string)).toMatchObject({
      method: 'isOpen',
      callId: 'c-1',
    });
  });

  it('is not present when deviceready never comes, or the plugin is missing', async () => {
    const late = createCordovaAdapter(fakeCordova().g, { readyTimeoutMs: 1000 })!;
    const p = late.present();
    await jest.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(false);

    const f = fakeCordova({ plugin: false });
    f.fireDeviceReady();
    const a = createCordovaAdapter(f.g)!;
    await expect(a.present()).resolves.toBe(false);
    await expect(a.call('info', {}, 'c-1')).rejects.toThrow('No Pulse plugin');
  });

  it('subscribes once and keeps flowResult and hostRequest for the next subscriber', async () => {
    const f = fakeCordova();
    f.fireDeviceReady();
    const a = createCordovaAdapter(f.g)!;
    const first: BridgeEvent[] = [];
    const off = a.subscribe((e) => first.push(e));
    await jest.advanceTimersByTimeAsync(0);
    f.event('draftsChanged', { namespace: 'n', ids: [] });
    off();
    f.event('flowResult', { requestId: 'r-1' });
    f.event('log', { level: 'info', line: 'dropped', at: 1 });
    const second: string[] = [];
    a.subscribe((e) => second.push(e.name));
    expect(first.map((e) => e.name)).toEqual(['draftsChanged']);
    expect(second).toEqual(['flowResult']);
    expect(f.execs.filter((e) => e.action === 'subscribe')).toHaveLength(1);
  });

  it('works under a client', async () => {
    const f = fakeCordova();
    f.fireDeviceReady();
    const client = createPulseClient({ adapter: createCordovaAdapter(f.g)! });
    await expect(client.isOpen()).resolves.toBe(true);
  });

  it('makes file URLs with Meteor first, then WkWebView, else file://', () => {
    const f = fakeCordova();
    expect(createCordovaAdapter(f.g)!.toWebUrl('/a/b.mp4')).toBe(
      'app://localhost/_app_file_/a/b.mp4',
    );
    const meteor = {
      ...f.g,
      WebAppLocalServer: {
        localFileSystemUrl: (u: string) =>
          u.replace('file://', 'http://localhost:12000/local-filesystem'),
      },
    };
    expect(createCordovaAdapter(meteor)!.toWebUrl('/a/b.mp4')).toBe(
      'http://localhost:12000/local-filesystem/a/b.mp4',
    );
    const { WkWebView: _w, ...bare } = f.g;
    expect(createCordovaAdapter(bare)!.toWebUrl('/a/b.mp4')).toBe('file:///a/b.mp4');
  });
});
