import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import migrations from '../../../drizzle/migrations';
import { env, File } from '@/test-support/expo-fs-node';
import type { CatalogFile } from './catalog';
import { readCatalogFile } from './catalog-filter';

jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));
// The node stand-in for expo-sqlite has no change events: the test fires them, as SQLite's update
// hook would after a write.
const mockChangeListeners = new Set<(event: { tableName: string }) => void>();
jest.mock('expo-sqlite', () => {
  const sqlite = jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
    '@/test-support/expo-sqlite-node',
  ).mockModule;
  return Object.assign(Object.create(sqlite) as object, {
    addDatabaseChangeListener: (listener: (event: { tableName: string }) => void) => {
      mockChangeListeners.add(listener);
      return { remove: () => mockChangeListeners.delete(listener) };
    },
  });
});
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
// pulse-editor is native (and not a jest dependency): the writer reaches it only through imports.
jest.mock('@mieweb/pulse-editor', () => ({}), { virtual: true });
jest.mock('@/utils/video', () => ({}));
jest.mock('@/db/secure-token', () => ({ deleteSavedLink: async () => {} }));
jest.mock('expo-crypto', () => ({
  randomUUID: () => jest.requireActual<typeof import('node:crypto')>('node:crypto').randomUUID(),
}));

// The embed's folders inside a host app (`setStorageRoots`), apart from the app's own (`env`).
const ROOT = mkdtempSync(join(tmpdir(), 'pulse-catalog-writer-'));
const NS = join(ROOT, 'Library/PulseKit/com.example.host-0123456789abcdef');
const CATALOG = join(NS, 'catalog.json');
const PART = `${CATALOG}.part`;

let lib!: {
  roots: typeof import('@/utils/storage-root');
  client: typeof import('@/db/client');
  captions: typeof import('@/db/captions');
  drafts: typeof import('@/db/drafts');
  host: typeof import('@/db/host-context');
  project: typeof import('@/db/project');
  writer: typeof import('./catalog-writer');
};

beforeAll(async () => {
  Object.assign(env, {
    docDir: join(ROOT, 'App/Documents'),
    cacheDir: join(ROOT, 'App/Caches'),
    dbDir: join(ROOT, 'App/Documents/SQLite'),
  });
  for (const dir of [env.docDir, env.cacheDir, env.dbDir]) mkdirSync(dir, { recursive: true });
  const roots = jest.requireActual<typeof import('@/utils/storage-root')>('@/utils/storage-root');
  roots.setStorageRoots({ documents: NS, caches: join(ROOT, 'Library/Caches/PulseKit/ns') });
  lib = {
    roots,
    client: jest.requireActual('@/db/client'),
    captions: jest.requireActual('@/db/captions'),
    drafts: jest.requireActual('@/db/drafts'),
    host: jest.requireActual('@/db/host-context'),
    project: jest.requireActual('@/db/project'),
    writer: jest.requireActual('./catalog-writer'),
  };
  await migrate(lib.client.db, migrations);
});
afterAll(async () => {
  await lib?.writer.stopCatalogWriter();
  lib?.client.expoDb.closeSync();
  rmSync(ROOT, { recursive: true, force: true });
});

const readCatalog = () => JSON.parse(readFileSync(CATALOG, 'utf8')) as CatalogFile;
/** What PulseKit's reader finds, by the rule it mirrors (readCatalogFile). */
const readerFinds = () =>
  readCatalogFile((name) => {
    const path = join(NS, name);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  });
const change = (tableName: string) => mockChangeListeners.forEach((l) => l({ tableName }));

/**
 * expo-file-system's move, as it runs on a phone (FileSystemPath.move on iOS, CopyMoveStrategy on
 * Android): with `overwrite` it deletes the destination, and only then moves the file in. The Node
 * stand-in renames over it in one step, which would hide the gap between the two.
 */
function nativeMove(this: File, dest: File, opts?: { overwrite?: boolean }) {
  if (existsSync(dest.path)) {
    if (!opts?.overwrite) throw new Error('destination exists');
    rmSync(dest.path);
  }
  renameSync(this.path, dest.path);
  this.path = dest.path;
}
/** Every catalog the writer moved into place. */
const moves = jest.spyOn(File.prototype, 'moveSync').mockImplementation(nativeMove);
const writes = () => moves.mock.calls.filter(([dest]) => dest.path === CATALOG).length;
/** Only setTimeout and friends: the database's promises and Node's own queues run as usual. */
const fakeTimers = () =>
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForWrites(n: number) {
  for (let i = 0; i < 100 && writes() < n; i++) await sleep(10);
  expect(writes()).toBe(n);
}

describe('catalog writer', () => {
  it('the Pulse app (no host folders) writes no catalog', async () => {
    let standalone!: typeof import('./catalog-writer');
    jest.isolateModules(() => {
      standalone = jest.requireActual('./catalog-writer');
    });
    await standalone.startCatalogWriter({ namespace: 'app' });
    expect(existsSync(join(env.docDir, 'catalog.json'))).toBe(false);
    expect(existsSync(CATALOG)).toBe(false);
    expect(writes()).toBe(0);
  });

  it('boot: writes the catalog under the namespace root, with nothing left beside it', async () => {
    const id = await lib.drafts.createDraft({
      hostContext: { key: 'clock:e1', kind: 'clock', id: 'E1', label: 'Mon 9:02 session' },
      createdVia: 'host',
    });
    const before = Date.now();
    await lib.writer.startCatalogWriter({ namespace: 'com.example.host-0123456789abcdef' });
    const catalog = readCatalog();
    expect(catalog).toMatchObject({
      format: 'pulse-catalog',
      version: 1,
      namespace: 'com.example.host-0123456789abcdef',
      dbSchema: lib.project.APP_SCHEMA_VERSION,
      readOnly: false,
      online: true,
      receipts: [],
    });
    expect(catalog.writtenAt).toBeGreaterThanOrEqual(before);
    expect(catalog.drafts.map((d) => [d.id, d.state, d.name])).toEqual([
      [id, 'draft', 'Mon 9:02 session'],
    ]);
    expect(existsSync(PART)).toBe(false);
    expect(writes()).toBe(1);
  });

  it('a burst of writes makes one catalog without a timer, and other tables make none', async () => {
    const [draft] = readCatalog().drafts;
    await lib.drafts.renameDraft(draft.id, 'First take');
    // No timer may stand between a change and its write: Android pauses timers while no Pulse
    // screen is resumed, and a catalog waiting on one showed a sent draft as queued.
    const timers = jest.spyOn(global, 'setTimeout');
    try {
      for (let i = 0; i < 20; i++) change(i % 2 ? 'drafts' : 'segments');
      change('upload_jobs');
      await Promise.resolve();
      expect(timers).not.toHaveBeenCalled();
    } finally {
      timers.mockRestore();
    }
    await waitForWrites(2); // the whole burst: one write
    await sleep(50);
    expect(writes()).toBe(2);

    change('local_settings'); // not projected: no write
    change('upload_destinations');
    await sleep(50);
    expect(writes()).toBe(2);
    change('upload_receipts');
    await waitForWrites(3);
    expect(readCatalog().drafts[0].name).toBe('First take');
  });

  it('a write killed midway leaves the previous catalog, whole', async () => {
    const previous = readFileSync(CATALOG, 'utf8');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The process dies halfway through writing the new catalog: half of it is on disk.
    jest.spyOn(File.prototype, 'write').mockImplementationOnce(function (this: File, text) {
      writeFileSync(this.path, String(text).slice(0, Math.floor(String(text).length / 2)));
      throw new Error('killed');
    });
    const [draft] = readCatalog().drafts;
    await lib.drafts.renameDraft(draft.id, 'Second take');
    await lib.writer.startCatalogWriter({ namespace: 'com.example.host-0123456789abcdef' });
    expect(readFileSync(CATALOG, 'utf8')).toBe(previous);
    expect(readCatalog().drafts[0].name).toBe('First take');
    expect(warn).toHaveBeenCalledWith('[catalog] could not write the catalog', expect.any(Error));
    warn.mockRestore();

    // A `.part` a real kill left behind is replaced by the next write.
    writeFileSync(PART, '{"format":"pulse-cat');
    await lib.writer.startCatalogWriter({ namespace: 'com.example.host-0123456789abcdef' });
    expect(readCatalog().drafts[0].name).toBe('Second take');
    expect(existsSync(PART)).toBe(false);
  });

  it('mid-swap, after catalog.json is deleted and before the .part is moved in, a reader finds the new catalog', async () => {
    const [draft] = readCatalog().drafts;
    await lib.drafts.renameDraft(draft.id, 'Third take');
    let found: CatalogFile | null | undefined;
    moves.mockImplementationOnce(function (this: File, dest: File) {
      rmSync(dest.path);
      found = readerFinds(); // the gap
      renameSync(this.path, dest.path);
      this.path = dest.path;
    });
    await lib.writer.startCatalogWriter({ namespace: 'com.example.host-0123456789abcdef' });
    expect(found?.drafts[0].name).toBe('Third take');
    expect(readCatalog().drafts[0].name).toBe('Third take');
  });

  it('a kill inside the swap keeps the .part as the catalog, and the next write moves it in first', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const [draft] = readCatalog().drafts;
    await lib.drafts.renameDraft(draft.id, 'Fourth take');
    // catalog.json is deleted, then the move fails before the .part is in place.
    moves.mockImplementationOnce(function (this: File, dest: File) {
      rmSync(dest.path);
      throw new Error('killed');
    });
    await lib.writer.startCatalogWriter({ namespace: 'com.example.host-0123456789abcdef' });
    expect(warn).toHaveBeenCalledWith('[catalog] could not write the catalog', expect.any(Error));
    warn.mockRestore();
    expect(existsSync(CATALOG)).toBe(false);
    expect(existsSync(PART)).toBe(true); // the only catalog left, kept
    expect(readerFinds()?.drafts[0].name).toBe('Fourth take');

    // The next write: while its own .part is written, readers already have catalog.json again.
    await lib.drafts.renameDraft(draft.id, 'Fifth take');
    let whileWriting: string | null = null;
    jest.spyOn(File.prototype, 'write').mockImplementationOnce(function (this: File, text) {
      whileWriting = existsSync(CATALOG) ? readCatalog().drafts[0].name : null;
      writeFileSync(this.path, String(text));
    });
    await lib.writer.startCatalogWriter({ namespace: 'com.example.host-0123456789abcdef' });
    expect(whileWriting).toBe('Fourth take');
    expect(readCatalog().drafts[0].name).toBe('Fifth take');
    expect(existsSync(PART)).toBe(false);

    // A .part cut short with no catalog.json beside it (a first write killed) is dropped, not moved in.
    rmSync(CATALOG);
    writeFileSync(PART, '{"format":"pulse-cat');
    expect(readerFinds()).toBeNull();
    await lib.writer.startCatalogWriter({ namespace: 'com.example.host-0123456789abcdef' });
    expect(readCatalog().drafts[0].name).toBe('Fifth take');
    expect(existsSync(PART)).toBe(false);
  });

  it('the captions switch rewrites it: hasCaptions follows the draft’s captions-off setting', async () => {
    const [draft] = readCatalog().drafts;
    await lib.drafts.addSegment(draft.id, {
      id: 'cap-1',
      originalFilename: `drafts/${draft.id}/segments/cap-1.mp4`,
      durationMs: 2000,
      thumbnail: null,
    });
    await lib.captions.setCaptionEdits(
      new Map([
        [
          'cap-1',
          JSON.stringify({
            file: `drafts/${draft.id}/segments/cap-1.mp4`,
            words: [{ text: 'Hello', t0: 10, t1: 50 }],
          }),
        ],
      ]),
    );
    let n = writes();
    change('segments');
    await waitForWrites(++n);
    expect(readCatalog().drafts[0].hasCaptions).toBe(true);

    // The switch writes only `settings` (as SQLite's update hook reports it): that is watched.
    await lib.drafts.setDraftCaptionsOff(draft.id, true);
    change('settings');
    await waitForWrites(++n);
    expect(readCatalog().drafts[0].hasCaptions).toBe(false);
    await lib.drafts.setDraftCaptionsOff(draft.id, false);
    change('settings');
    await waitForWrites(++n);
    expect(readCatalog().drafts[0].hasCaptions).toBe(true);
  });

  it('a library a newer Pulse migrated is written with readOnly: true', async () => {
    lib.host.markNewerSchema();
    await lib.writer.startCatalogWriter({ namespace: 'com.example.host-0123456789abcdef' });
    expect(readCatalog().readOnly).toBe(true);
  });

  it('stopped, changes no longer write it', async () => {
    await lib.writer.stopCatalogWriter();
    const n = writes();
    fakeTimers();
    try {
      change('drafts');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
    expect(writes()).toBe(n);
  });
});
