import { describe, expect, it } from '@jest/globals';

import type { Segment } from '@/db/schema';
import {
  compactCaptionWords,
  compactTranscriptWords,
  planTranscriptCut,
} from './bulk-transcript-cut';

const segment = (overrides: Partial<Segment> = {}): Segment =>
  ({
    id: 'beat',
    originalFilename: 'source.mp4',
    durationMs: 8000,
    editedFilename: null,
    editedDurationMs: null,
    editState: null,
    ...overrides,
  }) as Segment;

describe('reviewed bulk source ranges', () => {
  it('compacts owned words without retiming or losing custom caption/word metadata', () => {
    const words = [
      { text: 'before', t0: 0, t1: 50, start: true },
      { text: 'Corrected', t0: 100, t1: 150, confidence: 0.9, custom: 'kept' },
      { text: 'after', t0: 200, t1: 250 },
    ];
    const window = { startMs: 1000, endMs: 2000 };
    const payload = JSON.stringify({ file: 'source.mp4', words, customTopLevel: { keep: true } });
    expect(JSON.parse(compactCaptionWords(payload, 'source.mp4', window)!)).toEqual({
      file: 'source.mp4',
      customTopLevel: { keep: true },
      words: [{ ...words[1], start: true }],
    });
    expect(JSON.parse(compactTranscriptWords(JSON.stringify(words), window)!)).toEqual([
      { ...words[1], start: true },
    ]);
    expect(words[1]).not.toHaveProperty('start');
    expect(compactCaptionWords(payload, 'other.mp4', window)).toBe(payload);
    for (const legacy of ['legacy', '{"file":"source.mp4","words":[{"text":"untimed"}]}']) {
      expect(compactCaptionWords(legacy, 'source.mp4', window)).toBe(legacy);
      expect(compactTranscriptWords(legacy, window)).toBe(legacy);
    }
  });

  it('unions unsorted overlapping cuts without changing their inputs', () => {
    const ranges = [
      { startMs: 5000, endMs: 6000 },
      { startMs: 1500, endMs: 2500 },
      { startMs: 1000, endMs: 2000 },
    ];
    const before = JSON.stringify(ranges);
    expect(planTranscriptCut(segment(), ranges, 30)).toEqual({
      kept: [
        { startMs: 0, endMs: 1000 },
        { startMs: 2500, endMs: 5000 },
        { startMs: 6000, endMs: 8000 },
      ],
      removed: [
        { startMs: 1000, endMs: 2500 },
        { startMs: 5000, endMs: 6000 },
      ],
      removedMs: 2500,
    });
    expect(JSON.stringify(ranges)).toBe(before);
  });

  it('supports first/last words and removing a complete beat', () => {
    expect(
      planTranscriptCut(
        segment(),
        [
          { startMs: -100, endMs: 1000 },
          { startMs: 7000, endMs: 9000 },
        ],
        30,
      )?.kept,
    ).toEqual([{ startMs: 1000, endMs: 7000 }]);
    expect(planTranscriptCut(segment(), [{ startMs: 0, endMs: 8000 }], 30)).toEqual({
      kept: [],
      removed: [{ startMs: 0, endMs: 8000 }],
      removedMs: 8000,
    });
  });

  it('snaps frames, absorbs unplayable retained slivers and applies speed only to totals', () => {
    const editState = JSON.stringify({
      startMs: 500,
      endMs: 3500,
      speed: 2,
      rotation: 0,
      flipped: false,
      muted: false,
      crop: null,
    });
    expect(
      planTranscriptCut(
        segment({ editState }),
        [
          { startMs: 510, endMs: 1510 },
          { startMs: 1515, endMs: 1990 },
        ],
        30,
      ),
    ).toEqual({
      kept: [{ startMs: 2000, endMs: 3500 }],
      removed: [{ startMs: 500, endMs: 2000 }],
      removedMs: 750,
    });
  });

  it('plans against the baked file duration, not the original duration', () => {
    expect(
      planTranscriptCut(
        segment({ editedFilename: 'baked.mp4', editedDurationMs: 2000 }),
        [{ startMs: 1000, endMs: 8000 }],
        30,
      )?.kept,
    ).toEqual([{ startMs: 0, endMs: 1000 }]);
  });

  it('rejects invalid, out-of-window and sub-frame-only plans', () => {
    for (const ranges of [
      [],
      [{ startMs: NaN, endMs: 2000 }],
      [{ startMs: 2000, endMs: 1000 }],
      [{ startMs: 9000, endMs: 10000 }],
      [{ startMs: 1000, endMs: 1001 }],
    ]) {
      expect(planTranscriptCut(segment(), ranges, 30)).toBeNull();
    }
    expect(planTranscriptCut(segment(), [{ startMs: 1000, endMs: 2000 }], 0)).toBeNull();
  });
});
