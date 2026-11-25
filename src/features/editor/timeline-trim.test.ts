import { describe, expect, it } from '@jest/globals';

import { trimPreviewTarget, trimSourceBounds } from './timeline-geometry';

describe('trim boundaries after metadata splitting', () => {
  const whole = { startMs: 0, endMs: 10000, sourceMs: 10000, frameMs: 40 };

  it('keeps the existing whole-source trim limits for an unsplit clip', () => {
    expect(trimSourceBounds(whole, 1)).toEqual({ lo: 0, hi: 9000 });
    expect(trimSourceBounds(whole, 2)).toEqual({ lo: 1000, hi: 10000 });
  });

  it('cannot extend the left half beyond the split or its original visible start', () => {
    const left = {
      ...whole,
      startMs: 2000,
      endMs: 5000,
      sourceStartMs: 2000,
      sourceEndMs: 5000,
    };
    expect(trimSourceBounds(left, 1)).toEqual({ lo: 2000, hi: 4000 });
    expect(trimSourceBounds(left, 2)).toEqual({ lo: 3000, hi: 5000 });
  });

  it('can reveal trimmed frames within the right half without revealing its sibling', () => {
    const right = {
      ...whole,
      startMs: 6000,
      endMs: 9000,
      sourceStartMs: 5000,
      sourceEndMs: 10000,
    };
    expect(trimSourceBounds(right, 1)).toEqual({ lo: 5000, hi: 8000 });
    expect(trimSourceBounds(right, 2)).toEqual({ lo: 7000, hi: 10000 });
  });

  it('never inverts a trim range for a short half or a split between frame times', () => {
    const short = {
      ...whole,
      startMs: 125,
      endMs: 425,
      sourceStartMs: 125,
      sourceEndMs: 425,
    };
    expect(trimSourceBounds(short, 1)).toEqual({ lo: 125, hi: 125 });
    expect(trimSourceBounds(short, 2)).toEqual({ lo: 425, hi: 425 });
  });

  it('starts the right grip inside a subframe half instead of seeking into its sibling', () => {
    const info = {
      slotStartMs: 2000,
      sourceStartMs: 5125,
      speed: 2,
      frameMs: 1000 / 30,
    };
    expect(trimPreviewTarget(info, 1, 5125)).toBe(2000);
    expect(trimPreviewTarget(info, 2, 5130)).toBe(2000);
    expect(trimPreviewTarget(info, 2, 5225)).toBeCloseTo(2033.3333);
  });
});
