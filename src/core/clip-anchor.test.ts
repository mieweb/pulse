import { describe, expect, it, jest } from '@jest/globals';

import {
  anchorForPlayhead,
  anchorForExactPlayhead,
  anchorFromRouteParam,
  anchorSlot,
  anchorToRouteParam,
  END,
  expectClipsAdded,
  isEnd,
  noteClipsAdded,
  onClipsAdded,
  playheadSlot,
  resolveAnchor,
  returnEditorTo,
  sameAnchor,
  takeClipsAdded,
  takeClipSplits,
  takeEditorReturn,
  timeAtAnchor,
  type ClipAnchor,
} from './clip-anchor';

const inside: ClipAnchor = {
  before: 'a',
  next: 'b',
  split: { sourceMs: 1500, sourceKey: 'drafts/d/a.mp4#trim', rightId: 'a-right', offsetMs: 250 },
};

describe('route params', () => {
  it.each<ClipAnchor>([
    { before: 'd1-170' },
    { before: 'abc_DEF-9', next: 'x' },
    { at: 'end' },
    inside,
  ])('round-trips %j', (anchor) => {
    expect(anchorFromRouteParam(anchorToRouteParam(anchor))).toEqual(anchor);
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['an empty string', ''],
    ['an array (a repeated param)', ['before:a', 'before:b']],
    ['an unknown side', 'inside:a'],
    ['an after anchor (no longer made)', 'after:a'],
    ['no id', 'before:'],
    ['an id with a path in it', 'before:../x'],
    ['an id with a colon', 'before:a:b'],
    ['an empty next', 'before:a,'],
    ['a third id', 'before:a,b,c'],
    ['an id too long', `before:${'a'.repeat(129)}`],
    ['plain "end"', 'end'],
  ])('reads %s as the end', (_name, param) => {
    expect(anchorFromRouteParam(param)).toEqual(END);
  });

  it.each([
    {},
    { before: 'a' },
    { before: '../a', split: { sourceMs: 1, offsetMs: 1, sourceKey: 'file', rightId: 'r' } },
    { before: 'a', split: { sourceMs: 0, offsetMs: 1, sourceKey: 'file', rightId: 'r' } },
    { before: 'a', split: { sourceMs: 1, offsetMs: -1, sourceKey: 'file', rightId: 'r' } },
    { before: 'a', split: { sourceMs: Number.NaN, offsetMs: 1, sourceKey: 'file', rightId: 'r' } },
    { before: 'a', split: { sourceMs: 1, offsetMs: 1, sourceKey: '', rightId: 'r' } },
    { before: 'a', split: { sourceMs: 1, offsetMs: 1, sourceKey: 'x'.repeat(4097), rightId: 'r' } },
    { before: 'a', split: { sourceMs: 1, offsetMs: 1, sourceKey: 'file\nkey', rightId: 'r' } },
    { before: 'a', split: { sourceMs: 1, offsetMs: 1, sourceKey: 'file', rightId: 'a' } },
    { before: 'a', split: { sourceMs: 1, offsetMs: 1, sourceKey: 'file', rightId: '../r' } },
    { before: 'a', next: [], split: { sourceMs: 1, offsetMs: 1, sourceKey: 'file', rightId: 'r' } },
  ])('rejects a malformed exact source position %j', (value) => {
    expect(anchorFromRouteParam(`inside:${encodeURIComponent(JSON.stringify(value))}`)).toEqual(
      END,
    );
  });

  it('rejects broken or oversized encoded exact positions', () => {
    expect(anchorFromRouteParam('inside:%broken')).toEqual(END);
    expect(anchorFromRouteParam(`inside:${'x'.repeat(20001)}`)).toEqual(END);
  });
});

describe('resolveAnchor / anchorSlot', () => {
  const ids = ['a', 'b', 'c'];

  it.each<[ClipAnchor, number]>([
    [{ before: 'a', next: 'b' }, 0],
    [{ before: 'b' }, 1],
    [{ before: 'c', next: 'a' }, 2], // its own clip, while there, wins
    [{ before: 'gone', next: 'b' }, 1], // its clip went: before the clip that followed it
    [{ before: 'gone', next: 'also-gone' }, 3], // both went: the end
    [{ before: 'gone' }, 3], // it was the last clip: the end
    [END, 3],
  ])('%j → slot %d', (anchor, slot) => {
    expect(anchorSlot(anchor, ids)).toBe(slot);
  });

  it('asks for `before`, then `next`, and nothing for the end', () => {
    const asked: string[] = [];
    const slotOf = (id: string) => {
      asked.push(id);
      return id === 'b' ? 7 : undefined;
    };
    expect(resolveAnchor({ before: 'x', next: 'b' }, slotOf)).toBe(7);
    expect(resolveAnchor({ before: 'b', next: 'x' }, slotOf)).toBe(7);
    expect(resolveAnchor({ before: 'x' }, slotOf)).toBeUndefined();
    expect(resolveAnchor(END, slotOf)).toBeUndefined();
    expect(asked).toEqual(['x', 'b', 'b', 'x']);
  });

  it('keeps an exact point on its original until the right half is committed', () => {
    expect(anchorSlot(inside, ['a', 'b'])).toBe(0);
    expect(anchorSlot(inside, ['a', 'x', 'a-right', 'b'])).toBe(2);
    // Missing original is stale, not a boundary fallback to the next clip.
    expect(resolveAnchor(inside, (id) => (id === 'b' ? 7 : undefined))).toBeUndefined();
  });
});

describe('anchorForExactPlayhead', () => {
  const clips = [
    { id: 'a', sourceKey: 'a-key', edit: { startMs: 1000, endMs: 3000, speed: 2 } },
    { id: 'b', sourceKey: 'b-key', edit: { startMs: 0, endMs: 2000, speed: 1 } },
    { id: 'c', sourceKey: 'c-key', edit: { startMs: 0, endMs: 1000, speed: 1 } },
  ];
  const starts = [0, 1000, 3000];

  it('captures the exact source point through existing trim and speed', () => {
    expect(anchorForExactPlayhead(clips, starts, 4000, 250, () => 'a-right')).toEqual({
      before: 'a',
      next: 'b',
      split: { sourceMs: 1500, sourceKey: 'a-key', rightId: 'a-right', offsetMs: 250 },
    });
    expect(anchorForExactPlayhead(clips, starts, 4000, 750, () => 'a-right')).toMatchObject({
      before: 'a',
      split: { sourceMs: 2500, offsetMs: 750 },
    });
    expect(anchorForExactPlayhead(clips, starts, 4000, 3999, () => 'c-right')).toMatchObject({
      before: 'c',
      split: { sourceMs: 999, sourceKey: 'c-key', rightId: 'c-right' },
    });
  });

  it('inserts at boundaries and appends at the end without allocating a half', () => {
    const fresh = jest.fn(() => 'new');
    expect(anchorForExactPlayhead(clips, starts, 4000, 0, fresh)).toEqual({
      before: 'a',
      next: 'b',
    });
    expect(anchorForExactPlayhead(clips, starts, 4000, 1000, fresh)).toEqual({
      before: 'b',
      next: 'c',
    });
    expect(anchorForExactPlayhead(clips, starts, 4000, 4000, fresh)).toEqual(END);
    expect(anchorForExactPlayhead(clips, starts, 4000, -1, fresh)).toEqual({
      before: 'a',
      next: 'b',
    });
    expect(anchorForExactPlayhead(clips, starts, 4000, Number.NaN, fresh)).toEqual(END);
    expect(anchorForExactPlayhead([], [], 0, 0, fresh)).toEqual(END);
    expect(fresh).not.toHaveBeenCalled();
  });
});

describe('anchorForPlayhead', () => {
  // Three clips: a 0–1000, b 1000–3000, c 3000–4000.
  const ids = ['a', 'b', 'c'];
  const starts = [0, 1000, 3000];
  const at = (t: number) => anchorForPlayhead(ids, starts, 4000, t);

  // Each anchor names the clip after it as `next`, where there is one.
  it.each<[number, ClipAnchor]>([
    [0, { before: 'a', next: 'b' }],
    [499, { before: 'a', next: 'b' }],
    [500, { before: 'b', next: 'c' }], // the midpoint is the second half: before the next clip
    [999, { before: 'b', next: 'c' }],
    [1000, { before: 'b', next: 'c' }], // on a boundary: before the next clip
    [1999, { before: 'b', next: 'c' }],
    [2000, { before: 'c' }],
    [3000, { before: 'c' }],
    [3400, { before: 'c' }],
    [3500, END], // after the last clip is the end
    [4000, END],
    [9000, END],
    [-5, { before: 'a', next: 'b' }],
  ])('at %d ms → %j', (t, expected) => {
    expect(at(t)).toEqual(expected);
  });

  it('is the end for an empty draft or a playhead that isn’t a number', () => {
    expect(anchorForPlayhead([], [], 0, 0)).toEqual(END);
    expect(at(Number.NaN)).toEqual(END);
  });

  it('a one-clip draft', () => {
    expect(anchorForPlayhead(['a'], [0], 1000, 100)).toEqual({ before: 'a' });
    expect(anchorForPlayhead(['a'], [0], 1000, 600)).toEqual(END);
  });
  it('playheadSlot gives the same rule as positions: the clip under it and the slot to add at', () => {
    expect(playheadSlot(starts, 4000, 499)).toEqual({ clip: 0, slot: 0 });
    expect(playheadSlot(starts, 4000, 500)).toEqual({ clip: 0, slot: 1 });
    expect(playheadSlot(starts, 4000, 1000)).toEqual({ clip: 1, slot: 1 });
    expect(playheadSlot(starts, 4000, 3500)).toEqual({ clip: 2, slot: 3 });
    expect(playheadSlot(starts, 4000, 4000)).toEqual({ clip: -1, slot: 3 });
    expect(playheadSlot([], 0, 0)).toEqual({ clip: -1, slot: 0 });
  });
});

describe('timeAtAnchor', () => {
  // Three clips: a 0–1000, b 1000–3000, c 3000–4000.
  const ids = ['a', 'b', 'c'];
  const starts = [0, 1000, 3000];

  it.each<[ClipAnchor, number]>([
    [{ before: 'a', next: 'b' }, 0],
    [{ before: 'b', next: 'c' }, 1000],
    [{ before: 'c' }, 3000],
    [END, 4000],
    [{ before: 'gone', next: 'c' }, 3000], // as the anchor resolves: before `next`
    [{ before: 'gone' }, 4000],
  ])('%j → %d ms', (anchor, ms) => {
    expect(timeAtAnchor(anchor, ids, starts, 4000)).toBe(ms);
  });

  it('is the way back from anchorForPlayhead, at every boundary', () => {
    for (const ms of [0, 1000, 3000, 3999]) {
      const anchor = anchorForPlayhead(ids, starts, 4000, ms);
      expect(anchorForPlayhead(ids, starts, 4000, timeAtAnchor(anchor, ids, starts, 4000))).toEqual(
        anchor,
      );
    }
  });

  it('is 0 in an empty draft', () => {
    expect(timeAtAnchor(END, [], [], 0)).toBe(0);
  });

  it('returns the exact point before the split, and the right boundary once committed', () => {
    expect(timeAtAnchor(inside, ids, starts, 4000)).toBe(250);
    expect(timeAtAnchor(inside, ['b', 'a', 'c'], [0, 2000, 3000], 4000)).toBe(2250);
    expect(timeAtAnchor(inside, ['a', 'x', 'a-right', 'b'], [0, 250, 1250, 2000], 4000)).toBe(1250);
  });
});

describe('sameAnchor / isEnd', () => {
  it('compares by clip and next clip', () => {
    expect(sameAnchor({ before: 'a' }, { before: 'a' })).toBe(true);
    expect(sameAnchor({ before: 'a', next: 'b' }, { before: 'a', next: 'b' })).toBe(true);
    expect(sameAnchor({ before: 'a' }, { before: 'a', next: 'b' })).toBe(false);
    expect(sameAnchor({ before: 'a' }, { before: 'b' })).toBe(false);
    expect(sameAnchor(END, { at: 'end' })).toBe(true);
    expect(sameAnchor(END, { before: 'a' })).toBe(false);
    expect(isEnd(END)).toBe(true);
    expect(isEnd({ before: 'a' })).toBe(false);
  });

  it('distinguishes frozen split positions and ordinary boundaries on the same clip', () => {
    expect(sameAnchor(inside, { ...inside })).toBe(true);
    expect(sameAnchor(inside, { before: 'a', next: 'b' })).toBe(false);
    if (isEnd(inside) || !inside.split) throw new Error('expected an inside anchor');
    expect(sameAnchor(inside, { ...inside, split: { ...inside.split, sourceMs: 1501 } })).toBe(
      false,
    );
    expect(sameAnchor(inside, { ...inside, split: { ...inside.split, rightId: 'other' } })).toBe(
      false,
    );
  });
});

describe('clips added', () => {
  it('queues the compound split receipt separately from inserted clip ids', () => {
    const split = {
      before: { draftId: 'split-d', order: ['a'], rows: [], transcripts: [] },
      rightId: 'a-right',
      firstInsertedId: 'x',
    };
    expect(noteClipsAdded({ draftId: 'split-d', segmentIds: ['x'], split })).toBe(false);
    const disarm = expectClipsAdded('split-d');
    expect(noteClipsAdded({ draftId: 'split-d', segmentIds: ['x'], split })).toBe(true);
    expect(takeClipsAdded('split-d')).toEqual(['x']);
    expect(takeClipSplits('split-d')).toEqual([split]);
    expect(takeClipSplits('split-d')).toEqual([]);
    disarm();
  });

  it('discards undelivered split receipts once when the final editor closes', () => {
    const discard = jest.fn();
    const split = {
      before: { draftId: 'discard-d', order: ['a'], rows: [], transcripts: [] },
      rightId: 'a-right',
      firstInsertedId: 'x',
    };
    const first = expectClipsAdded('discard-d', discard);
    const last = expectClipsAdded('discard-d');
    noteClipsAdded({ draftId: 'discard-d', segmentIds: ['x'], split });
    first();
    expect(discard).not.toHaveBeenCalled();
    last();
    last();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith(split);
    expect(takeClipSplits('discard-d')).toEqual([]);
  });

  it('tells listeners, and keeps an armed draft’s ids until taken', () => {
    const listener = jest.fn();
    const stop = onClipsAdded(listener);
    const disarm1 = expectClipsAdded('d1');
    const disarm2 = expectClipsAdded('d2');
    noteClipsAdded({ draftId: 'd1', segmentIds: ['x'] });
    noteClipsAdded({ draftId: 'd2', segmentIds: ['y'] });
    noteClipsAdded({ draftId: 'd1', segmentIds: ['z', 'w'] });
    stop();
    noteClipsAdded({ draftId: 'd1', segmentIds: ['v'] });

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenNthCalledWith(1, { draftId: 'd1', segmentIds: ['x'] });
    expect(takeClipsAdded('d1')).toEqual(['x', 'z', 'w', 'v']);
    expect(takeClipsAdded('d1')).toEqual([]);
    expect(takeClipsAdded('d2')).toEqual(['y']);
    disarm1();
    disarm2();
  });

  it('keeps nothing for a draft no editor armed, or from before it was armed', () => {
    noteClipsAdded({ draftId: 'd4', segmentIds: ['early'] });
    expect(takeClipsAdded('d4')).toEqual([]);
    const disarm = expectClipsAdded('d4');
    expect(takeClipsAdded('d4')).toEqual([]);
    noteClipsAdded({ draftId: 'd4', segmentIds: ['x'] });
    disarm();
    noteClipsAdded({ draftId: 'd4', segmentIds: ['late'] });
    expect(takeClipsAdded('d4')).toEqual([]);
  });

  it('keeps a draft armed until its last editor disarms, each disarm counting once', () => {
    const a = expectClipsAdded('d5');
    const b = expectClipsAdded('d5');
    a();
    a();
    noteClipsAdded({ draftId: 'd5', segmentIds: ['x'] });
    expect(takeClipsAdded('d5')).toEqual(['x']);
    b();
    noteClipsAdded({ draftId: 'd5', segmentIds: ['y'] });
    expect(takeClipsAdded('d5')).toEqual([]);
  });

  it('keeps every id of a large addition, so its undo step is whole', () => {
    const disarm = expectClipsAdded('d6');
    const many = Array.from({ length: 501 }, (_, i) => `c${i}`);
    noteClipsAdded({ draftId: 'd6', segmentIds: many });
    noteClipsAdded({ draftId: 'd6', segmentIds: ['more'] });
    expect(takeClipsAdded('d6')).toEqual([...many, 'more']);
    disarm();
  });

  it('a listener that throws doesn’t stop the others', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const second = jest.fn();
    const stopA = onClipsAdded(() => {
      throw new Error('boom');
    });
    const stopB = onClipsAdded(second);
    noteClipsAdded({ draftId: 'd3', segmentIds: ['x'] });
    stopA();
    stopB();
    expect(second).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('leaves an armed editor one place to return to, taken once, the latest winning', () => {
    returnEditorTo('d7', { before: 'early' }); // no editor yet: dropped
    const disarm = expectClipsAdded('d7');
    expect(takeEditorReturn('d7')).toBeNull();
    returnEditorTo('d7', { before: 'a' });
    returnEditorTo('d7', END);
    noteClipsAdded({ draftId: 'd7', segmentIds: ['x'] });
    expect(takeEditorReturn('d7')).toEqual(END);
    expect(takeEditorReturn('d7')).toBeNull();
    expect(takeClipsAdded('d7')).toEqual(['x']); // the clips are kept apart
    returnEditorTo('d7', { before: 'b' });
    disarm();
    expect(takeEditorReturn('d7')).toBeNull(); // gone with the last editor
    const again = expectClipsAdded('d7');
    expect(takeEditorReturn('d7')).toBeNull();
    again();
  });
});
