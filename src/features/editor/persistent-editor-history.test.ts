import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
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
jest.mock('@/utils/video', () => ({ generateThumbnailFile: async () => false }));
jest.mock('@/features/transcription/clip-queue', () => ({ dropClipJobs: () => {} }));
jest.mock('@/db/secure-token', () => ({ deleteSavedLink: async () => {} }));
jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: () => `undo-draft-${++n}` };
});

/* eslint-disable import/first -- Register native stand-ins before loading the real persistence. */
import { waitForUndoHistory } from '@/core/undo-write-barrier';
import { expectClipsAdded } from '@/core/clip-anchor';
import { clearUndoAdditionBatch, markUndoAdditionBatch } from '@/core/undo-additions';
import { trackDraftWrite, writeEdit, writeOrder } from '@/features/editor/draft-writes';
import type { Present, SnapshotDiff } from '@/features/editor/editor-history';
import { HISTORY_MAX_MEDIA_BYTES, parsePersistedHistory } from '@/db/persisted-history';
import { env } from '@/test-support/expo-fs-node';
import { setCaptionEdits, setCaptionY } from '@/db/captions';
import { expoDb } from '@/db/client';
import { addSegment, createDraft, deleteSegment } from '@/db/drafts';
import * as draftFunctions from '@/db/drafts';
import * as fileStore from '@/utils/file-store';
import { renderKey } from '@/utils/segment-window';
import { dropHeldFiles } from '@/db/held-files';
import { referencedMediaPaths } from '@/db/media-refs';
import { historyCheckpoint } from '@/db/undo-history';
import { editorUndoSession, hasRetainedUndo } from './persistent-editor-history';
/* eslint-enable import/first */

const root = mkdtempSync(join(tmpdir(), 'pulse-persistent-undo-'));
Object.assign(env, { docDir: join(root, 'Documents'), cacheDir: join(root, 'Caches') });
mkdirSync(env.docDir, { recursive: true });
mkdirSync(env.cacheDir, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const conn = expoDb as unknown as {
  execSync: (sql: string) => void;
  runSync: (sql: string, ...params: unknown[]) => unknown;
  getAllSync: <T>(sql: string, ...params: unknown[]) => T[];
  getFirstSync: <T>(sql: string, ...params: unknown[]) => T | null;
};
const speedEdit = JSON.stringify({
  startMs: 0,
  endMs: 1000,
  rotation: 0,
  flipped: false,
  crop: null,
  muted: false,
  speed: 2,
});
const saved = (draftId: string) =>
  parsePersistedHistory(
    conn.getFirstSync<{ value: string | null }>(
      'SELECT undo_history AS value FROM drafts WHERE id = ?',
      draftId,
    )?.value,
    draftId,
  );
const clipRows = (draftId: string) =>
  conn.getAllSync<{
    id: string;
    editState: string | null;
    captionEdit: string | null;
  }>(
    'SELECT id, edit_state AS editState, caption_edit AS captionEdit FROM segments WHERE draft_id = ? ORDER BY sort_order',
    draftId,
  );
function present(draftId: string): Present {
  const rows = clipRows(draftId);
  return {
    clips: rows.map((row) => ({ id: row.id, editKey: row.editState })),
    captions: new Map(rows.map((row) => [row.id, row.captionEdit])),
    captionY:
      conn.getFirstSync<{ value: number | null }>(
        'SELECT caption_y AS value FROM drafts WHERE id = ?',
        draftId,
      )?.value ?? null,
  };
}
function apply(draftId: string, diff: SnapshotDiff) {
  for (const [id, value] of diff.edits) writeEdit(id, value, draftId);
  if (diff.order) writeOrder(diff.order, draftId);
  if (diff.captions.size) void trackDraftWrite(draftId, setCaptionEdits(diff.captions));
  if (diff.captionY !== undefined)
    void trackDraftWrite(draftId, setCaptionY(draftId, diff.captionY));
}
function file(draftId: string, id: string) {
  const relative = `drafts/${draftId}/segments/${id}.mp4`;
  const absolute = join(env.docDir, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, id);
  return { relative, absolute };
}
async function add(draftId: string, suffix: string) {
  const id = `${draftId}-${suffix}`;
  const media = file(draftId, id);
  await addSegment(draftId, { id, originalFilename: media.relative, durationMs: 1000 });
  return { id, ...media };
}
const closeCallbacks = new Set<() => void>();
function open(draftId: string) {
  const session = editorUndoSession(draftId);
  const failed = jest.fn();
  const close = session.open(failed);
  closeCallbacks.add(close);
  return {
    session,
    store: session.store,
    failed,
    close: async () => {
      closeCallbacks.delete(close);
      close();
      await waitForUndoHistory();
      await Promise.resolve();
    },
  };
}
afterEach(async () => {
  jest.restoreAllMocks();
  conn.execSync('DROP TRIGGER IF EXISTS reject_undo_checkpoint');
  for (const close of closeCallbacks) close();
  closeCallbacks.clear();
  await waitForUndoHistory();
});

describe('persistent editor Undo on a migrated library', () => {
  it('keeps earlier edits and invalidates Redo when a recorder adds clips after the editor retires', async () => {
    const draftId = await createDraft();
    const a = await add(draftId, 'a');
    const first = open(draftId);
    first.store.record(present(draftId), null);
    writeEdit(a.id, speedEdit, draftId);
    await waitForUndoHistory();
    const x = await add(draftId, 'x');
    first.store.undo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();
    const before = saved(draftId)!;
    expect(before.future).toHaveLength(1);
    await first.close();

    const y = await add(draftId, 'y');
    const after = saved(draftId)!;
    expect(after.past.slice(0, -1)).toEqual(before.past);
    expect(after.past.at(-1)).toMatchObject({ kind: 'added', ids: [y.id] });
    expect(after.future).toEqual([]);
    expect(existsSync(x.absolute)).toBe(false);
    const reopened = open(draftId);
    reopened.store.undo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();
    expect(clipRows(draftId).map((row) => row.id)).toEqual([a.id]);
    reopened.store.undo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();
    expect(clipRows(draftId)[0].editState).toBeNull();
  });

  it('commits an armed editor’s addition before its UI journal drains or the editor closes', async () => {
    const draftId = await createDraft();
    const a = await add(draftId, 'a');
    const first = open(draftId);
    const stop = expectClipsAdded(draftId);
    const x = await add(draftId, 'x');
    // No recordAdded/takeClipsAdded call: the database owns durability before UI effects run.
    expect(saved(draftId)?.past.at(-1)).toMatchObject({ kind: 'added', ids: [x.id] });
    await first.close();
    stop();

    const reopened = open(draftId);
    reopened.store.undo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();
    expect(clipRows(draftId).map((row) => row.id)).toEqual([a.id]);
    expect(existsSync(x.absolute)).toBe(true);
  });

  it('rolls back new clip rows and counters when their addition checkpoint cannot commit', async () => {
    const draftId = await createDraft();
    await add(draftId, 'a');
    const beforeRows = clipRows(draftId);
    const beforeHistory = saved(draftId);
    const beforeCounter = conn.getFirstSync(
      'SELECT last_clip_number FROM drafts WHERE id = ?',
      draftId,
    );
    conn.execSync(
      `CREATE TRIGGER reject_undo_checkpoint BEFORE UPDATE OF undo_history ON drafts BEGIN SELECT RAISE(ABORT, 'addition checkpoint failed'); END`,
    );

    await expect(add(draftId, 'failed')).rejects.toThrow();
    expect(clipRows(draftId)).toEqual(beforeRows);
    expect(saved(draftId)).toEqual(beforeHistory);
    expect(conn.getFirstSync('SELECT last_clip_number FROM drafts WHERE id = ?', draftId)).toEqual(
      beforeCounter,
    );
  });

  it('extends an image batch below intervening edits before its journal drains, without duplicating steps', async () => {
    const draftId = await createDraft();
    const a = await add(draftId, 'a');
    const first = open(draftId);
    const key = 'atomic-images';
    await first.store.beginBatch(key);
    markUndoAdditionBatch(draftId, `${draftId}-x`, key);
    const x = await add(draftId, 'x');
    first.store.record(present(draftId), null);
    writeEdit(a.id, speedEdit, draftId);
    await waitForUndoHistory();
    markUndoAdditionBatch(draftId, `${draftId}-y`, key);
    const y = await add(draftId, 'y');

    expect(saved(draftId)?.past.map((step) => step.kind)).toEqual(['added', 'added', 'state']);
    expect(saved(draftId)?.past[1]).toMatchObject({ ids: [x.id, y.id], batchKey: key });
    first.store.recordAdded([x.id, y.id], [], key);
    expect(first.store.getState().past).toHaveLength(3);
    first.store.endBatch(key);
    clearUndoAdditionBatch(draftId, key);
    await waitForUndoHistory();
    first.store.undo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();
    expect(clipRows(draftId)[0].editState).toBeNull();
    first.store.undo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();
    expect(clipRows(draftId).map((row) => row.id)).toEqual([a.id]);
  });

  it('keeps recorder grouping and standalone split journal delivery idempotent', async () => {
    const draftId = await createDraft();
    const a = await add(draftId, 'a');
    const first = open(draftId);
    const x = await add(draftId, 'x');
    const y = await add(draftId, 'y');
    first.store.recordAdded([x.id, y.id]);
    await waitForUndoHistory();
    expect(saved(draftId)?.past).toHaveLength(2);
    first.store.undo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();
    expect(clipRows(draftId).map((row) => row.id)).toEqual([a.id]);
    const [row] = await draftFunctions.segmentsForDraft(draftId);
    const receipt = await draftFunctions.splitSegment(draftId, {
      before: a.id,
      split: {
        sourceMs: 500,
        offsetMs: 500,
        rightId: `${draftId}-right`,
        sourceKey: renderKey(row),
      },
    });
    expect(saved(draftId)?.past).toHaveLength(2);
    first.store.recordAdded([], [receipt]);
    expect(first.store.getState().past).toHaveLength(2);
    first.store.undo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();
    expect(clipRows(draftId).map((row) => row.id)).toEqual([a.id]);
  });

  it('rejects a matching saved checkpoint whose addition names another draft’s live clip', async () => {
    const draftA = await createDraft();
    const a = await add(draftA, 'a');
    const draftB = await createDraft();
    const b = await add(draftB, 'b');
    const beforeA = clipRows(draftA);
    const beforeB = clipRows(draftB);
    conn.runSync(
      'UPDATE drafts SET undo_history = ? WHERE id = ?',
      JSON.stringify({
        version: 1,
        checkpoint: historyCheckpoint(expoDb, draftA),
        past: [{ kind: 'added', ids: [b.id], taken: null }],
        future: [],
      }),
      draftA,
    );
    jest.spyOn(console, 'warn').mockImplementationOnce(() => {});

    const editorA = open(draftA);
    expect(editorA.store.getState().past).toEqual([]);
    await waitForUndoHistory();
    expect(saved(draftA)).toBeNull();
    expect(clipRows(draftA)).toEqual(beforeA);
    expect(clipRows(draftB)).toEqual(beforeB);
    expect(existsSync(a.absolute)).toBe(true);
    expect(existsSync(b.absolute)).toBe(true);
  });

  it('rejects a foreign structural clip ID introduced after a valid session hydrates', async () => {
    const draftA = await createDraft();
    const a = await add(draftA, 'a');
    const original = open(draftA);
    original.store.recordAdded([a.id]);
    await waitForUndoHistory();
    await original.close();
    const draftB = await createDraft();
    const b = await add(draftB, 'b');
    const editorA = open(draftA);
    await waitForUndoHistory();
    const step = editorA.store.getState().past.at(-1);
    if (step?.kind !== 'added') throw new Error('Expected the hydrated addition.');
    const beforeA = clipRows(draftA);
    const beforeB = clipRows(draftB);
    step.ids = [b.id];

    editorA.store.undo(present(draftA), (diff) => apply(draftA, diff));
    await editorA.store.settled();
    expect(editorA.failed).toHaveBeenCalledWith('undo', expect.anything());
    expect(clipRows(draftA)).toEqual(beforeA);
    expect(clipRows(draftB)).toEqual(beforeB);
    expect(existsSync(a.absolute)).toBe(true);
    expect(existsSync(b.absolute)).toBe(true);
    // Leave the fixture's saved state valid for the next simulated library launch.
    step.ids = [a.id];
    editorA.store.close();
    await waitForUndoHistory();
  });

  it('restores both edit stacks from disk after each editor session retires', async () => {
    const draftId = await createDraft();
    const a = await add(draftId, 'a');
    const first = open(draftId);
    first.store.record(present(draftId), null);
    writeEdit(a.id, speedEdit, draftId);
    await waitForUndoHistory();
    expect(saved(draftId)?.past).toHaveLength(2);
    await first.close();

    const reopened = open(draftId);
    expect(reopened.session).not.toBe(first.session);
    reopened.store.undo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();
    expect(clipRows(draftId)[0].editState).toBeNull();
    expect(saved(draftId)?.future).toHaveLength(1);
    await reopened.close();

    const restarted = open(draftId);
    restarted.store.redo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();
    expect(JSON.parse(clipRows(draftId)[0].editState!).speed).toBe(2);
    expect(saved(draftId)?.past).toHaveLength(2);
    expect(saved(draftId)?.future).toHaveLength(0);
  });

  it('keeps an undone addition recoverable after deleting A and reopening an empty draft', async () => {
    const draftId = await createDraft();
    const a = await add(draftId, 'a');
    const first = open(draftId);
    const x = await add(draftId, 'x');
    const captionEdit = JSON.stringify({
      file: x.relative,
      words: [{ text: 'kept', t0: 0, t1: 40 }],
    });
    conn.runSync(
      'UPDATE segments SET edit_state = ?, caption_edit = ? WHERE id = ?',
      speedEdit,
      captionEdit,
      x.id,
    );
    conn.runSync(
      'INSERT INTO clip_transcripts (segment_id, model, file, status, words, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      x.id,
      'tiny',
      x.relative,
      'done',
      '[{"text":"transcript"}]',
      1,
    );
    first.store.recordAdded([x.id]);
    await waitForUndoHistory();
    await deleteSegment(a.id);
    first.store.undo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();
    expect(clipRows(draftId)).toEqual([]);
    expect(hasRetainedUndo(draftId)).toBe(true);
    await first.close();
    dropHeldFiles(referencedMediaPaths(expoDb));
    expect(existsSync(x.absolute)).toBe(true);

    const reopened = open(draftId);
    expect(reopened.store.getState().keepEmptyOpen).toBe(true);
    reopened.store.redo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();
    expect(clipRows(draftId)).toEqual([{ id: x.id, editState: speedEdit, captionEdit }]);
    expect(
      conn.getFirstSync<{ words: string }>(
        'SELECT words FROM clip_transcripts WHERE segment_id = ?',
        x.id,
      )?.words,
    ).toBe('[{"text":"transcript"}]');
    expect(existsSync(x.absolute)).toBe(true);
  });

  it.each(['undo', 'redo'] as const)(
    'rolls back addition %s if its atomic checkpoint fails',
    async (direction) => {
      const draftId = await createDraft();
      const first = open(draftId);
      const x = await add(draftId, 'x');
      first.store.recordAdded([x.id]);
      await waitForUndoHistory();
      if (direction === 'redo') {
        first.store.undo(present(draftId), (diff) => apply(draftId, diff));
        await waitForUndoHistory();
      }
      const beforeRows = clipRows(draftId);
      const beforeHistory = saved(draftId);
      conn.execSync(
        `CREATE TRIGGER reject_undo_checkpoint BEFORE UPDATE OF undo_history ON drafts BEGIN SELECT RAISE(ABORT, 'checkpoint failed'); END`,
      );
      first.store[direction](present(draftId), (diff) => apply(draftId, diff));
      await first.store.settled();
      expect(clipRows(draftId)).toEqual(beforeRows);
      expect(saved(draftId)).toEqual(beforeHistory);
      expect(first.failed).toHaveBeenCalledWith(direction, expect.anything());
      expect(existsSync(x.absolute)).toBe(true);
      conn.execSync('DROP TRIGGER reject_undo_checkpoint');
      await waitForUndoHistory();
    },
  );

  it('discards an interrupted ordinary-write checkpoint without changing current rows', async () => {
    const draftId = await createDraft();
    const a = await add(draftId, 'a');
    const first = open(draftId);
    first.store.record(present(draftId), null);
    writeEdit(a.id, speedEdit, draftId);
    await waitForUndoHistory();
    await first.close();
    conn.runSync('UPDATE segments SET edit_state = NULL WHERE id = ?', a.id);

    const reopened = open(draftId);
    expect(reopened.store.getState().past).toEqual([]);
    await waitForUndoHistory();
    expect(clipRows(draftId)[0].editState).toBeNull();
    expect(saved(draftId)).toBeNull();
  });

  it('does not checkpoint optimistic stacks after a queued caption write fails', async () => {
    const draftId = await createDraft();
    await add(draftId, 'a');
    const first = open(draftId);
    await waitForUndoHistory();
    first.store.record(present(draftId), null);
    await trackDraftWrite(draftId, Promise.reject(new Error('caption disk failure'))).catch(
      () => {},
    );
    await waitForUndoHistory();
    expect(first.store.getState().past).toEqual([]);
    expect(saved(draftId)).toBeNull();
  });

  it.each(['edit', 'order', 'caption', 'position'] as const)(
    'invalidates only draft A when its %s fails, preserving draft B’s saved Redo and video',
    async (operation) => {
      const draftA = await createDraft();
      const a = await add(draftA, 'a');
      const a2 = await add(draftA, 'a2');
      const editorA = open(draftA);
      const draftB = await createDraft();
      const editorB = open(draftB);
      const b = await add(draftB, 'b');
      editorB.store.recordAdded([b.id]);
      await waitForUndoHistory();
      editorB.store.undo(present(draftB), (diff) => apply(draftB, diff));
      await waitForUndoHistory();
      const beforeB = saved(draftB);
      expect(beforeB?.future).toHaveLength(1);

      editorA.store.record(present(draftA), null);
      switch (operation) {
        case 'edit':
          writeEdit(a.id, 'unusable edit', draftA);
          break;
        case 'order':
          conn.execSync(
            `CREATE TRIGGER reject_undo_checkpoint BEFORE UPDATE OF sort_order ON segments WHEN OLD.draft_id = '${draftA}' BEGIN SELECT RAISE(ABORT, 'order write failed'); END`,
          );
          writeOrder([a2.id, a.id], draftA);
          break;
        case 'caption':
          conn.execSync(
            `CREATE TRIGGER reject_undo_checkpoint BEFORE UPDATE OF caption_edit ON segments WHEN OLD.draft_id = '${draftA}' BEGIN SELECT RAISE(ABORT, 'caption write failed'); END`,
          );
          await trackDraftWrite(
            draftA,
            setCaptionEdits(new Map([[a.id, JSON.stringify({ file: a.relative, words: [] })]])),
          ).catch(() => {});
          break;
        case 'position':
          conn.execSync(
            `CREATE TRIGGER reject_undo_checkpoint BEFORE UPDATE OF caption_y ON drafts WHEN OLD.id = '${draftA}' BEGIN SELECT RAISE(ABORT, 'caption position write failed'); END`,
          );
          await trackDraftWrite(draftA, setCaptionY(draftA, 0.7)).catch(() => {});
          break;
      }
      await waitForUndoHistory();
      expect(editorA.store.getState().past).toEqual([]);
      expect(saved(draftA)).toBeNull();
      // Closing B forces another checkpoint after A's failure, where a global failure epoch
      // would have discarded B's unrelated dormant addition and its media.
      await editorB.close();
      expect(saved(draftB)).toEqual(beforeB);
      expect(existsSync(b.absolute)).toBe(true);

      const reopenedB = open(draftB);
      expect(reopenedB.store.getState().future).toHaveLength(1);
      reopenedB.store.redo(present(draftB), (diff) => apply(draftB, diff));
      await waitForUndoHistory();
      expect(clipRows(draftB).map((row) => row.id)).toEqual([b.id]);
      expect(existsSync(b.absolute)).toBe(true);
    },
  );

  it('evicts a dormant redo whose source video is missing on reopen', async () => {
    const draftId = await createDraft();
    const first = open(draftId);
    const x = await add(draftId, 'x');
    first.store.recordAdded([x.id]);
    await waitForUndoHistory();
    first.store.undo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();
    await first.close();
    rmSync(x.absolute);

    const reopened = open(draftId);
    expect(reopened.store.getState().future).toEqual([]);
    await waitForUndoHistory();
    expect(saved(draftId)).toBeNull();
    expect(clipRows(draftId)).toEqual([]);
  });

  it('reuses an in-flight Undo when the editor closes and immediately reopens', async () => {
    const draftId = await createDraft();
    const first = open(draftId);
    const x = await add(draftId, 'x');
    first.store.recordAdded([x.id]);
    await waitForUndoHistory();
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const original = draftFunctions.takeOutSegments;
    jest.spyOn(draftFunctions, 'takeOutSegments').mockImplementation(async (...args) => {
      await pending;
      return original(...args);
    });

    first.store.undo(present(draftId), (diff) => apply(draftId, diff));
    const closing = first.close();
    const reopened = open(draftId);
    expect(reopened.session).toBe(first.session);
    complete();
    await closing;
    await waitForUndoHistory();

    expect(clipRows(draftId)).toEqual([]);
    expect(saved(draftId)?.future).toHaveLength(1);
    expect(reopened.store.getState().future).toHaveLength(1);
    expect(existsSync(x.absolute)).toBe(true);
  });

  it('releases redo-only files after a new addition invalidates a reopened redo stack', async () => {
    const draftId = await createDraft();
    const first = open(draftId);
    const x = await add(draftId, 'x');
    first.store.recordAdded([x.id]);
    await waitForUndoHistory();
    first.store.undo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();
    await first.close();

    const reopened = open(draftId);
    const y = await add(draftId, 'y');
    reopened.store.recordAdded([y.id]);
    await waitForUndoHistory();

    expect(existsSync(x.absolute)).toBe(false);
    expect(existsSync(y.absolute)).toBe(true);
    expect(saved(draftId)?.future).toHaveLength(0);
    expect(clipRows(draftId).map((row) => row.id)).toEqual([y.id]);
  });

  it('journals evicted redo media again if a launch already cleared its original cleanup note', async () => {
    const draftId = await createDraft();
    const first = open(draftId);
    const x = await add(draftId, 'x');
    first.store.recordAdded([x.id]);
    await waitForUndoHistory();
    first.store.undo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();
    await first.close();

    // Launch retains saved Redo's file but consumes the earlier take-out cleanup journal.
    dropHeldFiles(referencedMediaPaths(expoDb));
    expect(existsSync(x.absolute)).toBe(true);
    expect(
      conn.getFirstSync('SELECT value FROM settings WHERE key = ?', 'drafts.heldForRedo'),
    ).toBeNull();
    const reopened = open(draftId);
    await waitForUndoHistory();
    // Simulate stopping after the replacement checkpoint and before either cleanup runs.
    const dropTaken = jest.spyOn(draftFunctions, 'dropTakenOut').mockResolvedValue();
    const dropFiles = jest.spyOn(draftFunctions, 'dropHistoryFiles').mockResolvedValue();
    const deleteFile = jest.spyOn(fileStore, 'deleteSegmentFile').mockImplementation(() => {});
    const y = await add(draftId, 'y');
    reopened.store.recordAdded([y.id]);
    await waitForUndoHistory();

    expect(saved(draftId)?.future).toHaveLength(0);
    expect(existsSync(x.absolute)).toBe(true);
    const journal = conn.getFirstSync<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?',
      'drafts.heldForRedo',
    );
    expect(JSON.parse(journal?.value ?? '[]')).toContain(x.relative);
    dropTaken.mockRestore();
    dropFiles.mockRestore();
    deleteFile.mockRestore();

    dropHeldFiles(referencedMediaPaths(expoDb));
    expect(existsSync(x.absolute)).toBe(false);
    expect(existsSync(y.absolute)).toBe(true);
  });

  it('evicts oversized dormant video and releases its hold after the replacement checkpoint', async () => {
    const draftId = await createDraft();
    const first = open(draftId);
    const x = await add(draftId, 'x');
    // Sparse fixture: exercise real file sizes without allocating or reading a large video.
    truncateSync(x.absolute, HISTORY_MAX_MEDIA_BYTES + 1);
    first.store.recordAdded([x.id]);
    await waitForUndoHistory();
    expect(existsSync(x.absolute)).toBe(true);

    first.store.undo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();

    expect(first.store.getState().future).toEqual([]);
    expect(saved(draftId)).toBeNull();
    expect(hasRetainedUndo(draftId)).toBe(false);
    expect(existsSync(x.absolute)).toBe(false);
  });

  it('retains a closed image batch until its final commit, then checkpoints and retires it', async () => {
    const draftId = await createDraft();
    const first = open(draftId);
    const batch = 'import-images';
    await first.store.beginBatch(batch);
    const x = await add(draftId, 'x');
    first.store.recordAdded([x.id], [], batch);
    await waitForUndoHistory();
    await first.close();

    expect(editorUndoSession(draftId)).toBe(first.session);
    expect(first.store.getState().batchOpen).toBe(true);
    // An image already preparing can finish after React closes the editor.
    const y = await add(draftId, 'y');
    first.store.recordAdded([y.id], [], batch);
    first.store.endBatch(batch);
    await waitForUndoHistory();

    const reopened = open(draftId);
    expect(reopened.session).not.toBe(first.session);
    expect(reopened.store.getState().batchOpen).toBe(false);
    expect(saved(draftId)?.past).toHaveLength(1);
    expect(saved(draftId)?.past[0]).toMatchObject({ kind: 'added', ids: [x.id, y.id] });
    reopened.store.undo(present(draftId), (diff) => apply(draftId, diff));
    await waitForUndoHistory();
    expect(clipRows(draftId)).toEqual([]);
    expect(existsSync(x.absolute)).toBe(true);
    expect(existsSync(y.absolute)).toBe(true);
  });

  it.each(['caption', 'transcript'] as const)(
    'keeps history cleanup from deleting a file referenced only by a live %s',
    async (reference) => {
      const draftId = await createDraft();
      const a = await add(draftId, 'a');
      const retained = file(draftId, `${draftId}-earlier-source`);
      if (reference === 'caption') {
        await setCaptionEdits(
          new Map([[a.id, JSON.stringify({ file: retained.relative, words: [] })]]),
        );
      } else {
        conn.runSync(
          'INSERT INTO clip_transcripts (segment_id, model, file, status, words, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          a.id,
          'tiny',
          retained.relative,
          'done',
          '[]',
          1,
        );
      }

      await draftFunctions.dropHistoryFiles([retained.relative]);
      expect(existsSync(retained.absolute)).toBe(true);

      if (reference === 'caption') await setCaptionEdits(new Map([[a.id, null]]));
      else conn.runSync('DELETE FROM clip_transcripts WHERE segment_id = ?', a.id);
      await draftFunctions.dropHistoryFiles([retained.relative]);
      expect(existsSync(retained.absolute)).toBe(false);
      expect(existsSync(a.absolute)).toBe(true);
    },
  );
});
