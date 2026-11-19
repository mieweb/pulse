import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// A stand-in for the drizzle client: every query builder chain is awaitable, or runs at once with
// `.all()` / `.get()` / `.run()` as in a sync transaction. Selects resolve to the next queued
// result; writes resolve empty and are recorded (with their `.set()` payload) so a test can
// assert what a mutation did — or that it did nothing.
const mockSelects: unknown[][] = [];
const mockWrites: { op: string; set?: unknown; values?: unknown }[] = [];

function mockChain(
  resolve: () => unknown,
  write?: { op: string; set?: unknown; values?: unknown },
): unknown {
  const proxy: unknown = new Proxy(() => {}, {
    get(_target, prop) {
      if (prop === 'then') {
        return (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
          Promise.resolve(resolve()).then(ok, fail);
      }
      if (prop === 'all' || prop === 'run') return () => resolve();
      if (prop === 'get') return () => (resolve() as unknown[])[0];
      return (...args: unknown[]) => {
        if (prop === 'set' && write) write.set = args[0];
        if (prop === 'values' && write) write.values = args[0];
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
    transaction: (fn: (tx: unknown) => unknown) => {
      mockWrites.push({ op: 'transaction' });
      return fn(db);
    },
  };
  return { db };
});
jest.mock('@/utils/file-store', () => ({
  absolutize: (p: string) => `file:///docs/${p}`,
  copyRelFile: jest.fn(async () => true),
  deleteDraftDir: jest.fn(),
  deleteSegmentFile: jest.fn(),
  editCoverRelPath: (d: string, s: string, rev: number) =>
    `drafts/${d}/segments/${s}.cover.${rev}.jpg`,
  editedThumbRelPath: (p: string) => p.replace(/\.mp4$/, '.thumb.jpg'),
  thumbRelPath: (d: string, s: string) => `drafts/${d}/segments/${s}.thumb.jpg`,
}));
jest.mock('@/utils/video', () => ({ generateThumbnailFile: jest.fn(async () => true) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
jest.mock('./secure-token', () => ({ deleteSavedLink: jest.fn(async () => {}) }));

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { deleteDraftDir, deleteSegmentFile } from '@/utils/file-store';
import { deleteSavedLink } from './secure-token';
import { generateThumbnailFile } from '@/utils/video';

import {
  addSegment,
  createDraft,
  deleteDraft,
  draftDisplayName,
  deleteSegment,
  duplicateDraft,
  renameDraft,
  reorderSegments,
  resetEdit,
  setDraftContext,
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
    expect(deleteSavedLink).not.toHaveBeenCalled();
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
    expect(deleteSavedLink).toHaveBeenCalledWith('d1');
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
    const seg = { ...SEG, editedFilename: 'e.mp4', thumbnail: 'e.thumb.jpg' };
    mockSelects.push([seg], idle, [seg]);
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

describe('draft names', () => {
  beforeEach(() => {
    mockSelects.length = 0;
    mockWrites.length = 0;
  });

  it('a draft from a link for a place takes the link’s name, or none, and remembers the place', async () => {
    const context = { server: 'https://vault.example.org', ref: 'u1:huddle:t1' };
    await createDraft({ name: 'Huddle update', context });
    await createDraft({ name: null, context });
    expect(mockWrites.map((w) => w.values)).toEqual([
      {
        id: 'uuid',
        name: 'Huddle update',
        contextServer: context.server,
        contextRef: context.ref,
        createdVia: 'app',
      },
      {
        id: 'uuid',
        name: null,
        contextServer: context.server,
        contextRef: context.ref,
        createdVia: 'app',
      },
    ]);
  });

  it('shows a draft’s own name, else its destination’s label, else Untitled', () => {
    expect(draftDisplayName('Huddle update', 'Team · Huddle')).toBe('Huddle update');
    expect(draftDisplayName(null, 'Team · Huddle')).toBe('Team · Huddle');
    expect(draftDisplayName('', 'Team · Huddle')).toBe('Team · Huddle');
    expect(draftDisplayName(null, null)).toBe('Untitled');
  });
});

const TICKET = { key: 'ticket:t-42', kind: 'ticket', id: 'T-42', label: 'Fix login' };
const TICKET_TYPE = { id: 'ticket.video', version: 1 };
const CLOCK = { key: 'clock:ev-7', kind: 'clock', id: 'ev-7', label: 'Mon 9:02 session' };
const CLOCK_TYPE = { id: 'clock.session', version: 1, confirmSend: true };
const updates = () => mockWrites.filter((w) => w.op === 'update');

describe('host context', () => {
  it('createDraft stores a host’s place and upload type, and says the host made it', async () => {
    await createDraft({ hostContext: TICKET, uploadType: TICKET_TYPE, createdVia: 'host' });
    expect(mockWrites.map((w) => w.values)).toEqual([
      {
        id: 'uuid',
        name: null,
        contextServer: null,
        contextRef: null,
        contextKey: 'ticket:t-42',
        contextLabel: 'Fix login',
        contextJson: JSON.stringify({ kind: 'ticket', id: 'T-42', label: 'Fix login' }),
        uploadTypeJson: JSON.stringify(TICKET_TYPE),
        createdVia: 'host',
      },
    ]);
  });

  it('createDraft refuses a context that fails its checks, before writing', async () => {
    await expect(
      createDraft({ hostContext: { ...TICKET, key: 'Ticket:T-42' }, createdVia: 'host' }),
    ).rejects.toMatchObject({ code: 'invalid_options' });
    expect(mockWrites).toEqual([]);
  });

  it('setDraftContext moves an unsent draft to another place', async () => {
    mockSelects.push(idle, [{ hostConfirmedAt: null }]);
    await setDraftContext('d1', CLOCK, CLOCK_TYPE);
    expect(updates()).toHaveLength(1);
    expect(updates()[0].set).toMatchObject({
      contextKey: 'clock:ev-7',
      contextLabel: 'Mon 9:02 session',
      uploadTypeJson: JSON.stringify(CLOCK_TYPE),
    });
  });

  it('setDraftContext refuses a clock-bound draft: draft.locked, reason clock_bound', async () => {
    mockSelects.push(idle, [{ hostConfirmedAt: 1790000000000 }]);
    await expect(setDraftContext('d1', TICKET, TICKET_TYPE)).rejects.toMatchObject({
      name: 'LibraryError',
      code: 'draft.locked',
      reason: 'clock_bound',
    });
    expect(updates()).toEqual([]);
  });

  it('setDraftContext refuses while the draft uploads, a draft that’s gone, and a bad context', async () => {
    mockSelects.push(uploading);
    await expect(setDraftContext('d1', TICKET)).rejects.toThrow(/uploading/);
    mockSelects.push(idle, []);
    await expect(setDraftContext('gone', TICKET)).rejects.toMatchObject({ code: 'not_found' });
    await expect(setDraftContext('d1', { ...TICKET, label: ' ' })).rejects.toMatchObject({
      code: 'invalid_options',
    });
    expect(updates()).toEqual([]);
  });

  it('duplicateDraft leaves the host place, Send and confirmation behind', async () => {
    const source = {
      id: 'd1',
      name: 'Fix login video',
      captionY: 0.4,
      lastClipNumber: 2,
      contextKey: 'clock:ev-7',
      contextLabel: 'Mon 9:02 session',
      contextJson: '{"kind":"clock","id":"ev-7","label":"Mon 9:02 session"}',
      uploadTypeJson: JSON.stringify(CLOCK_TYPE),
      createdVia: 'host',
      hostConfirmedAt: 1790000000000,
      sentAt: 1790000000000,
    };
    mockSelects.push([source], []);
    await duplicateDraft('d1');
    const insert = mockWrites.find((w) => w.op === 'insert');
    expect(insert?.values).toEqual({
      id: 'uuid',
      name: 'Fix login video copy',
      captionY: 0.4,
      lastClipNumber: 2,
      createdVia: 'host',
    });
  });
});

describe('a library a newer Pulse wrote (read-only)', () => {
  it('refuses every draft write with storage.newer_schema, writing nothing', async () => {
    let d!: typeof import('./drafts');
    jest.isolateModules(() => {
      jest.requireActual<typeof import('./host-context')>('./host-context').markLibraryReadOnly();
      d = jest.requireActual<typeof import('./drafts')>('./drafts');
    });
    const writes: [string, () => Promise<unknown>][] = [
      ['createDraft', () => d.createDraft({ hostContext: TICKET, createdVia: 'host' })],
      ['setDraftContext', () => d.setDraftContext('d1', TICKET)],
      [
        'addSegment',
        () => d.addSegment('d1', { id: 's2', originalFilename: 'n.mp4', durationMs: 1 }),
      ],
      ['setEditState', () => d.setEditState('s1', EDIT)],
      ['resetEdit', () => d.resetEdit('s1')],
      ['deleteSegment', () => d.deleteSegment('s1')],
      ['reorderSegments', () => d.reorderSegments(['s1'])],
      ['renameDraft', () => d.renameDraft('d1', 'New name')],
      ['duplicateDraft', () => d.duplicateDraft('d1')],
      ['deleteDraft', () => d.deleteDraft('d1')],
      ['setMergedExport', () => d.setMergedExport('d1', null)],
    ];
    for (const [name, write] of writes) {
      mockSelects.length = 0;
      mockSelects.push([SEG], [SEG], [SEG]); // the clip a mutation looks up first
      await expect(write().then(() => name)).rejects.toMatchObject({
        code: 'storage.newer_schema',
      });
    }
    expect(mockWrites).toEqual([]);
    expect(deleteDraftDir).not.toHaveBeenCalled();
  });
});
