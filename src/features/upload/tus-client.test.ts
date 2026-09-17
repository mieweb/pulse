import { describe, expect, it, jest } from '@jest/globals';

import { cancelTusUpload, TusUploadError, type UploadChunk, uploadViaTus } from './tus-client';

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
    leaked.push({
      url: next.to,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    });
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

  it('surfaces a mid-run 404 as terminal (no recreate — the URL came from this run)', async () => {
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

  it('re-anchors on a PATCH 409 offset conflict: re-HEADs and resumes from the server offset', async () => {
    const file = fakeFile(30);
    const { fetchImpl, calls } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [
        new Response(null, { status: 200, headers: { 'upload-offset': '0' } }),
        // The "conflicting" first chunk actually landed — the server is at 10.
        new Response(null, { status: 200, headers: { 'upload-offset': '10' } }),
      ],
    });
    const { uploadChunk, calls: chunkCalls } = createChunkStub([
      { status: 409, headers: JSON_HEADERS },
      chunkOk(20),
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
    // First attempt 409s at offset 0; the retry re-HEADs (10) and never resends bytes 0–9.
    expect(chunkCalls.map((c) => c.offset)).toEqual([0, 10, 20]);
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
        POST: [
          new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } }),
        ],
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
      POST: [
        new Response(null, { status: 201, headers: { location: 'https://evil.example/collect' } }),
      ],
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
      POST: [
        new Response(null, { status: 201, headers: { location: '/other-prefix/upload/abc' } }),
      ],
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

  // Single-shot identities: a create 409 means this artifactId was already
  // used (the link is spent). There is no derive/resume/adopt recovery — the
  // manager burns the pairing and the user scans a fresh link.
  it('surfaces a create 409 as terminal, with no recovery probes', async () => {
    const file = fakeFile(20);
    const { fetchImpl, calls } = createFetchStub({
      POST: [
        new Response(JSON.stringify({ ok: false, error: 'already has an upload' }), {
          status: 409,
          headers: JSON_HEADERS,
        }),
      ],
    });
    const { uploadChunk, calls: chunkCalls } = createChunkStub([]);

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
    ).rejects.toMatchObject({ retryable: false, statusCode: 409 });
    // No derived-URL HEAD, no artifacts-URL probe, no bytes — one POST, done.
    expect(calls).toHaveLength(1);
    expect(chunkCalls).toHaveLength(0);
  });

  it('fails closed when the server reports more bytes than the local file has', async () => {
    // An offset past the local file is not this file's upload — satisfying the
    // transfer loop with it would report success without sending a byte.
    const file = fakeFile(10);
    const { fetchImpl } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [new Response(null, { status: 200, headers: { 'upload-offset': '99' } })],
    });
    const { uploadChunk, calls } = createChunkStub([]);

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
    ).rejects.toMatchObject({ retryable: false });
    expect(calls).toHaveLength(0);
  });

  it('awaits onResourceCreated before the first byte moves', async () => {
    // The callback persists resume state; a byte moving before that persist is durable
    // reopens the kill-window the whole mechanism exists to close.
    const file = fakeFile(10);
    const { fetchImpl } = createFetchStub({
      POST: [new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } })],
      HEAD: [new Response(null, { status: 200, headers: { 'upload-offset': '0' } })],
    });
    let persisted = false;
    let persistedBeforeFirstChunk = false;
    const uploadChunk: UploadChunk = async ({ offset }) => {
      if (offset === 0) persistedBeforeFirstChunk = persisted;
      return { status: 204, headers: { 'Upload-Offset': '10' } };
    };

    await uploadViaTus({
      server: SERVER,
      token: 'tok',
      artifactId: ARTIFACT_ID,
      filename: 'clip.mp4',
      kind: 'video',
      file: file as never,
      onResourceCreated: async () => {
        // Resolve on a later tick so a fire-and-forget caller would observe false.
        await new Promise((r) => setTimeout(r, 10));
        persisted = true;
      },
      fetchImpl,
      uploadChunk,
    });

    expect(persistedBeforeFirstChunk).toBe(true);
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
          POST: [
            new Response(null, { status: 201, headers: { location: '/pulsevault/upload/abc' } }),
          ],
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

      await expect(
        cancelTusUpload(`${SERVER}/upload/abc`, 'tok', fetchImpl),
      ).rejects.toBeInstanceOf(TusUploadError);

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
      await expect(
        cancelTusUpload(`${SERVER}/upload/abc`, 'tok', fetchImpl),
      ).resolves.toBeUndefined();
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
