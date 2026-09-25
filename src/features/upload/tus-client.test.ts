import { describe, expect, it, jest } from '@jest/globals';

import {
  cancelTusUpload,
  TusUploadError,
  type UploadChunk,
  uploadViaTus,
} from './tus-client';
import { setClientIdentity } from './client-identity';

const SERVER = 'https://vault.example.test/pulsevault';
const ARTIFACT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Minimal stand-in for an expo-file-system `File` — only `.size` is read by tus-client (the actual bytes never flow through this module; see `uploadChunk`). */
function fakeFile(size: number) {
  return { size };
}

type FetchCall = { url: string; init?: RequestInit };

/** Hand-rolled fetch stub: records calls, returns the next programmed response for each method. Only used for the headers-only requests (create/HEAD/DELETE) — the byte-carrying PATCHes go through `uploadChunk` instead. */
function createFetchStub(responses: Partial<Record<string, Response[]>>) {
  const calls: FetchCall[] = [];
  const queues = new Map(Object.entries(responses).map(([k, v]) => [k, [...(v ?? [])]]));
  const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? 'GET';
    const queue = queues.get(method);
    const next = queue?.shift();
    if (!next) throw new Error(`No stubbed response for ${method} ${url}`);
    return next;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

type ChunkCall = {
  offset: number;
  chunkBytes: number;
  totalBytes: number;
  headers: Record<string, string>;
};

/** Hand-rolled stand-in for the native per-chunk upload task: records calls, returns the next programmed result. Each programmed result may carry `ticks` — in-flight byte counts to report through `onProgress` before resolving. */
function createChunkStub(
  results: { status: number; headers?: Record<string, string>; ticks?: number[] }[],
) {
  const calls: ChunkCall[] = [];
  const queue = [...results];
  const uploadChunk: UploadChunk = async ({
    offset,
    chunkBytes,
    totalBytes,
    headers,
    onProgress,
  }) => {
    calls.push({ offset, chunkBytes, totalBytes, headers });
    const next = queue.shift();
    if (!next) throw new Error('No stubbed chunk result');
    for (const tick of next.ticks ?? []) onProgress?.(tick);
    return { status: next.status, headers: next.headers ?? {} };
  };
  return { uploadChunk, calls };
}

/** The 204 a TUS server returns for a successful PATCH: the new authoritative offset. */
function chunkOk(newOffset: number) {
  return { status: 204, headers: { 'Upload-Offset': String(newOffset) } };
}

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };

/**
 * A redirect descriptor for `createRedirectFollowingFetchStub`: models a real
 * HTTP 3xx response instead of a plain 200/204/4xx Response.
 */
type RedirectDescriptor = { to: string; status?: number };

/**
 * Unlike `createFetchStub`, this models what an actual `fetch` implementation
 * does with a 3xx response: with the default `redirect: 'follow'` mode, the
 * runtime transparently resends the same method/headers (including
 * `Authorization`) to the `Location` target and only ever hands the caller the
 * final response — the 3xx itself, and the fact a redirect happened at all,
 * is invisible to application code unless the request explicitly opted out
 * via `redirect: 'manual'`. `leaked` records every request the *redirect
 * target* actually received, so a test can assert whether secrets reached an
 * attacker-controlled origin even though tus-client itself never saw an error.
 */
function createRedirectFollowingFetchStub(
  responses: Partial<Record<string, (Response | RedirectDescriptor)[]>>,
  finalResponse: () => Response,
) {
  const calls: FetchCall[] = [];
  const leaked: { url: string; headers: Record<string, string> }[] = [];
  const queues = new Map(Object.entries(responses).map(([k, v]) => [k, [...(v ?? [])]]));
  const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? 'GET';
    const queue = queues.get(method);
    const next = queue?.shift();
    if (!next) throw new Error(`No stubbed response for ${method} ${url}`);
    if (next instanceof Response) return next;

    if (init?.redirect === 'manual') {
      return new Response(null, { status: next.status ?? 307, headers: { location: next.to } });
    }
    // Simulate the runtime transparently following the redirect: the target
    // receives the original request (with its Authorization header) before
    // tus-client ever gets a response back.
    leaked.push({ url: next.to, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
    return finalResponse();
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, leaked };
}

describe('uploadViaTus', () => {
  it('creates, HEADs once, then uploads a small file as a single chunk', async () => {
    const file = fakeFile(20);
    const { fetchImpl, calls } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [new Response(null, { status: 200, headers: { 'upload-offset': '0' } })],
    });
    const { uploadChunk, calls: chunkCalls } = createChunkStub([chunkOk(20)]);

    const progress: number[] = [];
    const result = await uploadViaTus({
      server: SERVER,
      token: 'tok',
      artifactId: ARTIFACT_ID,
      filename: 'clip.mp4',
      kind: 'video',
      file: file as never,
      fetchImpl,
      uploadChunk,
      onProgress: ({ bytesSent }) => progress.push(bytesSent),
    });

    expect(result.resourceUrl).toBe('https://vault.example.test/pulsevault/upload/abc');
    expect(progress).toEqual([0, 20]);
    // Exactly one HEAD: completion is known from the last 204's Upload-Offset.
    expect(calls.filter((c) => c.init?.method === 'HEAD')).toHaveLength(1);

    const createCall = calls.find((c) => c.init?.method === 'POST');
    const headers = createCall?.init?.headers as Record<string, string>;
    expect(headers['Tus-Resumable']).toBe('1.0.0');
    expect(headers['Upload-Length']).toBe('20');
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['Upload-Metadata']).toContain(`artifactId ${btoa(ARTIFACT_ID)}`);
    expect(headers['Upload-Metadata']).toContain(`kind ${btoa('video')}`);

    expect(chunkCalls).toHaveLength(1);
    expect(chunkCalls[0].offset).toBe(0);
    expect(chunkCalls[0].chunkBytes).toBe(20);
    expect(chunkCalls[0].totalBytes).toBe(20);
    expect(chunkCalls[0].headers['Upload-Offset']).toBe('0');
    expect(chunkCalls[0].headers.Authorization).toBe('Bearer tok');
  });

  it('splits a file into sequential bounded chunks, advancing on each 204 Upload-Offset', async () => {
    const file = fakeFile(25);
    const { fetchImpl, calls } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [new Response(null, { status: 200, headers: { 'upload-offset': '0' } })],
    });
    const { uploadChunk, calls: chunkCalls } = createChunkStub([
      chunkOk(10),
      chunkOk(20),
      chunkOk(25),
    ]);

    const progress: number[] = [];
    await uploadViaTus({
      server: SERVER,
      token: null,
      artifactId: ARTIFACT_ID,
      filename: 'clip.mp4',
      kind: 'video',
      file: file as never,
      chunkSizeBytes: 10,
      fetchImpl,
      uploadChunk,
      onProgress: ({ bytesSent }) => progress.push(bytesSent),
    });

    // Strictly sequential, bounded, offset-labelled per chunk.
    expect(chunkCalls.map((c) => [c.offset, c.chunkBytes])).toEqual([
      [0, 10],
      [10, 10],
      [20, 5],
    ]);
    expect(chunkCalls.map((c) => c.headers['Upload-Offset'])).toEqual(['0', '10', '20']);
    // No in-flight ticks programmed — progress here is the durable offsets only.
    expect(progress).toEqual([0, 10, 20, 25]);
    // Still exactly one HEAD — no per-chunk offset polling on the happy path.
    expect(calls.filter((c) => c.init?.method === 'HEAD')).toHaveLength(1);
  });

  it('defaults to a single PATCH carrying the whole remainder (offset → EOF)', async () => {
    // Standard TUS shape (tus-js-client defaults chunkSize to Infinity): a
    // fresh 100 MB upload is ONE PATCH — one native background transfer, no
    // per-chunk staging or dead time. Bounding requires opting in.
    const size = 100 * 1024 * 1024;
    const file = fakeFile(size);
    const { fetchImpl } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [new Response(null, { status: 200, headers: { 'upload-offset': '0' } })],
    });
    const { uploadChunk, calls: chunkCalls } = createChunkStub([chunkOk(size)]);

    await uploadViaTus({
      server: SERVER,
      token: null,
      artifactId: ARTIFACT_ID,
      filename: 'clip.mp4',
      kind: 'video',
      file: file as never,
      fetchImpl,
      uploadChunk,
    });

    expect(chunkCalls.map((c) => [c.offset, c.chunkBytes])).toEqual([[0, size]]);
  });

  it('forwards in-flight progress ticks, then re-anchors on the server-acknowledged offset', async () => {
    const file = fakeFile(100);
    const { fetchImpl } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [new Response(null, { status: 200, headers: { 'upload-offset': '0' } })],
    });
    // Native ticks are relative to the PATCH body; the last tick may claim
    // more than the wire has durably committed — the 204's offset re-anchors.
    const { uploadChunk } = createChunkStub([{ ...chunkOk(100), ticks: [30, 70, 100] }]);

    const progress: number[] = [];
    await uploadViaTus({
      server: SERVER,
      token: null,
      artifactId: ARTIFACT_ID,
      filename: 'clip.mp4',
      kind: 'video',
      file: file as never,
      fetchImpl,
      uploadChunk,
      onProgress: ({ bytesSent }) => progress.push(bytesSent),
    });

    expect(progress).toEqual([0, 30, 70, 100, 100]);
  });

  it('reports resumed in-flight progress as offset + bytes sent this attempt, clamped to the total', async () => {
    const file = fakeFile(100);
    const { fetchImpl } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [new Response(null, { status: 200, headers: { 'upload-offset': '40' } })],
    });
    // 70 sent on a 60-byte remainder would claim 110/100 — must clamp.
    const { uploadChunk } = createChunkStub([{ ...chunkOk(100), ticks: [20, 70] }]);

    const progress: number[] = [];
    await uploadViaTus({
      server: SERVER,
      token: null,
      artifactId: ARTIFACT_ID,
      filename: 'clip.mp4',
      kind: 'video',
      file: file as never,
      fetchImpl,
      uploadChunk,
      onProgress: ({ bytesSent }) => progress.push(bytesSent),
    });

    expect(progress).toEqual([40, 60, 100, 100]);
  });

  it.each([0, -1, 0.5, NaN, Infinity])(
    'rejects an invalid chunkSizeBytes (%p) up front with a non-retryable error',
    async (chunkSizeBytes) => {
      const file = fakeFile(20);
      const { fetchImpl, calls } = createFetchStub({});
      const { uploadChunk, calls: chunkCalls } = createChunkStub([]);

      await expect(
        uploadViaTus({
          server: SERVER,
          token: null,
          artifactId: ARTIFACT_ID,
          filename: 'clip.mp4',
          kind: 'video',
          file: file as never,
          chunkSizeBytes,
          fetchImpl,
          uploadChunk,
        }),
      ).rejects.toMatchObject({ name: 'TusUploadError', retryable: false });
      // Fails fast: nothing was created and no bytes moved.
      expect(calls).toHaveLength(0);
      expect(chunkCalls).toHaveLength(0);
    },
  );

  it('treats a 204 without a usable Upload-Offset as transient: re-HEADs, then continues from the authoritative offset', async () => {
    const file = fakeFile(20);
    const { fetchImpl, calls } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [
        new Response(null, { status: 200, headers: { 'upload-offset': '0' } }),
        // The re-HEAD: the anomalous 204's chunk actually landed server-side.
        new Response(null, { status: 200, headers: { 'upload-offset': '10' } }),
      ],
    });
    const { uploadChunk, calls: chunkCalls } = createChunkStub([
      { status: 204 }, // no Upload-Offset header — position can't be trusted
      chunkOk(20),
    ]);

    await uploadViaTus({
      server: SERVER,
      token: null,
      artifactId: ARTIFACT_ID,
      filename: 'clip.mp4',
      kind: 'video',
      file: file as never,
      chunkSizeBytes: 10,
      fetchImpl,
      uploadChunk,
    });

    expect(calls.filter((c) => c.init?.method === 'HEAD')).toHaveLength(2);
    // Second attempt resumed from the re-HEAD's offset, not a local guess.
    expect(chunkCalls.map((c) => [c.offset, c.chunkBytes])).toEqual([
      [0, 10],
      [10, 10],
    ]);
  });

  it('treats a 404 on the upload it just created as terminal, without creating another', async () => {
    const file = fakeFile(20);
    const { fetchImpl, calls } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [new Response(null, { status: 404 })],
    });
    const { uploadChunk } = createChunkStub([]);

    await expect(
      uploadViaTus({
        server: SERVER,
        token: 'tok',
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        file: file as never,
        fetchImpl,
        uploadChunk,
      }),
    ).rejects.toMatchObject({ retryable: false, statusCode: 404 });
    expect(calls.filter((c) => c.init?.method === 'POST')).toHaveLength(1);
  });

  it('retries a transient (5xx) chunk failure by re-HEADing and re-attempting from the fresh offset', async () => {
    const file = fakeFile(30);
    const { fetchImpl, calls } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [
        new Response(null, { status: 200, headers: { 'upload-offset': '0' } }),
        // Re-HEAD after the failed second chunk: the server kept a partial 17
        // of it — the next chunk must start exactly there, not at a local
        // chunk-boundary guess.
        new Response(null, { status: 200, headers: { 'upload-offset': '17' } }),
      ],
    });
    const { uploadChunk, calls: chunkCalls } = createChunkStub([
      chunkOk(10),
      { status: 503, headers: JSON_HEADERS },
      chunkOk(27),
      chunkOk(30),
    ]);

    const result = await uploadViaTus({
      server: SERVER,
      token: null,
      artifactId: ARTIFACT_ID,
      filename: 'clip.mp4',
      kind: 'video',
      file: file as never,
      chunkSizeBytes: 10,
      fetchImpl,
      uploadChunk,
    });
    expect(result.resourceUrl).toBe('https://vault.example.test/pulsevault/upload/abc');
    expect(calls.filter((c) => c.init?.method === 'HEAD')).toHaveLength(2);
    expect(chunkCalls.map((c) => [c.offset, c.chunkBytes])).toEqual([
      [0, 10],
      [10, 10],
      [17, 10],
      [27, 3],
    ]);
  });

  it('retries a PATCH 409 (offset conflict) by re-HEADing and continuing from the server offset', async () => {
    const file = fakeFile(20);
    const { fetchImpl, calls } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [
        new Response(null, { status: 200, headers: { 'upload-offset': '0' } }),
        // The "failed" PATCH had actually landed its first 12 bytes.
        new Response(null, { status: 200, headers: { 'upload-offset': '12' } }),
      ],
    });
    const { uploadChunk, calls: chunkCalls } = createChunkStub([{ status: 409 }, chunkOk(20)]);

    await uploadViaTus({
      server: SERVER,
      token: null,
      artifactId: ARTIFACT_ID,
      filename: 'clip.mp4',
      kind: 'video',
      file: file as never,
      fetchImpl,
      uploadChunk,
    });

    expect(calls.filter((c) => c.init?.method === 'POST')).toHaveLength(1);
    expect(calls.filter((c) => c.init?.method === 'HEAD')).toHaveLength(2);
    expect(chunkCalls.map((c) => [c.offset, c.chunkBytes])).toEqual([
      [0, 20],
      [12, 8],
    ]);
  });

  it('treats a create 409 as terminal', async () => {
    const file = fakeFile(20);
    const { fetchImpl, calls } = createFetchStub({
      POST: [new Response(JSON.stringify({ error: 'Already exists' }), { status: 409 })],
    });
    const { uploadChunk } = createChunkStub([]);

    await expect(
      uploadViaTus({
        server: SERVER,
        token: null,
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        file: file as never,
        fetchImpl,
        uploadChunk,
      }),
    ).rejects.toMatchObject({ retryable: false, statusCode: 409 });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a number', 'abc'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['exponent', '1e1'],
    ['past the end of the file', '21'],
    ['beyond a safe integer', '9007199254740993'],
  ])('fails closed on a HEAD Upload-Offset that is %s, sending nothing', async (_, offset) => {
    const file = fakeFile(20);
    const { fetchImpl, calls } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [
        new Response(null, {
          status: 200,
          headers: offset === undefined ? {} : { 'upload-offset': offset },
        }),
      ],
    });
    const { uploadChunk, calls: chunkCalls } = createChunkStub([]);

    await expect(
      uploadViaTus({
        server: SERVER,
        token: null,
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        file: file as never,
        fetchImpl,
        uploadChunk,
      }),
    ).rejects.toMatchObject({ name: 'TusUploadError', retryable: false });
    expect(calls.filter((c) => c.init?.method === 'HEAD')).toHaveLength(1);
    expect(chunkCalls).toHaveLength(0);
  });

  it('never advances past the end of the file on a PATCH offset: re-HEADs, which fails closed', async () => {
    const file = fakeFile(20);
    const { fetchImpl, calls } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [
        new Response(null, { status: 200, headers: { 'upload-offset': '0' } }),
        new Response(null, { status: 200, headers: { 'upload-offset': '30' } }),
      ],
    });
    const { uploadChunk, calls: chunkCalls } = createChunkStub([chunkOk(30)]);

    await expect(
      uploadViaTus({
        server: SERVER,
        token: null,
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        file: file as never,
        fetchImpl,
        uploadChunk,
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(calls.filter((c) => c.init?.method === 'HEAD')).toHaveLength(2);
    expect(chunkCalls).toHaveLength(1);
  });

  it('does not retry a terminal (4xx) failure', async () => {
    const file = fakeFile(5);
    const { fetchImpl } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [new Response(null, { status: 200, headers: { 'upload-offset': '0' } })],
    });
    const { uploadChunk } = createChunkStub([{ status: 422 }]);

    await expect(
      uploadViaTus({
        server: SERVER,
        token: null,
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        file: file as never,
        fetchImpl,
        uploadChunk,
      }),
    ).rejects.toMatchObject({ retryable: false, statusCode: 422 });
  });

  it('includes relatedTo and checksum in Upload-Metadata when provided', async () => {
    const file = fakeFile(1);
    const { fetchImpl, calls } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [new Response(null, { status: 200, headers: { 'upload-offset': '1' } })],
    });
    const { uploadChunk } = createChunkStub([]);

    await uploadViaTus({
      server: SERVER,
      token: null,
      artifactId: ARTIFACT_ID,
      filename: 'clip.vtt',
      kind: 'captions',
      relatedTo: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      checksum: 'sha256:deadbeef',
      file: file as never,
      fetchImpl,
      uploadChunk,
    });

    const createCall = calls.find((c) => c.init?.method === 'POST');
    const metadata = (createCall?.init?.headers as Record<string, string>)['Upload-Metadata'];
    expect(metadata).toContain(`relatedTo ${btoa('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')}`);
    expect(metadata).toContain(`checksum ${btoa('sha256:deadbeef')}`);
  });

  it('includes an ASCII name in Upload-Metadata, and omits it when unset', async () => {
    const run = async (name?: string) => {
      const { fetchImpl, calls } = createFetchStub({
        POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
        HEAD: [new Response(null, { status: 200, headers: { 'upload-offset': '1' } })],
      });
      const { uploadChunk } = createChunkStub([]);
      await uploadViaTus({
        server: SERVER,
        token: null,
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        name,
        file: fakeFile(1) as never,
        fetchImpl,
        uploadChunk,
      });
      const createCall = calls.find((c) => c.init?.method === 'POST');
      return (createCall?.init?.headers as Record<string, string>)['Upload-Metadata'];
    };

    expect(await run('Morning rounds')).toContain(`name ${btoa('Morning rounds')}`);
    // Unset: no `name` key at all (so an un-renamed draft sends nothing). Check
    // comma-parts precisely — a plain `.toContain('name ')` would false-match
    // the `filename ` part.
    const hasNameKey = (md: string) => md.split(',').some((p) => p.trim().startsWith('name '));
    expect(hasNameKey(await run(undefined))).toBe(false);
  });

  it('encodes a non-ASCII name as UTF-8 base64 (btoa alone would corrupt it)', async () => {
    const title = 'Café ☕ 🎥';
    const { fetchImpl, calls } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [new Response(null, { status: 200, headers: { 'upload-offset': '1' } })],
    });
    const { uploadChunk } = createChunkStub([]);
    await uploadViaTus({
      server: SERVER,
      token: null,
      artifactId: ARTIFACT_ID,
      filename: 'clip.mp4',
      kind: 'video',
      name: title,
      file: fakeFile(1) as never,
      fetchImpl,
      uploadChunk,
    });
    const createCall = calls.find((c) => c.init?.method === 'POST');
    const metadata = (createCall?.init?.headers as Record<string, string>)['Upload-Metadata'];
    const namePart = metadata.split(',').find((p) => p.trim().startsWith('name '));
    if (!namePart) throw new Error('expected a `name` Upload-Metadata part');
    const b64 = namePart.trim().slice('name '.length);
    // The server decodes base64 as UTF-8; assert it recovers the exact title.
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(title);
  });

  it('omits the name (does not throw) when the title is a malformed surrogate', async () => {
    const { fetchImpl, calls } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [new Response(null, { status: 200, headers: { 'upload-offset': '1' } })],
    });
    const { uploadChunk } = createChunkStub([]);
    // A lone high surrogate (e.g. a title pasted truncated mid-emoji) would make
    // encodeURIComponent throw; the upload must still succeed, just without name.
    await expect(
      uploadViaTus({
        server: SERVER,
        token: null,
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        name: 'oops \uD83D',
        file: fakeFile(1) as never,
        fetchImpl,
        uploadChunk,
      }),
    ).resolves.toBeDefined();
    const createCall = calls.find((c) => c.init?.method === 'POST');
    const metadata = (createCall?.init?.headers as Record<string, string>)['Upload-Metadata'];
    expect(metadata.split(',').some((p) => p.trim().startsWith('name '))).toBe(false);
  });

  it('rejects a Location header that redirects to a different origin than the paired server', async () => {
    // A malicious or compromised paired server could otherwise redirect every
    // subsequent HEAD/PATCH/DELETE (each carrying the bearer capability
    // token) to an attacker-controlled host by returning an absolute
    // Location on a different origin.
    const file = fakeFile(5);
    const { fetchImpl } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: 'https://evil.example/collect' } })],
    });
    const { uploadChunk } = createChunkStub([]);

    await expect(
      uploadViaTus({
        server: SERVER,
        token: 'tok',
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        file: file as never,
        fetchImpl,
        uploadChunk,
      }),
    ).rejects.toBeInstanceOf(TusUploadError);
  });

  it('accepts a Location header that is same-origin but on a different path prefix', async () => {
    const file = fakeFile(5);
    const { fetchImpl } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/other-prefix/upload/abc' } })],
      HEAD: [new Response(null, { status: 200, headers: { 'upload-offset': '5' } })],
    });
    const { uploadChunk } = createChunkStub([]);

    const result = await uploadViaTus({
      server: SERVER,
      token: 'tok',
      artifactId: ARTIFACT_ID,
      filename: 'clip.mp4',
      kind: 'video',
      file: file as never,
      fetchImpl,
      uploadChunk,
    });
    expect(result.resourceUrl).toBe('https://vault.example.test/other-prefix/upload/abc');
  });

  describe('redirect handling', () => {
    // `resolveLocation` only validates the *application-level* `Location`
    // header returned in a 201 body from `createUpload`. Without `redirect:
    // 'manual'` on the follow-up HEAD/PATCH/DELETE requests, a real fetch
    // implementation would otherwise follow an actual HTTP 3xx there
    // transparently, resending the bearer token to whatever host a
    // compromised or MITM'd paired server names, before tus-client ever sees
    // a response to inspect. These assert that never happens.

    it('rejects rather than following a redirect target on the offset HEAD request', async () => {
      const file = fakeFile(20);
      const { fetchImpl, leaked } = createRedirectFollowingFetchStub(
        {
          POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
          HEAD: [{ to: 'https://evil.example/collect' }],
        },
        () => new Response(null, { status: 200, headers: { 'upload-offset': '20' } }),
      );
      const { uploadChunk } = createChunkStub([]);

      await expect(
        uploadViaTus({
          server: SERVER,
          token: 'tok',
          artifactId: ARTIFACT_ID,
          filename: 'clip.mp4',
          kind: 'video',
          file: file as never,
          fetchImpl,
          uploadChunk,
        }),
      ).rejects.toBeInstanceOf(TusUploadError);

      expect(leaked).toHaveLength(0);
    });

    it('rejects rather than following a redirect target on cancelTusUpload', async () => {
      const { fetchImpl, leaked } = createRedirectFollowingFetchStub(
        { DELETE: [{ to: 'https://evil.example/collect' }] },
        () => new Response(null, { status: 204 }),
      );

      await expect(cancelTusUpload(`${SERVER}/upload/abc`, 'tok', fetchImpl)).rejects.toBeInstanceOf(
        TusUploadError,
      );

      expect(leaked).toHaveLength(0);
    });
  });
});

describe('cancelTusUpload', () => {
  it('sends a DELETE with the bearer token', async () => {
    const { fetchImpl, calls } = createFetchStub({ DELETE: [new Response(null, { status: 204 })] });
    await cancelTusUpload(`${SERVER}/upload/abc`, 'tok', fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe('DELETE');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('treats an already-gone resource (404/410) as a successful cancel', async () => {
    for (const status of [404, 410]) {
      const { fetchImpl } = createFetchStub({ DELETE: [new Response(null, { status })] });
      await expect(cancelTusUpload(`${SERVER}/upload/abc`, 'tok', fetchImpl)).resolves.toBeUndefined();
    }
  });

  it('rejects when the server does not confirm the cancel (reservation may still be live)', async () => {
    const { fetchImpl } = createFetchStub({ DELETE: [new Response(null, { status: 500 })] });
    await expect(cancelTusUpload(`${SERVER}/upload/abc`, 'tok', fetchImpl)).rejects.toMatchObject({
      statusCode: 500,
      retryable: true,
    });
  });
});

describe('client identity and protocol checks (PROTOCOL.md §7.2)', () => {
  const created = () =>
    new Response(null, { status: 201, headers: { location: `${SERVER}/upload/abc` } });
  const headAt = (offset: number) =>
    new Response(null, { status: 200, headers: { 'upload-offset': String(offset) } });

  it('sends Pulse-Client on every request and appVersion in Upload-Metadata', async () => {
    setClientIdentity({ version: '2.1.0', build: '45', platform: 'ios' });
    const { fetchImpl, calls } = createFetchStub({ POST: [created()], HEAD: [headAt(0)] });
    const chunks = createChunkStub([chunkOk(8)]);
    await uploadViaTus({
      server: SERVER,
      token: 'tok',
      artifactId: ARTIFACT_ID,
      filename: 'draft.mp4',
      kind: 'video',
      file: fakeFile(8) as never,
      fetchImpl,
      uploadChunk: chunks.uploadChunk,
    });
    const expected = 'Pulse/2.1.0 (45; ios); protocol=1-2';
    for (const call of calls) {
      expect((call.init?.headers as Record<string, string>)['Pulse-Client']).toBe(expected);
    }
    expect(chunks.calls[0]?.headers['Pulse-Client']).toBe(expected);
    const metadata = (calls[0]?.init?.headers as Record<string, string>)['Upload-Metadata'];
    const appVersion = metadata
      .split(',')
      .find((pair) => pair.startsWith('appVersion '))
      ?.split(' ')[1];
    expect(appVersion && Buffer.from(appVersion, 'base64').toString('utf8')).toBe('2.1.0 (45)');
  });

  it('turns 426 Upgrade Required into a terminal "update Pulse" error, without retrying', async () => {
    const body = JSON.stringify({
      error: 'This server needs a client that speaks upload protocol 3.',
      minSupportedVersion: 3,
      maxSupportedVersion: 3,
    });
    const { fetchImpl, calls } = createFetchStub({
      POST: [new Response(body, { status: 426, headers: JSON_HEADERS })],
    });
    const failure = await uploadViaTus({
      server: SERVER,
      token: null,
      artifactId: ARTIFACT_ID,
      filename: 'draft.mp4',
      kind: 'video',
      file: fakeFile(8) as never,
      fetchImpl,
      uploadChunk: createChunkStub([]).uploadChunk,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TusUploadError);
    expect((failure as TusUploadError).retryable).toBe(false);
    expect((failure as TusUploadError).statusCode).toBe(426);
    expect((failure as TusUploadError).message).toBe(
      'This server needs a newer version of Pulse. Update the app and try again.',
    );
    expect(calls).toHaveLength(1);
  });

  it('treats a 426 on a PATCH the same way', async () => {
    const { fetchImpl } = createFetchStub({ POST: [created()], HEAD: [headAt(0)] });
    const failure = await uploadViaTus({
      server: SERVER,
      token: null,
      artifactId: ARTIFACT_ID,
      filename: 'draft.mp4',
      kind: 'video',
      file: fakeFile(8) as never,
      fetchImpl,
      uploadChunk: createChunkStub([{ status: 426 }]).uploadChunk,
    }).catch((e: unknown) => e);
    expect((failure as TusUploadError).retryable).toBe(false);
    expect((failure as TusUploadError).statusCode).toBe(426);
  });
});
