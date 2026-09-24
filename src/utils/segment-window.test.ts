import { describe, expect, it } from '@jest/globals';

import type { Segment } from '@/db/schema';
import {
  canonicalEdit,
  clipRender,
  editTimelineMs,
  effFile,
  effMs,
  indexAtGlobalMs,
  segmentOffsets,
  segmentSignature,
} from './segment-window';

// Minimal Segment factory — only the fields the timeline math reads.
const seg = (over: Partial<Segment>): Segment =>
  ({
    id: 'x',
    originalFilename: 'orig.mp4',
    editedFilename: null,
    durationMs: 1000,
    editedDurationMs: null,
    editState: null,
    ...over,
  }) as Segment;

// An RNVT editState (undo/redo included, as the editor saves it).
const edit = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    startMs: 200,
    endMs: 800,
    rotation: 0,
    flipped: false,
    crop: null,
    muted: false,
    speed: 1,
    undo: [],
    redo: [],
    ...over,
  });

describe('clipRender', () => {
  it('plays an unedited clip whole', () => {
    expect(clipRender(seg({}))).toMatchObject({ file: 'orig.mp4', inMs: 0, outMs: 1000, speed: 1 });
  });

  it('plays an edited clip as the original through its saved settings', () => {
    const r = clipRender(
      seg({
        editState: edit({
          rotation: 1,
          flipped: true,
          muted: true,
          speed: 2,
          crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 },
        }),
      }),
    );
    expect(r).toEqual({
      file: 'orig.mp4',
      inMs: 200,
      outMs: 800,
      speed: 2,
      muted: true,
      rotation: 1,
      flipped: true,
      crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 },
    });
  });

  it('plays a legacy baked edit whole, ignoring any settings', () => {
    const r = clipRender(
      seg({ editedFilename: 'edit.mp4', editedDurationMs: 400, editState: edit() }),
    );
    expect(r).toMatchObject({ file: 'edit.mp4', inMs: 0, outMs: 400, speed: 1, rotation: 0 });
  });

  it('treats an unusable editState as unedited and clamps the window to the source', () => {
    expect(clipRender(seg({ editState: 'not json' }))).toMatchObject({ inMs: 0, outMs: 1000 });
    expect(clipRender(seg({ editState: edit({ speed: 9 }) }))).toMatchObject({
      inMs: 0,
      outMs: 1000,
    });
    expect(clipRender(seg({ durationMs: 500, editState: edit() }))).toMatchObject({
      inMs: 200,
      outMs: 500,
    });
  });
});

describe('effMs with edits', () => {
  it('is the trimmed window at the saved speed', () => {
    expect(effMs(seg({ editState: edit() }))).toBe(600);
    expect(effMs(seg({ editState: edit({ speed: 2 }) }))).toBe(300);
    expect(editTimelineMs(edit({ speed: 1.25 }))).toBe(480);
  });
});

describe('effFile / effMs', () => {
  it('uses the edited file and duration when present, else the original', () => {
    expect(effFile(seg({ editedFilename: 'edit.mp4' }))).toBe('edit.mp4');
    expect(effFile(seg({ editedFilename: null }))).toBe('orig.mp4');
    expect(
      effMs(seg({ editedFilename: 'edit.mp4', durationMs: 1000, editedDurationMs: 400 })),
    ).toBe(400);
    expect(effMs(seg({ durationMs: 1000, editedDurationMs: null }))).toBe(1000);
  });

  it('never reports a negative contribution', () => {
    expect(effMs(seg({ durationMs: -50, editedDurationMs: null }))).toBe(0);
  });
});

describe('segmentOffsets', () => {
  it('produces prefix sums of effective durations', () => {
    const segs = [seg({ durationMs: 1000 }), seg({ durationMs: 500 }), seg({ durationMs: 2000 })];
    expect(segmentOffsets(segs)).toEqual([0, 1000, 1500]);
  });
});

describe('segmentSignature', () => {
  it('changes when a segment gains an edit or when a re-edit lands at a new revision path', () => {
    const pristine = [seg({ id: 'a' }), seg({ id: 'b' })];
    const edited = [seg({ id: 'a', editedFilename: 'a.edited.100.mp4' }), seg({ id: 'b' })];
    const reEdited = [seg({ id: 'a', editedFilename: 'a.edited.200.mp4' }), seg({ id: 'b' })];

    expect(segmentSignature(edited)).not.toBe(segmentSignature(pristine));
    // Every edit writes a distinct revision-stamped file, so replacing an existing edit must
    // also produce a new signature — this is what invalidates merge/transcript/preview caches.
    expect(segmentSignature(reEdited)).not.toBe(segmentSignature(edited));
  });

  it('is stable when nothing changed', () => {
    const a = [seg({ id: 'a', editedFilename: 'a.edited.100.mp4' })];
    const b = [seg({ id: 'a', editedFilename: 'a.edited.100.mp4' })];
    expect(segmentSignature(a)).toBe(segmentSignature(b));
  });
});

describe('segmentSignature with edits', () => {
  it('keeps the file-only key for unedited clips, so existing caches stay valid', () => {
    expect(segmentSignature([seg({ id: 'a' }), seg({ id: 'b', originalFilename: 'b.mp4' })])).toBe(
      'orig.mp4|b.mp4',
    );
  });

  it('changes with the edit but not with undo/redo history', () => {
    const base = segmentSignature([seg({ editState: edit() })]);
    expect(segmentSignature([seg({ editState: edit({ endMs: 700 }) })])).not.toBe(base);
    expect(segmentSignature([seg({ editState: edit({ undo: [{ startMs: 0 }] }) })])).toBe(base);
    expect(segmentSignature([seg({})])).not.toBe(base);
  });

  it('canonicalises an edit without its history', () => {
    const c = canonicalEdit(edit({ undo: [{ startMs: 0 }] }));
    expect(c && JSON.parse(c)).toEqual({
      v: 1,
      startMs: 200,
      endMs: 800,
      rotation: 0,
      flipped: false,
      crop: null,
      muted: false,
      speed: 1,
    });
    expect(canonicalEdit(null)).toBeNull();
  });
});

describe('indexAtGlobalMs', () => {
  const segs = [seg({ durationMs: 1000 }), seg({ durationMs: 500 }), seg({ durationMs: 2000 })];
  const offsets = segmentOffsets(segs); // [0, 1000, 1500]

  it('maps a global position to the containing clip', () => {
    expect(indexAtGlobalMs(segs, offsets, 0)).toBe(0);
    expect(indexAtGlobalMs(segs, offsets, 999)).toBe(0);
    expect(indexAtGlobalMs(segs, offsets, 1000)).toBe(1);
    expect(indexAtGlobalMs(segs, offsets, 1600)).toBe(2);
  });

  it('skips zero-length clips and never lands on them', () => {
    const withZero = [seg({ durationMs: 1000 }), seg({ durationMs: 0 }), seg({ durationMs: 2000 })];
    const offs = segmentOffsets(withZero); // [0, 1000, 1000]
    expect(indexAtGlobalMs(withZero, offs, 1000)).toBe(2);
  });
});
