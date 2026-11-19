import { describe, expect, it, jest } from '@jest/globals';

import type { Segment } from '@/db/schema';

import { startUpload, type UploadTarget, type UploadTargetProvider } from './target-provider';
import type { UploadClaim } from './types';

/** A provider that records each claim it is handed. */
function recordingProvider() {
  const claim = jest.fn(async (_claim: UploadClaim) => {});
  const provider: UploadTargetProvider = { kind: 'host', claim };
  return { provider, claim };
}

const TARGET: UploadTarget = {
  destinationId: 'dest-1',
  destination: {
    server: 'https://vault.example.test',
    token: 'token',
    artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  returnTo: { url: 'https://huddle.example.test/ticket/12', app: 'Huddle' },
};
const SEGMENTS = [{ id: 'clip-1' }] as unknown as Segment[];
const MERGED = { path: 'file:///drafts/d1/export.mp4', durationMs: 4_000 };

describe('startUpload', () => {
  it('spends the picked target on the draft through the shell’s provider', async () => {
    const { provider, claim } = recordingProvider();
    const started = await startUpload(provider, {
      draftId: 'd1',
      target: TARGET,
      segments: SEGMENTS,
      merged: MERGED,
    });

    expect(started).toBe(true);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith({
      draftId: 'd1',
      destinationId: 'dest-1',
      destination: TARGET.destination,
      segments: SEGMENTS,
      merged: MERGED,
      returnTo: TARGET.returnTo,
    });
  });

  it('claims nothing without a target or before the merge has landed', async () => {
    const { provider, claim } = recordingProvider();
    const base = { draftId: 'd1', segments: SEGMENTS };

    expect(await startUpload(provider, { ...base, target: null, merged: MERGED })).toBe(false);
    expect(await startUpload(provider, { ...base, target: TARGET, merged: null })).toBe(false);
    expect(claim).not.toHaveBeenCalled();
  });

  it('sends nothing in a shell that set no upload targets', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const started = await startUpload(null, {
      draftId: 'd1',
      target: TARGET,
      segments: SEGMENTS,
      merged: MERGED,
    });

    expect(started).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('set no upload targets'));
    warn.mockRestore();
  });
});
