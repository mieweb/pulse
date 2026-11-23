import { describe, expect, it } from '@jest/globals';

import { END, type ClipsAdded } from '@/core/clip-anchor';
import {
  anchorAtBoundary,
  boundaryOf,
  boundaryX,
  cursorA11yValue,
  cursorAfterAdd,
  cursorAfterRemoval,
  cursorAfterReorder,
  cursorBeforeDelete,
  edgeScrollSpeed,
  EDGE_ZONE,
  insertChipText,
  insertPlace,
  MAX_SCROLL_SPEED,
  nearestBoundary,
  normalizeCursor,
  onClip,
  orderShown,
  resolvePinned,
  scrollToShow,
  stepBoundary,
  timeAtBoundary,
  type StripGeometry,
} from './insert-point';

const ids = ['a', 'b', 'c'];
// 48 pt tiles 8 pt apart after a 13 pt inset: boundaries at 9, 65, 121, 177.
const g: StripGeometry = { pad: 13, tileWidth: 48, gap: 8, tileTop: 22, tileHeight: 64 };
const added = (over: Partial<ClipsAdded>): ClipsAdded => ({
  draftId: 'd',
  segmentIds: ['x'],
  anchor: END,
  ...over,
});

describe('boundaries and anchors', () => {
  it('reads an anchor as a boundary, a missing clip as the end', () => {
    expect(boundaryOf({ before: 'a' }, ids)).toBe(0);
    expect(boundaryOf({ before: 'c' }, ids)).toBe(2);
    expect(boundaryOf({ after: 'a' }, ids)).toBe(1);
    expect(boundaryOf({ after: 'c' }, ids)).toBe(3);
    expect(boundaryOf(END, ids)).toBe(3);
    expect(boundaryOf({ before: 'gone' }, ids)).toBe(3);
    expect(boundaryOf({ after: 'gone' }, ids)).toBe(3);
  });

  it('writes a boundary in the before form, the end after the last clip', () => {
    expect([0, 1, 2, 3].map((k) => anchorAtBoundary(k, ids))).toEqual([
      { before: 'a' },
      { before: 'b' },
      { before: 'c' },
      END,
    ]);
    expect(anchorAtBoundary(0, [])).toEqual(END);
  });

  it('steps one boundary at a time (VoiceOver adjust), held to the strip', () => {
    expect(stepBoundary(1, 1, 3)).toBe(2);
    expect(stepBoundary(1, -1, 3)).toBe(0);
    expect(stepBoundary(0, -1, 3)).toBe(0);
    expect(stepBoundary(3, 1, 3)).toBe(3);
  });
});

describe('geometry', () => {
  it('puts each boundary in the middle of its gap', () => {
    expect([0, 1, 2, 3].map((k) => boundaryX(k, g))).toEqual([9, 65, 121, 177]);
  });

  it('snaps an x to the nearest boundary, never past either end', () => {
    expect(nearestBoundary(0, 3, g)).toBe(0);
    expect(nearestBoundary(36, 3, g)).toBe(0); // first half of clip a
    expect(nearestBoundary(38, 3, g)).toBe(1); // its second half
    expect(nearestBoundary(65, 3, g)).toBe(1);
    expect(nearestBoundary(150, 3, g)).toBe(3);
    expect(nearestBoundary(1000, 3, g)).toBe(3);
    expect(nearestBoundary(-50, 3, g)).toBe(0);
  });

  it('tells a touch on a clip from one in a gap or a lane', () => {
    expect(onClip(30, 50, 3, g)).toBe(true); // clip a
    expect(onClip(65, 50, 3, g)).toBe(false); // the gap between a and b
    expect(onClip(30, 10, 3, g)).toBe(false); // the lane above a
    expect(onClip(30, 90, 3, g)).toBe(false); // the lane below a
    expect(onClip(5, 50, 3, g)).toBe(false); // the inset before a
    expect(onClip(190, 50, 3, g)).toBe(false); // past the last clip
  });

  it('scrolls new clips into view by as little as it can', () => {
    // A 200-wide view of 600 of content, at 0.
    expect(scrollToShow(0, 200, 600, 50, 150)).toBeNull();
    expect(scrollToShow(0, 200, 600, 300, 380)).toBe(180);
    expect(scrollToShow(300, 200, 600, 100, 150)).toBe(100);
    // Held to the content.
    expect(scrollToShow(0, 200, 600, 500, 700)).toBe(400);
    expect(scrollToShow(100, 200, 600, -20, 40)).toBe(0);
  });

  it('scrolls the strip only while the dragged cursor is near an edge, faster deeper in', () => {
    const vw = 300;
    const pad = 14;
    expect(edgeScrollSpeed(150, vw, pad)).toBe(0);
    expect(edgeScrollSpeed(pad + EDGE_ZONE + 1, vw, pad)).toBe(0);
    expect(edgeScrollSpeed(pad, vw, pad)).toBe(-MAX_SCROLL_SPEED);
    expect(edgeScrollSpeed(-40, vw, pad)).toBe(-MAX_SCROLL_SPEED);
    expect(edgeScrollSpeed(vw, vw, pad)).toBe(MAX_SCROLL_SPEED);
    expect(edgeScrollSpeed(vw - pad - EDGE_ZONE / 2, vw, pad)).toBeCloseTo(MAX_SCROLL_SPEED / 2);
  });
});

describe('copy', () => {
  const clips = [
    { label: '1', durationMs: 3200 },
    { label: '7', durationMs: 1000 },
    { label: null, durationMs: 500 },
  ];

  it('names places by the clips’ labels, or their place when unlabelled', () => {
    expect(insertPlace(0, clips)).toBe('before clip 1');
    expect(insertPlace(1, clips)).toBe('between clips 1 and 7');
    expect(insertPlace(2, clips)).toBe('between clips 7 and 3');
    expect(insertPlace(3, clips)).toBe('at the end');
  });

  it('counts the recorded time before the cursor', () => {
    expect(timeAtBoundary(0, clips)).toBe(0);
    expect(timeAtBoundary(2, clips)).toBe(4200);
    expect(timeAtBoundary(9, clips)).toBe(4700);
  });

  it('writes the chip, and none at the end', () => {
    expect(insertChipText(1, clips)).toBe('Adding at 0:03 · between clips 1 and 7');
    expect(insertChipText(0, clips)).toBe('Adding at 0:00 · before clip 1');
    expect(insertChipText(3, clips)).toBeNull();
  });

  it('gives VoiceOver the place and the time', () => {
    expect(cursorA11yValue(1, clips)).toBe('between clips 1 and 7, at 0:03');
    expect(cursorA11yValue(3, clips)).toBe('at the end');
  });
});

describe('following the draft', () => {
  it('a before cursor stays put as clips land at it', () => {
    const cursor = { before: 'b' };
    expect(cursorAfterAdd(cursor, added({ anchor: cursor, prevId: 'a', nextId: 'b' }))).toBe(
      cursor,
    );
    expect(cursorAfterAdd(END, added({ prevId: 'c', nextId: null }))).toBe(END);
  });

  it('an after cursor moves past clips that land right after its clip, by either anchor', () => {
    const cursor = { after: 'a' };
    // Added as after:a, or as before:b (the same slot).
    expect(cursorAfterAdd(cursor, added({ anchor: cursor, prevId: 'a', nextId: 'b' }))).toEqual({
      before: 'b',
    });
    expect(
      cursorAfterAdd(cursor, added({ anchor: { before: 'b' }, prevId: 'a', nextId: 'b' })),
    ).toEqual({ before: 'b' });
    // After the last clip: the end.
    expect(cursorAfterAdd({ after: 'c' }, added({ prevId: 'c', nextId: null }))).toEqual(END);
    // Somewhere else: stays.
    expect(cursorAfterAdd(cursor, added({ prevId: 'b', nextId: 'c' }))).toBe(cursor);
  });

  it('without neighbours, an after cursor follows only the same anchor', () => {
    const cursor = { after: 'a' };
    expect(cursorAfterAdd(cursor, added({ anchor: cursor, segmentIds: ['x', 'y'] }))).toEqual({
      after: 'y',
    });
    expect(cursorAfterAdd(cursor, added({ anchor: { before: 'b' } }))).toBe(cursor);
  });

  it('keeps its place when its clip is deleted (a retake, or a delete in the editor)', () => {
    expect(cursorAfterRemoval({ before: 'b' }, ids, ['a', 'c'])).toEqual({ before: 'c' });
    expect(cursorAfterRemoval({ before: 'c' }, ids, ['a', 'b'])).toEqual(END);
    expect(cursorAfterRemoval({ after: 'a' }, ids, ['b', 'c'])).toEqual({ before: 'b' });
    expect(cursorAfterRemoval({ before: 'a' }, ids, ['c'])).toEqual({ before: 'c' });
  });

  it('a delete of another clip, or a clip it never saw, leaves it alone', () => {
    const cursor = { before: 'b' };
    expect(cursorAfterRemoval(cursor, ids, ['b', 'c'])).toBe(cursor);
    // The list not loaded yet: nothing to go on.
    expect(cursorAfterRemoval(cursor, [], [])).toBe(cursor);
    expect(cursorAfterRemoval(END, ids, [])).toBe(END);
  });

  it('turns an after cursor into the before form once its clip is known', () => {
    expect(normalizeCursor({ after: 'a' }, ids)).toEqual({ before: 'b' });
    expect(normalizeCursor({ after: 'c' }, ids)).toEqual(END);
    expect(normalizeCursor({ after: 'unknown' }, ids)).toEqual({ after: 'unknown' });
    expect(normalizeCursor({ before: 'b' }, ids)).toEqual({ before: 'b' });
  });

  it('keeps its boundary across a reorder', () => {
    expect(cursorAfterReorder({ before: 'b' }, ids, ['c', 'a', 'b'])).toEqual({ before: 'a' });
    expect(cursorAfterReorder(END, ids, ['c', 'a', 'b'])).toEqual(END);
  });

  it('moves off a clip the trash is about to delete (the retake, the cursor’s own clip)', () => {
    // a b c, cursor before c; b (the take before it) trashed: it stays before c.
    expect(cursorBeforeDelete({ before: 'c' }, ids, 'b')).toEqual({ before: 'c' });
    // Its own clip trashed: before the next.
    expect(cursorBeforeDelete({ before: 'b' }, ids, 'b')).toEqual({ before: 'c' });
    expect(cursorBeforeDelete({ before: 'c' }, ids, 'c')).toEqual(END);
    expect(cursorBeforeDelete(END, ids, 'c')).toBe(END);
  });
});

describe('the order on screen after a drop', () => {
  const stored = ['a', 'b', 'c'];
  const base = { clips: 'v1' };

  it('goes by the dropped order until the draft’s clips change', () => {
    const pending = { base, ids: ['c', 'a', 'b'] };
    expect(orderShown(base, stored, pending)).toEqual(['c', 'a', 'b']);
    // The live query caught up (a new list, in the dropped order or not): the draft's.
    expect(orderShown({ clips: 'v2' }, ['c', 'a', 'b'], pending)).toEqual(['c', 'a', 'b']);
    expect(orderShown({ clips: 'v2' }, ['a', 'c', 'b'], pending)).toEqual(['a', 'c', 'b']);
    expect(orderShown(base, stored, null)).toBe(stored);
  });

  it('a cursor kept across a reorder is drawn at its boundary in the order on screen', () => {
    const dropped = ['c', 'a', 'b'];
    const anchor = cursorAfterReorder({ before: 'b' }, stored, dropped); // was at boundary 1
    const shown = orderShown(base, stored, { base, ids: dropped });
    expect(boundaryOf(anchor, shown)).toBe(1);
    expect(
      insertChipText(
        boundaryOf(anchor, shown),
        shown.map((label) => ({ label, durationMs: 1000 })),
      ),
    ).toBe('Adding at 0:01 · between clips c and a');
    // Against the stored order, not caught up yet, it would be drawn a boundary off.
    expect(boundaryOf(anchor, stored)).toBe(0);
    // A tap maps against the order on screen too.
    expect(anchorAtBoundary(2, shown)).toEqual({ before: 'b' });
  });
});

describe('a screen take’s pinned spot', () => {
  const live = new Set(['a', 'c']); // b deleted while it converted
  const there = (id: string) => live.has(id);
  const first = () => 'a';

  it('keeps its anchor while its clip is there, and for older rows', () => {
    expect(resolvePinned({ before: 'a' }, null, there, first)).toEqual({ before: 'a' });
    expect(resolvePinned({ before: 'b' }, undefined, there, first)).toEqual({ before: 'b' });
    expect(resolvePinned(END, 'x', there, first)).toBe(END);
    expect(resolvePinned({ after: 'b' }, 'a', there, first)).toEqual({ after: 'b' });
  });

  it('goes after the clip before it when its clip has gone, or at the start', () => {
    expect(resolvePinned({ before: 'b' }, 'a', there, first)).toEqual({ after: 'a' });
    expect(resolvePinned({ before: 'b' }, null, there, first)).toEqual({ before: 'a' });
    expect(resolvePinned({ before: 'b' }, null, there, () => null)).toEqual(END);
    expect(resolvePinned({ before: 'b' }, 'gone', there, first)).toEqual(END);
  });
});
