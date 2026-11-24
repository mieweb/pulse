import { describe, expect, it, jest } from '@jest/globals';

import { draftOnDemand } from './draft-on-demand';

/** A recorder session's draft as use-recorder keeps it: a ref, set as the draft is made. */
function session() {
  let current: string | null = null;
  let finish: (id: string) => void = () => {};
  let fail: (e: Error) => void = () => {};
  const create = jest.fn(
    () =>
      new Promise<string>((resolve, reject) => {
        finish = (id) => {
          current = id;
          resolve(id);
        };
        fail = reject;
      }),
  );
  const ensure = draftOnDemand(() => current, create);
  return { ensure, create, finish: (id: string) => finish(id), fail: (e: Error) => fail(e) };
}

describe('draftOnDemand', () => {
  it('a take and a batch of images asking together get one draft', async () => {
    const s = session();
    // The take is saved while the batch's first image is being written: both need the draft.
    const take = s.ensure();
    const batch = s.ensure();
    s.finish('d1');
    await expect(Promise.all([take, batch])).resolves.toEqual(['d1', 'd1']);
    expect(s.create).toHaveBeenCalledTimes(1);
    // A copy later finds it.
    await expect(s.ensure()).resolves.toBe('d1');
    expect(s.create).toHaveBeenCalledTimes(1);
  });

  it('tries again after a failed create', async () => {
    const s = session();
    const first = s.ensure();
    s.fail(new Error('disk full'));
    await expect(first).rejects.toThrow('disk full');
    const second = s.ensure();
    s.finish('d2');
    await expect(second).resolves.toBe('d2');
    expect(s.create).toHaveBeenCalledTimes(2);
  });
});
