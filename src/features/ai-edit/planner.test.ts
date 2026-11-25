import { describe, expect, it } from '@jest/globals';

import { buildPassages, createCutPlan, fitPassageSelection, type AiEditSource } from './planner';

const source = (overrides: Partial<AiEditSource> = {}): AiEditSource => ({
  segmentId: 'clip-a',
  file: 'drafts/a/segments/a.mp4',
  sourceKey: 'source-a',
  startMs: 0,
  endMs: 10_000,
  speed: 1,
  words: [
    { text: 'First', t0: 100, t1: 150 },
    { text: 'point.', t0: 160, t1: 200 },
    { text: 'Another', t0: 210, t1: 260 },
    { text: 'point.', t0: 270, t1: 300 },
  ],
  ...overrides,
});

describe('offline AI passage planning', () => {
  it('converts file-time centiseconds explicitly, keeps stable source IDs and honors edited bounds', () => {
    const passages = buildPassages([source({ startMs: 1550, endMs: 2800, speed: 2 })]);
    expect(passages.map((p) => [p.id, p.text, p.startMs, p.endMs, p.durationMs])).toEqual([
      ['p:clip-a:1-2', 'point.', 1600, 2000, 200],
      ['p:clip-a:2-3', 'Another', 2100, 2600, 250],
    ]);
    expect(buildPassages([source()])[0].id).toBe('p:clip-a:0-2');
  });

  it('keeps padding inside actual silence and never cuts into an adjacent unselected word', () => {
    const passages = buildPassages([source()]);
    const plan = createCutPlan(passages, [passages[0].id]);
    expect(plan.intervals).toEqual([
      {
        segmentId: 'clip-a',
        file: source().file,
        sourceKey: 'source-a',
        startMs: 880,
        endMs: 2100,
      },
    ]);
    expect(plan.durationMs).toBe(1220);
  });

  it('merges overlapping padding from adjacent selections and counts it once', () => {
    const passages = buildPassages([source()]);
    const plan = createCutPlan(
      passages,
      passages.map((p) => p.id),
    );
    expect(plan.intervals).toHaveLength(1);
    expect(plan.intervals[0]).toMatchObject({ startMs: 880, endMs: 3120 });
    expect(plan.durationMs).toBe(2240);
  });

  it('keeps overlapping word timestamps together instead of cutting through an unselected word', () => {
    const passages = buildPassages([
      source({
        words: [
          { text: 'One.', t0: 0, t1: 100 },
          { text: 'Two.', t0: 90, t1: 150 },
          { text: 'Later.', t0: 200, t1: 250 },
        ],
      }),
    ]);
    expect(passages.map((passage) => passage.text)).toEqual(['One. Two.', 'Later.']);
    expect(createCutPlan(passages, [passages[0].id]).intervals[0].endMs).toBe(1620);
  });

  it('fits whole priority-ranked passages, skips an oversized choice and restores timeline order', () => {
    const passages = buildPassages([
      source({
        endMs: 120_000,
        words: [
          { text: 'Early.', t0: 0, t1: 2000 },
          { text: 'Long.', t0: 3000, t1: 8000 },
          { text: 'Late.', t0: 9000, t1: 11_000 },
        ],
      }),
    ]);
    const plan = fitPassageSelection(passages, [passages[2].id, passages[1].id, passages[0].id], {
      maxDurationMs: 40_000,
      paddingMs: 0,
    });
    expect(plan.selectedPassageIds).toEqual([passages[0].id, passages[2].id]);
    expect(plan.durationMs).toBe(40_000);
    expect(plan.intervals.map((p) => p.startMs)).toEqual([0, 90_000]);
    expect(() =>
      createCutPlan(
        passages,
        passages.map((p) => p.id),
        { maxDurationMs: 40_000 },
      ),
    ).toThrow('exceed');
  });

  it('uses playback speed in the budget and preserves ordered source segments', () => {
    const passages = buildPassages([
      source({ speed: 2 }),
      source({ segmentId: 'clip-b', file: 'b.mp4', sourceKey: 'b' }),
    ]);
    const chosen = [passages[3].id, passages[0].id];
    const plan = createCutPlan(passages, chosen, { paddingMs: 0 });
    expect(plan.intervals.map((interval) => interval.segmentId)).toEqual(['clip-a', 'clip-b']);
    expect(plan.durationMs).toBe(1400);
  });

  it('bounds ten minutes of punctuation-free speech at whole-word boundaries', () => {
    const words = Array.from({ length: 600 }, (_, i) => ({
      text: `word${i}`,
      t0: i * 100,
      t1: i * 100 + 80,
    }));
    const passages = buildPassages([source({ words, endMs: 600_000 })]);
    expect(passages.length).toBeGreaterThan(20);
    expect(passages.every((p) => p.durationMs <= 25_000)).toBe(true);
    expect(passages.map((p) => p.text).join(' ')).toBe(words.map((word) => word.text).join(' '));
    const plan = fitPassageSelection(
      passages,
      passages.map((p) => p.id),
    );
    expect(plan.durationMs).toBeLessThanOrEqual(115_000);
    for (const interval of plan.intervals) {
      expect(words.some((word) => word.t0 * 10 >= interval.startMs)).toBe(true);
      expect(words.some((word) => word.t1 * 10 <= interval.endMs)).toBe(true);
    }
  });

  it('rejects unknown, duplicate, empty and entirely over-budget model selections', () => {
    const passages = buildPassages([source()]);
    expect(() => fitPassageSelection(passages, ['invented'])).toThrow('unknown');
    expect(() => fitPassageSelection(passages, [passages[0].id, passages[0].id])).toThrow(
      'repeated',
    );
    expect(() => fitPassageSelection(passages, [])).toThrow('No complete');
    expect(() => fitPassageSelection(passages, [passages[0].id], { maxDurationMs: 200 })).toThrow(
      'No complete',
    );
    expect(() => createCutPlan(passages, [])).toThrow('did not select');
    expect(() => createCutPlan(passages, [passages[0].id], { maxDurationMs: 120_000 })).toThrow(
      'invalid',
    );
  });

  it('rejects corrupt transcript timing before producing candidate IDs', () => {
    expect(() => buildPassages([source({ words: [{ text: 'bad', t0: 20, t1: 10 }] })])).toThrow(
      'word timing',
    );
    expect(() => buildPassages([source(), source()])).toThrow('source');
  });
});
