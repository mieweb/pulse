import { describe, expect, it, jest } from '@jest/globals';

jest.mock('./client', () => ({ db: {} }));
jest.mock('@/utils/file-store', () => ({ deleteSegmentFile: jest.fn() }));

/* eslint-disable import/first -- the mocks above must be registered before this loads */
import { planBakedEditDrops } from './baked-edits-migration';
/* eslint-enable import/first */

const state = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    startMs: 1000,
    endMs: 3000,
    rotation: 0,
    flipped: false,
    crop: null,
    muted: false,
    speed: 2,
    ...over,
  });

describe('planBakedEditDrops', () => {
  it('drops the baked file and records the timeline length from the settings', () => {
    const { drops, deferred } = planBakedEditDrops([
      { id: 's1', editedFilename: 'a.edited.1.mp4', editState: state(), uploadStatus: null },
    ]);
    expect(drops).toEqual([{ id: 's1', editedFilename: 'a.edited.1.mp4', editedDurationMs: 1000 }]);
    expect(deferred).toBe(0);
  });

  it('defers drafts that are uploading', () => {
    const { drops, deferred } = planBakedEditDrops([
      { id: 's1', editedFilename: 'a.mp4', editState: state(), uploadStatus: 'uploading' },
      { id: 's2', editedFilename: 'b.mp4', editState: state(), uploadStatus: 'uploaded' },
    ]);
    expect(drops.map((d) => d.id)).toEqual(['s2']);
    expect(deferred).toBe(1);
  });

  it('keeps the baked file when the settings are unusable', () => {
    const { drops } = planBakedEditDrops([
      { id: 's1', editedFilename: 'a.mp4', editState: 'not json', uploadStatus: null },
    ]);
    expect(drops).toEqual([]);
  });
});
