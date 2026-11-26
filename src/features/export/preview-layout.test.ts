import { describe, expect, it } from '@jest/globals';

import { exportPreviewSize } from './preview-layout';

describe('export preview space', () => {
  it.each([
    { width: 343, viewport: 570, actions: 178, safeArea: 34, chrome: 88 },
    { width: 408, viewport: 800, actions: 214, safeArea: 34, chrome: 88 },
    { width: 288, viewport: 464, actions: 102, safeArea: 16, chrome: 88 },
  ])('reserves the measured actions and safe area on a portrait phone: %o', (screen) => {
    const available = screen.viewport - screen.actions - screen.safeArea - 8;
    const video = exportPreviewSize(screen.width, available, screen.chrome);
    expect(video.width).toBeLessThanOrEqual(screen.width);
    expect(video.height + screen.chrome).toBeLessThanOrEqual(available);
    expect(video.width / video.height).toBeCloseTo(9 / 16);
  });

  it('gives room back when actions disappear and shrinks for warnings or larger text', () => {
    const ordinary = exportPreviewSize(390, 540, 88);
    const warning = exportPreviewSize(390, 440, 88);
    const enlargedMetadata = exportPreviewSize(390, 540, 116);
    expect(ordinary.height - warning.height).toBeCloseTo(100);
    expect(ordinary.height - enlargedMetadata.height).toBeCloseTo(28);
  });

  it('reserves both metadata and the separate lower playback row with their video gaps', () => {
    const metadata = 28;
    const playback = 44;
    const video = exportPreviewSize(390, 540, metadata + playback + 8 * 2);
    expect(video.height + metadata + playback + 8 * 2).toBeCloseTo(540);
    expect(video.width / video.height).toBeCloseTo(9 / 16);
  });

  it('keeps a usable portrait preview and scrolls instead of producing negative dimensions', () => {
    for (const available of [0, -200, 100]) {
      const video = exportPreviewSize(288, available, 52);
      expect(video.height).toBe(160);
      expect(video.width / video.height).toBe(9 / 16);
    }
  });

  it('fits the width after rotation or a narrow host resize', () => {
    expect(exportPreviewSize(200, 900, 52)).toEqual({ width: 200, height: (200 * 16) / 9 });
    expect(exportPreviewSize(0, 0, 52)).toEqual({ width: 0, height: 0 });
  });

  it.each([
    [-1, 120, 42],
    [0, 120, 42],
    [375, 120, -1],
    [375, NaN, 42],
    [Infinity, 120, 42],
    [375, 120, Infinity],
  ])('rejects unusable frame dimensions (%s, %s, %s)', (width, height, metadataHeight) => {
    expect(exportPreviewSize(width, height, metadataHeight)).toEqual({ width: 0, height: 0 });
  });
});
