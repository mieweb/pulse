import { describe, expect, it, jest } from '@jest/globals';

import { uploadViaDirect, type UploadFile } from './direct-client';

const SERVER = 'https://vault.example.test/pulsevault';
const ARTIFACT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ARTIFACTS_URL = `${SERVER}/artifacts/${ARTIFACT_ID}`;
const GRANT_URL = 'https://bucket.example.test/video/aaa.mp4?X-Amz-Signature=abc';

function fakeFile(size: number) {
  return { size };
}

type FetchCall = { url: string; init?: RequestInit };

function createFetchStub(responses: Response[]) {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`No stubbed response for ${init?.method} ${url}`);
    return next;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const grantResponse = (status = 201) =>
  new Response(
    JSON.stringify({
      ok: true,
      artifactId: ARTIFACT_ID,
      uploadUrl: GRANT_URL,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': '20' },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );

const completeOk = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const jsonError = (status: number, error: string) =>
  new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function createUploadFileStub(results: { status: number; ticks?: number[] }[]) {
  const calls: { uploadUrl: string; headers: Record<string, string> }[] = [];
  const queue = [...results];
  const uploadFile: UploadFile = async ({ uploadUrl, headers, onProgress }) => {
    calls.push({ uploadUrl, headers });
    const next = queue.shift();
    if (!next) throw new Error('No stubbed uploadFile result');
    for (const tick of next.ticks ?? []) onProgress?.(tick);
    return { status: next.status };
  };
  return { uploadFile, calls };
}

describe('uploadViaDirect', () => {
  it('surfaces a grant 409 as terminal, with no recovery probes (single-shot identity)', async () => {
    const { fetchImpl, calls } = createFetchStub([
      jsonError(409, `artifactId ${ARTIFACT_ID} already has an upload`),
    ]);
    const { uploadFile, calls: putCalls } = createUploadFileStub([]);

    await expect(
      uploadViaDirect({
        server: SERVER,
        token: 'tok',
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        file: fakeFile(20) as never,
        fetchImpl,
        uploadFile,
      }),
    ).rejects.toMatchObject({ retryable: false, statusCode: 409 });
    // One grant POST, no artifacts-URL probe, no bytes — the pairing is spent.
    expect(calls).toHaveLength(1);
    expect(putCalls).toHaveLength(0);
  });

  it('grant → PUT → complete; persists the artifact URL before any byte moves', async () => {
    const { fetchImpl, calls } = createFetchStub([grantResponse(201), completeOk()]);
    let persisted: string | null = null;
    let persistedBeforePut = false;
    const { uploadFile, calls: putCalls } = createUploadFileStub([
      { status: 200, ticks: [10, 20] },
    ]);
    const progress: number[] = [];

    const result = await uploadViaDirect({
      server: SERVER,
      token: 'tok',
      artifactId: ARTIFACT_ID,
      filename: 'clip.mp4',
      kind: 'video',
      file: fakeFile(20) as never,
      onResourceCreated: async (url) => {
        await new Promise((r) => setTimeout(r, 5));
        persisted = url;
      },
      onProgress: ({ bytesSent }) => progress.push(bytesSent),
      fetchImpl,
      uploadFile: async (params) => {
        persistedBeforePut = persisted !== null;
        return uploadFile(params);
      },
    });

    expect(result.resourceUrl).toBe(ARTIFACTS_URL);
    expect(persisted).toBe(ARTIFACTS_URL);
    expect(persistedBeforePut).toBe(true);
    expect(putCalls[0].uploadUrl).toBe(GRANT_URL);
    expect(putCalls[0].headers['Content-Type']).toBe('video/mp4');
    expect(progress[progress.length - 1]).toBe(20);
    // create carries the bearer token; the PUT itself must NOT (the URL is the credential).
    const createCall = calls[0];
    expect((createCall.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const bodySent = JSON.parse(String(createCall.init?.body));
    expect(bodySent).toMatchObject({ artifactId: ARTIFACT_ID, filename: 'clip.mp4', size: 20 });
  });

  it('accepts a 200 re-grant (resume of an incomplete reservation)', async () => {
    const { fetchImpl } = createFetchStub([grantResponse(200), completeOk()]);
    const { uploadFile } = createUploadFileStub([{ status: 200 }]);
    await expect(
      uploadViaDirect({
        server: SERVER,
        token: 'tok',
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        file: fakeFile(20) as never,
        fetchImpl,
        uploadFile,
      }),
    ).resolves.toEqual({ resourceUrl: ARTIFACTS_URL });
  });

  it('re-grants and re-PUTs once when the PUT fails (expired grant), then completes', async () => {
    const { fetchImpl } = createFetchStub([grantResponse(201), grantResponse(200), completeOk()]);
    const { uploadFile, calls: putCalls } = createUploadFileStub([
      { status: 403 }, // storage rejects the stale signature
      { status: 200 },
    ]);
    const result = await uploadViaDirect({
      server: SERVER,
      token: 'tok',
      artifactId: ARTIFACT_ID,
      filename: 'clip.mp4',
      kind: 'video',
      file: fakeFile(20) as never,
      fetchImpl,
      uploadFile,
    });
    expect(result.resourceUrl).toBe(ARTIFACTS_URL);
    expect(putCalls).toHaveLength(2);
  });

  it('re-cycles when complete reports the object missing (409), then succeeds', async () => {
    const { fetchImpl } = createFetchStub([
      grantResponse(201),
      jsonError(409, 'No uploaded object found'),
      grantResponse(200),
      completeOk(),
    ]);
    const { uploadFile, calls: putCalls } = createUploadFileStub([
      { status: 200 },
      { status: 200 },
    ]);
    await expect(
      uploadViaDirect({
        server: SERVER,
        token: 'tok',
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        file: fakeFile(20) as never,
        fetchImpl,
        uploadFile,
      }),
    ).resolves.toEqual({ resourceUrl: ARTIFACTS_URL });
    expect(putCalls).toHaveLength(2);
  });

  it('gives up after the grant-cycle budget with a retryable error', async () => {
    const { fetchImpl } = createFetchStub([grantResponse(201), grantResponse(200)]);
    const { uploadFile } = createUploadFileStub([{ status: 403 }, { status: 403 }]);
    await expect(
      uploadViaDirect({
        server: SERVER,
        token: 'tok',
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        file: fakeFile(20) as never,
        fetchImpl,
        uploadFile,
      }),
    ).rejects.toMatchObject({ retryable: true, statusCode: 403 });
  });

  it('surfaces a terminal error for a 4xx grant (e.g. 401 missing token) without PUTting', async () => {
    const { fetchImpl } = createFetchStub([jsonError(401, 'Missing capability token')]);
    const { uploadFile, calls: putCalls } = createUploadFileStub([]);
    await expect(
      uploadViaDirect({
        server: SERVER,
        token: null,
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        file: fakeFile(20) as never,
        fetchImpl,
        uploadFile,
      }),
    ).rejects.toMatchObject({ retryable: false, statusCode: 401 });
    expect(putCalls).toHaveLength(0);
  });

  it('treats a 422 complete (validation failure) as terminal', async () => {
    const { fetchImpl } = createFetchStub([
      grantResponse(201),
      jsonError(422, 'Uploaded bytes are not a valid MP4 (missing ftyp header)'),
    ]);
    const { uploadFile } = createUploadFileStub([{ status: 200 }]);
    await expect(
      uploadViaDirect({
        server: SERVER,
        token: 'tok',
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        file: fakeFile(20) as never,
        fetchImpl,
        uploadFile,
      }),
    ).rejects.toMatchObject({ retryable: false, statusCode: 422 });
  });

  it('never follows a redirect on the grant request (token-bearing)', async () => {
    const { fetchImpl } = createFetchStub([
      new Response(null, { status: 307, headers: { location: 'https://evil.example/collect' } }),
    ]);
    const { uploadFile, calls: putCalls } = createUploadFileStub([]);
    await expect(
      uploadViaDirect({
        server: SERVER,
        token: 'tok',
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        file: fakeFile(20) as never,
        fetchImpl,
        uploadFile,
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(putCalls).toHaveLength(0);
  });

  it('recovers a REJECTED PUT with a fresh grant on the next cycle', async () => {
    // The native task rejects on transport failures (network drop, TLS reset) —
    // it does not return a status. That rejection must feed the same fresh-grant
    // recovery as a non-2xx status, not escape the cycle loop.
    const { fetchImpl, calls } = createFetchStub([
      grantResponse(201),
      grantResponse(200), // §9.1 re-grant for the same reservation
      completeOk(),
    ]);
    let attempts = 0;
    const uploadFile: UploadFile = async ({ onProgress }) => {
      attempts += 1;
      if (attempts === 1) throw new Error('network dropped mid-PUT');
      onProgress?.(20);
      return { status: 200 };
    };

    const result = await uploadViaDirect({
      server: SERVER,
      token: 'tok',
      artifactId: ARTIFACT_ID,
      filename: 'clip.mp4',
      kind: 'video',
      file: fakeFile(20) as never,
      fetchImpl,
      uploadFile,
    });

    expect(result.resourceUrl).toBe(ARTIFACTS_URL);
    expect(attempts).toBe(2);
    // Two grant POSTs (fresh + re-grant), one complete.
    expect(calls.filter((c) => c.url.endsWith('/direct-uploads'))).toHaveLength(2);
  });

  it('surfaces a retryable error when the PUT rejects on the final cycle', async () => {
    const { fetchImpl } = createFetchStub([grantResponse(201), grantResponse(200)]);
    const uploadFile: UploadFile = async () => {
      throw new Error('network dropped mid-PUT');
    };

    await expect(
      uploadViaDirect({
        server: SERVER,
        token: 'tok',
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        file: fakeFile(20) as never,
        fetchImpl,
        uploadFile,
      }),
    ).rejects.toMatchObject({ retryable: true, message: expect.stringContaining('network dropped') });
  });

  it('lets an aborted PUT escape unchanged (no extra grant cycle)', async () => {
    const { fetchImpl, calls } = createFetchStub([grantResponse(201)]);
    const uploadFile: UploadFile = async () => {
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    };

    await expect(
      uploadViaDirect({
        server: SERVER,
        token: 'tok',
        artifactId: ARTIFACT_ID,
        filename: 'clip.mp4',
        kind: 'video',
        file: fakeFile(20) as never,
        fetchImpl,
        uploadFile,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.filter((c) => c.url.endsWith('/direct-uploads'))).toHaveLength(1);
  });
});
