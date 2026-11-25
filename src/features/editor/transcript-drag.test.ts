import { describe, expect, it } from '@jest/globals';

import {
  transcriptDragSelection,
  transcriptWordAtPoint,
  type TranscriptWordBox,
} from './transcript-drag';

const box = (index: number, x: number, y: number, width = 50): TranscriptWordBox => ({
  id: `word-${index}`,
  index,
  x,
  y,
  width,
  height: 44,
});
const wrapped = [
  box(0, 0, 0),
  box(1, 56, 0),
  box(2, 112, 0),
  box(3, 0, 50),
  box(4, 56, 50),
  box(5, 112, 50),
  // A beat heading separates this row from the previous paragraph.
  box(6, 0, 150),
  box(7, 56, 150),
];
const ids = wrapped.map((word) => word.id);
const chosen = (...indices: number[]) => new Set(indices.map((index) => ids[index]));

describe('transcript drag hit testing', () => {
  it('starts on an actual word rather than capturing a scroll begun in whitespace', () => {
    expect(transcriptWordAtPoint(wrapped, { x: 60, y: 20 })?.index).toBe(1);
    expect(transcriptWordAtPoint(wrapped, { x: 53, y: 20 })).toBeNull();
    expect(transcriptWordAtPoint(wrapped, { x: 60, y: 120 })).toBeNull();
    expect(transcriptWordAtPoint(wrapped, { x: 200, y: 20 })).toBeNull();
  });

  it('supports modest target slop but prefers the actual word over its neighbour', () => {
    expect(transcriptWordAtPoint(wrapped, { x: -3, y: 20 }, { slop: 4 })?.index).toBe(0);
    expect(transcriptWordAtPoint(wrapped, { x: -5, y: 20 }, { slop: 4 })).toBeNull();
    expect(transcriptWordAtPoint(wrapped, { x: 57, y: 20 }, { slop: 8 })?.index).toBe(1);
  });

  it('follows reading order between wrapped lines rather than just the vertical column', () => {
    const end = transcriptWordAtPoint(wrapped, { x: 65, y: 65 }, { nearest: true });
    expect(end?.index).toBe(4);
    expect(transcriptDragSelection(ids, chosen(), 1, end!.index)).toEqual(chosen(1, 2, 3, 4));
  });

  it('extends through end-of-line whitespace to the last word on that line', () => {
    expect(transcriptWordAtPoint(wrapped, { x: 300, y: 20 }, { nearest: true })?.index).toBe(2);
    expect(transcriptWordAtPoint(wrapped, { x: -30, y: 65 }, { nearest: true })?.index).toBe(3);
    expect(transcriptWordAtPoint(wrapped, { x: 110, y: 65 }, { nearest: true })?.index).toBe(5);
  });

  it('crosses a line gap by its vertical midpoint, including a short neighbouring line', () => {
    const lines = [box(0, 0, 0, 300), box(1, 0, 60, 30)];
    expect(transcriptWordAtPoint(lines, { x: 280, y: 50 }, { nearest: true })?.index).toBe(0);
    expect(transcriptWordAtPoint(lines, { x: 280, y: 54 }, { nearest: true })?.index).toBe(1);
  });

  it('crosses beat headings and clamps moves beyond the transcript to its first/last line', () => {
    expect(transcriptWordAtPoint(wrapped, { x: 0, y: 110 }, { nearest: true })?.index).toBe(3);
    expect(transcriptWordAtPoint(wrapped, { x: 0, y: 130 }, { nearest: true })?.index).toBe(6);
    expect(transcriptWordAtPoint(wrapped, { x: 0, y: -100 }, { nearest: true })?.index).toBe(0);
    expect(transcriptWordAtPoint(wrapped, { x: 300, y: 500 }, { nearest: true })?.index).toBe(7);
  });

  it('uses visual RTL coordinates while selecting a logical reading-order passage', () => {
    const rtl = [box(0, 112, 0), box(1, 56, 0), box(2, 0, 0), box(3, 112, 50), box(4, 56, 50)];
    const end = transcriptWordAtPoint(rtl, { x: 70, y: 65 }, { nearest: true });
    expect(end?.index).toBe(4);
    expect(transcriptDragSelection(ids, chosen(), 1, end!.index)).toEqual(chosen(1, 2, 3, 4));
    expect(transcriptWordAtPoint(rtl, { x: -20, y: 20 }, { nearest: true })?.index).toBe(2);
    expect(transcriptWordAtPoint(rtl, { x: 300, y: 20 }, { nearest: true })?.index).toBe(0);
  });

  it('ignores incomplete/invalid layouts and nonfinite touch coordinates', () => {
    const boxes = [box(0, 0, 0), { ...box(1, 56, 0), width: 0 }, { ...box(2, 112, 0), y: NaN }];
    expect(transcriptWordAtPoint(boxes, { x: 100, y: 20 }, { nearest: true })?.index).toBe(0);
    expect(transcriptWordAtPoint([], { x: 0, y: 0 }, { nearest: true })).toBeNull();
    expect(transcriptWordAtPoint(wrapped, { x: NaN, y: 0 }, { nearest: true })).toBeNull();
  });
});

describe('transcript drag selection', () => {
  it('selects the inclusive forward/reverse span and preserves selections outside it', () => {
    const baseline = chosen(0, 7);
    expect(transcriptDragSelection(ids, baseline, 2, 5)).toEqual(chosen(0, 2, 3, 4, 5, 7));
    expect(transcriptDragSelection(ids, baseline, 5, 2)).toEqual(chosen(0, 2, 3, 4, 5, 7));
    expect(baseline).toEqual(chosen(0, 7));
  });

  it('starting on a selected word deselects the entire span without toggling mixed words', () => {
    const baseline = chosen(0, 1, 3, 4, 7);
    expect(transcriptDragSelection(ids, baseline, 1, 4)).toEqual(chosen(0, 7));
    expect(transcriptDragSelection(ids, baseline, 4, 1)).toEqual(chosen(0, 7));
    expect(baseline).toEqual(chosen(0, 1, 3, 4, 7));
  });

  it('shrinking and reversing a selection restores the frozen baseline outside its new span', () => {
    const baseline = chosen(0, 4, 7);
    expect(transcriptDragSelection(ids, baseline, 2, 6)).toEqual(chosen(0, 2, 3, 4, 5, 6, 7));
    expect(transcriptDragSelection(ids, baseline, 2, 3)).toEqual(chosen(0, 2, 3, 4, 7));
    expect(transcriptDragSelection(ids, baseline, 2, 1)).toEqual(chosen(0, 1, 2, 4, 7));
  });

  it('shrinking a deselection restores words left behind and can reverse past its anchor', () => {
    const baseline = chosen(0, 1, 2, 3, 4, 5, 6, 7);
    expect(transcriptDragSelection(ids, baseline, 3, 6)).toEqual(chosen(0, 1, 2, 7));
    expect(transcriptDragSelection(ids, baseline, 3, 4)).toEqual(chosen(0, 1, 2, 5, 6, 7));
    expect(transcriptDragSelection(ids, baseline, 3, 1)).toEqual(chosen(0, 4, 5, 6, 7));
  });

  it('supports a one-word span and refuses stale/out-of-bounds indices without changing baseline', () => {
    expect(transcriptDragSelection(ids, chosen(7), 2, 2)).toEqual(chosen(2, 7));
    expect(transcriptDragSelection(ids, chosen(2, 7), 2, 2)).toEqual(chosen(7));
    for (const [anchor, end] of [
      [-1, 2],
      [2, 99],
      [NaN, 2],
      [2, 1.5],
    ]) {
      expect(transcriptDragSelection(ids, chosen(7), anchor, end)).toEqual(chosen(7));
    }
    expect(transcriptDragSelection([], chosen(7), 0, 0)).toEqual(chosen(7));
  });
});
