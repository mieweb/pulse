import { describe, expect, it, jest } from '@jest/globals';

import type {
  CountOptions,
  DraftFilter,
  DraftSummary,
  FlowResult,
  OpenRequest,
  PulseEventName,
  PulseInfo,
} from '@mieweb/pulse-embed';

import { pulseError } from '../errors';
import {
  createAvailabilityStore,
  createDraftCountsStore,
  createDraftsStore,
  createDraftStore,
  createPresentStore,
} from './stores';

const tick = () => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A client stand-in: `on` records listeners so the test can fire events. */
function fakeClient() {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const on = jest.fn((name: PulseEventName, cb: (p: never) => void) => {
    let set = listeners.get(name);
    if (!set) listeners.set(name, (set = new Set()));
    set.add(cb as (p: unknown) => void);
    return () => {
      set.delete(cb as (p: unknown) => void);
    };
  });
  const emit = (name: string, payload: unknown) => {
    for (const cb of [...(listeners.get(name) ?? [])]) cb(payload);
  };
  const count = (name: string) => listeners.get(name)?.size ?? 0;
  return { on, emit, count };
}

const draft = (id: string, n = 0) =>
  ({ id, state: 'ready', clipCount: n }) as unknown as DraftSummary;

describe('the drafts store', () => {
  it('reads on the first subscribe and re-reads on draftsChanged and uploadProgress', async () => {
    const c = fakeClient();
    let n = 0;
    const listDrafts = jest.fn(async (_f?: DraftFilter) => [draft('d-1', ++n)]);
    const store = createDraftsStore(
      { on: c.on as never, listDrafts },
      { contextKeyPrefix: 'ticket:' },
    );
    expect(store.getSnapshot()).toMatchObject({ data: undefined, loading: true, error: null });
    expect(listDrafts).not.toHaveBeenCalled();

    const changed = jest.fn();
    const off = store.subscribe(changed);
    await tick();
    expect(listDrafts).toHaveBeenCalledWith({ contextKeyPrefix: 'ticket:' });
    expect(store.getSnapshot()).toMatchObject({ data: [draft('d-1', 1)], loading: false });

    c.emit('draftsChanged', { namespace: 'n', ids: ['d-1'] });
    await tick();
    expect(store.getSnapshot().data).toEqual([draft('d-1', 2)]);

    c.emit('uploadProgress', { draftId: 'd-1', fraction: 0.5, bytesSent: 1, bytesTotal: 2 });
    await tick();
    expect(store.getSnapshot().data).toEqual([draft('d-1', 3)]);
    expect(changed).toHaveBeenCalled();

    // After the last unsubscribe, events no longer trigger reads.
    off();
    expect(c.count('draftsChanged')).toBe(0);
    c.emit('draftsChanged', { namespace: 'n', ids: [] });
    await tick();
    expect(listDrafts).toHaveBeenCalledTimes(3);
  });

  it('runs one more read for any number of events during a read', async () => {
    const c = fakeClient();
    const reads: ReturnType<typeof deferred<DraftSummary[]>>[] = [];
    const listDrafts = jest.fn(() => {
      const d = deferred<DraftSummary[]>();
      reads.push(d);
      return d.promise;
    });
    const store = createDraftsStore({ on: c.on as never, listDrafts });
    store.subscribe(() => {});
    for (let i = 0; i < 5; i++) {
      c.emit('uploadProgress', { draftId: 'd-1', fraction: i / 5, bytesSent: i, bytesTotal: 5 });
    }
    expect(listDrafts).toHaveBeenCalledTimes(1);
    reads[0].resolve([draft('a')]);
    await tick();
    expect(listDrafts).toHaveBeenCalledTimes(2);
    // Still loading: a newer read is running.
    expect(store.getSnapshot()).toMatchObject({ data: [draft('a')], loading: true });
    reads[1].resolve([draft('b')]);
    await tick();
    expect(listDrafts).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({ data: [draft('b')], loading: false });
  });

  it('keeps the data and reports the error as PulseErrorInfo when a read fails; refresh retries', async () => {
    const c = fakeClient();
    const listDrafts = jest
      .fn<() => Promise<DraftSummary[]>>()
      .mockResolvedValueOnce([draft('a')])
      .mockRejectedValueOnce(pulseError('no_account', 'signed out', 'c-1'))
      .mockResolvedValueOnce([]);
    const store = createDraftsStore({ on: c.on as never, listDrafts });
    store.subscribe(() => {});
    await tick();
    c.emit('draftsChanged', { namespace: 'n', ids: [] });
    await tick();
    const s = store.getSnapshot();
    expect(s.data).toEqual([draft('a')]);
    expect(s.error).toEqual({
      code: 'no_account',
      message: 'signed out',
      recoverable: false,
      callId: 'c-1',
    });
    s.refresh();
    await tick();
    expect(store.getSnapshot()).toMatchObject({ data: [], error: null, loading: false });
  });

  it('gives the same snapshot object until something changes', async () => {
    const c = fakeClient();
    const store = createDraftsStore({ on: c.on as never, listDrafts: async () => [] });
    store.subscribe(() => {});
    await tick();
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });
});

describe('the draft and counts stores', () => {
  it('re-reads one draft only for events that name it', async () => {
    const c = fakeClient();
    const getDraft = jest.fn(async (id: string) => draft(id));
    const store = createDraftStore({ on: c.on as never, getDraft }, 'd-1');
    store.subscribe(() => {});
    await tick();
    c.emit('draftsChanged', { namespace: 'n', ids: ['d-2'] });
    c.emit('uploadProgress', { draftId: 'd-2', fraction: 1, bytesSent: 1, bytesTotal: 1 });
    await tick();
    expect(getDraft).toHaveBeenCalledTimes(1);
    c.emit('draftsChanged', { namespace: 'n', ids: ['d-1', 'd-2'] });
    await tick();
    c.emit('uploadProgress', { draftId: 'd-1', fraction: 1, bytesSent: 1, bytesTotal: 1 });
    await tick();
    expect(getDraft).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().data).toEqual(draft('d-1'));
  });

  it('reads nothing for a null id', () => {
    const getDraft = jest.fn(async () => null);
    const store = createDraftStore({ on: fakeClient().on as never, getDraft }, null);
    store.subscribe(() => {});
    expect(getDraft).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({ data: null, loading: false, error: null });
  });

  it('re-reads counts on draftsChanged', async () => {
    const c = fakeClient();
    let n = 0;
    const countDrafts = jest.fn(async (_o: CountOptions) => ({ 'ticket:42': ++n }));
    const store = createDraftCountsStore({ on: c.on as never, countDrafts }, { by: 'contextKey' });
    store.subscribe(() => {});
    await tick();
    c.emit('draftsChanged', { namespace: 'n', ids: [] });
    await tick();
    expect(countDrafts).toHaveBeenCalledWith({ by: 'contextKey' });
    expect(store.getSnapshot().data).toEqual({ 'ticket:42': 2 });
  });
});

describe('the availability store', () => {
  it('is available for a supported facade', async () => {
    const info = { supported: true } as PulseInfo;
    const store = createAvailabilityStore({ getInfo: async () => info });
    expect(store.getSnapshot()).toEqual({ available: false, info: null, loading: true });
    store.subscribe(() => {});
    await tick();
    expect(store.getSnapshot()).toEqual({ available: true, info, loading: false });
  });

  it('is not available when unsupported or when getInfo rejects', async () => {
    const unsupported = createAvailabilityStore({
      getInfo: async () => ({ supported: false }) as PulseInfo,
    });
    unsupported.subscribe(() => {});
    const missing = createAvailabilityStore({
      getInfo: async () => {
        throw pulseError('unavailable', 'no plugin', 'c-1');
      },
    });
    missing.subscribe(() => {});
    await tick();
    expect(unsupported.getSnapshot()).toMatchObject({ available: false, loading: false });
    expect(missing.getSnapshot()).toEqual({ available: false, info: null, loading: false });
  });
});

describe('the present store', () => {
  const result = { requestId: 'r-1', status: 'canceled' } as FlowResult;
  const req: OpenRequest = { entry: 'edit', draftId: 'd-1' };

  it('holds one pending flow: a second open gets the same pending result', async () => {
    const c = fakeClient();
    const d = deferred<FlowResult>();
    const open = jest.fn((_r: OpenRequest) => d.promise);
    const store = createPresentStore({ open, on: c.on as never });
    store.subscribe(() => {});
    const a = store.open(req);
    const b = store.open({ entry: 'export', draftId: 'd-2' });
    expect(b).toBe(a);
    expect(open).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual({ isOpen: true, lastResult: null });
    d.resolve(result);
    await expect(a).resolves.toBe(result);
    expect(store.getSnapshot()).toEqual({ isOpen: false, lastResult: result });
    // Once it ended, the next open is a new flow.
    open.mockResolvedValueOnce({ ...result, requestId: 'r-2' });
    await store.open(req);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('closes on a rejected open and passes the error on', async () => {
    const c = fakeClient();
    const store = createPresentStore({
      open: async () => {
        throw pulseError('busy', 'busy', 'c-1');
      },
      on: c.on as never,
    });
    await expect(store.open(req)).rejects.toMatchObject({ code: 'busy' });
    expect(store.getSnapshot().isOpen).toBe(false);
  });

  it('takes lastResult from flowResult events while subscribed', () => {
    const c = fakeClient();
    const store = createPresentStore({ open: jest.fn(async () => result), on: c.on as never });
    const off = store.subscribe(() => {});
    c.emit('flowResult', result);
    expect(store.getSnapshot().lastResult).toBe(result);
    off();
    expect(c.count('flowResult')).toBe(0);
  });
});
