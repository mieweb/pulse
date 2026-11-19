import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { UploadJob, UploadPart } from '@/db/upload-jobs';

// The outbox on the real migrations (node:sqlite behind the drizzle expo driver), the real host
// channel answered by a fake host, and the send files and TUS deletes stubbed at their modules.
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
jest.mock('expo-secure-store', () => ({ deleteItemAsync: jest.fn(async () => {}) }));
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
jest.mock('./send-files', () => ({
  writeSendFiles: jest.fn(async (draftId: string) => ({
    parts: [
      {
        role: 'manifest',
        artifactId: 'm-1',
        file: `drafts/${draftId}/send/beats.pulse`,
        bytes: 40,
        tusUrl: null,
        done: false,
      },
      {
        role: 'video',
        artifactId: null,
        file: `drafts/${draftId}/export.mp4`,
        bytes: 1000,
        tusUrl: null,
        done: false,
      },
    ],
    bytesTotal: 1000,
  })),
}));
jest.mock('./tus-client', () => ({ cancelTusUpload: jest.fn(async () => {}) }));
jest.mock('./upload-log', () => ({
  ...jest.requireActual<typeof import('./upload-log')>('./upload-log'),
  uploadLog: { info: () => {}, warn: () => {} },
}));

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { expoDb } from '@/db/client';
import { deleteDraft, renameDraft, reorderSegments, setDraftContext } from '@/db/drafts';
import { getUploadJob } from '@/db/upload-jobs';
import {
  applyTransition,
  backoffMs,
  cancelJob,
  hostErrorEvent,
  nextJobState,
  recoverInterruptedSends,
  renewParts,
  resumePausedJobs,
  runJobEffects,
  sendDraft,
  type JobEvent,
  type TransitionContext,
} from './outbox';
import {
  forgetUploadTokens,
  getUploadTarget,
  HostRequestError,
  respondToHostRequest,
  setHostRequestSink,
  type HostRequestPayload,
} from './host-services';
import { writeSendFiles } from './send-files';
import { cancelTusUpload } from './tus-client';
/* eslint-enable import/first */

const conn = expoDb as unknown as {
  execSync: (sql: string) => void;
  runSync: (sql: string, ...params: unknown[]) => void;
  getFirstSync: (sql: string, ...params: unknown[]) => Record<string, unknown> | null;
};

// ---- the pure table ----------------------------------------------------------------------------

const NOW = 1_790_000_000_000;
const ctx = (draft: TransitionContext['draft'] = { sentAt: null, hostConfirmedAt: null }) => {
  let n = 0;
  return { now: NOW, newId: () => `new-${++n}`, draft };
};

const PARTS: UploadPart[] = [
  { role: 'captions', artifactId: 'c-1', file: 'c.vtt', bytes: 5, tusUrl: null, done: false },
  { role: 'video', artifactId: null, file: 'v.mp4', bytes: 100, tusUrl: null, done: false },
];

function job(state: UploadJob['state'], over: Partial<UploadJob> = {}): UploadJob {
  return {
    draftId: 'd1',
    state,
    clientKey: 'i:d1:aaaa',
    draftKey: 'i:d1',
    mergedSignature: 'sig',
    sentAt: NOW - 1000,
    uploadId: null,
    artifactId: null,
    endpoint: null,
    partsJson: JSON.stringify(PARTS),
    bytesTotal: 100,
    bytesSent: null,
    attempts: 0,
    nextAttemptAt: null,
    tokenExp: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    ...over,
  };
}

const TARGET: JobEvent = {
  type: 'targetAnswered',
  uploadId: 'u1',
  artifactId: 'v-1',
  endpoint: 'https://pv',
  tokenExp: NOW + 900_000,
};

/** `[from, event, to]`: every row of pulse-schema.md §3.3 that ends in a state. */
const TABLE: [string, UploadJob | null, JobEvent, string][] = [
  [
    '(none) + send',
    null,
    { type: 'send', clientKey: 'i:d1:aaaa', draftKey: 'i:d1', mergedSignature: 'sig' },
    'preparing',
  ],
  [
    'preparing + files ready',
    job('preparing', { partsJson: null, bytesTotal: null }),
    { type: 'prepared', parts: PARTS, bytesTotal: 100, needsConfirm: false },
    'queued',
  ],
  [
    'preparing + files ready, confirm needed',
    job('preparing', { partsJson: null }),
    { type: 'prepared', parts: PARTS, bytesTotal: 100, needsConfirm: true },
    'preparing',
  ],
  ['preparing + confirmed', job('preparing'), { type: 'confirmed', confirmedAt: NOW }, 'queued'],
  ['preparing + merge fails', job('preparing'), { type: 'mergeFailed', message: 'x' }, 'failed'],
  ['queued + target', job('queued'), TARGET, 'uploading'],
  ['queued + target delivered', job('queued'), { ...TARGET, state: 'delivered' }, 'delivering'],
  ['queued + target kept', job('queued'), { ...TARGET, state: 'kept' }, 'delivering'],
  [
    'queued + host away',
    job('queued'),
    { type: 'credentialsLost', code: 'host.unavailable', message: 'x' },
    'needs_credentials',
  ],
  [
    'uploading + token expired, no refresh',
    job('uploading'),
    { type: 'credentialsLost', code: 'credentials.expired', message: 'x' },
    'needs_credentials',
  ],
  [
    'uploading + no_account',
    job('uploading'),
    { type: 'credentialsLost', code: 'no_account', message: 'x' },
    'needs_credentials',
  ],
  ['needs_credentials + resume', job('needs_credentials'), { type: 'resume' }, 'queued'],
  [
    'uploading + retryable error',
    job('uploading', { attempts: 1 }),
    { type: 'retryableError', code: 'upload.failed', message: 'x' },
    'queued',
  ],
  [
    'queued + destination.gone',
    job('queued'),
    { type: 'permanentError', code: 'destination.gone', message: 'x' },
    'failed',
  ],
  [
    'uploading + upload.refused',
    job('uploading'),
    { type: 'permanentError', code: 'upload.refused', message: 'x' },
    'failed',
  ],
  ['uploading + video done', job('uploading'), { type: 'videoDone', parts: PARTS }, 'delivering'],
  // Not rows of the table: what the job loop records between them.
  [
    'uploading + renewed target (404)',
    job('uploading', { artifactId: 'v-0' }),
    TARGET,
    'uploading',
  ],
  ['queued + token refreshed', job('queued'), { type: 'tokenRefreshed', tokenExp: NOW }, 'queued'],
  [
    'uploading + token refreshed',
    job('uploading'),
    { type: 'tokenRefreshed', tokenExp: NOW },
    'uploading',
  ],
];

describe('nextJobState: pulse-schema.md §3.3', () => {
  it.each(TABLE)('%s', (_name, from, event, to) => {
    const t = nextJobState(from, event, ctx());
    if (t.kind === 'insert') expect(t.row.state).toBe(to);
    else if (t.kind === 'update') expect([t.to, t.set.state]).toEqual([to, to]);
    else throw new Error(`expected a move to ${to}, got ${t.kind}`);
  });

  it('send freezes the keys and the time, and keeps a clock-bound draft’s first Send time', () => {
    const send: JobEvent = { type: 'send', clientKey: 'k', draftKey: 'dk', mergedSignature: 's' };
    const fresh = nextJobState(null, send, ctx({ sentAt: NOW - 50, hostConfirmedAt: null }));
    expect(fresh).toMatchObject({
      kind: 'insert',
      replaces: false,
      row: { clientKey: 'k', draftKey: 'dk', mergedSignature: 's', sentAt: NOW },
      draft: { sentAt: NOW },
    });
    const bound = nextJobState(null, send, ctx({ sentAt: NOW - 50, hostConfirmedAt: NOW - 40 }));
    expect(bound).toMatchObject({ row: { sentAt: NOW - 50 }, draft: { sentAt: NOW - 50 } });
    expect(nextJobState(null, send, ctx(null))).toMatchObject({
      kind: 'refuse',
      code: 'not_found',
    });
  });

  it('send on a failed job starts it over; on a sent one is a no-op or locked', () => {
    const send: JobEvent = {
      type: 'send',
      clientKey: 'i:d1:aaaa',
      draftKey: 'i:d1',
      mergedSignature: 'sig',
    };
    expect(nextJobState(job('failed'), send, ctx())).toMatchObject({
      kind: 'insert',
      replaces: true,
    });
    expect(nextJobState(job('queued'), send, ctx())).toMatchObject({ kind: 'ignore' });
    expect(nextJobState(job('queued'), { ...send, clientKey: 'i:d1:bbbb' }, ctx())).toMatchObject({
      kind: 'refuse',
      code: 'draft.locked',
    });
    for (const state of ['preparing', 'uploading', 'delivering'] as const) {
      expect(nextJobState(job(state), send, ctx())).toMatchObject({
        kind: 'refuse',
        code: 'draft.locked',
      });
    }
  });

  it('writes what each row says it writes', () => {
    expect(
      nextJobState(
        job('preparing'),
        { type: 'prepared', parts: PARTS, bytesTotal: 100, needsConfirm: false },
        ctx(),
      ),
    ).toMatchObject({ set: { partsJson: JSON.stringify(PARTS), bytesTotal: 100 } });
    expect(
      nextJobState(job('preparing'), { type: 'mergeFailed', message: 'no room' }, ctx()),
    ).toMatchObject({ set: { lastErrorCode: 'export.failed', lastErrorMessage: 'no room' } });
    expect(
      nextJobState(job('preparing'), { type: 'confirmed', confirmedAt: 7 }, ctx()),
    ).toMatchObject({ draft: { hostConfirmedAt: 7 } });
    const answered = nextJobState(job('queued', { attempts: 2 }), TARGET, ctx());
    expect(answered).toMatchObject({
      set: { uploadId: 'u1', artifactId: 'v-1', endpoint: 'https://pv', attempts: 3 },
    });
    // The video part takes the target's artifact id; the related ones keep theirs.
    const parts = JSON.parse((answered as { set: { partsJson: string } }).set.partsJson);
    expect(parts.map((p: UploadPart) => p.artifactId)).toEqual(['c-1', 'v-1']);
    expect(
      nextJobState(
        job('uploading', { bytesTotal: 100 }),
        { type: 'videoDone', parts: PARTS },
        ctx(),
      ),
    ).toMatchObject({ set: { bytesSent: 100 } });
  });

  it('a renewed artifact restarts every part, the related ones under new ids', () => {
    const sent = PARTS.map((p) => ({
      ...p,
      artifactId: p.artifactId ?? 'v-1',
      tusUrl: 'https://pv/u',
      done: true,
    }));
    const t = nextJobState(
      job('queued', { partsJson: JSON.stringify(sent), artifactId: 'v-1' }),
      { ...TARGET, artifactId: 'v-2' },
      ctx(),
    );
    const parts = JSON.parse((t as { set: { partsJson: string } }).set.partsJson);
    expect(parts).toEqual([
      { ...sent[0], artifactId: 'new-1', tusUrl: null, done: false },
      { ...sent[1], artifactId: 'v-2', tusUrl: null, done: false },
    ]);
    expect(renewParts(sent, 'v-3', () => 'n')).toEqual([
      { ...sent[0], artifactId: 'n', tusUrl: null, done: false },
      { ...sent[1], artifactId: 'v-3', tusUrl: null, done: false },
    ]);
  });

  it('backs off 5 s · 2^n, capped at 15 min', () => {
    expect([0, 1, 2, 3, 7, 8, 50].map(backoffMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 640_000, 900_000, 900_000,
    ]);
    const first = nextJobState(
      job('uploading', { attempts: 1 }),
      { type: 'retryableError', code: 'upload.failed', message: 'x' },
      ctx(),
    );
    expect(first).toMatchObject({ set: { attempts: 1, nextAttemptAt: NOW + 5_000 } });
    // A failed ask for a target counts as an attempt too.
    const again = nextJobState(
      job('queued', { attempts: 1 }),
      { type: 'retryableError', code: 'host.unavailable', message: 'x' },
      ctx(),
    );
    expect(again).toMatchObject({ set: { attempts: 2, nextAttemptAt: NOW + 10_000 } });
    // A server that says when: at least that long, and the backoff when it is longer.
    const told = (attempts: number) =>
      nextJobState(
        job('uploading', { attempts }),
        { type: 'retryableError', code: 'upload.conflict', message: 'x', retryAfterMs: 310_000 },
        ctx(),
      );
    expect(told(1)).toMatchObject({ set: { attempts: 1, nextAttemptAt: NOW + 310_000 } });
    expect(told(9)).toMatchObject({ set: { attempts: 9, nextAttemptAt: NOW + 900_000 } });
  });

  it('delivering retires on the outcome', () => {
    expect(nextJobState(job('delivering'), { type: 'outcome', outcome: 'kept' }, ctx())).toEqual({
      kind: 'retire',
      outcome: 'kept',
    });
  });

  it('cancel deletes a queued, paused or failed job, and an uploading one only for Cancel', () => {
    for (const state of ['queued', 'needs_credentials', 'failed'] as const) {
      for (const reason of ['canceled', 'edited', 'deleted'] as const) {
        expect(nextJobState(job(state), { type: 'cancel', reason }, ctx()).kind).toBe('delete');
      }
    }
    expect(nextJobState(job('uploading'), { type: 'cancel', reason: 'canceled' }, ctx()).kind).toBe(
      'delete',
    );
    for (const [state, reason] of [
      ['uploading', 'edited'],
      ['uploading', 'deleted'],
      ['preparing', 'canceled'],
      ['delivering', 'canceled'],
    ] as const) {
      expect(nextJobState(job(state), { type: 'cancel', reason }, ctx())).toMatchObject({
        kind: 'refuse',
        code: 'draft.locked',
      });
    }
  });

  it('cancel releases the target and deletes the uploads the job created', () => {
    const created = [
      { ...PARTS[0], tusUrl: 'https://pv/uploads/c' },
      { ...PARTS[1], tusUrl: null },
    ];
    const t = nextJobState(
      job('failed', { uploadId: 'u1', partsJson: JSON.stringify(created) }),
      { type: 'cancel', reason: 'edited' },
      ctx(),
    );
    expect(t).toEqual({
      kind: 'delete',
      effects: [
        { type: 'deleteUploads', uploadId: 'u1', urls: ['https://pv/uploads/c'] },
        {
          type: 'release',
          request: { uploadId: 'u1', clientKey: 'i:d1:aaaa', reason: 'edited' },
        },
      ],
    });
    // Before any target: nothing to tell anyone.
    expect(nextJobState(job('queued'), { type: 'cancel', reason: 'edited' }, ctx())).toEqual({
      kind: 'delete',
      effects: [],
    });
  });

  it('a renewal mid-upload is the same attempt; a refreshed token writes only its expiry', () => {
    const uploading = job('uploading', {
      attempts: 2,
      artifactId: 'v-0',
      partsJson: JSON.stringify(PARTS.map((p) => ({ ...p, artifactId: `${p.role}-0` }))),
    });
    const renewed = nextJobState(uploading, TARGET, ctx());
    if (renewed.kind !== 'update') throw new Error('expected an update');
    expect(renewed.set).toMatchObject({ attempts: 2, artifactId: 'v-1', bytesSent: 0 });
    expect(JSON.parse(renewed.set.partsJson!)).toEqual([
      { ...PARTS[0], artifactId: 'new-1' },
      { ...PARTS[1], artifactId: 'v-1' },
    ]);
    const refreshed = nextJobState(uploading, { type: 'tokenRefreshed', tokenExp: NOW + 5 }, ctx());
    expect(refreshed).toMatchObject({
      kind: 'update',
      to: 'uploading',
      set: { state: 'uploading', tokenExp: NOW + 5, updatedAt: NOW },
    });
    if (refreshed.kind === 'update') {
      expect(Object.keys(refreshed.set).sort()).toEqual(['state', 'tokenExp', 'updatedAt']);
    }
    for (const state of ['preparing', 'delivering', 'failed', 'needs_credentials'] as const) {
      expect(nextJobState(job(state), { type: 'tokenRefreshed', tokenExp: NOW }, ctx()).kind).toBe(
        'ignore',
      );
    }
  });

  it('a Send refused before its confirm leaves no job', () => {
    expect(nextJobState(job('preparing'), { type: 'sendRefused' }, ctx())).toEqual({
      kind: 'delete',
      effects: [],
    });
    expect(nextJobState(job('queued'), { type: 'sendRefused' }, ctx()).kind).toBe('ignore');
  });

  it('ignores an event its state doesn’t take (a late answer after a cancel)', () => {
    expect(nextJobState(null, TARGET, ctx()).kind).toBe('ignore');
    expect(nextJobState(job('failed'), TARGET, ctx()).kind).toBe('ignore');
    expect(nextJobState(job('queued'), { type: 'resume' }, ctx()).kind).toBe('ignore');
    expect(nextJobState(job('queued'), { type: 'videoDone', parts: [] }, ctx()).kind).toBe(
      'ignore',
    );
    expect(nextJobState(null, { type: 'cancel', reason: 'canceled' }, ctx()).kind).toBe('ignore');
  });

  it('maps a host failure to the event its code calls for', () => {
    const answered = (code: string) => new HostRequestError(code as never, 'x');
    expect(hostErrorEvent(answered('destination.gone'))).toMatchObject({
      type: 'permanentError',
      code: 'destination.gone',
    });
    expect(hostErrorEvent(answered('upload.too_large'))).toMatchObject({
      type: 'permanentError',
      code: 'upload.too_large',
    });
    expect(hostErrorEvent(answered('host_misconfigured'))).toMatchObject({
      type: 'permanentError',
    });
    expect(hostErrorEvent(answered('no_account'))).toMatchObject({
      type: 'credentialsLost',
      code: 'no_account',
    });
    expect(hostErrorEvent(new HostRequestError('host.unavailable', 'x', true))).toMatchObject({
      type: 'credentialsLost',
      code: 'host.unavailable',
    });
    expect(hostErrorEvent(answered('host.unavailable'))).toMatchObject({
      type: 'retryableError',
    });
    expect(hostErrorEvent(new Error('socket hang up'))).toMatchObject({
      type: 'retryableError',
      code: 'upload.failed',
    });
  });
});

// ---- on the database ---------------------------------------------------------------------------

/** The fake host: answers each request with `answer(payload)` (undefined: never answers). */
const asked: HostRequestPayload[] = [];
let answer: (p: HostRequestPayload) => { result?: unknown; error?: unknown } | undefined = () =>
  undefined;

const CLOCK = { id: 'clock.wrapup', version: 1, confirmSend: true, requireOnline: true };
const TICKET = { id: 'ticket.video', version: 1 };

function addDraft(id: string, uploadType: object = TICKET) {
  conn.runSync(
    `INSERT INTO drafts (id, context_key, context_label, context_json, upload_type_json, created_via)
     VALUES (?, 'clock:e1', 'Mon session', ?, ?, 'host')`,
    id,
    JSON.stringify({ kind: 'clock', id: 'e1', label: 'Mon session' }),
    JSON.stringify(uploadType),
  );
  conn.runSync(
    `INSERT INTO segments (id, draft_id, sort_order, original_filename, duration_ms)
     VALUES (?, ?, 0, ?, 4000)`,
    `${id}-s1`,
    id,
    `drafts/${id}/segments/${id}-s1.mp4`,
  );
}
/** An edit: the clip now plays a re-encoded file, so the cut's signature changes. */
function editDraft(id: string) {
  conn.runSync(
    `UPDATE segments SET edited_filename = ?, edited_duration_ms = 2500 WHERE draft_id = ?`,
    `drafts/${id}/segments/${id}-s1.edited.1.mp4`,
    id,
  );
}
const draftRow = (id: string) =>
  conn.getFirstSync('SELECT sent_at, host_confirmed_at FROM drafts WHERE id = ?', id);
const merge = async () => ({ durationMs: 4000 });
/** Let fire-and-forget work (a release after a cancel) reach the fake host. */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
/** Sent, given a target, then back in `queued` after a retryable error: the host holds a target. */
async function queuedWithTarget(id: string, uploadType?: object) {
  addDraft(id, uploadType);
  const sent = await sendDraft(id, merge);
  applyTransition(id, TARGET);
  applyTransition(id, {
    type: 'partsProgress',
    parts: [{ ...PARTS[0], tusUrl: `https://pv/uploads/${id}-c`, done: true }, PARTS[1]],
  });
  applyTransition(id, { type: 'retryableError', code: 'upload.failed', message: 'reset' });
  expect(getUploadJob(id)).toMatchObject({ state: 'queued', uploadId: 'u1' });
  return sent;
}
const releases = () =>
  asked
    .filter((p) => p.method === 'releaseUploadTarget')
    .map((p) => p.args as { clientKey: string; reason: string });

beforeEach(() => {
  conn.execSync('DELETE FROM upload_jobs');
  conn.execSync('DELETE FROM drafts');
  conn.execSync('DELETE FROM local_settings');
  asked.length = 0;
  answer = () => undefined;
  setHostRequestSink((p) => {
    asked.push(p);
    const reply = answer(p);
    if (reply) queueMicrotask(() => respondToHostRequest({ hostCallId: p.hostCallId, ...reply }));
  });
  jest.mocked(writeSendFiles).mockClear();
  jest.mocked(cancelTusUpload).mockClear();
});

afterEach(() => {
  setHostRequestSink(null);
  forgetUploadTokens();
});

describe('sendDraft and cancelJob', () => {
  it('queues a draft whose type asks no confirmation, with its keys and send files', async () => {
    addDraft('d1');
    const before = Date.now();
    const sent = await sendDraft('d1', merge);
    expect(sent.draftKey).toMatch(/^uuid-\d+:d1$/);
    expect(sent.clientKey).toMatch(new RegExp(`^${sent.draftKey}:[0-9a-f]{16}$`));
    expect(sent.sentAt).toBeGreaterThanOrEqual(before);
    expect(writeSendFiles).toHaveBeenCalledWith('d1', 4000);
    expect(asked).toEqual([]);
    const row = getUploadJob('d1');
    expect(row).toMatchObject({
      state: 'queued',
      clientKey: sent.clientKey,
      draftKey: sent.draftKey,
      sentAt: sent.sentAt,
      bytesTotal: 1000,
    });
    expect(JSON.parse(row!.partsJson!).map((p: UploadPart) => p.role)).toEqual([
      'manifest',
      'video',
    ]);
    expect(draftRow('d1')).toMatchObject({ sent_at: sent.sentAt, host_confirmed_at: null });
    // Sending the same cut again changes nothing.
    expect(await sendDraft('d1', merge)).toEqual(sent);
  });

  it('an edit on a queued draft deletes its job; the next Send has a new clientKey, same draftKey', async () => {
    addDraft('d1');
    const first = await sendDraft('d1', merge);
    await renameDraft('d1', 'Monday wrap-up');
    expect(getUploadJob('d1')).toBeNull();
    editDraft('d1');
    const second = await sendDraft('d1', merge);
    expect(second.draftKey).toBe(first.draftKey);
    expect(second.clientKey).not.toBe(first.clientKey);
    expect(getUploadJob('d1')).toMatchObject({ state: 'queued', clientKey: second.clientKey });
  });

  it('edits through drafts.ts take a queued job out and release its target', async () => {
    const renamed = await queuedWithTarget('d1');
    const reordered = await queuedWithTarget('d2');
    const moved = await queuedWithTarget('d3');
    answer = () => ({ result: null });
    asked.length = 0;

    await renameDraft('d1', 'Renamed');
    await reorderSegments(['d2-s1']);
    await setDraftContext('d3', { key: 'clock:e2', label: 'Tue session', kind: 'clock' });

    for (const id of ['d1', 'd2', 'd3']) expect(getUploadJob(id)).toBeNull();
    await settle();
    expect(releases()).toEqual([
      { uploadId: 'u1', clientKey: renamed.clientKey, reason: 'edited' },
      { uploadId: 'u1', clientKey: reordered.clientKey, reason: 'edited' },
      { uploadId: 'u1', clientKey: moved.clientKey, reason: 'edited' },
    ]);
    expect(cancelTusUpload).toHaveBeenCalledWith('https://pv/uploads/d1-c', null);
    // The edits themselves went through.
    expect(conn.getFirstSync(`SELECT name FROM drafts WHERE id = 'd1'`)).toEqual({
      name: 'Renamed',
    });
    expect(conn.getFirstSync(`SELECT context_key FROM drafts WHERE id = 'd3'`)).toEqual({
      context_key: 'clock:e2',
    });
  });

  it('Delete takes the job out through the outbox: the host is told and the uploads deleted', async () => {
    const sent = await queuedWithTarget('d1');
    answer = () => ({ result: null });
    asked.length = 0;

    await deleteDraft('d1');

    expect(getUploadJob('d1')).toBeNull();
    expect(conn.getFirstSync(`SELECT id FROM drafts WHERE id = 'd1'`)).toBeNull();
    await settle();
    expect(releases()).toEqual([{ uploadId: 'u1', clientKey: sent.clientKey, reason: 'deleted' }]);
    expect(cancelTusUpload).toHaveBeenCalledWith('https://pv/uploads/d1-c', null);
  });

  it('an edit while uploading is refused and keeps the job; a clock-bound draft won’t move', async () => {
    addDraft('d1');
    await sendDraft('d1', merge);
    applyTransition('d1', TARGET);
    await expect(renameDraft('d1', 'x')).rejects.toMatchObject({ code: 'draft.locked' });
    await expect(deleteDraft('d1')).rejects.toMatchObject({ code: 'draft.locked' });
    expect(getUploadJob('d1')).toMatchObject({ state: 'uploading' });

    addDraft('d2', CLOCK);
    answer = () => ({ result: { confirmedAt: 1_790_000_000_500 } });
    await sendDraft('d2', merge);
    await expect(
      setDraftContext('d2', { key: 'clock:e2', label: 'Tue session' }),
    ).rejects.toMatchObject({ code: 'draft.locked', reason: 'clock_bound' });
    // The refused move left its Send queued.
    expect(getUploadJob('d2')).toMatchObject({ state: 'queued' });
  });

  it('a refusal before the confirm leaves no job and asks the host nothing', async () => {
    addDraft('d1', CLOCK);
    const stages: string[] = [];
    const tooLarge = Object.assign(new Error('Over 500 bytes'), { code: 'upload.too_large' });
    await expect(
      sendDraft('d1', merge, {
        onStage: (stage) => stages.push(stage),
        beforeConfirm: ({ bytesTotal }) => {
          if (bytesTotal > 500) throw tooLarge;
        },
      }),
    ).rejects.toBe(tooLarge);
    expect(asked).toEqual([]);
    expect(getUploadJob('d1')).toBeNull();
    expect(draftRow('d1')).toMatchObject({ host_confirmed_at: null });
    expect(stages).toEqual(['merging']);

    answer = () => ({ result: { confirmedAt: 1_790_000_000_500 } });
    stages.length = 0;
    await sendDraft('d1', merge, { onStage: (stage) => stages.push(stage) });
    expect(stages).toEqual(['merging', 'confirming', 'queued']);
  });

  it('a launch check while a Send waits on its confirm leaves that Send alone', async () => {
    addDraft('d1', CLOCK);
    let reply: (() => void) | undefined;
    answer = (p) => {
      reply = () =>
        respondToHostRequest({
          hostCallId: p.hostCallId,
          result: { confirmedAt: 1_790_000_000_500 },
        });
      return undefined;
    };
    const sending = sendDraft('d1', merge);
    await settle();
    expect(asked.map((p) => p.method)).toEqual(['confirmSend']);

    expect(recoverInterruptedSends()).toBe(0);
    expect(getUploadJob('d1')).toMatchObject({ state: 'preparing' });

    reply!();
    await sending;
    expect(getUploadJob('d1')).toMatchObject({ state: 'queued' });
    expect(draftRow('d1')).toMatchObject({ host_confirmed_at: 1_790_000_000_500 });
  });

  it('a merge that fails leaves a failed job with export.failed', async () => {
    addDraft('d1');
    await expect(
      sendDraft('d1', async () => {
        throw new Error('encoder died');
      }),
    ).rejects.toThrow('encoder died');
    expect(getUploadJob('d1')).toMatchObject({
      state: 'failed',
      lastErrorCode: 'export.failed',
      lastErrorMessage: 'encoder died',
    });
  });

  it('confirmSend fails: no job, the draft is a draft again and not clock-bound', async () => {
    addDraft('d1', CLOCK);
    answer = () => ({ error: { code: 'upload.refused', message: 'Not clocked in' } });
    await expect(sendDraft('d1', merge)).rejects.toMatchObject({ code: 'upload.refused' });
    expect(asked.map((p) => p.method)).toEqual(['confirmSend']);
    expect(asked[0].args).toMatchObject({
      draftId: 'd1',
      context: { key: 'clock:e1', kind: 'clock', id: 'e1', label: 'Mon session' },
      uploadType: CLOCK,
      bytes: 1000,
    });
    expect(getUploadJob('d1')).toBeNull();
    expect(draftRow('d1')).toMatchObject({ host_confirmed_at: null });
  });

  it('confirmSend succeeds: clock-bound, queued; after an edit the next Send skips it and keeps sentAt', async () => {
    addDraft('d1', CLOCK);
    answer = () => ({ result: { confirmedAt: 1_790_000_000_500 } });
    const first = await sendDraft('d1', merge);
    expect(asked).toHaveLength(1);
    expect(asked[0].args).toMatchObject({ draftKey: first.draftKey, sentAt: first.sentAt });
    expect(getUploadJob('d1')).toMatchObject({ state: 'queued' });
    expect(draftRow('d1')).toMatchObject({
      sent_at: first.sentAt,
      host_confirmed_at: 1_790_000_000_500,
    });

    cancelJob('d1', 'edited');
    editDraft('d1');
    const second = await sendDraft('d1', merge);
    expect(asked).toHaveLength(1);
    expect(second.sentAt).toBe(first.sentAt);
    expect(second.draftKey).toBe(first.draftKey);
    expect(second.clientKey).not.toBe(first.clientKey);
    expect(getUploadJob('d1')).toMatchObject({ state: 'queued', sentAt: first.sentAt });
  });

  it('a host that never answers the confirm leaves the draft unsent', async () => {
    jest.useFakeTimers();
    try {
      addDraft('d1', CLOCK);
      const sending = sendDraft('d1', merge);
      const outcome = expect(sending).rejects.toMatchObject({
        code: 'host.unavailable',
        unanswered: true,
      });
      await jest.advanceTimersByTimeAsync(20_000);
      await outcome;
      expect(getUploadJob('d1')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses an edit or delete while uploading, and anything while delivering', async () => {
    addDraft('d1');
    await sendDraft('d1', merge);
    applyTransition('d1', TARGET);
    expect(() => cancelJob('d1', 'edited')).toThrow(
      expect.objectContaining({ name: 'LibraryError', code: 'draft.locked' }),
    );
    applyTransition('d1', { type: 'videoDone', parts: PARTS });
    expect(() => cancelJob('d1', 'canceled')).toThrow(
      expect.objectContaining({ code: 'draft.locked' }),
    );
    expect(getUploadJob('d1')).toMatchObject({ state: 'delivering' });
  });

  it('Cancel sending tells the host and deletes what was uploaded, with the token in memory', async () => {
    addDraft('d1');
    const sent = await sendDraft('d1', merge);
    // The target, as the job loop gets it: its token stays in memory.
    answer = () => ({
      result: {
        uploadId: 'u1',
        endpoint: 'https://pv',
        artifactId: 'v-1',
        token: 'tok',
        expiresAt: NOW,
        clientKey: sent.clientKey,
      },
    });
    await getUploadTarget({} as never);
    applyTransition('d1', TARGET);
    applyTransition('d1', {
      type: 'partsProgress',
      parts: [{ ...PARTS[0], tusUrl: 'https://pv/uploads/c', done: true }, PARTS[1]],
    });
    // Only the token's expiry is stored.
    expect(conn.getFirstSync('SELECT token_exp FROM upload_jobs')).toEqual({
      token_exp: NOW + 900_000,
    });

    answer = () => ({ result: null });
    asked.length = 0;
    const effects = applyTransition('d1', { type: 'cancel', reason: 'canceled' });
    expect(getUploadJob('d1')).toBeNull();
    if (effects.kind !== 'delete') throw new Error('expected a delete');
    await runJobEffects(effects.effects);
    expect(cancelTusUpload).toHaveBeenCalledWith('https://pv/uploads/c', 'tok');
    expect(asked.map((p) => [p.method, p.args])).toEqual([
      ['releaseUploadTarget', { uploadId: 'u1', clientKey: sent.clientKey, reason: 'canceled' }],
    ]);
  });

  it('at launch, a Send that stopped while preparing is a draft again; paused jobs resume', async () => {
    addDraft('d1');
    addDraft('d2');
    applyTransition('d1', {
      type: 'send',
      clientKey: 'k1',
      draftKey: 'i:d1',
      mergedSignature: 's',
    });
    await sendDraft('d2', merge);
    applyTransition('d2', { type: 'credentialsLost', code: 'no_account', message: 'signed out' });

    expect(recoverInterruptedSends()).toBe(1);
    expect(getUploadJob('d1')).toBeNull();
    expect(resumePausedJobs()).toBe(1);
    expect(getUploadJob('d2')).toMatchObject({ state: 'queued', lastErrorCode: 'no_account' });
  });

  it('writes the job and the draft’s Send columns in one transaction', () => {
    addDraft('d1');
    // A unique-index clash on the insert must leave the draft’s sent_at unwritten too.
    addDraft('d2');
    applyTransition('d2', {
      type: 'send',
      clientKey: 'same',
      draftKey: 'i:d2',
      mergedSignature: 's',
    });
    expect(() =>
      applyTransition('d1', {
        type: 'send',
        clientKey: 'same',
        draftKey: 'i:d1',
        mergedSignature: 's',
      }),
    ).toThrow();
    expect(getUploadJob('d1')).toBeNull();
    expect(draftRow('d1')).toMatchObject({ sent_at: null });
  });
});
