import { describe, expect, it } from '@jest/globals';
import type { VideoProbeResult } from 'react-native-video-trim';

import {
  decideUploadContract,
  effectiveBitrate,
  UPLOAD_MAX_LONG_EDGE,
  UPLOAD_TARGET_BITRATE,
  UPLOAD_TARGET_FPS,
} from './upload-contract';

/** A clip that already satisfies the contract; override one field to test one rule. */
function probe(overrides: Partial<VideoProbeResult> = {}): VideoProbeResult {
  return {
    hasVideo: true,
    videoCodec: 'h264',
    width: 1920,
    height: 1080,
    rotation: 0,
    nominalFps: 30,
    averageFps: 30,
    bitrate: 5_000_000,
    pixelFormat: 'yuv420p',
    colorTransfer: 'bt709',
    hasAudio: true,
    audioCodec: 'aac',
    audioSampleRate: 48000,
    audioChannels: 2,
    duration: 8000,
    fileSize: 5_000_000,
    ...overrides,
  };
}

/**
 * The two PulseCam uploads that were actually sitting on the dev box, measured with
 * ffprobe. These are the files that would not play on a phone — the regression test
 * for this whole gate is that both of them get normalized.
 */
const REAL_UPLOADS: Record<string, VideoProbeResult> = {
  '669b7a78 (343MB, 110s)': probe({
    videoCodec: 'hevc',
    width: 3840,
    height: 2160,
    bitrate: 24_761_167,
    duration: 110_588,
    fileSize: 343_727_447,
  }),
  'a9dd0919 (579MB, 166s)': probe({
    videoCodec: 'hevc',
    width: 3840,
    height: 2160,
    bitrate: 27_831_557,
    duration: 165_821,
    fileSize: 579_118_404,
  }),
};

describe('decideUploadContract', () => {
  describe('the real 4K HEVC uploads that broke phone playback', () => {
    for (const [name, p] of Object.entries(REAL_UPLOADS)) {
      it(`normalizes ${name} on every count`, () => {
        const decision = decideUploadContract(p);
        expect(decision.action).toBe('normalize');
        if (decision.action !== 'normalize') return;

        expect(decision.reasons).toEqual(
          expect.arrayContaining([
            expect.stringContaining('video codec hevc'),
            expect.stringContaining('3840x2160'),
            expect.stringContaining('Mbps'),
          ]),
        );
        expect(decision.options).toMatchObject({
          codec: 'h264',
          bitrate: UPLOAD_TARGET_BITRATE,
          frameRate: UPLOAD_TARGET_FPS,
          width: UPLOAD_MAX_LONG_EDGE,
        });
        // Landscape source: the long edge is pinned via width, height follows the aspect ratio.
        expect(decision.options.height).toBeUndefined();
      });
    }
  });

  it('passes a compliant clip through untouched — the whole point of the recorder pin', () => {
    expect(decideUploadContract(probe())).toEqual({ action: 'passthrough' });
  });

  it('converts HEVC that is otherwise perfect (this is where it diverges from imports)', () => {
    const decision = decideUploadContract(probe({ videoCodec: 'hevc' }));
    expect(decision.action).toBe('normalize');
    if (decision.action !== 'normalize') return;
    expect(decision.reasons).toEqual(['video codec hevc']);
    // Nothing is wrong with the geometry, so no scaling is requested.
    expect(decision.options.width).toBeUndefined();
    expect(decision.options.height).toBeUndefined();
    expect(decision.options.codec).toBe('h264');
  });

  it('pins the long edge by HEIGHT for a rotated (portrait) 4K clip, not width', () => {
    // 3840x2160 coded + 90deg rotation displays as 2160x3840 — portrait.
    const decision = decideUploadContract(
      probe({ videoCodec: 'hevc', width: 3840, height: 2160, rotation: 90, bitrate: 24_000_000 }),
    );
    expect(decision.action).toBe('normalize');
    if (decision.action !== 'normalize') return;
    expect(decision.options.height).toBe(UPLOAD_MAX_LONG_EDGE);
    expect(decision.options.width).toBeUndefined();
    expect(decision.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('2160x3840')]),
    );
  });

  it('accepts a clip sitting exactly on the long-edge cap, and rejects one pixel over', () => {
    expect(decideUploadContract(probe({ width: 1920, height: 1080 })).action).toBe('passthrough');
    expect(decideUploadContract(probe({ width: 1921, height: 1080 })).action).toBe('normalize');
  });

  it('leaves a slightly-over-target bitrate alone rather than burning a generation on 7%', () => {
    expect(decideUploadContract(probe({ bitrate: 5_400_000 })).action).toBe('passthrough');
    expect(decideUploadContract(probe({ bitrate: 8_000_000 })).action).toBe('normalize');
  });

  it('caps high frame rates', () => {
    expect(decideUploadContract(probe({ nominalFps: 60, averageFps: 60 })).action).toBe(
      'normalize',
    );
    // 29.97 NTSC must pass untouched.
    expect(decideUploadContract(probe({ nominalFps: 29.97, averageFps: 29.97 })).action).toBe(
      'passthrough',
    );
  });

  it('normalizes 10-bit and HDR sources', () => {
    expect(decideUploadContract(probe({ pixelFormat: 'yuv420p10le' })).action).toBe('normalize');
    expect(decideUploadContract(probe({ colorTransfer: 'arib-std-b67' })).action).toBe('normalize');
    expect(decideUploadContract(probe({ colorTransfer: 'smpte2084' })).action).toBe('normalize');
    // 8-bit format whose name merely contains "10".
    expect(decideUploadContract(probe({ pixelFormat: 'yuv410p' })).action).toBe('passthrough');
  });

  it('conforms audio only, copying the video, when just the audio codec is wrong', () => {
    const decision = decideUploadContract(probe({ audioCodec: 'opus' }));
    expect(decision.action).toBe('normalize');
    if (decision.action !== 'normalize') return;
    expect(decision.options).toEqual({ copyVideo: true });
    expect(decision.reasons).toEqual(['audio codec opus']);
  });

  it('does a full re-encode (not a video copy) when audio AND video are both wrong', () => {
    const decision = decideUploadContract(probe({ videoCodec: 'hevc', audioCodec: 'opus' }));
    expect(decision.action).toBe('normalize');
    if (decision.action !== 'normalize') return;
    expect(decision.options.copyVideo).toBeUndefined();
    expect(decision.options.codec).toBe('h264');
    expect(decision.reasons).toEqual(['video codec hevc', 'audio codec opus']);
  });

  it('ignores audio entirely on a silent clip', () => {
    expect(decideUploadContract(probe({ hasAudio: false, audioCodec: '' })).action).toBe(
      'passthrough',
    );
  });

  it('passes through anything with no video stream', () => {
    expect(decideUploadContract(probe({ hasVideo: false })).action).toBe('passthrough');
  });
});

describe('effectiveBitrate', () => {
  it('prefers the declared stream bitrate', () => {
    expect(effectiveBitrate(probe({ bitrate: 4_000_000 }))).toBe(4_000_000);
  });

  it('derives from size and duration when the container declares nothing', () => {
    // 10 MB over 10 s = 8 Mbps.
    expect(
      effectiveBitrate(probe({ bitrate: -1, fileSize: 10_000_000, duration: 10_000 })),
    ).toBeCloseTo(8_000_000);
  });

  it('reports unknown rather than guessing when neither source is usable', () => {
    expect(effectiveBitrate(probe({ bitrate: -1, fileSize: 0, duration: 0 }))).toBe(-1);
  });

  it('does not treat an undeclared bitrate as a reason to re-encode', () => {
    expect(decideUploadContract(probe({ bitrate: -1, fileSize: 0, duration: 0 }))).toEqual({
      action: 'passthrough',
    });
  });

  it('catches a 4K master whose container declares no bitrate, via size/duration', () => {
    const decision = decideUploadContract(
      probe({ bitrate: -1, fileSize: 343_727_447, duration: 110_588, videoCodec: 'h264' }),
    );
    expect(decision.action).toBe('normalize');
    if (decision.action !== 'normalize') return;
    expect(decision.reasons).toEqual(expect.arrayContaining([expect.stringContaining('Mbps')]));
  });
});
