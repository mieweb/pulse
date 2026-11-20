import { describe, expect, it } from '@jest/globals';

import type { HostServices, PulseContext, UploadTarget } from '@mieweb/pulse-embed';
import { createFakePulse, type FakeScript } from '@mieweb/pulse-embed/testing';

import type { FetchInitLike, FetchLike, FetchResponseLike } from './tus';

// Server mode against a local fetch stub standing in for PulseVault (TUS create + PATCH, then the
// status route). No network: every request is answered here.

const ENDPOINT = 'https://vault.test/pulsevault';
const ctx: PulseContext = {
  key: 'ticket:42',
  kind: 'ticket',
  id: '42',
  label: 'Fix login',
  data: { type: 'ticket.video', target: { kind: 'ticket', ticketId: '42' } },
};

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  bytes?: number;
}

function res(
  status: number,
  headers: Record<string, string> = {},
  body?: unknown,
): FetchResponseLike {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (n) => lower[n.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function bodySize(b: FetchInitLike['body']): number | undefined {
  if (b === undefined) return undefined;
  return b instanceof ArrayBuffer ? b.byteLength : b.size;
}

/** A tiny PulseVault: creates, one PATCH per upload, and a status route answering `statuses` in turn. */
function vault(
  o: {
    statuses?: { status: number; body?: unknown }[];
    create?: (n: number) => FetchResponseLike;
    patch?: () => FetchResponseLike | null;
  } = {},
) {
  const seen: Seen[] = [];
  const lengths = new Map<string, number>();
  const statuses = [
    ...(o.statuses ?? [{ status: 200, body: { state: 'ready', outcome: { state: 'done' } } }]),
  ];
  let n = 0;
  const fetch: FetchLike = async (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers, bytes: bodySize(init.body) });
    if (init.method === 'POST' && url === `${ENDPOINT}/upload`) {
      n += 1;
      const custom = o.create?.(n);
      if (custom) return custom;
      const loc = `/pulsevault/upload/up${n}`;
      lengths.set(`https://vault.test${loc}`, Number(init.headers['Upload-Length']));
      return res(201, { Location: loc });
    }
    if (init.method === 'PATCH') {
      const custom = o.patch?.();
      if (custom) return custom;
      return res(204, { 'Upload-Offset': String(lengths.get(url) ?? -1) });
    }
    if (init.method === 'GET' && url.endsWith('/status')) {
      const next = statuses.length > 1 ? statuses.shift() : statuses[0];
      return res(next?.status ?? 404, {}, next?.body);
    }
    return res(404);
  };
  return { fetch, seen };
}

function metadata(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of header.split(',')) {
    const [k, v] = pair.split(' ');
    out[k] = new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)));
  }
  return out;
}

function services(over: Partial<HostServices> = {}): HostServices & { targets: string[] } {
  const targets: string[] = [];
  return {
    targets,
    getUploadTarget: async (r): Promise<UploadTarget> => {
      targets.push(r.clientKey);
      return {
        uploadId: 'up-1',
        endpoint: ENDPOINT,
        artifactId: '11111111-2222-4333-8444-555555555555',
        token: 'tok-1',
        expiresAt: Date.now() + 60_000,
        clientKey: r.clientKey,
      };
    },
    refreshUploadToken: async () => ({ token: 'tok-2', expiresAt: Date.now() + 60_000 }),
    ...over,
  };
}

function fixture(n: number): ArrayBuffer {
  return new Uint8Array(n).fill(7).buffer;
}

function make(v: ReturnType<typeof vault>, over: Partial<FakeScript> = {}) {
  return createFakePulse({
    flows: [{ result: 'sent', name: 'Löwe ✓' }],
    server: {
      fixture: fixture(10),
      pollMs: 2,
      fetch: v.fetch,
      related: [{ kind: 'captions', filename: 'captions.vtt', fixture: fixture(3) }],
    },
    ...over,
  });
}

describe('server mode', () => {
  it('begins through HostServices, uploads over TUS, polls the status route, then retires', async () => {
    const v = vault({
      statuses: [
        { status: 200, body: { artifactId: 'x', state: 'processing' } },
        {
          status: 200,
          body: {
            state: 'ready',
            outcome: { state: 'done', note: 'Attached to Fix login', uploadId: 'up-1' },
          },
        },
      ],
    });
    const fake = make(v);
    const host = services();
    fake.client.setHostServices(host);
    const progress: number[] = [];
    fake.client.on('uploadProgress', (e) => progress.push(e.fraction));
    const r = await fake.client.record(ctx);
    if (r.status !== 'completed' || r.mode !== 'pulse') throw new Error(r.status);
    await fake.idle();

    const [ask] = fake.hostRequests;
    expect(ask.method).toBe('getUploadTarget');
    expect(ask.args).toMatchObject({
      draftId: r.draftId,
      clientKey: r.clientKey,
      draftKey: r.draftKey,
      context: ctx,
      name: 'Löwe ✓',
      bytes: 10,
      sentAt: r.sentAt,
      attempt: 1,
      renewArtifact: false,
    });

    const [captions, captionsPatch, video, videoPatch, poll1, poll2] = v.seen;
    expect(v.seen).toHaveLength(6);
    // The related part goes first, relatedTo the video, under its own artifact id.
    expect(captions.method).toBe('POST');
    const cm = metadata(captions.headers['Upload-Metadata']);
    expect(cm.kind).toBe('captions');
    expect(cm.relatedTo).toBe('11111111-2222-4333-8444-555555555555');
    expect(cm.artifactId).not.toBe(cm.relatedTo);
    expect(captionsPatch.bytes).toBe(3);
    // Then the video: its artifact id, kind, name, length and the bearer token.
    expect(video.url).toBe(`${ENDPOINT}/upload`);
    expect(video.headers['Tus-Resumable']).toBe('1.0.0');
    expect(video.headers['Upload-Length']).toBe('10');
    expect(video.headers.Authorization).toBe('Bearer tok-1');
    expect(metadata(video.headers['Upload-Metadata'])).toEqual({
      artifactId: '11111111-2222-4333-8444-555555555555',
      filename: `${r.draftId}.mp4`,
      kind: 'video',
      name: 'Löwe ✓',
    });
    expect(videoPatch).toMatchObject({
      method: 'PATCH',
      url: 'https://vault.test/pulsevault/upload/up2',
      bytes: 10,
    });
    expect(videoPatch.headers['Upload-Offset']).toBe('0');
    expect(videoPatch.headers['Content-Type']).toBe('application/offset+octet-stream');
    expect(poll1.url).toBe(`${ENDPOINT}/artifacts/11111111-2222-4333-8444-555555555555/status`);
    expect(poll2.headers.Authorization).toBe('Bearer tok-1');

    const d = await fake.client.getDraft(r.draftId);
    expect(d?.state).toBe('sent');
    expect(d?.sent).toMatchObject({
      outcome: 'done',
      note: 'Attached to Fix login',
      uploadId: 'up-1',
      artifactId: '11111111-2222-4333-8444-555555555555',
      sentAt: r.sentAt,
      dismissed: false,
    });
    expect(progress).toEqual([1]);
    expect(host.targets).toEqual([r.clientKey]);
  });

  it('a 401 on the status route refreshes the token; a kept outcome is a kept receipt', async () => {
    const v = vault({
      statuses: [
        { status: 401 },
        {
          status: 200,
          body: { state: 'ready', outcome: { state: 'kept', reason: 'Ticket closed' } },
        },
      ],
    });
    const fake = make(v, { server: { fixture: fixture(4), pollMs: 2, fetch: v.fetch } });
    fake.client.setHostServices(services());
    const r = await fake.client.record(ctx);
    await fake.idle();
    expect(fake.hostRequests.map((h) => h.method)).toEqual([
      'getUploadTarget',
      'refreshUploadToken',
    ]);
    const polls = v.seen.filter((s) => s.method === 'GET');
    expect(polls.map((p) => p.headers.Authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    const d = r.status === 'completed' ? await fake.client.getDraft(r.draftId) : null;
    expect(d?.sent).toMatchObject({ outcome: 'kept', reason: 'Ticket closed' });
  });

  it('a target the server already delivered skips the upload and goes straight to the poll', async () => {
    const v = vault();
    const fake = make(v);
    fake.client.setHostServices(
      services({
        getUploadTarget: async (r) => ({
          uploadId: 'up-9',
          endpoint: ENDPOINT,
          artifactId: 'a-9',
          token: 't',
          expiresAt: 0,
          clientKey: r.clientKey,
          state: 'delivered',
        }),
      }),
    );
    await fake.client.record(ctx);
    await fake.idle();
    expect(v.seen.map((s) => s.method)).toEqual(['GET']);
    expect(fake.drafts()[0].state).toBe('sent');
  });

  it('host refusals: destination.gone fails the job, no_account pauses it, host.unavailable retries', async () => {
    for (const [code, state] of [
      ['destination.gone', 'failed'],
      ['upload.too_large', 'failed'],
      ['no_account', 'needs_credentials'],
      // The host said so itself: retried later (outbox.ts), not paused.
      ['host.unavailable', 'queued'],
      // Not one of the contract's codes: read as host.unavailable.
      ['host_misconfigured', 'queued'],
    ] as const) {
      const v = vault();
      const fake = make(v);
      fake.client.setHostServices(
        services({ getUploadTarget: () => Promise.reject({ code, message: 'nope' }) }),
      );
      await fake.client.record(ctx);
      await fake.idle();
      const [d] = fake.drafts();
      expect([code, d.state]).toEqual([code, state]);
      expect(v.seen).toEqual([]);
      expect(d.upload?.error?.code).toBe(code === 'host_misconfigured' ? 'host.unavailable' : code);
      expect(d.upload?.error?.recoverable).toBe(state !== 'failed');
      expect(d.upload?.attempts).toBe(state === 'queued' ? 1 : 0);
    }
  });

  it('a clientKey mismatch is host_misconfigured', async () => {
    const v = vault();
    const fake = make(v);
    fake.client.setHostServices(
      services({
        getUploadTarget: async () => ({
          uploadId: 'u',
          endpoint: ENDPOINT,
          artifactId: 'a',
          token: 't',
          expiresAt: 0,
          clientKey: 'someone-else',
        }),
      }),
    );
    await fake.client.record(ctx);
    await fake.idle();
    expect(fake.drafts()[0].upload?.error?.code).toBe('host_misconfigured');
    expect(v.seen).toEqual([]);
  });

  it('a Location on another origin and a 4xx PATCH both fail the job without sending the token on', async () => {
    const offsite = vault({ create: () => res(201, { Location: 'https://evil.test/upload/1' }) });
    const fake = make(offsite);
    fake.client.setHostServices(services());
    await fake.client.record(ctx);
    await fake.idle();
    expect(fake.drafts()[0].state).toBe('failed');
    expect(fake.drafts()[0].upload?.error?.code).toBe('upload.failed');
    expect(offsite.seen.some((s) => new URL(s.url).host === 'evil.test')).toBe(false);

    const refused = vault({ patch: () => res(413) });
    const fake2 = make(refused, {
      server: { fixture: fixture(4), pollMs: 2, fetch: refused.fetch },
    });
    fake2.client.setHostServices(services());
    await fake2.client.record(ctx);
    await fake2.idle();
    expect(fake2.drafts()[0].upload?.error?.code).toBe('upload.refused');
  });

  it('waits for the network; delivering is locked; dispose stops the poll', async () => {
    const v = vault({ statuses: [{ status: 200, body: { state: 'processing' } }] });
    const fake = make(v, {
      online: false,
      server: { fixture: fixture(4), pollMs: 2, fetch: v.fetch },
    });
    fake.client.setHostServices(services({ releaseUploadTarget: async () => {} }));
    const r = await fake.client.record(ctx);
    if (r.status !== 'completed') throw new Error(r.status);
    await fake.idle();
    expect(fake.hostRequests).toEqual([]);
    expect(fake.drafts()[0].state).toBe('waiting_network');
    fake.setOnline(true);
    for (let i = 0; i < 100 && fake.drafts()[0].state !== 'delivering'; i++) {
      await new Promise((ok) => setTimeout(ok, 2));
    }
    expect(fake.drafts()[0].state).toBe('delivering');
    await fake.client.cancelUpload(r.draftId).catch((e: { code: string }) => {
      // Delivering is locked for cancel (the bytes landed); the poll goes on.
      expect(e.code).toBe('draft.locked');
    });
    await fake.client.deleteDraft(r.draftId).catch((e: { code: string }) => {
      expect(e.code).toBe('draft.locked');
    });
    fake.dispose();
    await fake.idle();
    const polls = v.seen.filter((s) => s.method === 'GET').length;
    await new Promise((ok) => setTimeout(ok, 10));
    expect(v.seen.filter((s) => s.method === 'GET').length).toBe(polls);
  });

  it('cancelUpload while the host is asked drops the job; the late target is ignored', async () => {
    const v = vault();
    let answer: ((t: UploadTarget) => void) | null = null;
    const fake = make(v);
    const released: string[] = [];
    fake.client.setHostServices(
      services({
        getUploadTarget: (r) =>
          new Promise<UploadTarget>((ok) => {
            answer = ok;
            void r;
          }),
        releaseUploadTarget: async (r) => {
          released.push(r.reason);
        },
      }),
    );
    const r = await fake.client.record(ctx);
    if (r.status !== 'completed' || r.mode !== 'pulse') throw new Error(r.status);
    await new Promise((ok) => setTimeout(ok, 5));
    await fake.client.cancelUpload(r.draftId);
    expect(fake.drafts()[0].state).toBe('ready');
    answer!({
      uploadId: 'u',
      endpoint: ENDPOINT,
      artifactId: 'a',
      token: 't',
      expiresAt: 0,
      clientKey: r.clientKey,
    });
    await fake.idle();
    expect(v.seen).toEqual([]);
    expect(fake.drafts()[0].state).toBe('ready');
    expect(released).toEqual([]);
  });

  it('cancelUpload while uploading aborts the PATCH and releases the target', async () => {
    const v = vault();
    const seen: string[] = [];
    // A PATCH that only ends when aborted.
    const fetch: FetchLike = (url, init) => {
      seen.push(init.method);
      if (init.method !== 'PATCH') return v.fetch(url, init);
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    const fake = make(v, { server: { fixture: fixture(4), pollMs: 2, fetch } });
    const released: { reason: string; uploadId: string }[] = [];
    fake.client.setHostServices(
      services({
        releaseUploadTarget: async (r) => {
          released.push({ reason: r.reason, uploadId: r.uploadId });
        },
      }),
    );
    const r = await fake.client.record(ctx);
    if (r.status !== 'completed') throw new Error(r.status);
    for (let i = 0; i < 100 && !seen.includes('PATCH'); i++) {
      await new Promise((ok) => setTimeout(ok, 2));
    }
    expect(fake.drafts()[0].state).toBe('uploading');
    await fake.client.cancelUpload(r.draftId);
    await fake.idle();
    await new Promise((ok) => setTimeout(ok, 10));
    expect(fake.drafts()[0].state).toBe('ready');
    expect(released).toEqual([{ reason: 'canceled', uploadId: 'up-1' }]);
    expect(seen).toEqual(['POST', 'PATCH']);
  });

  it('without a fetch of its own it calls the global fetch unbound, as a browser needs', async () => {
    const v = vault();
    const original = globalThis.fetch;
    const receivers: unknown[] = [];
    // A browser's fetch throws "Illegal invocation" when called as a method of another object.
    globalThis.fetch = function (this: unknown, url: string, init: FetchInitLike) {
      receivers.push(this);
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return v.fetch(url, init);
    } as unknown as typeof fetch;
    try {
      const fake = createFakePulse({
        flows: [{ result: 'sent' }],
        server: { fixture: fixture(10), pollMs: 2 },
      });
      fake.client.setHostServices(services());
      const r = await fake.client.record(ctx);
      if (r.status !== 'completed') throw new Error(r.status);
      await fake.idle();
      expect(receivers.length > 0).toBe(true);
      expect((await fake.client.getDraft(r.draftId))?.state).toBe('sent');
    } finally {
      globalThis.fetch = original;
    }
  });
});
