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
  deleteExportFile: jest.fn(),
  deleteSegmentFile: jest.fn(),
  editedThumbRelPath: (p: string) => p.replace(/\.mp4$/, '.thumb.jpg'),
  thumbRelPath: (d: string, s: string) => `drafts/${d}/segments/${s}.thumb.jpg`,
}));
jest.mock('@/utils/video', () => ({ generateThumbnailFile: jest.fn(async () => true) }));
jest.mock('./secure-token', () => ({ deleteDraftToken: jest.fn(), setDraftToken: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { deleteDraftDir, deleteExportFile } from '@/utils/file-store';

import {
  addSegment,
  deleteDraft,
  deleteSegment,
  renameDraft,
  reorderSegments,
  resetEdit,
  setEdited,
} from './drafts';
/* eslint-enable import/first */

const SEG = { id: 's1', draftId: 'd1', originalFilename: 'o.mp4', editedFilename: null };
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
  ['setEdited', () => setEdited('s1', 'e.mp4', 500), [[SEG]], []],
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
    expect(deleteExportFile).not.toHaveBeenCalled();
    expect(deleteDraftDir).not.toHaveBeenCalled();
  });
});

describe('persisted export invalidation', () => {
  const CLIP_MUTATIONS = MUTATIONS.filter(
    ([name]) => name !== 'renameDraft' && name !== 'deleteDraft',
  );

  it.each(CLIP_MUTATIONS)(
    '%s drops the export and its signature',
    async (_name, mutate, before, after) => {
      mockSelects.push(...before, idle, ...after);
      await mutate();
      expect(deleteExportFile).toHaveBeenCalledWith('d1');
      expect(mockWrites).toContainEqual({
        op: 'update',
        set: { mergedSignature: null, mergedDurationMs: null },
      });
    },
  );

  it('renameDraft keeps the export — the video did not change', async () => {
    mockSelects.push(idle);
    await renameDraft('d1', 'New name');
    expect(deleteExportFile).not.toHaveBeenCalled();
  });

  it('deleteDraft removes it with the draft dir', async () => {
    mockSelects.push(idle);
    await deleteDraft('d1');
    expect(deleteDraftDir).toHaveBeenCalledWith('d1');
  });
});
