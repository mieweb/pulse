import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Directory, File } from 'expo-file-system';

import { emptyPulseState, type PulseState } from './document';
import { hashPulseFile, NativePulseStorage } from './file-storage';
import { PulseRepository } from './repository';

// Exercise real file contents/renames with the narrow Expo API used by this storage.
// This does not establish the native OS's power-loss/fsync guarantees.
jest.mock('expo-file-system', () => {
  const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
  const path = jest.requireActual<typeof import('node:path')>('node:path');
  const { fileURLToPath, pathToFileURL } =
    jest.requireActual<typeof import('node:url')>('node:url');
  let fault: { operation: string; suffix: string } | null = null;
  const stats = { openHandles: 0, readSizes: [] as number[] };

  function check(operation: string, filename: string): void {
    if (fault?.operation === operation && filename.endsWith(fault.suffix)) {
      fault = null;
      throw new Error(`Injected ${operation} failure`);
    }
  }

  function location(parts: (string | { uri: string })[]): string {
    return path.join(
      ...parts.map((part) => {
        const value = typeof part === 'string' ? part : part.uri;
        return value.startsWith('file:') ? fileURLToPath(value) : value;
      }),
    );
  }

  class MockDirectory {
    readonly diskPath: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.diskPath = location(parts);
    }
    get uri() {
      return pathToFileURL(this.diskPath).href;
    }
    get name() {
      return path.basename(this.diskPath);
    }
    get exists() {
      return fs.existsSync(this.diskPath) && fs.statSync(this.diskPath).isDirectory();
    }
    create(options: { intermediates?: boolean; idempotent?: boolean } = {}) {
      if (this.exists && options.idempotent) return;
      fs.mkdirSync(this.diskPath, { recursive: options.intermediates ?? false });
    }
    list() {
      return fs.readdirSync(this.diskPath).map((name) => {
        const child = path.join(this.diskPath, name);
        return fs.statSync(child).isDirectory() ? new MockDirectory(child) : new MockFile(child);
      });
    }
  }

  class MockFile {
    diskPath: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.diskPath = location(parts);
    }
    get uri() {
      return pathToFileURL(this.diskPath).href;
    }
    get name() {
      return path.basename(this.diskPath);
    }
    get exists() {
      return fs.existsSync(this.diskPath) && fs.statSync(this.diskPath).isFile();
    }
    get size() {
      return fs.statSync(this.diskPath).size;
    }
    get parentDirectory() {
      return new MockDirectory(path.dirname(this.diskPath));
    }
    info() {
      const stat = fs.statSync(this.diskPath);
      return { size: stat.size, modificationTime: stat.mtimeMs };
    }
    write(content: string | Uint8Array) {
      check('write', this.diskPath);
      fs.writeFileSync(this.diskPath, content);
    }
    textSync() {
      return fs.readFileSync(this.diskPath, 'utf8');
    }
    delete() {
      check('delete', this.diskPath);
      fs.unlinkSync(this.diskPath);
    }
    copySync(target: MockFile, options: { overwrite?: boolean } = {}) {
      check('copy', target.diskPath);
      fs.copyFileSync(
        this.diskPath,
        target.diskPath,
        options.overwrite ? 0 : fs.constants.COPYFILE_EXCL,
      );
    }
    moveSync(target: MockFile) {
      check('move', this.diskPath);
      fs.renameSync(this.diskPath, target.diskPath);
      this.diskPath = target.diskPath;
    }
    open() {
      const file = this;
      const fd = fs.openSync(this.diskPath, 'r');
      let offset = 0;
      let closed = false;
      stats.openHandles++;
      return {
        get offset() {
          return offset;
        },
        get size() {
          return fs.fstatSync(fd).size;
        },
        readBytes(count: number) {
          check('read', file.diskPath);
          stats.readSizes.push(count);
          const bytes = Buffer.alloc(count);
          const read = fs.readSync(fd, bytes, 0, count, offset);
          offset += read;
          return new Uint8Array(bytes.subarray(0, read));
        },
        close() {
          if (!closed) {
            fs.closeSync(fd);
            stats.openHandles--;
            closed = true;
          }
        },
      };
    }
  }

  return {
    File: MockFile,
    Directory: MockDirectory,
    FileMode: { ReadOnly: 'r' },
    Paths: { document: '/unused-test-document-root' },
    __setFault(operation: string, suffix: string) {
      fault = { operation, suffix };
    },
    __reset() {
      fault = null;
      stats.readSizes = [];
    },
    __stats: stats,
  };
});

type MockFilesystem = {
  __setFault(operation: string, suffix: string): void;
  __reset(): void;
  __stats: { openHandles: number; readSizes: number[] };
};
const mockFilesystem = jest.requireMock<MockFilesystem>('expo-file-system');

function stateWithSource(): PulseState {
  const state = emptyPulseState();
  state.drafts.push({
    id: 'draft',
    name: 'Original',
    uploadServer: null,
    uploadArtifactId: null,
    uploadStatus: null,
    contextServer: null,
    contextRef: null,
    mergedSignature: null,
    mergedDurationMs: null,
    captionY: null,
    lastClipNumber: 1,
    createdAt: 123,
    lastModified: 456,
  });
  state.segments.push({
    id: 'clip',
    draftId: 'draft',
    order: 0,
    label: '1',
    originalFilename: 'original.mp4',
    durationMs: 1000,
    editedFilename: null,
    editedDurationMs: null,
    editState: null,
    thumbnail: null,
    captionEdit: null,
  });
  return state;
}

describe('native Pulse package files', () => {
  let temp: string;
  let packagePath: string;
  let workingPath: string;
  let storage: NativePulseStorage;
  const source = Buffer.from('immutable original bytes — 日本語 🫀');

  beforeEach(() => {
    mockFilesystem.__reset();
    temp = mkdtempSync(join(tmpdir(), 'pulse-native-storage-'));
    packagePath = join(temp, 'library.pulse');
    workingPath = join(temp, 'documents');
    const working = new Directory(workingPath);
    working.create();
    writeFileSync(join(workingPath, 'original.mp4'), source);
    storage = new NativePulseStorage(new Directory(packagePath), working);
  });

  afterEach(() => {
    expect(mockFilesystem.__stats.openHandles).toBe(0);
    rmSync(temp, { recursive: true, force: true });
  });

  function saved() {
    const repository = new PulseRepository(storage);
    expect(repository.load()).toBeNull();
    const state = stateWithSource();
    const document = repository.commit(state);
    return { repository, state, document };
  }

  it('hashes real bytes in bounded chunks and always closes the file', () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 123, 0x61);
    writeFileSync(join(workingPath, 'large.mp4'), bytes);
    expect(hashPulseFile(new File(workingPath, 'large.mp4'))).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(mockFilesystem.__stats.readSizes).toEqual([1024 * 1024, 1024 * 1024, 123]);
    mockFilesystem.__setFault('read', 'large.mp4');
    expect(() => hashPulseFile(new File(workingPath, 'large.mp4'))).toThrow(
      'Injected read failure',
    );
    expect(mockFilesystem.__stats.openHandles).toBe(0);
  });

  it('publishes YAML plus immutable assets and reloads the exact saved document', () => {
    const { document } = saved();
    expect(document.assets).toHaveLength(1);
    expect(readFileSync(join(packagePath, document.assets[0].archivePath))).toEqual(source);
    expect(readdirSync(packagePath)).toContain('pulse-1.commit');
    expect(new PulseRepository(storage).load()).toEqual(document);
  });

  it('avoids rereading video for a warm metadata save but fully hashes it on load', () => {
    const { repository, state, document } = saved();
    mockFilesystem.__reset();
    state.drafts[0].name = 'Rename only';
    repository.commit(state);
    expect(mockFilesystem.__stats.readSizes).toEqual([]);
    new PulseRepository(storage).load();
    expect(mockFilesystem.__stats.readSizes.reduce((total, size) => total + size, 0)).toBe(
      source.length,
    );
    const archived = join(packagePath, document.assets[0].archivePath);
    writeFileSync(archived, Buffer.alloc(source.length, 0x78));
    utimesSync(archived, new Date(), new Date(Date.now() + 10_000));
    state.drafts[0].name = 'Must detect the changed canonical file';
    expect(() => repository.commit(state)).toThrow(/missing or damaged/);
  });

  it('shares one content-addressed file when distinct source paths have identical bytes', () => {
    const repository = new PulseRepository(storage);
    repository.load();
    writeFileSync(join(workingPath, 'duplicate.mp4'), source);
    const state = stateWithSource();
    state.segments.push({
      ...state.segments[0],
      id: 'second',
      order: 1,
      originalFilename: 'duplicate.mp4',
    });
    const document = repository.commit(state);
    expect(document.assets).toHaveLength(2);
    expect(new Set(document.assets.map((asset) => asset.archivePath)).size).toBe(1);
    expect(readdirSync(join(packagePath, 'assets'))).toHaveLength(1);
    expect(new PulseRepository(storage).load()).toEqual(document);
  });

  it('recovers missing working sources from verified canonical bytes', () => {
    const { repository, state } = saved();
    unlinkSync(join(workingPath, 'original.mp4'));
    state.drafts[0].name = 'Metadata-only update';
    const next = repository.commit(state);
    const recovered = new PulseRepository(storage);
    expect(recovered.load()).toEqual(next);
    recovered.materialize();
    expect(readFileSync(join(workingPath, 'original.mp4'))).toEqual(source);
  });

  it('never promotes changed working original bytes into canonical state during an unrelated edit', () => {
    const { repository, state, document } = saved();
    writeFileSync(join(workingPath, 'original.mp4'), 'damaged disposable working original');
    state.drafts[0].name = 'Rename with damaged working files';
    const next = repository.commit(state);
    expect(next.assets).toEqual(document.assets);
    const reopened = new PulseRepository(storage);
    expect(reopened.load()).toEqual(next);
    reopened.materialize();
    expect(readFileSync(join(workingPath, 'original.mp4'))).toEqual(source);
  });

  it('rejects same-size corruption before reusing a canonical target for a new save', () => {
    const { repository, state, document } = saved();
    writeFileSync(
      join(packagePath, document.assets[0].archivePath),
      Buffer.alloc(source.length, 0x78),
    );
    state.drafts[0].name = 'Must not be acknowledged';
    expect(() => repository.commit(state)).toThrow(/missing or damaged/);
    expect(repository.getDocument()?.revision).toBe(1);
    expect(readdirSync(packagePath)).not.toContain('pulse-0.commit');
  });

  it('also verifies archived fallbacks when the working source is missing', () => {
    const { repository, state, document } = saved();
    unlinkSync(join(workingPath, 'original.mp4'));
    writeFileSync(
      join(packagePath, document.assets[0].archivePath),
      Buffer.alloc(source.length, 0x78),
    );
    state.drafts[0].name = 'Must not be acknowledged';
    expect(() => repository.commit(state)).toThrow(/missing or damaged/);
    expect(repository.getDocument()?.revision).toBe(1);
  });

  it('does not publish when initial asset staging fails and retains recovery evidence', () => {
    const repository = new PulseRepository(storage);
    repository.load();
    mockFilesystem.__setFault('copy', '.tmp');
    expect(() => repository.commit(stateWithSource())).toThrow(/Injected copy failure/);
    expect(repository.getDocument()).toBeNull();
    expect(readdirSync(packagePath)).not.toContain('pulse-1.commit');
    expect(() => new PulseRepository(storage).load()).toThrow(/no committed revision/);
    expect(readFileSync(join(workingPath, 'original.mp4'))).toEqual(source);
  });

  it('resumes a marked, unacknowledged initial upgrade after asset or publication failure', () => {
    const repository = new PulseRepository(storage);
    repository.load();
    repository.beginInitialMigration();
    mockFilesystem.__setFault('copy', '.tmp');
    expect(() => repository.commit(stateWithSource())).toThrow(/Injected copy failure/);
    const restarted = new PulseRepository(storage);
    expect(restarted.load()).toBeNull();
    restarted.beginInitialMigration();
    mockFilesystem.__setFault('move', 'pulse-1.commit.tmp');
    expect(() => restarted.commit(stateWithSource())).toThrow(/Injected move failure/);
    const retry = new PulseRepository(storage);
    expect(retry.load()).toBeNull();
    retry.beginInitialMigration();
    const committed = retry.commit(stateWithSource());
    expect(readdirSync(packagePath)).not.toContain('initial-upgrade.json');
    expect(new PulseRepository(storage).load()).toEqual(committed);
    unlinkSync(join(packagePath, 'pulse-1.commit'));
    // Once acknowledged, losing canonical files must never reseed from the old database.
    expect(() => new PulseRepository(storage).load()).toThrow(/no committed revision/);
  });

  it('retries initial-marker staging before any source media has been captured', () => {
    const repository = new PulseRepository(storage);
    repository.load();
    mockFilesystem.__setFault('move', 'initial-upgrade.json.tmp');
    expect(() => repository.beginInitialMigration()).toThrow(/Injected move failure/);
    const retry = new PulseRepository(storage);
    expect(retry.load()).toBeNull();
    retry.beginInitialMigration();
    expect(retry.commit(stateWithSource()).revision).toBe(1);
  });

  it('keeps the committed first capture if final initial-marker retirement fails, then retries retirement', () => {
    const repository = new PulseRepository(storage);
    repository.load();
    repository.beginInitialMigration();
    mockFilesystem.__setFault('delete', 'initial-upgrade.json');
    expect(() => repository.commit(stateWithSource())).toThrow(/Injected delete failure/);
    const restarted = new PulseRepository(storage);
    const committed = restarted.load();
    expect(committed?.state).toEqual(stateWithSource());
    restarted.finishInitialMigration();
    expect(readdirSync(packagePath)).not.toContain('initial-upgrade.json');
    expect(readFileSync(join(workingPath, 'original.mp4'))).toEqual(source);
  });

  it.each([
    ['write', 'pulse-0.yaml.tmp'],
    ['write', 'pulse-0.commit.tmp'],
    ['move', 'pulse-0.yaml.tmp'],
    ['move', 'pulse-0.commit.tmp'],
  ])('retains the last acknowledged revision after %s failure at %s', (operation, suffix) => {
    const { repository, state, document } = saved();
    state.drafts[0].name = 'Interrupted update';
    mockFilesystem.__setFault(operation, suffix);
    expect(() => repository.commit(state)).toThrow(/Injected/);
    expect(repository.getDocument()).toEqual(document);
    const restarted = new PulseRepository(
      new NativePulseStorage(new Directory(packagePath), new Directory(workingPath)),
    );
    expect(restarted.load()).toEqual(document);
    expect(restarted.commit(state).revision).toBe(2);
  });

  it('retains the other slot when replacing an older committed slot is interrupted', () => {
    const { repository, state } = saved();
    state.drafts[0].name = 'Revision 2';
    const second = repository.commit(state);
    state.drafts[0].name = 'Interrupted revision 3';
    mockFilesystem.__setFault('move', 'pulse-1.commit.tmp');
    expect(() => repository.commit(state)).toThrow(/Injected move failure/);
    expect(new PulseRepository(storage).load()).toEqual(second);
  });

  it('fails explicitly for a damaged latest committed YAML instead of rolling back silently', () => {
    const { repository, state } = saved();
    state.drafts[0].name = 'Revision 2';
    repository.commit(state);
    writeFileSync(join(packagePath, 'pulse-0.yaml'), 'corrupt');
    expect(() => new PulseRepository(storage).load()).toThrow(/YAML is damaged/);
    expect(readFileSync(join(packagePath, 'pulse-0.yaml'), 'utf8')).toBe('corrupt');
  });

  it('refuses to roll back silently if the latest final marker is missing', () => {
    const { repository, state } = saved();
    state.drafts[0].name = 'Latest acknowledged save';
    repository.commit(state);
    unlinkSync(join(packagePath, 'pulse-0.commit'));
    expect(() => new PulseRepository(storage).load()).toThrow(/commit marker is missing/);
  });

  it('fails explicitly for damaged committed asset bytes', () => {
    const { document } = saved();
    writeFileSync(
      join(packagePath, document.assets[0].archivePath),
      Buffer.alloc(source.length, 0x78),
    );
    expect(() => new PulseRepository(storage).load()).toThrow(/missing or damaged/);
  });

  it('binds marker publication order to its checksum instead of selecting stale state after a bitflip', () => {
    const { repository, state } = saved();
    state.drafts[0].name = 'Latest';
    repository.commit(state);
    const markerPath = join(packagePath, 'pulse-1.commit');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    marker.revision = 101; // Still a valid integer with the correct slot parity.
    writeFileSync(markerPath, JSON.stringify(marker));
    expect(() => new PulseRepository(storage).load()).toThrow(
      /Invalid canonical Pulse commit marker/,
    );
  });

  it('restores a historical document exactly while publishing a newer physical generation', () => {
    const { repository, state, document } = saved();
    state.drafts[0].name = 'Later revision';
    repository.commit(state);
    const extra = Buffer.from('extra accepted asset not referenced by an active clip');
    writeFileSync(join(workingPath, 'extra.bin'), extra);
    const historical = {
      ...document,
      assets: [
        { ...document.assets[0], archivePath: 'assets/imported/original.bin' },
        {
          path: 'extra.bin',
          archivePath: 'assets/extras/extra.bin',
          byteLength: extra.length,
          sha256: createHash('sha256').update(extra).digest('hex'),
        },
      ],
    };
    historical.assets.reverse(); // Retain descriptor order as well as custom member names.
    expect(repository.restore(historical)).toEqual(historical);
    expect(readFileSync(join(packagePath, 'assets/extras/extra.bin'))).toEqual(extra);
    expect(JSON.parse(readFileSync(join(packagePath, 'pulse-1.commit'), 'utf8')).revision).toBe(3);
    const restarted = new PulseRepository(storage);
    expect(restarted.load()).toEqual(historical);
    state.drafts[0].name = 'Edit after historical restore';
    const next = restarted.commit(state);
    expect(next.revision).toBe(2);
    expect(next.assets).toEqual(historical.assets);
    expect(JSON.parse(readFileSync(join(packagePath, 'pulse-0.commit'), 'utf8')).revision).toBe(4);
    expect(new PulseRepository(storage).load()).toEqual(next);
  });

  it('refuses an immutable archive-name collision without overwriting a committed asset', () => {
    const { repository, document } = saved();
    const replacement = Buffer.alloc(source.length, 0x78);
    writeFileSync(join(workingPath, 'replacement.mp4'), replacement);
    const conflicting = {
      ...document,
      assets: [
        document.assets[0],
        {
          path: 'replacement.mp4',
          archivePath: document.assets[0].archivePath,
          byteLength: replacement.length,
          sha256: createHash('sha256').update(replacement).digest('hex'),
        },
      ],
    };
    // Call storage directly to exercise conflict detection even before document validation.
    expect(() => storage.importAssets(conflicting.assets)).toThrow(/missing or damaged/);
    expect(readFileSync(join(packagePath, document.assets[0].archivePath))).toEqual(source);
    expect(new PulseRepository(storage).load()).toEqual(document);
    expect(repository.getDocument()).toEqual(document);
  });

  it('stages an incoming restore directly in canonical assets without changing live working bytes', () => {
    const { repository, document } = saved();
    const replacement = Buffer.from('incoming replacement source');
    const hash = createHash('sha256').update(replacement).digest('hex');
    const incoming = {
      ...document,
      assets: [
        {
          ...document.assets[0],
          archivePath: `assets/${hash}`,
          sha256: hash,
          byteLength: replacement.length,
        },
      ],
    };
    mockFilesystem.__setFault('move', 'pulse-0.commit.tmp');
    expect(() =>
      repository.restore(
        incoming,
        repository.getPublicationGeneration(),
        new Map([['original.mp4', replacement]]),
      ),
    ).toThrow(/Injected move failure/);
    expect(readFileSync(join(workingPath, 'original.mp4'))).toEqual(source);
    expect(new PulseRepository(storage).load()).toEqual(document);
    expect(
      repository.restore(
        incoming,
        repository.getPublicationGeneration(),
        new Map([['original.mp4', replacement]]),
      ),
    ).toEqual(incoming);
    // Working files are a later postcommit materialization, never part of staging.
    expect(readFileSync(join(workingPath, 'original.mp4'))).toEqual(source);
    repository.materialize();
    expect(readFileSync(join(workingPath, 'original.mp4'))).toEqual(replacement);
  });

  it('does not publish an exact restore with a missing extra asset', () => {
    const { repository, document } = saved();
    const missing = {
      ...document,
      assets: [
        ...document.assets,
        {
          path: 'missing-extra.bin',
          archivePath: 'assets/missing-extra',
          byteLength: 1,
          sha256: 'a'.repeat(64),
        },
      ],
    };
    expect(() => repository.restore(missing)).toThrow(/source media is missing or damaged/);
    expect(repository.getDocument()).toEqual(document);
    expect(new PulseRepository(storage).load()).toEqual(document);
  });

  it('retains a previous committed document when restored-asset staging fails', () => {
    const { repository, document } = saved();
    const extra = Buffer.from('new incoming extra');
    writeFileSync(join(workingPath, 'extra.bin'), extra);
    const incoming = {
      ...document,
      assets: [
        ...document.assets,
        {
          path: 'extra.bin',
          archivePath: 'assets/incoming/extra',
          byteLength: extra.length,
          sha256: createHash('sha256').update(extra).digest('hex'),
        },
      ],
    };
    mockFilesystem.__setFault('copy', '.restore.tmp');
    expect(() => repository.restore(incoming)).toThrow(/Injected copy failure/);
    expect(repository.getDocument()).toEqual(document);
    expect(new PulseRepository(storage).load()).toEqual(document);
  });

  it('rejects working paths that could overwrite the canonical package itself', () => {
    // The production package is beneath the document root; safe-relative syntax alone
    // must not let imported asset descriptors target the package's own YAML/markers.
    const nested = new NativePulseStorage(
      new Directory(workingPath, 'library.pulse'),
      new Directory(workingPath),
    );
    const repository = new PulseRepository(nested);
    repository.load();
    const state = stateWithSource();
    state.segments[0].originalFilename = 'library.pulse/pulse-1.commit';
    expect(() => repository.commit(state)).toThrow(/cannot overwrite their canonical package/);
  });

  it.each([
    'SQLite/pulse-cache.db',
    'pulse.db',
    'pulse-cache.db-wal',
    'models/download',
    'logs/debug',
  ])('rejects exact-restore working path %s before publishing', (path) => {
    const { repository, document } = saved();
    const incoming = {
      ...document,
      assets: [{ ...document.assets[0], path }],
      state: {
        ...document.state,
        segments: [{ ...document.state.segments[0], originalFilename: path }],
      },
    };
    expect(() =>
      repository.restore(
        incoming,
        repository.getPublicationGeneration(),
        new Map([[path, source]]),
      ),
    ).toThrow(/reserved application storage/);
    expect(new PulseRepository(storage).load()).toEqual(document);
  });

  it('never treats an existing nonempty package without commit markers as an empty library', () => {
    saved();
    unlinkSync(join(packagePath, 'pulse-1.commit'));
    expect(() => new PulseRepository(storage).load()).toThrow(/no committed revision/);
    expect(readdirSync(packagePath)).toContain('pulse-1.yaml');
  });

  it('allows an empty initial directory but preserves evidence after initial publish failure', () => {
    new Directory(packagePath).create();
    const repository = new PulseRepository(storage);
    expect(repository.load()).toBeNull();
    mockFilesystem.__setFault('move', 'pulse-1.commit.tmp');
    expect(() => repository.commit(stateWithSource())).toThrow(/Injected move failure/);
    expect(() => new PulseRepository(storage).load()).toThrow(/no committed revision/);
    expect(readdirSync(packagePath)).toContain('pulse-1.commit.tmp');
  });
});
