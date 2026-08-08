import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { compress, probeVideo, type VideoProbeResult } from 'react-native-video-trim';

import { ensureUploadContract } from './ensure-upload-contract';
import { hasFaststart } from './faststart';

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
// The scanner has its own tests against synthetic box layouts (faststart.test.ts); here we
// only care what the gate DOES with each of its three answers.
jest.mock('./faststart', () => ({ hasFaststart: jest.fn() }));

const mockHasFaststart = hasFaststart as jest.MockedFunction<typeof hasFaststart>;
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
    // These cases are about path handling, so keep faststart out of the picture.
    mockHasFaststart.mockReset();
    mockHasFaststart.mockReturnValue(true);
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

/**
 * `moov` placement is the one contract term a probe cannot see, so it is enforced here rather
 * than in `decideUploadContract`. It only bites on files that skip the merge engine — a
 * single-clip draft and every segment upload — which are raw AVCaptureMovieFileOutput files
 * and therefore always index-at-the-tail. Before the recorder pinned H.264 they were re-encoded
 * anyway for breaching codec/bitrate, and got faststart as a side effect; now they are otherwise
 * compliant, so without this they would upload with the index still at the end.
 */
describe('ensureUploadContract — faststart', () => {
  beforeEach(() => {
    mockProbeVideo.mockReset();
    mockCompress.mockReset();
    mockHasFaststart.mockReset();
    mockProbeVideo.mockResolvedValue(compliant());
  });

  it('remuxes a compliant clip whose moov is at the end', async () => {
    mockHasFaststart.mockReturnValue(false);
    mockCompress.mockResolvedValue({ outputPath: '/cache/remuxed.mp4' });

    const r = await ensureUploadContract('file:///doc/segments/s.mp4');

    expect(r.changed).toBe(true);
    expect(r.path).toBe('file:///cache/remuxed.mp4');
    expect(r.reasons).toEqual(['moov atom at the end of the file']);
  });

  it('stream-copies the video rather than transcoding it', async () => {
    mockHasFaststart.mockReturnValue(false);
    mockCompress.mockResolvedValue({ outputPath: '/cache/remuxed.mp4' });

    await ensureUploadContract('file:///doc/segments/s.mp4');

    // copyVideo maps to `-c:v copy` in the fork, which also applies `+faststart` to the
    // output. Re-encoding here would spend a quality generation to move four bytes.
    expect(mockCompress).toHaveBeenCalledWith(
      'file:///doc/segments/s.mp4',
      expect.objectContaining({ copyVideo: true, outputExt: 'mp4' }),
    );
    const options = mockCompress.mock.calls[0][1] as Record<string, unknown>;
    expect(options.bitrate).toBeUndefined();
    expect(options.width).toBeUndefined();
    expect(options.height).toBeUndefined();
  });

  it('leaves a merged clip that already has faststart completely alone', async () => {
    mockHasFaststart.mockReturnValue(true);

    const r = await ensureUploadContract('file:///cache/merged.mp4');

    expect(r.changed).toBe(false);
    expect(r.reasons).toEqual([]);
    expect(mockCompress).not.toHaveBeenCalled();
  });

  it('does nothing when the scan cannot tell', async () => {
    // A short read or an unrecognised container. Guessing would mean a needless re-encode on
    // every upload, which is worse than the stall it would be avoiding.
    mockHasFaststart.mockReturnValue(null);

    const r = await ensureUploadContract('file:///cache/odd.mp4');

    expect(r.changed).toBe(false);
    expect(mockCompress).not.toHaveBeenCalled();
  });

  it('fails open loudly when the remux itself fails', async () => {
    mockHasFaststart.mockReturnValue(false);
    mockCompress.mockRejectedValue(new Error('ffmpeg exploded'));

    const r = await ensureUploadContract('file:///doc/segments/s.mp4');

    expect(r.changed).toBe(false);
    expect(r.path).toBe('file:///doc/segments/s.mp4');
    expect(r.failure).toBeTruthy();
  });

  it('does not double-handle a clip that is already being re-encoded', async () => {
    // A breaching file goes down the normalize path, and compress() writes faststart there
    // too — so the scan must not add a second pass on top.
    mockProbeVideo.mockResolvedValue(compliant({ videoCodec: 'hevc' }));
    mockHasFaststart.mockReturnValue(false);
    mockCompress.mockResolvedValue({ outputPath: '/cache/out.mp4' });

    const r = await ensureUploadContract('file:///doc/segments/s.mp4');

    expect(mockCompress).toHaveBeenCalledTimes(1);
    expect(r.reasons).toEqual(['video codec hevc']);
  });
});
