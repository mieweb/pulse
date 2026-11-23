import { describe, expect, it, jest } from '@jest/globals';

// Inserting clips at an anchor, on the real migrations (node:sqlite behind the drizzle expo
// driver), so the unique (draft_id, sort_order) index is the real one.
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
  return { randomUUID: () => `draft${++n}` };
});

/* eslint-disable import/first -- the mocks above must be registered before these load */
import {
  expectClipsAdded,
  onClipsAdded,
  takeClipsAdded,
  type ClipAnchor,
  type ClipsAdded,
} from '@/core/clip-anchor';
import { expoDb } from './client';
import * as fileStore from '@/utils/file-store';
import {
  addSegment,
  createDraft,
  deleteSegment,
  dropTakenOut,
  insertSegments,
  reorderSegments,
  restoreSegments,
  takeOutSegments,
} from './drafts';
/* eslint-enable import/first */

const conn = expoDb as unknown as {
  getAllSync: <T>(sql: string, ...params: unknown[]) => T[];
  getFirstSync: <T>(sql: string, ...params: unknown[]) => T | null;
};

const clip = (id: string) => ({
  id,
  originalFilename: `drafts/x/segments/${id}.mp4`,
  durationMs: 1,
});

/** The draft's clips in order, as `id:label`. */
const clips = (draftId: string) =>
  conn
    .getAllSync<{ id: string; label: string }>(
      'SELECT id, label FROM segments WHERE draft_id = ? ORDER BY sort_order',
      draftId,
    )
    .map((r) => `${r.id}:${r.label}`);
const ids = (draftId: string) => clips(draftId).map((c) => c.split(':')[0]);
const lastClipNumber = (draftId: string) =>
  conn.getFirstSync<{ n: number }>('SELECT last_clip_number AS n FROM drafts WHERE id = ?', draftId)
    ?.n;

/** A draft with clips a, b, c (labels 1–3). */
async function abc(): Promise<string> {
  const draftId = await createDraft();
  for (const id of ['a', 'b', 'c']) await addSegment(draftId, clip(`${draftId}${id}`));
  return draftId;
}
const s = (draftId: string, id: string) => `${draftId}${id}`;

describe('insertSegments', () => {
  const cases: [string, (d: string) => ClipAnchor, string[]][] = [
    ['before the first clip', (d) => ({ before: s(d, 'a') }), ['x', 'a', 'b', 'c']],
    ['before a middle clip', (d) => ({ before: s(d, 'b') }), ['a', 'x', 'b', 'c']],
    ['after a middle clip', (d) => ({ after: s(d, 'b') }), ['a', 'b', 'x', 'c']],
    ['after the last clip', (d) => ({ after: s(d, 'c') }), ['a', 'b', 'c', 'x']],
    ['at the end', () => ({ at: 'end' }), ['a', 'b', 'c', 'x']],
  ];
  it.each(cases)('inserts %s', async (_name, anchor, expected) => {
    const d = await abc();
    expect(await insertSegments(d, anchor(d), [clip(s(d, 'x'))])).toEqual([s(d, 'x')]);
    expect(ids(d)).toEqual(expected.map((id) => s(d, id)));
    // The new clip takes the next badge number.
    expect(clips(d)).toContain(`${s(d, 'x')}:4`);
    expect(lastClipNumber(d)).toBe(4);
  });

  it('inserts several clips together, in order, with consecutive labels', async () => {
    const d = await abc();
    const added = await insertSegments(d, { after: s(d, 'a') }, [
      clip(s(d, 'x')),
      clip(s(d, 'y')),
      clip(s(d, 'z')),
    ]);
    expect(added).toEqual([s(d, 'x'), s(d, 'y'), s(d, 'z')]);
    expect(clips(d)).toEqual(['a:1', 'x:4', 'y:5', 'z:6', 'b:2', 'c:3'].map((c) => `${d}${c}`));
    expect(lastClipNumber(d)).toBe(6);
  });

  it('a run of takes, each after the one before, stays in order', async () => {
    const d = await abc();
    let anchor: ClipAnchor = { before: s(d, 'b') };
    for (const id of ['x', 'y', 'z']) {
      const [added] = await insertSegments(d, anchor, [clip(s(d, id))]);
      anchor = { after: added };
    }
    expect(ids(d)).toEqual(['a', 'x', 'y', 'z', 'b', 'c'].map((id) => s(d, id)));
  });

  it('goes to the end when the anchor clip was deleted meanwhile, or is in another draft', async () => {
    const d = await abc();
    await deleteSegment(s(d, 'b'));
    await insertSegments(d, { before: s(d, 'b') }, [clip(s(d, 'x'))]);
    expect(ids(d)).toEqual(['a', 'c', 'x'].map((id) => s(d, id)));

    const other = await abc();
    await insertSegments(d, { after: s(other, 'a') }, [clip(s(d, 'y'))]);
    expect(ids(d)).toEqual(['a', 'c', 'x', 'y'].map((id) => s(d, id)));
    expect(ids(other)).toEqual(['a', 'b', 'c'].map((id) => s(other, id)));
  });

  it('keeps slots unique around the holes deletes leave', async () => {
    const d = await abc();
    await addSegment(d, clip(s(d, 'd')));
    await deleteSegment(s(d, 'b')); // orders 0, 2, 3
    await insertSegments(d, { before: s(d, 'c') }, [clip(s(d, 'x')), clip(s(d, 'y'))]);
    await insertSegments(d, { after: s(d, 'a') }, [clip(s(d, 'z'))]);
    expect(ids(d)).toEqual(['a', 'z', 'x', 'y', 'c', 'd'].map((id) => s(d, id)));
    const orders = conn
      .getAllSync<{ o: number }>('SELECT sort_order AS o FROM segments WHERE draft_id = ?', d)
      .map((r) => r.o);
    expect(orders.every((o) => o >= 0)).toBe(true);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('inserts into an empty draft, whatever the anchor', async () => {
    const d = await createDraft();
    await insertSegments(d, { before: 'gone' }, [clip(s(d, 'x'))]);
    expect(clips(d)).toEqual([`${s(d, 'x')}:1`]);
  });

  it('writes nothing for a missing draft, and changes no other draft', async () => {
    const other = await abc();
    await expect(insertSegments('missing', { at: 'end' }, [clip('x')])).rejects.toThrow(
      /not found/,
    );
    expect(ids(other)).toEqual(['a', 'b', 'c'].map((id) => s(other, id)));
    expect(conn.getFirstSync('SELECT id FROM segments WHERE id = ?', 'x')).toBeNull();
  });

  it('tells clips-added listeners, and keeps the ids for the editor', async () => {
    const d = await abc();
    const disarm = expectClipsAdded(d);
    const heard: ClipsAdded[] = [];
    const stop = onClipsAdded((a) => heard.push(a));
    try {
      await insertSegments(d, { before: s(d, 'a') }, [clip(s(d, 'x')), clip(s(d, 'y'))]);
      await addSegment(d, clip(s(d, 'z')));
    } finally {
      stop();
    }
    expect(heard).toEqual([
      {
        draftId: d,
        segmentIds: [s(d, 'x'), s(d, 'y')],
        anchor: { before: s(d, 'a') },
        prevId: null,
        nextId: s(d, 'a'),
      },
      {
        draftId: d,
        segmentIds: [s(d, 'z')],
        anchor: { at: 'end' },
        prevId: s(d, 'c'),
        nextId: null,
      },
    ]);
    expect(takeClipsAdded(d)).toEqual([s(d, 'x'), s(d, 'y'), s(d, 'z')]);
    expect(takeClipsAdded(d)).toEqual([]);
    disarm();
  });
});

describe('where clips land, for the recorder’s cursor', () => {
  it('reports the clips either side, whichever anchor named the slot', async () => {
    const d = await abc();
    const heard: ClipsAdded[] = [];
    const stop = onClipsAdded((a) => heard.push(a));
    try {
      await insertSegments(d, { after: s(d, 'a') }, [clip(s(d, 'x'))]);
      await insertSegments(d, { before: s(d, 'b') }, [clip(s(d, 'y'))]);
      await insertSegments(d, { after: 'gone' }, [clip(s(d, 'z'))]);
    } finally {
      stop();
    }
    expect(heard.map((a) => [a.prevId, a.nextId])).toEqual([
      [s(d, 'a'), s(d, 'b')],
      [s(d, 'x'), s(d, 'b')],
      [s(d, 'c'), null],
    ]);
  });

  it('reads an anchor given as a function once the draft’s earlier writes are done', async () => {
    const d = await abc();
    let anchor: ClipAnchor = { before: s(d, 'a') };
    const write = insertSegments(d, () => anchor, [clip(s(d, 'x'))]);
    // Moved after the call, before the write: the write follows it.
    anchor = { before: s(d, 'c') };
    await write;
    expect(ids(d)).toEqual(['a', 'b', 'x', 'c'].map((id) => s(d, id)));
  });
});

describe('reorderSegments with clips it was not given', () => {
  it('an order worked out before an insert applies over it without a collision', async () => {
    const d = await abc();
    await insertSegments(d, { before: s(d, 'b') }, [clip(s(d, 'x'))]); // a x b c
    // The editor's order from before the insert: c a b.
    await reorderSegments([s(d, 'c'), s(d, 'a'), s(d, 'b')]);
    expect(ids(d)).toEqual(['c', 'x', 'a', 'b'].map((id) => s(d, id)));
  });

  it('skips ids that have gone, and moves only the clips it names', async () => {
    const d = await abc();
    await addSegment(d, clip(s(d, 'd'))); // a b c d
    await deleteSegment(s(d, 'b'));
    await reorderSegments([s(d, 'd'), s(d, 'b'), s(d, 'a')]);
    expect(ids(d)).toEqual(['d', 'c', 'a'].map((id) => s(d, id)));
  });

  it('a reorder and an insert running together never collide, in either order', async () => {
    for (const reorderFirst of [true, false]) {
      const d = await abc();
      const reorder = () => reorderSegments([s(d, 'c'), s(d, 'b'), s(d, 'a')]);
      const insert = () => insertSegments(d, { after: s(d, 'a') }, [clip(s(d, 'x'))]);
      await Promise.all(reorderFirst ? [reorder(), insert()] : [insert(), reorder()]);
      // Every clip is there once, and the reorder holds for the clips it named.
      const order = ids(d);
      expect([...order].sort()).toEqual(['a', 'b', 'c', 'x'].map((id) => s(d, id)).sort());
      expect(order.filter((id) => id !== s(d, 'x'))).toEqual(['c', 'b', 'a'].map((id) => s(d, id)));
    }
  });
});

describe('taking added clips out and putting them back (the editor’s undo/redo of an addition)', () => {
  /** a x y b c: x and y added before b. */
  async function added(): Promise<string> {
    const d = await abc();
    await insertSegments(d, { before: s(d, 'b') }, [clip(s(d, 'x')), clip(s(d, 'y'))]);
    return d;
  }

  it('takes the clips out keeping their files, and puts them back where they were', async () => {
    const d = await added();
    const before = clips(d);
    const del = jest.spyOn(fileStore, 'deleteSegmentFile').mockImplementation(() => {});
    try {
      const taken = await takeOutSegments([s(d, 'x'), s(d, 'y')]);
      expect(ids(d)).toEqual(['a', 'b', 'c'].map((id) => s(d, id)));
      expect(del).not.toHaveBeenCalled();
      expect(taken?.rows.map((r) => r.id)).toEqual([s(d, 'x'), s(d, 'y')]);
      await restoreSegments(taken!);
      // Same places and the same badge numbers; the counter isn't touched.
      expect(clips(d)).toEqual(before);
      expect(lastClipNumber(d)).toBe(5);
      expect(del).not.toHaveBeenCalled();
    } finally {
      del.mockRestore();
    }
  });

  it('keeps a clip’s edit and transcript across the round trip', async () => {
    const d = await added();
    conn.getAllSync(
      `UPDATE segments SET edit_state = '{"muted":true}', caption_edit = 'c' WHERE id = ?`,
      s(d, 'x'),
    );
    conn.getAllSync(
      "INSERT INTO clip_transcripts (segment_id, model, file, status, words) VALUES (?, 'm', 'f', 'done', '[]')",
      s(d, 'x'),
    );
    const row = () => conn.getFirstSync('SELECT * FROM segments WHERE id = ?', s(d, 'x'));
    const was = row();
    const taken = await takeOutSegments([s(d, 'x')]);
    expect(row()).toBeNull();
    expect(
      conn.getAllSync('SELECT * FROM clip_transcripts WHERE segment_id = ?', s(d, 'x')),
    ).toEqual([]);
    await restoreSegments(taken!);
    expect(row()).toEqual(was);
    expect(
      conn.getAllSync('SELECT model FROM clip_transcripts WHERE segment_id = ?', s(d, 'x')),
    ).toEqual([{ model: 'm' }]);
  });

  it('puts clips back after the clip they followed even after a reorder', async () => {
    const d = await added(); // a x y b c
    const taken = await takeOutSegments([s(d, 'x'), s(d, 'y')]); // a b c
    await reorderSegments([s(d, 'c'), s(d, 'a'), s(d, 'b')]); // c a b
    await restoreSegments(taken!);
    expect(ids(d)).toEqual(['c', 'a', 'x', 'y', 'b'].map((id) => s(d, id)));
  });

  it('puts clips at the front before the clip they preceded, and at the end with no neighbour', async () => {
    const d = await abc();
    await insertSegments(d, { before: s(d, 'a') }, [clip(s(d, 'x'))]); // x a b c
    const front = await takeOutSegments([s(d, 'x')]);
    await restoreSegments(front!);
    expect(ids(d)).toEqual(['x', 'a', 'b', 'c'].map((id) => s(d, id)));

    const lone = await createDraft();
    await addSegment(lone, clip(s(lone, 'p')));
    await addSegment(lone, clip(s(lone, 'q')));
    const taken = await takeOutSegments([s(lone, 'q')]);
    await deleteSegment(s(lone, 'p'));
    await addSegment(lone, clip(s(lone, 'r')));
    await restoreSegments(taken!);
    expect(ids(lone)).toEqual([s(lone, 'r'), s(lone, 'q')]);
  });

  it('skips clips already gone, and takes nothing out when none is left', async () => {
    const d = await added();
    await deleteSegment(s(d, 'x'));
    const taken = await takeOutSegments([s(d, 'x'), s(d, 'y')]);
    expect(taken?.rows.map((r) => r.id)).toEqual([s(d, 'y')]);
    expect(await takeOutSegments([s(d, 'x')])).toBeNull();
  });

  it('drops the files of clips never put back, and keeps those that are back', async () => {
    const d = await added();
    const del = jest.spyOn(fileStore, 'deleteSegmentFile').mockImplementation(() => {});
    try {
      const taken = await takeOutSegments([s(d, 'x')]);
      await dropTakenOut(taken!);
      expect(del).toHaveBeenCalledWith(`drafts/x/segments/${s(d, 'x')}.mp4`);

      del.mockClear();
      const back = await takeOutSegments([s(d, 'y')]);
      await restoreSegments(back!);
      await dropTakenOut(back!);
      expect(del).not.toHaveBeenCalled();
    } finally {
      del.mockRestore();
    }
  });

  it('tells no clips-added listener when clips are put back', async () => {
    const d = await added();
    const taken = await takeOutSegments([s(d, 'x')]);
    const heard: ClipsAdded[] = [];
    const stop = onClipsAdded((a) => heard.push(a));
    try {
      await restoreSegments(taken!);
    } finally {
      stop();
    }
    expect(heard).toEqual([]);
  });
});
