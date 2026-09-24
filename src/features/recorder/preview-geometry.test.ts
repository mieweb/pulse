import { describe, expect, it } from '@jest/globals';

import { hasGeometry, previewGeometry } from './preview-geometry';

const stage = { width: 360, height: 640 };
const portrait = { width: 1080, height: 1920 };
const none = { rotation: 0, flipped: false, crop: null };

describe('previewGeometry', () => {
  it('fills a matching stage when there is no edit', () => {
    const g = previewGeometry(stage, portrait, none)!;
    expect(g.box).toEqual({ left: 0, top: 0, width: 360, height: 640 });
    expect(g.video).toMatchObject({ left: 0, top: 0, width: 360, height: 640 });
    expect(g.video.transform).toEqual([{ scaleX: 1 }, { rotate: '0deg' }]);
  });

  it('letterboxes a quarter turn into a landscape box and centres the video on it', () => {
    const g = previewGeometry(stage, portrait, { ...none, rotation: 1 })!;
    // Rotated frame is 1920×1080 → fits 360 wide, 202.5 tall, centred vertically.
    expect(g.box.width).toBeCloseTo(360);
    expect(g.box.height).toBeCloseTo(202.5);
    expect(g.box.top).toBeCloseTo((640 - 202.5) / 2);
    // The un-rotated view (portrait) is centred on the box so rotating it about its centre
    // fills the box exactly.
    expect(g.video.width).toBeCloseTo(202.5);
    expect(g.video.height).toBeCloseTo(360);
    expect(g.video.left + g.video.width / 2).toBeCloseTo(g.box.width / 2);
    expect(g.video.top + g.video.height / 2).toBeCloseTo(g.box.height / 2);
    expect(g.video.transform[1]).toEqual({ rotate: '-90deg' });
  });

  it('scales a crop up to the box and offsets the video by the crop origin', () => {
    const g = previewGeometry(stage, portrait, {
      ...none,
      crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    })!;
    // The bottom-right quarter fills the whole stage (same aspect).
    expect(g.box).toEqual({ left: 0, top: 0, width: 360, height: 640 });
    expect(g.video).toMatchObject({ left: -360, top: -640, width: 720, height: 1280 });
  });

  it('mirrors after rotating', () => {
    const g = previewGeometry(stage, portrait, { rotation: 3, flipped: true, crop: null })!;
    expect(g.video.transform).toEqual([{ scaleX: -1 }, { rotate: '-270deg' }]);
  });

  it('waits for a measured stage and source', () => {
    expect(previewGeometry({ width: 0, height: 0 }, portrait, none)).toBeNull();
    expect(previewGeometry(stage, { width: 0, height: 0 }, none)).toBeNull();
  });
});

describe('hasGeometry', () => {
  it('is false only for an unrotated, unflipped, uncropped clip', () => {
    expect(hasGeometry(none)).toBe(false);
    expect(hasGeometry({ ...none, rotation: 2 })).toBe(true);
    expect(hasGeometry({ ...none, flipped: true })).toBe(true);
    expect(hasGeometry({ ...none, crop: { x: 0, y: 0, w: 0.5, h: 1 } })).toBe(true);
  });
});
