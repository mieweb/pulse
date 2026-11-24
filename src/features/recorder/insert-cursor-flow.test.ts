import { describe, expect, it, jest } from '@jest/globals';

// The recorder's insert cursor following real inserts and deletes, as use-recorder keeps it, on the
// real migrations (node:sqlite behind the drizzle expo driver).
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
jest.mock('@/utils/video', () => ({}));
jest.mock('@/db/secure-token', () => ({ deleteSavedLink: async () => {} }));
jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: () => `draft${++n}` };
});

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { anchorFromRouteParam, anchorToRouteParam, type ClipAnchor } from '@/core/clip-anchor';
import { expoDb } from '@/db/client';
import { addSegment, createDraft, deleteSegment } from '@/db/drafts';
import {
  anchorAtBoundary,
  boundaryOf,
  cursorAfterRemoval,
  cursorBeforeDelete,
} from './insert-point';
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
const ids = (draftId: string) =>
  conn
    .getAllSync<{ id: string }>(
      'SELECT id FROM segments WHERE draft_id = ? ORDER BY sort_order',
      draftId,
    )
    .map((r) => r.id);
/** A draft with clips a, b, c. */
async function abc(): Promise<string> {
  const draftId = await createDraft();
  for (const id of ['a', 'b', 'c']) await addSegment(draftId, clip(`${draftId}${id}`));
  return draftId;
}
const s = (draftId: string, id: string) => `${draftId}${id}`;

describe('the recorder’s insert cursor over real inserts', () => {
  // The recorder's cursor as use-recorder keeps it: moved off a clip the trash deletes, and kept
  // up to date with the draft's clips (`cursorAfterRemoval`, as its live query runs).
  function recorderCursor(draftId: string, start: ClipAnchor) {
    let cursor = start;
    let shown = ids(draftId);
    return {
      get: () => cursor,
      // As the trash does: the cursor moves off the clip first, then the clip goes.
      remove: async (id: string) => {
        cursor = cursorBeforeDelete(cursor, ids(draftId), id);
        await deleteSegment(id);
      },
      // The live query catching up with the draft.
      sync: () => {
        const now = ids(draftId);
        cursor = cursorAfterRemoval(cursor, shown, now);
        shown = now;
      },
    };
  }

  it('a run of takes at the cursor stays in order, and a retake goes back in its place', async () => {
    const d = await abc();
    const cursor = recorderCursor(d, anchorAtBoundary(1, ids(d)));
    for (const id of ['x', 'y']) await addSegment(d, clip(s(d, id)), cursor.get);
    expect(ids(d)).toEqual(['a', 'x', 'y', 'b', 'c'].map((id) => s(d, id)));
    // Retake: the last take dragged to the trash, then recorded again.
    await cursor.remove(s(d, 'y'));
    await addSegment(d, clip(s(d, 'y2')), cursor.get);
    expect(ids(d)).toEqual(['a', 'x', 'y2', 'b', 'c'].map((id) => s(d, id)));
    // The clip after the cursor deleted (in the editor, say): the next take still goes there,
    // whether the cursor has caught up with the delete yet or not.
    await deleteSegment(s(d, 'b'));
    await addSegment(d, clip(s(d, 'w')), cursor.get);
    cursor.sync();
    await addSegment(d, clip(s(d, 'v')), cursor.get);
    expect(ids(d)).toEqual(['a', 'x', 'y2', 'w', 'v', 'c'].map((id) => s(d, id)));
    expect(cursor.get()).toEqual({ before: s(d, 'c') });
  });

  it('a cursor from the editor (through its route param) stays before its clip', async () => {
    const d = await abc();
    const param = anchorToRouteParam(anchorAtBoundary(1, ids(d)));
    const cursor = recorderCursor(d, anchorFromRouteParam(param));
    for (const id of ['x', 'y']) await addSegment(d, clip(s(d, id)), cursor.get);
    expect(cursor.get()).toEqual({ before: s(d, 'b'), next: s(d, 'c') });
    expect(ids(d)).toEqual(['a', 'x', 'y', 'b', 'c'].map((id) => s(d, id)));
  });

  it('a screen take lands where the cursor was at its tap, through its saved row', async () => {
    const d = await abc();
    const cursor = recorderCursor(d, anchorAtBoundary(1, ids(d)));
    // Record screen tapped: the take's row keeps the cursor as text (screen-capture.ts).
    const row = { anchor: anchorToRouteParam(cursor.get()) };
    // A camera take lands at the cursor during the screen take.
    await addSegment(d, clip(s(d, 'x')), cursor.get);
    // The screen take's import, after a kill even: the row's anchor, read back.
    await addSegment(d, clip(`${d}-screen-1700000000000`), anchorFromRouteParam(row.anchor));
    expect(ids(d)).toEqual([
      s(d, 'a'),
      s(d, 'x'),
      `${d}-screen-1700000000000`,
      s(d, 'b'),
      s(d, 'c'),
    ]);
    expect(cursor.get()).toEqual({ before: s(d, 'b'), next: s(d, 'c') });
  });

  it('a cursor whose clip went before the recorder loaded shows where the take lands', async () => {
    const d = await abc();
    // From the editor, between a and b; b is deleted before the recorder's first clips load.
    const cursor = recorderCursor(d, anchorAtBoundary(1, ids(d)));
    await deleteSegment(s(d, 'b'));
    const loaded = ids(d);
    expect(cursorAfterRemoval(cursor.get(), [], loaded)).toEqual(cursor.get()); // never saw b
    const shown = boundaryOf(cursor.get(), loaded);
    expect(shown).toBe(1); // before c, not at the end
    await addSegment(d, clip(s(d, 'x')), cursor.get);
    expect(ids(d).indexOf(s(d, 'x'))).toBe(shown);
  });

  it.each<[string, (d: string) => ClipAnchor, string[]]>([
    ['its clip there', (d) => ({ before: s(d, 'b'), next: s(d, 'c') }), []],
    ['its clip gone, next there', (d) => ({ before: s(d, 'b'), next: s(d, 'c') }), ['b']],
    ['both gone', (d) => ({ before: s(d, 'b'), next: s(d, 'c') }), ['b', 'c']],
    ['the last clip, gone', (d) => ({ before: s(d, 'c') }), ['c']],
    ['the end', () => ({ at: 'end' }), ['a']],
  ])('the cursor and the write agree: %s', async (_name, anchorOf, deleted) => {
    const d = await abc();
    const anchor = anchorOf(d);
    for (const id of deleted) await deleteSegment(s(d, id));
    const shown = boundaryOf(anchor, ids(d));
    await addSegment(d, clip(s(d, 'x')), anchor);
    expect(ids(d).indexOf(s(d, 'x'))).toBe(shown);
  });

  it('a screen take keeps its spot when the clip after it goes while it converts', async () => {
    const d = await abc();
    // Pinned at the tap between a and b.
    const row = { anchor: anchorToRouteParam(anchorAtBoundary(1, ids(d))) };
    await deleteSegment(s(d, 'b'));
    await addSegment(d, clip(`${d}-screen-1`), anchorFromRouteParam(row.anchor));
    expect(ids(d)).toEqual([s(d, 'a'), `${d}-screen-1`, s(d, 'c')]);
    // At the start, its clip gone: the new start.
    const atStart = { anchor: anchorToRouteParam(anchorAtBoundary(0, ids(d))) };
    await deleteSegment(s(d, 'a'));
    await addSegment(d, clip(`${d}-screen-2`), anchorFromRouteParam(atStart.anchor));
    expect(ids(d)[0]).toBe(`${d}-screen-2`);
  });
});
