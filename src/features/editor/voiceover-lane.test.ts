import { describe, expect, it } from '@jest/globals';

import { voiceoverTapTime, voiceoverWidth } from './voiceover-lane';

const take = (startMs: number, trimStartMs = 0, trimEndMs = 1000) => ({
  startMs,
  trimStartMs,
  trimEndMs,
});

describe('voiceover lane taps', () => {
  it('shares the painted width, including the two-point gap and minimum size', () => {
    expect(voiceoverWidth(1000, 0.1)).toBe(98);
    expect(voiceoverWidth(1000, 0.5)).toBe(498);
    expect(voiceoverWidth(40, 0.1)).toBe(2);
    expect(voiceoverWidth(0.001, 0.01)).toBe(2);
  });

  it('hits the visible bar and leaves its trailing gap alone', () => {
    const takes = [take(1000)];
    expect(voiceoverTapTime(takes, 999, 0.1)).toBeNull();
    expect(voiceoverTapTime(takes, 1000, 0.1)).toBe(1000);
    expect(voiceoverTapTime(takes, 1750, 0.1)).toBe(1750);
    expect(voiceoverTapTime(takes, 1979.9, 0.1)).toBe(1979.9);
    expect(voiceoverTapTime(takes, 1980, 0.1)).toBeNull();
    expect(voiceoverTapTime(takes, 1990, 0.1)).toBeNull();
    expect(voiceoverTapTime(takes, 2000, 0.1)).toBeNull();
  });

  it('uses the trimmed source length at its independent draft position', () => {
    const takes = [take(10000, 4000, 4500)];
    expect(voiceoverTapTime(takes, 10250, 0.1)).toBe(10250);
    expect(voiceoverTapTime(takes, 10480, 0.1)).toBeNull();
    expect(voiceoverTapTime(takes, 14250, 0.1)).toBeNull();
  });

  it('leaves blank lane space and gaps between separate takes unselected', () => {
    const takes = [take(0), take(2000)];
    for (const time of [-1, 990, 1500, 1999, 3000, 8000]) {
      expect(voiceoverTapTime(takes, time, 0.1)).toBeNull();
    }
    expect(voiceoverTapTime(takes, 2000, 0.1)).toBe(2000);
    expect(voiceoverTapTime([], 0, 0.1)).toBeNull();
  });

  it('clamps a tiny bar’s extended visible area to the actual take end', () => {
    const takes = [take(1000, 700, 701)];
    expect(voiceoverTapTime(takes, 1000.5, 0.1)).toBe(1000.5);
    expect(voiceoverTapTime(takes, 1010, 0.1)).toBe(1001);
    expect(voiceoverTapTime(takes, 1019.9, 0.1)).toBe(1001);
    expect(voiceoverTapTime(takes, 1020, 0.1)).toBeNull();
  });

  it('hits the last-drawn overlapping bar, even over its minimum-width overflow', () => {
    const underneath = take(0, 0, 5000);
    const tiny = take(1000, 0, 1);
    expect(voiceoverTapTime([underneath, tiny], 1100, 0.01)).toBe(1001);
    expect(voiceoverTapTime([tiny, underneath], 1100, 0.01)).toBe(1100);
    expect(voiceoverTapTime([underneath, tiny], 1300, 0.01)).toBe(1300);
  });

  it('uses the live zoom for the visual gap instead of a fixed timeline tolerance', () => {
    const takes = [take(1000)];
    expect(voiceoverTapTime(takes, 1990, 0.1)).toBeNull();
    expect(voiceoverTapTime(takes, 1990, 0.5)).toBe(1990);
  });

  it.each([0, -0.1, NaN, Infinity, -Infinity])('rejects invalid zoom %s', (zoom) => {
    expect(voiceoverTapTime([take(0)], 500, zoom)).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity])('rejects invalid tap time %s', (time) => {
    expect(voiceoverTapTime([take(0)], time, 0.1)).toBeNull();
  });

  it('skips malformed windows without hiding a valid bar underneath', () => {
    const invalid = [
      take(-100),
      take(NaN),
      take(0, -1),
      take(0, NaN),
      take(0, 0, Infinity),
      take(0, 1000, 1000),
      take(0, 1000, 500),
    ];
    expect(voiceoverTapTime(invalid, 500, 0.1)).toBeNull();
    expect(voiceoverTapTime([take(0), ...invalid], 500, 0.1)).toBe(500);
  });

  it('rejects coordinate or timeline overflow rather than producing an infinite hit', () => {
    expect(voiceoverTapTime([take(0)], 1, Number.MAX_VALUE)).toBeNull();
    expect(voiceoverTapTime([take(0)], Number.MAX_VALUE, 2)).toBeNull();
    expect(
      voiceoverTapTime(
        [take(Number.MAX_VALUE / 2, 0, Number.MAX_VALUE)],
        Number.MAX_VALUE / 2,
        1e-308,
      ),
    ).toBeNull();
  });
});
