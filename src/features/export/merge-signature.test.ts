import { describe, expect, it } from '@jest/globals';

import type { Segment } from '@/db/schema';

import { currentExportDuration, MERGE_VERSION, mergedSignature } from './merge-signature';

const seg = (id: string, over: Partial<Segment> = {}): Segment =>
  ({
    id,
    originalFilename: `drafts/d/segments/${id}.mp4`,
    editedFilename: null,
    durationMs: 1000,
    editedDurationMs: null,
    ...over,
  }) as Segment;

const a = seg('a');
const b = seg('b');
const clips = [a, b];

describe('mergedSignature', () => {
  it('is stable for the same clips, independent of array identity', () => {
    expect(mergedSignature([seg('a'), seg('b')])).toBe(mergedSignature(clips));
  });

  it('changes on add, delete and reorder', () => {
    const base = mergedSignature(clips);
    expect(mergedSignature([a, b, seg('c')])).not.toBe(base);
    expect(mergedSignature([a])).not.toBe(base);
    expect(mergedSignature([b, a])).not.toBe(base);
  });

  it('changes on a trim and again on its reset', () => {
    const base = mergedSignature(clips);
    const trimmed = mergedSignature([seg('a', { editedFilename: 'a.edited.1.mp4' }), b]);
    expect(trimmed).not.toBe(base);
    expect(mergedSignature([seg('a', { editedFilename: 'a.edited.2.mp4' }), b])).not.toBe(trimmed);
    expect(mergedSignature(clips)).toBe(base);
  });

  it('changes when MERGE_VERSION is bumped', () => {
    expect(mergedSignature(clips, MERGE_VERSION + 1)).not.toBe(mergedSignature(clips));
  });
});

describe('currentExportDuration', () => {
  const stored = { fileExists: true, signature: mergedSignature(clips), durationMs: 2000 };

  it('reuses the export when the file exists and the signature matches', () => {
    expect(currentExportDuration(stored, clips)).toBe(2000);
  });

  it('re-merges when the clips changed since the export', () => {
    expect(currentExportDuration(stored, [b, a])).toBeNull();
  });

  it('re-merges an export encoded under an older MERGE_VERSION', () => {
    const old = { ...stored, signature: mergedSignature(clips, MERGE_VERSION - 1) };
    expect(currentExportDuration(old, clips)).toBeNull();
  });

  it('re-merges when the file is gone or nothing is recorded', () => {
    expect(currentExportDuration({ ...stored, fileExists: false }, clips)).toBeNull();
    expect(currentExportDuration({ ...stored, signature: null }, clips)).toBeNull();
    expect(currentExportDuration({ ...stored, durationMs: null }, clips)).toBeNull();
  });
});
