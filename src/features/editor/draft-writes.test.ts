import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@/db/drafts', () => ({
  setEditState: jest.fn(),
  resetEdit: jest.fn(),
  reorderSegments: jest.fn(),
}));

let writes: typeof import('./draft-writes');
let mutations: jest.Mocked<typeof import('@/db/drafts')>;
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  jest.resetModules();
  writes = jest.requireActual('./draft-writes');
  mutations = jest.requireMock('@/db/drafts');
  mutations.setEditState.mockResolvedValue(undefined);
  mutations.resetEdit.mockResolvedValue(undefined);
  mutations.reorderSegments.mockResolvedValue(undefined);
});

describe('draft write acknowledgment', () => {
  it('waits for the actual commit before export/navigation may proceed', async () => {
    const save = deferred();
    mutations.setEditState.mockReturnValueOnce(save.promise);
    writes.writeEdit('clip', 'edit');
    let settled = false;
    const flushed = writes.flushDraftWrites().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    save.resolve();
    await flushed;
    expect(settled).toBe(true);
  });

  it('rejects every concurrent flush waiter after a failed newest edit, then permits explicit retry', async () => {
    const save = deferred();
    mutations.setEditState.mockReturnValueOnce(save.promise);
    writes.writeEdit('clip', 'edit');
    const waiting = Promise.allSettled([writes.flushDraftWrites(), writes.flushDraftWrites()]);
    save.reject(new Error('canonical disk failure'));
    const results = await waiting;
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    const error = (results[0] as PromiseRejectedResult).reason;
    expect(error.message).toContain('could not be saved');
    expect(error.errors[0].message).toBe('canonical disk failure');
    await expect(writes.flushDraftWrites()).resolves.toBeUndefined();
  });

  it('retains a failure that finished just before flush started', async () => {
    mutations.setEditState.mockRejectedValueOnce(new Error('failed before flush'));
    const failure = new Promise<void>((resolve) => writes.onWriteFailure(() => resolve()));
    writes.writeEdit('clip', 'edit');
    await failure;
    await expect(writes.flushDraftWrites()).rejects.toThrow('could not be saved');
    await expect(writes.flushDraftWrites()).resolves.toBeUndefined();
  });

  it('allows a successful newer edit to replace an older unreported failure', async () => {
    mutations.setEditState.mockRejectedValueOnce(new Error('old failure'));
    const failure = new Promise<void>((resolve) => writes.onWriteFailure(() => resolve()));
    writes.writeEdit('clip', 'old edit');
    await failure;
    writes.writeEdit('clip', 'new edit');
    await expect(writes.flushDraftWrites()).resolves.toBeUndefined();
    expect(mutations.setEditState).toHaveBeenLastCalledWith('clip', 'new edit');
  });

  it('ignores a superseded failure when the queued newest value commits', async () => {
    const old = deferred();
    mutations.setEditState.mockReturnValueOnce(old.promise);
    writes.writeEdit('clip', 'old edit');
    writes.writeEdit('clip', 'new edit');
    const flushed = writes.flushDraftWrites();
    old.reject(new Error('superseded'));
    await expect(flushed).resolves.toBeUndefined();
    expect(mutations.setEditState).toHaveBeenLastCalledWith('clip', 'new edit');
  });

  it('also rejects reset and reorder failures rather than reporting the queue as saved', async () => {
    mutations.resetEdit.mockRejectedValueOnce(new Error('reset failed'));
    writes.writeEdit('clip', null);
    await expect(writes.flushDraftWrites()).rejects.toThrow('could not be saved');
    mutations.reorderSegments.mockRejectedValueOnce(new Error('order failed'));
    writes.writeOrder(['clip-b', 'clip-a']);
    await expect(writes.flushDraftWrites()).rejects.toThrow('could not be saved');
  });
});
