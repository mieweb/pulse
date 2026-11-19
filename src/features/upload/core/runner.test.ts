import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { UploadPart } from '@/db/upload-jobs';

// The job loop on the real migrations (node:sqlite behind the drizzle expo driver), the real
// outbox and TUS client, against an in-memory PulseVault and a fake host that mints tokens like
// TimeHuddle's server. A "kill" stops a process at one of its requests (before the server sees
// it, after the server applied it, or with half of a PATCH's bytes stored), and a new process
// (empty token memory, a new runner) boots from the rows.
jest.mock(
  'expo-sqlite',
  () =>
    jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
      '@/test-support/expo-sqlite-node',
    ).mockModule,
);
jest.mock('@/db/client', () => {
  const { readdirSync, readFileSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
  const { join } = jest.requireActual<typeof import('node:path')>('node:path');
  const { SQLiteDatabase } = jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
    '@/test-support/expo-sqlite-node',
  );
  const { drizzle } =
    jest.requireActual<typeof import('drizzle-orm/expo-sqlite')>('drizzle-orm/expo-sqlite');
  const conn = new SQLiteDatabase(':memory:');
  conn.execSync('PRAGMA foreign_keys = ON');
  const dir = join(__dirname, '../../../../drizzle');
  for (const file of readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()) {
    for (const statement of readFileSync(join(dir, file), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      if (statement.trim()) conn.execSync(statement);
    }
  }
  return { expoDb: conn, db: drizzle(conn as never) };
});
jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));
jest.mock('expo-file-system/legacy', () => ({ getInfoAsync: jest.fn() }));
jest.mock('expo-secure-store', () => ({ deleteItemAsync: jest.fn(async () => {}) }));
jest.mock('expo', () => ({ requireOptionalNativeModule: () => null }));
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
jest.mock('@/utils/video', () => ({}));
jest.mock('expo-crypto', () => {
  const { createHash } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  let n = 0;
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex' },
    randomUUID: () => `uuid-${++n}`,
    digestStringAsync: async (_algorithm: string, data: string) =>
      createHash('sha256').update(data, 'utf8').digest('hex'),
  };
});
jest.mock('./send-files', () => ({ writeSendFiles: jest.fn() }));
jest.mock('./upload-log', () => ({
  ...jest.requireActual<typeof import('./upload-log')>('./upload-log'),
  uploadLog: { info: () => {}, warn: () => {} },
}));

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { expoDb } from '@/db/client';
import { getReceipt } from '@/db/receipts';
import { getUploadJob } from '@/db/upload-jobs';
import { env, File } from '@/test-support/expo-fs-node';

import {
  HostRequestError,
  type HostUploadTarget,
  type TokenResult,
  type UploadTargetRequest,
} from './host-services';
import {
  BACKGROUND_HELLO_TIMEOUT_MS,
  cancelOrphanedUploadTasks,
  setBackgroundUploads,
  uploadChunkNative,
  type BackgroundTransport,
} from './native-chunk-upload';
import { cancelJob, sendDraft } from './outbox';
import { createJobRunner, PERSIST_INTERVAL_MS, type RunnerHost } from './runner';
import { writeSendFiles } from './send-files';
import type { UploadChunk } from './tus-client';
/* eslint-enable import/first */

const conn = expoDb as unknown as {
  runSync: (sql: string, ...params: unknown[]) => void;
  getFirstSync: (sql: string, ...params: unknown[]) => Record<string, unknown> | null;
};

const EP = 'https://vault.test/pulsevault';
const NOW = 1_790_000_000_000;
const VIDEO_BYTES = 1000;
let clock = NOW;

// ---- an in-memory PulseVault, plus the host server's upload rows -------------------------------

type VaultUpload = {
  url: string;
  artifactId: string;
  kind: string;
  relatedTo: string | null;
  length: number;
  offset: number;
  uploadId: string;
};

type Row = { uploadId: string; clientKey: string; draftKey: string; artifactId: string };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

class Vault {
  n = 0;
  rows = new Map<string, Row>();
  uploads = new Map<string, VaultUpload>();
  complete = new Map<string, VaultUpload>();
  outcomes = new Map<string, unknown>();
  tokens = new Map<string, { uploadId: string; exp: number }>();
  patches: { url: string; offset: number; kind: string }[] = [];
  creates: string[] = [];
  /** Tokens the server stops taking (e.g. revoked): 403. */
  refused = new Set<string>();

  mint(uploadId: string, exp = clock + 2 * 3600_000): TokenResult {
    const token = `tok-${++this.n}`;
    this.tokens.set(token, { uploadId, exp });
    return { token, expiresAt: exp };
  }

  /** The host server's begin: one row per clientKey; `renewArtifact` mints a new artifact. */
  begin(r: UploadTargetRequest): HostUploadTarget {
    let row = this.rows.get(r.clientKey);
    if (!row) {
      row = {
        uploadId: `up-${++this.n}`,
        clientKey: r.clientKey,
        draftKey: r.draftKey,
        artifactId: `vid-${++this.n}`,
      };
      this.rows.set(r.clientKey, row);
    } else if (r.renewArtifact) {
      row.artifactId = `vid-${++this.n}`;
    }
    const landed = this.complete.has(row.artifactId);
    const state = landed
      ? this.outcomes.has(row.artifactId)
        ? 'delivered'
        : 'processing'
      : undefined;
    const { token, expiresAt } = this.mint(row.uploadId);
    return {
      uploadId: row.uploadId,
      endpoint: EP,
      artifactId: row.artifactId,
      token,
      expiresAt,
      clientKey: r.clientKey,
      ...(state ? { state } : {}),
    };
  }

  private auth(headers: Record<string, string>): string | number {
    const bearer = headers.Authorization ?? headers.authorization;
    const token = bearer?.replace(/^Bearer /, '') ?? '';
    const t = this.tokens.get(token);
    if (!t || this.refused.has(token)) return 403;
    if (t.exp < clock) return 401;
    return t.uploadId;
  }

  handle(url: string, init: RequestInit = {}): Response {
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    const who = this.auth(headers);
    if (typeof who === 'number') return json(who, { error: 'token refused' });
    if (method === 'POST' && url === `${EP}/upload`) {
      const meta = Object.fromEntries(
        headers['Upload-Metadata'].split(',').map((pair) => {
          const [k, v] = pair.split(' ');
          return [k, Buffer.from(v, 'base64').toString('utf8')];
        }),
      );
      if (this.complete.has(meta.artifactId)) return json(409, { error: 'taken' });
      // PROTOCOL.md §6.5: a create by the same token takes over an unfinished upload.
      for (const [u, up] of this.uploads)
        if (up.artifactId === meta.artifactId) this.uploads.delete(u);
      const location = `${EP}/upload/u${++this.n}`;
      this.uploads.set(location, {
        url: location,
        artifactId: meta.artifactId,
        kind: meta.kind,
        relatedTo: meta.relatedTo ?? null,
        length: Number(headers['Upload-Length']),
        offset: 0,
        uploadId: who,
      });
      this.creates.push(meta.artifactId);
      return new Response(null, { status: 201, headers: { location } });
    }
    if (method === 'HEAD') {
      const up = this.uploads.get(url);
      if (!up) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: { 'upload-offset': String(up.offset) } });
    }
    const status = url.match(/\/artifacts\/([^/]+)\/status$/);
    if (method === 'GET' && status) {
      const artifactId = status[1];
      const done = this.complete.get(artifactId);
      const uploading = [...this.uploads.values()].some((u) => u.artifactId === artifactId);
      return json(200, {
        artifactId,
        state: done ? 'ready' : uploading ? 'uploading' : 'unknown',
        ...(this.outcomes.has(artifactId) ? { outcome: this.outcomes.get(artifactId) } : {}),
      });
    }
    if (method === 'DELETE') {
      this.uploads.delete(url);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }

  patch(
    p: Parameters<UploadChunk>[0],
    bytes: number,
  ): { status: number; headers: Record<string, string> } {
    const who = this.auth(p.headers);
    if (typeof who === 'number') return { status: who, headers: {} };
    const up = this.uploads.get(p.resourceUrl);
    if (!up) return { status: 404, headers: {} };
    if (up.offset !== p.offset) return { status: 409, headers: {} };
    this.patches.push({ url: up.url, offset: p.offset, kind: up.kind });
    up.offset += bytes;
    if (up.offset === up.length) {
      this.complete.set(up.artifactId, up);
      // The host's onUploadComplete records where the video went (huddle-server.md §7).
      if (up.kind === 'video') {
        this.outcomes.set(up.artifactId, { state: 'done', note: 'Posted', uploadId: up.uploadId });
      }
    }
    return { status: 204, headers: { 'Upload-Offset': String(up.offset) } };
  }
}

// ---- a process: the runner and its fakes, killable at its n-th request -------------------------

type KillMode = 'before' | 'after' | 'mid';
type Account = 'signed-in' | 'signed-out' | 'away';

function makeProcess(
  vault: Vault,
  opts: {
    killAt?: number;
    mode?: KillMode;
    account?: Account;
    foreground?: boolean;
    onTarget?: (r: UploadTargetRequest, t: HostUploadTarget) => HostUploadTarget;
    cancelOrphans?: (live: readonly string[]) => Promise<number>;
  } = {},
) {
  let ops = 0;
  let dead = false;
  const labels: string[] = [];
  const held = new Map<string, TokenResult>();
  const targetCalls: UploadTargetRequest[] = [];
  let refreshes = 0;
  const hang = () => new Promise<never>(() => {});
  let account: Account = opts.account ?? 'signed-in';

  async function op<T>(label: string, run: () => T, partial?: () => void): Promise<T> {
    if (dead) return hang();
    ops++;
    labels.push(label);
    if (opts.killAt === ops) {
      dead = true;
      if (opts.mode === 'after') run();
      if (opts.mode === 'mid') (partial ?? run)();
      return hang();
    }
    return run();
  }

  const refuse = () =>
    account === 'signed-out'
      ? new HostRequestError('no_account', 'Nobody is signed in.')
      : new HostRequestError('host.unavailable', 'No answer.', true);

  const host: RunnerHost = {
    async getUploadTarget(r) {
      targetCalls.push(r);
      if (account !== 'signed-in') throw refuse();
      const target = await op('target', () => vault.begin(r));
      const answered = opts.onTarget ? opts.onTarget(r, target) : target;
      held.set(answered.uploadId, { token: answered.token, expiresAt: answered.expiresAt });
      return answered;
    },
    async refreshUploadToken(r) {
      refreshes++;
      if (account !== 'signed-in') throw refuse();
      const fresh = await op('refresh', () => vault.mint(r.uploadId));
      held.set(r.uploadId, fresh);
      return fresh;
    },
    token: (uploadId) => held.get(uploadId) ?? null,
  };

  const fetchImpl = ((url: string, init?: RequestInit) =>
    op(`${init?.method ?? 'GET'} ${url.replace(EP, '')}`, () =>
      vault.handle(url, init),
    )) as unknown as typeof fetch;

  const uploadChunk: UploadChunk = async (p) => {
    const result = await op(
      `PATCH ${p.kind}`,
      () => vault.patch(p, p.chunkBytes),
      () => vault.patch(p, Math.floor(p.chunkBytes / 2)),
    );
    p.onProgress?.(p.chunkBytes);
    return result;
  };

  const runner = createJobRunner({
    host,
    fetchImpl,
    uploadChunk,
    cancelOrphans: opts.cancelOrphans ?? (async () => 0),
    checksum: async () => 'md5:00',
    isForeground: () => opts.foreground ?? true,
    canUpload: () => true,
    now: () => clock,
  });

  return {
    runner,
    host,
    labels,
    targetCalls,
    held,
    ops: () => ops,
    dead: () => dead,
    refreshes: () => refreshes,
    setAccount: (next: Account) => {
      account = next;
    },
  };
}

/** Let a process run until it is killed (its pass then hangs for good). */
async function untilDead(p: { dead: () => boolean }): Promise<void> {
  for (let i = 0; i < 500 && !p.dead(); i++) await new Promise((r) => setImmediate(r));
  if (!p.dead()) throw new Error('the process was never killed');
}

// ---- drafts ------------------------------------------------------------------------------------

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'runner-'));
  env.docDir = join(root, 'doc');
  env.cacheDir = join(root, 'cache');
  env.dbDir = join(root, 'db');
  for (const d of [env.docDir, env.cacheDir, env.dbDir]) mkdirSync(d, { recursive: true });
});
afterAll(() => rmSync(dirname(env.docDir), { recursive: true, force: true }));

beforeEach(() => {
  clock = NOW;
});

function writeDoc(rel: string, bytes: number | string) {
  const path = join(env.docDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof bytes === 'string' ? bytes : Buffer.alloc(bytes, 7));
}

/** The parts writeSendFiles would list for `id` (the files are written here). */
function partsFor(id: string): UploadPart[] {
  const send = `drafts/${id}/send`;
  writeDoc(`${send}/captions.vtt`, 'WEBVTT\n');
  writeDoc(`${send}/beats.pulse`, '{"beats":[]}');
  writeDoc(`${send}/thumbnail.jpg`, 64);
  writeDoc(`drafts/${id}/export.mp4`, VIDEO_BYTES);
  const part = (role: UploadPart['role'], file: string, bytes: number): UploadPart => ({
    role,
    artifactId: role === 'video' ? null : `${role}-${id}`,
    file,
    bytes,
    tusUrl: null,
    done: false,
  });
  return [
    part('captions', `${send}/captions.vtt`, 7),
    part('manifest', `${send}/beats.pulse`, 12),
    part('thumbnail', `${send}/thumbnail.jpg`, 64),
    part('video', `drafts/${id}/export.mp4`, VIDEO_BYTES),
  ];
}

jest.mocked(writeSendFiles).mockImplementation(async (draftId: string) => ({
  parts: partsFor(draftId),
  bytesTotal: VIDEO_BYTES,
}));

function addDraft(id: string) {
  conn.runSync(
    `INSERT INTO drafts (id, name, context_key, context_label, context_json, created_via,
       merged_duration_ms)
     VALUES (?, 'Shift notes', 'ticket:t1', 'Ticket 1', ?, 'host', 4000)`,
    id,
    JSON.stringify({ kind: 'ticket', id: 't1', label: 'Ticket 1' }),
  );
  conn.runSync(
    `INSERT INTO segments (id, draft_id, sort_order, original_filename, duration_ms)
     VALUES (?, ?, 0, ?, 4000)`,
    `${id}-s1`,
    id,
    `drafts/${id}/segments/${id}-s1.mp4`,
  );
}

/** A draft sent and queued, as Export leaves it. */
async function queued(id: string) {
  addDraft(id);
  return sendDraft(id, async () => ({ durationMs: 4000 }));
}

function expectOneUpload(vault: Vault, id: string, clientKey: string) {
  expect(getUploadJob(id)).toBeNull();
  expect(getReceipt(id)).toMatchObject({ outcome: 'done', note: 'Posted', clientKey });
  expect(conn.getFirstSync('SELECT id FROM drafts WHERE id = ?', id)).toBeNull();
  const row = vault.rows.get(clientKey)!;
  expect([...vault.rows.values()].filter((r) => r.draftKey === row.draftKey)).toHaveLength(1);
  // The video under the row's artifact, and one of each related part relatedTo it.
  const landed = [...vault.complete.values()].filter(
    (u) => u.artifactId === row.artifactId || u.relatedTo === row.artifactId,
  );
  expect(landed.map((u) => u.kind).sort()).toEqual(['captions', 'project', 'thumbnail', 'video']);
  expect(landed.every((u) => u.uploadId === row.uploadId)).toBe(true);
  // Exactly one finished video for the upload, whatever the kills cost.
  const videos = [...vault.complete.values()].filter(
    (u) => u.uploadId === row.uploadId && u.kind === 'video',
  );
  expect(videos.map((u) => u.artifactId)).toEqual([row.artifactId]);
}

// ---- tests -------------------------------------------------------------------------------------

describe('the job loop', () => {
  it('uploads the parts in order with the target token, then retires on the outcome', async () => {
    const vault = new Vault();
    const sent = await queued('d-clean');
    const p = makeProcess(vault);
    await p.runner.drain();

    expect(p.labels.map((l) => l.replace(/\/u\d+$/, '/<id>'))).toEqual([
      'target',
      'POST /upload',
      'HEAD /upload/<id>',
      'PATCH captions',
      'POST /upload',
      'HEAD /upload/<id>',
      'PATCH project',
      'POST /upload',
      'HEAD /upload/<id>',
      'PATCH thumbnail',
      'POST /upload',
      'HEAD /upload/<id>',
      'PATCH video',
      `GET /artifacts/${vault.rows.get(sent.clientKey)!.artifactId}/status`,
    ]);
    expect(p.targetCalls[0]).toMatchObject({
      draftId: 'd-clean',
      clientKey: sent.clientKey,
      draftKey: sent.draftKey,
      context: { key: 'ticket:t1', label: 'Ticket 1', kind: 'ticket', id: 't1' },
      name: 'Shift notes',
      durationMs: 4000,
      bytes: VIDEO_BYTES,
      attempt: 1,
      renewArtifact: false,
    });
    const related = [...vault.uploads.values()].filter((u) => u.kind !== 'video');
    expect(related.every((u) => u.relatedTo === vault.rows.get(sent.clientKey)!.artifactId)).toBe(
      true,
    );
    expectOneUpload(vault, 'd-clean', sent.clientKey);
  });

  describe('a simulated kill after each step ends in exactly one server upload', () => {
    const vault = new Vault();
    // A clean run makes 14 requests: the target, POST + HEAD + PATCH for each of the four parts,
    // and one status poll.
    const STEPS = 14;
    const cases: [number, KillMode][] = [];
    for (let k = 1; k <= STEPS; k++) {
      cases.push([k, 'before'], [k, 'after']);
      if (k % 3 === 1 && k > 1) cases.push([k, 'mid']); // the PATCHes: half the bytes stored
    }

    it.each(cases)('killed at request %i (%s)', async (k, mode) => {
      const id = `d-kill-${k}-${mode}`;
      const sent = await queued(id);
      const first = makeProcess(vault, { killAt: k, mode });
      void first.runner.drain();
      await untilDead(first);

      const second = makeProcess(vault);
      await second.runner.boot();

      expectOneUpload(vault, id, sent.clientKey);
      if (mode === 'mid') {
        // The relaunch resumed the part from the server's HEAD offset instead of starting over.
        const row = vault.rows.get(sent.clientKey)!;
        const urls = new Set(
          [...vault.uploads.values()].filter((u) => u.uploadId === row.uploadId).map((u) => u.url),
        );
        const resumed = vault.patches.filter((x) => urls.has(x.url) && x.offset > 0);
        expect(resumed).toHaveLength(1);
        // A token minted after the relaunch carried it (the first process's died with it).
        expect(second.refreshes()).toBe(1);
      }
    });

    it('covers every request of a clean run', async () => {
      const sent = await queued('d-kill-count');
      const p = makeProcess(vault);
      await p.runner.drain();
      expect(p.ops()).toBe(STEPS);
      expectOneUpload(vault, 'd-kill-count', sent.clientKey);
    });
  });

  it('refreshes the token once when PulseVault refuses it (403), and carries on', async () => {
    const vault = new Vault();
    const sent = await queued('d-403');
    const p = makeProcess(vault, {
      // The first token stops working right after the host hands it out.
      onTarget: (_r, t) => {
        vault.refused.add(t.token);
        return t;
      },
    });
    await p.runner.drain();
    expect(p.refreshes()).toBe(1);
    expectOneUpload(vault, 'd-403', sent.clientKey);
  });

  it('pauses the job (credentials.expired) when the token is refused and the host never answers a refresh', async () => {
    const vault = new Vault();
    await queued('d-401');
    const p = makeProcess(vault, {
      onTarget: (_r, t) => {
        vault.refused.add(t.token);
        p.setAccount('away');
        return t;
      },
    });
    await p.runner.drain();
    expect(getUploadJob('d-401')).toMatchObject({
      state: 'needs_credentials',
      lastErrorCode: 'credentials.expired',
    });
  });

  it('asks again with renewArtifact on a 404, and sends every part under the new ids', async () => {
    const vault = new Vault();
    const sent = await queued('d-404');
    const first = makeProcess(vault, { killAt: 13, mode: 'mid' }); // half the video stored
    void first.runner.drain();
    await untilDead(first);
    const firstArtifact = vault.rows.get(sent.clientKey)!.artifactId;
    // PulseVault forgets the partial upload (its 24 h retention).
    for (const [url, u] of vault.uploads)
      if (u.artifactId === firstArtifact) vault.uploads.delete(url);

    const second = makeProcess(vault);
    await second.runner.boot();

    expect(second.targetCalls).toEqual([
      expect.objectContaining({ clientKey: sent.clientKey, renewArtifact: true }),
    ]);
    const row = vault.rows.get(sent.clientKey)!;
    expect(row.artifactId).not.toBe(firstArtifact);
    expectOneUpload(vault, 'd-404', sent.clientKey);
    expect(getReceipt('d-404')?.artifactId).toBe(row.artifactId);
    // The related parts went again under new ids, relatedTo the new video.
    const relatedTo = (artifactId: string) =>
      [...vault.complete.values()]
        .filter((u) => u.relatedTo === artifactId)
        .map((u) => u.artifactId);
    expect(relatedTo(row.artifactId)).toHaveLength(3);
    expect(relatedTo(row.artifactId).some((a) => relatedTo(firstArtifact).includes(a))).toBe(false);
  });

  it('an edit takes the job out, and the next Send has a new clientKey and the same draftKey', async () => {
    const vault = new Vault();
    const before = await queued('d-edit');
    const p = makeProcess(vault, { account: 'signed-out' });
    await p.runner.drain();
    expect(getUploadJob('d-edit')?.state).toBe('needs_credentials');

    cancelJob('d-edit', 'edited');
    conn.runSync(
      `UPDATE segments SET edited_filename = 'drafts/d-edit/segments/e.mp4',
         edited_duration_ms = 2500 WHERE draft_id = 'd-edit'`,
    );
    const after = await sendDraft('d-edit', async () => ({ durationMs: 2500 }));
    p.setAccount('signed-in');
    await p.runner.drain();

    expect(after.draftKey).toBe(before.draftKey);
    expect(after.clientKey).not.toBe(before.clientKey);
    expect(p.targetCalls.map((c) => [c.clientKey, c.draftKey])).toEqual([
      [before.clientKey, before.draftKey],
      [after.clientKey, before.draftKey],
    ]);
    expectOneUpload(vault, 'd-edit', after.clientKey);
  });

  it('fails the job when the host answers for another upload (clientKey echo)', async () => {
    const vault = new Vault();
    await queued('d-echo');
    const p = makeProcess(vault, { onTarget: (_r, t) => ({ ...t, clientKey: 'someone:else:0' }) });
    await p.runner.drain();
    expect(getUploadJob('d-echo')).toMatchObject({
      state: 'failed',
      lastErrorCode: 'host_misconfigured',
    });
    expect(vault.creates).toEqual([]);
  });

  it('fails the job on destination.gone, and backs off on a retryable host answer', async () => {
    const vault = new Vault();
    await queued('d-gone');
    await queued('d-retry');
    let n = 0;
    const host: RunnerHost = {
      getUploadTarget: async () => {
        throw n++ === 0
          ? new HostRequestError('destination.gone', 'The ticket was deleted.')
          : new HostRequestError('host.unavailable', 'Try later.');
      },
      refreshUploadToken: async () => ({ token: 't', expiresAt: 0 }),
      token: () => null,
    };
    const runner = createJobRunner({ host, canUpload: () => true, now: () => clock });
    await runner.drain();
    expect(getUploadJob('d-gone')).toMatchObject({
      state: 'failed',
      lastErrorCode: 'destination.gone',
    });
    expect(getUploadJob('d-retry')).toMatchObject({
      state: 'queued',
      attempts: 1,
      nextAttemptAt: NOW + 5_000,
      lastErrorCode: 'host.unavailable',
    });
    expect(vault.creates).toEqual([]);
  });

  it('fails the job with upload.too_large when PulseVault answers 413', async () => {
    const vault = new Vault();
    await queued('d-413');
    const p = makeProcess(vault);
    const handle = vault.handle.bind(vault);
    vault.handle = (url, init) =>
      init?.method === 'POST' ? json(413, { error: 'Too large' }) : handle(url, init);
    await p.runner.drain();
    expect(getUploadJob('d-413')).toMatchObject({
      state: 'failed',
      lastErrorCode: 'upload.too_large',
    });
  });

  it('writes bytes_sent at most every 5 s while the video uploads', async () => {
    const vault = new Vault();
    await queued('d-bytes');
    const p = makeProcess(vault);
    const seen: (number | null)[] = [];
    const inner = vault.patch.bind(vault);
    vault.patch = (params, bytes) => {
      if (params.kind === 'video') {
        // Ticks 1 s apart, then one 5 s later: only that one is written.
        for (const [dt, sent] of [
          [1000, 100],
          [1000, 200],
          [PERSIST_INTERVAL_MS, 600],
        ]) {
          clock += dt;
          params.onProgress?.(sent);
          seen.push(getUploadJob('d-bytes')?.bytesSent ?? null);
        }
      }
      return inner(params, bytes);
    };
    await p.runner.drain();
    expect(seen).toEqual([0, 0, 600]);
  });

  it('sends progress at most 4 times a second, and always the end', async () => {
    const vault = new Vault();
    await queued('d-progress');
    const p = makeProcess(vault);
    const events: number[] = [];
    p.runner.subscribeProgress((e) => events.push(e.bytesSent));
    const inner = vault.patch.bind(vault);
    vault.patch = (params, bytes) => {
      if (params.kind === 'video') {
        for (let sent = 100; sent <= 500; sent += 100) params.onProgress?.(sent); // same instant
        clock += 300;
        params.onProgress?.(700);
      }
      return inner(params, bytes);
    };
    await p.runner.drain();
    // HEAD's 0, then 700 (300 ms later), then the end; the ticks in between are dropped.
    expect(events).toEqual([0, 700, VIDEO_BYTES]);
  });

  describe('status polling (foreground only)', () => {
    it("doesn't poll in the background, and retires on the next foreground pass", async () => {
      const vault = new Vault();
      const sent = await queued('d-bg');
      const background = makeProcess(vault, { foreground: false });
      await background.runner.drain();
      expect(getUploadJob('d-bg')?.state).toBe('delivering');
      expect(background.labels.some((l) => l.endsWith('/status'))).toBe(false);

      const foreground = makeProcess(vault);
      await foreground.runner.boot();
      expectOneUpload(vault, 'd-bg', sent.clientKey);
    });

    it('refreshes an expired token for the status route', async () => {
      const vault = new Vault();
      const sent = await queued('d-status-401');
      const background = makeProcess(vault, { foreground: false });
      await background.runner.drain();
      // The token runs out (a long conform queue) before the app is back in the foreground.
      clock += 3 * 3600_000;
      const foreground = makeProcess(vault);
      foreground.held.set(vault.rows.get(sent.clientKey)!.uploadId, {
        token: [...vault.tokens.keys()].at(-1)!,
        expiresAt: clock + 3600_000, // what the device believes; the server disagrees
      });
      await foreground.runner.drain();
      expect(foreground.refreshes()).toBe(1);
      expectOneUpload(vault, 'd-status-401', sent.clientKey);
    });
  });

  describe('accounts', () => {
    it('the host answering no_account pauses the job, and never fails it', async () => {
      const vault = new Vault();
      await queued('d-noacct');
      const p = makeProcess(vault, { account: 'signed-out' });
      await p.runner.drain();
      await p.runner.drain();
      expect(getUploadJob('d-noacct')).toMatchObject({
        state: 'needs_credentials',
        lastErrorCode: 'no_account',
      });
    });

    it('setAccount back to the same namespace + resumeOutbox resumes from the HEAD offset', async () => {
      const vault = new Vault();
      const sent = await queued('d-back');
      const first = makeProcess(vault, { killAt: 13, mode: 'mid' }); // half the video stored
      void first.runner.drain();
      await untilDead(first);

      // Relaunched while signed out: the token can't be refreshed, so the job waits.
      const second = makeProcess(vault, { account: 'signed-out' });
      await second.runner.boot();
      expect(getUploadJob('d-back')).toMatchObject({
        state: 'needs_credentials',
        lastErrorCode: 'no_account',
      });

      // The same person signs in again (the host's setAccount, then resumeOutbox).
      second.setAccount('signed-in');
      await second.runner.resumeOutbox();
      const video = [...vault.uploads.values()].find(
        (u) => u.uploadId === vault.rows.get(sent.clientKey)!.uploadId && u.kind === 'video',
      )!;
      expect(vault.patches.filter((x) => x.url === video.url).map((x) => x.offset)).toEqual([
        0,
        VIDEO_BYTES / 2,
      ]);
      expectOneUpload(vault, 'd-back', sent.clientKey);
    });

    it('jobs of an inactive namespace never run', async () => {
      const vault = new Vault();
      await queued('d-inactive');
      const p = makeProcess(vault);
      p.runner.setAccountActive(false);
      await p.runner.boot();
      await p.runner.resumeOutbox();
      await p.runner.runJob('d-inactive');
      expect(p.ops()).toBe(0);
      expect(getUploadJob('d-inactive')?.state).toBe('queued');

      p.runner.setAccountActive(true);
      await p.runner.drain();
      expect(getUploadJob('d-inactive')).toBeNull();
      expect(getReceipt('d-inactive')?.outcome).toBe('done');
    });
  });

  it('a Cancel sending under way stops the upload', async () => {
    const vault = new Vault();
    await queued('d-cancel');
    const p = makeProcess(vault);
    const inner = vault.patch.bind(vault);
    vault.patch = (params, bytes) => {
      if (params.kind === 'video') cancelJob('d-cancel', 'canceled');
      return inner(params, bytes);
    };
    await p.runner.drain();
    expect(getUploadJob('d-cancel')).toBeNull();
    expect(getReceipt('d-cancel')).toBeNull();
    expect(p.labels.some((l) => l.endsWith('/status'))).toBe(false);
  });
  it('the launch rule keeps the background tasks of live jobs, then reattaches through HEAD', async () => {
    const vault = new Vault();
    const sent = await queued('d-sweep');
    const first = makeProcess(vault, { killAt: 13, mode: 'mid' });
    void first.runner.drain();
    await untilDead(first);

    const kept: string[][] = [];
    const second = makeProcess(vault, {
      cancelOrphans: async (live) => {
        kept.push([...live]);
        return 0;
      },
    });
    await second.runner.boot();
    const row = vault.rows.get(sent.clientKey)!;
    const urls = [...vault.uploads.values()]
      .filter((u) => u.uploadId === row.uploadId)
      .map((u) => u.url)
      .sort();
    // Every part's upload URL counted as live, the video's (still running) among them.
    expect([...kept[0]].sort()).toEqual(expect.arrayContaining(urls));
    // Status first, then HEAD + PATCH of the rest.
    expect(second.labels.slice(0, 4)).toEqual([
      'refresh',
      `GET /artifacts/${row.artifactId}/status`,
      expect.stringMatching(/^HEAD \/upload\//),
      'PATCH video',
    ]);
    expectOneUpload(vault, 'd-sweep', sent.clientKey);
  });
});

describe("PulseKit's background uploader (native-chunk-upload.ts)", () => {
  /** A fake PulseKit on the other end of the transport; `answer` decides what it replies. */
  function fakePulseKit(answer: (m: Record<string, unknown>, reply: (r: object) => void) => void) {
    const sent: Record<string, unknown>[] = [];
    let deliver: ((m: Record<string, unknown>) => void) | null = null;
    const transport: BackgroundTransport = {
      send: (m) => {
        sent.push(m);
        queueMicrotask(() => answer(m, (r) => deliver?.({ id: m.id, ...r })));
      },
      listen: (fn) => {
        deliver = fn;
        return () => {
          deliver = null;
        };
      },
    };
    setBackgroundUploads(transport);
    return { sent, deliver: (m: Record<string, unknown>) => deliver?.(m) };
  }

  afterAll(() => setBackgroundUploads(null));

  function videoFile(): InstanceType<typeof File> {
    writeDoc('bg/export.mp4', 100);
    return new File(env.docDir, 'bg', 'export.mp4');
  }

  it('sends one PATCH of the bytes left to PulseKit, with its progress and answer', async () => {
    const pk = fakePulseKit((m, reply) => {
      if (m.op === 'hello') reply({ type: 'pulse.upload.end', ok: true });
      if (m.op === 'patch') {
        reply({ type: 'pulse.upload.progress', sent: 30 });
        reply({
          type: 'pulse.upload.end',
          ok: true,
          status: 204,
          headers: { 'Upload-Offset': '100' },
        });
      }
    });
    const ticks: number[] = [];
    const file = videoFile();
    const result = await uploadChunkNative({
      resourceUrl: `${EP}/upload/u1`,
      kind: 'video',
      offset: 40,
      chunkBytes: 60,
      totalBytes: 100,
      file: file as never,
      headers: { 'Upload-Offset': '40', Authorization: 'Bearer t' },
      onProgress: (n) => ticks.push(n),
    });
    expect(result).toEqual({ status: 204, headers: { 'Upload-Offset': '100' } });
    expect(ticks).toEqual([30]);
    expect(pk.sent.map((m) => m.op)).toEqual(['hello', 'patch']);
    expect(pk.sent[1]).toMatchObject({
      type: 'pulse.upload',
      url: `${EP}/upload/u1`,
      offset: 40,
      length: 60,
      path: file.path,
      headers: { 'Upload-Offset': '40', Authorization: 'Bearer t' },
    });
  });

  it('cancels the task when the upload is aborted', async () => {
    const pk = fakePulseKit((m, reply) => {
      if (m.op === 'hello') reply({ type: 'pulse.upload.end', ok: true });
      if (m.op === 'cancel') {
        pk.deliver({
          type: 'pulse.upload.end',
          id: m.id,
          ok: false,
          error: { message: 'Cancelled.', canceled: true },
        });
      }
    });
    const abort = new AbortController();
    const patch = uploadChunkNative({
      resourceUrl: `${EP}/upload/u2`,
      kind: 'video',
      offset: 0,
      chunkBytes: 100,
      totalBytes: 100,
      file: videoFile() as never,
      headers: {},
      signal: abort.signal,
    });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    abort.abort();
    await expect(patch).rejects.toMatchObject({ name: 'AbortError' });
    const patchId = pk.sent.find((m) => m.op === 'patch')?.id;
    expect(pk.sent.find((m) => m.op === 'cancel')).toMatchObject({ id: patchId });
  });

  it('cancels only the tasks of no live job, through PulseKit', async () => {
    const pk = fakePulseKit((m, reply) => {
      if (m.op === 'hello') reply({ type: 'pulse.upload.end', ok: true });
      if (m.op === 'sweep') reply({ type: 'pulse.upload.end', ok: true, cancelled: 2 });
    });
    await expect(cancelOrphanedUploadTasks([`${EP}/upload/live`])).resolves.toBe(2);
    expect(pk.sent.find((m) => m.op === 'sweep')).toMatchObject({ live: [`${EP}/upload/live`] });
  });

  it("falls back to expo's task when PulseKit doesn't answer", async () => {
    jest.useFakeTimers();
    try {
      const pk = fakePulseKit(() => {});
      const swept = cancelOrphanedUploadTasks(['x']);
      await jest.advanceTimersByTimeAsync(BACKGROUND_HELLO_TIMEOUT_MS);
      await expect(swept).resolves.toBe(0);
      expect(pk.sent.map((m) => m.op)).toEqual(['hello']);
    } finally {
      jest.useRealTimers();
    }
  });
});
