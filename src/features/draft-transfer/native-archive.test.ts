import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { pulseAssetSha256, type DecodedPulseArchive } from '@/pulse/archive';
import { emptyPulseState, type PulseDocument, type PulseState } from '@/pulse/document';
import {
  commitPulseState,
  getPulseDocument,
  getPulsePublicationGeneration,
  restorePulseDocument,
} from '@/pulse/runtime';
import { importPulseArchiveCopy, restoreDecodedPulseArchive } from './native-archive';

jest.mock('expo-crypto', () => {
  let sequence = 0;
  return { randomUUID: () => `uuid-${++sequence}` };
});
jest.mock('expo-file-system', () => {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const controls: {
    failCopyTo: string | null;
    afterCopy: (() => void) | null;
    failCleanup: boolean;
  } = {
    failCopyTo: null,
    afterCopy: null,
    failCleanup: false,
  };
  const uri = (parts: (string | { uri: string })[]) =>
    parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts);
    }
    get exists() {
      return directories.has(this.uri);
    }
    create() {
      directories.add(this.uri);
    }
    delete() {
      if (controls.failCleanup) throw new Error('Injected cache cleanup failure');
      for (const name of files.keys()) if (name.startsWith(`${this.uri}/`)) files.delete(name);
      directories.delete(this.uri);
    }
  }
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts);
    }
    get exists() {
      return files.has(this.uri);
    }
    get parentDirectory() {
      return new Directory(this.uri.slice(0, this.uri.lastIndexOf('/')));
    }
    write(bytes: Uint8Array) {
      files.set(this.uri, bytes.slice());
    }
    delete() {
      files.delete(this.uri);
    }
    async copy(destination: File) {
      if (controls.failCopyTo && destination.uri.endsWith(controls.failCopyTo))
        throw new Error('Injected working copy failure');
      const bytes = files.get(this.uri);
      if (!bytes) throw new Error('Missing copy source');
      files.set(destination.uri, bytes.slice());
      const callback = controls.afterCopy;
      controls.afterCopy = null;
      callback?.();
    }
  }
  return {
    File,
    Directory,
    Paths: { document: 'doc', cache: 'cache' },
    __test: { files, directories, controls },
  };
});
jest.mock('@/pulse/runtime', () => ({
  getPulseDocument: jest.fn(),
  commitPulseState: jest.fn(),
  restorePulseDocument: jest.fn(),
  getPulsePublicationGeneration: jest.fn(),
}));

const fs = jest.requireMock('expo-file-system') as {
  __test: {
    files: Map<string, Uint8Array>;
    directories: Set<string>;
    controls: { failCopyTo: string | null; afterCopy: (() => void) | null; failCleanup: boolean };
  };
};
let current: PulseDocument;
let publicationGeneration: number;
function fixture(): DecodedPulseArchive {
  const state = emptyPulseState();
  state.drafts.push({
    id: 'old-draft',
    name: 'Renamed',
    uploadServer: 'server',
    uploadArtifactId: 'artifact',
    uploadStatus: 'uploaded',
    contextServer: 'server',
    contextRef: 'visit',
    mergedSignature: 'merge',
    mergedDurationMs: 2,
    captionY: 0.4,
    lastClipNumber: 12,
    createdAt: 7,
    lastModified: 9,
  });
  state.segments.push({
    id: 'old-clip',
    draftId: 'old-draft',
    order: 4,
    label: 'custom',
    originalFilename: 'drafts/old/original.mov',
    durationMs: 3.75,
    editedFilename: 'drafts/old/baked.mp4',
    editedDurationMs: 2.5,
    editState: 'invalid legacy settings',
    thumbnail: null,
    captionEdit: 'invalid legacy correction',
  });
  state.settings.push({ key: 'theme', value: 'foreign' });
  const assets = new Map([
    ['drafts/old/original.mov', new Uint8Array([1, 2, 3])],
    ['drafts/old/baked.mp4', new Uint8Array([4, 5])],
  ]);
  return {
    document: {
      format: 'pulse-document',
      version: 2,
      scope: 'library',
      revision: 88,
      state,
      assets: [...assets].map(([path, bytes]) => ({
        path,
        archivePath: `assets/${pulseAssetSha256(bytes)}`,
        sha256: pulseAssetSha256(bytes),
        byteLength: bytes.length,
      })),
    },
    assets,
  };
}

beforeEach(() => {
  fs.__test.files.clear();
  fs.__test.directories.clear();
  fs.__test.controls.failCopyTo = null;
  fs.__test.controls.afterCopy = null;
  fs.__test.controls.failCleanup = false;
  current = {
    format: 'pulse-document',
    version: 2,
    scope: 'library',
    revision: 1,
    state: emptyPulseState(),
    assets: [],
  };
  current.state.settings.push({ key: 'theme', value: 'local' });
  publicationGeneration = 1;
  jest.mocked(getPulsePublicationGeneration).mockImplementation(() => publicationGeneration);
  jest.mocked(getPulseDocument).mockImplementation(() => JSON.parse(JSON.stringify(current)));
  jest.mocked(commitPulseState).mockReset();
  jest.mocked(commitPulseState).mockImplementation((state: PulseState) => {
    publicationGeneration++;
    current = {
      ...current,
      revision: current.revision + 1,
      state: JSON.parse(JSON.stringify(state)),
    };
    return JSON.parse(JSON.stringify(current));
  });
  jest.mocked(restorePulseDocument).mockReset();
  jest
    .mocked(restorePulseDocument)
    .mockImplementation(
      (
        document: PulseDocument,
        expectedGeneration?: number,
        assets?: ReadonlyMap<string, Uint8Array>,
      ) => {
        if (expectedGeneration !== undefined && expectedGeneration !== publicationGeneration)
          throw new Error('Pulse publication generation changed');
        current = JSON.parse(JSON.stringify(document));
        publicationGeneration++;
        // Simulate the runtime's post-publication materialization, after its canonical callback.
        for (const [path, bytes] of assets ?? []) fs.__test.files.set(`doc/${path}`, bytes.slice());
        return JSON.parse(JSON.stringify(current));
      },
    );
});

describe('native v2 copy and exact-state restore', () => {
  it('copies all media before one canonical commit, keeps local preferences, and merges concurrent changes', async () => {
    const source = fixture();
    fs.__test.controls.afterCopy = () => {
      current.state.settings.push({ key: 'concurrent', value: 'committed during IO' });
    };
    const ids = await importPulseArchiveCopy(source);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe('old-draft');
    expect(commitPulseState).toHaveBeenCalledTimes(1);
    expect(current.state.settings).toEqual([
      { key: 'theme', value: 'local' },
      { key: 'concurrent', value: 'committed during IO' },
    ]);
    expect(current.state.segments[0].editState).toBe('invalid legacy settings');
    for (const field of ['originalFilename', 'editedFilename'] as const) {
      const path = current.state.segments[0][field]!;
      expect(fs.__test.files.get(`doc/${path}`)).toEqual(
        source.assets.get(source.document.state.segments[0][field]!),
      );
    }
    expect([...fs.__test.files.keys()].every((path) => path.startsWith('doc/imports/'))).toBe(true);
  });

  it('restores every state value and exact bytes without minting identities or normalizing media', async () => {
    const source = fixture();
    const result = await restoreDecodedPulseArchive(source);
    expect(result).toEqual(source.document);
    for (const [path, bytes] of source.assets)
      expect(fs.__test.files.get(`doc/${path}`)).toEqual(bytes);
  });

  it('leaves all working bytes intact after an immutable-canonical restore failure', async () => {
    const source = fixture();
    const original = new Uint8Array([99, 98]);
    fs.__test.files.set('doc/drafts/old/original.mov', original);
    jest.mocked(restorePulseDocument).mockImplementation(() => {
      throw new Error('Injected canonical failure');
    });
    await expect(restoreDecodedPulseArchive(source)).rejects.toThrow('canonical failure');
    expect(fs.__test.files.get('doc/drafts/old/original.mov')).toEqual(original);
    expect(fs.__test.files.has('doc/drafts/old/baked.mp4')).toBe(false);
    expect(current.state.drafts).toEqual([]);
  });

  it('does not commit a copy if installing media fails, and preserves the previous library files', async () => {
    const source = fixture();
    fs.__test.files.set('doc/drafts/old/original.mov', new Uint8Array([99]));
    fs.__test.controls.failCopyTo = '/baked.mp4';
    await expect(importPulseArchiveCopy(source)).rejects.toThrow('working copy failure');
    expect(commitPulseState).not.toHaveBeenCalled();
    expect(fs.__test.files.get('doc/drafts/old/original.mov')).toEqual(new Uint8Array([99]));
    expect(fs.__test.files.size).toBe(1);
  });

  it('rejects corrupt bytes and reserved paths before writing any working file', async () => {
    const source = fixture();
    source.assets.set('drafts/old/original.mov', new Uint8Array([8, 8, 8]));
    await expect(restoreDecodedPulseArchive(source)).rejects.toThrow('checksum mismatch');
    expect(fs.__test.files.size).toBe(0);
    const reserved = fixture();
    const asset = reserved.document.assets[0];
    reserved.document.state.segments[0].originalFilename = 'library.pulse/pulse-0.yaml';
    reserved.assets.set('library.pulse/pulse-0.yaml', reserved.assets.get(asset.path)!);
    reserved.assets.delete(asset.path);
    asset.path = 'library.pulse/pulse-0.yaml';
    await expect(restoreDecodedPulseArchive(reserved)).rejects.toThrow(
      'reserved application directory',
    );
    expect(fs.__test.files.size).toBe(0);
  });

  it('does not erase a committed copy or report failure when transient staging cleanup fails', async () => {
    const source = fixture();
    fs.__test.controls.failCleanup = true;
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await importPulseArchiveCopy(source);
      expect(result).toEqual([current.state.drafts[0].id]);
      for (const field of ['originalFilename', 'editedFilename'] as const) {
        expect(fs.__test.files.get(`doc/${current.state.segments[0][field]}`)).toEqual(
          source.assets.get(source.document.state.segments[0][field]!),
        );
      }
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it('refuses to replace the library with a narrower selection archive', async () => {
    const source = fixture();
    source.document.scope = 'selection';
    await expect(restoreDecodedPulseArchive(source)).rejects.toThrow('requires a library snapshot');
    expect(restorePulseDocument).not.toHaveBeenCalled();
    expect(fs.__test.files.size).toBe(0);
  });

  it('rejects a change acknowledged during archive reads even when the document revision repeats', async () => {
    const source = fixture();
    const previous = new Uint8Array([99, 98]);
    fs.__test.files.set('doc/drafts/old/original.mov', previous);
    const expectedGeneration = publicationGeneration;
    publicationGeneration++;
    current.state.settings.push({ key: 'concurrent', value: 'acknowledged' });
    await expect(restoreDecodedPulseArchive(source, expectedGeneration)).rejects.toThrow(
      'publication generation changed',
    );
    expect(restorePulseDocument).toHaveBeenCalledWith(source.document, 1, source.assets);
    expect(current.revision).toBe(1);
    expect(current.state.settings).toContainEqual({ key: 'concurrent', value: 'acknowledged' });
    expect(fs.__test.files.get('doc/drafts/old/original.mov')).toEqual(previous);
    expect(fs.__test.files.has('doc/drafts/old/baked.mp4')).toBe(false);
  });

  it('passes verified bytes to the canonical restore without replacing working media first', async () => {
    const source = fixture();
    const previous = new Uint8Array([99, 98]);
    fs.__test.files.set('doc/drafts/old/original.mov', previous);
    jest.mocked(restorePulseDocument).mockImplementation((document, generation, assets) => {
      expect(generation).toBe(1);
      expect(assets).toEqual(source.assets);
      expect(fs.__test.files.get('doc/drafts/old/original.mov')).toEqual(previous);
      expect(fs.__test.files.has('doc/drafts/old/baked.mp4')).toBe(false);
      expect(fs.__test.files.size).toBe(1);
      expect(fs.__test.directories.size).toBe(0);
      return document;
    });
    await expect(restoreDecodedPulseArchive(source)).resolves.toEqual(source.document);
  });
});
