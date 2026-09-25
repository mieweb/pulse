import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// A stand-in for the drizzle client: every query builder chain is awaitable. Selects resolve to
// the next queued result; writes resolve empty and are recorded (with their `.set()` payload) so a
// test can assert what a mutation did — or that it did nothing.
const mockSelects: unknown[][] = [];
const mockWrites: { op: string; set?: unknown }[] = [];

function mockChain(resolve: () => unknown, write?: { op: string; set?: unknown }): unknown {
  const proxy: unknown = new Proxy(() => {}, {
    get(_target, prop) {
      if (prop === 'then') {
        return (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
          Promise.resolve(resolve()).then(ok, fail);
      }
      return (...args: unknown[]) => {
        if (prop === 'set' && write) write.set = args[0];
        return proxy;
      };
    },
  });
  return proxy;
}

jest.mock('./client', () => {
  const write = (op: string) => () => {
    const entry = { op };
    mockWrites.push(entry);
    // `returning()` rows — only addSegment reads them (the bumped clip counter).
    return mockChain(() => [{ clipNumber: 1 }], entry);
  };
  const db = {
    select: () => mockChain(() => mockSelects.shift() ?? []),
    update: write('update'),
    insert: write('insert'),
    delete: write('delete'),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      mockWrites.push({ op: 'transaction' });
      return fn(db);
    },
  };
  return { db };
});
jest.mock('@/utils/file-store', () => ({
  absolutize: (p: string) => `file:///docs/${p}`,
  deleteDraftDir: jest.fn(),
  deleteSegmentFile: jest.fn(),
  editCoverRelPath: (d: string, s: string, rev: number) =>
    `drafts/${d}/segments/${s}.cover.${rev}.jpg`,
  editedThumbRelPath: (p: string) => p.replace(/\.mp4$/, '.thumb.jpg'),
  thumbRelPath: (d: string, s: string) => `drafts/${d}/segments/${s}.thumb.jpg`,
}));
jest.mock('@/utils/video', () => ({ generateThumbnailFile: jest.fn(async () => true) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
jest.mock('./secure-token', () => ({ deleteViewLink: jest.fn(async () => {}) }));

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { deleteDraftDir, deleteSegmentFile } from '@/utils/file-store';
import { deleteViewLink } from './secure-token';
import { generateThumbnailFile } from '@/utils/video';

import {
  addSegment,
  deleteDraft,
  deleteSegment,
  renameDraft,
  reorderSegments,
  resetEdit,
  setEditState,
} from './drafts';
/* eslint-enable import/first */

const SEG = { id: 's1', draftId: 'd1', originalFilename: 'o.mp4', editedFilename: null };
// An editor state: a 2s window at 2x → 1s on the timeline.
const EDIT = JSON.stringify({
  v: 1,
  startMs: 1000,
  endMs: 3000,
  rotation: 1,
  flipped: false,
  crop: null,
  muted: false,
  speed: 2,
  undo: [],
  redo: [],
});
const uploading = [{ status: 'uploading' }];
const idle = [{ status: null }];

beforeEach(() => {
  mockSelects.length = 0;
  mockWrites.length = 0;
  jest.clearAllMocks();
});

// Each mutation with the select results it reads before the lock check (a segment lookup, if
// any) and after it (the rest of the mutation's reads).
type Mutation = [string, () => Promise<unknown>, unknown[][], unknown[][]];
const MUTATIONS: Mutation[] = [
  [
    'addSegment',
    () => addSegment('d1', { id: 's2', originalFilename: 'n.mp4', durationMs: 1 }),
    [],
    [[{ maxOrder: 0 }]],
  ],
  ['deleteSegment', () => deleteSegment('s1'), [[SEG]], [[{ value: 0 }]]],
  ['setEditState', () => setEditState('s1', EDIT), [[SEG]], []],
  ['resetEdit', () => resetEdit('s1'), [[SEG]], []],
  ['reorderSegments', () => reorderSegments(['s1']), [[SEG]], [[SEG]]],
  ['renameDraft', () => renameDraft('d1', 'New name'), [], []],
  ['deleteDraft', () => deleteDraft('d1'), [], []],
];

describe('draft lock while uploading', () => {
  it.each(MUTATIONS)('%s throws and writes nothing', async (_name, mutate, before) => {
    mockSelects.push(...before, uploading);
    await expect(mutate()).rejects.toThrow(/uploading/);
    expect(mockWrites).toEqual([]);
    expect(deleteDraftDir).not.toHaveBeenCalled();
    expect(deleteViewLink).not.toHaveBeenCalled();
  });
});

describe('persisted export', () => {
  // Edits leave the export alone — the export screen decides reuse vs re-merge by signature, so
  // an undone edit gets the saved video back (see merged-export.test.ts).
  it.each(MUTATIONS.filter(([name]) => name !== 'deleteDraft'))(
    '%s leaves the export and its signature alone',
    async (_name, mutate, before, after) => {
      mockSelects.push(...before, idle, ...after);
      await mutate();
      const touchesExport = mockWrites.some(
        (w) => typeof w.set === 'object' && w.set !== null && 'mergedSignature' in w.set,
      );
      expect(touchesExport).toBe(false);
    },
  );

  it('deleteDraft removes it with the draft dir, and forgets its view link', async () => {
    mockSelects.push(idle);
    await deleteDraft('d1');
    expect(deleteDraftDir).toHaveBeenCalledWith('d1');
    expect(deleteViewLink).toHaveBeenCalledWith('d1');
  });
});

describe('edit state', () => {
  const segmentUpdate = () =>
    mockWrites.find((w) => typeof w.set === 'object' && w.set !== null && 'editedFilename' in w.set)
      ?.set;

  it('setEditState stores the settings and their timeline length, with no file', async () => {
    mockSelects.push([SEG], idle);
    await setEditState('s1', EDIT);
    expect(segmentUpdate()).toMatchObject({
      editState: EDIT,
      editedDurationMs: 1000,
      editedFilename: null,
    });
    // The cover is rendered from the original at the edit's start, with the edit applied.
    expect(generateThumbnailFile).toHaveBeenCalledWith(
      'file:///docs/o.mp4',
      expect.stringMatching(/segments\/s1\.cover\.\d+\.jpg$/),
      { editState: EDIT, startMs: 1000 },
    );
  });

  it('setEditState drops a legacy baked file and its cover once the row moves off them', async () => {
    mockSelects.push([{ ...SEG, editedFilename: 'e.mp4', thumbnail: 'e.thumb.jpg' }], idle);
    await setEditState('s1', EDIT);
    expect(deleteSegmentFile).toHaveBeenCalledWith('e.mp4');
    expect(deleteSegmentFile).toHaveBeenCalledWith('e.thumb.jpg');
  });

  it('setEditState rejects an unusable state without writing', async () => {
    await expect(setEditState('s1', 'not json')).rejects.toThrow();
    expect(mockWrites).toEqual([]);
  });

  it('resetEdit clears the editor settings so the next open starts fresh', async () => {
    mockSelects.push([{ ...SEG, editedFilename: 'e.mp4' }], idle);
    await resetEdit('s1');
    expect(segmentUpdate()).toMatchObject({
      editedFilename: null,
      editedDurationMs: null,
      editState: null,
    });
  });
});
