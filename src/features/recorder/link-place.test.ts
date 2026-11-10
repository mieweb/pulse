import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  offerRecorderPlace,
  peekRecorderPlace,
  type RecorderPlace,
  takeRecorderPlace,
  withdrawRecorderPlace,
} from './link-place';

const place = (ref: string, over: Partial<RecorderPlace> = {}): RecorderPlace => ({
  context: { server: 'https://vault.example.org/pulsevault', ref },
  name: null,
  ...over,
});

beforeEach(() => withdrawRecorderPlace());

describe('the place a link hands the recorder', () => {
  it('arrives exactly as it was offered, whatever characters its key has', () => {
    for (const ref of ['ticket%3A12', 'a/b:c?d=e&f#g', '100% done', 'équipe ☕ 😀', ' spaced ']) {
      const offered = place(ref, { name: '50%25 off' });
      offerRecorderPlace(offered, 10_000);
      expect(peekRecorderPlace(0)).toBe(offered);
      expect(peekRecorderPlace(0)?.context.ref).toBe(ref);
      expect(peekRecorderPlace(0)?.name).toBe('50%25 off');
    }
  });

  it('can be read more than once before it is taken, and then is gone', () => {
    const onTaken = jest.fn();
    const offered = place('r1', { onTaken });
    offerRecorderPlace(offered, 10_000);
    // React may render a recorder twice before it mounts.
    expect(peekRecorderPlace(0)).toBe(offered);
    expect(peekRecorderPlace(0)).toBe(offered);
    takeRecorderPlace(offered);
    // And run its mount effect twice.
    takeRecorderPlace(offered);
    expect(onTaken).toHaveBeenCalledTimes(1);
    expect(peekRecorderPlace(0)).toBeNull();
  });

  it('stands only until its time is up', () => {
    offerRecorderPlace(place('r1'), 5000);
    expect(peekRecorderPlace(4999)).not.toBeNull();
    expect(peekRecorderPlace(5000)).toBeNull();
    // Gone for good, not only at that moment.
    expect(peekRecorderPlace(0)).toBeNull();
  });

  it('is replaced by a newer offer, which an older recorder can’t take away', () => {
    const older = place('older');
    const newer = place('newer');
    offerRecorderPlace(older, 10_000);
    offerRecorderPlace(newer, 10_000);
    takeRecorderPlace(older);
    expect(peekRecorderPlace(0)).toBe(newer);
  });
});
