import { describe, expect, it } from '@jest/globals';

import { buildPassages, type AiEditPassage } from './planner';
import { passageBatches, selectCut } from './selection';

function passages(count: number): AiEditPassage[] {
  return buildPassages([
    {
      segmentId: 'source',
      file: 'source.mp4',
      sourceKey: 'original',
      startMs: 0,
      endMs: count * 12_000,
      speed: 1,
      words: Array.from({ length: count }, (_, index) => ({
        text: `Complete thought ${index}.`,
        t0: index * 1200 + 10,
        t1: index * 1200 + 1000,
      })),
    },
  ]);
}

describe('local AI selection orchestration', () => {
  it('fits ranked whole passages and restores the original order within the padded duration', async () => {
    const source = passages(15);
    const cut = await selectCut(
      source,
      async (batch) => ({ selectedIds: batch.map((p) => p.id).reverse() }),
      () => {},
    );
    expect(cut.durationMs).toBeLessThanOrEqual(115_000);
    expect(cut.intervals.length).toBeGreaterThan(1);
    expect(cut.intervals[0].startMs).toBeGreaterThan(0);
    expect(cut.intervals.map((p) => p.startMs)).toEqual(
      [...cut.intervals].map((p) => p.startMs).sort((a, b) => a - b),
    );
    // Every boundary still contains the selected complete sentence, never a chopped suffix.
    expect(
      cut.intervals.every((p) => source.some((s) => s.startMs >= p.startMs && s.endMs <= p.endMs)),
    ).toBe(true);
  });

  it('shortlists long recordings before a global pass using source text', async () => {
    const source = passages(50);
    const calls: string[][] = [];
    const cut = await selectCut(
      source,
      async (batch) => {
        calls.push(batch.map((p) => p.id));
        return { selectedIds: batch.slice(0, 3).map((p) => p.id) };
      },
      () => {},
    );
    expect(calls.length).toBe(4);
    expect(calls.every((batch) => batch.length <= 24)).toBe(true);
    expect(calls.at(-1)).toEqual(
      [...source.slice(0, 3), ...source.slice(24, 27), ...source.slice(48, 50)].map((p) => p.id),
    );
    expect(cut.durationMs).toBeLessThanOrEqual(115_000);
  });

  it('rejects invented, repeated and empty selections without creating heuristic cuts', async () => {
    const source = passages(3);
    for (const selectedIds of [['invented'], [source[0].id, source[0].id], []]) {
      await expect(
        selectCut(
          source,
          async () => ({ selectedIds }),
          () => {},
        ),
      ).rejects.toThrow();
    }
  });

  it('allows an intermediate chunk with no useful passages while requiring a real final cut', async () => {
    const source = passages(30);
    let call = 0;
    const cut = await selectCut(
      source,
      async (batch) => ({
        selectedIds: ++call === 2 ? [] : [batch[0].id],
      }),
      () => {},
    );
    expect(call).toBe(3);
    expect(cut.selectedPassageIds).toEqual([source[0].id]);
    await expect(
      selectCut(
        source,
        async () => ({ selectedIds: [] }),
        () => {},
      ),
    ).rejects.toThrow('did not find');
  });

  it('gives a long tail passage room in the intermediate shortlist', async () => {
    const source = passages(25);
    source[24] = {
      ...source[24],
      endMs: source[24].startMs + 25_000,
      durationMs: 25_000,
      paddingEndMs: source[24].startMs + 25_120,
    };
    const cut = await selectCut(
      source,
      async (batch) => ({ selectedIds: [batch.at(-1)!.id] }),
      () => {},
    );
    expect(cut.selectedPassageIds).toEqual([source[24].id]);
  });

  it('stops before a native request and after a cancelled in-flight result', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await expect(
      selectCut(
        passages(2),
        async () => {
          called = true;
          return { selectedIds: [] };
        },
        () => {},
        controller.signal,
      ),
    ).rejects.toThrow('cancelled');
    expect(called).toBe(false);
    const during = new AbortController();
    await expect(
      selectCut(
        passages(2),
        async (batch) => {
          during.abort();
          return { selectedIds: [batch[0].id] };
        },
        () => {},
        during.signal,
      ),
    ).rejects.toThrow('cancelled');
  });

  it('bounds input text as well as passage counts', () => {
    const source = passages(5).map((p) => ({ ...p, text: 'word '.repeat(600) }));
    expect(passageBatches(source).map((batch) => batch.length)).toEqual([2, 2, 1]);
  });
});
