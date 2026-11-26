import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { Segment } from '@/db/schema';

// The draft row's saved-export columns and its `export.mp4` in memory; the merge itself stubbed.
const mockRow: { signature: string | null; durationMs: number | null; failClear: boolean } = {
  signature: null,
  durationMs: null,
  failClear: false,
};
const mockFile: { exists: boolean; from: string | null } = { exists: false, from: null };
const mockSegments: { list: Segment[] } = { list: [] };

const mockVoiceover = {
  takes: [] as import('@/db/schema').VoiceoverTake[],
  sourceMuted: false,
  voiceoverMuted: false,
};
jest.mock('@/db/voiceovers', () => ({ getVoiceover: async () => ({ ...mockVoiceover }) }));

jest.mock('@/db/drafts', () => ({
  segmentsForDraft: async () => mockSegments.list,
  getMergedExport: async () => ({ signature: mockRow.signature, durationMs: mockRow.durationMs }),
  setMergedExport: async (_id: string, m: { signature: string; durationMs: number } | null) => {
    if (m === null && mockRow.failClear) throw new Error('disk I/O error');
    mockRow.signature = m?.signature ?? null;
    mockRow.durationMs = m?.durationMs ?? null;
  },
  getDraftUploadStatus: async () => null,
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
jest.mock('@/features/recorder/recorder-format', () => ({ getRecorderFormat: async () => ({}) }));
jest.mock('./editor-merge', () => ({
  exportAudio: () => ({ sampleRate: 48000, channels: 1 }),
  mergeWithEditor: jest.fn(async () => ({ path: '/cache/m.mp4', durationMs: 1500 })),
}));

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { mergeWithEditor } from './editor-merge';
import { mergeForSend } from './send-merge';
/* eslint-enable import/first */

const seg = (id: string, over: Partial<Segment> = {}): Segment =>
  ({
    id,
    originalFilename: `${id}.mp4`,
    editedFilename: null,
    durationMs: 1000,
    ...over,
  }) as Segment;

beforeEach(() => {
  Object.assign(mockVoiceover, { takes: [], sourceMuted: false, voiceoverMuted: false });
  Object.assign(mockRow, { signature: null, durationMs: null, failClear: false });
  Object.assign(mockFile, { exists: false, from: null });
  jest.mocked(mergeWithEditor).mockClear();
});

describe('mergeForSend', () => {
  it('merges, saves the export and returns its length', async () => {
    mockSegments.list = [seg('a'), seg('b')];
    await expect(mergeForSend('d1')).resolves.toEqual({ durationMs: 1500 });
    expect(mockFile.from).toBe('/cache/m.mp4');
    // Sent again with the same clips: the saved export, no merge.
    await expect(mergeForSend('d1')).resolves.toEqual({ durationMs: 1500 });
    expect(mergeWithEditor).toHaveBeenCalledTimes(1);
  });

  it('includes saved track mutes in a Send and invalidates the earlier export', async () => {
    mockSegments.list = [seg('a')];
    await mergeForSend('d1');
    mockVoiceover.sourceMuted = true;
    await mergeForSend('d1');
    expect(mergeWithEditor).toHaveBeenCalledTimes(2);
    expect(jest.mocked(mergeWithEditor).mock.calls[1]?.[4]).toMatchObject({
      sourceMuted: true,
      voiceoverMuted: false,
      takes: [],
    });
  });

  it('fails when the new cut could not be saved over an earlier cut’s export', async () => {
    mockSegments.list = [seg('a'), seg('b')];
    jest
      .mocked(mergeWithEditor)
      .mockResolvedValueOnce({ path: '/cache/old.mp4', durationMs: 2000 });
    await mergeForSend('d1');
    // An edit, then a Send whose save fails: export.mp4 still holds the earlier cut.
    mockSegments.list = [seg('a', { editedFilename: 'a.edited.1.mp4' }), seg('b')];
    mockRow.failClear = true;
    await expect(mergeForSend('d1')).rejects.toThrow(/couldn't be saved/);
    expect(mockFile.from).toBe('/cache/old.mp4');
  });
});
