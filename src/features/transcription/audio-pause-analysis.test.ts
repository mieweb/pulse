import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { extractAudio, type AudioPCM } from '@mieweb/pulse-editor';

import { analyzeQuietPauses, createQuietPauseAnalyzer } from './audio-pause-analysis';

jest.mock('@mieweb/pulse-editor', () => ({ extractAudio: jest.fn() }), { virtual: true });

const extract = jest.mocked(extractAudio);
const silent = (): AudioPCM => ({
  data: new Int16Array(16000).buffer,
  sampleRate: 16000,
  durationMs: 1000,
});

beforeEach(() => {
  extract.mockReset();
});

describe('quiet-pause analysis job', () => {
  it('decodes a shared source once, with each split beat receiving its own source bounds', async () => {
    extract.mockResolvedValue(silent());
    const analyze = createQuietPauseAnalyzer();
    const [left, right] = await Promise.all([
      analyze('file:///original.mp4', {
        minPauseMs: 400,
        window: { startMs: 0, endMs: 500 },
      }),
      analyze('file:///original.mp4', {
        minPauseMs: 400,
        window: { startMs: 500, endMs: 1000 },
      }),
    ]);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(left).toEqual([
      expect.objectContaining({ startMs: 120, endMs: 380, requiresReview: true }),
    ]);
    expect(right).toEqual([
      expect.objectContaining({ startMs: 620, endMs: 880, requiresReview: true }),
    ]);
    expect(left[0].id).toBe(right[0].id);
  });

  it('reuses raw spans for minimum/padding choices, with energy settings and review jobs isolated', async () => {
    extract.mockResolvedValue(silent());
    const first = createQuietPauseAnalyzer();
    await first('file:///original.mp4');
    await first('file:///original.mp4', { minPauseMs: 1500 });
    await first('file:///original.mp4', { keepMs: 200 });
    expect(extract).toHaveBeenCalledTimes(1);
    await first('file:///original.mp4', { thresholdDb: -60 });
    await createQuietPauseAnalyzer()('file:///original.mp4');
    expect(extract).toHaveBeenCalledTimes(3);
  });

  it('does not reuse a qualifying full-file pause for a shorter played overlap', async () => {
    const data = new Int16Array(32000);
    data.fill(6000, 0, 8000);
    data.fill(6000, 24000);
    extract.mockResolvedValue({ data: data.buffer, sampleRate: 16000, durationMs: 2000 });
    const analyze = createQuietPauseAnalyzer();
    expect(await analyze('file:///original.mp4')).toEqual([
      expect.objectContaining({ startMs: 620, endMs: 1380 }),
    ]);
    await expect(
      analyze('file:///original.mp4', { window: { startMs: 1000, endMs: 2000 } }),
    ).resolves.toEqual([]);
    expect(
      await analyze('file:///original.mp4', {
        minPauseMs: 400,
        window: { startMs: 1000, endMs: 2000 },
      }),
    ).toEqual([expect.objectContaining({ startMs: 1120, endMs: 1380 })]);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('does not turn a decoding failure into a silence cut and permits retry', async () => {
    extract.mockRejectedValueOnce(new Error('Unreadable audio')).mockResolvedValueOnce(silent());
    const analyze = createQuietPauseAnalyzer();
    await expect(analyze('file:///broken.mp4')).rejects.toThrow('Unreadable audio');
    await expect(analyze('file:///broken.mp4')).resolves.toHaveLength(1);
  });

  it('checks cancellation before decoding and after an in-flight native decode', async () => {
    const before = new AbortController();
    before.abort();
    await expect(analyzeQuietPauses('file:///original.mp4', {}, before.signal)).rejects.toThrow(
      'cancelled',
    );
    expect(extract).not.toHaveBeenCalled();

    let resolve!: (audio: AudioPCM) => void;
    extract.mockImplementationOnce(
      () =>
        new Promise<AudioPCM>((done) => {
          resolve = done;
        }),
    );
    const during = new AbortController();
    const pending = analyzeQuietPauses('file:///original.mp4', {}, during.signal);
    during.abort();
    resolve(silent());
    await expect(pending).rejects.toThrow('cancelled');
  });

  it('does not fabricate pauses when the source has no audio track', async () => {
    extract.mockResolvedValue({ data: new ArrayBuffer(0), sampleRate: 16000, durationMs: 0 });
    await expect(analyzeQuietPauses('file:///silent-video.mp4')).resolves.toEqual([]);
  });

  it('does not return cached proposals after a review is cancelled', async () => {
    extract.mockResolvedValue(silent());
    const controller = new AbortController();
    const analyze = createQuietPauseAnalyzer(controller.signal);
    await expect(analyze('file:///original.mp4')).resolves.toHaveLength(1);
    controller.abort();
    await expect(analyze('file:///original.mp4')).rejects.toThrow('cancelled');
    expect(extract).toHaveBeenCalledTimes(1);
  });
});
