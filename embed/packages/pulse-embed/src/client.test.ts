import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  createPulseClient,
  getPulse,
  isPulseError,
  type BridgeEvent,
  type BridgeReply,
  type FlowResult,
  type Json,
  type PulseAdapter,
  type PulseClient,
  type PulseInfo,
} from '@mieweb/pulse-embed';

import { buildReply, buildRequest, MINOR0_METHODS, routeRequest } from './envelope';

const MINOR1 = [
  'setAccount',
  'listDrafts',
  'getDraft',
  'countDrafts',
  'renameDraft',
  'deleteDraft',
  'setDraftContext',
  'upload',
  'cancelUpload',
  'retireDraft',
  'dismissReceipt',
  'resumeOutbox',
  'usage',
  'listNamespaces',
  'purge',
  'respondHostRequest',
];

function makeInfo(over: Partial<PulseInfo> = {}): PulseInfo {
  return {
    sdkVersion: '2.8.0',
    build: '1',
    gitSha: 'abc',
    contract: { major: 1, minor: 1 },
    formatVersion: 2,
    dbSchema: 1,
    entries: ['record', 'edit', 'export'],
    methods: [...MINOR0_METHODS, ...MINOR1],
    capabilities: [],
    platform: 'ios',
    osVersion: '18.0',
    supported: true,
    namespace: 'com.example-local',
    ...over,
  };
}

type Answer = (method: string, args: Json, callId: string) => BridgeReply | Promise<BridgeReply>;

/** An adapter whose facade answers `info` from `info` and everything else through `answer`. */
function fakeAdapter(o: { info?: unknown; answer?: Answer; present?: boolean } = {}) {
  const calls: { method: string; args: Json; callId: string }[] = [];
  let listener: ((e: BridgeEvent) => void) | null = null;
  const answer: Answer =
    o.answer ?? ((_m, _a, callId) => buildReply({ ok: true, callId, result: null }));
  const adapter: PulseAdapter = {
    kind: 'fake',
    present: async () => o.present ?? true,
    call: async (method, args, callId) => {
      calls.push({ method, args, callId });
      if (method === 'info') {
        return buildReply({ ok: true, callId, result: (o.info ?? makeInfo()) as Json });
      }
      return answer(method, args, callId);
    },
    subscribe: (cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    toWebUrl: (path) => `capacitor://localhost/_capacitor_file_${path}`,
  };
  const emit = (name: string, payload: unknown) =>
    listener?.({ v: 1, name, payload: payload as Json });
  const methods = () => calls.map((c) => c.method);
  return { adapter, calls, emit, methods };
}

async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as Record<string, unknown>;
  }
  throw new Error('expected a rejection');
}

const ctx = { key: 'ticket:42', kind: 'ticket', id: '42', label: 'Fix login' };

const sent: FlowResult = {
  requestId: 'r-1',
  entry: 'record',
  endedOn: 'export',
  stage: 'exported',
  context: ctx,
  endedAt: 1763400000000,
  status: 'completed',
  mode: 'pulse',
  draftId: 'd-1',
  sentAt: 1763400000000,
  clientKey: 'i:d-1:0123456789abcdef',
  draftKey: 'i:d-1',
};

describe('envelope round trip', () => {
  it('sends a request envelope through a facade router and reads its reply', async () => {
    // A facade made of the shared routing rules: the client's envelope must route natively.
    const wire: string[] = [];
    const adapter: PulseAdapter = {
      kind: 'wire',
      present: async () => true,
      call: async (method, args, callId) => {
        const text = JSON.stringify(buildRequest(method, args, callId));
        wire.push(text);
        const routed = routeRequest(text, { methods: [...MINOR0_METHODS] });
        if (routed.route === 'reply') return routed.reply;
        const result = routed.method === 'info' ? makeInfo() : routed.method === 'isOpen';
        return JSON.parse(
          JSON.stringify(buildReply({ ok: true, callId: routed.callId, result: result as Json })),
        );
      },
      subscribe: () => () => {},
      toWebUrl: (p) => p,
    };
    const client = createPulseClient({ adapter });
    await expect(client.isOpen()).resolves.toBe(true);
    const sentEnvelope = JSON.parse(wire[1]);
    expect(sentEnvelope).toEqual({
      v: 1,
      callId: expect.stringMatching(/^c-[0-9a-f]{12}$/),
      method: 'isOpen',
      args: {},
      client: { contract: { major: 1, minor: 0 }, version: '0.0.0-dev' },
    });
  });

  it('gives every call its own callId', async () => {
    const f = fakeAdapter();
    const client = createPulseClient({ adapter: f.adapter });
    await client.prewarm();
    await client.prewarm();
    const ids = f.calls.map((c) => c.callId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^c-[0-9a-f]{12}$/);
  });
});

describe('results pass through', () => {
  it('keeps unknown fields in a result and in info()', async () => {
    const f = fakeAdapter({
      info: { ...makeInfo(), futureInfo: { a: 1 } },
      answer: (_m, _a, callId) =>
        buildReply({
          ok: true,
          callId,
          result: [{ ...sent, futureField: { a: [1, null, true] } }] as unknown as Json,
        }),
    });
    const client = createPulseClient({ adapter: f.adapter });
    const results = await client.pendingResults();
    expect(results[0]).toEqual({ ...sent, futureField: { a: [1, null, true] } });
    expect(await client.getInfo()).toMatchObject({ futureInfo: { a: 1 } });
  });

  it("fills FileRef.webUrl from the adapter, with ?v= from the row's updatedAt or endedAt", async () => {
    const file = {
      ...sent,
      mode: 'file',
      export: { rel: 'results/r-1.mp4', path: '/lib/results/r-1.mp4', webUrl: '' },
      draft: {
        id: 'd-1',
        updatedAt: 1700000000123,
        poster: { rel: 'drafts/d-1/poster.jpg', path: '/lib/drafts/d-1/poster.jpg', webUrl: '' },
      },
    };
    const f = fakeAdapter({
      answer: (_m, _a, callId) => buildReply({ ok: true, callId, result: [file] as Json }),
    });
    const client = createPulseClient({ adapter: f.adapter });
    const [r] = (await client.pendingResults()) as unknown as (typeof file)[];
    expect(r.export.webUrl).toBe(
      'capacitor://localhost/_capacitor_file_/lib/results/r-1.mp4?v=1763400000000',
    );
    expect(r.draft.poster.webUrl).toBe(
      'capacitor://localhost/_capacitor_file_/lib/drafts/d-1/poster.jpg?v=1700000000123',
    );
    // The adapter's own objects aren't changed.
    expect(file.export.webUrl).toBe('');
  });

  it('fills webUrl in flowResult events too', async () => {
    const f = fakeAdapter();
    const client = createPulseClient({ adapter: f.adapter });
    const got: FlowResult[] = [];
    client.on('flowResult', (r) => got.push(r));
    f.emit('flowResult', {
      ...sent,
      mode: 'file',
      export: { rel: 'results/r-1.mp4', path: '/x/r-1.mp4', webUrl: '' },
    });
    expect((got[0] as unknown as { export: { webUrl: string } }).export.webUrl).toBe(
      'capacitor://localhost/_capacitor_file_/x/r-1.mp4?v=1763400000000',
    );
  });
});

describe('gating by info()', () => {
  it('rejects a method the facade does not list as method.unsupported, without calling it', async () => {
    const f = fakeAdapter({ info: makeInfo({ methods: [...MINOR0_METHODS] }) });
    const client = createPulseClient({ adapter: f.adapter });
    const e = await rejection(client.listDrafts());
    expect(e.code).toBe('method.unsupported');
    expect(isPulseError(e)).toBe(true);
    expect(f.methods()).toEqual(['info']);
  });

  it('rejects contract.unsupported when the facade speaks another major', async () => {
    const f = fakeAdapter({ info: makeInfo({ contract: { major: 2 as 1, minor: 0 } }) });
    const client = createPulseClient({ adapter: f.adapter });
    expect((await rejection(client.getInfo())).code).toBe('contract.unsupported');
    expect((await rejection(client.prewarm())).code).toBe('contract.unsupported');
    await expect(client.isAvailable()).resolves.toBe(false);
    expect(f.methods().every((m) => m === 'info')).toBe(true);
  });

  it('rejects contract.unsupported for an info() that is not a PulseInfo', async () => {
    const f = fakeAdapter({ info: { hello: 'world' } });
    const client = createPulseClient({ adapter: f.adapter });
    expect((await rejection(client.getInfo())).code).toBe('contract.unsupported');
  });

  it('rejects unsupported on a device Pulse does not run on, but still answers info', async () => {
    const f = fakeAdapter({ info: makeInfo({ supported: false, unsupportedReason: 'ipad' }) });
    const client = createPulseClient({ adapter: f.adapter });
    await expect(client.isAvailable()).resolves.toBe(false);
    expect((await client.getInfo()).unsupportedReason).toBe('ipad');
    expect((await rejection(client.record(ctx))).code).toBe('unsupported');
    expect(f.methods()).toEqual(['info']);
  });

  it('caches info(), but not a failure', async () => {
    let present = false;
    const f = fakeAdapter();
    const adapter = { ...f.adapter, present: async () => present };
    const client = createPulseClient({ adapter });
    expect((await rejection(client.getInfo())).code).toBe('unavailable');
    present = true;
    await client.getInfo();
    await client.prewarm();
    await client.isOpen();
    expect(f.methods()).toEqual(['info', 'prewarm', 'isOpen']);
  });
});

describe('transport failures', () => {
  it('turns a transport rejection into unavailable', async () => {
    const f = fakeAdapter({
      answer: () => Promise.reject(new Error('"Pulse" plugin is not implemented on ios')),
    });
    const client = createPulseClient({ adapter: f.adapter });
    const e = await rejection(client.prewarm());
    expect(e.code).toBe('unavailable');
    expect(e.message).toContain('not implemented');
  });

  it('turns a reply that is not an envelope into unavailable', async () => {
    const f = fakeAdapter({ answer: () => ({ nope: true }) as unknown as BridgeReply });
    const client = createPulseClient({ adapter: f.adapter });
    expect((await rejection(client.prewarm())).code).toBe('unavailable');
  });

  it('with no plugin: not available, every call unavailable', async () => {
    const f = fakeAdapter({ present: false });
    const client = createPulseClient({ adapter: f.adapter });
    await expect(client.isAvailable()).resolves.toBe(false);
    expect((await rejection(client.record(ctx))).code).toBe('unavailable');
    expect(f.calls).toEqual([]);
  });

  it('rejects an ok:false reply as a PulseError with its code and callId', async () => {
    const f = fakeAdapter({
      answer: (_m, _a, callId) =>
        buildReply({
          ok: false,
          callId,
          error: { code: 'busy', message: 'open', requestId: 'r-2' },
        }),
    });
    const client = createPulseClient({ adapter: f.adapter });
    const e = await rejection(client.edit('d-1', { requestId: 'r-2' }));
    expect(e).toMatchObject({
      name: 'PulseError',
      code: 'busy',
      recoverable: true,
      requestId: 'r-2',
    });
    expect(e.callId).toBe(f.calls[1].callId);
    expect(e).toBeInstanceOf(Error);
  });

  it('maps an error code this client does not know to unknown, keeping it as the reason', async () => {
    const f = fakeAdapter({
      answer: (_m, _a, callId) =>
        buildReply({ ok: false, callId, error: { code: 'quantum.flux', message: 'later code' } }),
    });
    const client = createPulseClient({ adapter: f.adapter });
    expect(await rejection(client.prewarm())).toMatchObject({
      code: 'unknown',
      reason: 'quantum.flux',
    });
  });
});

describe('timeouts', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const hang: Answer = () => new Promise<BridgeReply>(() => {});

  it('rejects a call with no reply in 30 s as timeout (recoverable)', async () => {
    const f = fakeAdapter({ answer: hang });
    const client = createPulseClient({ adapter: f.adapter });
    await client.getInfo();
    const p = rejection(client.resumeOutbox());
    await jest.advanceTimersByTimeAsync(29_999);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ code: 'timeout', recoverable: true });
  });

  it('takes timeoutMs from the options', async () => {
    const f = fakeAdapter({ answer: hang });
    const client = createPulseClient({ adapter: f.adapter, timeoutMs: 1000 });
    await client.getInfo();
    const p = rejection(client.usage());
    await jest.advanceTimersByTimeAsync(1000);
    expect((await p).code).toBe('timeout');
  });

  it('never times out open (a flow lasts minutes)', async () => {
    let finish: (r: BridgeReply) => void = () => {};
    const f = fakeAdapter({
      answer: (method, _a, callId) =>
        method === 'open'
          ? new Promise<BridgeReply>((resolve) => {
              finish = resolve;
            })
          : buildReply({ ok: true, callId, result: null }),
    });
    const client = createPulseClient({ adapter: f.adapter });
    const p = client.record(ctx, { requestId: 'r-1' });
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    finish(buildReply({ ok: true, callId: f.calls[1].callId, result: sent as unknown as Json }));
    await expect(p).resolves.toMatchObject({ requestId: 'r-1', status: 'completed' });
  });
});

describe('argument checks', () => {
  it('rejects record without a context as invalid_options, before native', async () => {
    const f = fakeAdapter();
    const client = createPulseClient({ adapter: f.adapter });
    const e = await rejection(client.open({ entry: 'record' } as never));
    expect(e.code).toBe('invalid_options');
    expect(f.calls).toEqual([]);
    expect((await rejection(client.record(undefined as never))).code).toBe('invalid_options');
  });

  it.each([
    ['edit without a draftId', (c: PulseClient) => c.edit('')],
    [
      'a requestId that could leave the results folder',
      (c: PulseClient) => c.edit('d-1', { requestId: '../x' }),
    ],
    ['configure with a bad hostId', (c: PulseClient) => c.configure({ hostId: 'Upper' })],
    ['acknowledge without a requestId', (c: PulseClient) => c.acknowledge('')],
    ['getDraft without an id', (c: PulseClient) => c.getDraft('')],
    [
      'countDrafts by something else',
      (c: PulseClient) => c.countDrafts({ by: 'state' as 'contextKey' }),
    ],
    [
      'setDraftContext without a context key',
      (c: PulseClient) => c.setDraftContext('d-1', {} as never),
    ],
    [
      'setAccount without a userId',
      (c: PulseClient) => c.setAccount({ serverOrigin: 'https://x' } as never),
    ],
    ['close with another reason', (c: PulseClient) => c.close({ reason: 'user' as 'host' })],
  ])('rejects %s', async (_name, run) => {
    const f = fakeAdapter();
    const client = createPulseClient({ adapter: f.adapter });
    expect((await rejection(run(client))).code).toBe('invalid_options');
    expect(f.calls).toEqual([]);
  });

  it('lets unknown fields through to the facade', async () => {
    const f = fakeAdapter();
    const client = createPulseClient({ adapter: f.adapter });
    await client.configure({ hostId: 'com.example', later: { x: 1 } } as never);
    expect(f.calls[1].args).toEqual({ hostId: 'com.example', later: { x: 1 } });
  });
});

describe('every method', () => {
  const draft = { id: 'd-1', state: 'ready', updatedAt: 5, poster: null };
  const cases: [string, (c: PulseClient) => Promise<unknown>, Json, Json][] = [
    ['configure', (c) => c.configure({ uploadMode: 'file' }), { uploadMode: 'file' }, null],
    [
      'setAccount',
      (c) => c.setAccount({ serverOrigin: 'https://h', userId: 'u' }),
      { serverOrigin: 'https://h', userId: 'u' },
      { namespace: 'h-0123' },
    ],
    ['setAccount', (c) => c.setAccount(null), {}, { namespace: null }],
    ['prewarm', (c) => c.prewarm(), {}, null],
    [
      'close',
      (c) => c.close({ reason: 'host', discard: true }),
      { reason: 'host', discard: true },
      null,
    ],
    ['close', (c) => c.close(), {}, null],
    ['isOpen', (c) => c.isOpen(), {}, false],
    ['pendingResults', (c) => c.pendingResults(), {}, []],
    ['acknowledge', (c) => c.acknowledge('r-1'), { requestId: 'r-1' }, null],
    [
      'listDrafts',
      (c) => c.listDrafts({ contextKeyPrefix: 'ticket:' }),
      { contextKeyPrefix: 'ticket:' },
      [draft],
    ],
    ['listDrafts', (c) => c.listDrafts(), {}, []],
    ['getDraft', (c) => c.getDraft('d-1'), { id: 'd-1' }, draft],
    [
      'countDrafts',
      (c) => c.countDrafts({ by: 'contextKey' }),
      { by: 'contextKey' },
      { 'ticket:42': 2 },
    ],
    [
      'renameDraft',
      (c) => c.renameDraft('d-1', 'Login fix'),
      { id: 'd-1', name: 'Login fix' },
      null,
    ],
    ['setDraftContext', (c) => c.setDraftContext('d-1', ctx), { id: 'd-1', context: ctx }, null],
    ['deleteDraft', (c) => c.deleteDraft('d-1'), { id: 'd-1' }, null],
    [
      'upload',
      (c) => c.upload('d-1'),
      { id: 'd-1' },
      { clientKey: 'k', draftKey: 'dk', sentAt: 1 },
    ],
    ['cancelUpload', (c) => c.cancelUpload('d-1'), { id: 'd-1' }, null],
    ['retireDraft', (c) => c.retireDraft('d-1'), { id: 'd-1' }, null],
    ['dismissReceipt', (c) => c.dismissReceipt('d-1'), { id: 'd-1' }, null],
    ['resumeOutbox', (c) => c.resumeOutbox(), {}, null],
    [
      'usage',
      (c) => c.usage(),
      {},
      { namespace: 'n', bytes: 1, drafts: 1, unsent: 0, uploading: 0, failed: 0, receipts: 0 },
    ],
    ['listNamespaces', (c) => c.listNamespaces(), {}, []],
    ['purge', (c) => c.purge({ namespace: 'n' }), { namespace: 'n' }, null],
    ['purge', (c) => c.purge(), {}, null],
    [
      'logFile',
      (c) => c.logFile(),
      {},
      { rel: 'logs/pulse.log', path: '/l/logs/pulse.log', webUrl: 'already-set' },
    ],
  ];

  it.each(cases)(
    '%s forwards its args and answers with the result',
    async (method, run, args, result) => {
      const f = fakeAdapter({
        answer: (_m, _a, callId) => buildReply({ ok: true, callId, result }),
      });
      const client = createPulseClient({ adapter: f.adapter });
      const out = await run(client);
      expect(f.calls.map((c) => [c.method, c.args])).toEqual([
        ['info', {}],
        [method, args],
      ]);
      // void methods resolve undefined, the rest with the facade's result.
      expect(out).toEqual(result === null ? undefined : result);
    },
  );

  it('record, edit and exportDraft are open with the entry filled in', async () => {
    const f = fakeAdapter({
      answer: (_m, a, callId) =>
        buildReply({
          ok: true,
          callId,
          result: { ...sent, requestId: (a as { requestId: string }).requestId } as unknown as Json,
        }),
    });
    const client = createPulseClient({ adapter: f.adapter });
    await client.record(ctx, { requestId: 'r-1', draft: { continue: 'd-0' } });
    await client.edit('d-1', { requestId: 'r-2', clipId: 'c-1' });
    await client.exportDraft('d-1', { requestId: 'r-3' });
    await client.open({ entry: 'edit', draftId: 'd-2', requestId: 'r-4' });
    expect(f.calls.slice(1).map((c) => c.args)).toEqual([
      { entry: 'record', context: ctx, requestId: 'r-1', draft: { continue: 'd-0' } },
      { entry: 'edit', draftId: 'd-1', requestId: 'r-2', clipId: 'c-1' },
      { entry: 'export', draftId: 'd-1', requestId: 'r-3' },
      { entry: 'edit', draftId: 'd-2', requestId: 'r-4' },
    ]);
  });

  it('open names the request when the host did not, and joins a pending one with the same id', async () => {
    let finish: () => void = () => {};
    const f = fakeAdapter({
      answer: (_m, a, callId) =>
        new Promise<BridgeReply>((resolve) => {
          finish = () =>
            resolve(
              buildReply({
                ok: true,
                callId,
                result: {
                  ...sent,
                  requestId: (a as { requestId: string }).requestId,
                } as unknown as Json,
              }),
            );
        }),
    });
    const client = createPulseClient({ adapter: f.adapter });
    const a = client.record(ctx, { requestId: 'same' });
    const b = client.record(ctx, { requestId: 'same' });
    expect(b).toBe(a);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    finish();
    await a;
    expect(f.methods()).toEqual(['info', 'open']);

    const c = client.edit('d-1');
    await new Promise((r) => setTimeout(r, 0));
    finish();
    const result = await c;
    expect(result.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('isAvailable is true with a supported facade', async () => {
    const client = createPulseClient({ adapter: fakeAdapter().adapter });
    await expect(client.isAvailable()).resolves.toBe(true);
  });
});

describe('events', () => {
  it('delivers known events, drops unknown ones, and on() returns an unsubscribe', () => {
    const f = fakeAdapter();
    const client = createPulseClient({ adapter: f.adapter });
    const changed: unknown[] = [];
    const off = client.on('draftsChanged', (p) => changed.push(p));
    const weird = jest.fn();
    client.on('teleported' as 'log', weird);
    f.emit('draftsChanged', { namespace: 'n', ids: ['d-1'] });
    f.emit('teleported', { x: 1 });
    off();
    f.emit('draftsChanged', { namespace: 'n', ids: ['d-2'] });
    expect(changed).toEqual([{ namespace: 'n', ids: ['d-1'] }]);
    expect(weird).not.toHaveBeenCalled();
  });

  it('drops a repeated identical flowResult, but delivers a changed one for the same requestId', () => {
    const f = fakeAdapter();
    const client = createPulseClient({ adapter: f.adapter });
    const got: FlowResult[] = [];
    client.on('flowResult', (r) => got.push(r));
    f.emit('flowResult', sent);
    f.emit('flowResult', { ...sent });
    const fallback = { ...sent, status: 'canceled', reason: 'host' };
    f.emit('flowResult', fallback);
    expect(got.map((r) => r.status)).toEqual(['completed', 'canceled']);
  });

  it('keeps a flowResult that arrives before anyone listens, for the first listener', async () => {
    const f = fakeAdapter();
    const client = createPulseClient({ adapter: f.adapter });
    f.emit('flowResult', sent);
    const got: FlowResult[] = [];
    client.on('flowResult', (r) => got.push(r));
    await Promise.resolve();
    expect(got).toEqual([sent]);
    client.on('flowResult', (r) => got.push(r));
    await Promise.resolve();
    expect(got).toHaveLength(1);
  });

  it('a listener that throws does not stop the others', () => {
    const f = fakeAdapter();
    const client = createPulseClient({ adapter: f.adapter });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const second = jest.fn();
    client.on('log', () => {
      throw new Error('host bug');
    });
    client.on('log', second);
    f.emit('log', { level: 'info', line: 'x', at: 1 });
    expect(second).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('getPulse', () => {
  afterEach(() => {
    delete (globalThis as { __PULSE_ADAPTER__?: unknown }).__PULSE_ADAPTER__;
  });

  it('is one page-wide client over the injected adapter', async () => {
    const f = fakeAdapter();
    (globalThis as { __PULSE_ADAPTER__?: unknown }).__PULSE_ADAPTER__ = f.adapter;
    const client = getPulse();
    expect(getPulse()).toBe(client);
    await client.prewarm();
    expect(f.methods()).toEqual(['info', 'prewarm']);
  });
});
