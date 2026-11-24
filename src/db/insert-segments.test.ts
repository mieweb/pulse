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
  deleteDraft,
  deleteSegment,
  dropTakenOut,
  insertSegments,
  reorderSegments,
  restoreSegments,
  takeOutSegments,
} from './drafts';
import { dropHeldFiles } from './held-files';
import { referencedMediaPaths } from './media-refs';
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
/** a x y b c: x and y added before b. */
async function added(): Promise<string> {
  const d = await abc();
  await insertSegments(d, { before: s(d, 'b') }, [clip(s(d, 'x')), clip(s(d, 'y'))]);
  return d;
}

describe('insertSegments', () => {
  const cases: [string, (d: string) => ClipAnchor, string[]][] = [
    ['before the first clip', (d) => ({ before: s(d, 'a') }), ['x', 'a', 'b', 'c']],
    ['before a middle clip', (d) => ({ before: s(d, 'b') }), ['a', 'x', 'b', 'c']],
    [
      'before a clip, with its next clip',
      (d) => ({ before: s(d, 'b'), next: s(d, 'c') }),
      ['a', 'x', 'b', 'c'],
    ],
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
    const added = await insertSegments(d, { before: s(d, 'b') }, [
      clip(s(d, 'x')),
      clip(s(d, 'y')),
      clip(s(d, 'z')),
    ]);
    expect(added).toEqual([s(d, 'x'), s(d, 'y'), s(d, 'z')]);
    expect(clips(d)).toEqual(['a:1', 'x:4', 'y:5', 'z:6', 'b:2', 'c:3'].map((c) => `${d}${c}`));
    expect(lastClipNumber(d)).toBe(6);
  });

  it('a run of takes at one anchor stays in order', async () => {
    const d = await abc();
    const anchor: ClipAnchor = { before: s(d, 'b'), next: s(d, 'c') };
    for (const id of ['x', 'y', 'z']) await insertSegments(d, anchor, [clip(s(d, id))]);
    expect(ids(d)).toEqual(['a', 'x', 'y', 'z', 'b', 'c'].map((id) => s(d, id)));
  });

  it('goes to the end when the anchor clip (and its next) are gone, or in another draft', async () => {
    const d = await abc();
    await deleteSegment(s(d, 'b'));
    await insertSegments(d, { before: s(d, 'b') }, [clip(s(d, 'x'))]);
    expect(ids(d)).toEqual(['a', 'c', 'x'].map((id) => s(d, id)));

    const other = await abc();
    await insertSegments(d, { before: s(other, 'a'), next: s(other, 'b') }, [clip(s(d, 'y'))]);
    expect(ids(d)).toEqual(['a', 'c', 'x', 'y'].map((id) => s(d, id)));
    expect(ids(other)).toEqual(['a', 'b', 'c'].map((id) => s(other, id)));
  });

  it('keeps slots unique around the holes deletes leave', async () => {
    const d = await abc();
    await addSegment(d, clip(s(d, 'd')));
    await deleteSegment(s(d, 'b')); // orders 0, 2, 3
    await insertSegments(d, { before: s(d, 'c') }, [clip(s(d, 'x')), clip(s(d, 'y'))]);
    await insertSegments(d, { before: s(d, 'x') }, [clip(s(d, 'z'))]);
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
      { draftId: d, segmentIds: [s(d, 'x'), s(d, 'y')] },
      { draftId: d, segmentIds: [s(d, 'z')] },
    ]);
    expect(takeClipsAdded(d)).toEqual([s(d, 'x'), s(d, 'y'), s(d, 'z')]);
    expect(takeClipsAdded(d)).toEqual([]);
    disarm();
  });
});

describe('an anchor whose clip goes while the add waits (an import converting, a screen take)', () => {
  // The anchor is fixed as the add starts; the clip it names is deleted before the row is written.
  it.each<[string, (d: string) => ClipAnchor, string, string[]]>([
    ['a middle clip', (d) => ({ before: s(d, 'b'), next: s(d, 'c') }), 'b', ['a', 'x', 'c']],
    ['the first clip', (d) => ({ before: s(d, 'a'), next: s(d, 'b') }), 'a', ['x', 'b', 'c']],
    ['the last clip', (d) => ({ before: s(d, 'c') }), 'c', ['a', 'b', 'x']],
  ])(
    'before %s: lands at the same boundary, not the end',
    async (_name, anchor, gone, expected) => {
      const d = await abc();
      const at = anchor(d);
      await deleteSegment(s(d, gone));
      await insertSegments(d, at, [clip(s(d, 'x'))]);
      expect(ids(d)).toEqual(expected.map((id) => s(d, id)));
    },
  );

  it('a batch keeps its order when its anchor clip goes mid-batch', async () => {
    const d = await abc();
    const at: ClipAnchor = { before: s(d, 'b'), next: s(d, 'c') };
    await insertSegments(d, at, [clip(s(d, 'x'))]);
    await insertSegments(d, at, [clip(s(d, 'y'))]);
    await deleteSegment(s(d, 'b'));
    await insertSegments(d, at, [clip(s(d, 'z'))]);
    expect(ids(d)).toEqual(['a', 'x', 'y', 'z', 'c'].map((id) => s(d, id)));
  });
});

describe('an anchor given as a function', () => {
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
      const insert = () => insertSegments(d, { before: s(d, 'b') }, [clip(s(d, 'x'))]);
      await Promise.all(reorderFirst ? [reorder(), insert()] : [insert(), reorder()]);
      // Every clip is there once, and the reorder holds for the clips it named.
      const order = ids(d);
      expect([...order].sort()).toEqual(['a', 'b', 'c', 'x'].map((id) => s(d, id)).sort());
      expect(order.filter((id) => id !== s(d, 'x'))).toEqual(['c', 'b', 'a'].map((id) => s(d, id)));
    }
  });
});

describe('taking added clips out and putting them back (the editor’s undo/redo of an addition)', () => {
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

  it('never deletes a file another row shares, or one held for a redo', async () => {
    const d = await createDraft();
    const shared = { originalFilename: 'drafts/x/segments/shared.mp4', durationMs: 1 };
    await addSegment(d, { id: s(d, 'p'), ...shared });
    await addSegment(d, { id: s(d, 'q'), ...shared });
    await addSegment(d, clip(s(d, 'r')));
    const del = jest.spyOn(fileStore, 'deleteSegmentFile').mockImplementation(() => {});
    try {
      // q taken out (its redo needs the shared file), then p deleted: the file stays.
      const taken = await takeOutSegments([s(d, 'q')]);
      await deleteSegment(s(d, 'p'));
      expect(del).not.toHaveBeenCalledWith(shared.originalFilename);
      // Nothing can put q back now: the file goes.
      await dropTakenOut(taken!);
      expect(del).toHaveBeenCalledWith(shared.originalFilename);

      // Dropping a take-out whose sharer is still in the draft keeps the file.
      del.mockClear();
      await addSegment(d, { id: s(d, 'u'), ...shared });
      await addSegment(d, { id: s(d, 'v'), ...shared });
      const one = await takeOutSegments([s(d, 'u')]);
      await dropTakenOut(one!);
      expect(del).not.toHaveBeenCalledWith(shared.originalFilename);
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

  it('a redo into a deleted draft releases its files; dropping them after doesn’t throw', async () => {
    // q shares its file with p in another draft (a legacy duplicate), so the file outlives q's.
    const keep = await createDraft();
    const d = await createDraft();
    const shared = { originalFilename: 'drafts/x/segments/kept.mp4', durationMs: 1 };
    await addSegment(keep, { id: s(keep, 'p'), ...shared });
    await addSegment(d, clip(s(d, 'a')));
    await addSegment(d, { id: s(d, 'q'), ...shared });
    const del = jest.spyOn(fileStore, 'deleteSegmentFile').mockImplementation(() => {});
    try {
      const taken = await takeOutSegments([s(d, 'q')]);
      await deleteDraft(d);
      await expect(restoreSegments(taken!)).resolves.toBeUndefined();
      expect(ids(d)).toEqual([]);
      // Not held any more: once p goes, nothing uses the file.
      await deleteSegment(s(keep, 'p'));
      expect(del).toHaveBeenCalledWith(shared.originalFilename);
      // The editor closing later drops it again: nothing left to do, and no throw.
      await expect(dropTakenOut(taken!)).resolves.toBeUndefined();
    } finally {
      del.mockRestore();
    }
  });
});

describe('the launch sweep of clips undone when Pulse closed', () => {
  it('deletes the files undo held that no row uses, once, and keeps those in use', async () => {
    const d = await added(); // a x y b c
    // y shares its file with z, which stays in the draft.
    await addSegment(d, {
      id: s(d, 'z'),
      originalFilename: `drafts/x/segments/${s(d, 'y')}.mp4`,
      durationMs: 1,
    });
    // x and y undone out; x's redo never came (Pulse was killed). y was put back.
    await takeOutSegments([s(d, 'x')]);
    const y = await takeOutSegments([s(d, 'y')]);
    await restoreSegments(y!);
    // A file no row uses that undo never held (a library recovered from an older copy).
    const unheld = `drafts/${d}/segments/lost.mp4`;
    const del = jest.spyOn(fileStore, 'deleteSegmentFile').mockImplementation(() => {});
    try {
      expect(dropHeldFiles(referencedMediaPaths(expoDb))).toBeGreaterThan(0);
      const deleted = del.mock.calls.map(([rel]) => rel);
      expect(deleted).toContain(`drafts/x/segments/${s(d, 'x')}.mp4`);
      expect(deleted).toContain(`drafts/${d}/segments/${s(d, 'x')}.thumb.jpg`);
      // Every file a row uses stays: y is back, and z shares its file.
      for (const id of ['a', 'y', 'b', 'c', 'z']) {
        expect(deleted).not.toContain(`drafts/x/segments/${s(d, id)}.mp4`);
        expect(deleted).not.toContain(`drafts/${d}/segments/${s(d, id)}.thumb.jpg`);
      }
      expect(deleted).not.toContain(unheld);
      // The list is gone with it: a second launch deletes nothing.
      del.mockClear();
      expect(dropHeldFiles(referencedMediaPaths(expoDb))).toBe(0);
      expect(del).not.toHaveBeenCalled();
    } finally {
      del.mockRestore();
    }
  });

  it('only forgets the list on a library recovered or restored this launch', async () => {
    const d = await added();
    await takeOutSegments([s(d, 'x')]);
    const del = jest.spyOn(fileStore, 'deleteSegmentFile').mockImplementation(() => {});
    try {
      expect(dropHeldFiles(null)).toBe(0);
      expect(dropHeldFiles(referencedMediaPaths(expoDb))).toBe(0);
      expect(del).not.toHaveBeenCalled();
    } finally {
      del.mockRestore();
    }
  });
});
