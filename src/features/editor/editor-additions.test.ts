import { describe, expect, it, jest } from '@jest/globals';

import { anchorForPlayhead, type ClipAnchor } from '@/core/clip-anchor';
import { fromAnotherPulseAction } from '@/features/recorder/add-menu-actions';

import {
  batchWriting,
  editorAddActions,
  groupAdditions,
  type ImageBatch,
} from './editor-additions';

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
  const anchorNow = () => anchorForPlayhead(ids, [0, 1000, 3000], 4000, playhead);

  it('Photo adds at the playhead’s boundary as tapped, wherever it moves meanwhile', () => {
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
    playhead = 1200; // in b's first half: before b
    actions.find((a) => a.key === 'images')!.onPress();
    expect(pause).toHaveBeenCalled();
    // Scrubbed (or played) to c while the first image converts.
    playhead = 3200;
    expect(readLater!()).toEqual({ before: 'b', next: 'c' });
  });

  it('offers Record, Screen and Other Pulse only when they can run', () => {
    const base = { anchorNow, pause: () => {}, importVideo: () => {}, importImages: () => {} };
    expect(editorAddActions(base).map((a) => a.key)).toEqual(['import', 'images']);
    const record = jest.fn();
    const all = editorAddActions({
      ...base,
      record,
      recordScreen: () => {},
      fromAnotherPulse: fromAnotherPulseAction(() => {}),
    });
    expect(all.map((a) => a.key)).toEqual(['record', 'screen', 'import', 'images', 'another']);
    playhead = 0;
    all[0].onPress();
    expect(record).toHaveBeenCalledWith({ before: 'a', next: 'b' });
  });
});
