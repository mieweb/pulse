import { describe, expect, it, jest } from '@jest/globals';

import type { UploadClaim } from '@/features/upload/core/types';
import { uploads } from '@/features/upload/core/upload-manager';

import { poolProvider } from './pool-provider';

jest.mock('@/features/upload/core/upload-manager', () => ({
  uploads: { claim: jest.fn(async () => {}) },
}));

const claim = uploads.claim as jest.MockedFunction<typeof uploads.claim>;

const CLAIM: UploadClaim = {
  draftId: 'd1',
  destinationId: 'dest-1',
  destination: {
    server: 'https://vault.example.test',
    token: 'token',
    artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  segments: [],
  merged: { path: 'file:///drafts/d1/export.mp4', durationMs: 4_000 },
  returnTo: null,
};

describe('poolProvider', () => {
  it('is the paired pool', () => {
    expect(poolProvider.kind).toBe('pool');
  });

  it('delegates to the upload manager’s claim with the same args', async () => {
    let finish!: () => void;
    claim.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));

    let settled = false;
    const pending = poolProvider.claim(CLAIM).then(() => {
      settled = true;
    });

    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim.mock.calls[0][0]).toBe(CLAIM);
    // It resolves when the manager's claim does, not before.
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await pending;
    expect(settled).toBe(true);
  });
});
