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
    h.undo(present(['a', 'x'], { a: 'e2' }), applied);
    expect(applied).not.toHaveBeenCalled();
    taking.reject(new Error('draft.locked'));
    await h.settled();
    expect(log).toContain('failed:undo');
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
    const { log, deps } = fakes({
      restore: async () => {
        throw new Error('locked');
      },
    });
    const h = createEditorHistory(deps);
    h.recordAdded(['x']);
    h.undo(present(['a', 'x']), apply);
    await h.settled();
    h.redo(present(['a']), apply);
    await h.settled();
    expect(log).toContain('failed:redo');
    expect(h.getState().future).toHaveLength(1);
    expect(log.filter((l) => l.startsWith('drop'))).toEqual([]);
  });
});
