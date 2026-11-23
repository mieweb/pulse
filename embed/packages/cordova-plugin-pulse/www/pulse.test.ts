import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// www/pulse.js against a fake `cordova/exec`: the transport passes envelopes through untouched,
// resolves a Pulse error reply (ok:false) like any other reply, and rejects only when the
// transport itself fails.

type Callback = (value?: unknown) => void;
interface ExecCall {
  ok: Callback;
  fail: Callback;
  service: string;
  action: string;
  args: unknown[];
}
interface PulseKitModule {
  call(json: unknown): Promise<string>;
  subscribe(cb: (json: string) => void): () => void;
}

let execCalls: ExecCall[];
let pulse: PulseKitModule;

beforeEach(() => {
  execCalls = [];
  const exec = (ok: Callback, fail: Callback, service: string, action: string, args: unknown[]) =>
    execCalls.push({ ok, fail, service, action, args });
  // A fresh module per test: the subscription state lives at module level.
  jest.isolateModules(() => {
    jest.doMock('cordova/exec', () => exec, { virtual: true });
    pulse = jest.requireActual<PulseKitModule>('./pulse');
  });
});

afterEach(() => {
  jest.useRealTimers();
});

const reply = '{"v":1,"callId":"c-0123456789ab","ok":true,"result":{"supported":true}}';
const request = '{"v":1,"callId":"c-0123456789ab","method":"info","args":{}}';

describe('call', () => {
  it('passes the request JSON to Pulse.call and resolves the reply string', async () => {
    const pending = pulse.call(request);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toMatchObject({ service: 'Pulse', action: 'call', args: [request] });
    execCalls[0].ok(reply);
    await expect(pending).resolves.toBe(reply);
  });

  it('resolves a Pulse error reply (ok:false) instead of rejecting', async () => {
    const failure =
      '{"v":1,"callId":"c-1","ok":false,"error":{"code":"busy","message":"x","recoverable":true,"callId":"c-1"}}';
    const pending = pulse.call(request);
    execCalls[0].ok(failure);
    await expect(pending).resolves.toBe(failure);
  });

  it('rejects when the transport fails', async () => {
    const pending = pulse.call(request);
    execCalls[0].fail('Class not found');
    await expect(pending).rejects.toThrow('Class not found');
  });

  it('rejects with a message when the native side gives none', async () => {
    const pending = pulse.call(request);
    execCalls[0].fail(undefined);
    await expect(pending).rejects.toThrow('The Pulse plugin call failed.');
  });

  it('rejects a request that is not a JSON string without calling native', async () => {
    await expect(pulse.call({ method: 'info' })).rejects.toThrow(TypeError);
    expect(execCalls).toHaveLength(0);
  });
});

describe('subscribe', () => {
  it('registers one keepCallback subscription and forwards each event', () => {
    const seen: string[] = [];
    pulse.subscribe((json) => seen.push(json));
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toMatchObject({ service: 'Pulse', action: 'subscribe', args: [] });

    // keepCallback: native calls the same success callback once per event.
    execCalls[0].ok('{"v":1,"name":"flowResult","payload":{}}');
    execCalls[0].ok('{"v":1,"name":"draftsChanged","payload":{}}');
    execCalls[0].ok(undefined); // a payload-less keep-alive result is not an event
    expect(seen).toEqual([
      '{"v":1,"name":"flowResult","payload":{}}',
      '{"v":1,"name":"draftsChanged","payload":{}}',
    ]);
  });

  it('shares one native subscription between subscribers', () => {
    const a: string[] = [];
    const b: string[] = [];
    pulse.subscribe((json) => a.push(json));
    pulse.subscribe((json) => b.push(json));
    expect(execCalls.filter((c) => c.action === 'subscribe')).toHaveLength(1);
    execCalls[0].ok('{"name":"log"}');
    expect(a).toEqual(['{"name":"log"}']);
    expect(b).toEqual(['{"name":"log"}']);
  });

  it('unsubscribes natively when the last subscriber leaves, and subscribes again later', () => {
    const a: string[] = [];
    const offA = pulse.subscribe((json) => a.push(json));
    const offB = pulse.subscribe(() => {});
    offA();
    offA(); // twice is harmless
    expect(execCalls.map((c) => c.action)).toEqual(['subscribe']);
    execCalls[0].ok('{"name":"log"}');
    expect(a).toEqual([]);

    offB();
    expect(execCalls.map((c) => c.action)).toEqual(['subscribe', 'unsubscribe']);

    pulse.subscribe(() => {});
    expect(execCalls.map((c) => c.action)).toEqual(['subscribe', 'unsubscribe', 'subscribe']);
  });

  it('keeps delivering to the others when one subscriber throws, and reports the throw', () => {
    jest.useFakeTimers();
    const seen: string[] = [];
    pulse.subscribe(() => {
      throw new Error('listener broke');
    });
    pulse.subscribe((json) => seen.push(json));
    execCalls[0].ok('{"name":"flowResult"}');
    expect(seen).toEqual(['{"name":"flowResult"}']);
    expect(() => jest.runOnlyPendingTimers()).toThrow('listener broke');
  });

  it('retries the native subscription after it failed', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    pulse.subscribe(() => {});
    execCalls[0].fail('Class not found');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Class not found'));
    pulse.subscribe(() => {});
    expect(execCalls.map((c) => c.action)).toEqual(['subscribe', 'subscribe']);
    warn.mockRestore();
  });

  it('needs a callback', () => {
    expect(() => pulse.subscribe(undefined as unknown as (json: string) => void)).toThrow(
      TypeError,
    );
    expect(execCalls).toHaveLength(0);
  });
});
