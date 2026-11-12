import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';

import * as schema from '@/db/schema';

import {
  referencedPulseAssetPaths,
  stringifyPulseYaml,
  type PulseAsset,
  type PulseDocument,
  type PulseState,
} from './document';
import { LEGACY_UPGRADE_PENDING_KEY, runPulseBootstrap } from './bootstrap';
import { hydratePulseIndex } from './recovery';
import { PulseRepository, type PulseStorage } from './repository';
import { installCanonicalCommitGuard } from './sqlite-guard';
import {
  readPulseDocumentFromDatabase,
  readPulseState,
  replacePulseDocument,
  replacePulseState,
  writePulseDocumentHeader,
  type PulseSqliteDatabase,
} from './sqlite-state';

// Keep Drizzle's actual Expo driver, including its transaction/query implementations.
// The unused useLiveQuery export must not load an Expo native module in Node.
jest.mock('expo-sqlite', () => ({}));

const migrationDir = join(__dirname, '../../drizzle');
const migrationFiles = readdirSync(migrationDir)
  .filter((file) => /^\d{4}_.*\.sql$/.test(file))
  .sort();
const openConnections = new Set<DatabaseSync>();
const directories: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  for (const db of openConnections) db.close();
  openConnections.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = (text: string) => new TextEncoder().encode(text);

/** Canonical YAML and media bytes survive independently of every cache/working-directory byte. */
class TestPulseStorage implements PulseStorage {
  readonly commits: { revision: number; yaml: string }[] = [];
  readonly archived = new Map<string, Uint8Array>();
  readonly working = new Map<string, Uint8Array>();
  failPublish = false;
  failMaterialize = false;

  readCommits() {
    return this.commits.map((commit) => ({ ...commit }));
  }

  publish(document: PulseDocument, yaml: string) {
    if (this.failPublish) throw new Error('injected canonical publication failure');
    this.commits.push({ revision: document.revision, yaml });
  }

  captureAssets(state: PulseState, previous: readonly PulseAsset[]): PulseAsset[] {
    const required = new Set(referencedPulseAssetPaths(state));
    const optional = state.segments.flatMap((segment) =>
      segment.thumbnail ? [segment.thumbnail] : [],
    );
    optional.push(
      ...state.drafts
        .filter((draft) => draft.mergedSignature !== null)
        .map((draft) => `drafts/${draft.id}/export.mp4`),
    );
    return [...new Set([...required, ...optional])].sort().flatMap((path) => {
      const source = this.working.get(path);
      if (!source) {
        const old = previous.find((asset) => asset.path === path);
        if (old) {
          this.verifyAssets([old]);
          return [{ ...old }];
        }
        if (required.has(path)) throw new Error(`missing working source ${path}`);
        return [];
      }
      const sha256 = hash(source);
      const asset = {
        path,
        archivePath: `assets/${sha256}`,
        byteLength: source.byteLength,
        sha256,
      };
      this.archived.set(asset.archivePath, source.slice());
      return [asset];
    });
  }

  verifyAssets(assets: readonly PulseAsset[]) {
    for (const asset of assets) {
      const source = this.archived.get(asset.archivePath);
      if (!source || source.byteLength !== asset.byteLength || hash(source) !== asset.sha256) {
        throw new Error(`damaged canonical source ${asset.path}`);
      }
    }
  }

  materializeAssets(assets: readonly PulseAsset[]) {
    this.verifyAssets(assets);
    if (this.failMaterialize) throw new Error('injected materialization failure');
    for (const asset of assets)
      this.working.set(asset.path, this.archived.get(asset.archivePath)!.slice());
  }

  snapshot() {
    return {
      commits: this.readCommits(),
      media: [...this.archived].map(([path, source]) => [path, [...source]]),
    };
  }
}

/** Every one of the 48 application columns has an explicit non-default or nullable value. */
function completeState(): PulseState {
  return {
    drafts: [
      {
        id: 'draft-a',
        name: '日本語 🫀 / "quoted"',
        uploadServer: 'https://vault.test/pv',
        uploadArtifactId: 'artifact-a',
        uploadStatus: 'uploaded',
        contextServer: 'https://host.test',
        contextRef: 'opaque:place/β',
        mergedSignature: 'legacy|signature',
        mergedDurationMs: 1432.5,
        captionY: 0.637,
        lastClipNumber: 12,
        createdAt: 1700000000123,
        lastModified: 1700000999456,
      },
    ],
    segments: [
      {
        id: 'segment-a',
        draftId: 'draft-a',
        order: 4,
        label: '12 → 特別',
        originalFilename: 'drafts/draft-a/original.mov',
        durationMs: 2456.75,
        editedFilename: 'drafts/draft-a/legacy.mp4',
        editedDurationMs: 1432.5,
        editState: 'not JSON — baked media remains authoritative',
        thumbnail: 'drafts/draft-a/cover.jpg',
        captionEdit:
          '{"file":"drafts/draft-a/legacy.mp4","words":[{"text":"corrected","t0":5,"t1":11,"start":true}]}',
      },
    ],
    draftTranscripts: [
      {
        draftId: 'draft-a',
        signature: 'old-signature',
        model: null,
        status: 'done',
        lines: '[{"text":"generated"}]',
        editedLines: '[{"text":"manual legacy correction 🫀"}]',
        durationMs: 1432.5,
        createdAt: 1700000200123,
      },
    ],
    clipTranscripts: [
      {
        segmentId: 'segment-a',
        model: 'whisper-small',
        file: 'old/deleted/source.mov',
        status: 'done',
        words: '[{"text":"generated","t0":0,"t1":10}]',
        createdAt: 1700000300123,
      },
    ],
    settings: [
      { key: 'appearance.theme', value: 'dark' },
      { key: 'opaque.app-data', value: "'); DELETE FROM drafts; --\n🫀" },
      { key: 'unknown.nullable', value: null },
    ],
    uploadDestinations: [
      {
        id: 'destination-a',
        server: 'https://vault.test/pv',
        artifactId: 'unclaimed-artifact',
        ref: 'another-ref',
        label: 'Team',
        app: 'Host',
        returnUrl: 'https://host.test/back',
        createdAt: 1700000400123,
      },
    ],
  };
}

function sandbox() {
  const directory = mkdtempSync(join(tmpdir(), 'pulse-recovery-test-'));
  directories.push(directory);
  const path = join(directory, 'pulse-cache.db');
  const storage = new TestPulseStorage();
  for (const name of ['original.mov', 'legacy.mp4', 'cover.jpg', 'export.mp4']) {
    storage.working.set(`drafts/draft-a/${name}`, bytes(`offline fixture: ${name}\0🫀`));
  }
  return { path, storage };
}

function openIndex(path: string) {
  const sqlite = new DatabaseSync(path);
  openConnections.add(sqlite);
  const failure = { commit: false, rollback: false };
  try {
    sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL');
    for (const file of migrationFiles) {
      for (const statement of readFileSync(join(migrationDir, file), 'utf8').split(
        '--> statement-breakpoint',
      )) {
        if (statement.trim()) sqlite.exec(statement);
      }
    }
  } catch (error) {
    sqlite.close();
    openConnections.delete(sqlite);
    throw error;
  }
  const raw: PulseSqliteDatabase = {
    getAllSync<T>(sql: string, ...params: (string | number | null)[]) {
      return sqlite.prepare(sql).all(...params) as T[];
    },
    runSync(sql, params = []) {
      return sqlite.prepare(sql).run(...params);
    },
    execSync(sql) {
      sqlite.exec(sql);
    },
  };
  const adapter = {
    prepareSync(sql: string) {
      const statement = sqlite.prepare(sql);
      const execute = (params: (string | number | null)[], arrays: boolean) => {
        if (sql.trim().toLowerCase() === 'commit' && failure.commit) {
          failure.commit = false;
          throw new Error('injected SQLite COMMIT failure after canonical publication');
        }
        if (sql.trim().toLowerCase() === 'rollback' && failure.rollback) {
          failure.rollback = false;
          throw new Error('injected SQLite ROLLBACK failure');
        }
        const objects = statement.all(...params);
        const result = arrays ? objects.map((row) => Object.values(row)) : objects;
        const meta = sqlite
          .prepare('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowId')
          .get()!;
        return {
          changes: Number(meta.changes),
          lastInsertRowId: Number(meta.lastInsertRowId),
          getAllSync: () => result,
          getFirstSync: () => result[0] ?? null,
        };
      };
      return {
        executeSync: (params: (string | number | null)[]) => execute(params, false),
        executeForRawResultSync: (params: (string | number | null)[]) => execute(params, true),
      };
    },
  } as unknown as SQLiteDatabase;
  return {
    sqlite,
    raw,
    failure,
    db: drizzle(adapter, { schema }),
    close() {
      sqlite.close();
      openConnections.delete(sqlite);
    },
  };
}

function eraseIndex(path: string) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  for (const suffix of ['', '-wal', '-shm']) expect(existsSync(path + suffix)).toBe(false);
}

function seeded() {
  const fixture = sandbox();
  const index = openIndex(fixture.path);
  replacePulseState(index.raw, completeState());
  const repository = new PulseRepository(fixture.storage);
  expect(repository.load()).toBeNull();
  const initial = hydratePulseIndex(repository, index.raw);
  const guard = installCanonicalCommitGuard(index.db, {
    beforeCommit: () => {
      repository.commit(readPulseState(index.raw), (document) =>
        writePulseDocumentHeader(index.raw, document),
      );
    },
  });
  return { ...fixture, index, repository, guard, initial };
}

describe('canonical Pulse to disposable SQLite recovery', () => {
  it('prepares resumable initial migration before asset capture and leaves legacy SQL unchanged until publication succeeds', () => {
    const f = sandbox();
    const index = openIndex(f.path);
    const original = completeState();
    replacePulseState(index.raw, original);
    const events: string[] = [];
    let pending = false;
    Object.assign(f.storage, {
      prepareInitialMigration() {
        events.push('prepare initial migration');
        pending = true;
      },
      finishInitialMigration() {
        events.push('finish initial migration');
        pending = false;
      },
    });
    const capture = f.storage.captureAssets.bind(f.storage);
    jest.spyOn(f.storage, 'captureAssets').mockImplementation((state, previous) => {
      events.push('capture assets');
      expect(pending).toBe(true);
      expect(readPulseState(index.raw)).toEqual(original);
      return capture(state, previous);
    });
    const publish = f.storage.publish.bind(f.storage);
    jest.spyOn(f.storage, 'publish').mockImplementation((document, yaml) => {
      events.push('publish');
      expect(readPulseState(index.raw)).toEqual(original);
      return publish(document, yaml);
    });
    const repository = new PulseRepository(f.storage);
    repository.load();
    f.storage.failPublish = true;
    expect(() => hydratePulseIndex(repository, index.raw)).toThrow('canonical publication failure');
    expect(events).toEqual(['prepare initial migration', 'capture assets', 'publish']);
    expect(pending).toBe(true);
    expect(f.storage.commits).toEqual([]);
    expect(readPulseState(index.raw)).toEqual(original);
    events.length = 0;
    f.storage.failPublish = false;
    const saved = hydratePulseIndex(repository, index.raw);
    expect(events).toEqual([
      'prepare initial migration',
      'capture assets',
      'publish',
      'finish initial migration',
    ]);
    expect(pending).toBe(false);
    expect(readPulseDocumentFromDatabase(index.raw)).toEqual(saved);
    events.length = 0;
    pending = true; // Simulates interrupted retirement after a durable canonical publication.
    expect(hydratePulseIndex(repository, index.raw)).toEqual(saved);
    expect(events).toEqual(['finish initial migration']);
    expect(pending).toBe(false);
  });

  it('marks only the first legacy capture pending and preserves that committed marker across index deletion', () => {
    const f = seeded();
    expect(f.initial.state.settings).toContainEqual({
      key: LEGACY_UPGRADE_PENDING_KEY,
      value: 'true',
    });
    expect(readPulseDocumentFromDatabase(f.index.raw)).toEqual(f.initial);
    f.index.close();
    eraseIndex(f.path);
    const fresh = openIndex(f.path);
    const reopened = new PulseRepository(f.storage);
    expect(reopened.load()).toEqual(f.initial);
    expect(hydratePulseIndex(reopened, fresh.raw)).toEqual(f.initial);
    expect(readPulseDocumentFromDatabase(fresh.raw)).toEqual(f.initial);
  });

  it('preserves a valid baked edit when starting a restored canonical library without initial-upgrade markers', async () => {
    const f = seeded();
    const state = completeState();
    state.segments[0].editState = JSON.stringify({
      v: 1,
      startMs: 100,
      endMs: 1100,
      rotation: 0,
      flipped: false,
      crop: null,
      muted: false,
      speed: 1,
      undo: [],
      redo: [],
    });
    const restored: PulseDocument = {
      format: 'pulse-document',
      version: 2,
      scope: 'library',
      revision: 37,
      state,
      assets: f.storage.captureAssets(state, []),
    };
    f.storage.commits.splice(0);
    f.storage.publish(restored, stringifyPulseYaml(restored));
    const canonical = f.storage.snapshot();
    f.index.close();
    eraseIndex(f.path);
    f.storage.working.clear();
    const fresh = openIndex(f.path);
    const reopened = new PulseRepository(f.storage);
    reopened.load();
    const status = { ready: false, error: null };
    const transform = jest.fn(() => {
      fresh.db.update(schema.segments).set({ editedFilename: null }).run();
      f.storage.working.delete(state.segments[0].editedFilename!);
    });
    const commitState = jest.fn(() => {
      throw new Error('ordinary restore must not write completion markers');
    });
    await runPulseBootstrap({
      getStatus: () => status,
      migrateSchema: () => {},
      initializePersistence: () => {
        hydratePulseIndex(reopened, fresh.raw);
        status.ready = true;
      },
      getDocument: () => reopened.getDocument()!,
      commitState,
      legacyMigrationIds: ['legacy-drafts-import', 'drop-baked-edits', 'drop-draft-tokens'],
      runDataMigrations: transform,
      cleanup: () => {},
    });
    expect(transform).not.toHaveBeenCalled();
    expect(commitState).not.toHaveBeenCalled();
    expect(readPulseDocumentFromDatabase(fresh.raw)).toEqual(restored);
    const baked = restored.assets.find((asset) => asset.path === state.segments[0].editedFilename)!;
    expect(f.storage.working.get(baked.path)).toEqual(f.storage.archived.get(baked.archivePath));
    expect(f.storage.snapshot()).toEqual(canonical);
  });

  it('resumes an interrupted initial upgrade only from its committed pending/completion markers', async () => {
    const f = seeded();
    const cleanup = jest.fn<() => void>();
    const firstId = 'legacy-drafts-import';
    const secondId = 'drop-baked-edits';
    const firstStatus = { ready: true, error: null };
    const options = {
      getStatus: () => firstStatus,
      migrateSchema: () => {},
      initializePersistence: () => {},
      getDocument: () => f.repository.getDocument()!,
      commitState: (state: PulseState) => {
        const doc = f.repository.commit(state);
        replacePulseDocument(f.index.raw, doc);
        return doc;
      },
      legacyMigrationIds: [firstId, secondId],
      cleanup,
      runDataMigrations: () => {
        f.index.db
          .insert(schema.settings)
          .values({ key: `dataMigration.${firstId}`, value: 'true' })
          .run();
        // The next task failed; the historical runner returned without throwing.
      },
    };
    await expect(runPulseBootstrap(options)).rejects.toThrow('upgrade is incomplete');
    expect(cleanup).not.toHaveBeenCalled();
    expect(f.repository.getDocument()!.state.settings).toContainEqual({
      key: LEGACY_UPGRADE_PENDING_KEY,
      value: 'true',
    });
    f.index.close();
    eraseIndex(f.path);
    const fresh = openIndex(f.path);
    const reopened = new PulseRepository(f.storage);
    const resumed = reopened.load()!;
    expect(resumed.state.settings).toContainEqual({
      key: `dataMigration.${firstId}`,
      value: 'true',
    });
    expect(resumed.state.settings).toContainEqual({
      key: LEGACY_UPGRADE_PENDING_KEY,
      value: 'true',
    });
    const guard = installCanonicalCommitGuard(fresh.db, {
      beforeCommit: () => {
        reopened.commit(readPulseState(fresh.raw), (doc) =>
          writePulseDocumentHeader(fresh.raw, doc),
        );
      },
    });
    guard.setEnabled(false);
    const resumedStatus = { ready: false, error: null };
    await runPulseBootstrap({
      getStatus: () => resumedStatus,
      migrateSchema: () => {},
      initializePersistence: () => {
        hydratePulseIndex(reopened, fresh.raw);
        guard.setEnabled(true);
        resumedStatus.ready = true;
      },
      getDocument: () => reopened.getDocument()!,
      commitState: (state) => {
        const doc = reopened.commit(state);
        replacePulseDocument(fresh.raw, doc);
        return doc;
      },
      legacyMigrationIds: [firstId, secondId],
      cleanup,
      runDataMigrations: () => {
        // The persisted first completion prevents rerunning that task; only the remaining one writes.
        expect(reopened.getDocument()!.state.settings).toContainEqual({
          key: `dataMigration.${firstId}`,
          value: 'true',
        });
        fresh.db
          .insert(schema.settings)
          .values({ key: `dataMigration.${secondId}`, value: 'true' })
          .run();
      },
    });
    const completed = reopened.getDocument()!;
    expect(completed.state.settings.some((row) => row.key === LEGACY_UPGRADE_PENDING_KEY)).toBe(
      false,
    );
    expect(completed.state.settings).toContainEqual({
      key: `dataMigration.${firstId}`,
      value: 'true',
    });
    expect(completed.state.settings).toContainEqual({
      key: `dataMigration.${secondId}`,
      value: 'true',
    });
    expect(readPulseDocumentFromDatabase(fresh.raw)).toEqual(completed);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect canonically deleted drafts or dependent rows after rebuilding with old immutable media retained', () => {
    const f = seeded();
    const retainedMedia = [...f.storage.archived].map(([path, source]) => [path, [...source]]);
    f.index.db.delete(schema.drafts).where(eq(schema.drafts.id, 'draft-a')).run();
    const saved = f.repository.getDocument()!;
    expect(saved.state.drafts).toEqual([]);
    expect(saved.state.segments).toEqual([]);
    expect(saved.state.draftTranscripts).toEqual([]);
    expect(saved.state.clipTranscripts).toEqual([]);
    expect([...f.storage.archived].map(([path, source]) => [path, [...source]])).toEqual(
      retainedMedia,
    );
    f.index.close();
    eraseIndex(f.path);
    const fresh = openIndex(f.path);
    const reopened = new PulseRepository(f.storage);
    expect(reopened.load()).toEqual(saved);
    hydratePulseIndex(reopened, fresh.raw);
    expect(readPulseDocumentFromDatabase(fresh.raw)).toEqual(saved);
    expect(readPulseState(fresh.raw).drafts).toEqual([]);
    expect(readPulseState(fresh.raw).segments).toEqual([]);
    expect([...f.storage.archived].map(([path, source]) => [path, [...source]])).toEqual(
      retainedMedia,
    );
  });

  it('rebuilds offline after deleting the real database and both sidecars, preserving all 48 columns and the complete document', () => {
    const f = seeded();
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network must not be used');
    });
    expect(migrationFiles).toHaveLength(20);
    expect(
      Object.values(completeState()).reduce(
        (total, rows) => total + Object.keys(rows[0]).length,
        0,
      ),
    ).toBe(48);
    expect(f.initial.revision).toBe(1);
    expect(readPulseDocumentFromDatabase(f.index.raw)).toEqual(f.initial);
    f.index.db.transaction((tx) => {
      tx.update(schema.drafts)
        .set({ name: 'Saved correction', captionY: 0.21, lastModified: 1700001000000 })
        .run();
      tx.update(schema.segments).set({ captionEdit: '{"words":[]}', label: 'renamed clip' }).run();
      tx.update(schema.settings)
        .set({ value: 'light' })
        .where(eq(schema.settings.key, 'appearance.theme'))
        .run();
    });
    const saved = f.repository.getDocument()!;
    expect(saved.revision).toBe(2);
    expect(saved.assets).toHaveLength(4);
    expect(readPulseDocumentFromDatabase(f.index.raw)).toEqual(saved);
    const canonical = f.storage.snapshot();
    f.index.close();
    // SQLite often removes real sidecars at close. Stale sidecars must also be disposable.
    writeFileSync(f.path + '-wal', 'stale test WAL');
    writeFileSync(f.path + '-shm', 'stale test shared memory');
    eraseIndex(f.path);
    f.storage.working.clear();
    const rebuilt = openIndex(f.path);
    const reopened = new PulseRepository(f.storage);
    expect(reopened.load()).toEqual(saved);
    expect(hydratePulseIndex(reopened, rebuilt.raw)).toEqual(saved);
    expect(readPulseState(rebuilt.raw)).toEqual(saved.state);
    expect(readPulseDocumentFromDatabase(rebuilt.raw)).toEqual(saved);
    for (const asset of saved.assets)
      expect(f.storage.working.get(asset.path)).toEqual(f.storage.archived.get(asset.archivePath));
    expect(f.storage.snapshot()).toEqual(canonical);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rolls back application rows and the staged header when canonical publication fails', () => {
    const f = seeded();
    const before = f.repository.getDocument();
    const canonical = f.storage.snapshot();
    f.storage.failPublish = true;
    expect(() =>
      f.index.db.transaction((tx) => {
        tx.update(schema.drafts).set({ name: 'Must not survive' }).run();
        tx.update(schema.segments).set({ captionEdit: '{"words":[]}' }).returning().get();
      }),
    ).toThrow();
    expect(f.guard.poisoned).toBe(false);
    expect(readPulseDocumentFromDatabase(f.index.raw)).toEqual(before);
    expect(f.repository.getDocument()).toEqual(before);
    expect(new PulseRepository(f.storage).load()).toEqual(before);
    expect(f.storage.snapshot()).toEqual(canonical);
  });

  it('keeps the newly committed Pulse revision when SQLite COMMIT fails, then rebuilds that saved revision', () => {
    const f = seeded();
    f.index.failure.commit = true;
    const result = f.index.db
      .update(schema.drafts)
      .set({ name: 'Canonical success' })
      .returning()
      .get();
    expect(result?.name).toBe('Canonical success');
    const saved = f.repository.getDocument()!;
    expect(saved.revision).toBe(2);
    expect(saved.state.drafts[0].name).toBe('Canonical success');
    expect(f.guard.poisoned).toBe(true);
    expect(readPulseDocumentFromDatabase(f.index.raw)).toEqual(f.initial);
    expect(() => f.index.db.select().from(schema.drafts).all()).toThrow('requires rehydration');
    const canonical = f.storage.snapshot();
    f.index.close();
    eraseIndex(f.path);
    f.storage.working.clear();
    const fresh = openIndex(f.path);
    const reopened = new PulseRepository(f.storage);
    expect(reopened.load()).toEqual(saved);
    hydratePulseIndex(reopened, fresh.raw);
    expect(readPulseDocumentFromDatabase(fresh.raw)).toEqual(saved);
    expect(f.storage.snapshot()).toEqual(canonical);
  });

  it('keeps the old canonical head and blocks unsafe pending rows when a failed save also cannot roll back', () => {
    const f = seeded();
    const canonical = f.storage.snapshot();
    f.storage.failPublish = true;
    f.index.failure.rollback = true;
    expect(() =>
      f.index.db.update(schema.drafts).set({ name: 'Never acknowledged' }).returning().get(),
    ).toThrow('canonical publication failure');
    expect(f.guard.poisoned).toBe(true);
    expect(f.guard.failure?.canonicalCommitted).toBe(false);
    expect(f.repository.getDocument()).toEqual(f.initial);
    expect(new PulseRepository(f.storage).load()).toEqual(f.initial);
    expect(() => f.index.db.select().from(schema.drafts).all()).toThrow('requires rehydration');
    expect(f.storage.snapshot()).toEqual(canonical);
    f.index.close();
    eraseIndex(f.path);
    const fresh = openIndex(f.path);
    const reopened = new PulseRepository(f.storage);
    reopened.load();
    expect(hydratePulseIndex(reopened, fresh.raw)).toEqual(f.initial);
    expect(readPulseDocumentFromDatabase(fresh.raw)).toEqual(f.initial);
    expect(f.storage.snapshot()).toEqual(canonical);
  });

  it('can discard a corrupt SQLite cache without changing any canonical YAML or source bytes', () => {
    const f = seeded();
    const canonical = f.storage.snapshot();
    f.index.close();
    eraseIndex(f.path);
    writeFileSync(f.path, 'This is corrupt SQLite fixture data.');
    expect(() => openIndex(f.path)).toThrow();
    expect(f.storage.snapshot()).toEqual(canonical);
    eraseIndex(f.path);
    const fresh = openIndex(f.path);
    const reopened = new PulseRepository(f.storage);
    reopened.load();
    hydratePulseIndex(reopened, fresh.raw);
    expect(readPulseDocumentFromDatabase(fresh.raw)).toEqual(f.initial);
    expect(f.storage.snapshot()).toEqual(canonical);
  });

  it.each(['materialization', 'index write'] as const)(
    'leaves canonical sources intact after a %s rebuild failure and permits a retry',
    (phase) => {
      const f = seeded();
      const canonical = f.storage.snapshot();
      f.index.close();
      eraseIndex(f.path);
      f.storage.working.clear();
      const fresh = openIndex(f.path);
      const reopened = new PulseRepository(f.storage);
      reopened.load();
      f.storage.failMaterialize = phase === 'materialization';
      let writes = 0;
      const failing =
        phase === 'index write'
          ? {
              ...fresh.raw,
              runSync(sql: string, params?: (string | number | null)[]) {
                if (++writes === 2) throw new Error('injected index restore failure');
                return fresh.raw.runSync(sql, params ?? []);
              },
            }
          : fresh.raw;
      expect(() => hydratePulseIndex(reopened, failing)).toThrow('injected');
      expect(readPulseState(fresh.raw).drafts).toEqual([]);
      expect(f.storage.snapshot()).toEqual(canonical);
      f.storage.failMaterialize = false;
      expect(hydratePulseIndex(reopened, fresh.raw)).toEqual(f.initial);
      expect(readPulseDocumentFromDatabase(fresh.raw)).toEqual(f.initial);
      expect(f.storage.snapshot()).toEqual(canonical);
    },
  );

  it('refuses corrupt committed YAML before touching a surviving projection or any media', () => {
    const f = seeded();
    f.storage.commits[0].yaml += '\nversion: 999\n';
    const damagedCanonical = f.storage.snapshot();
    const survivingProjection = readPulseDocumentFromDatabase(f.index.raw);
    const reopened = new PulseRepository(f.storage);
    expect(() => reopened.load()).toThrow('Invalid Pulse YAML');
    expect(() => hydratePulseIndex(reopened, f.index.raw)).toThrow();
    expect(f.storage.snapshot()).toEqual(damagedCanonical);
    expect(readPulseDocumentFromDatabase(f.index.raw)).toEqual(survivingProjection);
  });
});
