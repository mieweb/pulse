import { describe, expect, it } from '@jest/globals';
import type { ProbeAudio, ProbeResult, ProbeVideo } from 'pulse-editor';

import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  decideImport,
  NORMALIZE_TARGET_BITRATE,
  NORMALIZE_TARGET_FPS,
} from './import-normalization';

// Real probe() values from the wild-import corpus in assets/dev/import/
// (see assets/dev/README.md), read with pulse-editor's AVFoundation probe against the committed
// fixtures. Names match the fixture files. Rotation is clockwise.
type Fields = Partial<ProbeVideo> & { durationMs?: number; audio?: ProbeAudio | null; noVideo?: true };
function probe({ durationMs = 8000, audio, noVideo, ...video }: Fields): ProbeResult {
  return {
    durationMs,
    video: noVideo
      ? undefined
      : {
          codec: 'h264',
          width: 1920,
          height: 1080,
          rotation: 0,
          mirrored: false,
          fps: 30,
          bitrate: 3_000_000,
          bitDepth: 8,
          transfer: 'sdr',
          durationMs,
          ...video,
        },
    audio: audio === null ? undefined : { codec: 'aac', sampleRate: 48000, channels: 2, ...audio },
  };
}
const aac = (sampleRate: number, channels: number): ProbeAudio => ({ codec: 'aac', sampleRate, channels });
const opus: ProbeAudio = { codec: 'opus', sampleRate: 48000, channels: 2 };

const FIXTURES: Record<string, ProbeResult> = {
  'hdr-hlg-portrait-1080p-30-hevc10': probe({
    codec: 'hevc',
    rotation: 270,
    bitrate: 1_002_851,
    bitDepth: 10,
    transfer: 'hlg',
  }),
  'hdr-pq-landscape-4k-30-hevc10': probe({
    codec: 'hevc',
    width: 3840,
    height: 2160,
    bitrate: 2_125_325,
    bitDepth: 10,
    transfer: 'pq',
  }),
  'mono44k-portrait-1080p-30-h264': probe({
    rotation: 270,
    bitrate: 2_226_719,
    audio: aac(44100, 1),
  }),
  'ntsc-landscape-1080p-2997-h264': probe({
    fps: 29.97,
    bitrate: 3_436_690,
  }),
  'opus-landscape-1080p-30-h264': probe({
    bitrate: 4_718_881,
    audio: opus,
  }),
  'rot270-portrait-1080p-30-hevc': probe({
    codec: 'hevc',
    rotation: 90,
    fps: 29.87,
    bitrate: 566_119,
  }),
  'screenrec-portrait-886x1920-60-h264': probe({
    width: 886,
    height: 1920,
    fps: 60,
    bitrate: 1_372_973,
  }),
  'slomo-portrait-1080p-120-h264': probe({
    rotation: 270,
    fps: 120,
    bitrate: 911_077,
  }),
  'square-720x720-30-h264': probe({
    width: 720,
    height: 720,
    bitrate: 968_701,
  }),
  'timelapse-landscape-1080p-30-hevc-noaudio': probe({
    codec: 'hevc',
    bitrate: 3_266_407,
    audio: null,
  }),
  'vfr-portrait-1080p-h264': probe({
    width: 1080,
    height: 1920,
    fps: 40,
    bitrate: 2_366_691,
  }),
  'whatsapp-848x464-30-h264-baseline': probe({
    width: 848,
    height: 464,
    bitrate: 752_820,
    audio: aac(44100, 2),
  }),
};

describe('decideImport against the wild-import fixture corpus', () => {
  // Only imports already ON the 1080×1920 portrait canvas can pass through — the reels
  // contract bakes everything else onto the canvas at import time.
  it.each(['mono44k-portrait-1080p-30-h264'])('%s passes through untouched', (name) => {
    expect(decideImport(FIXTURES[name])).toEqual({ action: 'passthrough' });
  });

  it('opus audio on an on-canvas video gets an audio-only conform with the video stream-copied', () => {
    const d = decideImport(probe({ rotation: 270, audio: opus }));
    expect(d).toEqual({
      action: 'normalize',
      options: { engine: 'auto', copyVideo: true },
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
    ['hdr-hlg-portrait-1080p-30-hevc10', ['video codec hevc', '10-bit', 'HDR transfer hlg']],
    ['hdr-pq-landscape-4k-30-hevc10', ['video codec hevc', '10-bit', 'HDR transfer pq']],
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
    expect(decideImport(probe({ rotation: 270, audio: null }))).toEqual({
      action: 'passthrough',
    });
  });

  it('audio-only files (no video stream) pass through', () => {
    expect(decideImport(probe({ noVideo: true })).action).toBe('passthrough');
  });

  it('exotic video codecs are re-encoded', () => {
    const d = decideImport(probe({ codec: 'vp9' }));
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
    const d = decideImport(probe({ fps: 60, audio: opus }));
    expect(d.action).toBe('normalize');
    if (d.action === 'normalize') {
      expect(d.options.copyVideo).toBeUndefined();
      expect(d.reasons.join('; ')).toContain('audio codec opus');
    }
  });

  it('portrait 4K (rotated coded-landscape) is baked onto the canvas', () => {
    const d = decideImport(probe({ width: 3840, height: 2160, rotation: 270 }));
    expect(d.action).toBe('normalize');
    if (d.action === 'normalize') {
      expect(d.options.width).toBe(CANVAS_WIDTH);
      expect(d.options.height).toBe(CANVAS_HEIGHT);
      expect(d.options.letterbox).toBe(true);
    }
  });

  it('unknown fps (probe -1) does not trigger the fps rule', () => {
    expect(decideImport(probe({ rotation: 270, fps: -1 }))).toEqual({
      action: 'passthrough',
    });
  });

  it('on-canvas 31 fps is normalized (would round past the pinned 30 fps)', () => {
    const d = decideImport(probe({ rotation: 270, fps: 31 }));
    expect(d.action).toBe('normalize');
    if (d.action === 'normalize') {
      expect(d.reasons.join('; ')).toContain('31 fps');
    }
  });

  it('exactly 30.5 fps rounds to 31 and is normalized (merge-pin rounding boundary)', () => {
    const d = decideImport(probe({ rotation: 270, fps: 30.5 }));
    expect(d.action).toBe('normalize');
  });

  it('on-canvas 29.97 NTSC still passes through', () => {
    expect(
      decideImport(probe({ rotation: 270, fps: 29.97 })),
    ).toEqual({ action: 'passthrough' });
  });

  it('unknown bitrate (probe -1) does not trigger the bitrate rule', () => {
    expect(decideImport(probe({ rotation: 270, bitrate: -1 }))).toEqual({ action: 'passthrough' });
  });

  it('10-bit video is re-encoded even when SDR', () => {
    const d = decideImport(probe({ rotation: 270, bitDepth: 10 }));
    expect(d.action).toBe('normalize');
    if (d.action === 'normalize') expect(d.reasons).toContain('10-bit video');
  });
});
