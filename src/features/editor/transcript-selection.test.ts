import { describe, expect, it } from '@jest/globals';

import { transcriptSelectionRanges } from './transcript-selection';

const sources = [
  { clipId: 'a', inMs: 0, outMs: 5000 },
  { clipId: 'silent-picture', inMs: 0, outMs: 2000 },
  { clipId: 'b', inMs: 1000, outMs: 6000 },
];
const words = [
  { id: 'one', clipId: 'a', index: 0, startMs: 100, endMs: 500 },
  { id: 'two', clipId: 'a', index: 1, startMs: 1500, endMs: 2000 },
  { id: 'three', clipId: 'a', index: 2, startMs: 3000, endMs: 3500 },
  { id: 'four', clipId: 'b', index: 2, startMs: 1200, endMs: 1800 },
  { id: 'five', clipId: 'b', index: 3, startMs: 2500, endMs: 3000 },
];
describe('transcript selection source ranges', () => {
  it('cuts pauses between consecutive selected words rather than leaving silent fragments', () => {
    expect(
      transcriptSelectionRanges(sources, words, new Set(['one', 'two']), false).get('a'),
    ).toEqual([{ startMs: 100, endMs: 2000 }]);
  });
  it('preserves unselected words between separate checkbox selections', () => {
    expect(
      transcriptSelectionRanges(sources, words, new Set(['one', 'three']), false).get('a'),
    ).toEqual([
      { startMs: 100, endMs: 500 },
      { startMs: 3000, endMs: 3500 },
    ]);
  });
  it('cuts a passage through beat boundaries and intervening material with no transcript', () => {
    expect([
      ...transcriptSelectionRanges(sources, words, new Set(['three', 'four']), true),
    ]).toEqual([
      ['a', [{ startMs: 3000, endMs: 5000 }]],
      ['silent-picture', [{ startMs: 0, endMs: 2000 }]],
      ['b', [{ startMs: 1000, endMs: 1800 }]],
    ]);
  });
  it('keeps unrelated silent beats when using individual word selections', () => {
    expect([
      ...transcriptSelectionRanges(sources, words, new Set(['three', 'four']), false).keys(),
    ]).toEqual(['a', 'b']);
  });
  it('clamps a passage to the owned trim and ignores empty selections', () => {
    expect(
      transcriptSelectionRanges(
        sources.slice(2),
        [
          { ...words[3], startMs: 800 },
          { ...words[4], endMs: 7000 },
        ],
        new Set(['four', 'five']),
        true,
      ).get('b'),
    ).toEqual([{ startMs: 1000, endMs: 6000 }]);
    expect(transcriptSelectionRanges(sources, words, new Set(), true).size).toBe(0);
  });
});
