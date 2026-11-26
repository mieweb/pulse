import { describe, expect, it } from '@jest/globals';

import type { Segment } from '@/db/schema';
import { clipRender, effMs, parseEdit, resetSegmentEdit } from './segment-window';
import { cutSegmentAt, interiorCutWindow } from './transcript-cut';

const settings = {
  startMs: 500,
  endMs: 3500,
  speed: 2,
  rotation: 1,
  flipped: true,
  muted: false,
  crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 },
};
const source = (overrides: Partial<Segment> = {}): Segment =>
  ({
    id: 'beat',
    originalFilename: 'source.mp4',
    durationMs: 4000,
    editedFilename: null,
    editedDurationMs: 1500,
    editState: JSON.stringify(settings),
    captionEdit: '{"file":"source.mp4","words":[{"text":"um","t0":150,"t1":200}]}',
    ...overrides,
  }) as Segment;

describe('interior speech cut', () => {
  it('snaps source word times to whole-ms frames, independent of timeline speed', () => {
    const render = clipRender(source());
    expect(interiorCutWindow(render, 1510, 1990, 30)).toEqual({ startMs: 1500, endMs: 2000 });
    expect(interiorCutWindow({ ...render, speed: 0.5 }, 1510, 1990, 30)).toEqual({
      startMs: 1500,
      endMs: 2000,
    });
  });

  it.each([
    [500, 1000, 30], // At the current trim's start.
    [1000, 3500, 30], // At its end.
    [500, 3500, 30], // The whole beat.
    [490, 1000, 30], // Outside its source window.
    [1000, 3510, 30],
    [510, 1000, 30], // Retained sliver disappears at source frame rounding.
    [1000, 3490, 30],
    [1000, 1001, 30], // The removed interval itself disappears.
    [2000, 1500, 30],
    [1000, 2000, 0],
    [NaN, 2000, 30],
    [1000, Infinity, 30],
  ])('rejects invalid or empty frame ranges (%s, %s, %s fps)', (start, end, fps) => {
    expect(interiorCutWindow(clipRender(source()), start, end, fps)).toBeNull();
  });

  it('preserves edits and caption corrections on two ranges sharing the original source', () => {
    const original = source();
    const { left, right } = cutSegmentAt(original, 1500, 2000, 'right', 30);
    expect([left.id, right.id]).toEqual(['beat', 'right']);
    expect([left, right].map((row) => row.originalFilename)).toEqual(['source.mp4', 'source.mp4']);
    const effects = clipRender(original);
    expect(clipRender(left)).toMatchObject({ ...effects, inMs: 500, outMs: 1500 });
    expect(clipRender(right)).toMatchObject({ ...effects, inMs: 2000, outMs: 3500 });
    expect(effMs(left) + effMs(right)).toBe(effMs(original) - 250);
    expect(left.captionEdit).toBe(original.captionEdit);
    expect(right.captionEdit).toBe(original.captionEdit);
    expect(original.editState).toBe(JSON.stringify(settings));
    expect(parseEdit(resetSegmentEdit(left))).toMatchObject({ startMs: 500, endMs: 1500 });
    expect(parseEdit(resetSegmentEdit(right))).toMatchObject({ startMs: 2000, endMs: 3500 });
  });

  it('uses the effective baked source and its duration for legacy media', () => {
    const original = source({ editedFilename: 'baked.mp4', editedDurationMs: 3000 });
    const { left, right } = cutSegmentAt(original, 1000, 1500, 'right', 30);
    expect([left, right].map((row) => row.originalFilename)).toEqual(['baked.mp4', 'baked.mp4']);
    expect([left, right].map((row) => row.editedFilename)).toEqual([null, null]);
    expect([left, right].map((row) => row.durationMs)).toEqual([3000, 3000]);
    expect(clipRender(right)).toMatchObject({ inMs: 1500, outMs: 3000, speed: 1, rotation: 0 });
  });

  it('requires a distinct identity for the right-hand occurrence', () => {
    expect(() => cutSegmentAt(source(), 1500, 2000, 'beat', 30)).toThrow('new clip id');
  });
});
