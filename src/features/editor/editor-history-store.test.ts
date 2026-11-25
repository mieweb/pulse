import { describe, expect, it, jest } from '@jest/globals';

import type { SplitReceipt, TakenOutClips } from '@/db/drafts';

import type { Present } from './editor-history';
import { createEditorHistory, type HistoryDeps } from './editor-history-store';

const present = (ids: string[], edits: Record<string, string | null> = {}): Present => ({
  clips: ids.map((id) => ({ id, editKey: edits[id] ?? null })),
  captions: new Map(),
  captionY: null,
});
const takenOf = (ids: string[]): TakenOutClips => ({
  draftId: 'd',
  order: ['a', ...ids],
  rows: [],
  transcripts: [],
});

/** A promise and its resolve/reject, to hold a fake's work open. */
function gate<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fake database work, logging the order things ran in. */
function fakes(overrides: Partial<HistoryDeps> = {}) {
  const log: string[] = [];
  const deps: HistoryDeps = {
    flush: async () => {
      log.push('flush');
    },
    takeOut: async (ids) => {
      log.push(`takeOut:${ids}`);
      return takenOf(ids);
    },
    restore: async (t) => {
      log.push(`restore:${t.order.slice(1)}`);
    },
    drop: async (t) => {
      log.push(`drop:${t.order.slice(1)}`);
    },
    failed: (direction) => {
      log.push(`failed:${direction}`);
    },
    ...overrides,
  };
  return { log, deps };
}
const apply = () => {};

const splitReceipt = (): SplitReceipt => ({
  before: {
    ...takenOf(['a']),
    order: ['a'],
    rows: [{ id: 'a' } as TakenOutClips['rows'][number]],
  },
  rightId: 'right',
  firstInsertedId: 'x',
});

describe('createEditorHistory: split and insert', () => {
  it('passes the same original snapshot through repeated compound undo and redo', async () => {
    const split = splitReceipt();
    const takeOut = jest.fn<HistoryDeps['takeOut']>(async () => takenOf(['a', 'x', 'right']));
    const { deps } = fakes({ takeOut });
    const h = createEditorHistory(deps);
    h.recordAdded(['x'], [split]);
    for (let cycle = 0; cycle < 2; cycle++) {
      h.undo(present(['a', 'x', 'right']), apply);
      await h.settled();
      expect(takeOut).toHaveBeenLastCalledWith(['x'], [split]);
      h.redo(present(['a']), apply);
      await h.settled();
      expect(h.getState().past).toEqual([
        { kind: 'added', ids: ['x'], taken: null, splits: [split] },
      ]);
    }
  });

  it('can undo the split after the inserted clip was deleted', async () => {
    const split = splitReceipt();
    const takeOut = jest.fn<HistoryDeps['takeOut']>(async () => takenOf(['a', 'right']));
    const { deps } = fakes({ takeOut });
    const h = createEditorHistory(deps);
    h.recordAdded(['x'], [split]);
    h.undo(present(['a', 'right']), apply);
    await h.settled();
    expect(takeOut).toHaveBeenCalledWith(['x'], [split]);
  });

  it('undoes the entire insertion before the live query has published its new clip ids', async () => {
    const split = splitReceipt();
    const takeOut = jest.fn<HistoryDeps['takeOut']>(async () => takenOf(['a', 'x', 'right']));
    const { deps } = fakes({ takeOut });
    const h = createEditorHistory(deps);
    h.recordAdded(['x'], [split]);
    h.undo(present(['a']), apply);
    await h.settled();
    expect(takeOut).toHaveBeenCalledWith(['x'], [split]);
    expect(h.getState().future).toHaveLength(1);
  });

  it('releases original snapshot media when its applied history is closed or evicted', () => {
    for (const close of [false, true]) {
      const split = splitReceipt();
      const drop = jest.fn<HistoryDeps['drop']>(async () => {});
      const { deps } = fakes({ drop });
      const h = createEditorHistory(deps);
      h.recordAdded(['x'], [split]);
      if (close) h.dispose();
      else for (let i = 0; i < 100; i++) h.record(present(['a', 'x', 'right']), null);
      expect(drop).toHaveBeenCalledTimes(1);
      expect(drop).toHaveBeenCalledWith(split.before);
    }
  });

  it('releases both original and redo media when closed after compound undo', async () => {
    const split = splitReceipt();
    const taken = takenOf(['a', 'x', 'right']);
    const drop = jest.fn<HistoryDeps['drop']>(async () => {});
    const { deps } = fakes({ takeOut: async () => taken, drop });
    const h = createEditorHistory(deps);
    h.recordAdded(['x'], [split]);
    h.undo(present(['a', 'x', 'right']), apply);
    await h.settled();
    expect(drop).not.toHaveBeenCalled();
    h.dispose();
    expect(drop).toHaveBeenCalledWith(split.before);
    expect(drop).toHaveBeenCalledWith(taken);
  });

  it('releases a split snapshot after storage confirms all affected clips were deleted', async () => {
    const split = splitReceipt();
    const drop = jest.fn<HistoryDeps['drop']>(async () => {});
    const { deps } = fakes({ drop, takeOut: async () => null });
    const h = createEditorHistory(deps);
    h.recordAdded(['x'], [split]);
    h.undo(present([]), apply);
    await h.settled();
    expect(h.getState().past).toEqual([]);
    expect(drop).toHaveBeenCalledTimes(1);
    expect(drop).toHaveBeenCalledWith(split.before);
    h.dispose();
    expect(drop).toHaveBeenCalledTimes(1);
  });
});

describe('createEditorHistory: additions', () => {
  it('ignores a delayed addition journal event after that committed addition was undone', async () => {
    const { deps, log } = fakes();
    const history = createEditorHistory(deps);
    history.recordAdded(['x']);
    history.undo(present(['a', 'x']), apply);
    await history.settled();
    const undone = history.getState();
    history.recordAdded(['x']);
    expect(history.getState()).toBe(undone);
    expect(history.getState().future).toHaveLength(1);
    expect(log.some((entry) => entry.startsWith('drop:'))).toBe(false);
  });

  it('skips a storage-confirmed missing addition and undoes the older edit on the same tap', async () => {
    const takeOut = jest.fn<HistoryDeps['takeOut']>(async () => null);
    const { deps } = fakes({ takeOut });
    const h = createEditorHistory(deps);
    h.record(present(['a'], { a: 'before' }), null);
    h.recordAdded(['gone']);
    const applied = jest.fn();
    h.undo(present(['a'], { a: 'after' }), applied);
    await h.settled();
    expect(takeOut).toHaveBeenCalledWith(['gone']);
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({ edits: [['a', 'before']] }));
    expect(h.getState().past).toEqual([]);
    expect(h.getState().future.map((s) => s.kind)).toEqual(['state']);
    expect(h.getState().busy).toBe(false);
  });

  it('checks several absent additions in storage before finishing a no-op Undo', async () => {
    const takeOut = jest.fn<HistoryDeps['takeOut']>(async () => null);
    const { deps } = fakes({ takeOut });
    const h = createEditorHistory(deps);
    h.recordAdded(['one']);
    h.recordAdded(['two']);
    h.undo(present([]), apply);
    await h.settled();
    expect(takeOut.mock.calls).toEqual([[['two']], [['one']]]);
    expect(h.getState()).toMatchObject({ past: [], future: [], busy: false, keepEmptyOpen: false });
  });

  it('does not undo an older edit if a new change arrives while storage checks an absent addition', async () => {
    const checking = gate<TakenOutClips | null>();
    const { deps } = fakes({ takeOut: () => checking.promise });
    const h = createEditorHistory(deps);
    h.record(present(['a'], { a: 'before' }), null);
    h.recordAdded(['gone']);
    const applied = jest.fn();
    h.undo(present(['a'], { a: 'after' }), applied);
    h.record(present(['a'], { a: 'newer' }), null);
    checking.resolve(null);
    await h.settled();
    expect(applied).not.toHaveBeenCalled();
    expect(h.getState().past.map((s) => s.kind)).toEqual(['state', 'state']);
  });

  it('undoes and redoes an edited addition after the original clip is deleted', async () => {
    type Row = TakenOutClips['rows'][number];
    const clip = (id: string, editState: string | null = null): Row => ({
      id,
      draftId: 'd',
      addedAt: 1000,
      order: id === 'a' ? 0 : 1,
      label: id,
      originalFilename: `${id}.mp4`,
      durationMs: 2000,
      editedFilename: null,
      editedDurationMs: editState ? 1000 : null,
      editState,
      thumbnail: null,
      captionEdit: null,
    });
    let rows = [clip('a')];
    const files = new Set(['a.mp4', 'x.mp4']);
    const takeOut = jest.fn<HistoryDeps['takeOut']>(async (ids) => {
      const taken: TakenOutClips = {
        draftId: 'd',
        order: rows.map((row) => row.id),
        rows: rows.filter((row) => ids.includes(row.id)),
        transcripts: [],
      };
      rows = rows.filter((row) => !ids.includes(row.id));
      return taken.rows.length ? taken : null;
    });
    const restore = jest.fn<HistoryDeps['restore']>(async (taken) => {
      rows.push(...taken.rows);
    });
    const drop = jest.fn<HistoryDeps['drop']>(async (taken) => {
      for (const row of taken.rows) files.delete(row.originalFilename);
    });
    const { log, deps } = fakes({ takeOut, restore, drop });
    const h = createEditorHistory(deps);
    const now = () =>
      present(
        rows.map((row) => row.id),
        Object.fromEntries(rows.map((row) => [row.id, row.editState])),
      );

    const editedX = clip('x', 'x-trimmed-and-muted');
    rows.push(editedX);
    h.recordAdded(['x']);
    // Deleting the original clip leaves the addition as the draft's only clip.
    rows = rows.filter((row) => row.id !== 'a');
    files.delete('a.mp4');

    for (let cycle = 0; cycle < 2; cycle++) {
      h.undo(now(), apply);
      await h.settled();
      expect(rows).toEqual([]);
      expect(h.getState().past).toEqual([]);
      expect(h.getState().future).toEqual([
        {
          kind: 'added',
          ids: ['x'],
          taken: { draftId: 'd', order: ['x'], rows: [editedX], transcripts: [] },
        },
      ]);
      expect(files).toEqual(new Set(['x.mp4']));
      expect(drop).not.toHaveBeenCalled();

      h.redo(now(), apply);
      await h.settled();
      expect(rows).toEqual([editedX]);
      expect(rows[0].editState).toBe('x-trimmed-and-muted');
      expect(h.getState().past).toEqual([{ kind: 'added', ids: ['x'], taken: null }]);
      expect(h.getState().future).toEqual([]);
      expect(files).toEqual(new Set(['x.mp4']));
    }
    expect(takeOut).toHaveBeenCalledTimes(2);
    expect(restore).toHaveBeenCalledTimes(2);
    expect(log).not.toContain('failed:undo');
    expect(log).not.toContain('failed:redo');
  });

  it('keeps the empty editor open while undo and redo database work is pending', async () => {
    const taking = gate<TakenOutClips | null>();
    const restoring = gate();
    let draftIds = ['x'];
    const taken = { ...takenOf(['x']), order: ['x'] };
    const { deps } = fakes({
      takeOut: () => {
        draftIds = [];
        return taking.promise;
      },
      restore: async () => {
        await restoring.promise;
        draftIds = ['x'];
      },
    });
    const h = createEditorHistory(deps);
    const reported: boolean[] = [];
    h.subscribe(() => reported.push(h.getState().keepEmptyOpen));
    h.recordAdded(['x']);
    expect(h.getState().keepEmptyOpen).toBe(false);

    h.undo(present(draftIds), apply);
    expect(h.getState().keepEmptyOpen).toBe(true);
    await Promise.resolve(); // The row disappears before takeOut's promise resolves.
    expect(draftIds).toEqual([]);
    expect(h.getState().future).toEqual([]);
    expect(h.getState().keepEmptyOpen).toBe(true);
    expect(reported.at(-1)).toBe(true);

    taking.resolve(taken);
    await h.settled();
    expect(h.getState().future).toHaveLength(1);
    expect(h.getState().keepEmptyOpen).toBe(true);

    h.redo(present(draftIds), apply);
    // The redo step is no longer on the future stack, but its rows aren't back yet.
    expect(h.getState().future).toEqual([]);
    expect(h.getState().keepEmptyOpen).toBe(true);
    await Promise.resolve();
    expect(draftIds).toEqual([]);
    expect(h.getState().keepEmptyOpen).toBe(true);
    expect(reported.at(-1)).toBe(true);

    restoring.resolve();
    await h.settled();
    expect(draftIds).toEqual(['x']);
    expect(h.getState().future).toEqual([]);
    expect(h.getState().keepEmptyOpen).toBe(false);
    expect(reported.at(-1)).toBe(false);
  });

  it('stores the queued edits before taking clips out or putting them back', async () => {
    const { log, deps } = fakes();
    const h = createEditorHistory(deps);
    h.recordAdded(['x']);
    h.undo(present(['a', 'x']), apply);
    await h.settled();
    expect(h.getState().future).toHaveLength(1);
    h.redo(present(['a']), apply);
    await h.settled();
    expect(log).toEqual(['flush', 'takeOut:x', 'flush', 'restore:x']);
    expect(h.getState().past).toEqual([{ kind: 'added', ids: ['x'], taken: null }]);
    expect(h.getState().future).toEqual([]);
  });

  it('a queued edit lands before the take-out reads the row', async () => {
    // The edit (a trim of the new clip) is still being stored when undo is tapped.
    const order: string[] = [];
    const write = gate();
    const { deps } = fakes({
      flush: () => write.promise.then(() => void order.push('edit stored')),
      takeOut: async (ids) => {
        order.push('taken out');
        return takenOf(ids);
      },
    });
    const h = createEditorHistory(deps);
    h.recordAdded(['x']);
    h.undo(present(['a', 'x']), apply);
    await Promise.resolve();
    expect(order).toEqual([]);
    write.resolve();
    await h.settled();
    expect(order).toEqual(['edit stored', 'taken out']);
  });

  it('a change during a redo neither drops its files nor loses its undo step', async () => {
    const restoring = gate();
    const { log, deps } = fakes({ restore: () => restoring.promise });
    const h = createEditorHistory(deps);
    h.recordAdded(['x']);
    h.undo(present(['a', 'x']), apply);
    await h.settled();
    h.redo(present(['a']), apply);
    // Off the redo stack at once: a change recorded now has nothing of it to drop.
    expect(h.getState().future).toEqual([]);
    h.record(present(['a']), null);
    restoring.resolve();
    await h.settled();
    expect(log.filter((l) => l.startsWith('drop'))).toEqual([]);
    // Its undo step is back, under the change recorded meanwhile.
    expect(h.getState().past.map((s) => s.kind)).toEqual(['added', 'state']);
  });

  it('closing during a redo leaves the restored clips their files', async () => {
    const restoring = gate();
    const { log, deps } = fakes({ restore: () => restoring.promise });
    const h = createEditorHistory(deps);
    h.recordAdded(['x']);
    h.undo(present(['a', 'x']), apply);
    await h.settled();
    h.redo(present(['a']), apply);
    h.dispose();
    restoring.resolve();
    await h.settled();
    expect(log.filter((l) => l.startsWith('drop'))).toEqual([]);
  });

  it('closing during an undo drops what it takes out once it has', async () => {
    const taking = gate<TakenOutClips | null>();
    const { log, deps } = fakes({ takeOut: () => taking.promise });
    const h = createEditorHistory(deps);
    h.recordAdded(['x']);
    h.undo(present(['a', 'x']), apply);
    h.dispose();
    expect(log).not.toContain('drop:x');
    taking.resolve(takenOf(['x']));
    await h.settled();
    expect(log).toContain('drop:x');
  });

  it('a change during an undo drops what it takes out (no redo after a new change)', async () => {
    const taking = gate<TakenOutClips | null>();
    const { log, deps } = fakes({ takeOut: () => taking.promise });
    const h = createEditorHistory(deps);
    h.recordAdded(['x']);
    h.undo(present(['a', 'x']), apply);
    h.record(present(['a']), null);
    taking.resolve(takenOf(['x']));
    await h.settled();
    expect(log).toContain('drop:x');
    expect(h.getState().future).toEqual([]);
  });

  it('a new change drops the files of additions waiting to be redone', async () => {
    const { log, deps } = fakes();
    const h = createEditorHistory(deps);
    h.recordAdded(['x']);
    h.undo(present(['a', 'x']), apply);
    await h.settled();
    h.record(present(['a']), null);
    expect(log).toContain('drop:x');
    expect(h.getState().future).toEqual([]);
  });

  it('waits for an addition before another undo, and says when one fails', async () => {
    const taking = gate<TakenOutClips | null>();
    const { log, deps } = fakes({ takeOut: () => taking.promise });
    const h = createEditorHistory(deps);
    h.record(present(['a'], { a: 'e1' }), null);
    h.recordAdded(['x']);
    const applied = jest.fn();
    h.undo(present(['a', 'x'], { a: 'e2' }), applied);
    expect(h.getState().keepEmptyOpen).toBe(true);
    h.undo(present(['a', 'x'], { a: 'e2' }), applied);
    expect(applied).not.toHaveBeenCalled();
    taking.reject(new Error('draft.locked'));
    await h.settled();
    expect(log).toContain('failed:undo');
    expect(h.getState().keepEmptyOpen).toBe(false);
    // Nothing came out: the addition is still the step to undo.
    expect(h.getState().past.map((s) => s.kind)).toEqual(['state', 'added']);
  });

  it('a failed undo with a change made meanwhile goes back under that change', async () => {
    const taking = gate<TakenOutClips | null>();
    const takeOut = jest.fn<HistoryDeps['takeOut']>(() => taking.promise);
    const { log, deps } = fakes({ takeOut });
    const h = createEditorHistory(deps);
    h.record(present(['a'], { a: 'e1' }), null);
    h.recordAdded(['x']);
    h.undo(present(['a', 'x'], { a: 'e2' }), apply);
    h.record(present(['a', 'x'], { a: 'e2' }), null); // an edit while the clips are coming out
    taking.reject(new Error('draft.locked'));
    await h.settled();
    expect(log).toContain('failed:undo');
    // The clips never came out: the addition is still undoable, once the edit is.
    expect(h.getState().past.map((s) => s.kind)).toEqual(['state', 'added', 'state']);
    const applied = jest.fn();
    h.undo(present(['a', 'x'], { a: 'e3' }), applied);
    expect(applied).toHaveBeenCalledTimes(1);
    takeOut.mockImplementation(async (ids) => takenOf(ids));
    h.undo(present(['a', 'x'], { a: 'e2' }), apply);
    await h.settled();
    expect(takeOut).toHaveBeenLastCalledWith(['x']);
    expect(h.getState().past.map((s) => s.kind)).toEqual(['state']);
  });

  it('a failed redo keeps the addition redoable', async () => {
    const restore = jest
      .fn<HistoryDeps['restore']>()
      .mockRejectedValueOnce(new Error('locked'))
      .mockResolvedValue(undefined);
    const { log, deps } = fakes({ restore });
    const h = createEditorHistory(deps);
    h.recordAdded(['x']);
    h.undo(present(['a', 'x']), apply);
    await h.settled();
    h.redo(present(['a']), apply);
    await h.settled();
    expect(log).toContain('failed:redo');
    expect(h.getState().future).toHaveLength(1);
    expect(h.getState().keepEmptyOpen).toBe(true);
    expect(log.filter((l) => l.startsWith('drop'))).toEqual([]);

    h.redo(present(['a']), apply);
    await h.settled();
    expect(restore).toHaveBeenCalledTimes(2);
    expect(h.getState().future).toEqual([]);
    expect(h.getState().keepEmptyOpen).toBe(false);
    expect(log.filter((l) => l.startsWith('drop'))).toEqual([]);
  });
});

describe('createEditorHistory: active image batches', () => {
  it('creates no empty step and preserves redo when the picker is canceled before any commit', async () => {
    const { log, deps } = fakes();
    const h = createEditorHistory(deps);
    h.recordAdded(['x']);
    h.undo(present(['a', 'x']), apply);
    await h.settled();
    await h.beginBatch('batch');
    h.redo(present(['a']), apply);
    h.undo(present(['a']), apply);
    expect(h.getState()).toMatchObject({ past: [], batchOpen: true, keepEmptyOpen: true });
    expect(h.getState().future).toHaveLength(1);
    expect(log.some((entry) => entry.startsWith('restore:'))).toBe(false);
    h.endBatch('batch');
    h.redo(present(['a']), apply);
    await h.settled();
    expect(log).toContain('restore:x');
  });

  it('extends the first commit below intervening edits and keeps its split receipt', async () => {
    const split = splitReceipt();
    const takeOut = jest.fn<HistoryDeps['takeOut']>(async (ids) => takenOf(ids));
    const drop = jest.fn<HistoryDeps['drop']>(async () => {});
    const { deps } = fakes({ takeOut, drop });
    const h = createEditorHistory(deps);
    await h.beginBatch('batch');
    h.recordAdded(['x'], [split], 'batch');
    const first = h.getState().past[0];
    h.record(present(['a', 'x', 'right'], { a: 'left' }), 'rotate');
    h.recordAdded(['y'], [], 'batch');
    expect(h.getState().past[0]).toBe(first);
    expect(first).toMatchObject({ ids: ['x', 'y'], splits: [split], batchKey: 'batch' });
    expect(h.getState().past.map((s) => s.kind)).toEqual(['added', 'state']);
    const applied = jest.fn();
    h.undo(present(['a', 'x', 'y', 'right'], { a: 'rotated-left' }), applied);
    expect(applied).not.toHaveBeenCalled();
    expect(takeOut).not.toHaveBeenCalled();
    expect(drop).not.toHaveBeenCalled();
    h.endBatch('batch');
    h.undo(present(['a', 'x', 'y', 'right'], { a: 'rotated-left' }), applied);
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({ edits: [['a', 'left']] }));
    h.undo(present(['a', 'x', 'y', 'right'], { a: 'left' }), applied);
    await h.settled();
    expect(takeOut).toHaveBeenCalledWith(['x', 'y'], [split]);
  });

  it('pins an open batch across history eviction, then releases its snapshot once it ages out', async () => {
    const split = splitReceipt();
    const drop = jest.fn<HistoryDeps['drop']>(async () => {});
    const { deps } = fakes({ drop });
    const h = createEditorHistory(deps);
    await h.beginBatch('batch');
    h.recordAdded(['x'], [split], 'batch');
    const first = h.getState().past[0];
    for (let i = 0; i < 110; i++) h.record(present(['a', 'x', 'right']), null);
    expect(h.getState().past).toHaveLength(101);
    expect(h.getState().past[0]).toBe(first);
    expect(drop).not.toHaveBeenCalled();
    h.recordAdded(['y'], [], 'batch');
    expect(first).toMatchObject({ ids: ['x', 'y'] });
    h.endBatch('batch');
    expect(h.getState().past).toHaveLength(100);
    expect(drop).toHaveBeenCalledTimes(1);
    expect(drop).toHaveBeenCalledWith(split.before);
    h.dispose();
    expect(drop).toHaveBeenCalledTimes(1);
  });

  it('seals a partially committed batch as one undoable addition', async () => {
    const { log, deps } = fakes();
    const h = createEditorHistory(deps);
    await h.beginBatch('partial');
    h.recordAdded(['first'], [], 'partial');
    h.endBatch('partial');
    h.undo(present(['a', 'first']), apply);
    await h.settled();
    expect(log).toContain('takeOut:first');
    expect(h.getState().future).toHaveLength(1);
  });

  it('waits for an existing history write before allowing batch preparation to start', async () => {
    const taking = gate<TakenOutClips | null>();
    const { deps } = fakes({ takeOut: () => taking.promise });
    const h = createEditorHistory(deps);
    h.recordAdded(['x']);
    h.undo(present(['a', 'x']), apply);
    let began = false;
    const beginning = h.beginBatch('batch').then(() => {
      began = true;
    });
    await Promise.resolve();
    expect(began).toBe(false);
    taking.resolve(takenOf(['x']));
    await beginning;
    expect(began).toBe(true);
    expect(h.getState().batchOpen).toBe(true);
    h.endBatch('batch');
  });

  it('releases a late unaccepted split receipt after the editor closes', async () => {
    const split = splitReceipt();
    const drop = jest.fn<HistoryDeps['drop']>(async () => {});
    const { deps } = fakes({ drop });
    const h = createEditorHistory(deps);
    await h.beginBatch('batch');
    h.dispose();
    h.recordAdded(['x'], [split], 'batch');
    h.endBatch('batch');
    expect(drop).toHaveBeenCalledWith(split.before);
    expect(h.getState().past).toEqual([]);
    expect(h.getState().batchOpen).toBe(false);
  });
});
