import { describe, expect, it } from '@jest/globals';

import { isPulseManifest, PULSE_FORMAT } from './manifest';

describe('legacy Pulse manifest version gate', () => {
  const manifest = {
    format: PULSE_FORMAT,
    version: 1,
    exportedAt: 1,
    drafts: [
      { name: null, createdAt: 1, segments: [{ original: 'media/original.mp4', durationMs: 12 }] },
    ],
  };
  it('still recognizes incomplete v1 copy imports', () => {
    expect(isPulseManifest(manifest)).toBe(true);
  });
  it('rejects all unknown/future versions rather than interpreting them as v1', () => {
    for (const version of [0, 2, 3, 1.5, NaN, '1', null]) {
      expect(isPulseManifest({ ...manifest, version })).toBe(false);
    }
  });
});
