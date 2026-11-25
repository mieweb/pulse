import { describe, expect, it } from '@jest/globals';

import { fitExportPreview } from './preview-layout';

describe('export preview in a reduced viewport', () => {
  it.each([0, 20, 42])('hides the preview when metadata uses the %s-point frame', (height) => {
    expect(fitExportPreview(375, height, 42)).toBeNull();
  });

  it('keeps the video and metadata inside a short keyboard viewport', () => {
    const card = fitExportPreview(375, 120, 42)!;
    expect(card.height).toBe(78);
    expect(card.width).toBe(43.875);
    expect(card.height + 42).toBe(120);
  });

  it('keeps the aspect ratio when width limits a roomy viewport', () => {
    const card = fitExportPreview(375, 900, 42)!;
    expect(card.width).toBe(375);
    expect(card.width / card.height).toBeCloseTo(9 / 16);
    expect(card.height + 42).toBeLessThanOrEqual(900);
  });

  it.each([
    [-1, 120, 42],
    [0, 120, 42],
    [375, -1, 42],
    [375, 120, -1],
    [375, NaN, 42],
    [Infinity, 120, 42],
  ])('rejects unusable frame dimensions (%s, %s, %s)', (width, height, metadataHeight) => {
    expect(fitExportPreview(width, height, metadataHeight)).toBeNull();
  });
});
