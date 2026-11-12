import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { sweepRnvtOutputs } from './cleanup';
import { emptyPulseState, validatePulseDocument, type PulseDocument } from './document';

jest.mock('expo-file-system', () => {
  const files = new Set<string>();
  const directories = new Set<string>();
  const failList = new Set<string>();
  const failDelete = new Set<string>();
  const uri = (parts: (string | { uri: string })[]) =>
    parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts);
    }
    get name() {
      return this.uri.split('/').pop()!;
    }
    delete() {
      if (failDelete.has(this.uri)) throw new Error('injected delete failure');
      files.delete(this.uri);
    }
  }
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts);
    }
    list() {
      if (failList.has(this.uri)) throw new Error('injected list failure');
      const immediate = (path: string) =>
        path.startsWith(this.uri + '/') && !path.slice(this.uri.length + 1).includes('/');
      return [
        ...[...files].filter(immediate).map((path) => new File(path)),
        ...[...directories].filter(immediate).map((path) => new Directory(path)),
      ];
    }
  }
  return {
    File,
    Directory,
    Paths: { document: 'doc', cache: 'cache' },
    __test: { files, directories, failList, failDelete },
  };
});

const fs = jest.requireMock('expo-file-system') as {
  __test: {
    files: Set<string>;
    directories: Set<string>;
    failList: Set<string>;
    failDelete: Set<string>;
  };
};

function document(): PulseDocument {
  const state = emptyPulseState();
  state.drafts.push({
    id: 'draft-a',
    name: 'Retained',
    uploadServer: null,
    uploadArtifactId: null,
    uploadStatus: null,
    contextServer: null,
    contextRef: null,
    mergedSignature: null,
    mergedDurationMs: null,
    captionY: null,
    lastClipNumber: 1,
    createdAt: 1,
    lastModified: 2,
  });
  state.segments.push({
    id: 'segment-a',
    draftId: 'draft-a',
    order: 0,
    label: '1',
    originalFilename: 'trimmedVideo-source.mov',
    durationMs: 1000,
    editedFilename: 'trimmedVideo-baked.mp4',
    editedDurationMs: 500,
    editState: null,
    thumbnail: null,
    captionEdit: null,
  });
  return {
    format: 'pulse-document',
    version: 2,
    scope: 'library',
    revision: 7,
    state,
    assets: [
      'trimmedVideo-source.mov',
      'trimmedVideo-baked.mp4',
      'trimmedVideo-retained-extra.bin',
      'nested/trimmedVideo-original.mov',
    ].map((path, index) => ({
      path,
      archivePath: `assets/${index}`,
      byteLength: 7,
      sha256: 'a'.repeat(64),
    })),
  };
}

beforeEach(() => {
  for (const values of Object.values(fs.__test)) values.clear();
});

describe('obsolete editor output cleanup', () => {
  it('preserves every canonical logical path, including unreferenced retained extras, and only removes unprotected prefixed files', () => {
    const canonical = document();
    expect(() => validatePulseDocument(canonical)).not.toThrow();
    for (const asset of canonical.assets) fs.__test.files.add(`doc/${asset.path}`);
    for (const path of [
      'doc/trimmedVideo-unused.mp4',
      'cache/trimmedVideo-unused.mov',
      'doc/ordinary.mov',
    ])
      fs.__test.files.add(path);
    fs.__test.directories.add('doc/trimmedVideo-directory');
    const before = JSON.stringify(canonical);
    expect(sweepRnvtOutputs(canonical)).toBe(2);
    for (const asset of canonical.assets)
      expect(fs.__test.files.has(`doc/${asset.path}`)).toBe(true);
    expect(fs.__test.files.has('doc/ordinary.mov')).toBe(true);
    expect(fs.__test.directories.has('doc/trimmedVideo-directory')).toBe(true);
    expect(fs.__test.files.has('doc/trimmedVideo-unused.mp4')).toBe(false);
    expect(fs.__test.files.has('cache/trimmedVideo-unused.mov')).toBe(false);
    expect(JSON.stringify(canonical)).toBe(before);
  });

  it('does not turn cache listing/deletion failures into canonical changes', () => {
    const canonical = document();
    fs.__test.files.add('doc/trimmedVideo-retained-extra.bin');
    fs.__test.files.add('cache/trimmedVideo-locked.mov');
    fs.__test.failList.add('doc');
    fs.__test.failDelete.add('cache/trimmedVideo-locked.mov');
    expect(sweepRnvtOutputs(canonical)).toBe(0);
    expect(fs.__test.files.has('doc/trimmedVideo-retained-extra.bin')).toBe(true);
    expect(fs.__test.files.has('cache/trimmedVideo-locked.mov')).toBe(true);
  });
});
