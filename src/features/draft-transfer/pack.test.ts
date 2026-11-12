import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { flushDraftWrites } from '@/features/editor/draft-writes';
import { decodePulseArchive, pulseAssetSha256 } from '@/pulse/archive';
import { emptyPulseState, type PulseDocument } from '@/pulse/document';
import { getPulseDocument, readCanonicalPulseAsset } from '@/pulse/runtime';
import { exportDrafts, exportPulseLibrary } from './pack';

jest.mock('expo-crypto', () => ({ randomUUID: () => 'share-uuid' }));
jest.mock('expo-file-system', () => {
  const files = new Map<string, Uint8Array>();
  const uri = (parts: (string | { uri: string })[]) =>
    parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts);
    }
    create() {}
  }
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts);
    }
    write(bytes: Uint8Array) {
      files.set(this.uri, bytes.slice());
    }
  }
  return { Directory, File, Paths: { cache: 'cache' }, __files: files };
});
jest.mock('@/features/editor/draft-writes', () => ({ flushDraftWrites: jest.fn() }));
jest.mock('@/pulse/runtime', () => ({
  getPulseDocument: jest.fn(),
  readCanonicalPulseAsset: jest.fn(),
}));

const files = (jest.requireMock('expo-file-system') as { __files: Map<string, Uint8Array> })
  .__files;
let document: PulseDocument;
let media: Map<string, Uint8Array>;
beforeEach(() => {
  files.clear();
  const state = emptyPulseState();
  state.drafts.push({
    id: 'selected',
    name: 'Renamed',
    uploadServer: null,
    uploadArtifactId: null,
    uploadStatus: null,
    contextServer: null,
    contextRef: null,
    mergedSignature: null,
    mergedDurationMs: null,
    captionY: 0.37,
    lastClipNumber: 12,
    createdAt: 7,
    lastModified: 9,
  });
  state.drafts.push({ ...state.drafts[0], id: 'empty' });
  state.segments.push({
    id: 'clip',
    draftId: 'selected',
    order: 4,
    label: 'custom',
    originalFilename: 'drafts/selected/original.mov',
    durationMs: 3.75,
    editedFilename: 'drafts/selected/baked.mp4',
    editedDurationMs: 2.5,
    editState: 'invalid legacy settings',
    thumbnail: null,
    captionEdit: 'invalid correction text',
  });
  state.settings.push({ key: 'theme', value: 'dark' });
  media = new Map([
    ['drafts/selected/original.mov', new Uint8Array([1, 2])],
    ['drafts/selected/baked.mp4', new Uint8Array([3, 4])],
    ['unused/retained.mov', new Uint8Array([5, 6])],
  ]);
  document = {
    format: 'pulse-document',
    version: 2,
    scope: 'library',
    revision: 12,
    state,
    assets: [...media].map(([path, bytes]) => ({
      path,
      archivePath: `assets/${pulseAssetSha256(bytes)}`,
      byteLength: bytes.length,
      sha256: pulseAssetSha256(bytes),
    })),
  };
  jest.mocked(flushDraftWrites).mockReset().mockResolvedValue(undefined);
  jest
    .mocked(getPulseDocument)
    .mockReset()
    .mockImplementation(() => JSON.parse(JSON.stringify(document)));
  jest
    .mocked(readCanonicalPulseAsset)
    .mockReset()
    .mockImplementation((path: string) => {
      const bytes = media.get(path);
      if (!bytes) throw new Error('Missing canonical media');
      return bytes;
    });
});

describe('canonical v2 exports', () => {
  it('exports original and selected baked media together with invalid historical settings', async () => {
    const uri = await exportDrafts(['selected', 'empty'], 123);
    const decoded = decodePulseArchive(files.get(uri)!);
    expect(decoded.document.scope).toBe('selection');
    expect(decoded.document.state).toEqual(document.state);
    expect([...decoded.assets.keys()]).toEqual([
      'drafts/selected/original.mov',
      'drafts/selected/baked.mp4',
    ]);
    expect(readCanonicalPulseAsset).toHaveBeenCalledTimes(2);
  });

  it('exports a library snapshot with every descriptor and global row for exact restore', async () => {
    const uri = await exportPulseLibrary(123);
    const decoded = decodePulseArchive(files.get(uri)!);
    expect(decoded.document).toEqual(document);
    expect(decoded.assets).toEqual(media);
  });

  it('aborts rather than skipping unavailable media or acknowledging failed queued writes', async () => {
    media.delete('drafts/selected/baked.mp4');
    await expect(exportDrafts(['selected'], 123)).rejects.toThrow('Missing canonical media');
    expect(files.size).toBe(0);
    jest.mocked(flushDraftWrites).mockRejectedValueOnce(new Error('Newest edit failed'));
    jest.mocked(getPulseDocument).mockClear();
    await expect(exportPulseLibrary(124)).rejects.toThrow('Newest edit failed');
    expect(getPulseDocument).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });
});
