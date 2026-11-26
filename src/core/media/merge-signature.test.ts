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

describe('narration export freshness', () => {
  const audio = { sampleRate: 48000, channels: 1 };
  const take = {
    filename: 'drafts/d1/voiceover/take.caf',
    startMs: 1000,
    durationMs: 6000,
    trimStartMs: 100,
    trimEndMs: 5100,
  } as import('@/db/schema').VoiceoverTake;
  const mix = { takes: [take], sourceMuted: false, voiceoverMuted: false };
  const signature = exportSignature(clips, audio, mix);

  it('includes narration placement, source trim and both saved track mute settings', () => {
    for (const changed of [
      { ...mix, sourceMuted: true },
      { ...mix, voiceoverMuted: true },
      { ...mix, takes: [] },
      { ...mix, takes: [{ ...take, startMs: 1500 }] },
      { ...mix, takes: [{ ...take, trimStartMs: 200 }] },
      { ...mix, takes: [{ ...take, trimEndMs: 5000 }] },
      { ...mix, takes: [{ ...take, filename: 'another.caf' }] },
    ]) {
      expect(exportSignature(clips, audio, changed)).not.toBe(signature);
    }
    expect(
      currentExportDuration({ fileExists: true, signature, durationMs: 2000 }, clips, audio, mix),
    ).toBe(2000);
    expect(
      currentExportDuration({ fileExists: true, signature, durationMs: 2000 }, clips, audio),
    ).toBeNull();
  });

  it('keeps existing no-narration exports current', () => {
    expect(
      exportSignature(clips, audio, { takes: [], sourceMuted: false, voiceoverMuted: false }),
    ).toBe(exportSignature(clips, audio));
  });
});
