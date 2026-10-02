import { describe, expect, it } from '@jest/globals';

import {
  centerBounds,
  clampCenter,
  parsePosition,
  serializePosition,
} from './record-button-position';

const screen = { width: 400, height: 800 };
const insets = { top: 50, bottom: 30, left: 0, right: 0 };
const bounds = centerBounds({
  screen,
  insets,
  topReserved: 100,
  buttonSize: 80,
  leftExtent: 40,
  margin: 10,
});

describe('centerBounds', () => {
  it('keeps the button and its left handle on screen, below the top bar', () => {
    expect(bounds).toEqual({ minX: 90, maxX: 350, minY: 150, maxY: 720 });
  });
});

describe('clampCenter', () => {
  it('leaves an in-bounds point alone', () => {
    expect(clampCenter({ x: 200, y: 400 }, bounds)).toEqual({ x: 200, y: 400 });
  });

  it('clamps to every edge', () => {
    expect(clampCenter({ x: -50, y: 0 }, bounds)).toEqual({ x: 90, y: 150 });
    expect(clampCenter({ x: 999, y: 999 }, bounds)).toEqual({ x: 350, y: 720 });
  });

  it('collapses an inverted range onto its midpoint', () => {
    expect(clampCenter({ x: 0, y: 0 }, { minX: 10, maxX: 0, minY: 4, maxY: 4 })).toEqual({
      x: 5,
      y: 4,
    });
  });
});

describe('position persistence', () => {
  it('round-trips as screen fractions', () => {
    const raw = serializePosition({ x: 100, y: 600 }, screen);
    expect(parsePosition(raw)).toEqual({ x: 0.25, y: 0.75 });
  });

  it('rejects unset, corrupt, and out-of-range values', () => {
    expect(parsePosition(null)).toBeNull();
    expect(parsePosition('')).toBeNull();
    expect(parsePosition('not json')).toBeNull();
    expect(parsePosition('null')).toBeNull();
    expect(parsePosition('{"x":0.5}')).toBeNull();
    expect(parsePosition('{"x":"0.5","y":0.5}')).toBeNull();
    expect(parsePosition('{"x":1.5,"y":0.5}')).toBeNull();
    expect(parsePosition('{"x":-0.1,"y":0.5}')).toBeNull();
  });
});
