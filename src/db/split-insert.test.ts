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
jest.mock('@mieweb/pulse-editor', () => ({}), { virtual: true });

/* eslint-disable import/first -- native stand-ins must load before the database */
import {
  expectClipsAdded,
  onClipsAdded,
  takeClipsAdded,
  takeClipSplits,
  type ClipAnchor,
  type ClipsAdded,
} from '@/core/clip-anchor';
import { env, File } from '@/test-support/expo-fs-node';
import { registerUndoAdditionOwner } from '@/core/undo-additions';
import { heldMediaPaths } from '@/core/media-holds';
import { setClipWriteBarrier } from '@/core/draft-write-barrier';
// eslint-disable-next-line import/no-restricted-paths -- exercise the real DB/history integration
import { createEditorHistory } from '@/features/editor/editor-history-store';
// eslint-disable-next-line import/no-restricted-paths -- verify caption projection after a stored cut
import { composeCaptions } from '@/features/transcription/compose';
// eslint-disable-next-line import/no-restricted-paths -- verify the real native export contract
import { toMergeClip } from '@/features/export/editor-merge';
import { clipRender, effMs, parseEdit, renderKey } from '@/utils/segment-window';
import * as video from '@/utils/video';
import { expoDb } from './client';
import {
  addSegment,
  createDraft,
  cutSegmentRange,
  cutTranscriptRanges,
  deleteSegment,
  dropTakenOut,
  insertSegments,
  reorderSegments,
  resetEdit,
  restoreSegments,
  segmentsForDraft,
  setClipEdit,
  setEditState,
  splitSegment,
  takeOutSegments,
  type TakenOutClips,
} from './drafts';
import type { Segment } from './schema';
import { getClipTranscripts } from './clip-transcripts';
import {
  HISTORY_MAX_JSON_BYTES,
  HISTORY_MAX_MEDIA_BYTES,
  parsePersistedHistory,
} from './persisted-history';
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
function databaseHistory(
  draftId: string,
  initial?: Parameters<typeof createEditorHistory>[0]['initial'],
) {
  const writes: Promise<void>[] = [];
  const flush = async () => {
    await Promise.all(writes.splice(0));
  };
  const failed = jest.fn();
  const takeOut = jest.fn<typeof takeOutSegments>(takeOutSegments);
  const history = createEditorHistory({
    initial,
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

describe('bulk transcript source cuts', () => {
  it('restores an intentional whole-beat removal without resurrecting a deleted sibling cut', async () => {
    const t = await setup();
    const before = await segmentsForDraft(t.d);
    put(before[1].originalFilename, 'second beat video bytes');
    const cut = await cutTranscriptRanges(
      t.d,
      before.map((row, i) => ({
        clipId: row.id,
        sourceKey: renderKey(row),
        captionKey: row.captionEdit,
        fps: 30,
        ranges: i === 0 ? [{ startMs: 500, endMs: 3500 }] : [{ startMs: 100, endMs: 300 }],
      })),
    );
    retained.push(...cut.splits.map((split) => split.before));
    expect(cut.splits.map((split) => split.fullyRemoved)).toEqual([true, false]);
    for (const id of cut.ids) await deleteSegment(id);
    expect(await segmentsForDraft(t.d)).toEqual([]);
    const taken = await takeOutSegments(cut.ids, cut.splits, undefined, t.d);
    expect(taken).not.toBeNull();
    retained.push(taken!);
    expect((await segmentsForDraft(t.d)).map((row) => row.id)).toEqual([t.a]);
    expect(taken!.replaced?.map((row) => row.id)).toEqual([t.a]);
    await restoreSegments(taken!, undefined, t.d);
    expect(await segmentsForDraft(t.d)).toEqual([]);
  });

  it('still undoes a bulk cut when only a later retained range survives', async () => {
    const t = await setup();
    const cut = await cutTranscriptRanges(t.d, [
      {
        clipId: t.a,
        sourceKey: renderKey(t.before),
        captionKey: t.before.captionEdit,
        fps: 30,
        ranges: [
          { startMs: 1000, endMs: 1500 },
          { startMs: 2000, endMs: 2500 },
        ],
      },
    ]);
    retained.push(...cut.splits.map((split) => split.before));
    expect(cut.ids).toHaveLength(3);
    expect(cut.splits[0].appliedIds).toEqual(cut.ids);
    await deleteSegment(cut.ids[0]);
    await deleteSegment(cut.ids[1]);
    const taken = await takeOutSegments(cut.ids, cut.splits, undefined, t.d);
    expect(taken).not.toBeNull();
    retained.push(taken!);
    expect((await segmentsForDraft(t.d)).map((row) => row.id)).toEqual([t.a, t.b]);
    await restoreSegments(taken!, undefined, t.d);
    expect((await segmentsForDraft(t.d)).map((row) => row.id)).toEqual([cut.ids[2], t.b]);
  });

  it('atomically applies multiple edge/interior cuts and persists one reversible step', async () => {
    const t = await setup();
    const original = (await segmentsForDraft(t.d))[0];
    const beforeHistory = parsePersistedHistory(
      conn.getFirstSync<{ value: string }>(
        'SELECT undo_history AS value FROM drafts WHERE id = ?',
        t.d,
      )?.value,
      t.d,
    );
    const result = await cutTranscriptRanges(t.d, [
      {
        clipId: t.a,
        sourceKey: renderKey(original),
        captionKey: original.captionEdit,
        fps: 30,
        ranges: [
          { startMs: 500, endMs: 1000 },
          { startMs: 1500, endMs: 2000 },
          { startMs: 3000, endMs: 3500 },
        ],
        transcript: { model: 'base', file: t.video, words: '[{"t1":200,"t0":100,"text":"hello"}]' },
      },
    ]);
    const applied = await segmentsForDraft(t.d);
    expect(applied.map((row) => row.id)).toEqual([...result.ids, t.b]);
    expect(applied.slice(0, 2).map((row) => [clipRender(row).inMs, clipRender(row).outMs])).toEqual(
      [
        [1000, 1500],
        [2000, 3000],
      ],
    );
    expect(result.removedMs).toBe(750);
    expect(applied.slice(0, 2).map((row) => JSON.parse(row.captionEdit!).words)).toEqual([[], []]);
    expect(applied.slice(0, 2).map((row) => transcript(row.id))).toEqual([
      transcript(result.ids[0]),
      transcript(result.ids[0]),
    ]);
    expect(bytes(t.video)).toBe('original video bytes');
    const stored = conn.getFirstSync<{ value: string }>(
      'SELECT undo_history AS value FROM drafts WHERE id = ?',
      t.d,
    );
    const persisted = parsePersistedHistory(stored?.value, t.d)!;
    expect(persisted.past).toHaveLength((beforeHistory?.past.length ?? 0) + 1);
    const h = databaseHistory(t.d, { ...persisted, lastOp: null });
    try {
      for (let i = 0; i < 2; i++) {
        h.history.undo(await h.present(), h.apply);
        await h.settled();
        expect((await segmentsForDraft(t.d))[0]).toEqual(original);
        h.history.redo(await h.present(), h.apply);
        await h.settled();
        expect(contentRows(await segmentsForDraft(t.d))).toEqual(contentRows(applied));
      }
      expect(h.failed).not.toHaveBeenCalled();
    } finally {
      h.history.dispose();
    }
  });

  it('removes every beat and still restores/replays the batch from durable history', async () => {
    const t = await setup();
    const before = await segmentsForDraft(t.d);
    put(before[1].originalFilename, 'second beat video bytes');
    const result = await cutTranscriptRanges(
      t.d,
      before.map((row) => ({
        clipId: row.id,
        sourceKey: renderKey(row),
        captionKey: row.captionEdit,
        fps: 30,
        ranges: [{ startMs: clipRender(row).inMs, endMs: clipRender(row).outMs }],
      })),
    );
    expect(result.ids).toEqual([]);
    expect(result.splits).toHaveLength(2);
    expect(await segmentsForDraft(t.d)).toEqual([]);
    const stored = conn.getFirstSync<{ value: string }>(
      'SELECT undo_history AS value FROM drafts WHERE id = ?',
      t.d,
    );
    const persisted = parsePersistedHistory(stored?.value, t.d)!;
    const h = databaseHistory(t.d, { ...persisted, lastOp: null });
    try {
      for (let i = 0; i < 2; i++) {
        h.history.undo(await h.present(), h.apply);
        await h.settled();
        expect(contentRows(await segmentsForDraft(t.d))).toEqual(contentRows(before));
        h.history.redo(await h.present(), h.apply);
        await h.settled();
        expect(await segmentsForDraft(t.d)).toEqual([]);
      }
      expect(h.failed).not.toHaveBeenCalled();
      expect(bytes(t.video)).toBe('original video bytes');
    } finally {
      h.history.dispose();
    }
  });

  it('keeps transcript storage linear across many cuts and preserves visible corrections and replay', async () => {
    const t = await setup();
    const words = Array.from({ length: 1200 }, (_, i) => ({
      text: `word-${i}-${'x'.repeat(30)}`,
      t0: i * 5,
      t1: i * 5 + 4,
      ...(i === 0 && { start: true }),
    }));
    const edited = words.map((word) => ({ ...word, text: `Corrected-${word.text}` }));
    const caption = JSON.stringify({ file: t.video, words: edited, customTopLevel: 'preserved' });
    const longEdit = JSON.stringify({ ...edit, startMs: 0, endMs: 60000, speed: 1 });
    conn.runSync(
      'UPDATE segments SET duration_ms = 60000, edited_duration_ms = 60000, edit_state = ?, caption_edit = ? WHERE id = ?',
      longEdit,
      caption,
      t.a,
    );
    conn.runSync(
      'UPDATE clip_transcripts SET words = ? WHERE segment_id = ?',
      JSON.stringify(words),
      t.a,
    );
    const original = (await segmentsForDraft(t.d))[0];
    const result = await cutTranscriptRanges(t.d, [
      {
        clipId: t.a,
        sourceKey: renderKey(original),
        captionKey: caption,
        fps: 30,
        ranges: Array.from({ length: 50 }, (_, i) => ({
          startMs: i * 1000 + 250,
          endMs: i * 1000 + 500,
        })),
      },
    ]);
    const applied = await segmentsForDraft(t.d);
    const clones = applied.filter((row) => result.ids.includes(row.id));
    expect(clones).toHaveLength(51);
    const transcriptRows = await getClipTranscripts(
      clones.map((row) => row.id),
      'base',
    );
    expect([...transcriptRows.values()].reduce((n, row) => n + row.words.length, 0)).toBeLessThan(
      words.length,
    );
    expect(clones.reduce((n, row) => n + row.captionEdit!.length, 0)).toBeLessThan(
      caption.length * 2,
    );
    expect(clones.every((row) => JSON.parse(row.captionEdit!).customTopLevel === 'preserved')).toBe(
      true,
    );
    const actual = composeCaptions(clones, transcriptRows);
    const uncompacted = composeCaptions(
      clones.map((row) => ({ ...row, captionEdit: caption })),
      transcriptRows,
    );
    const visible = (lines: typeof actual.lines) =>
      lines.map(({ clipId, text, t0, t1, words }) => ({ clipId, text, t0, t1, words }));
    expect(visible(actual.lines)).toEqual(visible(uncompacted.lines));
    expect(result.splits[0].before.rows[0].captionEdit).toBe(caption);
    expect(result.splits[0].before.transcripts[0].words).toBe(JSON.stringify(words));
    const persisted = parsePersistedHistory(
      conn.getFirstSync<{ value: string }>(
        'SELECT undo_history AS value FROM drafts WHERE id = ?',
        t.d,
      )?.value,
      t.d,
    )!;
    const h = databaseHistory(t.d, { ...persisted, lastOp: null });
    try {
      h.history.undo(await h.present(), h.apply);
      await h.settled();
      expect((await segmentsForDraft(t.d))[0]).toEqual(original);
      const afterUndo = h.history.getState();
      const redoDocument = JSON.stringify({
        version: 1,
        checkpoint: 'checked-format',
        past: afterUndo.past,
        future: afterUndo.future,
      });
      expect(Buffer.byteLength(redoDocument)).toBeLessThan(HISTORY_MAX_JSON_BYTES);
      expect(parsePersistedHistory(redoDocument, t.d)?.future).toHaveLength(1);
      h.history.redo(await h.present(), h.apply);
      await h.settled();
      expect(contentRows(await segmentsForDraft(t.d))).toEqual(contentRows(applied));
      expect(h.failed).not.toHaveBeenCalled();
    } finally {
      h.history.dispose();
    }
  });

  it('rejects a stale caption/model or any stale beat without partial changes', async () => {
    const t = await setup();
    const before = await segmentsForDraft(t.d);
    const request = {
      clipId: t.a,
      sourceKey: renderKey(before[0]),
      captionKey: before[0].captionEdit,
      fps: 30,
      ranges: [{ startMs: 1000, endMs: 1500 }],
    };
    await expect(cutTranscriptRanges(t.d, [{ ...request, captionKey: null }])).rejects.toThrow(
      /changed/,
    );
    await expect(
      cutTranscriptRanges(t.d, [
        {
          ...request,
          transcript: {
            model: 'base',
            file: t.video,
            words: '[{"text":"wrong","t0":100,"t1":200}]',
          },
        },
      ]),
    ).rejects.toThrow(/transcript changed/);
    await expect(
      cutTranscriptRanges(t.d, [
        request,
        {
          clipId: t.b,
          sourceKey: 'stale',
          captionKey: null,
          fps: 30,
          ranges: [{ startMs: 0, endMs: 500 }],
        },
      ]),
    ).rejects.toThrow(/changed/);
    expect(await segmentsForDraft(t.d)).toEqual(before);
  });

  it('rolls back every row, transcript and history when a later beat insert fails', async () => {
    const t = await setup();
    const before = await segmentsForDraft(t.d);
    put(before[1].originalFilename, 'second beat video bytes');
    const saved = conn.getFirstSync(
      'SELECT last_clip_number,undo_history,last_modified FROM drafts WHERE id = ?',
      t.d,
    );
    const beforeTranscript = transcript(t.a);
    const quoted = before[1].originalFilename.replace(/'/g, "''");
    conn.runSync(`CREATE TEMP TRIGGER cleanup_insert_failure BEFORE INSERT ON segments
      WHEN NEW.original_filename = '${quoted}' BEGIN SELECT RAISE(ABORT,'cleanup forced failure'); END`);
    try {
      await expect(
        cutTranscriptRanges(
          t.d,
          before.map((row, i) => ({
            clipId: row.id,
            sourceKey: renderKey(row),
            captionKey: row.captionEdit,
            fps: 30,
            ranges: i === 0 ? [{ startMs: 1000, endMs: 1500 }] : [{ startMs: 0, endMs: 200 }],
          })),
        ),
      ).rejects.toThrow(/cleanup forced failure/);
    } finally {
      conn.runSync('DROP TRIGGER cleanup_insert_failure');
    }
    expect(await segmentsForDraft(t.d)).toEqual(before);
    expect(transcript(t.a)).toEqual(beforeTranscript);
    expect(
      conn.getFirstSync(
        'SELECT last_clip_number,undo_history,last_modified FROM drafts WHERE id = ?',
        t.d,
      ),
    ).toEqual(saved);
    expect(bytes(t.video)).toBe('original video bytes');
  });

  it('refuses removal when media-only Undo exceeds retention, even with an active editor', async () => {
    const t = await setup();
    const before = await segmentsForDraft(t.d);
    const saved = conn.getFirstSync(
      'SELECT last_clip_number,undo_history,last_modified FROM drafts WHERE id = ?',
      t.d,
    );
    const committed = jest.fn();
    const unregister = registerUndoAdditionOwner(t.d, {
      snapshot: () => ({ past: [], future: [] }),
      committed,
    });
    const getSize = Object.getOwnPropertyDescriptor(File.prototype, 'size')!.get!;
    const size = jest.spyOn(File.prototype, 'size', 'get').mockImplementation(function (
      this: File,
    ) {
      return this.path.endsWith(t.video) ? HISTORY_MAX_MEDIA_BYTES + 1 : getSize.call(this);
    });
    try {
      await expect(
        cutTranscriptRanges(t.d, [
          {
            clipId: t.a,
            sourceKey: renderKey(before[0]),
            captionKey: before[0].captionEdit,
            fps: 30,
            ranges: [{ startMs: 500, endMs: 3500 }],
          },
        ]),
      ).rejects.toThrow('too large to keep Undo');
    } finally {
      size.mockRestore();
      unregister();
    }
    expect(await segmentsForDraft(t.d)).toEqual(before);
    expect(
      conn.getFirstSync(
        'SELECT last_clip_number,undo_history,last_modified FROM drafts WHERE id = ?',
        t.d,
      ),
    ).toEqual(saved);
    expect(committed).not.toHaveBeenCalled();
    expect(bytes(t.video)).toBe('original video bytes');
  });

  it('refuses cleanup when preserving the original captions exceeds the history JSON budget', async () => {
    const t = await setup();
    const caption = JSON.stringify({
      file: t.video,
      words: [{ text: 'x'.repeat(HISTORY_MAX_JSON_BYTES), t0: 100, t1: 200 }],
    });
    conn.runSync('UPDATE segments SET caption_edit = ? WHERE id = ?', caption, t.a);
    const before = await segmentsForDraft(t.d);
    const saved = conn.getFirstSync(
      'SELECT last_clip_number,undo_history,last_modified FROM drafts WHERE id = ?',
      t.d,
    );
    await expect(
      cutTranscriptRanges(t.d, [
        {
          clipId: t.a,
          sourceKey: renderKey(before[0]),
          captionKey: caption,
          fps: 30,
          ranges: [{ startMs: 1000, endMs: 2000 }],
        },
      ]),
    ).rejects.toThrow('too large to keep Undo');
    expect(await segmentsForDraft(t.d)).toEqual(before);
    expect(
      conn.getFirstSync(
        'SELECT last_clip_number,undo_history,last_modified FROM drafts WHERE id = ?',
        t.d,
      ),
    ).toEqual(saved);
  });

  it('rolls back a whole-beat cleanup whose applied Undo fits but restored Redo cannot fit', async () => {
    const t = await setup();
    const caption = JSON.stringify({
      file: t.video,
      words: [{ text: 'x'.repeat(800 * 1024), t0: 100, t1: 200 }],
    });
    conn.runSync('UPDATE segments SET caption_edit = ? WHERE id = ?', caption, t.a);
    const before = await segmentsForDraft(t.d);
    const beforeTranscript = transcript(t.a);
    const saved = conn.getFirstSync('SELECT * FROM drafts WHERE id = ?', t.d);
    const journal = conn.getFirstSync(
      "SELECT value FROM settings WHERE key = 'drafts.heldForRedo'",
    );
    const held = heldMediaPaths();
    const committed = jest.fn();
    const unregister = registerUndoAdditionOwner(t.d, {
      snapshot: () => ({ past: [], future: [] }),
      committed,
    });
    const cover = jest.spyOn(video, 'generateThumbnailFile');
    try {
      await expect(
        cutTranscriptRanges(t.d, [
          {
            clipId: t.a,
            sourceKey: renderKey(before[0]),
            captionKey: caption,
            fps: 30,
            ranges: [{ startMs: 500, endMs: 3500 }],
          },
        ]),
      ).rejects.toThrow('too large to keep Undo and Redo');
      expect(await segmentsForDraft(t.d)).toEqual(before);
      expect(transcript(t.a)).toEqual(beforeTranscript);
      expect(conn.getFirstSync('SELECT * FROM drafts WHERE id = ?', t.d)).toEqual(saved);
      expect(
        conn.getFirstSync("SELECT value FROM settings WHERE key = 'drafts.heldForRedo'"),
      ).toEqual(journal);
      expect(heldMediaPaths()).toEqual(held);
      expect(committed).not.toHaveBeenCalled();
      expect(cover).not.toHaveBeenCalled();
      expect(bytes(t.video)).toBe('original video bytes');
    } finally {
      unregister();
      cover.mockRestore();
    }
  });
});

describe('transcript-driven source cut', () => {
  it('rolls back a single-word cut when its saved Undo receipt would be evicted', async () => {
    const t = await setup();
    conn.runSync(
      'UPDATE segments SET caption_edit = ? WHERE id = ?',
      JSON.stringify({
        file: t.video,
        words: [{ text: 'x'.repeat(HISTORY_MAX_JSON_BYTES), t0: 100, t1: 200 }],
      }),
      t.a,
    );
    const before = await segmentsForDraft(t.d);
    const beforeTranscript = transcript(t.a);
    const saved = conn.getFirstSync('SELECT * FROM drafts WHERE id = ?', t.d);
    const journal = conn.getFirstSync(
      "SELECT value FROM settings WHERE key = 'drafts.heldForRedo'",
    );
    const held = heldMediaPaths();
    const committed = jest.fn();
    const unregister = registerUndoAdditionOwner(t.d, {
      snapshot: () => ({ past: [], future: [] }),
      committed,
    });
    const cover = jest.spyOn(video, 'generateThumbnailFile');
    try {
      await expect(
        cutSegmentRange(t.d, {
          clipId: t.a,
          sourceKey: renderKey(before[0]),
          startMs: 1500,
          endMs: 2000,
          rightId: `${t.d}-speech-right`,
          fps: 30,
        }),
      ).rejects.toThrow('too large to keep Undo');
      expect(await segmentsForDraft(t.d)).toEqual(before);
      expect(transcript(t.a)).toEqual(beforeTranscript);
      expect(conn.getFirstSync('SELECT * FROM drafts WHERE id = ?', t.d)).toEqual(saved);
      expect(
        conn.getFirstSync("SELECT value FROM settings WHERE key = 'drafts.heldForRedo'"),
      ).toEqual(journal);
      expect(heldMediaPaths()).toEqual(held);
      expect(committed).not.toHaveBeenCalled();
      expect(cover).not.toHaveBeenCalled();
      expect(bytes(t.video)).toBe('original video bytes');
    } finally {
      unregister();
      cover.mockRestore();
    }
  });

  it('cuts spoken media, projects captions and exports the same retained ranges', async () => {
    const t = await setup();
    const words = [
      { text: 'before', t0: 100, t1: 140 },
      { text: 'remove', t0: 150, t1: 200 },
      { text: 'after', t0: 210, t1: 250 },
    ];
    const captionEdit = JSON.stringify({ file: t.video, words });
    conn.runSync('UPDATE segments SET caption_edit = ? WHERE id = ?', captionEdit, t.a);
    conn.runSync(
      'UPDATE clip_transcripts SET words = ? WHERE segment_id = ?',
      JSON.stringify(words),
      t.a,
    );
    const original = (await segmentsForDraft(t.d))[0];
    const receipt = await cutSegmentRange(t.d, {
      clipId: t.a,
      sourceKey: renderKey(original),
      startMs: 1500,
      endMs: 2000,
      rightId: `${t.d}-speech-right`,
      fps: 30,
    });
    const applied = await segmentsForDraft(t.d);
    expect(applied.map((row) => row.id)).toEqual([t.a, receipt.rightId, t.b]);
    expect(clipRender(applied[0])).toMatchObject({
      file: t.video,
      inMs: 500,
      outMs: 1500,
      speed: 2,
    });
    expect(clipRender(applied[1])).toMatchObject({
      file: t.video,
      inMs: 2000,
      outMs: 3500,
      speed: 2,
    });
    expect(applied.slice(0, 2).reduce((ms, row) => ms + effMs(row), 0)).toBe(effMs(original) - 250);
    expect(applied.slice(0, 2).map(toMergeClip)).toEqual([
      expect.objectContaining({
        uri: expect.stringContaining(t.video),
        startMs: 500,
        endMs: 1500,
        speed: 2,
      }),
      expect.objectContaining({
        uri: expect.stringContaining(t.video),
        startMs: 2000,
        endMs: 3500,
        speed: 2,
      }),
    ]);
    const captions = composeCaptions(
      applied,
      await getClipTranscripts(
        applied.map((row) => row.id),
        'base',
      ),
    );
    expect(captions.lines.flatMap((line) => line.words?.map((word) => word.text) ?? [])).toEqual([
      'before',
      'after',
    ]);
    expect(transcript(receipt.rightId)).toEqual(transcript(t.a));
    expect(bytes(t.video)).toBe('original video bytes');

    // Restore the operation from the on-disk format rather than relying on the returned receipt.
    const stored = conn.getFirstSync<{ value: string }>(
      'SELECT undo_history AS value FROM drafts WHERE id = ?',
      t.d,
    );
    const persisted = parsePersistedHistory(stored?.value, t.d)!;
    expect(persisted.past.at(-1)).toMatchObject({ kind: 'added', ids: [], splits: [receipt] });
    const h = databaseHistory(t.d, {
      past: persisted.past,
      future: persisted.future,
      lastOp: null,
    });
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        h.history.undo(await h.present(), h.apply);
        await h.settled();
        expect((await segmentsForDraft(t.d))[0]).toEqual(original);
        expect((await segmentsForDraft(t.d)).map((row) => row.id)).toEqual([t.a, t.b]);
        h.history.redo(await h.present(), h.apply);
        await h.settled();
        expect(contentRows(await segmentsForDraft(t.d))).toEqual(contentRows(applied));
      }
      expect(h.failed).not.toHaveBeenCalled();
    } finally {
      h.history.dispose();
    }
  });

  it('rejects a changed source and edge/sliver selections without changing rows or history', async () => {
    const t = await setup();
    const request = {
      clipId: t.a,
      sourceKey: renderKey(t.before),
      startMs: 1500,
      endMs: 2000,
      rightId: `${t.d}-right`,
      fps: 30,
    };
    await setClipEdit(t.a, { ...edit, speed: 1 });
    const before = await segmentsForDraft(t.d);
    const saved = conn.getFirstSync(
      'SELECT last_clip_number, undo_history FROM drafts WHERE id = ?',
      t.d,
    );
    await expect(cutSegmentRange(t.d, request)).rejects.toThrow(/changed/);
    for (const [startMs, endMs] of [
      [500, 1000],
      [510, 1000],
      [1000, 3500],
      [1000, 1001],
    ]) {
      await expect(
        cutSegmentRange(t.d, { ...request, sourceKey: renderKey(before[0]), startMs, endMs }),
      ).rejects.toThrow(/both sides/);
    }
    expect(await segmentsForDraft(t.d)).toEqual(before);
    expect(
      conn.getFirstSync('SELECT last_clip_number, undo_history FROM drafts WHERE id = ?', t.d),
    ).toEqual(saved);
  });
});

describe('standalone split at playhead', () => {
  it.each(['split', 'speech cut'])(
    'skips a deleted %s after both applied halves are gone',
    async (kind) => {
      const t = await setup();
      const receipt =
        kind === 'split'
          ? await splitSegment(t.d, t.anchor())
          : await cutSegmentRange(t.d, {
              clipId: t.a,
              sourceKey: renderKey(t.before),
              startMs: 1500,
              endMs: 2000,
              rightId: `${t.d}-cut-right`,
              fps: 30,
            });
      retained.push(receipt.before);
      expect(receipt.fullyRemoved).toBe(false);
      await deleteSegment(t.a);
      await deleteSegment(receipt.rightId);
      const before = await segmentsForDraft(t.d);
      const draft = conn.getFirstSync('SELECT * FROM drafts WHERE id = ?', t.d);
      expect(await takeOutSegments([], [receipt], undefined, t.d)).toBeNull();
      expect(await segmentsForDraft(t.d)).toEqual(before);
      expect(before.map((row) => row.id)).toEqual([t.b]);
      expect(conn.getFirstSync('SELECT * FROM drafts WHERE id = ?', t.d)).toEqual(draft);
    },
  );

  it.each(['standalone', 'split + insert'])(
    'rejects a floating-point recut at the same playhead atomically (%s)',
    async (operation) => {
      const t = await setup();
      await setClipEdit(t.a, { ...edit, speed: 1.25 });
      const source = (await segmentsForDraft(t.d))[0];
      const playhead = 750.123;
      const sourceCut = 500 + playhead * 1.25;
      const receipt = await splitSegment(t.d, t.anchor(source, sourceCut));
      retained.push(receipt.before);
      const before = await segmentsForDraft(t.d);
      const right = before[1];
      const rightStart = effMs(before[0]);
      expect(sourceCut).toBe(1437.65375);
      expect(rightStart).toBe(750.1229999999999);
      // Converting the unchanged playhead back into source time can appear barely inside right.
      const recut = clipRender(right).inMs + (playhead - rightStart) * 1.25;
      expect(recut).toBeGreaterThan(sourceCut);
      const anchor = t.anchor(right, recut, `${t.d}-recut`);
      const counter = conn.getFirstSync('SELECT last_clip_number FROM drafts WHERE id = ?', t.d);
      const transcripts = transcript(right.id);
      const held = conn.getFirstSync(
        'SELECT value FROM settings WHERE key = ?',
        'drafts.heldForRedo',
      );
      await expect(
        operation === 'standalone'
          ? splitSegment(t.d, anchor)
          : insertSegments(t.d, anchor, [t.object()]),
      ).rejects.toThrow(/inside/);
      const after = await segmentsForDraft(t.d);
      expect(contentRows(after)).toEqual(contentRows(before));
      expect(after.every((row) => effMs(row) > 0 && row.editedDurationMs !== 0)).toBe(true);
      expect(conn.getFirstSync('SELECT last_clip_number FROM drafts WHERE id = ?', t.d)).toEqual(
        counter,
      );
      expect(transcript(right.id)).toEqual(transcripts);
      expect(
        conn.getFirstSync('SELECT value FROM settings WHERE key = ?', 'drafts.heldForRedo'),
      ).toEqual(held);
      expect(t.heard).toEqual([]);
      expect(bytes(t.video)).toBe('original video bytes');
    },
  );

  it.each([0.25, 1.25, 4].flatMap((speed) => ['start', 'end'].map((edge) => ({ speed, edge }))))(
    'keeps both split halves over one timeline millisecond at $edge, speed $speed',
    async ({ speed, edge }) => {
      const t = await setup();
      await setClipEdit(t.a, { ...edit, speed });
      const before = await segmentsForDraft(t.d);
      const render = clipRender(before[0]);
      const cut = (timelineMs: number) =>
        edge === 'start' ? render.inMs + timelineMs * speed : render.outMs - timelineMs * speed;
      const rejectedMedia = t.object();
      for (const timelineMs of [0.5, 1]) {
        const anchor = t.anchor(before[0], cut(timelineMs));
        await expect(splitSegment(t.d, anchor)).rejects.toThrow(/inside/);
        await expect(insertSegments(t.d, anchor, [rejectedMedia])).rejects.toThrow(/inside/);
      }
      expect(contentRows(await segmentsForDraft(t.d))).toEqual(contentRows(before));
      expect(
        conn.getFirstSync<{ n: number }>(
          'SELECT last_clip_number AS n FROM drafts WHERE id = ?',
          t.d,
        )?.n,
      ).toBe(2);
      expect(t.heard).toEqual([]);
      expect(bytes(t.video)).toBe('original video bytes');

      const receipt = await splitSegment(t.d, t.anchor(before[0], cut(1.1)));
      retained.push(receipt.before);
      const halves = (await segmentsForDraft(t.d)).slice(0, 2);
      expect(halves.every((row) => effMs(row) > 1 && row.editedDurationMs! > 0)).toBe(true);
      expect(effMs(halves[0]) + effMs(halves[1])).toBeCloseTo(effMs(before[0]));
    },
  );

  it('creates adjacent metadata halves with preserved edits/captions and no media-addition event', async () => {
    const t = await setup();
    const receipt = await splitSegment(t.d, t.anchor());
    retained.push(receipt.before);
    const rows = await segmentsForDraft(t.d);
    expect(rows.map((row) => row.id)).toEqual([t.a, receipt.rightId, t.b]);
    expect(rows.map((row) => row.label)).toEqual(['1', '3', '2']);
    expect(rows.map((row) => row.order)).toEqual([0, 1, 2]);
    expect(receipt.before.rows).toEqual([t.before]);
    expect(receipt.rightId).toBe(`${t.d}-right`);
    expect(receipt.firstInsertedId).toBeUndefined();
    expect(clipRender(rows[0])).toMatchObject({
      file: t.video,
      inMs: 500,
      outMs: 1500,
      speed: 2,
      rotation: 1,
      flipped: true,
    });
    expect(clipRender(rows[1])).toMatchObject({
      file: t.video,
      inMs: 1500,
      outMs: 3500,
      speed: 2,
      rotation: 1,
      flipped: true,
    });
    expect(effMs(rows[0]) + effMs(rows[1])).toBe(effMs(t.before));
    expect(rows.slice(0, 2).map((row) => row.captionEdit)).toEqual([
      t.before.captionEdit,
      t.before.captionEdit,
    ]);
    expect(transcript(receipt.rightId)).toEqual(transcript(t.a));
    expect(bytes(t.video)).toBe('original video bytes');
    expect(bytes(t.cover)).toBe('original cover bytes');
    expect(readdirSync(dirname(join(env.docDir, t.video))).sort()).toEqual(
      [`${t.a}.cover.1.jpg`, `${t.a}.mp4`].sort(),
    );
    expect(t.heard).toEqual([]);
    expect(takeClipsAdded(t.d)).toEqual([]);
    expect(takeClipSplits(t.d)).toEqual([]);
    expect(
      conn.getFirstSync<{ n: number }>('SELECT last_clip_number AS n FROM drafts WHERE id = ?', t.d)
        ?.n,
    ).toBe(3);
  });

  it.each([false, true])(
    'repeatedly undoes/redoes a split-only history step (legacy %s)',
    async (legacy) => {
      const t = await setup(legacy);
      const receipt = await splitSegment(t.d, t.anchor());
      const applied = await segmentsForDraft(t.d);
      const h = databaseHistory(t.d);
      h.history.recordAdded([], [receipt]);
      try {
        for (let cycle = 0; cycle < 3; cycle++) {
          // Even the immediate tap before a live-query update must undo the structural operation.
          h.history.undo(presentRows([t.before]), h.apply);
          await h.settled();
          expect(h.takeOut).toHaveBeenLastCalledWith([], [receipt]);
          expect((await segmentsForDraft(t.d)).map((row) => row.id)).toEqual([t.a, t.b]);
          expect((await segmentsForDraft(t.d))[0]).toEqual(t.before);
          expect(transcript(receipt.rightId)).toEqual([]);
          expect(bytes(t.video)).toBe('original video bytes');
          if (legacy) expect(bytes(t.baked)).toBe('baked video bytes');
          h.history.redo(await h.present(), h.apply);
          await h.settled();
          expect(contentRows(await segmentsForDraft(t.d))).toEqual(contentRows(applied));
          expect(transcript(receipt.rightId)).toEqual(transcript(t.a));
        }
        expect(h.failed).not.toHaveBeenCalled();
        expect(t.heard).toEqual([]);
      } finally {
        h.history.dispose();
      }
    },
  );

  it('keeps trim/reset within each standalone half and normalizes a legacy source', async () => {
    const t = await setup(true);
    const receipt = await splitSegment(t.d, t.anchor());
    retained.push(receipt.before);
    const halves = (await segmentsForDraft(t.d)).slice(0, 2);
    expect(halves.map((row) => row.originalFilename)).toEqual([t.baked, t.baked]);
    expect(halves.map((row) => row.editedFilename)).toEqual([null, null]);
    for (const [i, row] of halves.entries()) {
      await setClipEdit(row.id, { ...edit, startMs: 0, endMs: 4000, speed: 4 });
      await resetEdit(row.id);
      const current = (await segmentsForDraft(t.d)).find((r) => r.id === row.id)!;
      expect(clipRender(current)).toMatchObject({
        file: t.baked,
        inMs: i === 0 ? 0 : 1500,
        outMs: i === 0 ? 1500 : 3000,
        rotation: 0,
        speed: 1,
      });
    }
    expect(bytes(t.video)).toBe('original video bytes');
    expect(bytes(t.baked)).toBe('baked video bytes');
  });

  it('releases obsolete original media when its receipt is discarded and keeps a surviving sibling source', async () => {
    const t = await setup(true);
    const receipt = await splitSegment(t.d, t.anchor());
    expect(has(t.video)).toBe(true); // The unsplit original is held for Undo.
    conn.runSync('UPDATE drafts SET undo_history = NULL WHERE id = ?', t.d);
    await dropTakenOut(receipt.before);
    expect(has(t.video)).toBe(false);
    expect(has(t.baked)).toBe(true); // Both applied halves still use the baked source.
    await deleteSegment(t.a);
    expect(has(t.baked)).toBe(true); // Deleting the left half must preserve its sibling's source.
    await deleteSegment(receipt.rightId);
    expect(has(t.baked)).toBe(false);
  });

  it('invalidates a direct edit that finishes after a standalone split commits', async () => {
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
    const saving = setClipEdit(t.a, { ...edit, startMs: 0, endMs: 4000, speed: 1 });
    try {
      await entered;
      const receipt = await splitSegment(t.d, t.anchor());
      retained.push(receipt.before);
      const halves = await segmentsForDraft(t.d);
      finish(true);
      await saving;
      expect(contentRows(await segmentsForDraft(t.d))).toEqual(contentRows(halves));
      expect(clipRender(halves[0])).toMatchObject({ inMs: 500, outMs: 1500, speed: 2 });
    } finally {
      finish(true);
      await saving;
      thumbnail.mockRestore();
    }
  });

  it.each([500, 3500, NaN, Infinity])(
    'rejects invalid cut %s without fragments or counter changes',
    async (cut) => {
      const t = await setup();
      const before = await segmentsForDraft(t.d);
      await expect(splitSegment(t.d, t.anchor(t.before, cut))).rejects.toThrow(/inside/);
      expect(await segmentsForDraft(t.d)).toEqual(before);
      expect(
        conn.getFirstSync<{ n: number }>(
          'SELECT last_clip_number AS n FROM drafts WHERE id = ?',
          t.d,
        )?.n,
      ).toBe(2);
      expect(t.heard).toEqual([]);
    },
  );

  it.each<ClipAnchor>([{ at: 'end' }, { before: 'missing' }])(
    'rejects a boundary anchor %j',
    async (anchor) => {
      const t = await setup();
      const before = await segmentsForDraft(t.d);
      await expect(splitSegment(t.d, anchor)).rejects.toThrow(/inside/);
      expect(await segmentsForDraft(t.d)).toEqual(before);
    },
  );

  it('rejects stale, missing or reused targets instead of splitting somewhere else', async () => {
    const t = await setup();
    const anchor = t.anchor();
    conn.runSync(
      'UPDATE segments SET edit_state = ? WHERE id = ?',
      JSON.stringify({ ...edit, speed: 1 }),
      t.a,
    );
    const changed = await segmentsForDraft(t.d);
    await expect(splitSegment(t.d, anchor)).rejects.toThrow(/changed/);
    expect(await segmentsForDraft(t.d)).toEqual(changed);
    const receipt = await splitSegment(t.d, t.anchor(changed[0]));
    retained.push(receipt.before);
    const applied = await segmentsForDraft(t.d);
    await expect(splitSegment(t.d, anchor)).rejects.toThrow(/changed/);
    expect(contentRows(await segmentsForDraft(t.d))).toEqual(contentRows(applied));
    await deleteSegment(t.a);
    await expect(splitSegment(t.d, anchor)).rejects.toThrow(/changed/);
    expect(t.heard).toEqual([]);
  });

  it('waits for queued edits and rejects a cut captured before they changed the source', async () => {
    const t = await setup();
    let finish!: () => void;
    let reached!: () => void;
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
      const splitting = splitSegment(t.d, t.anchor());
      await entered;
      expect((await segmentsForDraft(t.d))[0]).toEqual(t.before);
      conn.runSync(
        'UPDATE segments SET edit_state = ? WHERE id = ?',
        JSON.stringify({ ...edit, speed: 1 }),
        t.a,
      );
      finish();
      await expect(splitting).rejects.toThrow(/changed/);
      expect((await segmentsForDraft(t.d)).map((row) => row.id)).toEqual([t.a, t.b]);
      expect(t.heard).toEqual([]);
    } finally {
      finish();
      restoreBarrier();
    }
  });
});

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

  it('skips a queued cleanup cover when a newer user edit is rendering', async () => {
    const t = await setup();
    let finishFirst!: (ok: boolean) => void;
    let finishUser!: (ok: boolean) => void;
    let reachedFirst!: () => void;
    let reachedUser!: () => void;
    let reachedTail!: () => void;
    const first = new Promise<boolean>((resolve) => {
      finishFirst = resolve;
    });
    const user = new Promise<boolean>((resolve) => {
      finishUser = resolve;
    });
    const enteredFirst = new Promise<void>((resolve) => {
      reachedFirst = resolve;
    });
    const enteredUser = new Promise<void>((resolve) => {
      reachedUser = resolve;
    });
    const enteredTail = new Promise<void>((resolve) => {
      reachedTail = resolve;
    });
    let calls = 0;
    let userCovers = 0;
    let targetId: string | undefined;
    let tailId: string | undefined;
    const thumbnail = jest.spyOn(video, 'generateThumbnailFile').mockImplementation((_, output) => {
      if (++calls === 1) {
        reachedFirst();
        return first;
      }
      if (targetId && output.includes(`${targetId}.cover.`)) {
        if (++userCovers === 1) {
          reachedUser();
          return user;
        }
      }
      if (tailId && output.includes(`${tailId}.cover.`)) reachedTail();
      return Promise.resolve(true);
    });
    let saving: Promise<void> | undefined;
    try {
      const result = await cutTranscriptRanges(t.d, [
        {
          clipId: t.a,
          sourceKey: renderKey(t.before),
          captionKey: t.before.captionEdit,
          fps: 30,
          ranges: [
            { startMs: 1000, endMs: 1200 },
            { startMs: 2000, endMs: 2200 },
          ],
        },
      ]);
      retained.push(...result.splits.map((split) => split.before));
      await enteredFirst;
      [targetId, tailId] = result.ids.slice(1);
      expect(targetId).toBeDefined();
      expect(tailId).toBeDefined();
      const target = (await segmentsForDraft(t.d)).find((row) => row.id === targetId)!;
      saving = setClipEdit(target.id, { ...parseEdit(target.editState)!, speed: 3, rotation: 2 });
      await enteredUser;
      finishFirst(true);
      // The last cover proves the serial worker has passed the actively edited middle clip.
      await enteredTail;
      finishUser(true);
      await saving;
      const saved = (await segmentsForDraft(t.d)).find((row) => row.id === targetId)!;
      expect(clipRender(saved)).toMatchObject({ speed: 3, rotation: 2 });
      expect(userCovers).toBe(1);
    } finally {
      finishFirst(true);
      finishUser(true);
      await saving;
      thumbnail.mockRestore();
    }
  });

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
