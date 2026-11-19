import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// The real migrations on a node:sqlite stand-in for expo-sqlite, behind the drizzle expo driver.
jest.mock(
  'expo-sqlite',
  () =>
    jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
      '@/test-support/expo-sqlite-node',
    ).mockModule,
);
jest.mock('./client', () => {
  const { readdirSync, readFileSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
  const { join } = jest.requireActual<typeof import('node:path')>('node:path');
  const { SQLiteDatabase } = jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
    '@/test-support/expo-sqlite-node',
  );
  const { drizzle } =
    jest.requireActual<typeof import('drizzle-orm/expo-sqlite')>('drizzle-orm/expo-sqlite');
  const conn = new SQLiteDatabase(':memory:');
  conn.execSync('PRAGMA foreign_keys = ON');
  const dir = join(__dirname, '../../drizzle');
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

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { expoDb } from './client';
import {
  cancelJobForChange,
  getUploadJob,
  isLockedJobState,
  listUploadJobs,
  LOCKED_JOB_STATES,
  notifyUploadJobs,
  parseParts,
  serializeParts,
  setJobCancelHook,
  subscribeUploadJobs,
  type UploadPart,
} from './upload-jobs';
/* eslint-enable import/first */

const conn = expoDb as unknown as {
  execSync: (sql: string) => void;
  runSync: (sql: string, params: unknown[]) => void;
  getAllSync: (sql: string) => unknown[];
  getFirstSync: (sql: string) => unknown;
};

function addDraft(id: string) {
  conn.runSync('INSERT INTO drafts (id) VALUES (?)', [id]);
}
function addJob(draftId: string, state: string, sentAt: number) {
  conn.runSync(
    `INSERT INTO upload_jobs (draft_id, state, client_key, draft_key, merged_signature, sent_at)
     VALUES (?, ?, ?, ?, 'sig', ?)`,
    [draftId, state, `i:${draftId}:k`, `i:${draftId}`, sentAt],
  );
}

const VIDEO: UploadPart = {
  role: 'video',
  artifactId: null,
  file: 'drafts/d1/export.mp4',
  bytes: 10,
  tusUrl: null,
  done: false,
};

beforeEach(() => {
  conn.execSync('DELETE FROM upload_jobs');
  conn.execSync('DELETE FROM drafts');
});

describe('upload_jobs', () => {
  it('reads a draft’s job, or null', () => {
    addDraft('d1');
    expect(getUploadJob('d1')).toBeNull();
    addJob('d1', 'queued', 5);
    expect(getUploadJob('d1')).toMatchObject({
      draftId: 'd1',
      state: 'queued',
      clientKey: 'i:d1:k',
      draftKey: 'i:d1',
      sentAt: 5,
      attempts: 0,
    });
  });

  it('lists jobs oldest Send first, optionally by state', () => {
    for (const [id, state, at] of [
      ['a', 'uploading', 30],
      ['b', 'queued', 10],
      ['c', 'needs_credentials', 20],
    ] as const) {
      addDraft(id);
      addJob(id, state, at);
    }
    expect(listUploadJobs().map((j) => j.draftId)).toEqual(['b', 'c', 'a']);
    expect(listUploadJobs(['uploading', 'queued']).map((j) => j.draftId)).toEqual(['b', 'a']);
    expect(listUploadJobs(['failed'])).toEqual([]);
  });

  it('goes with its draft (the foreign key cascades)', () => {
    addDraft('d1');
    addJob('d1', 'failed', 1);
    conn.execSync("DELETE FROM drafts WHERE id = 'd1'");
    expect(getUploadJob('d1')).toBeNull();
  });

  it('locks a draft while preparing, uploading or delivering only', () => {
    expect([...LOCKED_JOB_STATES]).toEqual(['preparing', 'uploading', 'delivering']);
    for (const state of ['queued', 'needs_credentials', 'failed'] as const) {
      expect(isLockedJobState(state)).toBe(false);
    }
    for (const state of LOCKED_JOB_STATES) expect(isLockedJobState(state)).toBe(true);
  });

  it('round-trips parts_json, and reads a damaged one as no parts', () => {
    const parts: UploadPart[] = [
      { ...VIDEO, role: 'captions', artifactId: 'c1', file: 'drafts/d1/send/captions.vtt' },
      { ...VIDEO, artifactId: 'v1', tusUrl: 'https://pv/uploads/1', done: true },
    ];
    expect(parseParts(serializeParts(parts))).toEqual(parts);
    expect(parseParts(null)).toEqual([]);
    expect(parseParts('{not json')).toEqual([]);
    expect(parseParts(JSON.stringify([{ ...VIDEO, role: 'poster' }]))).toEqual([]);
    expect(parseParts(JSON.stringify({ parts }))).toEqual([]);
  });

  it('tells subscribers which drafts’ jobs changed, until they unsubscribe', () => {
    const heard: (readonly string[])[] = [];
    const stop = subscribeUploadJobs((ids) => heard.push(ids));
    notifyUploadJobs(['d1']);
    notifyUploadJobs([]);
    stop();
    notifyUploadJobs(['d2']);
    expect(heard).toEqual([['d1']]);
  });

  it('an edit hands the job to the installed hook (the outbox’s cancelJob)', () => {
    addDraft('d1');
    addJob('d1', 'queued', 1);
    const calls: [string, string][] = [];
    setJobCancelHook((draftId, reason) => calls.push([draftId, reason]));
    try {
      cancelJobForChange('d1', 'deleted');
    } finally {
      setJobCancelHook(null);
    }
    expect(calls).toEqual([['d1', 'deleted']]);
    // The hook decides; nothing was deleted here.
    expect(getUploadJob('d1')).toMatchObject({ state: 'queued' });
  });

  it('without the outbox loaded, an edit still drops a waiting job, never a locked one', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const heard: (readonly string[])[] = [];
    const stop = subscribeUploadJobs((ids) => heard.push(ids));
    try {
      for (const [id, state] of [
        ['q', 'queued'],
        ['p', 'needs_credentials'],
        ['f', 'failed'],
        ['u', 'uploading'],
      ] as const) {
        addDraft(id);
        addJob(id, state, 1);
        cancelJobForChange(id, 'edited');
      }
    } finally {
      stop();
      warn.mockRestore();
    }
    expect(listUploadJobs().map((j) => j.draftId)).toEqual(['u']);
    expect(heard).toEqual([['q'], ['p'], ['f']]);
  });
});
