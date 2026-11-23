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
import {
  anchorFromRouteParam,
  anchorToRouteParam,
  onClipsAdded,
  type ClipAnchor,
} from '@/core/clip-anchor';
import { expoDb } from '@/db/client';
import { addSegment, createDraft, deleteSegment } from '@/db/drafts';
import { cursorAfterAdd, cursorAfterRemoval } from './insert-point';
/* eslint-enable import/first */

const conn = expoDb as unknown as {
  getAllSync: <T>(sql: string, ...params: unknown[]) => T[];
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
  // The recorder's cursor as use-recorder keeps it: moved by every insert it hears and by removals.
  function recorderCursor(draftId: string, start: ClipAnchor) {
    let cursor = start;
    const stop = onClipsAdded((a) => {
      if (a.draftId === draftId) cursor = cursorAfterAdd(cursor, a);
    });
    return {
      get: () => cursor,
      remove: async (id: string) => {
        const before = ids(draftId);
        cursor = cursorAfterRemoval(
          cursor,
          before,
          before.filter((other) => other !== id),
        );
        await deleteSegment(id);
      },
      stop,
    };
  }

  it('a run of takes at the cursor stays in order, and a retake goes back in its place', async () => {
    const d = await abc();
    const cursor = recorderCursor(d, { before: s(d, 'b') });
    try {
      for (const id of ['x', 'y']) await addSegment(d, clip(s(d, id)), cursor.get);
      expect(ids(d)).toEqual(['a', 'x', 'y', 'b', 'c'].map((id) => s(d, id)));
      // Retake: the last take dragged to the trash, then recorded again.
      await cursor.remove(s(d, 'y'));
      await addSegment(d, clip(s(d, 'y2')), cursor.get);
      expect(ids(d)).toEqual(['a', 'x', 'y2', 'b', 'c'].map((id) => s(d, id)));
      // The clip after the cursor deleted (in the editor, say): the next take still goes there.
      await cursor.remove(s(d, 'b'));
      await addSegment(d, clip(s(d, 'w')), cursor.get);
      expect(ids(d)).toEqual(['a', 'x', 'y2', 'w', 'c'].map((id) => s(d, id)));
    } finally {
      cursor.stop();
    }
  });

  it('an after cursor (from the editor) moves past each take', async () => {
    const d = await abc();
    const cursor = recorderCursor(d, { after: s(d, 'a') });
    try {
      for (const id of ['x', 'y']) await addSegment(d, clip(s(d, id)), cursor.get);
      expect(cursor.get()).toEqual({ before: s(d, 'b') });
      expect(ids(d)).toEqual(['a', 'x', 'y', 'b', 'c'].map((id) => s(d, id)));
    } finally {
      cursor.stop();
    }
  });

  it('a screen take lands where the cursor was at its tap, through its saved row', async () => {
    const d = await abc();
    const cursor = recorderCursor(d, { before: s(d, 'b') });
    try {
      // Record screen tapped: the take's row keeps the cursor as text (screen-capture.ts).
      const row = { anchor: anchorToRouteParam(cursor.get()) };
      // A camera take lands at the cursor during the screen take.
      await addSegment(d, clip(s(d, 'x')), cursor.get);
      // The screen take's import, after a kill even: the row's anchor, read back.
      await addSegment(d, clip(`${d}-screen-1700000000000`), () =>
        anchorFromRouteParam(row.anchor),
      );
      expect(ids(d)).toEqual([
        s(d, 'a'),
        s(d, 'x'),
        `${d}-screen-1700000000000`,
        s(d, 'b'),
        s(d, 'c'),
      ]);
      expect(cursor.get()).toEqual({ before: s(d, 'b') });
    } finally {
      cursor.stop();
    }
  });
});
