import { describe, expect, it, jest } from '@jest/globals';

import { canSplitAtPlayhead, canSplitClip, clipSplitAnchor } from './clip-split';

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

  it('follows the playhead across clips without a selection or Edit mode', () => {
    const edits = clips.map((clip) => clip.edit);
    for (const ms of [0, 1999, 2000, 2999, 3000, NaN]) {
      expect(canSplitAtPlayhead(edits, layout.starts, layout.totalMs, ms)).toBe(false);
    }
    for (const ms of [750, 1998, 2200]) {
      expect(canSplitAtPlayhead(edits, layout.starts, layout.totalMs, ms)).toBe(true);
    }
    expect(canSplitAtPlayhead([], [], 0, 0)).toBe(false);
  });

  it.each([
    [1.25, 750.123],
    [1.1, 750],
  ])('does not split again at a rounded boundary at speed %s and playhead %s', (speed, timeMs) => {
    const original = {
      id: 'fractional',
      sourceKey: 'fractional-key',
      edit: { startMs: 500, endMs: 3500, speed },
    };
    const totalMs = (original.edit.endMs - original.edit.startMs) / speed;
    const first = clipSplitAnchor([original], { starts: [0], totalMs }, timeMs, () => 'r');
    const sourceMs = first!.split!.sourceMs;
    const boundary = (sourceMs - original.edit.startMs) / original.edit.speed;
    expect(boundary).toBeLessThan(timeMs);
    const halves = [
      { ...original, edit: { ...original.edit, endMs: sourceMs } },
      { ...original, id: 'r', edit: { ...original.edit, startMs: sourceMs } },
    ];
    const layout = { starts: [0, boundary], totalMs };
    const freshId = jest.fn(() => 'tiny');
    for (const at of [timeMs, boundary - 1e-10, boundary + 1e-10]) {
      expect(
        canSplitAtPlayhead(
          halves.map((clip) => clip.edit),
          layout.starts,
          totalMs,
          at,
        ),
      ).toBe(false);
      expect(clipSplitAnchor(halves, layout, at, freshId)).toBeNull();
    }
    expect(freshId).not.toHaveBeenCalled();
    expect(clipSplitAnchor(halves, layout, timeMs + 2, freshId)?.split).toBeDefined();
  });
});
