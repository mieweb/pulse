import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { Segment } from '@/db/schema';

// In-memory stand-ins for the draft row (`merged_signature` / `merged_duration_ms` /
// `upload_status`) and the `drafts/{id}/export.mp4` file.
const mockRow: {
  signature: string | null;
  durationMs: number | null;
  uploadStatus: string | null;
} = { signature: null, durationMs: null, uploadStatus: null };
const mockFile: { exists: boolean; from: string | null } = { exists: false, from: null };

jest.mock('@/db/drafts', () => ({
  getMergedExport: async () => ({ signature: mockRow.signature, durationMs: mockRow.durationMs }),
  setMergedExport: async (_id: string, m: { signature: string; durationMs: number } | null) => {
    mockRow.signature = m?.signature ?? null;
    mockRow.durationMs = m?.durationMs ?? null;
  },
  getDraftUploadStatus: async () => mockRow.uploadStatus,
}));
jest.mock('@/utils/file-store', () => ({
  absolutize: (p: string) => `file:///docs/${p}`,
  exportRelPath: (id: string) => `drafts/${id}/export.mp4`,
  exportFileExists: () => mockFile.exists,
  persistExportFile: async (id: string, from: string) => {
    mockFile.exists = true;
    mockFile.from = from;
    return `file:///docs/drafts/${id}/export.mp4`;
  },
}));

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { mergedSignature } from './merge-signature';
import { resolveMergedExport } from './merged-export';
/* eslint-enable import/first */

const EXPORT = 'file:///docs/drafts/d1/export.mp4';
const seg = (id: string, over: Partial<Segment> = {}): Segment =>
  ({
    id,
    originalFilename: `${id}.mp4`,
    editedFilename: null,
    durationMs: 1000,
    ...over,
  }) as Segment;
const clips = [seg('a'), seg('b')];

const mergeTo = (path: string, durationMs = 2000) => jest.fn(async () => ({ path, durationMs }));

beforeEach(() => {
  Object.assign(mockRow, { signature: null, durationMs: null, uploadStatus: null });
  Object.assign(mockFile, { exists: false, from: null });
});

describe('resolveMergedExport', () => {
  it('merges once and persists the result when nothing is stored', async () => {
    const merge = mergeTo('/cache/m1.mp4');
    await expect(resolveMergedExport('d1', clips, merge)).resolves.toEqual({
      path: EXPORT,
      durationMs: 2000,
    });
    expect(merge).toHaveBeenCalledTimes(1);
    expect(mockFile.from).toBe('/cache/m1.mp4');
    expect(mockRow).toMatchObject({ signature: mergedSignature(clips), durationMs: 2000 });
  });

  it('reuses the stored export for unchanged clips — no merge', async () => {
    await resolveMergedExport('d1', clips, mergeTo('/cache/m1.mp4'));
    const merge = mergeTo('/cache/m2.mp4');
    await expect(resolveMergedExport('d1', [seg('a'), seg('b')], merge)).resolves.toEqual({
      path: EXPORT,
      durationMs: 2000,
    });
    expect(merge).not.toHaveBeenCalled();
  });

  it('merges exactly once again after the clips change', async () => {
    await resolveMergedExport('d1', clips, mergeTo('/cache/m1.mp4'));
    const trimmed = [seg('a', { editedFilename: 'a.edited.1.mp4' }), seg('b')];
    const merge = mergeTo('/cache/m2.mp4', 1500);
    await resolveMergedExport('d1', trimmed, merge);
    await resolveMergedExport('d1', trimmed, merge);
    expect(merge).toHaveBeenCalledTimes(1);
    expect(mockRow).toMatchObject({ signature: mergedSignature(trimmed), durationMs: 1500 });
  });

  // Undoing edits restores the exact effective files, so the saved video is reused.
  it.each([
    ['reordering back', [seg('b'), seg('a')]],
    ['resetting a trim', [seg('a', { editedFilename: 'a.edited.1.mp4' }), seg('b')]],
    ['deleting an added clip', [seg('a'), seg('b'), seg('c')]],
  ])('reuses the export after %s', async (_label, edited) => {
    await resolveMergedExport('d1', clips, mergeTo('/cache/m1.mp4'));
    // The edited arrangement is never exported (the user goes straight back), then undone.
    expect(mergedSignature(edited)).not.toBe(mergedSignature(clips));
    const merge = mergeTo('/cache/m2.mp4');
    await expect(resolveMergedExport('d1', [seg('a'), seg('b')], merge)).resolves.toEqual({
      path: EXPORT,
      durationMs: 2000,
    });
    expect(merge).not.toHaveBeenCalled();
  });

  it('only remembers the last merge — an exported edit replaces it', async () => {
    await resolveMergedExport('d1', clips, mergeTo('/cache/m1.mp4'));
    await resolveMergedExport('d1', [seg('b'), seg('a')], mergeTo('/cache/m2.mp4'));
    const merge = mergeTo('/cache/m3.mp4');
    await resolveMergedExport('d1', clips, merge);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it('re-merges when the stored file is gone', async () => {
    await resolveMergedExport('d1', clips, mergeTo('/cache/m1.mp4'));
    mockFile.exists = false;
    const merge = mergeTo('/cache/m2.mp4');
    await resolveMergedExport('d1', clips, merge);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it('never replaces the export while the draft is uploading', async () => {
    mockRow.uploadStatus = 'uploading';
    await expect(resolveMergedExport('d1', clips, mergeTo('/cache/m1.mp4'))).resolves.toEqual({
      path: '/cache/m1.mp4',
      durationMs: 2000,
    });
    expect(mockFile.from).toBeNull();
    expect(mockRow.signature).toBeNull();
  });
});
