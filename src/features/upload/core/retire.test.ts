import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Retirement on the real migrations (node:sqlite behind the drizzle expo driver) and a temp
// documents folder, with `deleteDraftDir` wrapped so a test can stop the process between the
// rows and the files.
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
jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
jest.mock('./send-files', () => ({ writeSendFiles: jest.fn() }));
jest.mock('./tus-client', () => ({ cancelTusUpload: jest.fn(async () => {}) }));
jest.mock('./upload-log', () => ({
  ...jest.requireActual<typeof import('./upload-log')>('./upload-log'),
  uploadLog: { info: () => {}, warn: () => {} },
}));
jest.mock('@/utils/file-store', () => {
  const actual = jest.requireActual<typeof import('@/utils/file-store')>('@/utils/file-store');
  return { ...actual, deleteDraftDir: jest.fn(actual.deleteDraftDir) };
});

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { expoDb } from '@/db/client';
import { getReceipt, RECEIPT_TTL_MS } from '@/db/receipts';
import { getUploadJob, subscribeUploadJobs } from '@/db/upload-jobs';
import { env } from '@/test-support/expo-fs-node';
import { deleteDraftDir } from '@/utils/file-store';
import { dropTakenOut, takeOutSegments } from '@/db/drafts';
import { historyCheckpoint } from '@/db/undo-history';

import { finishRetirements, retireDelivered, retireSentFile } from './retire';
/* eslint-enable import/first */

const conn = expoDb as unknown as {
  runSync: (sql: string, ...params: unknown[]) => void;
  getFirstSync: (sql: string, ...params: unknown[]) => Record<string, unknown> | null;
};
const NOW = 1_790_000_000_000;

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'retire-'));
  env.docDir = join(root, 'doc');
  env.cacheDir = join(root, 'cache');
  mkdirSync(env.docDir, { recursive: true });
  mkdirSync(env.cacheDir, { recursive: true });
});
afterAll(() => rmSync(dirname(env.docDir), { recursive: true, force: true }));

const folder = (id: string) => join(env.docDir, 'drafts', id);

/** A sent draft with two clips and its folder on disk; `state` for its job (none: no job). */
function addDraft(id: string, state: string | null = 'delivering') {
  conn.runSync(
    `INSERT INTO drafts (id, name, context_key, context_label, context_json, upload_type_json,
       created_via, merged_duration_ms, sent_at)
     VALUES (?, NULL, 'ticket:t1', 'Ticket 1', ?, ?, 'host', 6500, ?)`,
    id,
    JSON.stringify({ kind: 'ticket', id: 't1', label: 'Ticket 1' }),
    JSON.stringify({ id: 'ticket.video', version: 1 }),
    NOW - 50_000,
  );
  for (const n of [0, 1]) {
    conn.runSync(
      `INSERT INTO segments (id, draft_id, sort_order, original_filename, duration_ms)
       VALUES (?, ?, ?, ?, 3000)`,
      `${id}-s${n}`,
      id,
      n,
      `drafts/${id}/segments/${n}.mp4`,
    );
  }
  if (state) {
    conn.runSync(
      `INSERT INTO upload_jobs (draft_id, state, client_key, draft_key, merged_signature, sent_at,
         upload_id, artifact_id, endpoint)
       VALUES (?, ?, ?, ?, 'sig', ?, 'up-1', 'vid-1', 'https://pv')`,
      id,
      state,
      `i:${id}:aaaa`,
      `i:${id}`,
      NOW - 60_000,
    );
  }
  mkdirSync(join(folder(id), 'segments'), { recursive: true });
  writeFileSync(join(folder(id), 'export.mp4'), 'video');
  writeFileSync(join(folder(id), 'segments', '0.mp4'), 'clip');
}

const rows = (table: string, id: string) =>
  conn.getFirstSync(
    `SELECT count(*) AS n FROM ${table} WHERE ${table === 'drafts' ? 'id' : 'draft_id'} = ?`,
    id,
  )?.n;

describe('retirement', () => {
  it.each(['live', 'saved Redo', 'active Undo'] as const)(
    'retains a source shared with another draft’s %s and finishes cleanup after its last owner releases it',
    async (owner) => {
      const donor = `shared-donor-${owner.replaceAll(' ', '-')}`;
      const receiver = `shared-receiver-${owner.replaceAll(' ', '-')}`;
      addDraft(donor);
      addDraft(receiver, null);
      const source = `drafts/${donor}/segments/0.mp4`;
      let release = async () => {};
      if (owner === 'saved Redo') {
        const id = `${receiver}-redo`;
        conn.runSync(
          'UPDATE drafts SET undo_history = ? WHERE id = ?',
          JSON.stringify({
            version: 1,
            checkpoint: historyCheckpoint(expoDb, receiver),
            past: [],
            future: [
              {
                kind: 'added',
                ids: [id],
                taken: {
                  draftId: receiver,
                  order: [id],
                  rows: [
                    {
                      id,
                      draftId: receiver,
                      order: 0,
                      label: null,
                      originalFilename: source,
                      durationMs: 1000,
                      editedFilename: null,
                      editedDurationMs: null,
                      editState: null,
                      thumbnail: null,
                      captionEdit: null,
                    },
                  ],
                  transcripts: [],
                },
              },
            ],
          }),
          receiver,
        );
        release = async () => {
          conn.runSync('UPDATE drafts SET undo_history = NULL WHERE id = ?', receiver);
        };
      } else {
        conn.runSync(
          'UPDATE segments SET original_filename = ? WHERE id = ?',
          source,
          `${receiver}-s0`,
        );
        if (owner === 'active Undo') {
          const taken = await takeOutSegments([`${receiver}-s0`]);
          if (!taken) throw new Error('Expected retained addition');
          release = () => dropTakenOut(taken);
        } else
          release = async () => {
            conn.runSync(
              'UPDATE segments SET original_filename = ? WHERE id = ?',
              `drafts/${receiver}/segments/0.mp4`,
              `${receiver}-s0`,
            );
          };
      }
      try {
        expect(retireDelivered(donor, { state: 'done' }, NOW)).toBe(true);
        expect(rows('drafts', donor)).toBe(0);
        expect(existsSync(join(env.docDir, source))).toBe(true);
        expect(existsSync(join(folder(donor), 'export.mp4'))).toBe(false);
        expect(getReceipt(donor)?.mediaDeletedAt).toBeNull();
        finishRetirements(NOW + 1);
        expect(existsSync(join(env.docDir, source))).toBe(true);
        await release();
        finishRetirements(NOW + 10);
        expect(existsSync(folder(donor))).toBe(false);
        expect(getReceipt(donor)?.mediaDeletedAt).toBe(NOW + 10);
      } finally {
        await release();
      }
    },
  );

  it('writes the receipt and deletes the draft in one transaction, then its folder', () => {
    addDraft('d1');
    const changed: string[][] = [];
    const stop = subscribeUploadJobs((ids) => changed.push([...ids]));
    expect(retireDelivered('d1', { state: 'done', note: 'Posted to Ticket 1' }, NOW)).toBe(true);
    stop();

    expect(getReceipt('d1')).toEqual({
      draftId: 'd1',
      name: 'Ticket 1',
      contextKey: 'ticket:t1',
      contextLabel: 'Ticket 1',
      contextJson: JSON.stringify({ kind: 'ticket', id: 't1', label: 'Ticket 1' }),
      uploadTypeJson: JSON.stringify({ id: 'ticket.video', version: 1 }),
      outcome: 'done',
      note: 'Posted to Ticket 1',
      reason: null,
      uploadId: 'up-1',
      artifactId: 'vid-1',
      clientKey: 'i:d1:aaaa',
      clipCount: 2,
      durationMs: 6500,
      sentAt: NOW - 60_000,
      deliveredAt: NOW,
      expiresAt: NOW + RECEIPT_TTL_MS,
      dismissedAt: null,
      mediaDeletedAt: NOW,
    });
    // The cascade took the clips and the job.
    expect([rows('drafts', 'd1'), rows('segments', 'd1'), rows('upload_jobs', 'd1')]).toEqual([
      0, 0, 0,
    ]);
    expect(existsSync(folder('d1'))).toBe(false);
    expect(changed).toEqual([['d1']]);
  });

  it("keeps the host's reason for a kept video", () => {
    addDraft('d-kept');
    retireDelivered('d-kept', { state: 'kept', reason: 'The ticket was closed' }, NOW);
    expect(getReceipt('d-kept')).toMatchObject({
      outcome: 'kept',
      reason: 'The ticket was closed',
      note: null,
    });
  });

  it.each<[string, string | null]>([
    ['queued', 'queued'],
    ['uploading', 'uploading'],
    ['needs_credentials', 'needs_credentials'],
    ['failed', 'failed'],
    ['no job', null],
  ])('writes nothing for a draft whose job is %s', (label, state) => {
    const id = `d-not-${label}`;
    addDraft(id, state);
    expect(retireDelivered(id, { state: 'done' }, NOW)).toBe(false);
    expect(getReceipt(id)).toBeNull();
    expect(rows('drafts', id)).toBe(1);
    expect(existsSync(folder(id))).toBe(true);
  });

  it('a kill between the rows and the files: the next launch deletes the folder', () => {
    addDraft('d-crash');
    jest.mocked(deleteDraftDir).mockImplementationOnce(() => {
      throw new Error('killed');
    });
    expect(retireDelivered('d-crash', { state: 'done' }, NOW)).toBe(true);
    expect(rows('drafts', 'd-crash')).toBe(0);
    expect(getReceipt('d-crash')?.mediaDeletedAt).toBeNull();
    expect(existsSync(folder('d-crash'))).toBe(true);

    expect(finishRetirements(NOW + 10).foldersDeleted).toBeGreaterThanOrEqual(1);
    expect(existsSync(folder('d-crash'))).toBe(false);
    expect(getReceipt('d-crash')?.mediaDeletedAt).toBe(NOW + 10);
  });

  it("deletes no folder that no receipt names (it isn't an orphan sweep)", () => {
    addDraft('d-alive', 'uploading');
    mkdirSync(folder('no-row-at-all'), { recursive: true });
    finishRetirements(NOW);
    expect(existsSync(folder('d-alive'))).toBe(true);
    expect(existsSync(folder('no-row-at-all'))).toBe(true);
  });

  it('receipts expire after 7 days', () => {
    addDraft('d-expire');
    retireDelivered('d-expire', { state: 'done' }, NOW);
    expect(finishRetirements(NOW + RECEIPT_TTL_MS).receiptsExpired).toBe(0);
    expect(getReceipt('d-expire')).not.toBeNull();
    expect(finishRetirements(NOW + RECEIPT_TTL_MS + 1).receiptsExpired).toBeGreaterThanOrEqual(1);
    expect(getReceipt('d-expire')).toBeNull();
  });

  describe("'file' mode (the host stored the MP4)", () => {
    it('retires now with outcome done and no server ids', () => {
      addDraft('d-file', null);
      retireSentFile('d-file', NOW);
      expect(getReceipt('d-file')).toMatchObject({
        outcome: 'done',
        uploadId: '',
        artifactId: '',
        clientKey: '',
        sentAt: NOW - 50_000,
        mediaDeletedAt: NOW,
      });
      expect(existsSync(folder('d-file'))).toBe(false);
    });

    it('refuses a draft whose job locks it, and a draft that is not there', () => {
      addDraft('d-file-locked', 'uploading');
      expect(() => retireSentFile('d-file-locked', NOW)).toThrow(
        expect.objectContaining({ code: 'draft.locked' }),
      );
      expect(getUploadJob('d-file-locked')?.state).toBe('uploading');
      expect(() => retireSentFile('missing', NOW)).toThrow(
        expect.objectContaining({ code: 'not_found' }),
      );
    });
  });
});
