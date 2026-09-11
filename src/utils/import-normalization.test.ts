import { describe, expect, it } from '@jest/globals';
import type { VideoProbeResult } from 'react-native-video-trim';

import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  decideImport,
  NORMALIZE_TARGET_BITRATE,
  NORMALIZE_TARGET_FPS,
} from './import-normalization';

// Real probeVideo() values from the wild-import corpus in assets/dev/import/
// (see assets/dev/README.md), captured with ffprobe against the committed
// fixtures. Names match the fixture files.
function probe(overrides: Partial<VideoProbeResult>): VideoProbeResult {
  return {
    hasVideo: true,
    videoCodec: 'h264',
    width: 1920,
    height: 1080,
    rotation: 0,
    nominalFps: 30,
    averageFps: 30,
    bitrate: 3_000_000,
    pixelFormat: 'yuv420p',
    colorTransfer: 'bt709',
    hasAudio: true,
    audioCodec: 'aac',
    audioSampleRate: 48000,
    audioChannels: 2,
    duration: 8000,
    fileSize: 3_000_000,
    ...overrides,
  };
}

const FIXTURES: Record<string, VideoProbeResult> = {
  'hdr-hlg-portrait-1080p-30-hevc10': probe({
    videoCodec: 'hevc',
    rotation: 90,
    bitrate: 895_086,
    pixelFormat: 'yuv420p10le',
    colorTransfer: 'arib-std-b67',
  }),
  'hdr-pq-landscape-4k-30-hevc10': probe({
    videoCodec: 'hevc',
    width: 3840,
    height: 2160,
    bitrate: 1_701_365,
    pixelFormat: 'yuv420p10le',
    colorTransfer: 'smpte2084',
  }),
  'mono44k-portrait-1080p-30-h264': probe({
    rotation: 90,
    bitrate: 2_155_971,
    audioSampleRate: 44100,
    audioChannels: 1,
  }),
  'ntsc-landscape-1080p-2997-h264': probe({
    nominalFps: 29.97,
    averageFps: 29.97,
    bitrate: 3_166_876,
  }),
  'opus-landscape-1080p-30-h264': probe({
    bitrate: 4_551_683,
    audioCodec: 'opus',
  }),
  'rot270-portrait-1080p-30-hevc': probe({
    videoCodec: 'hevc',
    rotation: 270,
    bitrate: 433_528,
  }),
  'screenrec-portrait-886x1920-60-h264': probe({
    width: 886,
    height: 1920,
    nominalFps: 60,
    averageFps: 60,
    bitrate: 1_218_503,
  }),
  'slomo-portrait-1080p-120-h264': probe({
    rotation: 90,
    nominalFps: 120,
    averageFps: 120,
    bitrate: 850_255,
  }),
  'square-720x720-30-h264': probe({
    width: 720,
    height: 720,
    bitrate: 890_283,
  }),
  'timelapse-landscape-1080p-30-hevc-noaudio': probe({
    videoCodec: 'hevc',
    bitrate: 3_037_944,
    hasAudio: false,
    audioCodec: '',
    audioSampleRate: -1,
    audioChannels: -1,
  }),
  'vfr-portrait-1080p-h264': probe({
    width: 1080,
    height: 1920,
    nominalFps: 60,
    averageFps: 40,
    bitrate: 2_224_619,
  }),
  'whatsapp-848x464-30-h264-baseline': probe({
    width: 848,
    height: 464,
    bitrate: 745_736,
    audioSampleRate: 44100,
  }),
};

describe('decideImport against the wild-import fixture corpus', () => {
  // Only imports already ON the 1080×1920 portrait canvas can pass through — the reels
  // contract bakes everything else onto the canvas at import time.
  it.each(['mono44k-portrait-1080p-30-h264'])('%s passes through untouched', (name) => {
    expect(decideImport(FIXTURES[name])).toEqual({ action: 'passthrough' });
  });

  it('opus audio on an on-canvas video gets an audio-only conform with the video stream-copied', () => {
    const d = decideImport(probe({ rotation: 90, audioCodec: 'opus' }));
    expect(d).toEqual({
      action: 'normalize',
      options: { copyVideo: true },
      reasons: ['audio codec opus'],
    });
  });

  it('opus audio on an off-canvas video folds into the full re-encode', () => {
    const d = decideImport(FIXTURES['opus-landscape-1080p-30-h264']);
    expect(d.action).toBe('normalize');
    if (d.action !== 'normalize') return;
    expect(d.options.copyVideo).toBeUndefined();
    expect(d.reasons.join('; ')).toContain('audio codec opus');
    expect(d.reasons.join('; ')).toContain('off the 1080x1920 canvas');
  });

  it.each([
    ['hdr-hlg-portrait-1080p-30-hevc10', ['video codec hevc', '10-bit', 'HDR transfer arib-std-b67']],
    ['hdr-pq-landscape-4k-30-hevc10', ['video codec hevc', '10-bit', 'HDR transfer smpte2084']],
    ['rot270-portrait-1080p-30-hevc', ['video codec hevc']],
    ['timelapse-landscape-1080p-30-hevc-noaudio', ['video codec hevc', 'off the 1080x1920 canvas']],
    ['screenrec-portrait-886x1920-60-h264', ['60 fps', 'off the 1080x1920 canvas']],
    ['slomo-portrait-1080p-120-h264', ['120 fps']],
    ['vfr-portrait-1080p-h264', ['40 fps']],
    ['ntsc-landscape-1080p-2997-h264', ['off the 1080x1920 canvas']],
    ['square-720x720-30-h264', ['off the 1080x1920 canvas']],
    ['whatsapp-848x464-30-h264-baseline', ['off the 1080x1920 canvas']],
  ])('%s is re-encoded (%p)', (name, expectedReasons) => {
    const d = decideImport(FIXTURES[name]);
    expect(d.action).toBe('normalize');
    if (d.action !== 'normalize') return;
    expect(d.options.copyVideo).toBeUndefined();
    expect(d.options.bitrate).toBe(NORMALIZE_TARGET_BITRATE);
    expect(d.options.frameRate).toBe(NORMALIZE_TARGET_FPS);
    for (const fragment of expectedReasons) {
      expect(d.reasons.join('; ')).toContain(fragment);
    }
  });

  it('every full re-encode is baked onto the exact portrait canvas', () => {
    for (const name of Object.keys(FIXTURES)) {
      const d = decideImport(FIXTURES[name]);
      if (d.action !== 'normalize' || d.options.copyVideo) continue;
      expect(d.options.width).toBe(CANVAS_WIDTH);
      expect(d.options.height).toBe(CANVAS_HEIGHT);
      expect(d.options.letterbox).toBe(true);
    }
  });
});

describe('decideImport edge cases beyond the corpus', () => {
  it('audio-less files with fine on-canvas video pass through', () => {
    expect(decideImport(probe({ rotation: 90, hasAudio: false, audioCodec: '' }))).toEqual({
      action: 'passthrough',
    });
  });

  it('audio-only files (no video stream) pass through', () => {
    expect(decideImport(probe({ hasVideo: false, videoCodec: '' })).action).toBe('passthrough');
  });

  it('exotic video codecs are re-encoded', () => {
    const d = decideImport(probe({ videoCodec: 'vp9' }));
    expect(d.action).toBe('normalize');
    if (d.action === 'normalize') {
      expect(d.reasons.join('; ')).toContain('vp9');
    }
  });

  it('excessive bitrate alone triggers a re-encode', () => {
    const d = decideImport(probe({ bitrate: 45_000_000 }));
    expect(d.action).toBe('normalize');
    if (d.action === 'normalize') {
      expect(d.options.bitrate).toBe(NORMALIZE_TARGET_BITRATE);
    }
  });

  it('hostile audio on a hostile video is folded into the full re-encode', () => {
    const d = decideImport(probe({ averageFps: 60, nominalFps: 60, audioCodec: 'opus' }));
    expect(d.action).toBe('normalize');
    if (d.action === 'normalize') {
      expect(d.options.copyVideo).toBeUndefined();
      expect(d.reasons.join('; ')).toContain('audio codec opus');
    }
  });

  it('portrait 4K (rotated coded-landscape) is baked onto the canvas', () => {
    const d = decideImport(probe({ width: 3840, height: 2160, rotation: 90 }));
    expect(d.action).toBe('normalize');
    if (d.action === 'normalize') {
      expect(d.options.width).toBe(CANVAS_WIDTH);
      expect(d.options.height).toBe(CANVAS_HEIGHT);
      expect(d.options.letterbox).toBe(true);
    }
  });

  it('unknown fps (probe -1) does not trigger the fps rule', () => {
    expect(decideImport(probe({ rotation: 90, nominalFps: -1, averageFps: -1 }))).toEqual({
      action: 'passthrough',
    });
  });

  it('on-canvas 31 fps is normalized (would round past the pinned 30 fps)', () => {
    const d = decideImport(probe({ rotation: 90, nominalFps: 31, averageFps: 31 }));
    expect(d.action).toBe('normalize');
    if (d.action === 'normalize') {
      expect(d.reasons.join('; ')).toContain('31 fps');
    }
  });

  it('exactly 30.5 fps rounds to 31 and is normalized (merge-pin rounding boundary)', () => {
    const d = decideImport(probe({ rotation: 90, nominalFps: 30.5, averageFps: 30.5 }));
    expect(d.action).toBe('normalize');
  });

  it('on-canvas 29.97 NTSC still passes through', () => {
    expect(
      decideImport(probe({ rotation: 90, nominalFps: 29.97, averageFps: 29.97 })),
    ).toEqual({ action: 'passthrough' });
  });

  it('unknown bitrate (probe -1) does not trigger the bitrate rule', () => {
    expect(decideImport(probe({ rotation: 90, bitrate: -1 }))).toEqual({ action: 'passthrough' });
  });

  it('8-bit chroma-subsampling formats with "10" in the name are not treated as 10-bit', () => {
    // yuv410p/yuv411p are 8-bit 4:1:0 / 4:1:1 — only a 10/10le/10be depth suffix means 10-bit.
    expect(decideImport(probe({ rotation: 90, pixelFormat: 'yuv410p' }))).toEqual({
      action: 'passthrough',
    });
    expect(decideImport(probe({ rotation: 90, pixelFormat: 'yuv411p' }))).toEqual({
      action: 'passthrough',
    });
  });

  it('10-bit depth suffixes are still caught (be as well as le, and biplanar p010)', () => {
    for (const pixelFormat of ['yuv420p10le', 'yuv420p10be', 'p010le']) {
      const d = decideImport(probe({ pixelFormat }));
      expect(d.action).toBe('normalize');
      if (d.action === 'normalize') expect(d.reasons).toContain(`10-bit pixel format ${pixelFormat}`);
    }
  });
});
