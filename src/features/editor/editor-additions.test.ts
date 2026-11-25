import { describe, expect, it, jest } from '@jest/globals';

import { type ClipAnchor, END } from '@/core/clip-anchor';

import {
  batchWriting,
  editorAddAnchor,
  editorAddActions,
  groupAdditions,
  type ImageBatch,
  playheadGoal,
  playheadGoalMs,
} from './editor-additions';

describe('editorAddAnchor', () => {
  const clips = [
    { id: 'a', sourceKey: 'a-key', edit: { startMs: 1000, endMs: 3000, speed: 2 } },
    { id: 'b', sourceKey: 'b-key', edit: { startMs: 0, endMs: 2000, speed: 1 } },
    { id: 'c', sourceKey: 'c-key', edit: { startMs: 0, endMs: 1000, speed: 1 } },
  ];
  const layout = { starts: [0, 1000, 3000], totalMs: 4000 };

  it.each<[number, ClipAnchor]>([
    [250, { before: 'a', next: 'b' }],
    [499.999, { before: 'a', next: 'b' }],
    [500, { before: 'b', next: 'c' }],
    [750, { before: 'b', next: 'c' }],
    [1000, { before: 'b', next: 'c' }],
    [1999, { before: 'b', next: 'c' }],
    [2000, { before: 'c' }],
    [3500, END],
    [4000, END],
  ])('keeps beats whole in Clips view at %s ms, putting midpoint ties after', (ms, expected) => {
    const fresh = jest.fn(() => 'right');
    expect(editorAddAnchor('clips', clips, layout, ms, fresh)).toEqual(expected);
    expect(fresh).not.toHaveBeenCalled();
  });

  it('splits at the exact source point in Timeline view at the same midpoint', () => {
    expect(editorAddAnchor('timeline', clips, layout, 500, () => 'right')).toEqual({
      before: 'a',
      next: 'b',
      split: { sourceMs: 2000, sourceKey: 'a-key', rightId: 'right', offsetMs: 500 },
    });
  });
});

describe('groupAdditions', () => {
  it('makes each addition one step, the playhead after its last clip', () => {
    expect(groupAdditions(null, ['x', 'y'], false)).toEqual({
      steps: [['x', 'y']],
      batch: null,
      placeAfter: 'y',
    });
    expect(groupAdditions(null, [], false)).toEqual({ steps: [], batch: null, placeAfter: null });
  });

  it('a screen take landing mid-batch is its own step, before the batch’s', () => {
    let batch: ImageBatch | null = batchWriting(null, 'i1');
    // i1 lands: kept in the batch, nothing recorded yet.
    let r = groupAdditions(batch, ['i1'], true);
    expect(r.steps).toEqual([]);
    batch = batchWriting(r.batch, 'i2');
    // The screen take lands while i2 is being made: a step of its own, now.
    r = groupAdditions(batch, ['s'], true);
    expect(r).toMatchObject({ steps: [['s']], placeAfter: 's' });
    // i2 lands and the batch is over: its step, the playhead after its last clip.
    r = groupAdditions(r.batch, ['i2'], false);
    expect(r).toEqual({ steps: [['i1', 'i2']], batch: null, placeAfter: 'i2' });
  });

  it('a batch that ended while the editor was covered is recorded once, on its return', () => {
    // Nothing was taken while covered: all of it comes in at once, the batch over.
    const batch = batchWriting(batchWriting(null, 'i1'), 'i2');
    const back = groupAdditions(batch, ['i1', 's', 'i2'], false);
    expect(back).toEqual({ steps: [['s'], ['i1', 'i2']], batch: null, placeAfter: 'i2' });
    // The next take (another focus, the batch's end heard too) records nothing again.
    expect(groupAdditions(back.batch, [], false).steps).toEqual([]);
  });

  it('a batch whose only image failed records nothing', () => {
    // Its id was told as it was about to be written, but its row never went in.
    const batch = batchWriting(null, 'i1');
    expect(groupAdditions(batch, [], false)).toEqual({
      steps: [],
      batch: null,
      placeAfter: null,
    });
  });
});

describe('editorAddActions', () => {
  // Clips a 0–1000, b 1000–3000, c 3000–4000; the playhead moves during a conversion.
  const ids = ['a', 'b', 'c'];
  let playhead = 0;
  const clips = ids.map((id, i) => ({
    id,
    edit: { startMs: 0, endMs: i === 1 ? 2000 : 1000, speed: 1 },
    sourceKey: `${id}.mp4`,
  }));
  const anchorNow = () =>
    editorAddAnchor(
      'timeline',
      clips,
      { starts: [0, 1000, 3000], totalMs: 4000 },
      playhead,
      () => 'right',
    );

  it('Photo freezes the exact source cut as tapped, wherever the playhead moves meanwhile', () => {
    let readLater: (() => ClipAnchor) | null = null;
    const pause = jest.fn();
    const actions = editorAddActions({
      anchorNow,
      pause,
      importVideo: () => {},
      // As the editor passes it on: read as each image's row is written.
      importImages: (anchor) => {
        readLater = () => anchor;
      },
    });
    playhead = 1200; // 200 source ms inside b
    actions.find((a) => a.key === 'images')!.onPress();
    expect(pause).toHaveBeenCalled();
    // Scrubbed (or played) to c while the first image converts.
    playhead = 3200;
    expect(readLater!()).toEqual({
      before: 'b',
      next: 'c',
      split: { sourceMs: 200, sourceKey: 'b.mp4', rightId: 'right', offsetMs: 200 },
    });
  });

  it('offers Record, Screen and Other Pulse only when they can run', () => {
    const base = { anchorNow, pause: () => {}, importVideo: () => {}, importImages: () => {} };
    expect(editorAddActions(base).map((a) => a.key)).toEqual(['import', 'images']);
    const record = jest.fn();
    const all = editorAddActions({
      ...base,
      record,
      recordScreen: () => {},
      fromAnotherPulse: () => {},
    });
    expect(all.map((a) => a.key)).toEqual(['record', 'screen', 'import', 'images', 'another']);
    playhead = 0;
    all[0].onPress();
    expect(record).toHaveBeenCalledWith({ before: 'a', next: 'b' });
  });

  it('appends every media type when the playhead is at the end', () => {
    const add = jest.fn();
    const actions = editorAddActions({
      anchorNow,
      pause: () => {},
      record: add,
      recordScreen: add,
      importVideo: add,
      importImages: add,
      fromAnotherPulse: add,
    });
    playhead = 4000;
    for (const action of actions) action.onPress();
    expect(add).toHaveBeenCalledTimes(5);
    expect(add.mock.calls.every(([anchor]) => anchor === END)).toBe(true);
  });
});

describe('playheadGoal', () => {
  // Clips a 0–1000, b 1000–3000, c 3000–4000.
  const ids = ['a', 'b', 'c'];
  const starts = [0, 1000, 3000];
  const ms = (goal: ReturnType<typeof playheadGoal>) =>
    goal && playheadGoalMs(goal, ids, starts, 4000);

  it('after the clips added, as before, when the recorder came back by ✕ or back', () => {
    expect(playheadGoal(null, 'b')).toEqual({ after: 'b' });
    expect(ms(playheadGoal(null, 'a'))).toBe(1000);
    expect(ms(playheadGoal(null, 'c'))).toBe(4000);
    expect(playheadGoal(null, null)).toBeNull();
  });

  it('at the recorder’s cursor when it came back on its Edit, over the clips added', () => {
    // Clip b recorded before c, then the cursor moved to the start before Edit.
    expect(playheadGoal({ before: 'a', next: 'b' }, 'b')).toEqual({
      at: { before: 'a', next: 'b' },
    });
    expect(ms(playheadGoal({ before: 'a', next: 'b' }, 'b'))).toBe(0);
    expect(ms(playheadGoal({ before: 'c' }, null))).toBe(3000);
    expect(ms(playheadGoal(END, 'a'))).toBe(4000);
  });

  it('waits for a clip added that the list doesn’t have yet; a place never waits', () => {
    expect(playheadGoalMs({ after: 'new' }, ids, starts, 4000)).toBeNull();
    expect(playheadGoalMs({ at: { before: 'gone', next: 'b' } }, ids, starts, 4000)).toBe(1000);
  });
});
