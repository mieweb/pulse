import { describe, expect, it, jest } from '@jest/globals';

import {
  anchorForPlayhead,
  anchorFromRouteParam,
  anchorToRouteParam,
  END,
  expectClipsAdded,
  isEnd,
  noteClipsAdded,
  onClipsAdded,
  playheadSlot,
  sameAnchor,
  takeClipsAdded,
  type ClipAnchor,
} from './clip-anchor';

describe('route params', () => {
  it.each<ClipAnchor>([{ before: 'd1-170' }, { after: 'abc_DEF-9' }, { at: 'end' }])(
    'round-trips %j',
    (anchor) => {
      expect(anchorFromRouteParam(anchorToRouteParam(anchor))).toEqual(anchor);
    },
  );

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['an empty string', ''],
    ['an array (a repeated param)', ['before:a', 'after:b']],
    ['an unknown side', 'inside:a'],
    ['no id', 'before:'],
    ['an id with a path in it', 'after:../x'],
    ['an id with a colon', 'before:a:b'],
    ['an id too long', `after:${'a'.repeat(129)}`],
    ['plain "end"', 'end'],
  ])('reads %s as the end', (_name, param) => {
    expect(anchorFromRouteParam(param)).toEqual(END);
  });
});

describe('anchorForPlayhead', () => {
  // Three clips: a 0–1000, b 1000–3000, c 3000–4000.
  const ids = ['a', 'b', 'c'];
  const starts = [0, 1000, 3000];
  const at = (t: number) => anchorForPlayhead(ids, starts, 4000, t);

  it.each<[number, ClipAnchor]>([
    [0, { before: 'a' }],
    [499, { before: 'a' }],
    [500, { after: 'a' }], // the midpoint is the second half
    [999, { after: 'a' }],
    [1000, { before: 'b' }], // on a boundary: before the next clip
    [1999, { before: 'b' }],
    [2000, { after: 'b' }],
    [3000, { before: 'c' }],
    [3400, { before: 'c' }],
    [3500, END], // after the last clip is the end
    [4000, END],
    [9000, END],
    [-5, { before: 'a' }],
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

describe('sameAnchor / isEnd', () => {
  it('compares by side and id', () => {
    expect(sameAnchor({ before: 'a' }, { before: 'a' })).toBe(true);
    expect(sameAnchor({ before: 'a' }, { after: 'a' })).toBe(false);
    expect(sameAnchor({ after: 'a' }, { after: 'b' })).toBe(false);
    expect(sameAnchor(END, { at: 'end' })).toBe(true);
    expect(sameAnchor(END, { after: 'a' })).toBe(false);
    expect(isEnd(END)).toBe(true);
    expect(isEnd({ before: 'a' })).toBe(false);
  });
});

describe('clips added', () => {
  it('tells listeners, and keeps an armed draft’s ids until taken', () => {
    const listener = jest.fn();
    const stop = onClipsAdded(listener);
    const disarm1 = expectClipsAdded('d1');
    const disarm2 = expectClipsAdded('d2');
    noteClipsAdded({ draftId: 'd1', segmentIds: ['x'], anchor: { before: 'a' } });
    noteClipsAdded({ draftId: 'd2', segmentIds: ['y'], anchor: END });
    noteClipsAdded({ draftId: 'd1', segmentIds: ['z', 'w'], anchor: { after: 'x' } });
    stop();
    noteClipsAdded({ draftId: 'd1', segmentIds: ['v'], anchor: END });

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenNthCalledWith(1, {
      draftId: 'd1',
      segmentIds: ['x'],
      anchor: { before: 'a' },
    });
    expect(takeClipsAdded('d1')).toEqual(['x', 'z', 'w', 'v']);
    expect(takeClipsAdded('d1')).toEqual([]);
    expect(takeClipsAdded('d2')).toEqual(['y']);
    disarm1();
    disarm2();
  });

  it('keeps nothing for a draft no editor armed, or from before it was armed', () => {
    noteClipsAdded({ draftId: 'd4', segmentIds: ['early'], anchor: END });
    expect(takeClipsAdded('d4')).toEqual([]);
    const disarm = expectClipsAdded('d4');
    expect(takeClipsAdded('d4')).toEqual([]);
    noteClipsAdded({ draftId: 'd4', segmentIds: ['x'], anchor: END });
    disarm();
    noteClipsAdded({ draftId: 'd4', segmentIds: ['late'], anchor: END });
    expect(takeClipsAdded('d4')).toEqual([]);
  });

  it('keeps a draft armed until its last editor disarms, each disarm counting once', () => {
    const a = expectClipsAdded('d5');
    const b = expectClipsAdded('d5');
    a();
    a();
    noteClipsAdded({ draftId: 'd5', segmentIds: ['x'], anchor: END });
    expect(takeClipsAdded('d5')).toEqual(['x']);
    b();
    noteClipsAdded({ draftId: 'd5', segmentIds: ['y'], anchor: END });
    expect(takeClipsAdded('d5')).toEqual([]);
  });

  it('keeps at most the newest 500 ids per draft', () => {
    const disarm = expectClipsAdded('d6');
    const many = Array.from({ length: 600 }, (_, i) => `c${i}`);
    noteClipsAdded({ draftId: 'd6', segmentIds: many, anchor: END });
    expect(takeClipsAdded('d6')).toEqual(many.slice(100));
    disarm();
  });

  it('a listener that throws doesn’t stop the others', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const second = jest.fn();
    const stopA = onClipsAdded(() => {
      throw new Error('boom');
    });
    const stopB = onClipsAdded(second);
    noteClipsAdded({ draftId: 'd3', segmentIds: ['x'], anchor: END });
    stopA();
    stopB();
    expect(second).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
