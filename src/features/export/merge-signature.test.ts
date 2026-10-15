import { describe, expect, it } from '@jest/globals';

import type { Segment } from '@/db/schema';

import {
  currentExportDuration,
  exportSignature,
  MERGE_VERSION,
  mergedSignature,
} from './merge-signature';

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
  const AUDIO = { sampleRate: 48000, channels: 1 };
  const stored = { fileExists: true, signature: exportSignature(clips, AUDIO), durationMs: 2000 };

  it('reuses the export when the file exists and the signature matches', () => {
    expect(currentExportDuration(stored, clips, AUDIO)).toBe(2000);
  });

  it('re-merges when the clips changed since the export', () => {
    expect(currentExportDuration(stored, [b, a], AUDIO)).toBeNull();
  });

  it('re-merges an export encoded under an older MERGE_VERSION', () => {
    const old = {
      ...stored,
      signature: `${mergedSignature(clips, MERGE_VERSION - 1)}|audio 48000x1`,
    };
    expect(currentExportDuration(old, clips, AUDIO)).toBeNull();
  });

  it('re-merges when the file is gone or nothing is recorded', () => {
    expect(currentExportDuration({ ...stored, fileExists: false }, clips, AUDIO)).toBeNull();
    expect(currentExportDuration({ ...stored, signature: null }, clips, AUDIO)).toBeNull();
    expect(currentExportDuration({ ...stored, durationMs: null }, clips, AUDIO)).toBeNull();
  });
});
