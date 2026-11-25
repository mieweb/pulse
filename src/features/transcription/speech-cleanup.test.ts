import { describe, expect, it } from '@jest/globals';

import type { TranscriptWord } from '@/core/types/transcription';

import {
  candidatesInWindow,
  findFillerCandidates,
  findQuietPauseCandidates,
  normalizeFillerText,
} from './speech-cleanup';

const words = (...texts: string[]): TranscriptWord[] =>
  texts.map((text, i) => ({ text, t0: i * 50, t1: (i + 1) * 50 }));

/** Real signed PCM: alternating audible/quiet runs at the extractor's 16 kHz sample rate. */
const pcm = (...runs: [number, number][]): ArrayBuffer => {
  const data = new Int16Array(runs.reduce((sum, [ms]) => sum + Math.round(ms * 16), 0));
  let at = 0;
  for (const [ms, amplitude] of runs) {
    const end = at + Math.round(ms * 16);
    data.fill(amplitude, at, end);
    at = end;
  }
  return data.buffer;
};

describe('filler proposals', () => {
  it('uses source word times and preserves occurrence identity through punctuation and case', () => {
    const result = findFillerCandidates(words('Hello', '“UM,”', 'Uh!', 'world.', 'ERM…'));
    expect(
      result.map(({ id, startMs, endMs, wordIndexes }) => ({ id, startMs, endMs, wordIndexes })),
    ).toEqual([
      { id: 'filler:1:1', startMs: 500, endMs: 1000, wordIndexes: [1] },
      { id: 'filler:2:2', startMs: 1000, endMs: 1500, wordIndexes: [2] },
      { id: 'filler:4:4', startMs: 2000, endMs: 2500, wordIndexes: [4] },
    ]);
  });

  it('does not default to deleting meaningful words or substrings', () => {
    expect(
      findFillerCandidates(words('like', 'so', 'well', 'actually', 'summer', 'ermines')),
    ).toEqual([]);
    expect(normalizeFillerText('  …ＵＭ！ ')).toBe('um');
  });

  it('accepts explicit custom phrases, preferring the longest non-overlapping match', () => {
    const result = findFillerCandidates(words('You', 'know,', 'I', 'mean', 'hello'), [
      'you',
      'you know',
      'YOU KNOW!',
      'i mean',
    ]);
    expect(result).toEqual([
      expect.objectContaining({ startMs: 0, endMs: 1000, wordIndexes: [0, 1] }),
      expect.objectContaining({ startMs: 1000, endMs: 2000, wordIndexes: [2, 3] }),
    ]);
  });

  it('does not join a custom phrase across a long pause, reversed or invalid timestamps', () => {
    for (const second of [
      { text: 'know', t0: 151, t1: 200 }, // More than half a second after “you”.
      { text: 'know', t0: 25, t1: 100 }, // Overlapping source words.
      { text: 'know', t0: NaN, t1: 100 },
    ]) {
      expect(findFillerCandidates([{ text: 'you', t0: 0, t1: 50 }, second], ['you know'])).toEqual(
        [],
      );
    }
  });

  it('clips individual proposals to played source bounds and excludes trimmed-away phrase words', () => {
    expect(
      findFillerCandidates(words('um', 'uh'), undefined, { startMs: 250, endMs: 750 }),
    ).toEqual([
      expect.objectContaining({ id: 'filler:0:0', startMs: 250, endMs: 500 }),
      expect.objectContaining({ id: 'filler:1:1', startMs: 500, endMs: 750 }),
    ]);
    expect(
      findFillerCandidates(words('you', 'know'), ['you know'], { startMs: 500, endMs: 1000 }),
    ).toEqual([]);
  });

  it('does not invent fillers missing from an ASR transcript', () => {
    expect(findFillerCandidates(words('Hello', 'world'))).toEqual([]);
  });
});

describe('quiet audio proposals', () => {
  it('detects actual quiet PCM and retains breathing space on both sides', () => {
    expect(findQuietPauseCandidates(pcm([500, 6000], [1000, 0], [500, -6000]))).toEqual([
      expect.objectContaining({ kind: 'silence', startMs: 620, endMs: 1380 }),
    ]);
  });

  it('keeps short pauses and honors the chosen minimum pause duration', () => {
    const source = pcm([200, 6000], [500, 0], [200, 6000]);
    expect(findQuietPauseCandidates(source)).toEqual([]);
    expect(findQuietPauseCandidates(source, 16000, { minPauseMs: 400, keepMs: 100 })).toEqual([
      expect.objectContaining({ startMs: 300, endMs: 600 }),
    ]);
  });

  it('uses inclusive minimum length and does not create an empty interval after padding', () => {
    expect(findQuietPauseCandidates(pcm([200, 6000], [700, 0], [200, 6000]))).toEqual([
      expect.objectContaining({ startMs: 320, endMs: 780 }),
    ]);
    expect(findQuietPauseCandidates(pcm([1000, 0]), 16000, { keepMs: 500 })).toEqual([]);
  });

  it('does not mistake a low-RMS audible peak for silence', () => {
    const source = new Int16Array(pcm([1000, 0]));
    source[8000] = 1500;
    expect(findQuietPauseCandidates(source.buffer)).toEqual([]);
  });

  it('has explicit energy thresholds rather than inferring silence from transcript gaps', () => {
    const lowEnergy = pcm([1000, 30]);
    expect(findQuietPauseCandidates(lowEnergy)).toHaveLength(1);
    expect(findQuietPauseCandidates(lowEnergy, 16000, { thresholdDb: -70, peakDb: -60 })).toEqual(
      [],
    );
    expect(findQuietPauseCandidates(pcm([1000, -32768]))).toEqual([]);
  });

  it('limits quiet-source candidates to the current trim while retaining source identities', () => {
    const source = pcm([500, 6000], [1000, 0], [500, 6000]);
    const full = findQuietPauseCandidates(source);
    expect(
      findQuietPauseCandidates(source, 16000, { window: { startMs: 1000, endMs: 2000 } }),
    ).toEqual([{ ...full[0], startMs: 1000 }]);
    expect(candidatesInWindow(full, { startMs: 1600, endMs: 2000 })).toEqual([]);
  });

  it('handles leading/trailing and wholly quiet audio conservatively, plus a missing track', () => {
    expect(findQuietPauseCandidates(pcm([1000, 0], [1000, 6000], [1000, 0]))).toEqual([
      expect.objectContaining({ startMs: 120, endMs: 880 }),
      expect.objectContaining({ startMs: 2120, endMs: 2880 }),
    ]);
    expect(findQuietPauseCandidates(pcm([1000, 0]))).toEqual([
      expect.objectContaining({ startMs: 120, endMs: 880, requiresReview: true }),
    ]);
    expect(findQuietPauseCandidates(new ArrayBuffer(0))).toEqual([]);
  });

  it('rejects malformed PCM/settings rather than proposing cuts on unknown audio', () => {
    expect(() => findQuietPauseCandidates(new ArrayBuffer(3))).toThrow(/Invalid/);
    expect(() => findQuietPauseCandidates(pcm([1000, 0]), 0)).toThrow(/Invalid/);
    for (const options of [
      { minPauseMs: NaN },
      { keepMs: -1 },
      { thresholdDb: 3 },
      { peakDb: -80 },
    ])
      expect(() => findQuietPauseCandidates(pcm([1000, 0]), 16000, options)).toThrow(/Invalid/);
    expect(candidatesInWindow([], { startMs: NaN, endMs: 10 })).toEqual([]);
  });
});
