/**
 * Cross-repo integration suite: the app's REAL tus-client driven over real
 * HTTP against the REAL pulsevault server built from the submodule — the one
 * seam both repos depend on, exercised end to end (create → PATCH → validate
 * → serve, kill/resume, the 409 self-heal, checksum rejection, cancel).
 *
 * Opt-in like the ffmpeg e2e suite (abort/resume scenarios wait out real tus
 * lock releases, ~20 s total): `PULSE_INTEGRATION=1 npx jest pv-integration`.
 * Also requires the submodule built (`cd pulsevault-mieweb && npm ci && npm
 * run build`); self-skips with a warning otherwise so plain runs stay green.
 *
 * The byte-carrying PATCH is a plain fetch here (Node can send raw bodies;
 * the native URLSession/OkHttp task exists for React Native's benefit), so
 * every request on the wire is byte-identical to production traffic.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  cancelTusUpload,
  deriveUploadResourceUrl,
  uploadViaTus,
  type UploadChunk,
} from './tus-client';
import { uploadViaDirect, type UploadFile } from './direct-client';

const ROOT = path.resolve(__dirname, '../../..');
const DIST = path.join(ROOT, 'pulsevault-mieweb/dist/core.js');
const SERVER_SCRIPT = path.join(ROOT, 'scripts/pv-test-server.mjs');
const ENABLED = process.env.PULSE_INTEGRATION === '1';
const HAVE_DIST = existsSync(DIST);

/** Minimal MP4-family header (ftyp box) so the server's sniffer accepts uploads. */
function makeMp4(size: number): Buffer {
  const header = Buffer.from([
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  ]);
  const body = Buffer.alloc(size);
  header.copy(body, 0);
  for (let i = header.length; i < size; i++) body[i] = i & 0xff;
  return body;
}

const md5 = (buf: Buffer) => `md5:${createHash('md5').update(buf).digest('hex')}`;

/** Real-wire UploadChunk: PATCHes the byte range with fetch, exactly like production headers. */
function bufferChunkUploader(bytes: Buffer): UploadChunk {
  return async ({ resourceUrl, offset, chunkBytes, headers, signal, onProgress }) => {
    const body = bytes.subarray(offset, offset + chunkBytes);
    const res = await fetch(resourceUrl, {
      method: 'PATCH',
      redirect: 'manual',
      signal,
      headers,
      // Node's fetch accepts Uint8Array bodies; the app's RN-flavored BodyInit
      // typings just don't know that in this node-only suite.
      body: body as unknown as BodyInit,
    });
    onProgress?.(body.length);
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      outHeaders[k] = v;
    });
    await res.arrayBuffer().catch(() => undefined);
    return { status: res.status, headers: outHeaders };
  };
}

const describeIf = ENABLED && HAVE_DIST ? describe : describe.skip;
if (ENABLED && !HAVE_DIST) {
  console.warn(
    'pv-integration: pulsevault-mieweb/dist not built — skipping. Run `cd pulsevault-mieweb && npm ci && npm run build`.',
  );
}

/** Spawn scripts/pv-test-server.mjs with the given env; resolves to its base URL. */
async function spawnServer(env: Record<string, string>): Promise<{
  child: ChildProcess;
  server: string;
}> {
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pv-test-server did not start')), 10_000);
    let buffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/PV_PORT=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on('exit', (code) => reject(new Error(`pv-test-server exited early (${code})`)));
  });
  return { child, server: `http://127.0.0.1:${port}/pulsevault` };
}

async function stopServer(child: ChildProcess): Promise<void> {
  child.stdin?.end();
  await new Promise((resolve) => {
    child.on('exit', resolve);
    setTimeout(() => {
      child.kill('SIGTERM');
      resolve(undefined);
    }, 2000);
  });
}

describeIf('pulsevault integration (real server, real wire)', () => {
  jest.setTimeout(30_000);
  let child: ChildProcess;
  let server: string;

  beforeAll(async () => {
    ({ child, server } = await spawnServer({}));
  });

  afterAll(async () => {
    await stopServer(child);
  });

  const upload = (
    bytes: Buffer,
    artifactId: string,
    extra?: Partial<Parameters<typeof uploadViaTus>[0]>,
  ) =>
    uploadViaTus({
      server,
      token: null,
      artifactId,
      filename: 'clip.mp4',
      kind: 'video',
      checksum: md5(bytes),
      file: { size: bytes.length } as never,
      uploadChunk: bufferChunkUploader(bytes),
      ...extra,
    });

  it('uploads end to end and the served bytes are identical', async () => {
    const bytes = makeMp4(64 * 1024);
    const artifactId = randomUUID();
    const result = await upload(bytes, artifactId);
    expect(result.resourceUrl).toContain(`${server}/upload/`);

    const res = await fetch(`${server}/artifacts/${artifactId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    const served = Buffer.from(await res.arrayBuffer());
    expect(Buffer.compare(served, bytes)).toBe(0);
  });

  it('resumes from the durable offset after an interrupted transfer (kill/resume)', async () => {
    const bytes = makeMp4(96 * 1024);
    const artifactId = randomUUID();

    // First attempt: bounded chunks, aborted after the first chunk lands —
    // the "app killed mid-upload" shape. The resource URL was persisted (the
    // onResourceCreated contract), the bytes were partially durable.
    const controller = new AbortController();
    let persistedUrl: string | null = null;
    let chunksSent = 0;
    const abortingChunker: UploadChunk = async (params) => {
      const result = await bufferChunkUploader(bytes)(params);
      chunksSent += 1;
      if (chunksSent === 1) controller.abort();
      return result;
    };
    await expect(
      upload(bytes, artifactId, {
        chunkSizeBytes: 32 * 1024,
        signal: controller.signal,
        uploadChunk: abortingChunker,
        onResourceCreated: (url) => {
          persistedUrl = url;
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(persistedUrl).not.toBeNull();

    // Not served while incomplete.
    const early = await fetch(`${server}/artifacts/${artifactId}`);
    expect(early.status).toBe(404);

    // Relaunch shape: resume from the persisted URL; HEAD gives the durable
    // offset (32 KiB) and only the remainder moves.
    const offsets: number[] = [];
    const resumeChunker: UploadChunk = async (params) => {
      offsets.push(params.offset);
      return bufferChunkUploader(bytes)(params);
    };
    await upload(bytes, artifactId, {
      resourceUrl: persistedUrl,
      uploadChunk: resumeChunker,
    });
    expect(offsets[0]).toBe(32 * 1024);

    const res = await fetch(`${server}/artifacts/${artifactId}`);
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), bytes)).toBe(0);
  });

  it('self-heals a 409 create conflict end to end (lost-handle recovery)', async () => {
    const bytes = makeMp4(48 * 1024);
    const artifactId = randomUUID();

    // Simulate the kill window: a create succeeded server-side but the client
    // never persisted the Location. 16 KiB landed before the "kill".
    const first = await upload(bytes, artifactId, {
      chunkSizeBytes: 16 * 1024,
      uploadChunk: (() => {
        const inner = bufferChunkUploader(bytes);
        let sent = 0;
        const chunker: UploadChunk = async (params) => {
          const result = await inner(params);
          sent += 1;
          if (sent === 1) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
          return result;
        };
        return chunker;
      })(),
    }).catch((err) => err);
    expect((first as Error).name).toBe('AbortError');

    // Fresh run with NO resourceUrl — exactly what a relaunched app does when
    // the persist never happened. POST 409s; the client derives the resource
    // URL, HEADs the durable offset, and finishes the upload.
    const derived = deriveUploadResourceUrl(server, 'video', artifactId, 'clip.mp4');
    const offsets: number[] = [];
    const result = await upload(bytes, artifactId, {
      uploadChunk: (() => {
        const inner = bufferChunkUploader(bytes);
        const chunker: UploadChunk = async (params) => {
          offsets.push(params.offset);
          return inner(params);
        };
        return chunker;
      })(),
    });
    expect(result.resourceUrl).toBe(derived);
    expect(offsets[0]).toBe(16 * 1024);

    const res = await fetch(`${server}/artifacts/${artifactId}`);
    expect(res.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), bytes)).toBe(0);
  });

  it('rejects a checksum mismatch terminally, wipes the artifact, and allows a corrected retry', async () => {
    const bytes = makeMp4(32 * 1024);
    const artifactId = randomUUID();

    await expect(
      upload(bytes, artifactId, { checksum: `md5:${'0'.repeat(32)}` }),
    ).rejects.toMatchObject({ retryable: false, statusCode: 422 });

    // Fail-closed cleanup freed the artifactId — the corrected retry works.
    await upload(bytes, artifactId);
    const res = await fetch(`${server}/artifacts/${artifactId}`);
    expect(res.status).toBe(200);
  });

  it('cancel (tus DELETE) frees the reservation so the artifactId is immediately reusable', async () => {
    const bytes = makeMp4(64 * 1024);
    const artifactId = randomUUID();

    const controller = new AbortController();
    let persistedUrl: string | null = null;
    let sent = 0;
    await upload(bytes, artifactId, {
      chunkSizeBytes: 32 * 1024,
      signal: controller.signal,
      onResourceCreated: (url) => {
        persistedUrl = url;
      },
      uploadChunk: (() => {
        const inner = bufferChunkUploader(bytes);
        const chunker: UploadChunk = async (params) => {
          const result = await inner(params);
          sent += 1;
          if (sent === 1) controller.abort();
          return result;
        };
        return chunker;
      })(),
    }).catch(() => undefined);

    await cancelTusUpload(persistedUrl!, null);

    // Termination swept the server-side reservation (bytes + sidecar) — a
    // fresh create under the same artifactId succeeds without waiting out
    // any grace period.
    await upload(bytes, artifactId);
    const res = await fetch(`${server}/artifacts/${artifactId}`);
    expect(res.status).toBe(200);
  });

  it('capabilities probe: version-compatible, no direct upload on local storage', async () => {
    const res = await fetch(`${server}/capabilities`);
    expect(res.status).toBe(200);
    const caps = (await res.json()) as Record<string, unknown>;
    expect(caps.protocolVersion).toBe(1);
    expect(caps.directUpload).toBeUndefined();
  });
});

describeIf('pulsevault integration — direct-upload profile (real server, mock S3 data plane)', () => {
  jest.setTimeout(30_000);
  let child: ChildProcess;
  let server: string;

  beforeAll(async () => {
    ({ child, server } = await spawnServer({ PV_STORAGE: 's3-mock' }));
  });

  afterAll(async () => {
    await stopServer(child);
  });

  /** Real-wire UploadFile: PUTs the whole payload to the presigned URL with the grant's headers verbatim. */
  const bufferFileUploader =
    (bytes: Buffer, calls?: { puts: number }): UploadFile =>
    async ({ uploadUrl, headers, signal, onProgress }) => {
      if (calls) calls.puts += 1;
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers,
        signal,
        body: bytes as unknown as BodyInit,
      });
      await res.arrayBuffer().catch(() => undefined);
      onProgress?.(bytes.length);
      return { status: res.status };
    };

  const uploadDirect = (
    bytes: Buffer,
    artifactId: string,
    extra?: Partial<Parameters<typeof uploadViaDirect>[0]>,
  ) =>
    uploadViaDirect({
      server,
      token: null,
      artifactId,
      filename: 'clip.mp4',
      kind: 'video',
      checksum: md5(bytes),
      file: { size: bytes.length } as never,
      uploadFile: bufferFileUploader(bytes),
      ...extra,
    });

  it('advertises the profile and uploads grant → PUT → complete end to end', async () => {
    const caps = (await (await fetch(`${server}/capabilities`)).json()) as Record<string, unknown>;
    expect(caps.directUpload).toEqual({ enabled: true });

    const bytes = makeMp4(64 * 1024);
    const artifactId = randomUUID();
    let persistedUrl: string | null = null;
    const result = await uploadDirect(bytes, artifactId, {
      onResourceCreated: (url) => {
        persistedUrl = url;
      },
    });
    // The durable handle is the artifacts URL — cancel/invalidate DELETEs it.
    expect(persistedUrl).toBe(`${server}/artifacts/${artifactId}`);
    expect(result.resourceUrl).toBe(persistedUrl);

    // Served bytes are identical (mock-S3 presigned redirect followed by fetch).
    const res = await fetch(`${server}/artifacts/${artifactId}`);
    expect(res.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), bytes)).toBe(0);
  });

  it('recovers a rejected PUT with a fresh grant on the next cycle (re-grant, §9.1)', async () => {
    const bytes = makeMp4(48 * 1024);
    const artifactId = randomUUID();
    const grantedUrls: string[] = [];
    let attempts = 0;
    const flakyOnce: UploadFile = async (params) => {
      grantedUrls.push(params.uploadUrl);
      attempts += 1;
      // First PUT dies mid-transport — the native task rejects, it does not
      // return a status. The client must fetch a FRESH grant and re-PUT.
      if (attempts === 1) throw new Error('network dropped mid-PUT');
      return bufferFileUploader(bytes)(params);
    };
    await uploadDirect(bytes, artifactId, { uploadFile: flakyOnce });
    expect(attempts).toBe(2);
    // Both grants target the same reservation, re-signed per cycle.
    expect(grantedUrls).toHaveLength(2);

    const res = await fetch(`${server}/artifacts/${artifactId}`);
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), bytes)).toBe(0);
  });

  it('adopts an already-completed upload on retry without re-sending bytes', async () => {
    const bytes = makeMp4(32 * 1024);
    const artifactId = randomUUID();
    await uploadDirect(bytes, artifactId);

    // Retry after a client-side failure that lost the completion: the grant
    // 409s (artifact is ready), the artifacts URL serves → adopt as done.
    const calls = { puts: 0 };
    const result = await uploadDirect(bytes, artifactId, {
      uploadFile: bufferFileUploader(bytes, calls),
    });
    expect(result.resourceUrl).toBe(`${server}/artifacts/${artifactId}`);
    expect(calls.puts).toBe(0);
  });

  it('cancel (DELETE on the artifacts URL) frees the reservation for a fresh create', async () => {
    const bytes = makeMp4(32 * 1024);
    const artifactId = randomUUID();
    const result = await uploadDirect(bytes, artifactId);

    await cancelTusUpload(result.resourceUrl, null);
    const gone = await fetch(`${server}/artifacts/${artifactId}`);
    expect(gone.status).toBe(404);

    // The artifactId is immediately reusable — and serves the new bytes.
    const fresh = makeMp4(32 * 1024);
    fresh.fill(0xcd, 64);
    await uploadDirect(fresh, artifactId, { checksum: md5(fresh) });
    const res = await fetch(`${server}/artifacts/${artifactId}`);
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), fresh)).toBe(0);
  });
});
