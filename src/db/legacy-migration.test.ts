import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { legacyDraftsImport } from './legacy-migration';

const mockWrites: { table: string; values: Record<string, unknown> }[] = [];
const mockControls = { failWrites: 0 };
jest.mock('./client', () => ({
  db: {
    insert: (table: string) => ({
      values: (values: Record<string, unknown>) => ({
        async onConflictDoNothing() {
          if (mockControls.failWrites > 0) {
            mockControls.failWrites--;
            throw new Error('injected canonical save failure');
          }
          mockWrites.push({ table, values });
        },
      }),
    }),
  },
}));
jest.mock('./schema', () => ({ drafts: 'drafts', segments: 'segments' }));
jest.mock('@react-native-async-storage/async-storage', () => {
  const values = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => values.get(key) ?? null),
      getAllKeys: jest.fn(async () => [...values.keys()]),
      multiRemove: jest.fn(async (keys: string[]) => {
        for (const key of keys) values.delete(key);
      }),
    },
    __test: { values },
  };
});
jest.mock('expo-file-system', () => {
  const files = new Map<string, Uint8Array>();
  const copies: { from: string; to: string }[] = [];
  const moves: string[] = [];
  const deletions: string[] = [];
  const uri = (parts: (string | { uri: string })[]) =>
    parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts);
    }
    get exists() {
      return files.has(this.uri);
    }
    async copy(destination: File) {
      const source = files.get(this.uri);
      if (!source) throw new Error('missing legacy media');
      files.set(destination.uri, source.slice());
      copies.push({ from: this.uri, to: destination.uri });
    }
    async move() {
      moves.push(this.uri);
      throw new Error('moving legacy media is forbidden');
    }
    delete() {
      deletions.push(this.uri);
      files.delete(this.uri);
    }
  }
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts);
    }
    get exists() {
      return true;
    }
    create() {}
    delete() {
      deletions.push(this.uri);
      for (const path of files.keys()) if (path.startsWith(this.uri + '/')) files.delete(path);
    }
  }
  return {
    File,
    Directory,
    Paths: { document: 'doc' },
    __test: { files, copies, moves, deletions },
  };
});
jest.mock('@/utils/file-store', () => ({
  absolutize: (path: string) => `doc/${path}`,
  thumbRelPath: (draft: string, segment: string) => `drafts/${draft}/segments/${segment}.thumb.jpg`,
  toFileUri: (path: string) => `file://${path}`,
}));
jest.mock('@/utils/video', () => ({
  generateThumbnailFile: jest.fn(async () => false),
  getDurationMs: jest.fn(async () => 1000),
}));

const oldStorage = jest.requireMock('@react-native-async-storage/async-storage') as {
  __test: { values: Map<string, string> };
};
const fs = jest.requireMock('expo-file-system') as {
  __test: {
    files: Map<string, Uint8Array>;
    copies: { from: string; to: string }[];
    moves: string[];
    deletions: string[];
  };
};

function fixture() {
  const oldDrafts = JSON.stringify([
    {
      id: 'legacy-a',
      name: 'Ancient draft',
      createdAt: 123,
      lastModified: 456,
      maxDurationLimitSeconds: 90,
      segments: [
        {
          id: 'clip-a',
          uri: 'pulse/drafts/legacy-a/segments/clip-a.mov',
          recordedDurationSeconds: 2.5,
          trimStartTimeMs: 12.5,
          trimEndTimeMs: 1320.75,
        },
      ],
    },
  ]);
  oldStorage.__test.values.set('recording_drafts', oldDrafts);
  oldStorage.__test.values.set(
    'upload_config_legacy-a',
    JSON.stringify({ server: 'https://old.test', token: 'legacy-bearer-never-put-in-yaml' }),
  );
  oldStorage.__test.values.set('redo_stack', '[{"original":"ancient redo metadata"}]');
  fs.__test.files.set(
    'doc/pulse/drafts/legacy-a/segments/clip-a.mov',
    new Uint8Array([7, 0, 255, 42]),
  );
  fs.__test.files.set('doc/pulse/unrepresented-legacy-extra.bin', new Uint8Array([13, 17]));
  return {
    oldValues: [...oldStorage.__test.values],
    originalBytes: fs.__test.files.get('doc/pulse/drafts/legacy-a/segments/clip-a.mov')!.slice(),
    extraBytes: fs.__test.files.get('doc/pulse/unrepresented-legacy-extra.bin')!.slice(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  mockWrites.length = 0;
  mockControls.failWrites = 0;
  oldStorage.__test.values.clear();
  fs.__test.files.clear();
  fs.__test.copies.length = 0;
  fs.__test.moves.length = 0;
  fs.__test.deletions.length = 0;
});

describe('ancient Pulse import retains its source', () => {
  it('copies selected media while retaining every original byte and unrepresented AsyncStorage field/key', async () => {
    const f = fixture();
    await legacyDraftsImport.run();
    expect(fs.__test.files.get('doc/pulse/drafts/legacy-a/segments/clip-a.mov')).toEqual(
      f.originalBytes,
    );
    expect(fs.__test.files.get('doc/drafts/legacy-a/segments/clip-a.mov')).toEqual(f.originalBytes);
    expect(fs.__test.files.get('doc/pulse/unrepresented-legacy-extra.bin')).toEqual(f.extraBytes);
    expect([...oldStorage.__test.values]).toEqual(f.oldValues);
    expect(AsyncStorage.getItem).toHaveBeenCalledTimes(1);
    expect(AsyncStorage.getItem).toHaveBeenCalledWith('recording_drafts');
    expect(AsyncStorage.getAllKeys).not.toHaveBeenCalled();
    expect(AsyncStorage.multiRemove).not.toHaveBeenCalled();
    expect(fs.__test.moves).toEqual([]);
    expect(fs.__test.deletions).toEqual([]);
    expect(mockWrites).toHaveLength(2);
    expect(mockWrites[1]).toMatchObject({
      table: 'segments',
      values: { originalFilename: 'drafts/legacy-a/segments/clip-a.mov', durationMs: 2500 },
    });
    expect(JSON.stringify(mockWrites)).not.toContain('legacy-bearer-never-put-in-yaml');
  });

  it('retains the old tree and records after a save failure, then retries without moving or recopying existing media', async () => {
    const f = fixture();
    mockControls.failWrites = 1;
    await expect(legacyDraftsImport.run()).rejects.toThrow('canonical save failure');
    expect([...oldStorage.__test.values]).toEqual(f.oldValues);
    expect(fs.__test.files.get('doc/pulse/drafts/legacy-a/segments/clip-a.mov')).toEqual(
      f.originalBytes,
    );
    expect(fs.__test.files.get('doc/pulse/unrepresented-legacy-extra.bin')).toEqual(f.extraBytes);
    expect(fs.__test.copies).toHaveLength(1);
    await legacyDraftsImport.run();
    expect(fs.__test.copies).toHaveLength(1);
    expect(mockWrites).toHaveLength(2);
    expect(fs.__test.moves).toEqual([]);
    expect(fs.__test.deletions).toEqual([]);
    expect([...oldStorage.__test.values]).toEqual(f.oldValues);
  });
});
