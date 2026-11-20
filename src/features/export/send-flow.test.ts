import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// Export's Send over the real outbox on the real migrations (node:sqlite behind the drizzle expo
// driver), the real host channel answered by a fake host, and the send files and TUS deletes
// stubbed at their modules, as outbox.test.ts does.
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
  const dir = join(__dirname, '../../../drizzle');
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
/** The send files' size: the merged video's bytes, which `maxBytes` is checked against. */
let mockBytes = 1000;
jest.mock('@/features/upload/core/send-files', () => ({
  writeSendFiles: jest.fn(async (draftId: string) => ({
    parts: [
      {
        role: 'video',
        artifactId: null,
        file: `drafts/${draftId}/export.mp4`,
        bytes: mockBytes,
        tusUrl: null,
        done: false,
      },
    ],
    bytesTotal: mockBytes,
  })),
}));
jest.mock('@/features/upload/core/tus-client', () => ({
  cancelTusUpload: jest.fn(async () => {}),
}));
jest.mock('@/features/upload/core/upload-log', () => ({
  ...jest.requireActual<typeof import('@/features/upload/core/upload-log')>(
    '@/features/upload/core/upload-log',
  ),
  uploadLog: { info: () => {}, warn: () => {} },
}));

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { expoDb } from '@/db/client';
import { getUploadJob } from '@/db/upload-jobs';
import {
  forgetUploadTokens,
  respondToHostRequest,
  setHostRequestSink,
  type HostRequestPayload,
} from '@/features/upload/core/host-services';
import { cancelJob, sendDraft } from '@/features/upload/core/outbox';

import { uploadRulesOf } from './send-checks';
import {
  confirmCopy,
  runSend,
  sendLabel,
  wantsConfirm,
  type SendFlowDeps,
  type SendPhase,
} from './send-flow';
/* eslint-enable import/first */

const conn = expoDb as unknown as {
  execSync: (sql: string) => void;
  runSync: (sql: string, ...params: unknown[]) => void;
  getFirstSync: (sql: string, ...params: unknown[]) => Record<string, unknown> | null;
};

const WRAP_UP = {
  id: 'clock.wrapup',
  version: 1,
  sendLabel: 'Clock out & send',
  confirmSend: true,
  requireOnline: true,
};
const PLAN = { id: 'clock.plan', version: 1, confirmSend: true, requireOnline: true };
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

/** The fake host: answers each request with `answer(payload)` (undefined: never answers). */
const asked: HostRequestPayload[] = [];
let answer: (p: HostRequestPayload) => { result?: unknown; error?: unknown } | undefined = () =>
  undefined;
let online = true;
const merge = jest.fn(async () => ({ durationMs: 4000 }));

const deps: SendFlowDeps = {
  isOnline: () => online,
  sendDraft,
  merge,
  confirmedAt: (id) => (draftRow(id)?.host_confirmed_at as number | null) ?? null,
};

/** One Send of `id` as Export runs it, with the draft's stored rules; records its phases. */
async function send(id: string, uploadType: object, name: string | null = null) {
  const phases: SendPhase[] = [];
  const outcome = await runSend(
    { draftId: id, rules: uploadRulesOf(uploadType), name },
    deps,
    (p) => phases.push(p),
  );
  return { outcome, phases };
}

const confirms = () => asked.filter((p) => p.method === 'confirmSend');

beforeEach(() => {
  conn.execSync('DELETE FROM upload_jobs');
  conn.execSync('DELETE FROM drafts');
  asked.length = 0;
  answer = () => undefined;
  online = true;
  mockBytes = 1000;
  merge.mockClear();
  setHostRequestSink((p) => {
    asked.push(p);
    const reply = answer(p);
    if (reply) queueMicrotask(() => respondToHostRequest({ hostCallId: p.hostCallId, ...reply }));
  });
});

afterEach(() => {
  setHostRequestSink(null);
  forgetUploadTokens();
  jest.restoreAllMocks();
});

describe('runSend', () => {
  it('offline, a requireOnline type is refused at the tap: no merge, no confirm, no job', async () => {
    addDraft('d1', WRAP_UP);
    online = false;
    const { outcome, phases } = await send('d1', WRAP_UP);
    expect(outcome).toEqual({ status: 'blocked', block: 'offline' });
    expect(phases).toEqual([]);
    expect(merge).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
    expect(getUploadJob('d1')).toBeNull();
  });

  it('a type without requireOnline sends offline (the job waits in the queue)', async () => {
    addDraft('d1');
    online = false;
    const { outcome } = await send('d1', TICKET);
    expect(outcome).toMatchObject({ status: 'sent' });
    expect(getUploadJob('d1')).toMatchObject({ state: 'queued' });
  });

  it('requireName without a name is refused at the tap', async () => {
    const named = { ...TICKET, requireName: true };
    addDraft('d1', named);
    expect((await send('d1', named)).outcome).toEqual({ status: 'blocked', block: 'name' });
    expect(getUploadJob('d1')).toBeNull();
    expect((await send('d1', named, 'Fix login')).outcome).toMatchObject({ status: 'sent' });
  });

  it('too large: refused before the confirm, nothing queued and nothing clocked', async () => {
    const capped = { ...WRAP_UP, maxBytes: 500 };
    addDraft('d1', capped);
    answer = () => ({ result: { confirmedAt: 1_790_000_000_500 } });
    const { outcome, phases } = await send('d1', capped);
    expect(outcome).toEqual({
      status: 'tooLarge',
      maxBytes: 500,
      text: expect.stringContaining('Too large to send'),
    });
    expect(phases).toEqual(['merging']);
    expect(confirms()).toEqual([]);
    expect(getUploadJob('d1')).toBeNull();
    expect(draftRow('d1')).toMatchObject({ host_confirmed_at: null });
  });

  it('at the cap exactly, it sends', async () => {
    const capped = { ...TICKET, maxBytes: 1000 };
    addDraft('d1', capped);
    expect((await send('d1', capped)).outcome).toMatchObject({ status: 'sent' });
  });

  it('confirm succeeds: clock-bound, queued, and the result carries confirmedAt', async () => {
    addDraft('d1', WRAP_UP);
    answer = () => ({ result: { confirmedAt: 1_790_000_000_500 } });
    const { outcome, phases } = await send('d1', WRAP_UP);
    expect(phases).toEqual(['merging', 'confirming']);
    expect(confirms()).toHaveLength(1);
    const job = getUploadJob('d1');
    expect(job).toMatchObject({ state: 'queued' });
    expect(outcome).toEqual({
      status: 'sent',
      sent: {
        draftId: 'd1',
        clientKey: job!.clientKey,
        draftKey: job!.draftKey,
        sentAt: job!.sentAt,
        confirmedAt: 1_790_000_000_500,
      },
    });
    expect(confirms()[0].args).toMatchObject({ draftKey: job!.draftKey, sentAt: job!.sentAt });
  });

  it('a type without confirmSend never asks the host and has no confirmedAt', async () => {
    addDraft('d1');
    const { outcome, phases } = await send('d1', TICKET);
    expect(phases).toEqual(['merging']);
    expect(asked).toEqual([]);
    expect(outcome.status === 'sent' && 'confirmedAt' in outcome.sent).toBe(false);
  });

  it('confirm fails: confirmFailed, nothing queued, the draft is a draft again', async () => {
    addDraft('d1', WRAP_UP);
    answer = () => ({ error: { code: 'upload.refused', message: 'Not clocked in' } });
    const { outcome, phases } = await send('d1', WRAP_UP);
    expect(outcome).toEqual({ status: 'confirmFailed', message: expect.any(String) });
    expect(phases).toEqual(['merging', 'confirming']);
    expect(getUploadJob('d1')).toBeNull();
    expect(draftRow('d1')).toMatchObject({ host_confirmed_at: null });

    // Try again: the host answers this time.
    answer = () => ({ result: { confirmedAt: 1_790_000_000_900 } });
    const retry = await send('d1', WRAP_UP);
    expect(retry.outcome).toMatchObject({
      status: 'sent',
      sent: { confirmedAt: 1_790_000_000_900 },
    });
    expect(confirms()).toHaveLength(2);
  });

  it('a merge that fails is failed, not a confirm failure, and the host is never asked', async () => {
    addDraft('d1', WRAP_UP);
    merge.mockRejectedValueOnce(new Error('encoder died'));
    const { outcome } = await send('d1', WRAP_UP);
    expect(outcome).toEqual({ status: 'failed', message: 'encoder died' });
    expect(confirms()).toEqual([]);
  });

  it('Edit → Send on a confirmed draft skips the confirm and keeps the original sentAt', async () => {
    addDraft('d1', WRAP_UP);
    answer = () => ({ result: { confirmedAt: 1_790_000_000_500 } });
    const first = await send('d1', WRAP_UP);
    if (first.outcome.status !== 'sent') throw new Error('first Send failed');

    cancelJob('d1', 'edited');
    editDraft('d1');
    jest.spyOn(Date, 'now').mockReturnValue(first.outcome.sent.sentAt + 45 * 60_000);
    const second = await send('d1', WRAP_UP);
    expect(second.phases).toEqual(['merging']);
    expect(confirms()).toHaveLength(1);
    expect(second.outcome).toMatchObject({
      status: 'sent',
      sent: {
        sentAt: first.outcome.sent.sentAt,
        draftKey: first.outcome.sent.draftKey,
        confirmedAt: 1_790_000_000_500,
      },
    });
    expect(second.outcome.status === 'sent' && second.outcome.sent.clientKey).not.toBe(
      first.outcome.sent.clientKey,
    );
  });

  it('an unconfirmed draft’s next Send stamps a fresh sentAt (never one older than the tap)', async () => {
    addDraft('d1', WRAP_UP);
    const t1 = 1_790_000_000_000;
    const t2 = t1 + 45 * 60_000; // past the server's 30-minute clamp
    const now = jest.spyOn(Date, 'now').mockReturnValue(t1);
    answer = () => ({ error: { code: 'host.unavailable', message: 'offline' } });
    expect((await send('d1', WRAP_UP)).outcome.status).toBe('confirmFailed');
    expect(confirms()[0].args).toMatchObject({ sentAt: t1 });

    now.mockReturnValue(t2);
    answer = () => ({ result: { confirmedAt: t2 + 300 } });
    const retry = await send('d1', WRAP_UP);
    expect(confirms()[1].args).toMatchObject({ sentAt: t2 });
    expect(retry.outcome).toMatchObject({ status: 'sent', sent: { sentAt: t2 } });
  });

  it('a draft never confirmed (no confirmSend) also stamps a fresh sentAt after an edit', async () => {
    addDraft('d1');
    const t1 = 1_790_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t1);
    expect((await send('d1', TICKET)).outcome).toMatchObject({ sent: { sentAt: t1 } });
    cancelJob('d1', 'edited');
    editDraft('d1');
    now.mockReturnValue(t1 + 60 * 60_000);
    expect((await send('d1', TICKET)).outcome).toMatchObject({
      sent: { sentAt: t1 + 60 * 60_000 },
    });
  });
});

describe('Send copy', () => {
  it('the primary action: the type’s sendLabel, else "Send to <place>", else "Send"', () => {
    expect(sendLabel(uploadRulesOf(WRAP_UP), 'Mon session')).toBe('Clock out & send');
    expect(sendLabel(uploadRulesOf(TICKET), 'Fix login')).toBe('Send to Fix login');
    expect(sendLabel(uploadRulesOf(TICKET), '  ')).toBe('Send');
    expect(sendLabel(null, null)).toBe('Send');
  });

  it('clock types say what the confirm does; other confirm types are neutral', () => {
    expect(confirmCopy(WRAP_UP)).toEqual({
      confirming: 'Clocking out…',
      failed: 'Couldn’t clock out. Your video is saved.',
      keepDraft: 'Keep draft (you’re still clocked in)',
    });
    expect(confirmCopy(PLAN)).toMatchObject({
      confirming: 'Clocking in…',
      failed: 'Couldn’t clock in. Your video is saved.',
      keepDraft: 'Keep draft (you’re still clocked out)',
    });
    // A clock id without confirmSend asks nothing, so it says nothing about clocks.
    expect(confirmCopy({ ...WRAP_UP, confirmSend: false }).keepDraft).toBe('Keep draft');
    expect(confirmCopy({ id: 'other', version: 1, confirmSend: true }).confirming).toBe('Sending…');
    expect(confirmCopy(null).keepDraft).toBe('Keep draft');
    expect(wantsConfirm(WRAP_UP)).toBe(true);
    expect(wantsConfirm(TICKET)).toBe(false);
  });
});
