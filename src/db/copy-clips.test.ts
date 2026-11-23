import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// "From another Pulse" (#308): copying clips between drafts, on the real migrations (node:sqlite
// behind the drizzle expo driver) and real files in a temp folder (the node stand-in for
// expo-file-system), so the file copies, their clean-up and the remapped paths are the real ones.
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
jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));
jest.mock('@/utils/video', () => ({}));
jest.mock('./secure-token', () => ({ deleteSavedLink: async () => {} }));
jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: () => `id${++n}` };
});

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { onClipsAdded, type ClipsAdded } from '@/core/clip-anchor';
import { env, File } from '@/test-support/expo-fs-node';
import { expoDb } from './client';
import {
  addSegment,
  anotherDraftClipQuery,
  copyClipsInto,
  createDraft,
  otherDraftsQuery,
} from './drafts';
/* eslint-enable import/first */

const conn = expoDb as unknown as {
  getAllSync: <T>(sql: string, ...params: unknown[]) => T[];
  runSync: (sql: string, ...params: unknown[]) => unknown;
};

const ROOT = mkdtempSync(join(tmpdir(), 'pulse-copy-clips-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
let devices = 0;
beforeEach(() => {
  env.docDir = join(ROOT, `device-${++devices}`);
  env.cacheDir = join(env.docDir, 'Caches');
  mkdirSync(env.docDir, { recursive: true });
});

const put = (rel: string, body = rel) => {
  const path = join(env.docDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};
const read = (rel: string) => readFileSync(join(env.docDir, rel), 'utf8');
const has = (rel: string) => existsSync(join(env.docDir, rel));
const filesOf = (draftId: string) => {
  const dir = join(env.docDir, 'drafts', draftId, 'segments');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

type Row = {
  id: string;
  label: string;
  original_filename: string;
  edited_filename: string | null;
  duration_ms: number;
  edited_duration_ms: number | null;
  edit_state: string | null;
  thumbnail: string | null;
  caption_edit: string | null;
};
const rows = (draftId: string) =>
  conn.getAllSync<Row>(
    'SELECT id, label, original_filename, edited_filename, duration_ms, edited_duration_ms, ' +
      'edit_state, thumbnail, caption_edit FROM segments WHERE draft_id = ? ORDER BY sort_order',
    draftId,
  );
const transcripts = (segmentId: string) =>
  conn.getAllSync<{ model: string; file: string; status: string; words: string | null }>(
    'SELECT model, file, status, words FROM clip_transcripts WHERE segment_id = ?',
    segmentId,
  );

const EDIT = JSON.stringify({
  startMs: 500,
  endMs: 2500,
  rotation: 1,
  flipped: true,
  crop: null,
  muted: true,
  speed: 2,
});

/**
 * A draft with clips a, b, c (ids `<draft>a`…), each with its video and cover on disk; b edited
 * (trim, speed, rotation, flip, mute), with edited captions and a clip transcript.
 */
async function source(): Promise<{ draftId: string; a: string; b: string; c: string }> {
  const draftId = await createDraft({ name: 'Trip' });
  const ids = { a: `${draftId}a`, b: `${draftId}b`, c: `${draftId}c` };
  for (const id of Object.values(ids)) {
    const video = `drafts/${draftId}/segments/${id}.mp4`;
    const cover = `drafts/${draftId}/segments/${id}.thumb.jpg`;
    put(video);
    put(cover);
    await addSegment(draftId, { id, originalFilename: video, durationMs: 4000, thumbnail: cover });
  }
  const bVideo = `drafts/${draftId}/segments/${ids.b}.mp4`;
  const bCover = `drafts/${draftId}/segments/${ids.b}.cover.7.jpg`;
  put(bCover);
  conn.runSync(
    'UPDATE segments SET edit_state = ?, edited_duration_ms = 1000, thumbnail = ?, caption_edit = ? WHERE id = ?',
    EDIT,
    bCover,
    JSON.stringify({ file: bVideo, words: [{ text: 'hi', t0: 10, t1: 40 }] }),
    ids.b,
  );
  conn.runSync(
    "INSERT INTO clip_transcripts (segment_id, model, file, status, words) VALUES (?, 'base', ?, 'done', ?)",
    ids.b,
    bVideo,
    '[{"text":"hi","t0":10,"t1":40}]',
  );
  return { draftId, ...ids };
}

/** A draft with clips x, y. */
async function target(): Promise<{ draftId: string; x: string; y: string }> {
  const draftId = await createDraft();
  for (const id of [`${draftId}x`, `${draftId}y`]) {
    const video = `drafts/${draftId}/segments/${id}.mp4`;
    put(video);
    await addSegment(draftId, { id, originalFilename: video, durationMs: 1000 });
  }
  return { draftId, x: `${draftId}x`, y: `${draftId}y` };
}

describe('copyClipsInto', () => {
  it('copies the clips at the anchor, in the source’s order, with the target’s next labels', async () => {
    const src = await source();
    const dst = await target();
    // Picked out of order: they still go in as a, c.
    const { segmentIds, skipped } = await copyClipsInto(dst.draftId, src.draftId, [src.c, src.a], {
      after: dst.x,
    });
    expect(skipped).toBe(0);
    expect(segmentIds).toHaveLength(2);
    const got = rows(dst.draftId);
    expect(got.map((r) => r.id)).toEqual([dst.x, ...segmentIds, dst.y]);
    expect(got.map((r) => r.label)).toEqual(['1', '3', '4', '2']);
    // Each copy plays its own file, a copy of the source's.
    const [a, c] = segmentIds;
    expect(got[1].original_filename).toBe(`drafts/${dst.draftId}/segments/${a}.mp4`);
    expect(read(got[1].original_filename)).toBe(`drafts/${src.draftId}/segments/${src.a}.mp4`);
    expect(read(got[2].original_filename)).toBe(`drafts/${src.draftId}/segments/${src.c}.mp4`);
    expect(got[2].thumbnail).toBe(`drafts/${dst.draftId}/segments/${c}.thumb.jpg`);
    expect(has(got[2].thumbnail!)).toBe(true);
  });

  it.each([
    ['before the first clip', (x: string) => ({ before: x }), 0],
    ['at the end', () => ({ at: 'end' as const }), 2],
  ])('inserts %s', async (_name, anchor, at) => {
    const src = await source();
    const dst = await target();
    const { segmentIds } = await copyClipsInto(dst.draftId, src.draftId, [src.b], anchor(dst.x));
    expect(rows(dst.draftId).map((r) => r.id)[at]).toBe(segmentIds[0]);
  });

  it('brings the edit, the captions and the transcripts, their paths remapped', async () => {
    const src = await source();
    const dst = await target();
    const {
      segmentIds: [b],
    } = await copyClipsInto(dst.draftId, src.draftId, [src.b], { at: 'end' });
    const row = rows(dst.draftId).find((r) => r.id === b)!;
    const video = `drafts/${dst.draftId}/segments/${b}.mp4`;
    expect(row).toMatchObject({
      original_filename: video,
      duration_ms: 4000,
      edited_duration_ms: 1000,
      edit_state: EDIT,
      thumbnail: `drafts/${dst.draftId}/segments/${b}.cover.7.jpg`,
    });
    expect(has(row.thumbnail!)).toBe(true);
    expect(JSON.parse(row.caption_edit!)).toEqual({
      file: video,
      words: [{ text: 'hi', t0: 10, t1: 40 }],
    });
    expect(transcripts(b)).toEqual([
      { model: 'base', file: video, status: 'done', words: '[{"text":"hi","t0":10,"t1":40}]' },
    ]);
  });

  it('leaves the source as it was, and may read it while it uploads', async () => {
    const src = await source();
    const dst = await target();
    conn.runSync("UPDATE drafts SET upload_status = 'uploading' WHERE id = ?", src.draftId);
    const before = { rows: rows(src.draftId), files: filesOf(src.draftId), t: transcripts(src.b) };
    await copyClipsInto(dst.draftId, src.draftId, [src.a, src.b, src.c], { at: 'end' });
    expect(rows(dst.draftId)).toHaveLength(5);
    expect({ rows: rows(src.draftId), files: filesOf(src.draftId), t: transcripts(src.b) }).toEqual(
      before,
    );
  });

  it('is one addition, heard once with every copy', async () => {
    const src = await source();
    const dst = await target();
    const heard: ClipsAdded[] = [];
    const stop = onClipsAdded((added) => heard.push(added));
    const { segmentIds } = await copyClipsInto(dst.draftId, src.draftId, [src.a, src.c], {
      before: dst.y,
    });
    stop();
    expect(heard).toEqual([
      expect.objectContaining({ draftId: dst.draftId, segmentIds, prevId: dst.x, nextId: dst.y }),
    ]);
  });

  it('skips a clip whose video is missing, leaving none of its files behind', async () => {
    const src = await source();
    const dst = await target();
    rmSync(join(env.docDir, `drafts/${src.draftId}/segments/${src.b}.mp4`));
    const progress: number[] = [];
    const { segmentIds, skipped } = await copyClipsInto(
      dst.draftId,
      src.draftId,
      [src.a, src.b, src.c],
      { at: 'end' },
      (done) => progress.push(done),
    );
    expect(skipped).toBe(1);
    expect(segmentIds).toHaveLength(2);
    expect(progress).toEqual([1, 2, 3]);
    // Only the two copies' videos and covers.
    expect(filesOf(dst.draftId)).toEqual(
      [
        `${dst.x}.mp4`,
        `${dst.y}.mp4`,
        ...segmentIds.flatMap((id) => [`${id}.mp4`, `${id}.thumb.jpg`]),
      ].sort(),
    );
  });

  it('adds nothing when every video is missing', async () => {
    const src = await source();
    const dst = await target();
    rmSync(join(env.docDir, 'drafts', src.draftId), { recursive: true });
    expect(await copyClipsInto(dst.draftId, src.draftId, [src.a], { at: 'end' })).toEqual({
      draftId: dst.draftId,
      segmentIds: [],
      skipped: 1,
    });
    expect(rows(dst.draftId)).toHaveLength(2);
  });

  it('makes a target draft only once a clip has something to copy', async () => {
    const src = await source();
    const make = jest.fn(async () => createDraft());
    rmSync(join(env.docDir, `drafts/${src.draftId}/segments/${src.a}.mp4`));
    // Only a's video was asked for, and it's missing: no draft.
    expect(await copyClipsInto(make, src.draftId, [src.a], { at: 'end' })).toEqual({
      draftId: null,
      segmentIds: [],
      skipped: 1,
    });
    expect(make).not.toHaveBeenCalled();
    // a missing, b and c there: one draft, made once, holding the two copies.
    const result = await copyClipsInto(make, src.draftId, [src.a, src.b, src.c], { at: 'end' });
    expect(make).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(1);
    expect(rows(result.draftId!).map((r) => r.id)).toEqual(result.segmentIds);
    expect(result.segmentIds).toHaveLength(2);
  });

  it('skips a clip deleted from the source during the copy', async () => {
    const src = await source();
    const dst = await target();
    const { skipped, segmentIds } = await copyClipsInto(
      dst.draftId,
      src.draftId,
      [src.a, src.c],
      { at: 'end' },
      (done) => {
        if (done !== 1) return;
        conn.runSync('DELETE FROM segments WHERE id = ?', src.c);
        rmSync(join(env.docDir, `drafts/${src.draftId}/segments/${src.c}.mp4`));
      },
    );
    expect({ skipped, copies: segmentIds.length }).toEqual({ skipped: 1, copies: 1 });
  });

  it('deletes the copies’ files when the rows can’t go in (the target deleted meanwhile)', async () => {
    const src = await source();
    const dst = await target();
    await expect(
      copyClipsInto(dst.draftId, src.draftId, [src.a, src.b], { at: 'end' }, (done) => {
        if (done === 2) conn.runSync('DELETE FROM drafts WHERE id = ?', dst.draftId);
      }),
    ).rejects.toThrow();
    expect(filesOf(dst.draftId)).toEqual([`${dst.x}.mp4`, `${dst.y}.mp4`]);
  });

  it('stops at a copy that fails (a full disk): nothing is added, no file is left', async () => {
    const src = await source();
    const dst = await target();
    const realCopy = File.prototype.copy;
    // The second clip's video runs out of space part-way: a partial file, then a throw.
    const copy = jest.spyOn(File.prototype, 'copy').mockImplementation(async function (
      this: File,
      dest: File,
    ) {
      if (!this.path.endsWith(`${src.b}.mp4`)) return realCopy.call(this, dest);
      writeFileSync(dest.path, 'part');
      throw new Error('No space left on device');
    });
    try {
      await expect(
        copyClipsInto(dst.draftId, src.draftId, [src.a, src.b, src.c], { at: 'end' }),
      ).rejects.toThrow(/No space left/);
    } finally {
      copy.mockRestore();
    }
    // Not taken for a missing video: c was never tried, and a's copies are gone with b's part.
    expect(copy.mock.calls.some(([dest]) => dest.path.includes(src.c))).toBe(false);
    expect(filesOf(dst.draftId)).toEqual([`${dst.x}.mp4`, `${dst.y}.mp4`]);
    expect(rows(dst.draftId)).toHaveLength(2);
  });

  it('refuses a target that is uploading before copying anything', async () => {
    const src = await source();
    const dst = await target();
    conn.runSync("UPDATE drafts SET upload_status = 'uploading' WHERE id = ?", dst.draftId);
    await expect(copyClipsInto(dst.draftId, src.draftId, [src.a], { at: 'end' })).rejects.toThrow(
      /uploading/,
    );
    expect(filesOf(dst.draftId)).toEqual([`${dst.x}.mp4`, `${dst.y}.mp4`]);
    expect(rows(dst.draftId)).toHaveLength(2);
  });

  it('refuses an embedded target whose Send is uploading (draft.locked)', async () => {
    const src = await source();
    const dst = await target();
    conn.runSync(
      "INSERT INTO upload_jobs (draft_id, state, client_key, draft_key, merged_signature, sent_at) VALUES (?, 'uploading', 'k', 'd', 's', 0)",
      dst.draftId,
    );
    await expect(
      copyClipsInto(dst.draftId, src.draftId, [src.a], { at: 'end' }),
    ).rejects.toMatchObject({ code: 'draft.locked' });
    expect(rows(dst.draftId)).toHaveLength(2);
  });

  it('refuses to copy a draft into itself', async () => {
    const src = await source();
    await expect(copyClipsInto(src.draftId, src.draftId, [src.a], { at: 'end' })).rejects.toThrow();
  });

  it('copies a legacy baked edit’s file, and a shared original once under a fresh name', async () => {
    const src = await source();
    const dst = await target();
    // c plays a baked file; a second clip d is a split of a, sharing a's original.
    const baked = `drafts/${src.draftId}/segments/${src.c}.edited.3.mp4`;
    put(baked, 'baked');
    conn.runSync('UPDATE segments SET edited_filename = ? WHERE id = ?', baked, src.c);
    const shared = `drafts/${src.draftId}/segments/${src.a}.mp4`;
    await addSegment(src.draftId, {
      id: `${src.draftId}d`,
      originalFilename: shared,
      durationMs: 2000,
    });
    const { segmentIds } = await copyClipsInto(
      dst.draftId,
      src.draftId,
      [src.c, `${src.draftId}d`],
      { at: 'end' },
    );
    const [c, d] = segmentIds.map((id) => rows(dst.draftId).find((r) => r.id === id)!);
    expect(c.edited_filename).toBe(`drafts/${dst.draftId}/segments/${c.id}.edited.3.mp4`);
    expect(read(c.edited_filename!)).toBe('baked');
    // d's file is named after a (not copied), so it gets a name of its own in the target.
    expect(d.original_filename).not.toContain(src.a);
    expect(d.original_filename.startsWith(`drafts/${dst.draftId}/segments/`)).toBe(true);
    expect(read(d.original_filename)).toBe(shared);
  });
});

describe('otherDraftsQuery', () => {
  it('lists the other drafts with clips, never the current one', async () => {
    const src = await source();
    const dst = await target();
    await createDraft({ name: 'Empty' });
    const others = await otherDraftsQuery(dst.draftId);
    expect(others.map((d) => d.id)).not.toContain(dst.draftId);
    expect(others.map((d) => d.id)).toContain(src.draftId);
    expect(others.every((d) => d.segmentCount > 0)).toBe(true);
    expect(others.find((d) => d.id === src.draftId)).toMatchObject({
      name: 'Trip',
      segmentCount: 3,
      // Trim-aware: b's edit is 1 s.
      durationMs: 9000,
      firstSegmentThumbnail: `drafts/${src.draftId}/segments/${src.a}.thumb.jpg`,
    });
    // A recorder without a draft yet: every draft with clips.
    expect((await otherDraftsQuery(null)).map((d) => d.id)).toEqual(
      expect.arrayContaining([src.draftId, dst.draftId]),
    );
  });

  it('says whether another draft has a clip (the menu item), cheaply', async () => {
    const only = await target();
    const empty = await createDraft();
    // Every draft so far is this file's: only the other drafts' clips count.
    conn.runSync('DELETE FROM segments WHERE draft_id != ?', only.draftId);
    expect(await anotherDraftClipQuery(only.draftId)).toEqual([]);
    expect(await anotherDraftClipQuery(empty)).toHaveLength(1);
    expect(await anotherDraftClipQuery(null)).toHaveLength(1);
  });
});
