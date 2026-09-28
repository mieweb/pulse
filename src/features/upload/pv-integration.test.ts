/**
 * Cross-repo integration suite: the app's REAL pairing and upload code, over real HTTP, against
 * the REAL pulsevault server built from the pinned submodule (scripts/pv-test-server.mjs). This
 * is the contract both repos depend on: a pairing link the server mints must parse in the app,
 * the server's /capabilities must pass the app's check, and a pulse must upload and come back
 * byte for byte.
 *
 * Opt-in: `PULSE_INTEGRATION=1 npx jest pv-integration`. Needs the submodule built
 * (`cd pulsevault-mieweb && npm ci && npm run build`); self-skips with a warning otherwise so
 * plain runs stay green. `PV_CORE=<path to core.js>` runs it against another pulsevault build
 * instead, e.g. the latest npm release (CI does both).
 *
 * The byte-carrying PATCH is a plain fetch here (Node can send raw bodies; the native
 * URLSession/OkHttp task exists for React Native's benefit), so every request on the wire is
 * byte-identical to production traffic.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { checkCapabilities } from './capabilities';
import { setClientIdentity } from './client-identity';
import { parseUploadDeepLink, type UploadDeepLink } from './deep-link';
import { TusUploadError, uploadViaTus, type ArtifactKind, type UploadChunk } from './tus-client';
import { requestViewLink } from './view-link';

const ROOT = path.resolve(__dirname, '../../..');
const DIST = process.env.PV_CORE
  ? path.resolve(process.env.PV_CORE)
  : path.join(ROOT, 'pulsevault-mieweb/dist/core.js');
const SERVER_SCRIPT = path.join(ROOT, 'scripts/pv-test-server.mjs');
const ENABLED = process.env.PULSE_INTEGRATION === '1';
const HAVE_DIST = existsSync(DIST);

/**
 * The server build's spec revision (`pulseProtocol.version` in its package.json, which is where
 * the server reads it too), known up front so tests of newer protocol features are reported as
 * skipped against an older server rather than passing without running. Releases from before the
 * field speak 1.0.
 */
function serverRevision(): [major: number, minor: number] {
  try {
    const pkg = JSON.parse(readFileSync(path.join(path.dirname(DIST), '../package.json'), 'utf8'));
    const [major, minor] = String(pkg.pulseProtocol?.version ?? '1.0')
      .split('.')
      .map(Number);
    return [major, minor];
  } catch {
    return [1, 0];
  }
}
const [SERVER_MAJOR, SERVER_MINOR] = serverRevision();

/** `it` if the server speaks protocol `major.minor` or later, else `it.skip`. */
const itSince = (major: number, minor: number) =>
  SERVER_MAJOR > major || (SERVER_MAJOR === major && SERVER_MINOR >= minor) ? it : it.skip;

/** Minimal MP4-family header (ftyp box) so the server's sniffer accepts the video. */
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
    `pv-integration: ${DIST} not found — skipping. Run \`cd pulsevault-mieweb && npm ci && npm run build\`.`,
  );
}

/** Spawn scripts/pv-test-server.mjs; resolves to its origin once it prints its port. */
async function spawnServer(): Promise<{ child: ChildProcess; origin: string }> {
  const child = spawn(process.execPath, [SERVER_SCRIPT], { stdio: ['pipe', 'pipe', 'inherit'] });
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
  return { child, origin: `http://127.0.0.1:${port}` };
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
  let origin: string;

  beforeAll(async () => {
    ({ child, origin } = await spawnServer());
    // As the app does at startup: every request says which build this is (Pulse-Client) and
    // every upload records it (appVersion).
    setClientIdentity({ version: '2.1.0', build: '45', platform: 'ios' });
  });

  afterAll(async () => {
    await stopServer(child);
  });

  /** Pair like a device does: the server mints a link, the app parses it. */
  async function pair(): Promise<UploadDeepLink> {
    const { link } = (await (await fetch(`${origin}/pair`)).json()) as { link: string };
    const parsed = parseUploadDeepLink(link);
    if (!parsed.ok) throw new Error(`pairing link rejected: ${parsed.reason}`);
    return parsed.link;
  }

  const upload = (
    link: UploadDeepLink,
    bytes: Buffer,
    artifact: { artifactId: string; filename: string; kind: ArtifactKind; relatedTo?: string },
    token: string | null = link.token,
  ) =>
    uploadViaTus({
      server: link.server,
      token,
      ...artifact,
      checksum: md5(bytes),
      file: { size: bytes.length } as never,
      uploadChunk: bufferChunkUploader(bytes),
    });

  const download = async (link: UploadDeepLink, artifactId: string) => {
    const res = await fetch(`${link.server}/artifacts/${artifactId}`, {
      headers: { Authorization: `Bearer ${link.token}` },
    });
    return { res, bytes: Buffer.from(await res.arrayBuffer()) };
  };

  it("pairs: the server's link parses in the app and its /capabilities passes the app's check", async () => {
    const link = await pair();
    expect(link.server).toBe(`${origin}/pulsevault`);
    expect(link.token).toBeTruthy();

    const caps = await checkCapabilities(link.server);
    expect(caps.ok).toBe(true);
  });

  it('uploads a pulse — the video plus its captions, beat manifest and thumbnail — under one token, byte for byte', async () => {
    const link = await pair();
    const video = makeMp4(64 * 1024);
    const captions = Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n');
    const manifest = Buffer.from(
      JSON.stringify({
        version: 1,
        type: 'beat-manifest',
        durationMs: 1000,
        beats: [{ segmentId: 's0', order: 0, startMs: 0, endMs: 1000 }],
      }),
    );
    const thumbnail = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    ]);

    // Same order as the app: the small related artifacts first, the video (the anchor) last.
    const related = [
      { bytes: captions, filename: 'draft.vtt', kind: 'captions' as const },
      { bytes: manifest, filename: 'draft-beats.pulse', kind: 'project' as const },
      { bytes: thumbnail, filename: 'draft.jpg', kind: 'thumbnail' as const },
    ].map((a) => ({ ...a, artifactId: randomUUID(), relatedTo: link.artifactId }));
    for (const { bytes, ...artifact } of related) await upload(link, bytes, artifact);
    await upload(link, video, {
      artifactId: link.artifactId,
      filename: 'draft.mp4',
      kind: 'video',
    });

    const served = await download(link, link.artifactId);
    expect(served.res.status).toBe(200);
    expect(served.res.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.compare(served.bytes, video)).toBe(0);
    for (const { artifactId, bytes } of related) {
      const got = await download(link, artifactId);
      expect(got.res.status).toBe(200);
      expect(Buffer.compare(got.bytes, bytes)).toBe(0);
    }
  });

  itSince(2, 2)(
    "mints a read-only view link that opens the video and can't delete it (protocol 2.2+)",
    async () => {
      const link = await pair();
      const caps = await checkCapabilities(link.server);
      expect(caps.ok && caps.capabilities.viewLinks).toBe(true);
      const video = makeMp4(16 * 1024);
      await upload(link, video, {
        artifactId: link.artifactId,
        filename: 'draft.mp4',
        kind: 'video',
      });

      const view = await requestViewLink({
        server: link.server,
        artifactId: link.artifactId,
        token: link.token,
      });
      expect(view).not.toBeNull();
      expect(view!.expiresAt).toBeGreaterThan(Date.now());

      const watched = await fetch(view!.url);
      expect(watched.status).toBe(200);
      expect(Buffer.compare(Buffer.from(await watched.arrayBuffer()), video)).toBe(0);

      // Safe to share: it can't delete the video.
      const viewToken = new URL(view!.url).searchParams.get('token');
      const removed = await fetch(`${link.server}/artifacts/${link.artifactId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${viewToken}` },
      });
      expect(removed.status).toBe(403);
    },
  );

  it("refuses an upload without the pairing token, or with another pulse's token — terminally", async () => {
    const link = await pair();
    const other = await pair();
    const video = makeMp4(16 * 1024);
    const artifact = { artifactId: link.artifactId, filename: 'draft.mp4', kind: 'video' as const };

    for (const token of [null, other.token]) {
      const failure = await upload(link, video, artifact, token).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(TusUploadError);
      expect((failure as TusUploadError).retryable).toBe(false);
    }
  });

  itSince(2, 1)('records which app build made each upload (protocol 2.1+)', async () => {
    const link = await pair();
    const video = makeMp4(16 * 1024);
    await upload(link, video, {
      artifactId: link.artifactId,
      filename: 'draft.mp4',
      kind: 'video',
    });
    const events = (await (await fetch(`${origin}/events`)).json()) as {
      phase: string;
      artifactId: string;
      appVersion?: string;
    }[];
    const complete = events.find((e) => e.phase === 'complete' && e.artifactId === link.artifactId);
    expect(complete?.appVersion).toBe('2.1.0 (45)');
  });

  itSince(2, 1)(
    'tells an app that is too old to update, instead of failing partway (protocol 2.1+)',
    async () => {
      const link = await pair();
      const res = await fetch(`${link.server}/upload`, {
        method: 'POST',
        headers: {
          'Tus-Resumable': '1.0.0',
          'Upload-Length': '16',
          'Pulse-Client': 'Pulse/1.9.0 (30; ios); protocol=1',
          Authorization: `Bearer ${link.token}`,
        },
      });
      expect(res.status).toBe(426);
    },
  );
});
