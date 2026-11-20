import { describe, expect, it } from '@jest/globals';

import type {
  BridgeEvent,
  DraftState,
  DraftSummary,
  FlowResult,
  PulseContext,
} from '@mieweb/pulse-embed';
import { createFakePulse } from '@mieweb/pulse-embed/testing';

const ctx: PulseContext = { key: 'ticket:42', kind: 'ticket', id: '42', label: 'Fix login' };

async function rejection(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (e) {
    return e as Record<string, unknown>;
  }
  throw new Error('expected a rejection');
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function seed(id: string, state: DraftState, over: Partial<DraftSummary> = {}): DraftSummary {
  return {
    id,
    draftKey: `inst:${id}`,
    name: `Draft ${id}`,
    context: { key: `ticket:${id}`, kind: 'ticket', id, label: id },
    state,
    clipCount: 1,
    durationMs: 1000,
    hasCaptions: false,
    poster: null,
    createdVia: 'host',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('flow steps', () => {
  it("'sent' in pulse mode completes with a queued job", async () => {
    const fake = createFakePulse({
      flows: [{ result: 'sent', name: 'Standup', durationMs: 4200 }],
    });
    const r = await fake.client.record(ctx);
    if (r.status !== 'completed' || r.mode !== 'pulse') throw new Error(r.status);
    expect(r.entry).toBe('record');
    expect(r.endedOn).toBe('export');
    expect(r.stage).toBe('exported');
    expect(r.draft?.name).toBe('Standup');
    expect(r.draft?.durationMs).toBe(4200);
    expect(r.clientKey.startsWith(`${r.draftKey}:`)).toBe(true);
    const d = await fake.client.getDraft(r.draftId);
    expect(d?.state).toBe('queued');
    expect(d?.upload?.sentAt).toBe(r.sentAt);
    // The facade's own copy: FileRef.webUrl is '' until a client fills it.
    const own = fake.lastResult();
    expect(own?.requestId).toBe(r.requestId);
    expect(own?.status === 'completed' && own.draft?.export?.webUrl).toBe('');
  });

  it("'sent' in file mode, and 'file', complete with the export under results/", async () => {
    const fake = createFakePulse({ flows: [{ result: 'sent' }, { result: 'file' }] });
    await fake.client.configure({ uploadMode: 'file' });
    for (const requestId of ['f-1', 'f-2']) {
      const r = await fake.client.record(ctx, { requestId });
      if (r.status !== 'completed' || r.mode !== 'file') throw new Error(r.status);
      expect(r.export.rel).toBe(`results/${requestId}.mp4`);
      expect(r.export.webUrl.startsWith(`fakepulse://local${r.export.path}?v=`)).toBe(true);
      expect(r.project?.rel).toBe(`results/${requestId}.project.json`);
      expect((await fake.client.getDraft(r.draftId))?.state).toBe('ready');
    }
  });

  it("'kept' closes with the take kept as a draft", async () => {
    const fake = createFakePulse({ flows: [{ result: 'kept' }] });
    const r = await fake.client.record(ctx);
    if (r.status !== 'closed') throw new Error(r.status);
    expect(r.reason).toBe('user');
    expect(r.endedOn).toBe('recorder');
    expect(r.stage).toBe('recorded');
    expect((await fake.client.getDraft(r.draftId))?.state).toBe('draft');
  });

  it("'discarded' cancels with no draft, or names the existing draft it left alone", async () => {
    const fake = createFakePulse({
      flows: [{ result: 'discarded' }],
      drafts: [seed('a', 'ready')],
    });
    const r = await fake.client.record(ctx);
    expect(r.status).toBe('canceled');
    expect('draftId' in r).toBe(false);
    expect(await fake.client.listDrafts()).toHaveLength(1);
    const e = await fake.client.edit('a');
    expect(e.status === 'canceled' && e.draftId).toBe('a');
  });

  it("'failed' resolves failed with the scripted code; the last step repeats", async () => {
    const fake = createFakePulse({
      flows: [{ result: 'kept' }, { result: 'failed', code: 'permission.camera' }],
    });
    expect((await fake.client.record(ctx)).status).toBe('closed');
    for (let i = 0; i < 2; i++) {
      const r = await fake.client.record(ctx);
      if (r.status !== 'failed') throw new Error(r.status);
      expect(r.error.code).toBe('permission.camera');
      expect(r.error.recoverable).toBe(false);
      expect(r.endedOn).toBe(null);
    }
    expect(await fake.client.listDrafts()).toHaveLength(1);
  });
});

describe('the inbox', () => {
  it('dropNextResult: the result is in pendingResults once, with no reply and no event', async () => {
    const fake = createFakePulse({ flows: [{ result: 'kept' }], dropNextResult: true });
    const heard: FlowResult[] = [];
    fake.client.on('flowResult', (r) => heard.push(r));
    let answered = false;
    void fake.client.record(ctx, { requestId: 'drop-1' }).then(() => (answered = true));
    await fake.idle();
    await tick();
    const pending = await fake.client.pendingResults();
    expect(pending.map((r) => r.requestId)).toEqual(['drop-1']);
    expect(answered).toBe(false);
    expect(heard).toEqual([]);
    expect(fake.lastResult()?.requestId).toBe('drop-1');

    // Only the next open drops; the one after answers (and both stay until acknowledged).
    const next = await fake.client.record(ctx, { requestId: 'drop-2' });
    expect(next.requestId).toBe('drop-2');
    expect((await fake.client.pendingResults()).map((r) => r.requestId)).toEqual([
      'drop-1',
      'drop-2',
    ]);
    await fake.client.acknowledge('drop-1');
    await fake.client.acknowledge('drop-1');
    expect((await fake.client.pendingResults()).map((r) => r.requestId)).toEqual(['drop-2']);
  });

  it('flowResult and hostRequest events retain at the adapter until a subscriber attaches', async () => {
    const fake = createFakePulse({ flows: [{ result: 'kept' }, { result: 'sent' }] });
    const { adapter } = fake;
    // No client yet: nobody is subscribed. Drive the facade through the adapter alone.
    const kept = await adapter.call(
      'open',
      { entry: 'record', context: ctx as never, requestId: 'ret-1' },
      'c-000000000001',
    );
    expect(kept.ok).toBe(true);
    const clock = { ...ctx, uploadType: { id: 'clock.wrapup', version: 1, confirmSend: true } };
    void adapter.call(
      'open',
      { entry: 'record', context: clock, requestId: 'ret-2' },
      'c-000000000002',
    );
    // Not idle(): the confirmSend waits for a host that isn't there yet.
    await tick(20);
    expect(fake.hostRequests.map((h) => h.method)).toEqual(['confirmSend']);

    const first: BridgeEvent[] = [];
    const second: BridgeEvent[] = [];
    adapter.subscribe((e) => first.push(e));
    adapter.subscribe((e) => second.push(e));
    await tick();
    expect(first.map((e) => e.name)).toEqual(['flowResult', 'hostRequest']);
    expect((first[0].payload as { requestId: string }).requestId).toBe('ret-1');
    // Retained events go out once, to the subscribers there when they're handed over.
    expect(second.map((e) => e.name)).toEqual(['flowResult', 'hostRequest']);
    const later: BridgeEvent[] = [];
    adapter.subscribe((e) => later.push(e));
    await tick();
    expect(later).toEqual([]);
    fake.dispose();
  });

  it('reload: the new page gets a fresh client on the same facade', async () => {
    const fake = createFakePulse({ flows: [{ result: 'kept' }] });
    const before = fake.client;
    const r = await before.record(ctx, { requestId: 'rl-1' });
    const after = fake.reload();
    expect(after).not.toBe(before);
    expect(fake.client).toBe(after);
    expect((await after.pendingResults()).map((p) => p.requestId)).toEqual([r.requestId]);
  });
});

describe('online', () => {
  it('setOnline(false) reads a queued job as waiting_network, and back', async () => {
    const fake = createFakePulse({ drafts: [seed('q', 'queued'), seed('u', 'uploading')] });
    const changed: string[][] = [];
    fake.client.on('draftsChanged', (e) => changed.push(e.ids));
    expect((await fake.client.getDraft('q'))?.state).toBe('queued');
    fake.setOnline(false);
    expect((await fake.client.getDraft('q'))?.state).toBe('waiting_network');
    expect((await fake.client.getDraft('u'))?.state).toBe('uploading');
    expect(await fake.client.listDrafts({ states: ['waiting_network'] })).toHaveLength(1);
    fake.setOnline(true);
    expect((await fake.client.getDraft('q'))?.state).toBe('queued');
    await tick();
    expect(changed).toEqual([['q'], ['q']]);
  });

  it('a Send while offline is waiting_network at once', async () => {
    const fake = createFakePulse({ flows: [{ result: 'sent' }], online: false });
    const r = await fake.client.record(ctx);
    expect(r.status === 'completed' && r.draft?.state).toBe('waiting_network');
  });
});

describe('the catalog', () => {
  const states: DraftState[] = [
    'draft',
    'ready',
    'preparing',
    'queued',
    'uploading',
    'delivering',
    'needs_credentials',
    'failed',
    'sent',
  ];

  it('holds a row in every state; listDrafts leaves receipts out unless asked', async () => {
    const fake = createFakePulse({
      drafts: states.map((s, i) => seed(s, s, { updatedAt: 100 + i })),
    });
    const unsent = await fake.client.listDrafts();
    expect(unsent.map((d) => d.state)).toEqual(states.filter((s) => s !== 'sent').reverse());
    const all = await fake.client.listDrafts({ states: [...states, 'waiting_network'] });
    expect(all.map((d) => d.id).sort()).toEqual([...states].sort());
    const receipt = await fake.client.getDraft('sent');
    expect(receipt?.sent?.outcome).toBe('done');
    expect(receipt?.export).toBeUndefined();
    expect((await fake.client.getDraft('ready'))?.export?.webUrl).toMatch(
      /^fakepulse:\/\/local\/.+\?v=/,
    );
    expect(await fake.client.getDraft('nope')).toBeNull();
  });

  it('filters by context and counts, attention only for failed and kept receipts', async () => {
    const kept = seed('k', 'sent', {
      context: { key: 'clock:e1', kind: 'clock', id: 'e1', label: 'Session' },
      sent: {
        outcome: 'kept',
        reason: 'Session closed',
        uploadId: 'u',
        artifactId: 'a',
        sentAt: 1,
        at: 2,
        expiresAt: 3,
        dismissed: false,
      },
    });
    const fake = createFakePulse({
      drafts: [
        seed('t1', 'ready'),
        seed('t2', 'failed', {
          context: { key: 'ticket:t1', kind: 'ticket', id: 't1', label: 't1' },
        }),
        seed('c1', 'draft', { context: { key: 'clock:e1', kind: 'clock', id: 'e1', label: 'S' } }),
        kept,
      ],
    });
    expect(
      (await fake.client.listDrafts({ contextKeyPrefix: 'ticket:' })).map((d) => d.id).sort(),
    ).toEqual(['t1', 't2']);
    expect((await fake.client.listDrafts({ contextKey: 'clock:e1' })).map((d) => d.id)).toEqual([
      'c1',
    ]);
    expect(await fake.client.countDrafts({ by: 'contextKind' })).toEqual({ ticket: 2, clock: 1 });
    expect(await fake.client.countDrafts({ by: 'contextKey', attentionOnly: true })).toEqual({
      'ticket:t1': 1,
      'clock:e1': 1,
    });
    await fake.client.dismissReceipt('k');
    expect(await fake.client.countDrafts({ by: 'contextKey', attentionOnly: true })).toEqual({
      'ticket:t1': 1,
    });
    expect((await rejection(fake.client.dismissReceipt('t1'))).code).toBe('not_found');
  });

  it('keeps fields it does not model on seeded rows', async () => {
    const fake = createFakePulse({
      drafts: [{ ...seed('x', 'ready'), futureRowField: 7 } as DraftSummary],
    });
    const d = (await fake.client.getDraft('x')) as DraftSummary & { futureRowField?: number };
    expect(d.futureRowField).toBe(7);
  });
});

describe('outbox transitions', () => {
  it('upload → queued → uploading → delivering → retired into a receipt', async () => {
    const fake = createFakePulse({ drafts: [seed('a', 'ready')] });
    const progress: number[] = [];
    fake.client.on('uploadProgress', (e) => progress.push(e.fraction));
    const q = await fake.client.upload('a');
    expect(q.draftKey).toBe('inst:a');
    expect(q.clientKey.startsWith('inst:a:')).toBe(true);
    expect((await fake.client.getDraft('a'))?.state).toBe('queued');
    fake.transition('a', { type: 'uploading', progress: 0.5 });
    const up = await fake.client.getDraft('a');
    expect(up?.state).toBe('uploading');
    expect(up?.upload?.progress).toBe(0.5);
    expect((await rejection(fake.client.deleteDraft('a'))).code).toBe('draft.locked');
    fake.transition('a', { type: 'delivering' });
    expect((await rejection(fake.client.cancelUpload('a'))).code).toBe('draft.locked');
    fake.transition('a', { type: 'delivered', outcome: 'kept', reason: 'Ticket closed' });
    const done = await fake.client.getDraft('a');
    expect(done?.state).toBe('sent');
    expect(done?.sent?.outcome).toBe('kept');
    expect(done?.sent?.reason).toBe('Ticket closed');
    expect(done?.sent?.sentAt).toBe(q.sentAt);
    expect(done?.poster).toBeNull();
    await tick();
    expect(progress).toEqual([0.5]);
  });

  it('cancelUpload takes queued, failed and needs_credentials back to unsent', async () => {
    const fake = createFakePulse({
      drafts: [seed('q', 'queued'), seed('f', 'failed'), seed('n', 'needs_credentials')],
    });
    for (const id of ['q', 'f', 'n']) {
      await fake.client.cancelUpload(id);
      const d = await fake.client.getDraft(id);
      expect(d?.state).toBe('ready');
      expect(d?.upload).toBeUndefined();
    }
  });

  it('resumeOutbox moves needs_credentials back to queued', async () => {
    const fake = createFakePulse({ drafts: [seed('n', 'needs_credentials')] });
    await fake.client.resumeOutbox();
    expect((await fake.client.getDraft('n'))?.state).toBe('queued');
  });

  it("retireDraft: 'file' mode retires at once; in 'pulse' mode only the status route does", async () => {
    const fake = createFakePulse({
      drafts: [seed('a', 'ready'), seed('b', 'queued'), seed('c', 'delivering')],
    });
    await fake.client.retireDraft('b');
    expect((await fake.client.getDraft('b'))?.state).toBe('queued');
    // A hint to ask the status route again, as the real job loop takes it: no retirement.
    await fake.client.retireDraft('c');
    expect((await fake.client.getDraft('c'))?.state).toBe('delivering');
    fake.transition('c', { type: 'delivered', outcome: 'done' });
    expect((await fake.client.getDraft('c'))?.sent?.outcome).toBe('done');
    await fake.client.configure({ uploadMode: 'file' });
    await fake.client.retireDraft('a');
    const a = await fake.client.getDraft('a');
    expect(a?.state).toBe('sent');
    expect(a?.sent?.uploadId).toBe('');
    expect((await rejection(fake.client.retireDraft('zz'))).code).toBe('not_found');
  });

  it('locks: locked states, the open draft, and a clock-bound draft refuse Move to…', async () => {
    const fake = createFakePulse({
      flows: [{ result: 'kept', afterMs: 50 }],
      drafts: [
        seed('p', 'preparing'),
        seed('r', 'ready'),
        seed('c', 'ready', { confirmedAt: 5, upload: undefined }),
      ],
    });
    expect((await rejection(fake.client.edit('p'))).code).toBe('draft.locked');
    expect((await rejection(fake.client.setDraftContext('p', ctx))).code).toBe('draft.locked');
    const moved = await rejection(fake.client.setDraftContext('c', ctx));
    expect(moved.code).toBe('draft.locked');
    expect(moved.reason).toBe('clock_bound');
    const open = fake.client.edit('r');
    await tick(5);
    expect((await rejection(fake.client.deleteDraft('r'))).code).toBe('draft.locked');
    // The open flow holds its draft against every write (router.ts), a rename too.
    expect((await rejection(fake.client.renameDraft('r', 'Renamed'))).code).toBe('draft.locked');
    await open;
    await fake.client.renameDraft('r', 'Renamed after');
    await fake.client.setDraftContext('r', ctx);
    const r = await fake.client.getDraft('r');
    expect(r?.context).toEqual(ctx);
    expect(r?.name).toBe('Renamed after');
    await fake.client.deleteDraft('r');
    expect(await fake.client.getDraft('r')).toBeNull();
  });
});

describe('open and close', () => {
  it('busy while open; close keeps the take, close({discard}) deletes it', async () => {
    const fake = createFakePulse({ flows: [{ result: 'kept', afterMs: 1000 }] });
    const a = fake.client.record(ctx, { requestId: 'o-1' });
    await tick(5);
    expect(await fake.client.isOpen()).toBe(true);
    expect((await rejection(fake.client.record(ctx, { requestId: 'o-2' }))).code).toBe('busy');
    expect((await rejection(fake.client.setAccount(null))).code).toBe('busy');
    await fake.client.close();
    const kept = await a;
    expect(kept.status === 'closed' && kept.reason).toBe('host');
    expect(await fake.client.listDrafts()).toHaveLength(1);

    const b = fake.client.record(ctx, { requestId: 'o-3' });
    await tick(5);
    await fake.client.close({ reason: 'host', discard: true });
    const gone = await b;
    expect(gone.status === 'canceled' && gone.reason).toBe('host');
    expect(await fake.client.listDrafts()).toHaveLength(1);
    await fake.client.close(); // nothing open: a no-op
    await fake.idle();
  });

  it('an open asked again after it ended returns the result the inbox holds', async () => {
    const fake = createFakePulse({ flows: [{ result: 'kept' }] });
    const first = await fake.client.record(ctx, { requestId: 'again-1' });
    const again = await fake.reload().record(ctx, { requestId: 'again-1' });
    expect(again).toEqual(first);
    expect(await fake.client.listDrafts()).toHaveLength(1);
  });

  it('records every call, and a method it does not list never reaches the facade', async () => {
    const fake = createFakePulse({ info: { methods: ['info', 'open', 'isOpen'] } });
    expect((await rejection(fake.client.listDrafts())).code).toBe('method.unsupported');
    await fake.client.isOpen();
    expect(fake.calls.map((c) => c.method)).toEqual(['info', 'isOpen']);
    // Raw, past the client: the facade routes the same way (envelope.ts routeRequest).
    const raw = await fake.adapter.call('listDrafts', {}, 'c-000000000003');
    expect(raw.ok === false && raw.error.code).toBe('method.unsupported');
  });

  it('the facade checks open like the Swift side: record without a context is invalid_options', async () => {
    const fake = createFakePulse();
    const raw = await fake.adapter.call(
      'open',
      { entry: 'record', futureField: 1 },
      'c-000000000004',
    );
    expect(raw.ok === false && raw.error.code).toBe('invalid_options');
    expect(await fake.client.isOpen()).toBe(false);
  });
});

describe('accounts', () => {
  it('starts signed in by default; signed out, data calls are no_account', async () => {
    const fake = createFakePulse({ account: null, flows: [{ result: 'kept' }] });
    expect((await fake.client.getInfo()).namespace).toBeNull();
    expect((await rejection(fake.client.listDrafts())).code).toBe('no_account');
    expect((await rejection(fake.client.record(ctx))).code).toBe('no_account');
    const { namespace } = await fake.client.setAccount({
      serverOrigin: 'https://TH.example.org',
      userId: 'u1',
    });
    expect(namespace).toMatch(/^fake\.host-[0-9a-f]{16}$/);
    expect((await fake.client.getInfo()).namespace).toBe(namespace);
    expect(await fake.client.listDrafts()).toEqual([]);
    const again = await fake.client.setAccount({
      serverOrigin: 'https://th.example.org',
      userId: 'u1',
    });
    expect(again.namespace).toBe(namespace);
    const spaces = await fake.client.listNamespaces();
    expect(spaces.filter((s) => s.active).map((s) => s.namespace)).toEqual([namespace]);
  });

  it('seeded drafts reach the namespace the page binds: its hostId and its first account', async () => {
    const fake = createFakePulse({ drafts: [seed('a', 'ready')] });
    await fake.client.configure({ uploadMode: 'pulse', hostId: 'com.example.th' });
    const { namespace } = await fake.client.setAccount({
      serverOrigin: 'https://th.example.org',
      userId: 'person-1',
    });
    expect(namespace).toMatch(/^com\.example\.th-[0-9a-f]{16}$/);
    expect((await fake.client.listDrafts()).map((d) => d.id)).toEqual(['a']);
    // Only the first sign-in takes them: another person starts empty, and the first keeps them.
    await fake.client.setAccount({ serverOrigin: 'https://th.example.org', userId: 'person-2' });
    expect(await fake.client.listDrafts()).toEqual([]);
    await fake.client.setAccount({ serverOrigin: 'https://th.example.org', userId: 'person-1' });
    expect((await fake.client.listDrafts()).map((d) => d.id)).toEqual(['a']);
    expect((await fake.client.listNamespaces()).map((n) => n.namespace).sort()).toHaveLength(2);
  });

  it('usage counts the active namespace; purge empties it', async () => {
    const fake = createFakePulse({
      drafts: [
        seed('a', 'ready', { bytes: 10 }),
        seed('f', 'failed', { bytes: 5 }),
        seed('s', 'sent'),
      ],
    });
    const u = await fake.client.usage();
    expect([u.drafts, u.unsent, u.failed, u.receipts, u.bytes]).toEqual([2, 2, 1, 1, 15]);
    await fake.client.purge();
    expect((await fake.client.usage()).drafts).toBe(0);
  });
});

describe('confirmSend', () => {
  const clock: PulseContext = {
    key: 'clock:e1',
    kind: 'clock',
    id: 'e1',
    label: 'Session',
    uploadType: { id: 'clock.session', version: 1, confirmSend: true },
  };

  it('Edit → Send on a confirmed draft skips the confirm and keeps the first sentAt', async () => {
    let t = 1000;
    const fake = createFakePulse({ flows: [{ result: 'sent' }], now: () => (t += 10) });
    let asked = 0;
    fake.client.setHostServices({
      getUploadTarget: () => new Promise(() => {}),
      refreshUploadToken: () => new Promise(() => {}),
      confirmSend: async () => {
        asked += 1;
        return { confirmedAt: 777 };
      },
    });
    const first = await fake.client.record(clock);
    if (first.status !== 'completed' || first.mode !== 'pulse') throw new Error(first.status);
    expect(first.confirmedAt).toBe(777);
    await fake.client.cancelUpload(first.draftId);
    const second = await fake.client.edit(first.draftId);
    if (second.status !== 'completed' || second.mode !== 'pulse') throw new Error(second.status);
    expect(asked).toBe(1);
    expect(second.sentAt).toBe(first.sentAt);
    expect(second.clientKey).not.toBe(first.clientKey);
    expect(second.draftKey).toBe(first.draftKey);
  });

  it('without a confirmSend handler the Send fails and the draft stays unsent', async () => {
    const fake = createFakePulse({ flows: [{ result: 'sent' }] });
    fake.client.setHostServices({
      getUploadTarget: () => new Promise(() => {}),
      refreshUploadToken: () => new Promise(() => {}),
    });
    const flow = fake.client.record(clock, { requestId: 'nh-1' });
    await fake.idle();
    await tick();
    expect(await fake.client.isOpen()).toBe(true);
    const [d] = fake.drafts();
    expect(d.state).toBe('ready');
    expect(d.confirmedAt).toBeUndefined();
    await fake.client.close({ discard: true });
    expect((await flow).status).toBe('canceled');
    expect(fake.drafts()).toEqual([]);
  });
});
