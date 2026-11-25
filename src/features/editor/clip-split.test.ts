import { describe, expect, it, jest } from '@jest/globals';

import { canSplitClip, clipSplitAnchor } from './clip-split';

describe('standalone clip splitting at the playhead', () => {
  const a = { id: 'a', sourceKey: 'a.mp4#trim', edit: { startMs: 1000, endMs: 5000, speed: 2 } };
  const b = { id: 'b', sourceKey: 'b.mp4', edit: { startMs: 0, endMs: 1000, speed: 1 } };
  const clips = [a, b];
  const layout = { starts: [0, 2000], totalMs: 3000 };

  it('captures a trimmed, sped-up source point and allocates only the right half', () => {
    const freshId = jest.fn(() => 'right');
    expect(clipSplitAnchor(clips, layout, 750, freshId)).toEqual({
      before: 'a',
      next: 'b',
      split: { sourceMs: 2500, sourceKey: a.sourceKey, rightId: 'right', offsetMs: 750 },
    });
    expect(freshId).toHaveBeenCalledTimes(1);
    expect(canSplitClip(a.edit, 0, layout.totalMs, 750)).toBe(true);
  });

  it.each([-1, 0, 2000, 2999, 3000, 4000, NaN, Infinity])(
    'makes no split or id at a boundary/end/invalid position: %s',
    (timeMs) => {
      const freshId = jest.fn(() => 'right');
      expect(clipSplitAnchor(clips, layout, timeMs, freshId)).toBeNull();
      expect(freshId).not.toHaveBeenCalled();
    },
  );

  it('enables only inside the selected clip, including an existing split half', () => {
    expect(canSplitClip(a.edit, 0, layout.totalMs, 0)).toBe(false);
    expect(canSplitClip(a.edit, 0, layout.totalMs, 2000)).toBe(false);
    expect(canSplitClip(a.edit, 0, layout.totalMs, 2200)).toBe(false);
    expect(canSplitClip(b.edit, 2000, layout.totalMs, 2200)).toBe(true);
    expect(canSplitClip(b.edit, 2000, layout.totalMs, 2999)).toBe(false);
    expect(canSplitClip(b.edit, 2000, layout.totalMs, NaN)).toBe(false);
    expect(clipSplitAnchor(clips, layout, 2200, () => 'right')).toMatchObject({
      before: 'b',
      split: { sourceMs: 200 },
    });
    const half = { ...a, edit: { startMs: 2500, endMs: 5000, speed: 2 } };
    expect(canSplitClip(half.edit, 750, 3000, 750)).toBe(false);
    expect(canSplitClip(half.edit, 750, 3000, 1000)).toBe(true);
  });
});
