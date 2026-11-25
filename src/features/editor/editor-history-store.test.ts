import { describe, expect, it, jest } from '@jest/globals';

import type { TakenOutClips } from '@/db/drafts';

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

describe('createEditorHistory: additions', () => {
  it('undoes and redoes an edited addition after the original clip is deleted', async () => {
    type Row = TakenOutClips['rows'][number];
    const clip = (id: string, editState: string | null = null): Row => ({
      id,
      draftId: 'd',
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
