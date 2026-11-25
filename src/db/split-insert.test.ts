import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
  const path = jest.requireActual<typeof import('node:path')>('node:path');
  const { SQLiteDatabase } = jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
    '@/test-support/expo-sqlite-node',
  );
  const { drizzle } =
    jest.requireActual<typeof import('drizzle-orm/expo-sqlite')>('drizzle-orm/expo-sqlite');
  const conn = new SQLiteDatabase(':memory:');
  conn.execSync('PRAGMA foreign_keys = ON');
  const dir = path.join(__dirname, '../../drizzle');
  for (const file of fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()) {
    for (const statement of fs
      .readFileSync(path.join(dir, file), 'utf8')
      .split('--> statement-breakpoint')) {
      if (statement.trim()) conn.execSync(statement);
    }
  }
  return { expoDb: conn, db: drizzle(conn as never) };
});
jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));
jest.mock('@/utils/video', () => ({ __esModule: true, generateThumbnailFile: async () => true }));
jest.mock('./secure-token', () => ({ deleteSavedLink: async () => {} }));
jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: () => `split-draft-${++n}` };
});

/* eslint-disable import/first -- native stand-ins must load before the database */
import {
  expectClipsAdded,
  onClipsAdded,
  takeClipsAdded,
  takeClipSplits,
  type ClipAnchor,
  type ClipsAdded,
} from '@/core/clip-anchor';
import { env } from '@/test-support/expo-fs-node';
import { setClipWriteBarrier } from '@/core/draft-write-barrier';
// eslint-disable-next-line import/no-restricted-paths -- exercise the real DB/history integration
import { createEditorHistory } from '@/features/editor/editor-history-store';
import { clipRender, effMs, parseEdit, renderKey } from '@/utils/segment-window';
import * as video from '@/utils/video';
import { expoDb } from './client';
import {
  addSegment,
  createDraft,
  deleteSegment,
  dropTakenOut,
  insertSegments,
  reorderSegments,
  resetEdit,
  restoreSegments,
  segmentsForDraft,
  setClipEdit,
  setEditState,
  takeOutSegments,
  type TakenOutClips,
} from './drafts';
import type { Segment } from './schema';
/* eslint-enable import/first */

const conn = expoDb as unknown as {
  runSync: (sql: string, ...params: unknown[]) => unknown;
  getAllSync: <T>(sql: string, ...params: unknown[]) => T[];
  getFirstSync: <T>(sql: string, ...params: unknown[]) => T | null;
};
const ROOT = mkdtempSync(join(tmpdir(), 'pulse-split-insert-'));
let sequence = 0;
const cleanups: (() => void)[] = [];
const retained: TakenOutClips[] = [];
beforeEach(() => {
  env.docDir = join(ROOT, String(++sequence));
  env.cacheDir = join(env.docDir, 'Caches');
  mkdirSync(env.docDir, { recursive: true });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const taken of retained.splice(0)) await dropTakenOut(taken);
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const put = (rel: string, contents: string) => {
  const file = join(env.docDir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
};
const bytes = (rel: string) => readFileSync(join(env.docDir, rel), 'utf8');
const has = (rel: string) => existsSync(join(env.docDir, rel));
// Covers are derived asynchronously; undo/redo preserves the content rows independently of them.
const contentRows = (rows: readonly Segment[]) => rows.map((row) => ({ ...row, thumbnail: null }));
const edit = {
  startMs: 500,
  endMs: 3500,
  rotation: 1,
  flipped: true,
  crop: null,
  muted: false,
  speed: 2,
};
const transcript = (id: string) =>
  conn.getAllSync<{ model: string; file: string; words: string }>(
    'SELECT model, file, words FROM clip_transcripts WHERE segment_id = ? ORDER BY model',
    id,
  );
async function setup(legacy = false) {
  const d = await createDraft();
  const a = `${d}-a`;
  const video = `drafts/${d}/segments/${a}.mp4`;
  const cover = `drafts/${d}/segments/${a}.cover.1.jpg`;
  put(video, 'original video bytes');
  put(cover, 'original cover bytes');
  const baked = `drafts/${d}/segments/${a}.edited.1.mp4`;
  if (legacy) put(baked, 'baked video bytes');
  const file = legacy ? baked : video;
  await addSegment(d, {
    id: a,
    originalFilename: video,
    durationMs: 4000,
    thumbnail: cover,
    editedFilename: legacy ? baked : null,
    editedDurationMs: legacy ? 3000 : 1500,
    editState: legacy ? null : JSON.stringify(edit),
    captionEdit: JSON.stringify({ file, words: [{ text: 'hello', t0: 100, t1: 200 }] }),
  });
  const b = `${d}-b`;
  await addSegment(d, {
    id: b,
    originalFilename: `drafts/${d}/segments/${b}.mp4`,
    durationMs: 500,
  });
  conn.runSync(
    "INSERT INTO clip_transcripts (segment_id, model, file, status, words) VALUES (?, 'base', ?, 'done', ?)",
    a,
    file,
    '[{"text":"hello","t0":100,"t1":200}]',
  );
  const before = (await segmentsForDraft(d))[0];
  const anchor = (row: Segment = before, sourceMs = 1500, rightId = `${d}-right`): ClipAnchor => ({
    before: row.id,
    split: {
      sourceMs,
      sourceKey: renderKey(row),
      rightId,
      offsetMs: (sourceMs - clipRender(row).inMs) / clipRender(row).speed,
    },
  });
  const heard: ClipsAdded[] = [];
  cleanups.push(
    expectClipsAdded(d),
    onClipsAdded((event) => {
      if (event.draftId === d) {
        heard.push(event);
        if (event.split) retained.push(event.split.before);
      }
    }),
  );
  const object = (suffix = 'x') => {
    const id = `${d}-${suffix}`;
    const originalFilename = `drafts/${d}/segments/${id}.mp4`;
    put(originalFilename, `${suffix} video bytes`);
    return { id, originalFilename, durationMs: 1000 };
  };
  return { d, a, b, before, anchor, heard, object, video, cover, baked };
}

const presentRows = (rows: readonly Segment[]) => ({
  clips: rows.map((row) => ({ id: row.id, editKey: row.editState })),
  captions: new Map(rows.map((row) => [row.id, row.captionEdit])),
  captionY: null,
});

/** Run actual row mutations for both addition steps and the intervening edit snapshots. */
function databaseHistory(draftId: string) {
  const writes: Promise<void>[] = [];
  const flush = async () => {
    await Promise.all(writes.splice(0));
  };
  const failed = jest.fn();
  const takeOut = jest.fn<typeof takeOutSegments>(takeOutSegments);
  const history = createEditorHistory({
    flush,
    takeOut,
    restore: restoreSegments,
    drop: dropTakenOut,
    failed,
  });
  const apply: Parameters<typeof history.undo>[1] = (diff) => {
    for (const [id, value] of diff.edits) {
      writes.push(value == null ? resetEdit(id) : setEditState(id, value));
    }
    if (diff.order) writes.push(reorderSegments(diff.order));
    // These histories change video transforms, so captions never require an independent write.
    expect(diff.captions.size).toBe(0);
    expect(diff.captionY).toBeUndefined();
  };
  return {
    history,
    apply,
    failed,
    takeOut,
    present: async () => presentRows(await segmentsForDraft(draftId)),
    settled: async () => {
      await history.settled();
      await flush();
    },
  };
}

describe('exact split + insert', () => {
  it('commits left/object/right with unchanged source bytes, edits, captions and cloned transcripts', async () => {
    const t = await setup();
    const x = t.object();
    await insertSegments(t.d, t.anchor(), [x]);
    const rows = await segmentsForDraft(t.d);
    expect(rows.map((r) => r.id)).toEqual([t.a, x.id, `${t.d}-right`, t.b]);
    expect(rows.map((r) => r.label)).toEqual(['1', '3', '4', '2']);
    expect(clipRender(rows[0])).toMatchObject({
      file: t.video,
      inMs: 500,
      outMs: 1500,
      speed: 2,
      rotation: 1,
      flipped: true,
    });
    expect(clipRender(rows[2])).toMatchObject({
      file: t.video,
      inMs: 1500,
      outMs: 3500,
      speed: 2,
      rotation: 1,
      flipped: true,
    });
    expect(effMs(rows[0]) + effMs(rows[2])).toBe(effMs(t.before));
    expect(rows[0].captionEdit).toBe(t.before.captionEdit);
    expect(rows[2].captionEdit).toBe(t.before.captionEdit);
    expect(transcript(rows[2].id)).toEqual(transcript(t.a));
    expect(bytes(t.video)).toBe('original video bytes');
    expect(bytes(t.cover)).toBe('original cover bytes');
    expect(readdirSync(dirname(join(env.docDir, t.video))).sort()).toEqual(
      [`${t.a}.cover.1.jpg`, `${t.a}.mp4`, `${x.id}.mp4`].sort(),
    );
    expect(t.heard).toHaveLength(1);
    expect(t.heard[0].segmentIds).toEqual([x.id]);
    expect(t.heard[0].split).toMatchObject({
      rightId: `${t.d}-right`,
      firstInsertedId: x.id,
      before: { rows: [t.before] },
    });
  });

  it('carries events through history and undoes before the live query catches up', async () => {
    const t = await setup();
    const x = t.object();
    await insertSegments(t.d, t.anchor(), [x]);
    const split = t.heard[0].split!;
    const applied = await segmentsForDraft(t.d);
    const failed = jest.fn();
    const history = createEditorHistory({
      flush: async () => {},
      takeOut: takeOutSegments,
      restore: restoreSegments,
      drop: dropTakenOut,
      failed,
    });
    const added = takeClipsAdded(t.d);
    const receipts = takeClipSplits(t.d);
    expect(added).toEqual([x.id]);
    expect(receipts).toEqual([split]);
    history.recordAdded(added, receipts);
    const present = async () => {
      const rows = await segmentsForDraft(t.d);
      return {
        clips: rows.map((row) => ({ id: row.id, editKey: row.editState })),
        captions: new Map(rows.map((row) => [row.id, row.captionEdit])),
        captionY: null,
      };
    };
    for (let cycle = 0; cycle < 2; cycle++) {
      // On the first tap React still has the pre-insert list: X/right aren't visible yet.
      const current =
        cycle === 0
          ? {
              clips: [{ id: t.a, editKey: t.before.editState }],
              captions: new Map(),
              captionY: null,
            }
          : await present();
      history.undo(current, () => {});
      await history.settled();
      expect((await segmentsForDraft(t.d)).map((r) => r.id)).toEqual([t.a, t.b]);
      expect((await segmentsForDraft(t.d))[0]).toEqual(t.before);
      expect(transcript(split.rightId)).toEqual([]);
      expect(has(x.originalFilename)).toBe(true);
      expect(history.getState().future).toHaveLength(1);
      history.redo(await present(), () => {});
      await history.settled();
      const redone = await segmentsForDraft(t.d);
      expect(redone.map((r) => r.id)).toEqual(applied.map((r) => r.id));
      expect(contentRows(redone.slice(0, 3))).toEqual(contentRows(applied.slice(0, 3)));
      expect(transcript(split.rightId)).toEqual(transcript(t.a));
    }
    expect(failed).not.toHaveBeenCalled();
    history.dispose();
    expect(t.heard).toHaveLength(1); // Redo isn't a second add/undo step.
  });

  it.each([
    ['boundary', 'wholly'],
    ['boundary', 'partly'],
    ['end', 'wholly'],
    ['end', 'partly'],
  ])(
    'undoes the whole ordinary %s addition with a %s stale live query, even just after redo',
    async (position, visible) => {
      const t = await setup();
      const base = await segmentsForDraft(t.d);
      const x = t.object('x');
      const y = t.object('y');
      const at: ClipAnchor = position === 'end' ? { at: 'end' } : { before: t.b };
      await insertSegments(t.d, at, [x, y]);
      const applied = await segmentsForDraft(t.d);
      const stale = presentRows(
        applied.filter((row) => row.id !== y.id && (row.id !== x.id || visible === 'partly')),
      );
      const h = databaseHistory(t.d);
      h.history.recordAdded(takeClipsAdded(t.d), takeClipSplits(t.d));
      try {
        for (let cycle = 0; cycle < 2; cycle++) {
          // Redo commits before React updates: the next Undo still sees only the original clips.
          h.history.undo(cycle === 0 ? stale : presentRows(base), h.apply);
          await h.settled();
          expect(h.takeOut).toHaveBeenLastCalledWith([x.id, y.id]);
          expect((await segmentsForDraft(t.d)).map((row) => row.id)).toEqual(
            base.map((row) => row.id),
          );
          expect(h.history.getState().future).toHaveLength(1);
          h.history.redo(presentRows(base), h.apply);
          await h.settled();
          expect(contentRows(await segmentsForDraft(t.d))).toEqual(contentRows(applied));
        }
        expect(h.failed).not.toHaveBeenCalled();
      } finally {
        h.history.dispose();
      }
    },
  );

  it('extends an image batch below a rotation so Undo rejoins full A and Redo preserves the edit', async () => {
    const t = await setup();
    await resetEdit(t.a);
    const before = (await segmentsForDraft(t.d))[0];
    const at = t.anchor(before);
    const x = t.object('photo1');
    const y = t.object('photo2');
    const h = databaseHistory(t.d);
    const key = 'photos';
    try {
      await h.history.beginBatch(key);
      await insertSegments(t.d, at, [x]);
      h.history.recordAdded(takeClipsAdded(t.d), takeClipSplits(t.d), key);
      expect(h.history.getState().past.map((step) => step.kind)).toEqual(['added']);

      // The first photo is visible while the second still prepares. Its batch step already
      // exists when the user rotates A-left, so that later edit must stay above the batch.
      h.history.record(await h.present(), null);
      const left = (await segmentsForDraft(t.d))[0];
      await setClipEdit(t.a, { ...parseEdit(left.editState)!, rotation: 1 });
      await insertSegments(t.d, at, [y]);
      h.history.recordAdded(takeClipsAdded(t.d), takeClipSplits(t.d), key);
      h.history.endBatch(key);
      expect(h.history.getState().past.map((step) => step.kind)).toEqual(['added', 'state']);
      const applied = await segmentsForDraft(t.d);
      expect(applied.map((row) => row.id)).toEqual([t.a, x.id, y.id, `${t.d}-right`, t.b]);

      h.history.undo(await h.present(), h.apply); // Undo the later rotation first.
      await h.settled();
      expect(clipRender((await segmentsForDraft(t.d))[0])).toMatchObject({
        inMs: 0,
        outMs: 1500,
        rotation: 0,
      });
      h.history.undo(await h.present(), h.apply); // One batch Undo removes both photos and rejoins A.
      await h.settled();
      let original = (await segmentsForDraft(t.d))[0];
      expect((await segmentsForDraft(t.d)).map((row) => row.id)).toEqual([t.a, t.b]);
      expect(contentRows([original])).toEqual(contentRows([before]));
      expect(parseEdit(original.editState)?.baseWindow).toBeUndefined();
      await resetEdit(t.a);
      original = (await segmentsForDraft(t.d))[0];
      expect(clipRender(original)).toMatchObject({ inMs: 0, outMs: 4000, rotation: 0, speed: 1 });

      h.history.redo(await h.present(), h.apply); // The batch returns before its later edit.
      await h.settled();
      expect(clipRender((await segmentsForDraft(t.d))[0])).toMatchObject({
        inMs: 0,
        outMs: 1500,
        rotation: 0,
      });
      h.history.redo(await h.present(), h.apply);
      await h.settled();
      const redone = await segmentsForDraft(t.d);
      expect(contentRows(redone)).toEqual(contentRows(applied));
      expect(clipRender(redone[0])).toMatchObject({ inMs: 0, outMs: 1500, rotation: 1 });
      expect(bytes(t.video)).toBe('original video bytes');
      expect(h.failed).not.toHaveBeenCalled();
    } finally {
      h.history.endBatch(key);
      h.history.dispose();
    }
  });

  it('splits only once for a batch continuing at the same frozen anchor', async () => {
    const t = await setup();
    const anchor = t.anchor();
    const x = t.object('x');
    const y = t.object('y');
    await insertSegments(t.d, anchor, [x]);
    await insertSegments(t.d, anchor, [y]);
    expect((await segmentsForDraft(t.d)).map((r) => r.id)).toEqual([
      t.a,
      x.id,
      y.id,
      `${t.d}-right`,
      t.b,
    ]);
    expect(t.heard.map((event) => !!event.split)).toEqual([true, false]);
    const taken = (await takeOutSegments([x.id, y.id], [t.heard[0].split!]))!;
    retained.push(taken);
    expect((await segmentsForDraft(t.d))[0]).toEqual(t.before);
    await restoreSegments(taken);
    expect((await segmentsForDraft(t.d)).map((r) => r.id)).toEqual([
      t.a,
      x.id,
      y.id,
      `${t.d}-right`,
      t.b,
    ]);
  });

  it.each(['original', 'right'])(
    'restores the earliest original when grouped additions split the %s half again',
    async (half) => {
      const t = await setup();
      const x = t.object('x');
      const y = t.object('y');
      await insertSegments(t.d, t.anchor(), [x]);
      const first = await segmentsForDraft(t.d);
      const target = half === 'original' ? first[0] : first[2];
      await insertSegments(
        t.d,
        t.anchor(target, half === 'original' ? 1000 : 2500, `${t.d}-second-right`),
        [y],
      );
      const appliedIds = (await segmentsForDraft(t.d)).map((r) => r.id);
      const taken = (await takeOutSegments(
        [x.id, y.id],
        t.heard.flatMap((e) => (e.split ? [e.split] : [])),
      ))!;
      retained.push(taken);
      expect((await segmentsForDraft(t.d)).map((r) => r.id)).toEqual([t.a, t.b]);
      expect((await segmentsForDraft(t.d))[0]).toEqual(t.before);
      await restoreSegments(taken);
      expect((await segmentsForDraft(t.d)).map((r) => r.id)).toEqual(appliedIds);
    },
  );

  it('normalizes legacy baked clips without copying or losing either original file', async () => {
    const t = await setup(true);
    await insertSegments(t.d, t.anchor(), [t.object()]);
    const rows = await segmentsForDraft(t.d);
    expect(rows[0].originalFilename).toBe(t.baked);
    expect(rows[2].originalFilename).toBe(t.baked);
    expect(rows[0].editedFilename).toBeNull();
    expect(bytes(t.video)).toBe('original video bytes');
    expect(bytes(t.baked)).toBe('baked video bytes');
    const taken = (await takeOutSegments([t.heard[0].segmentIds[0]], [t.heard[0].split!]))!;
    retained.push(taken);
    expect((await segmentsForDraft(t.d))[0]).toEqual(t.before);
    await restoreSegments(taken);
  });

  it.each([500, 3500, NaN])(
    'rejects an invalid interior cut %s without leaving fragments',
    async (cut) => {
      const t = await setup();
      await expect(insertSegments(t.d, t.anchor(t.before, cut), [t.object()])).rejects.toThrow(
        /inside/,
      );
      expect((await segmentsForDraft(t.d))[0]).toEqual(t.before);
      expect(t.heard).toEqual([]);
    },
  );

  it('does not split for an empty/cancelled insertion', async () => {
    const t = await setup();
    expect(await insertSegments(t.d, t.anchor(), [])).toEqual([]);
    expect((await segmentsForDraft(t.d))[0]).toEqual(t.before);
    expect(t.heard).toEqual([]);
  });

  it('rejects a changed or deleted source instead of silently appending', async () => {
    const t = await setup();
    const anchor = t.anchor();
    conn.runSync(
      'UPDATE segments SET edit_state = ? WHERE id = ?',
      JSON.stringify({ ...edit, speed: 1 }),
      t.a,
    );
    await expect(insertSegments(t.d, anchor, [t.object()])).rejects.toThrow(/changed/);
    await deleteSegment(t.a);
    await expect(insertSegments(t.d, anchor, [t.object()])).rejects.toThrow(/changed/);
    expect((await segmentsForDraft(t.d)).map((r) => r.id)).toEqual([t.b]);
    expect(t.heard).toEqual([]);
  });

  it('waits for pending edit writes before validating the frozen source', async () => {
    const t = await setup();
    const anchor = t.anchor();
    let reached!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const restoreBarrier = setClipWriteBarrier(() => {
      reached();
      return writing;
    });
    try {
      const adding = insertSegments(t.d, anchor, [t.object()]);
      await entered;
      expect((await segmentsForDraft(t.d))[0]).toEqual(t.before);
      expect(t.heard).toEqual([]);
      conn.runSync(
        'UPDATE segments SET edit_state = ? WHERE id = ?',
        JSON.stringify({ ...edit, speed: 1 }),
        t.a,
      );
      finish();
      await expect(adding).rejects.toThrow(/changed/);
      expect((await segmentsForDraft(t.d)).map((row) => row.id)).toEqual([t.a, t.b]);
      expect(t.heard).toEqual([]);
    } finally {
      finish();
      restoreBarrier();
    }
  });

  it.each(['setEditState', 'setClipEdit', 'resetEdit'])(
    'a direct %s finishing its cover after a split cannot overwrite the new half',
    async (method) => {
      const t = await setup();
      let finish!: (ok: boolean) => void;
      let reached!: () => void;
      const rendering = new Promise<boolean>((resolve) => {
        finish = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const thumbnail = jest.spyOn(video, 'generateThumbnailFile').mockImplementationOnce(() => {
        reached();
        return rendering;
      });
      const wideEdit = { ...edit, startMs: 0, endMs: 4000, speed: 1 };
      const saving =
        method === 'setEditState'
          ? setEditState(t.a, JSON.stringify(wideEdit))
          : method === 'setClipEdit'
            ? setClipEdit(t.a, wideEdit)
            : resetEdit(t.a);
      try {
        await entered;
        await insertSegments(t.d, t.anchor(), [t.object()]);
        const splitRows = await segmentsForDraft(t.d);
        finish(true);
        await saving;
        expect(contentRows(await segmentsForDraft(t.d))).toEqual(contentRows(splitRows));
        expect(clipRender(splitRows[0])).toMatchObject({ inMs: 500, outMs: 1500 });
        expect(bytes(t.video)).toBe('original video bytes');
      } finally {
        finish(true);
        await saving;
        thumbnail.mockRestore();
      }
    },
  );

  it('a failed split leaves a direct edit free to finish', async () => {
    const t = await setup();
    let finish!: (ok: boolean) => void;
    let reached!: () => void;
    const rendering = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const thumbnail = jest.spyOn(video, 'generateThumbnailFile').mockImplementationOnce(() => {
      reached();
      return rendering;
    });
    const wideEdit = { ...edit, startMs: 0, endMs: 4000, speed: 1 };
    const saving = setClipEdit(t.a, wideEdit);
    try {
      await entered;
      await expect(insertSegments(t.d, t.anchor(), [{ ...t.object(), id: t.b }])).rejects.toThrow();
      finish(true);
      await saving;
      const original = (await segmentsForDraft(t.d))[0];
      expect(clipRender(original)).toMatchObject({ inMs: 0, outMs: 4000, speed: 1 });
      expect(parseEdit(original.editState)?.baseWindow).toBeUndefined();
      expect(t.heard).toEqual([]);
    } finally {
      finish(true);
      await saving;
      thumbnail.mockRestore();
    }
  });

  it.each(['undo', 'redo'])(
    'a direct save finishing after compound %s cannot overwrite its restored row',
    async (direction) => {
      const t = await setup();
      const x = t.object();
      await insertSegments(t.d, t.anchor(), [x]);
      const split = t.heard[0].split!;
      let taken: TakenOutClips | null = null;
      if (direction === 'redo') {
        taken = await takeOutSegments([x.id], [split]);
        retained.push(taken!);
      }
      let finish!: (ok: boolean) => void;
      let reached!: () => void;
      const rendering = new Promise<boolean>((resolve) => {
        finish = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const thumbnail = jest.spyOn(video, 'generateThumbnailFile').mockImplementationOnce(() => {
        reached();
        return rendering;
      });
      const saving = setClipEdit(t.a, { ...edit, startMs: 0, endMs: 4000, speed: 1 });
      try {
        await entered;
        if (direction === 'undo') {
          taken = await takeOutSegments([x.id], [split]);
          retained.push(taken!);
        } else await restoreSegments(taken!);
        const restored = await segmentsForDraft(t.d);
        finish(true);
        await saving;
        expect(contentRows(await segmentsForDraft(t.d))).toEqual(contentRows(restored));
        expect(bytes(t.video)).toBe('original video bytes');
      } finally {
        finish(true);
        await saving;
        thumbnail.mockRestore();
      }
    },
  );

  it('renders the right cover at its cut and ignores a late pre-undo cover after redo', async () => {
    const t = await setup();
    const x = t.object();
    let finishFirst!: (ok: boolean) => void;
    let finishSecond!: (ok: boolean) => void;
    let reachedFirst!: () => void;
    let reachedSecond!: () => void;
    const first = new Promise<boolean>((resolve) => {
      finishFirst = resolve;
    });
    const second = new Promise<boolean>((resolve) => {
      finishSecond = resolve;
    });
    const enteredFirst = new Promise<void>((resolve) => {
      reachedFirst = resolve;
    });
    const enteredSecond = new Promise<void>((resolve) => {
      reachedSecond = resolve;
    });
    const outputs: string[] = [];
    const thumbnail = jest
      .spyOn(video, 'generateThumbnailFile')
      .mockImplementation((source, output, options) => {
        expect(source).toContain(t.video);
        expect(options?.startMs).toBe(1500);
        outputs.push(output);
        if (outputs.length === 1) {
          reachedFirst();
          return first;
        }
        reachedSecond();
        return second;
      });
    try {
      await insertSegments(t.d, t.anchor(), [x]);
      await enteredFirst;
      const split = t.heard[0].split!;
      const taken = (await takeOutSegments([x.id], [split]))!;
      retained.push(taken);
      await restoreSegments(taken);
      await enteredSecond;
      expect(outputs[0]).not.toBe(outputs[1]);
      expect(
        (await segmentsForDraft(t.d)).find((row) => row.id === split.rightId)?.thumbnail,
      ).toBeNull();

      finishFirst(true);
      await first;
      expect(
        (await segmentsForDraft(t.d)).find((row) => row.id === split.rightId)?.thumbnail,
      ).toBeNull();

      finishSecond(true);
      await second;
      const right = (await segmentsForDraft(t.d)).find((row) => row.id === split.rightId)!;
      expect(right.thumbnail).toContain(`${split.rightId}.cover.`);
      expect(outputs[1]).toContain(right.thumbnail!);
      expect(outputs[0]).not.toContain(right.thumbnail!);
      expect(bytes(t.video)).toBe('original video bytes');
    } finally {
      finishFirst(true);
      finishSecond(true);
      await Promise.all([first, second]);
      thumbnail.mockRestore();
    }
  });

  it('rechecks a cancellable anchor after waiting without ever splitting the draft', async () => {
    const t = await setup();
    let finish!: () => void;
    let reached!: () => void;
    let cancelled = false;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const restoreBarrier = setClipWriteBarrier(() => {
      reached();
      return pending;
    });
    try {
      const adding = insertSegments(
        t.d,
        () => {
          if (cancelled) throw new Error('cancelled');
          return t.anchor();
        },
        [t.object()],
      );
      await entered;
      cancelled = true;
      finish();
      await expect(adding).rejects.toThrow('cancelled');
      expect((await segmentsForDraft(t.d))[0]).toEqual(t.before);
      expect((await segmentsForDraft(t.d)).map((row) => row.id)).toEqual([t.a, t.b]);
      expect(t.heard).toEqual([]);
    } finally {
      finish();
      restoreBarrier();
    }
  });

  it('rolls back both halves, labels, receipt and held-file record when insertion fails', async () => {
    const t = await setup();
    const beforeRows = await segmentsForDraft(t.d);
    const held = conn.getFirstSync(
      'SELECT value FROM settings WHERE key = ?',
      'drafts.heldForRedo',
    );
    await expect(insertSegments(t.d, t.anchor(), [{ ...t.object(), id: t.b }])).rejects.toThrow();
    expect(await segmentsForDraft(t.d)).toEqual(beforeRows);
    expect(
      conn.getFirstSync<{ n: number }>('SELECT last_clip_number AS n FROM drafts WHERE id = ?', t.d)
        ?.n,
    ).toBe(2);
    expect(t.heard).toEqual([]);
    expect(
      conn.getFirstSync('SELECT value FROM settings WHERE key = ?', 'drafts.heldForRedo'),
    ).toEqual(held);
  });

  it('preserves split bounds on save/reset and never deletes a cover shared by its sibling', async () => {
    const t = await setup();
    await insertSegments(t.d, t.anchor(), [t.object()]);
    const rightId = t.heard[0].split!.rightId;
    // Older split drafts can share a cover. Replacing it must preserve the left sibling's file.
    conn.runSync('UPDATE segments SET thumbnail = ? WHERE id = ?', t.cover, rightId);
    // The cover remains protected by its sibling even without a history snapshot holding it.
    await dropTakenOut(t.heard[0].split!.before);
    await setEditState(rightId, JSON.stringify({ ...edit, startMs: 0, endMs: 4000, speed: 1 }));
    expect(has(t.cover)).toBe(true);
    await resetEdit(rightId);
    const right = (await segmentsForDraft(t.d)).find((r) => r.id === rightId)!;
    expect(clipRender(right)).toMatchObject({
      inMs: 1500,
      outMs: 3500,
      speed: 1,
      rotation: 0,
      flipped: false,
    });
    expect(parseEdit(right.editState)?.baseWindow).toEqual({ startMs: 1500, endMs: 3500 });
    expect(has(t.cover)).toBe(true);
  });

  it('refuses redo over an original clip changed after undo', async () => {
    const t = await setup();
    const x = t.object();
    await insertSegments(t.d, t.anchor(), [x]);
    const taken = (await takeOutSegments([x.id], [t.heard[0].split!]))!;
    retained.push(taken);
    conn.runSync(
      'UPDATE segments SET edit_state = ? WHERE id = ?',
      JSON.stringify({ ...edit, speed: 1 }),
      t.a,
    );
    const changed = await segmentsForDraft(t.d);
    await expect(restoreSegments(taken)).rejects.toThrow(/changed since Undo/);
    expect(await segmentsForDraft(t.d)).toEqual(changed);
    expect(has(x.originalFilename)).toBe(true);
  });
});
