import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { compress, probeVideo, type VideoProbeResult } from 'react-native-video-trim';

import { ensureUploadContract } from './ensure-upload-contract';

// `jest.mock` is hoisted above these imports by babel-plugin-jest-hoist, so the factories run
// first and the imports above resolve to the doubles below. The mock functions are created
// INSIDE the factories rather than captured from module scope: a `const` declared out here is
// still in its temporal dead zone when the hoisted factory runs.
//
// expo-file-system is a native module that `file-store` imports at load. Stubbing it keeps the
// REAL `toFileUri` in play, which is the behaviour under test.
jest.mock('expo-file-system', () => ({
  File: class {},
  Directory: class {},
  Paths: { document: '/doc', cache: '/cache' },
}));
jest.mock('react-native-video-trim', () => ({
  probeVideo: jest.fn(),
  compress: jest.fn(),
}));

const mockProbeVideo = probeVideo as jest.MockedFunction<typeof probeVideo>;
const mockCompress = compress as unknown as jest.MockedFunction<
  (p: string, o: unknown) => Promise<{ outputPath: string }>
>;

/** A clip that already satisfies the contract. */
function compliant(overrides: Partial<VideoProbeResult> = {}): VideoProbeResult {
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
  } as VideoProbeResult;
}

/**
 * The merged upload unit arrives as a bare filesystem path on Android (react-native-video-trim
 * returns one). `probeVideo`/`compress` want a file:// URI, and a failed probe is swallowed into
 * "upload the original" — so passing the bare path through made the gate fail open on every
 * Android merged upload while still looking present in the code.
 */
describe('ensureUploadContract — path normalisation', () => {
  beforeEach(() => {
    mockProbeVideo.mockReset();
    mockCompress.mockReset();
  });

  it('probes a bare Android path as a file:// URI', async () => {
    mockProbeVideo.mockResolvedValue(compliant());
    await ensureUploadContract('/data/user/0/app/cache/merged.mp4');
    expect(mockProbeVideo).toHaveBeenCalledWith('file:///data/user/0/app/cache/merged.mp4');
  });

  it('re-encodes from the normalised URI, not the bare path', async () => {
    mockProbeVideo.mockResolvedValue(compliant({ videoCodec: 'hevc' }));
    mockCompress.mockResolvedValue({ outputPath: '/cache/out.mp4' });
    await ensureUploadContract('/data/merged.mp4');
    expect(mockCompress).toHaveBeenCalledWith('file:///data/merged.mp4', expect.anything());
  });

  it('leaves an input that is already a URI untouched', async () => {
    mockProbeVideo.mockResolvedValue(compliant());
    await ensureUploadContract('file:///doc/drafts/a/segments/s.mp4');
    expect(mockProbeVideo).toHaveBeenCalledWith('file:///doc/drafts/a/segments/s.mp4');
  });

  it('returns a file:// URI on every path — passthrough, re-encode, and failure', async () => {
    mockProbeVideo.mockResolvedValue(compliant());
    expect((await ensureUploadContract('/data/a.mp4')).path).toBe('file:///data/a.mp4');

    mockProbeVideo.mockResolvedValue(compliant({ videoCodec: 'hevc' }));
    mockCompress.mockResolvedValue({ outputPath: '/cache/out.mp4' });
    expect((await ensureUploadContract('/data/b.mp4')).path).toBe('file:///cache/out.mp4');

    mockProbeVideo.mockRejectedValue(new Error('no such file'));
    const failed = await ensureUploadContract('/data/c.mp4');
    expect(failed.path).toBe('file:///data/c.mp4');
    expect(failed.failure).toBeTruthy();
  });

  it('a probe failure still fails open rather than dropping the upload', async () => {
    mockProbeVideo.mockRejectedValue(new Error('boom'));
    const r = await ensureUploadContract('/data/d.mp4');
    expect(r.changed).toBe(false);
    expect(r.path).toBeTruthy();
  });
});
