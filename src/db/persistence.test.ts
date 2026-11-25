import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getTableColumns, is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createHash, randomBytes } from 'node:crypto';

import migrations from '../../drizzle/migrations';
import { env, File, md5Calls } from '@/test-support/expo-fs-node';
import { zipCalls } from '@/test-support/zip-archive-node';
import { mockModule as sqlite } from '@/test-support/expo-sqlite-node';
import {
  createLibraryBackup,
  restoreLibraryBackup,
} from '@/features/draft-transfer/library-backup';
import { exportDrafts } from '@/features/draft-transfer/pack';
import { importProjectFile, pulseFileKind } from '@/features/draft-transfer/unpack-project';
import { applyDurability, readDurability } from './durability';
import {
  historyClipIds,
  historyMediaPaths,
  HISTORY_MAX_MEDIA_BYTES,
  parsePersistedHistory,
  type PersistedHistory,
} from '@/db/persisted-history';
import { assertSafeLibrary, referencedMediaPaths } from './media-refs';
import { checkpointForRows, historyCheckpoint } from './undo-history';
import {
  APP_SCHEMA_VERSION,
  assertSchemaCoverage,
  buildProject,
  checkProject,
  isNewerSchema,
  LOCAL_TABLES,
  planCopy,
  PROJECT_FORMAT,
  restoreProject,
  schemaVersion,
  type ProjectDocument,
} from './project';
import * as schema from './schema';
import { openLibrary, takeSnapshot } from './snapshots';
import { renderKey } from '@/utils/segment-window';

jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));
jest.mock(
  'expo-sqlite',
  () =>
    jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
      '@/test-support/expo-sqlite-node',
    ).mockModule,
);
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('react-native-zip-archive', () => jest.requireActual('@/test-support/zip-archive-node'));
// Only for the library as the app opens it (`@/db/client`, `@/db/drafts`): drafts.ts imports
// these native modules, none of which the tests here reach.
jest.mock('@/utils/video', () => ({ generateThumbnailFile: jest.fn(async () => false) }));
jest.mock('@/features/transcription/clip-queue', () => ({ dropClipJobs: () => {} }));
jest.mock('./secure-token', () => ({ deleteSavedLink: async () => {} }));
jest.mock('expo-crypto', () => ({
  randomUUID: () => jest.requireActual<typeof import('node:crypto')>('node:crypto').randomUUID(),
}));
// Only for the migration gate (`./migrate`): its screens, which the tests here never render.
jest.mock('@/components/primary-button', () => ({}));
jest.mock('@/components/state-message', () => ({}));
jest.mock('@/core/recovery/screen', () => ({}));
jest.mock('@/utils/relative-date', () => ({ formatDateTime: () => '' }));

// Each test works on "devices": a temp folder with the app's documents, cache and SQLite dirs.
const ROOT = mkdtempSync(join(tmpdir(), 'pulse-persistence-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
let deviceCount = 0;
type Device = { docDir: string; cacheDir: string; dbDir: string };
function newDevice(): Device {
  const base = join(ROOT, `device-${++deviceCount}`);
  const d = {
    docDir: join(base, 'Documents'),
    cacheDir: join(base, 'Caches'),
    dbDir: join(base, 'Documents/SQLite'),
  };
  for (const dir of Object.values(d)) mkdirSync(dir, { recursive: true });
  return d;
}
const use = (d: Device) => Object.assign(env, d);

const TABLES = Object.values(schema as Record<string, unknown>).filter((v): v is SQLiteTable =>
  is(v, SQLiteTable),
);
const tableNames = () => TABLES.map((t) => getTableConfig(t).name);
/** The tables documents and backups carry: all but the LOCAL ones (outbox, receipts, local settings). */
const LOCAL = ['upload_jobs', 'upload_receipts', 'local_settings'];
const carriedNames = () => tableNames().filter((n) => !LOCAL.includes(n));
/** What a restore replaces: every carried table, and the migration log. */
const REPLACED = () => [...carriedNames(), '__drizzle_migrations'];
/** What a restore keeps of this phone's LOCAL rows (its jobs go with the drafts it replaces). */
const KEPT = ['upload_receipts', 'local_settings'];

/** Open the device's pulse.db and run drizzle's expo-sqlite migrator (optionally only up to `idx`). */
async function openMigrated(idx?: number): Promise<SQLiteDatabase> {
  const conn = sqlite.openDatabaseSync('pulse.db') as unknown as SQLiteDatabase;
  applyDurability(conn, true);
  const journal = {
    ...migrations.journal,
    entries: migrations.journal.entries.filter((e) => idx == null || e.idx <= idx),
  };
  await migrate(drizzle(conn), { journal, migrations: migrations.migrations });
  return conn;
}

/** Every row of every table (and the migration log), each value `quote()`d so types count too. */
function dump(conn: SQLiteDatabase, tables = [...tableNames(), '__drizzle_migrations']) {
  const out: Record<string, string[]> = {};
  for (const t of tables) {
    const cols = conn
      .getAllSync<{ name: string }>(`PRAGMA table_info("${t}")`)
      .map((c) => `quote("${c.name}")`);
    out[t] = conn
      .getAllSync<Record<string, string>>(`SELECT ${cols.join(" || '|' || ")} AS r FROM "${t}"`)
      .map((r) => r.r)
      .sort();
  }
  return out;
}

/** Write a media file (relative to the device's documents) with recognizable content. */
function media(rel: string, content = `bytes of ${rel}`) {
  const path = join(env.docDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
const readMedia = (rel: string) => readFileSync(join(env.docDir, rel), 'utf8');

// The fixture: every column of every table non-null somewhere, legacy strings included.
const D = 'draft-A';
const S1 = 'seg-A1'; // legacy baked edit
const S2 = 'seg-A2'; // edit as settings, caption edit, cover
const S3 = 'seg-A3'; // a split sharing S1's original
const D2 = 'draft-B';
const S4 = 'seg-B1';
const P = (seg: string, rest: string, draft = D) => `drafts/${draft}/segments/${seg}${rest}`;
const EDIT_JSON =
  '{"startMs":120,"endMs":2400,"rotation":90,"flipH":false,"crop":null,"muted":true,"speed":1.5}';
const LEGACY_EDIT = '{"history":[{"startMs":0,"endMs":900}],"index":0}'; // an older shape, kept as text
const SIG = `${P(S1, '.edited.111.mp4')}|${P(S2, '.mp4')}|${P(S1, '.mp4')}`;
const CONTEXT_KEY = 'ticket:t-42';

function seedFixture(conn: SQLiteDatabase) {
  const d = drizzle(conn, { schema });
  d.insert(schema.drafts)
    .values([
      {
        id: D,
        name: 'Trip',
        uploadServer: 'https://vault.example.org',
        uploadArtifactId: 'art-1',
        uploadStatus: 'uploaded',
        contextServer: 'https://host.example.org',
        contextRef: 'ref-9',
        mergedSignature: `${SIG}|audio 48000x2`,
        mergedDurationMs: 4321,
        captionY: 0.37,
        lastClipNumber: 3,
        createdAt: 1790000000123.5, // unixepoch('subsec') * 1000 stores fractions
        lastModified: 1790000000999,
        // Recorded for a host's place (embedded), its Send confirmed by the host.
        contextKey: CONTEXT_KEY,
        contextLabel: 'Fix login',
        contextJson: '{"kind":"ticket","id":"T-42","label":"Fix login","data":{"teamId":"t1"}}',
        uploadTypeJson: '{"id":"ticket.video","version":1}',
        createdVia: 'host',
        hostConfirmedAt: 1790000000800,
        sentAt: 1790000000750,
      },
      {
        id: D2,
        name: 'Other',
        isSummary: true,
        summaryCutoffAt: 2,
        lastClipNumber: 1,
        createdAt: 1,
        lastModified: 2,
      },
    ])
    .run();
  d.insert(schema.segments)
    .values([
      {
        id: S1,
        draftId: D,
        order: 0,
        label: '1',
        originalFilename: P(S1, '.mp4'),
        durationMs: 3000,
        editedFilename: P(S1, '.edited.111.mp4'),
        editedDurationMs: 900,
        editState: LEGACY_EDIT,
        thumbnail: P(S1, '.edited.111.thumb.jpg'),
        captionEdit: 'not json — older text', // unreadable, still carried
      },
      {
        id: S2,
        draftId: D,
        order: 1,
        label: '2',
        originalFilename: P(S2, '.mp4'),
        durationMs: 5000,
        editedFilename: P(S2, '.edited.5.mp4'),
        editedDurationMs: 1520,
        editState: EDIT_JSON,
        thumbnail: P(S2, '.cover.222.jpg'),
        captionEdit: JSON.stringify({
          file: P(S2, '.mp4'),
          words: [{ text: 'hi', t0: 0, t1: 30 }],
        }),
      },
      {
        id: S3,
        draftId: D,
        order: 2,
        label: '3',
        originalFilename: P(S1, '.mp4'), // shares S1's original
        durationMs: 3000,
        editedFilename: P(S3, '.edited.7.mp4'),
        editedDurationMs: 700,
        editState: EDIT_JSON,
        thumbnail: P(S3, '.cover.333.jpg'),
        captionEdit: JSON.stringify({ file: P(S1, '.mp4'), words: [] }),
      },
      {
        id: S4,
        draftId: D2,
        order: 0,
        label: '1',
        originalFilename: P(S4, '.mp4', D2),
        durationMs: 1000,
        thumbnail: P(S4, '.thumb.jpg', D2),
      },
    ])
    .run();
  d.insert(schema.draftTranscripts)
    .values({
      draftId: D,
      signature: SIG,
      model: 'parakeet',
      status: 'done',
      lines: '[{"text":"hello","t0":0,"t1":50}]',
      editedLines: '[{"text":"Hello!","t0":0,"t1":50}]',
      durationMs: 4321,
      createdAt: 1790000000500.25,
    })
    .run();
  d.insert(schema.clipTranscripts)
    .values([
      {
        segmentId: S1,
        model: 'base',
        file: P(S1, '.edited.111.mp4'),
        status: 'done',
        words: '[]',
        createdAt: 5,
      },
      {
        segmentId: S2,
        model: 'parakeet',
        file: P(S2, '.mp4'),
        status: 'error',
        words: 'legacy',
        createdAt: 6,
      },
    ])
    .run();
  d.insert(schema.settings)
    .values([
      { key: 'transcription.model', value: 'parakeet' },
      { key: 'some.future.key', value: '{"unknown":true}' },
      { key: 'dataMigration.legacy-drafts-import', value: 'true' },
    ])
    .run();
  d.insert(schema.uploadDestinations)
    .values({
      id: 'dest-1',
      server: 'https://vault.example.org',
      artifactId: 'art-2',
      ref: 'place-7',
      label: 'Ward 3',
      app: 'Huddle',
      returnUrl: 'https://host.example.org/back',
      createdAt: 1790000000700,
    })
    .run();
  seedLocal(conn, 'src');
  conn.runSync(
    'UPDATE drafts SET undo_history = ? WHERE id = ?',
    JSON.stringify({
      version: 1,
      checkpoint: historyCheckpoint(conn, D2),
      past: [],
      future: [],
    }),
    D2,
  );
  // The files: everything referenced, stored or derived.
  for (const rel of FIXTURE_MEDIA) media(rel);
}

/**
 * This phone's LOCAL rows (every column set): an outbox job for draft `D`, a receipt and the
 * installation id, each tagged with `phone` so two phones' rows tell apart.
 */
function seedLocal(conn: SQLiteDatabase, phone: string, jobDraft = D) {
  const d = drizzle(conn, { schema });
  d.insert(schema.uploadJobs)
    .values({
      draftId: jobDraft,
      state: 'uploading',
      clientKey: `${phone}:${jobDraft}:0123456789abcdef`,
      draftKey: `${phone}:${jobDraft}`,
      mergedSignature: SIG,
      sentAt: 1790000000750,
      uploadId: `${phone}-upload`,
      artifactId: 'art-9',
      endpoint: 'https://vault.example.org',
      partsJson: '[]',
      bytesTotal: 1000,
      bytesSent: 400,
      attempts: 1,
      nextAttemptAt: 1790000001000,
      tokenExp: 1790000009000,
      lastErrorCode: 'upload.failed',
      lastErrorMessage: 'offline',
      createdAt: 1790000000760,
      updatedAt: 1790000000770,
    })
    .run();
  d.insert(schema.uploadReceipts)
    .values({
      draftId: `${phone}-retired`,
      name: 'Sent earlier',
      contextKey: CONTEXT_KEY,
      contextLabel: 'Fix login',
      contextJson: '{"kind":"ticket","id":"T-42","label":"Fix login"}',
      uploadTypeJson: '{"id":"ticket.video","version":1}',
      outcome: 'kept',
      note: 'n',
      reason: 'ticket closed',
      uploadId: `${phone}-u0`,
      artifactId: 'art-0',
      clientKey: `${phone}:retired:0`,
      clipCount: 1,
      durationMs: 1000,
      sentAt: 1,
      deliveredAt: 2,
      expiresAt: 3,
      dismissedAt: 4,
      mediaDeletedAt: 5,
    })
    .run();
  d.insert(schema.localSettings)
    .values([
      { key: 'installationId', value: `${phone}-install` },
      { key: 'wifiOnlyUploads', value: '1' },
    ])
    .run();
}

/** Every file the fixture's rows need (what referencedMediaPaths must return). */
const FIXTURE_MEDIA = [
  P(S1, '.mp4'),
  P(S1, '.edited.111.mp4'),
  P(S1, '.edited.111.thumb.jpg'), // stored cover = derived baked-edit thumb
  P(S1, '.thumb.jpg'), // derived: pristine thumb kept for a reset
  P(S2, '.mp4'),
  P(S2, '.edited.5.mp4'),
  P(S2, '.edited.5.thumb.jpg'), // derived from editedFilename
  P(S2, '.cover.222.jpg'),
  P(S2, '.thumb.jpg'),
  P(S3, '.edited.7.mp4'),
  P(S3, '.edited.7.thumb.jpg'),
  P(S3, '.cover.333.jpg'),
  P(S3, '.thumb.jpg'),
  `drafts/${D}/export.mp4`, // derived: the persisted export
  P(S4, '.mp4', D2),
  P(S4, '.thumb.jpg', D2),
  `drafts/${D2}/export.mp4`,
].sort();

/** What a library backup carries: everything but each draft's export (merged again). */
const BACKED_UP_MEDIA = FIXTURE_MEDIA.filter((p) => !p.endsWith('/export.mp4'));

/** A library backup's database leaves out export signatures, as its files leave out exports. */
const forgetExports = (conn: SQLiteDatabase) =>
  conn.execSync('UPDATE drafts SET merged_signature = NULL, merged_duration_ms = NULL');

/**
 * What a restore brings back: no exports, no upload destinations (their tokens stay here) and none
 * of the LOCAL rows (the restoring phone keeps its own).
 */
const asRestored = (conn: SQLiteDatabase) => {
  forgetExports(conn);
  conn.execSync('DELETE FROM upload_destinations');
  for (const t of LOCAL) conn.execSync(`DELETE FROM ${t}`);
};

const byteLength = (rel: string) => {
  const f = new File(env.docDir, rel);
  return f.exists ? f.size : null;
};

beforeEach(() => {
  use(newDevice());
});

describe('durability pragmas', () => {
  it('applies WAL, synchronous FULL, fullfsync and foreign keys, and reads them back', () => {
    const conn = sqlite.openDatabaseSync('pulse.db') as unknown as SQLiteDatabase;
    applyDurability(conn, true);
    expect(readDurability(conn)).toEqual({
      journal_mode: 'wal',
      synchronous: 2,
      fullfsync: 1,
      checkpoint_fullfsync: 1,
      foreign_keys: 1,
    });
  });
});

describe('schema-driven project document', () => {
  it('carries every table and every column (all non-null in the fixture)', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    assertSchemaCoverage(conn);
    const doc = buildProject(conn, { now: 1, byteLength });
    expect(Object.keys(doc.tables).sort()).toEqual(carriedNames().sort());
    for (const t of TABLES.filter((t) => !LOCAL.includes(getTableConfig(t).name))) {
      const rows = doc.tables[getTableConfig(t).name];
      for (const key of Object.keys(getTableColumns(t))) {
        expect([getTableConfig(t).name, key, rows.some((r) => r[key] != null)]).toEqual([
          getTableConfig(t).name,
          key,
          true,
        ]);
      }
    }
    expect(doc.media.map((m) => m.path)).toEqual(FIXTURE_MEDIA);
    expect(doc.schemaVersion).toBe(APP_SCHEMA_VERSION);
  });

  it('refuses to export when the database has a column schema.ts lacks', async () => {
    const conn = await openMigrated();
    conn.execSync('ALTER TABLE segments ADD COLUMN sneaky text');
    expect(() => buildProject(conn, { now: 1, byteLength })).toThrow(
      'Export coverage: column segments.sneaky is not in schema.ts',
    );
  });

  it('checks a LOCAL table’s columns too, though it never travels', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    expect(() => assertSchemaCoverage(conn)).not.toThrow();
    conn.execSync('ALTER TABLE upload_jobs ADD COLUMN sneaky text');
    expect(() => buildProject(conn, { now: 1, byteLength })).toThrow(
      'Export coverage: column upload_jobs.sneaky is not in schema.ts',
    );
  });

  it('exact restore into a fresh migrated database reproduces every row', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    const doc: ProjectDocument = JSON.parse(
      JSON.stringify(buildProject(src, { now: 1, byteLength })),
    );
    const before = dump(src, REPLACED());

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    drizzle(dst).insert(schema.drafts).values({ id: 'local', lastClipNumber: 0 }).run(); // replaced
    for (const m of doc.media) media(m.path, readFileSync(join(source.docDir, m.path), 'utf8'));
    restoreProject(dst, doc);
    expect(dump(dst, REPLACED())).toEqual(before);
    expect(dump(dst, LOCAL)).toEqual({ upload_jobs: [], upload_receipts: [], local_settings: [] });
  });

  it('a restore keeps this phone’s receipts and local settings; jobs go with the drafts', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    const doc: ProjectDocument = JSON.parse(
      JSON.stringify(buildProject(src, { now: 1, byteLength })),
    );

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    const local = drizzle(dst, { schema });
    local
      .insert(schema.drafts)
      .values([{ id: D }, { id: 'local' }])
      .run();
    seedLocal(dst, 'dst'); // a job for D, which the document also has
    local
      .insert(schema.uploadJobs)
      .values({
        draftId: 'local',
        state: 'queued',
        clientKey: 'dst:local:x',
        draftKey: 'dst:local',
        mergedSignature: 's',
        sentAt: 1,
      })
      .run();
    const mine = dump(dst, LOCAL);

    expect(mine.upload_jobs).toHaveLength(2);

    restoreProject(dst, doc);
    expect(dump(dst, KEPT)).toEqual({
      upload_receipts: mine.upload_receipts,
      local_settings: mine.local_settings,
    });
    // Every draft was replaced, D too (the document's D isn't the one that was sent).
    expect(dump(dst, ['upload_jobs'])).toEqual({ upload_jobs: [] });
    expect(
      local
        .select()
        .from(schema.drafts)
        .all()
        .map((r) => r.contextKey),
    ).toEqual([CONTEXT_KEY, null]);
  });

  it('never writes a LOCAL table into a document, in either scope', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    for (const draftIds of [undefined, [D]]) {
      const doc = buildProject(conn, { draftIds, now: 1, byteLength });
      expect(Object.keys(doc.tables).filter((t) => LOCAL_TABLES.has(t))).toEqual([]);
    }
  });

  it('refuses a document that carries a LOCAL table', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    const doc = buildProject(conn, { now: 1, byteLength });
    const job = drizzle(conn, { schema }).select().from(schema.uploadJobs).all();
    expect(job).toHaveLength(1);
    for (const table of LOCAL) {
      expect(() => checkProject({ ...doc, tables: { ...doc.tables, [table]: [] } })).toThrow(
        'This .pulse file is damaged.',
      );
    }
    expect(() => checkProject({ ...doc, tables: { ...doc.tables, upload_jobs: job } })).toThrow(
      'This .pulse file is damaged.',
    );
  });

  it('a draft’s host context goes with it in a .pulse file; a copy of it drops the place', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    const archive = unzipSync(readFileSync(new File(await exportDrafts(conn, [D], 5)).path));
    const doc = checkProject(JSON.parse(strFromU8(archive['project.json'])));
    const context = {
      contextKey: CONTEXT_KEY,
      contextLabel: 'Fix login',
      contextJson: '{"kind":"ticket","id":"T-42","label":"Fix login","data":{"teamId":"t1"}}',
      uploadTypeJson: '{"id":"ticket.video","version":1}',
      createdVia: 'host',
      hostConfirmedAt: 1790000000800,
      sentAt: 1790000000750,
    };
    expect(doc.tables.drafts).toEqual([expect.objectContaining(context)]);
    const plan = planCopy(doc, () => 'fresh');
    expect(plan.rows.drafts).toEqual([
      expect.objectContaining({
        contextKey: null,
        contextLabel: null,
        contextJson: null,
        uploadTypeJson: null,
        hostConfirmedAt: null,
        sentAt: null,
        createdVia: 'host', // where it was made stays
      }),
    ]);
  });

  it('copy import (.pulse v2 file) gives identical rows except remapped ids and paths', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    const uri = await exportDrafts(src, [D], 1234);
    const srcRows = buildProject(src, { draftIds: [D], now: 0, byteLength }).tables;

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    seedFixture(dst); // the same ids already here: a copy must not clobber them
    const ids = ['new-D', 'new-1', 'new-2', 'new-3'];
    const fresh = () => ids.shift()!;
    expect(await pulseFileKind(uri)).toBe('project');
    const [newDraft] = await importProjectFile(dst, uri, fresh);
    expect(newDraft).toBe('new-D');

    const swap = (v: unknown) =>
      JSON.parse(
        JSON.stringify(v)
          .replaceAll(D, 'new-D')
          .replaceAll(S1, 'new-1')
          .replaceAll(S2, 'new-2')
          .replaceAll(S3, 'new-3'),
      );
    const got = buildProject(dst, { draftIds: ['new-D'], now: 0, byteLength }).tables;
    const cleared = {
      uploadServer: null,
      uploadArtifactId: null,
      uploadStatus: null,
      contextServer: null,
      contextRef: null,
      contextKey: null,
      contextLabel: null,
      contextJson: null,
      uploadTypeJson: null,
      hostConfirmedAt: null,
      sentAt: null,
      mergedSignature: null,
      mergedDurationMs: null,
    };
    expect(got.drafts).toEqual([{ ...swap(srcRows.drafts[0]), ...cleared }]);
    for (const t of ['segments', 'draft_transcripts', 'clip_transcripts']) {
      expect([t, got[t]]).toEqual([t, swap(srcRows[t])]);
    }
    // The local draft with the source's ids is untouched, and every copied file has its bytes.
    expect(dump(dst).drafts.filter((r) => r.includes(`'${D}'`))).toHaveLength(1);
    for (const rel of FIXTURE_MEDIA.filter((p) => p.includes(D) && !p.endsWith('export.mp4'))) {
      expect(readMedia(swap(rel))).toBe(readFileSync(join(source.docDir, rel), 'utf8'));
    }
  });

  it('exports drafts natively and flat: every file under the entry project.json lists', async () => {
    use(newDevice());
    const src = await openMigrated();
    seedFixture(src);
    const zips = zipCalls.length;
    const archive = unzipSync(readFileSync(new File(await exportDrafts(src, [D], 1234)).path));
    expect(zipCalls.length).toBe(zips + 1); // the native zip wrote it, not JS
    const doc = JSON.parse(strFromU8(archive['project.json']));
    expect(Object.keys(archive).every((name) => !name.includes('/'))).toBe(true);
    expect(Object.keys(archive).sort()).toEqual(
      ['project.json', ...doc.media.map((m: { entry: string }) => m.entry)].sort(),
    );
    for (const m of doc.media) {
      expect(strFromU8(archive[m.entry])).toBe(readFileSync(join(env.docDir, m.path), 'utf8'));
    }
  });

  it('imports a draft file whose entries are deflated, as Android’s native zip writes them', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    const stored = unzipSync(readFileSync(new File(await exportDrafts(src, [D], 1234)).path));
    const deflated = join(env.cacheDir, 'deflated.pulse');
    writeFileSync(deflated, zipSync(stored, { level: 6 }));

    use(newDevice());
    const dst = await openMigrated();
    const ids = ['n-D', 'n-1', 'n-2', 'n-3'];
    const [copy] = await importProjectFile(dst, `file://${deflated}`, () => ids.shift()!);
    expect(copy).toBe('n-D');
    const doc = JSON.parse(strFromU8(stored['project.json']));
    for (const m of doc.media) {
      const swapped = m.path.replace(D, 'n-D').replace(S1, 'n-1').replace(S2, 'n-2');
      expect(readMedia(swapped.replace(S3, 'n-3'))).toBe(strFromU8(stored[m.entry]));
    }
    expect(readdirSync(env.docDir).some((n) => n.startsWith('.pulse-restore-'))).toBe(false);
  });

  it('imports two drafts that share a file: moved to the first copy, copied to the other', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    // Draft B's clip uses draft A's original, as a duplicated draft keeps its source's file.
    src.runSync('UPDATE segments SET original_filename = ? WHERE id = ?', P(S1, '.mp4'), S4);
    const uri = await exportDrafts(src, [D, D2], 1234);

    use(newDevice());
    const dst = await openMigrated();
    const draftIds = await importProjectFile(dst, uri, () =>
      `x${Math.random()}`.replace('.', '').slice(0, 10),
    );
    expect(draftIds).toHaveLength(2);
    const originals = dst.getAllSync<{ f: string }>('SELECT original_filename AS f FROM segments');
    for (const { f } of originals) expect(existsSync(join(env.docDir, f))).toBe(true);
    const shared = originals
      .map((r) => r.f)
      .filter((f) => readMedia(f) === `bytes of ${P(S1, '.mp4')}`);
    expect(new Set(shared.map((f) => f.split('/')[1])).size).toBe(2); // in both new drafts
  });

  it('still imports a v2 file in the first layout (media/<path>, no entry names)', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    const doc = buildProject(src, { draftIds: [D], now: 0, byteLength });
    const files: Record<string, Uint8Array> = { 'project.json': strToU8(JSON.stringify(doc)) };
    for (const m of doc.media) files[`media/${m.path}`] = readFileSync(join(source.docDir, m.path));
    const old = join(env.cacheDir, 'first-v2.pulse');
    writeFileSync(old, zipSync(files, { level: 0 }));

    use(newDevice());
    const dst = await openMigrated();
    const [copy] = await importProjectFile(dst, `file://${old}`, () =>
      `c${Math.random()}`.slice(0, 12),
    );
    expect(
      drizzle(dst, { schema })
        .select()
        .from(schema.drafts)
        .all()
        .map((r) => r.id),
    ).toEqual([copy]);
  });

  it('refuses a project whose entry names have folders or repeat', () => {
    const base = { format: PROJECT_FORMAT, version: 2, tables: {}, schemaVersion: null };
    const media = (entry: string) => ({ path: 'drafts/a/x.mp4', byteLength: 1, entry });
    expect(() => checkProject({ ...base, media: [media('../x.mp4')] })).toThrow(/isn’t a Pulse/);
    expect(() => checkProject({ ...base, media: [media('project.json')] })).toThrow(
      /isn’t a Pulse/,
    );
    expect(() =>
      checkProject({
        ...base,
        media: [media('x.mp4'), { ...media('x.mp4'), path: 'drafts/b/x.mp4' }],
      }),
    ).toThrow(/isn’t a Pulse/);
  });

  it('still recognizes a v1 bundle as one for the v1 importer', async () => {
    const path = join(env.cacheDir, 'old.pulse');
    writeFileSync(
      path,
      zipSync(
        { 'manifest.json': strToU8('{"format":"pulse-draft-bundle","version":1,"drafts":[]}') },
        { level: 0 },
      ),
    );
    expect(await pulseFileKind(`file://${path}`)).toBe('draft-bundle');
  });

  it('refuses a draft file whose media doesn’t match its MD5, keeping nothing', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    const archive = unzipSync(readFileSync(new File(await exportDrafts(src, [D], 1234)).path));
    const doc = JSON.parse(strFromU8(archive['project.json']));
    doc.media[0].md5 = '0'.repeat(32);
    const tampered = join(env.cacheDir, 'tampered-draft.pulse');
    writeFileSync(
      tampered,
      zipSync({ ...archive, 'project.json': strToU8(JSON.stringify(doc)) }, { level: 0 }),
    );

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    await expect(importProjectFile(dst, `file://${tampered}`, () => 'copy')).rejects.toThrow(
      /damaged/,
    );
    expect(readdirSync(env.docDir).some((n) => n.startsWith('.pulse-restore-'))).toBe(false);
    expect(drizzle(dst, { schema }).select().from(schema.drafts).all()).toEqual([]);
    expect(existsSync(join(env.docDir, 'drafts', 'copy'))).toBe(false);
  });

  it('refuses a project whose child rows have no parent', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    const doc = buildProject(conn, { draftIds: [D], now: 0, byteLength });
    expect(() => checkProject({ ...doc, tables: { ...doc.tables, drafts: [] } })).toThrow(
      'This .pulse file is damaged.',
    );
  });
});

/** A closed editor whose last addition is held only for Redo, including all of its metadata. */
function seedUndoFixture(conn: SQLiteDatabase): PersistedHistory {
  seedFixture(conn);
  const rows = drizzle(conn).select().from(schema.segments).all();
  const added = rows.find((r) => r.id === S2)!;
  const transcripts = drizzle(conn)
    .select()
    .from(schema.clipTranscripts)
    .all()
    .filter((r) => r.segmentId === S2);
  conn.runSync('DELETE FROM segments WHERE draft_id = ?', D);
  const history: PersistedHistory = {
    version: 1,
    checkpoint: historyCheckpoint(conn, D),
    past: [
      {
        kind: 'state',
        snapshot: {
          order: [S1, S2],
          edits: { [S1]: null, [S2]: EDIT_JSON },
          captions: { [S1]: null, [S2]: added.captionEdit },
          captionY: 0.2,
        },
      },
    ],
    future: [
      {
        kind: 'added',
        ids: [S2],
        taken: {
          draftId: D,
          order: [S1, S2],
          rows: [added],
          transcripts,
        },
      },
    ],
  };
  conn.runSync('UPDATE drafts SET undo_history = ? WHERE id = ?', JSON.stringify(history), D);
  return history;
}

function savedUndo(conn: SQLiteDatabase, draftId: string) {
  const row = conn.getFirstSync<{ history: string | null }>(
    'SELECT undo_history AS history FROM drafts WHERE id = ?',
    draftId,
  );
  return parsePersistedHistory(row?.history, draftId)!;
}

describe('undo history in .pulse files', () => {
  it('round trips an empty draft with dormant Redo clips under fresh IDs, without touching the source', async () => {
    const conn = await openMigrated();
    const original = seedUndoFixture(conn);
    const sourceSaved = JSON.stringify(original);
    const uri = await exportDrafts(conn, [D], 12345);
    const archive = unzipSync(readFileSync(new File(uri).path));
    const doc = checkProject(JSON.parse(strFromU8(archive['project.json'])));
    expect(doc.tables.segments).toEqual([]);
    const archived = parsePersistedHistory(doc.tables.drafts[0].undoHistory as string, D)!;
    expect(archived).toEqual(original);
    expect(new Set(doc.media.map((m) => m.path))).toEqual(
      new Set([...historyMediaPaths(original)].filter((p) => byteLength(p) !== null)),
    );
    let id = 0;
    const [copy] = await importProjectFile(conn, uri, () => `copy-${++id}`);
    const history = savedUndo(conn, copy);
    const sourceIds = historyClipIds(original);
    expect([...historyClipIds(history)].every((x) => !sourceIds.has(x))).toBe(true);
    expect(history.checkpoint).toBe(historyCheckpoint(conn, copy));
    expect(history.past).toHaveLength(1);
    expect(history.future).toHaveLength(1);
    const addition = history.future[0];
    if (addition.kind !== 'added' || !addition.taken) throw new Error('Expected dormant addition');
    const [row] = addition.taken.rows;
    expect(row.draftId).toBe(copy);
    expect(row.editState).toBe(EDIT_JSON);
    expect(row.label).toBe('2');
    expect(addition.taken.transcripts[0]).toEqual(
      expect.objectContaining({
        segmentId: row.id,
        file: row.originalFilename,
        model: 'parakeet',
        words: 'legacy',
      }),
    );
    const caption = JSON.parse(row.captionEdit!);
    expect(caption.file.startsWith(`drafts/${copy}/`)).toBe(true);
    expect([...historyMediaPaths(history)].every((p) => p.startsWith(`drafts/${copy}/`))).toBe(
      true,
    );
    // Exercise the imported addition in storage, not just the serialized map. The originals
    // retain their rows and files while the imported copy goes through Redo then Undo.
    const app = appLibrary();
    try {
      await app.drafts.restoreSegments(addition.taken);
      expect(
        conn.getFirstSync<{ n: number }>(
          'SELECT count(*) AS n FROM segments WHERE draft_id = ?',
          copy,
        )?.n,
      ).toBe(1);
      expect(
        conn.getFirstSync<{ words: string }>(
          'SELECT words FROM clip_transcripts WHERE segment_id = ?',
          row.id,
        )?.words,
      ).toBe('legacy');
      const taken = await app.drafts.takeOutSegments(addition.ids);
      expect(taken?.rows[0].id).toBe(row.id);
      expect(
        conn.getFirstSync<{ n: number }>(
          'SELECT count(*) AS n FROM segments WHERE draft_id = ?',
          copy,
        )?.n,
      ).toBe(0);
    } finally {
      app.client.expoDb.closeSync();
    }
    expect(
      conn.getFirstSync<{ history: string }>(
        'SELECT undo_history AS history FROM drafts WHERE id = ?',
        D,
      )?.history,
    ).toBe(sourceSaved);
    expect(readMedia(P(S2, '.mp4'))).toBe(`bytes of ${P(S2, '.mp4')}`);
    expect(existsSync(join(env.docDir, row.originalFilename))).toBe(true);
  });

  it('reopens and transfers a direct split’s Undo/Redo without an inserted clip', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    const sourceFile = P(S4, '.mp4', D2);
    const caption = JSON.stringify({
      file: sourceFile,
      words: [{ text: 'split me', t0: 0, t1: 90 }],
    });
    conn.runSync('UPDATE segments SET caption_edit = ? WHERE id = ?', caption, S4);
    conn.runSync(
      'INSERT INTO clip_transcripts (segment_id, model, file, status, words, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      S4,
      'tiny',
      sourceFile,
      'done',
      '[{"text":"split me","t0":0,"t1":90}]',
      1,
    );
    const app = appLibrary(true);
    const closeCallbacks = new Set<() => void>();
    const failed = jest.fn();
    const open = (draftId: string) => {
      const session = app.undo!.editorUndoSession(draftId);
      const stop = session.open(failed);
      closeCallbacks.add(stop);
      return {
        session,
        store: session.store,
        close: async () => {
          closeCallbacks.delete(stop);
          stop();
          await app.flushUndo!();
        },
      };
    };
    const rows = (draftId: string) =>
      drizzle(conn)
        .select()
        .from(schema.segments)
        .all()
        .filter((row) => row.draftId === draftId)
        .sort((a, b) => a.order - b.order);
    const now = (draftId: string) => ({
      clips: rows(draftId).map((row) => ({ id: row.id, editKey: row.editState })),
      captions: new Map(rows(draftId).map((row) => [row.id, row.captionEdit])),
      captionY: null,
    });
    const noSnapshot = () => {
      throw new Error('A direct split must remain one structural step.');
    };
    try {
      const original = rows(D2);
      const first = open(D2);
      const receipt = await app.drafts.splitSegment(D2, {
        before: S4,
        split: {
          sourceMs: 500,
          offsetMs: 500,
          sourceKey: renderKey(original[0]),
          rightId: 'direct-split-right',
        },
      });
      expect(receipt).not.toHaveProperty('firstInsertedId');
      first.store.recordAdded([], [receipt]);
      await app.flushUndo!();
      expect(rows(D2)).toHaveLength(2);
      await first.close();
      const reopened = open(D2);
      expect(reopened.session).not.toBe(first.session);
      expect(savedUndo(conn, D2).past[0]).toMatchObject({ kind: 'added', ids: [] });
      reopened.store.undo(now(D2), noSnapshot);
      await app.flushUndo!();
      expect(rows(D2)).toEqual(original);
      await reopened.close();
      const sourceHistory = savedUndo(conn, D2);
      expect(sourceHistory.future).toHaveLength(1);
      const uri = await exportDrafts(conn, [D2], 54321);
      let fresh = 0;
      const [copy] = await importProjectFile(conn, uri, () => `direct-copy-${++fresh}`);
      const imported = open(copy);
      const copiedStep = savedUndo(conn, copy).future[0];
      if (copiedStep.kind !== 'added') throw new Error('Expected split step');
      expect(copiedStep.ids).toEqual([]);
      expect(copiedStep.splits?.[0]).not.toHaveProperty('firstInsertedId');
      imported.store.redo(now(copy), noSnapshot);
      await app.flushUndo!();
      expect(rows(copy)).toHaveLength(2);
      expect(rows(copy).every((row) => row.captionEdit?.includes(`drafts/${copy}/`))).toBe(true);
      expect(
        conn.getAllSync<{ words: string }>(
          'SELECT words FROM clip_transcripts WHERE segment_id IN (SELECT id FROM segments WHERE draft_id = ?)',
          copy,
        ),
      ).toEqual([
        { words: '[{"text":"split me","t0":0,"t1":90}]' },
        { words: '[{"text":"split me","t0":0,"t1":90}]' },
      ]);
      await imported.close();
      const copiedReopened = open(copy);
      expect(copiedReopened.session).not.toBe(imported.session);
      copiedReopened.store.undo(now(copy), noSnapshot);
      await app.flushUndo!();
      expect(rows(copy)).toHaveLength(1);
      expect(rows(copy)[0].captionEdit).toContain('split me');
      expect(savedUndo(conn, D2)).toEqual(sourceHistory);
      expect(rows(D2)).toEqual(original);
      expect(readMedia(sourceFile)).toBe(`bytes of ${sourceFile}`);
      expect(failed).not.toHaveBeenCalled();
    } finally {
      for (const close of closeCallbacks) close();
      await app.flushUndo!();
      app.client.expoDb.closeSync();
    }
  });

  it('keeps a saved Redo source when its containing draft is explicitly deleted', async () => {
    const conn = await openMigrated();
    const history = seedUndoFixture(conn);
    const shared = P(S4, '.mp4', D2);
    const step = history.future[0];
    if (step.kind !== 'added' || !step.taken) throw new Error('Expected addition');
    step.taken.rows[0].originalFilename = shared;
    conn.runSync('UPDATE drafts SET undo_history = ? WHERE id = ?', JSON.stringify(history), D);
    const app = appLibrary();
    try {
      await app.drafts.deleteDraft(D2);
      expect(conn.getFirstSync('SELECT id FROM drafts WHERE id = ?', D2)).toBeNull();
      expect(readMedia(shared)).toBe(`bytes of ${shared}`);
      expect(savedUndo(conn, D)).toEqual(history);
      expect(existsSync(join(env.docDir, `drafts/${D2}/export.mp4`))).toBe(false);
      conn.runSync('UPDATE drafts SET undo_history = NULL WHERE id = ?', D);
      expect(app.drafts.deleteDraftMedia(D2)).toBe(true);
      expect(existsSync(join(env.docDir, `drafts/${D2}`))).toBe(false);
    } finally {
      app.client.expoDb.closeSync();
    }
  });

  it.each(['draft', 'library'] as const)(
    'keeps the captured %s archive usable while Redo is invalidated and its draft is deleted',
    async (kind) => {
      const conn = await openMigrated();
      const history = seedUndoFixture(conn);
      conn.runSync('DELETE FROM upload_jobs WHERE draft_id = ?', D);
      const source = P(S2, '.mp4');
      const originalBytes = readMedia(source);
      const app = appLibrary(true);
      try {
        const pending =
          kind === 'draft' ? app.exportDrafts!(conn, [D], 4455) : app.backup!(conn, 4455);
        // The archive has captured its document/database and yielded between media hashes.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        conn.runSync('UPDATE drafts SET undo_history = NULL WHERE id = ?', D);
        await app.drafts.dropHistoryFiles([...historyMediaPaths(history)]);
        await app.drafts.deleteDraft(D);
        expect(conn.getFirstSync('SELECT id FROM drafts WHERE id = ?', D)).toBeNull();
        expect(readMedia(source)).toBe(originalBytes);
        const uri = await pending;
        const archive = unzipSync(readFileSync(new File(uri).path));
        const metadata = JSON.parse(
          strFromU8(archive[kind === 'draft' ? 'project.json' : 'manifest.json']),
        );
        const listed = kind === 'draft' ? metadata.media : metadata.files;
        const captured = listed.find((entry: { path: string }) => entry.path === source);
        expect(strFromU8(archive[captured.entry])).toBe(originalBytes);
        expect(app.drafts.deleteDraftMedia(D)).toBe(true); // the archive released its hold
        expect(existsSync(join(env.docDir, `drafts/${D}`))).toBe(false);
        if (kind === 'draft') {
          let id = 0;
          const [copy] = await importProjectFile(conn, uri, () => `during-export-${++id}`);
          expect(savedUndo(conn, copy).future).toHaveLength(1);
        } else {
          Object.assign(env, newDevice());
          const target = await openMigrated();
          await restoreLibraryBackup(target, uri, 9000);
          target.closeSync();
          const launched = openLibrary(10000);
          expect(launched.restored).toBe(true);
          expect(savedUndo(launched.conn, D).future).toHaveLength(1);
          expect(readMedia(source)).toBe(originalBytes);
          launched.conn.closeSync();
        }
      } finally {
        app.client.expoDb.closeSync();
      }
    },
  );

  it.each(['capture first', 'render first'] as const)(
    'keeps pristine archive thumbnail bytes stable when Reset starts %s',
    async (order) => {
      const conn = await openMigrated();
      seedFixture(conn);
      const thumb = P(S4, '.thumb.jpg', D2);
      const original = readMedia(thumb);
      const app = appLibrary(true);
      let rendering!: () => void;
      let finish!: () => void;
      const started = new Promise<void>((resolve) => {
        rendering = resolve;
      });
      const prepared = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const render = jest
        .spyOn(app.video!, 'generateThumbnailFile')
        .mockImplementation(async (_source, destination) => {
          rendering();
          if (order === 'render first') await prepared;
          new File(destination).write('new pristine frame');
          return true;
        });
      let resetting: Promise<void> | null = null;
      let pending: Promise<string> | null = null;
      try {
        if (order === 'render first') {
          resetting = app.drafts.resetEdit(S4);
          await started;
        }
        pending = app.exportDrafts!(conn, [D2], 5511);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (resetting) {
          finish();
          await resetting;
        } else await app.drafts.resetEdit(S4);
        const current = conn.getFirstSync<{ thumbnail: string }>(
          'SELECT thumbnail FROM segments WHERE id = ?',
          S4,
        )!.thumbnail;
        expect(current).not.toBe(thumb);
        expect(current).toMatch(/\.cover\.\d+\.jpg$/);
        expect(readMedia(current)).toBe('new pristine frame');
        expect(readMedia(thumb)).toBe(original);
        const archive = unzipSync(readFileSync(new File(await pending).path));
        const doc = checkProject(JSON.parse(strFromU8(archive['project.json'])));
        const captured = doc.media.find((file) => file.path === thumb)!;
        expect(strFromU8(archive[captured.entry!])).toBe(original);
      } finally {
        finish();
        await resetting?.catch(() => {});
        await pending?.catch(() => {});
        render.mockRestore();
        app.client.expoDb.closeSync();
      }
    },
  );

  it('journals a legacy video cleanup deferred by an archive and retries only those named files', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    const legacy = P(S4, '.edited.pending.mp4', D2);
    const legacyThumb = P(S4, '.edited.pending.thumb.jpg', D2);
    const recovery = P('unreferenced-recovery', '.mp4', D2);
    media(legacy, 'legacy edited video');
    media(legacyThumb, 'legacy thumb');
    media(recovery, 'keep recovery bytes');
    conn.runSync(
      'UPDATE segments SET edited_filename = ?, edited_duration_ms = ? WHERE id = ?',
      legacy,
      500,
      S4,
    );
    const app = appLibrary(true);
    try {
      const pending = app.exportDrafts!(conn, [D2], 7722);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await app.drafts.resetEdit(S4);
      expect(existsSync(join(env.docDir, legacy))).toBe(true);
      const journal = JSON.parse(
        conn.getFirstSync<{ value: string }>(
          'SELECT value FROM settings WHERE key = ?',
          'drafts.heldForRedo',
        )!.value,
      );
      expect(journal).toEqual(expect.arrayContaining([legacy, legacyThumb]));
      await pending;
      expect(app.dropHeld!(referencedMediaPaths(conn))).toBeGreaterThanOrEqual(2);
      expect(existsSync(join(env.docDir, legacy))).toBe(false);
      expect(existsSync(join(env.docDir, legacyThumb))).toBe(false);
      expect(readMedia(recovery)).toBe('keep recovery bytes');
      expect(existsSync(join(env.docDir, P(S4, '.mp4', D2)))).toBe(true);
    } finally {
      app.client.expoDb.closeSync();
    }
  });

  it.each(['live', 'saved Redo'] as const)(
    'preserves a legacy upload sibling referenced by %s during cleanup and launch retry',
    async (owner) => {
      const conn = await openMigrated();
      const history = seedUndoFixture(conn);
      const source = P('legacy-base', '.mp4', D2);
      const sibling = P('legacy-base', '.upload.mp4', D2);
      const recovery = P('unreferenced-recovery', '.mp4', D2);
      media(source);
      media(sibling, 'keep shared legacy source');
      media(recovery, 'keep recovery input');
      if (owner === 'live') {
        conn.runSync('UPDATE segments SET original_filename = ? WHERE id = ?', sibling, S4);
      } else {
        const step = history.future[0];
        if (step.kind !== 'added' || !step.taken) throw new Error('Expected addition');
        step.taken.rows[0].originalFilename = sibling;
        conn.runSync('UPDATE drafts SET undo_history = ? WHERE id = ?', JSON.stringify(history), D);
      }
      const app = appLibrary(true);
      try {
        await app.drafts.dropHistoryFiles([source]);
        expect(existsSync(join(env.docDir, source))).toBe(false);
        expect(readMedia(sibling)).toBe('keep shared legacy source');
        conn.runSync(
          "INSERT INTO settings (key, value) VALUES ('drafts.heldForRedo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          JSON.stringify([source]),
        );
        app.dropHeld!(referencedMediaPaths(conn));
        expect(readMedia(sibling)).toBe('keep shared legacy source');
        if (owner === 'live')
          conn.runSync(
            'UPDATE segments SET original_filename = ? WHERE id = ?',
            P(S4, '.mp4', D2),
            S4,
          );
        else conn.runSync('UPDATE drafts SET undo_history = NULL WHERE id = ?', D);
        await app.drafts.dropHistoryFiles([source]);
        expect(existsSync(join(env.docDir, sibling))).toBe(false);
        expect(readMedia(recovery)).toBe('keep recovery input');
      } finally {
        app.client.expoDb.closeSync();
      }
    },
  );

  it('rejects an archive whose dormant replay rows disagree with its recorded addition IDs', async () => {
    const conn = await openMigrated();
    seedUndoFixture(conn);
    const before = dump(conn);
    const uri = await exportDrafts(conn, [D], 8811);
    const archive = unzipSync(readFileSync(new File(uri).path));
    const doc = JSON.parse(strFromU8(archive['project.json'])) as ProjectDocument;
    const history = parsePersistedHistory(doc.tables.drafts[0].undoHistory as string, D)!;
    const step = history.future[0];
    if (step.kind !== 'added') throw new Error('Expected addition');
    step.ids = ['unrelated'];
    doc.tables.drafts[0].undoHistory = JSON.stringify(history);
    const tampered = join(env.cacheDir, 'wrong-replay-rows.pulse');
    writeFileSync(
      tampered,
      zipSync({ ...archive, 'project.json': strToU8(JSON.stringify(doc)) }, { level: 0 }),
    );
    const fresh = jest.fn(() => 'must-not-copy');
    await expect(importProjectFile(conn, `file://${tampered}`, fresh)).rejects.toThrow(
      'This .pulse file is damaged.',
    );
    expect(fresh).not.toHaveBeenCalled();
    expect(dump(conn)).toEqual(before);
  });

  it('preserves split originals, replaced rows and snapshot caption paths when copying', async () => {
    const conn = await openMigrated();
    const history = seedUndoFixture(conn);
    const step = history.future[0];
    if (step.kind !== 'added' || !step.taken) throw new Error('Expected addition');
    const before = { ...step.taken, rows: [{ ...step.taken.rows[0], id: S1 }], transcripts: [] };
    step.splits = [{ before, rightId: 'right-half', firstInsertedId: S2 }];
    step.taken.replaced = before.rows;
    const doc = buildProject(conn, { draftIds: [D], now: 0, byteLength });
    doc.tables.drafts[0].undoHistory = JSON.stringify(history);
    let n = 0;
    const plan = planCopy(checkProject(doc), () => `split-copy-${++n}`);
    const copied = parsePersistedHistory(
      plan.rows.drafts[0].undoHistory as string,
      plan.draftIds[0],
    )!;
    expect([...historyClipIds(copied)].every((id) => !historyClipIds(history).has(id))).toBe(true);
    expect(JSON.stringify(copied.past)).not.toContain(`drafts/${D}/`);
    expect(JSON.stringify(copied.future)).not.toContain(`drafts/${D}/`);
    const added = copied.future[0];
    if (added.kind !== 'added' || !added.taken) throw new Error('Expected addition');
    expect(added.taken.replaced?.[0]).toEqual(added.splits?.[0].before.rows[0]);
  });

  it('rejects a malformed or stale archive history before minting IDs or touching the library', async () => {
    const conn = await openMigrated();
    const history = seedUndoFixture(conn);
    const doc = buildProject(conn, { draftIds: [D], now: 0, byteLength });
    const invalid: unknown[] = [
      { ...history, version: 999 },
      { ...history, checkpoint: 'older draft' },
      { ...history, future: [{ kind: 'added', ids: [S2], taken: { draftId: D2 } }] },
    ];
    for (const value of invalid) {
      doc.tables.drafts[0].undoHistory = JSON.stringify(value);
      expect(() => checkProject(doc)).toThrow('This .pulse file is damaged.');
    }
    doc.tables.drafts[0].undoHistory = JSON.stringify(history);
    const required = P(S2, '.mp4');
    doc.media = doc.media.filter((m) => m.path !== required);
    expect(() => checkProject(doc)).toThrow('This .pulse file is damaged.');
    expect(savedUndo(conn, D)).toEqual(history);
  });

  it('omits an interrupted checkpoint from exports and retains local history media', async () => {
    const conn = await openMigrated();
    const history = seedUndoFixture(conn);
    conn.runSync('UPDATE drafts SET caption_y = ? WHERE id = ?', 0.8, D);
    const doc = buildProject(conn, { draftIds: [D], now: 0, byteLength });
    expect(doc.tables.drafts[0].undoHistory).toBeNull();
    expect(savedUndo(conn, D)).toEqual(history);
    expect(referencedMediaPaths(conn).has(P(S2, '.mp4'))).toBe(true);
  });

  it('still copies drafts whose older file has no undo column', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    const doc = buildProject(conn, { draftIds: [D], now: 0, byteLength });
    delete doc.tables.drafts[0].undoHistory;
    let n = 0;
    const plan = planCopy(checkProject(doc), () => `old-copy-${++n}`);
    expect(plan.rows.drafts[0].undoHistory).toBeNull();
  });

  it('round trips dormant undo media through a whole-library backup and restart', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    const history = seedUndoFixture(src);
    const uri = await createLibraryBackup(src, 1000);
    use(newDevice());
    const dst = await openMigrated();
    await restoreLibraryBackup(dst, uri, 2000);
    dst.closeSync();
    const launched = openLibrary(3000);
    expect(launched.restored).toBe(true);
    await migrate(drizzle(launched.conn), migrations);
    expect(savedUndo(launched.conn, D)).toEqual(history);
    for (const rel of historyMediaPaths(history)) {
      if (existsSync(join(source.docDir, rel))) {
        expect(readMedia(rel)).toBe(readFileSync(join(source.docDir, rel), 'utf8'));
      }
    }
    launched.conn.closeSync();
  });

  it('refuses export and backup when a retained replay source is missing', async () => {
    const conn = await openMigrated();
    seedUndoFixture(conn);
    rmSync(join(env.docDir, P(S2, '.mp4')));
    await expect(exportDrafts(conn, [D], 1000)).rejects.toThrow('Undo history media is missing.');
    await expect(createLibraryBackup(conn, 2000)).rejects.toThrow('Undo history media is missing.');
  });

  it('rejects over-budget dormant history before import while exempting current clip media', async () => {
    const conn = await openMigrated();
    const history = seedUndoFixture(conn);
    const doc = buildProject(conn, { draftIds: [D], now: 0, byteLength });
    const path = P(S2, '.mp4');
    doc.media.find((m) => m.path === path)!.byteLength = HISTORY_MAX_MEDIA_BYTES + 1;
    expect(() => checkProject(doc)).toThrow('This .pulse file is damaged.');
    const addition = history.future[0];
    if (addition.kind !== 'added' || !addition.taken) throw new Error('Expected addition');
    // A current clip can share a retained source. Its bytes are required by the draft regardless
    // of the stack and therefore do not consume the history-only budget.
    doc.tables.segments = [{ ...addition.taken.rows[0], id: 'current-sharer' }];
    doc.tables.drafts[0].undoHistory = JSON.stringify({
      ...history,
      checkpoint: checkpointForRows(doc.tables.drafts[0].captionY, doc.tables.segments),
    });
    expect(() => checkProject(doc)).not.toThrow();
  });

  it('rejects non-finite, fractional and negative manifest byte lengths', async () => {
    const conn = await openMigrated();
    seedUndoFixture(conn);
    const doc = buildProject(conn, { draftIds: [D], now: 0, byteLength });
    for (const size of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      doc.media[0].byteLength = size;
      expect(() => checkProject(doc)).toThrow();
    }
  });

  it('applies the history-only byte budget to whole-library backups too', async () => {
    const conn = await openMigrated();
    seedUndoFixture(conn);
    // A sparse isolated fixture changes only stat size; rejection precedes reading/zipping it.
    truncateSync(join(env.docDir, P(S2, '.mp4')), HISTORY_MAX_MEDIA_BYTES + 1);
    await expect(createLibraryBackup(conn, 2000)).rejects.toThrow(
      'Undo history exceeds its retention limit.',
    );
  });

  it('rolls back the imported rows and files when the copy transaction fails', async () => {
    const conn = await openMigrated();
    const history = seedUndoFixture(conn);
    const uri = await exportDrafts(conn, [D], 1000);
    conn.execSync(
      "CREATE TRIGGER fail_copy BEFORE INSERT ON drafts WHEN NEW.id LIKE 'fail-%' BEGIN SELECT RAISE(ABORT, 'injected copy failure'); END",
    );
    let n = 0;
    await expect(importProjectFile(conn, uri, () => `fail-${++n}`)).rejects.toThrow(
      'injected copy failure',
    );
    expect(
      conn.getFirstSync<{ n: number }>("SELECT count(*) AS n FROM drafts WHERE id LIKE 'fail-%'")
        ?.n,
    ).toBe(0);
    expect(existsSync(join(env.docDir, 'drafts', 'fail-1'))).toBe(false);
    expect(savedUndo(conn, D)).toEqual(history);
    expect(readMedia(P(S2, '.mp4'))).toBe(`bytes of ${P(S2, '.mp4')}`);
  });

  it.each(['live', 'dormant'] as const)(
    'rejects a .pulse history targeting another draft’s %s clip before copying anything',
    async (owner) => {
      const conn = await openMigrated();
      seedUndoFixture(conn);
      const target = owner === 'live' ? D : D2;
      const foreignId = owner === 'live' ? S4 : S2;
      const original = dump(conn);
      const uri = await exportDrafts(conn, [D, D2], 1000);
      const archive = unzipSync(readFileSync(new File(uri).path));
      const doc = JSON.parse(strFromU8(archive['project.json'])) as ProjectDocument;
      doc.tables.drafts.find((row) => row.id === target)!.undoHistory = JSON.stringify({
        version: 1,
        checkpoint: historyCheckpoint(conn, target),
        past: [{ kind: 'added', ids: [foreignId], taken: null }],
        future: [],
      });
      // The checkpoint truthfully describes the target draft. Only cross-draft ID ownership is
      // wrong, including the second case where the foreign clip has no live segments row.
      expect(() => checkProject(doc)).toThrow('This .pulse file is damaged.');
      const tampered = join(env.cacheDir, `foreign-${owner}.pulse`);
      writeFileSync(
        tampered,
        zipSync({ ...archive, 'project.json': strToU8(JSON.stringify(doc)) }, { level: 0 }),
      );
      const fresh = jest.fn(() => 'must-not-be-copied');
      await expect(importProjectFile(conn, `file://${tampered}`, fresh)).rejects.toThrow(
        'This .pulse file is damaged.',
      );
      expect(fresh).not.toHaveBeenCalled();
      expect(dump(conn)).toEqual(original);
      expect(readMedia(P(S2, '.mp4'))).toBe(`bytes of ${P(S2, '.mp4')}`);
      expect(readMedia(P(S4, '.mp4', D2))).toBe(`bytes of ${P(S4, '.mp4', D2)}`);
    },
  );

  it.each(['live', 'dormant'] as const)(
    'rejects a backup history targeting another draft’s %s clip before replacing the library',
    async (owner) => {
      const conn = await openMigrated();
      seedUndoFixture(conn);
      const target = owner === 'live' ? D : D2;
      const foreignId = owner === 'live' ? S4 : S2;
      const originalHistory = conn.getFirstSync<{ value: string }>(
        'SELECT undo_history AS value FROM drafts WHERE id = ?',
        target,
      )!.value;
      const original = dump(conn);
      const files = [...referencedMediaPaths(conn)].filter(
        (path) => byteLength(path) !== null && !path.endsWith('/export.mp4'),
      );
      conn.runSync(
        'UPDATE drafts SET undo_history = ? WHERE id = ?',
        JSON.stringify({
          version: 1,
          checkpoint: historyCheckpoint(conn, target),
          past: [{ kind: 'added', ids: [foreignId], taken: null }],
          future: [],
        }),
        target,
      );
      // Source selections also check the rest of the source library: the owning draft need not
      // be selected for export for its live/dormant rows to keep ownership of their IDs.
      expect(() => buildProject(conn, { draftIds: [target], now: 0, byteLength })).toThrow(
        /saved Undo history/,
      );
      expect(() => assertSafeLibrary(conn)).toThrow(/saved Undo history/);
      await expect(createLibraryBackup(conn, 3000)).rejects.toThrow(/saved Undo history/);
      // Deliberately write an older-format backup without current validation. The database and
      // every file have correct sizes and MD5s, so restore must reject the nested ownership.
      const tampered = oldBackup(conn, files);
      conn.runSync('UPDATE drafts SET undo_history = ? WHERE id = ?', originalHistory, target);
      await expect(restoreLibraryBackup(conn, tampered, 4000)).rejects.toThrow(
        'This backup is damaged.',
      );
      expect(dump(conn)).toEqual(original);
      expect(readMedia(P(S2, '.mp4'))).toBe(`bytes of ${P(S2, '.mp4')}`);
      expect(readMedia(P(S4, '.mp4', D2))).toBe(`bytes of ${P(S4, '.mp4', D2)}`);
    },
  );

  it('checks unsafe paths nested in saved undo data before restoring a database', async () => {
    const conn = await openMigrated();
    const history = seedUndoFixture(conn);
    const step = history.future[0];
    if (step.kind !== 'added' || !step.taken) throw new Error('Expected addition');
    step.taken.rows[0].originalFilename = 'drafts/../logs/pulse.log';
    conn.runSync('UPDATE drafts SET undo_history = ? WHERE id = ?', JSON.stringify(history), D);
    expect(() => assertSafeLibrary(conn)).toThrow(/saved Undo history/);
  });

  it('does not collapse distinct retained source files with the same basename', async () => {
    const conn = await openMigrated();
    const history = seedUndoFixture(conn);
    const step = history.future[0];
    if (step.kind !== 'added' || !step.taken) throw new Error('Expected addition');
    const first = {
      ...step.taken.rows[0],
      originalFilename: 'drafts/one/segments/shared.mp4',
      editedFilename: null,
    };
    const second = { ...first, id: 'second', originalFilename: 'drafts/two/segments/shared.mp4' };
    step.ids.push(second.id);
    step.taken.rows = [first, second];
    step.taken.order.push(second.id);
    media(first.originalFilename, 'first source');
    media(second.originalFilename, 'second source');
    conn.runSync('UPDATE drafts SET undo_history = ? WHERE id = ?', JSON.stringify(history), D);
    const doc = buildProject(conn, { draftIds: [D], now: 0, byteLength });
    let n = 0;
    const plan = planCopy(checkProject(doc), () => `collision-${++n}`);
    const copied = parsePersistedHistory(
      plan.rows.drafts[0].undoHistory as string,
      plan.draftIds[0],
    )!;
    const addition = copied.future[0];
    if (addition.kind !== 'added' || !addition.taken) throw new Error('Expected addition');
    const sources = addition.taken.rows.map((r) => r.originalFilename);
    expect(new Set(sources).size).toBe(2);
    expect(sources.map((p) => plan.files.get(p))).toEqual([
      first.originalFilename,
      second.originalFilename,
    ]);
  });
});

describe('referencedMediaPaths and library safety', () => {
  it('covers every stored and derived path', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    expect([...referencedMediaPaths(conn)].sort()).toEqual(FIXTURE_MEDIA);
  });

  it('refuses ids and paths that could reach outside drafts/', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    expect(() => assertSafeLibrary(conn)).not.toThrow();
    conn.execSync(`INSERT INTO drafts (id, last_clip_number) VALUES ('..', 0)`);
    expect(() => assertSafeLibrary(conn)).toThrow('Unsafe draft or clip id.');
    conn.execSync(`DELETE FROM drafts WHERE id = '..'`);
    conn.execSync(`UPDATE segments SET thumbnail = 'drafts/../logs/pulse.log' WHERE id = '${S4}'`);
    expect(() => assertSafeLibrary(conn)).toThrow('Unsafe media path.');
  });
});

describe('snapshots and launch recovery', () => {
  it('a snapshot restores to the same rows after the database is damaged', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    takeSnapshot(conn, 1000);
    forgetExports(conn); // recovery merges exports again
    const before = dump(conn);
    drizzle(conn, { schema })
      .insert(schema.drafts)
      .values({ id: 'after-snapshot', lastClipNumber: 0 })
      .run();
    conn.closeSync(); // checkpoints the WAL into pulse.db

    // Damage a page in the middle of the file (header intact): quick_check fails.
    const path = join(env.dbDir, 'pulse.db');
    const bytes = readFileSync(path);
    bytes.fill(0xab, 4096 * 2, 4096 * 3);
    writeFileSync(path, bytes);

    const opened = openLibrary(5000);
    expect(opened).toMatchObject({ recoveredFrom: 1000, failed: false, restored: false });
    expect(dump(opened.conn)).toEqual(before);
  });

  it('with no sound snapshot it fails without touching media', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    conn.closeSync();
    const path = join(env.dbDir, 'pulse.db');
    const bytes = readFileSync(path);
    bytes.fill(0xab, 4096 * 2, 4096 * 3);
    writeFileSync(path, bytes);
    expect(openLibrary(5000).failed).toBe(true);
    for (const rel of FIXTURE_MEDIA) expect(readMedia(rel)).toBe(`bytes of ${rel}`);
    expect(readFileSync(path)).toEqual(bytes); // the damaged file is left in place, untouched
  });

  it('recovers when the whole file is garbage (header gone), keeping the damaged file aside', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    takeSnapshot(conn, 1000);
    forgetExports(conn); // recovery merges exports again
    const before = dump(conn);
    conn.closeSync();

    // What the phone test did: 64 KB of random bytes, empty -wal/-shm. SQLite can't write into it.
    const path = join(env.dbDir, 'pulse.db');
    const garbage = randomBytes(65536);
    writeFileSync(path, garbage);
    writeFileSync(`${path}-wal`, '');
    writeFileSync(`${path}-shm`, '');

    const opened = openLibrary(5000);
    expect(opened).toMatchObject({ recoveredFrom: 1000, failed: false, restored: false });
    expect(dump(opened.conn)).toEqual(before);
    expect(readFileSync(join(env.dbDir, 'backups', 'damaged-5000-pulse.db'))).toEqual(garbage);
  });

  it('keeps the newest three snapshots and takes one before migrations', async () => {
    const conn = await openMigrated(17);
    for (const t of [1, 2, 3, 4]) takeSnapshot(conn, t);
    conn.closeSync();
    openLibrary(10); // the schema is behind the app's: snapshot before migrating
    const { readdirSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
    expect(
      readdirSync(join(env.dbDir, 'backups'))
        .filter((n) => n.endsWith('.db'))
        .sort(),
    ).toEqual(['pulse-10.db', 'pulse-3.db', 'pulse-4.db']);
  });

  it('recovers an empty database while a usable snapshot exists (an interrupted recovery)', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    takeSnapshot(conn, 1000);
    forgetExports(conn); // recovery merges exports again
    const before = dump(conn);
    conn.closeSync();
    for (const f of ['pulse.db', 'pulse.db-wal', 'pulse.db-shm']) {
      rmSync(join(env.dbDir, f), { force: true });
    }
    writeFileSync(join(env.dbDir, 'pulse.db'), ''); // what a copy cut short leaves

    const opened = openLibrary(5000);
    expect(opened).toMatchObject({ recoveredFrom: 1000, failed: false });
    expect(dump(opened.conn)).toEqual(before);
  });

  it('never picks a snapshot that was cut short', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    takeSnapshot(conn, 1000);
    forgetExports(conn); // recovery merges exports again
    const before = dump(conn);
    conn.closeSync();
    const backups = join(env.dbDir, 'backups');
    writeFileSync(join(backups, 'pulse-2000.db'), ''); // empty: sound, but no schema
    writeFileSync(join(backups, 'pulse-3000.db.part'), 'half a copy');
    const path = join(env.dbDir, 'pulse.db');
    const bytes = readFileSync(path);
    bytes.fill(0xab, 4096 * 2, 4096 * 3);
    writeFileSync(path, bytes);

    const opened = openLibrary(5000);
    expect(opened).toMatchObject({ recoveredFrom: 1000, failed: false });
    expect(dump(opened.conn)).toEqual(before);
    expect(existsSync(join(backups, 'pulse-3000.db.part'))).toBe(false); // cleared at launch
  });

  it('a staged restore that can’t be applied leaves the library as it was, once', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    const before = dump(conn);
    conn.closeSync();
    const backups = join(env.dbDir, 'backups');
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(backups, 'restore-pending.db'), randomBytes(8192));
    media('.pulse-pending-media/drafts/x/segments/y.mp4', 'from the backup');

    const opened = openLibrary(5000);
    expect(opened).toMatchObject({ restored: false, restoreFailed: true, failed: false });
    expect(dump(opened.conn)).toEqual(before);
    expect(existsSync(join(backups, 'restore-pending.db'))).toBe(false);
    expect(existsSync(join(backups, 'restore-failed-5000.db'))).toBe(true);
    expect(existsSync(join(env.docDir, '.pulse-pending-media'))).toBe(false);
    opened.conn.closeSync();
    expect(openLibrary(6000)).toMatchObject({ restoreFailed: false, failed: false });
  });

  it('a routine snapshot that can’t be written never stops the launch', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    conn.closeSync();
    writeFileSync(join(env.dbDir, 'backups'), 'a file where the folder goes');
    const opened = openLibrary(5000); // no snapshot yet, so one is due
    expect(opened).toMatchObject({ failed: false, restoreFailed: false });
    rmSync(join(env.dbDir, 'backups'));
  });

  it('leftover restore files never touch the library unless their database was applied', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    conn.closeSync();
    const live = FIXTURE_MEDIA[0];
    media(`.pulse-pending-media/${live}`, 'from a restore that never finished');
    expect(openLibrary(5000)).toMatchObject({ restoreFailed: false, failed: false });
    expect(readMedia(live)).toBe(`bytes of ${live}`);
    expect(existsSync(join(env.docDir, '.pulse-pending-media'))).toBe(false);
  });

  it('after going back to a snapshot, exports merge again', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    takeSnapshot(conn, 1000);
    conn.closeSync();
    writeFileSync(join(env.dbDir, 'pulse.db'), randomBytes(65536));
    writeFileSync(join(env.dbDir, 'pulse.db-wal'), '');
    writeFileSync(join(env.dbDir, 'pulse.db-shm'), '');

    const opened = openLibrary(5000);
    expect(opened.recoveredFrom).toBe(1000);
    const rows = drizzle(opened.conn, { schema }).select().from(schema.drafts).all();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect([r.mergedSignature, r.mergedDurationMs]).toEqual([null, null]);
  });
});

describe('library backup', () => {
  it('round-trips the whole library, media included (exports merged again)', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    media('drafts/gone-draft/segments/leftover.mp4', 'a file no row references');
    const uri = await createLibraryBackup(src, 42);
    asRestored(src);
    const before = dump(src);

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    drizzle(dst).insert(schema.drafts).values({ id: 'local', lastClipNumber: 0 }).run();
    expect(await pulseFileKind(uri)).toBe('library-backup');
    await restoreLibraryBackup(dst, uri, 100);
    dst.closeSync();
    const relaunched = openLibrary(200); // the staged database becomes the library here
    expect(relaunched.restored).toBe(true);
    await migrate(drizzle(relaunched.conn), migrations);
    expect(dump(relaunched.conn)).toEqual(before);
    for (const rel of BACKED_UP_MEDIA) expect(readMedia(rel)).toBe(`bytes of ${rel}`);
    expect(existsSync(join(env.docDir, `drafts/${D}/export.mp4`))).toBe(false);
    expect(existsSync(join(env.docDir, 'drafts/gone-draft'))).toBe(false); // never carried
  });

  it('restores a backup from an older schema, then migrates it', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated(17); // before caption edits (0018) and link places (0019)
    src.execSync(`INSERT INTO drafts (id, name, last_clip_number) VALUES ('old', 'Old draft', 1)`);
    src.execSync(
      `INSERT INTO segments (id, draft_id, sort_order, label, original_filename, duration_ms) VALUES ('old-1', 'old', 0, '1', 'drafts/old/segments/old-1.mp4', 1000)`,
    );
    media('drafts/old/segments/old-1.mp4');
    const uri = oldBackup(src, ['drafts/old/segments/old-1.mp4']);

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    await restoreLibraryBackup(dst, uri, 100);
    dst.closeSync();
    const relaunched = openLibrary(200);
    expect(schemaVersion(relaunched.conn)).toBe(migrations.journal.entries[17].when);
    await migrate(drizzle(relaunched.conn), migrations);
    expect(schemaVersion(relaunched.conn)).toBe(APP_SCHEMA_VERSION);
    const rows = drizzle(relaunched.conn, { schema }).select().from(schema.segments).all();
    expect(rows).toEqual([expect.objectContaining({ id: 'old-1', captionEdit: null })]);
    expect(readMedia('drafts/old/segments/old-1.mp4')).toBe(
      'bytes of drafts/old/segments/old-1.mp4',
    );
  });

  it('refuses a backup from a newer schema, before writing anything', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    src.execSync(
      `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('', ${APP_SCHEMA_VERSION + 1000})`,
    );
    const uri = await createLibraryBackup(src, 42);

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    await expect(restoreLibraryBackup(dst, uri, 100)).rejects.toThrow(
      'This backup was made by a newer version of Pulse. Update Pulse, then restore it.',
    );
    expect(existsSync(join(env.dbDir, 'backups'))).toBe(false);
    expect(existsSync(join(env.docDir, 'drafts'))).toBe(false);
  });

  it('records each file’s native MD5 and checks restored media against it, not the CRC', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    const uri = await createLibraryBackup(src, 42);
    const archive = unzipSync(readFileSync(new File(uri).path));
    const manifest = JSON.parse(strFromU8(archive['manifest.json']));
    // Flat: exactly the manifest's files, each under its base name, plus the manifest.
    type Listed = { path: string; entry: string; md5: string };
    expect(Object.keys(archive).sort()).toEqual(
      ['manifest.json', ...manifest.files.map((f: Listed) => f.entry)].sort(),
    );
    expect(manifest.files.map((f: Listed) => f.path).sort()).toEqual(
      ['pulse.db', ...BACKED_UP_MEDIA].sort(),
    );
    for (const f of manifest.files as Listed[]) {
      expect(f.md5).toBe(createHash('md5').update(archive[f.entry]).digest('hex'));
    }

    // Same bytes (so every CRC still matches), one manifest MD5 changed: only the MD5 check sees it.
    const victim = manifest.files.find((f: { path: string }) => f.path.startsWith('drafts/'));
    victim.md5 = '0'.repeat(32);
    const tampered = join(env.cacheDir, 'tampered.pulse');
    writeFileSync(
      tampered,
      zipSync({ ...archive, 'manifest.json': strToU8(JSON.stringify(manifest)) }, { level: 0 }),
    );

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    md5Calls.length = 0;
    await expect(restoreLibraryBackup(dst, `file://${tampered}`, 100)).rejects.toThrow(
      'This backup is damaged.',
    );
    expect(existsSync(join(env.docDir, 'drafts'))).toBe(false); // nothing moved into the library
    expect(readdirSync(env.docDir).filter((n) => n.startsWith('.pulse-restore'))).toEqual([]);
    expect(md5Calls.length).toBeGreaterThan(0); // restored files were hashed natively

    const fresh = newDevice();
    use(fresh);
    const ok = await openMigrated();
    await restoreLibraryBackup(ok, uri, 100); // the untouched backup still restores
    for (const rel of BACKED_UP_MEDIA) expect(readMedia(rel)).toBe(`bytes of ${rel}`);
  });

  it('refuses a backup or a restore the phone has no room for, before writing anything', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    // Made with room to spare, and kept outside pulse-exports (each export clears that folder).
    const kept = join(ROOT, 'roomy.pulse');
    writeFileSync(kept, readFileSync(new File(await createLibraryBackup(src, 42)).path));
    const uri = `file://${kept}`;

    env.availableDiskSpace = 1000;
    try {
      await expect(createLibraryBackup(src, 43)).rejects.toThrow(/needs about .* GB free/);
      // No new archive or staged database; the last backup made is left alone.
      expect(readdirSync(join(env.cacheDir, 'pulse-exports'))).toEqual(['library-42']);
    } finally {
      env.availableDiskSpace = Infinity;
    }

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    env.availableDiskSpace = 1000;
    try {
      await expect(restoreLibraryBackup(dst, uri, 100)).rejects.toThrow(/needs about .* GB free/);
      expect(existsSync(join(env.docDir, 'drafts'))).toBe(false);
      expect(existsSync(join(env.dbDir, 'backups', 'restore-pending.db'))).toBe(false);
    } finally {
      env.availableDiskSpace = Infinity;
    }
  });

  it('refuses a backup whose database has an unsafe id, before touching the library', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    src.execSync(`INSERT INTO drafts (id, name, last_clip_number) VALUES ('..', 'Crafted', 0)`);
    const uri = oldBackup(src, []);

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    await expect(restoreLibraryBackup(dst, uri, 100)).rejects.toThrow('This backup is damaged.');
    expect(existsSync(join(env.dbDir, 'backups', 'restore-pending.db'))).toBe(false);
    expect(readdirSync(env.docDir).filter((n) => n.startsWith('.pulse-restore'))).toEqual([]);
  });

  it('refuses manifest paths that escape drafts/ or collide with the database', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    for (const path of ['drafts/../escaped.txt', 'drafts/pulse.db', '/etc/passwd']) {
      const uri = oldBackup(src, [], [{ path, size: 1, md5: '0'.repeat(32) }]);
      const target = newDevice();
      use(target);
      const dst = await openMigrated();
      await expect(restoreLibraryBackup(dst, uri, 100)).rejects.toThrow('This backup is damaged.');
      expect(existsSync(join(env.dbDir, 'backups', 'restore-pending.db'))).toBe(false);
      use(source);
    }
  });

  it('a file that differs from one already here is replaced with the database, not before', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    const uri = await createLibraryBackup(src, 42);
    asRestored(src);
    const before = dump(src, REPLACED());

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    seedFixture(dst);
    const mine = dump(dst, KEPT);
    const live = P(S2, '.cover.222.jpg'); // a file both libraries have, at the same path
    media(live, 'this phone’s newer copy');
    await restoreLibraryBackup(dst, uri, 100);
    expect(readMedia(live)).toBe('this phone’s newer copy'); // the old rows still point at it
    dst.closeSync();

    const relaunched = openLibrary(200);
    expect(relaunched).toMatchObject({ restored: true, restoreFailed: false, failed: false });
    expect(readMedia(live)).toBe(`bytes of ${live}`);
    await migrate(drizzle(relaunched.conn), migrations);
    expect(dump(relaunched.conn, REPLACED())).toEqual(before);
    expect(dump(relaunched.conn, KEPT)).toEqual(mine); // this phone's own, not the backup's
    expect(existsSync(join(env.docDir, '.pulse-pending-media'))).toBe(false);
  });

  it('restores from the recovery screen over a database with no usable snapshot', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    const uri = await createLibraryBackup(src, 42);
    asRestored(src);
    const before = dump(src);

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    dst.closeSync();
    const garbage = randomBytes(65536);
    writeFileSync(join(env.dbDir, 'pulse.db'), garbage);
    writeFileSync(join(env.dbDir, 'pulse.db-wal'), '');
    writeFileSync(join(env.dbDir, 'pulse.db-shm'), '');
    const broken = openLibrary(100);
    expect(broken.failed).toBe(true);

    await restoreLibraryBackup(broken.conn, uri, 150, { snapshotCurrent: false });
    broken.conn.closeSync();
    const relaunched = openLibrary(200);
    expect(relaunched).toMatchObject({ restored: true, restoreFailed: false, failed: false });
    await migrate(drizzle(relaunched.conn), migrations);
    expect(dump(relaunched.conn)).toEqual(before);
    expect(readFileSync(join(env.dbDir, 'backups', 'damaged-200-pulse.db'))).toEqual(garbage);
    // The fresh connection is configured like any other: foreign keys on.
    expect(relaunched.conn.getFirstSync<{ foreign_keys: number }>('PRAGMA foreign_keys')).toEqual({
      foreign_keys: 1,
    });
  });

  it('refuses a second restore while one is waiting, touching neither', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    const uri = await createLibraryBackup(src, 42);

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    await restoreLibraryBackup(dst, uri, 100);
    await expect(restoreLibraryBackup(dst, uri, 101)).rejects.toThrow(
      'A restore is already waiting.',
    );
    expect(existsSync(join(env.dbDir, 'backups', 'restore-pending.db'))).toBe(true);
  });

  it('refuses a backup whose database isn’t a complete library once migrated', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    for (const t of ['segments', 'draft_transcripts', 'clip_transcripts', 'settings']) {
      src.execSync(`DROP TABLE IF EXISTS "${t}"`);
    }
    const uri = oldBackup(src, []);

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    await expect(restoreLibraryBackup(dst, uri, 100)).rejects.toThrow('This backup is damaged.');
    expect(existsSync(join(env.dbDir, 'backups', 'restore-pending.db'))).toBe(false);
  });

  it('never carries LOCAL rows in a backup; a restore keeps this phone’s and the context', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src); // with src's own job, receipt and installation id
    const uri = await createLibraryBackup(src, 42);
    const archive = unzipSync(readFileSync(new File(uri).path));
    const copy = join(source.cacheDir, 'backed-up.db');
    writeFileSync(copy, archive['pulse.db']);
    const backedUp = sqlite.openDatabaseSync('backed-up.db', {}, source.cacheDir);
    for (const t of LOCAL) {
      expect([t, backedUp.getAllSync(`SELECT * FROM ${t}`)]).toEqual([t, []]);
    }
    backedUp.closeSync();

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    drizzle(dst)
      .insert(schema.drafts)
      .values([{ id: D }, { id: 'local' }])
      .run();
    seedLocal(dst, 'dst'); // its own job (for its own D), receipt and installation id
    const mine = dump(dst, KEPT);
    await restoreLibraryBackup(dst, uri, 100);
    dst.closeSync();
    const relaunched = openLibrary(200);
    expect(relaunched.restored).toBe(true);
    await migrate(drizzle(relaunched.conn), migrations);
    expect(dump(relaunched.conn, KEPT)).toEqual(mine);
    // Every draft was replaced, so no job is left (the backup's D isn't the one this phone sent).
    expect(dump(relaunched.conn, ['upload_jobs'])).toEqual({ upload_jobs: [] });
    const restored = drizzle(relaunched.conn, { schema });
    expect(restored.select().from(schema.drafts).all()).toEqual([
      expect.objectContaining({ id: D, contextKey: CONTEXT_KEY, createdVia: 'host' }),
      expect.objectContaining({ id: D2, contextKey: null, createdVia: 'app' }),
    ]);
  });

  it('never restores upload destinations (their tokens stay on this phone)', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    expect(drizzle(src, { schema }).select().from(schema.uploadDestinations).all()).not.toEqual([]);
    const uri = await createLibraryBackup(src, 42);

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    await restoreLibraryBackup(dst, uri, 100);
    dst.closeSync();
    const relaunched = openLibrary(200);
    await migrate(drizzle(relaunched.conn), migrations);
    expect(
      drizzle(relaunched.conn, { schema }).select().from(schema.uploadDestinations).all(),
    ).toEqual([]);
  });

  it('backs up two files that share a name (a duplicated draft keeps a shared original’s)', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    const shared = `drafts/dup/segments/${S1}.mp4`; // same base name as ${P(S1, '.mp4')}
    src.execSync(`INSERT INTO drafts (id, name, last_clip_number) VALUES ('dup', 'Copy', 1)`);
    src.execSync(
      `INSERT INTO segments (id, draft_id, sort_order, label, original_filename, duration_ms) VALUES ('dup-1', 'dup', 0, '1', '${shared}', 1000)`,
    );
    const copyBytes = 'c'.repeat(1 << 20); // big enough that the copy decides the room check
    media(shared, copyBytes);
    const uri = await createLibraryBackup(src, 42);
    asRestored(src);
    const before = dump(src);

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    await restoreLibraryBackup(dst, uri, 100);
    dst.closeSync();
    const relaunched = openLibrary(200);
    await migrate(drizzle(relaunched.conn), migrations);
    expect(dump(relaunched.conn)).toEqual(before);
    expect(readMedia(shared)).toBe(copyBytes);
    expect(readMedia(P(S1, '.mp4'))).toBe(`bytes of ${P(S1, '.mp4')}`);

    // The room check counts the renamed copy too: room for the archive alone is refused.
    use(source);
    const listed = JSON.parse(
      strFromU8(unzipSync(readFileSync(new File(uri).path))['manifest.json']),
    );
    const archiveBytes = listed.files.reduce((sum: number, f: { size: number }) => sum + f.size, 0);
    env.availableDiskSpace = archiveBytes + 200 * 1024 * 1024 + 1024; // the copy needs 1 MiB more
    try {
      await expect(createLibraryBackup(src, 43)).rejects.toThrow(/needs about .* GB free/);
    } finally {
      env.availableDiskSpace = Infinity;
    }
  });

  it('a restore whose files can’t all be moved holds the library, then finishes', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    const uri = await createLibraryBackup(src, 42);

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    seedFixture(dst);
    const live = P(S2, '.cover.222.jpg');
    media(live, 'this phone’s newer copy'); // differs: deferred to the launch
    await restoreLibraryBackup(dst, uri, 100);
    dst.closeSync();
    rmSync(join(env.docDir, live));
    mkdirSync(join(env.docDir, live)); // a folder in the way: the move fails

    const held = openLibrary(200);
    expect(held).toMatchObject({ restored: true, restoreIncomplete: true });
    held.conn.closeSync();
    rmSync(join(env.docDir, live), { recursive: true });

    const finished = openLibrary(300);
    expect(finished).toMatchObject({ restoreIncomplete: false, failed: false });
    expect(readMedia(live)).toBe(`bytes of ${live}`);
    expect(existsSync(join(env.docDir, '.pulse-pending-media'))).toBe(false);
  });

  it('a library backup and a draft export running together don’t clear each other’s files', async () => {
    use(newDevice());
    const src = await openMigrated();
    seedFixture(src);
    const backup = createLibraryBackup(src, 100); // yields between files
    const [uri, draft] = await Promise.all([backup, exportDrafts(src, [D], 101)]);
    expect(existsSync(new File(uri).path)).toBe(true);
    expect(existsSync(new File(draft).path)).toBe(true);
  });
});

/** A backup as an older Pulse wrote it: same format and layout, its own (older) database. */
function oldBackup(
  conn: SQLiteDatabase,
  files: string[],
  extra: { path: string; size: number; md5: string }[] = [],
): string {
  const copy = sqlite.openDatabaseSync('old-copy.db', {}, env.cacheDir);
  sqlite.backupDatabaseSync({ sourceDatabase: conn as never, destDatabase: copy });
  copy.execSync('PRAGMA journal_mode = DELETE;');
  copy.closeSync();
  const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');
  const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  const db = readFileSync(join(env.cacheDir, 'old-copy.db'));
  const media = files.map((p) => ({ path: p, bytes: readFileSync(join(env.docDir, p)) }));
  const manifest = {
    format: 'pulse-library-backup',
    version: 3,
    schemaVersion: schemaVersion(conn),
    createdAt: 1,
    files: [
      { path: 'pulse.db', entry: 'pulse.db', size: db.length, md5: md5(db) },
      ...media.map((m) => ({
        path: m.path,
        entry: base(m.path),
        size: m.bytes.length,
        md5: md5(m.bytes),
      })),
      ...extra.map((e) => ({ ...e, entry: base(e.path) })),
    ],
  };
  const out = join(env.cacheDir, 'old.pulse');
  const entries: Record<string, Uint8Array> = {
    'pulse.db': db,
    'manifest.json': strToU8(JSON.stringify(manifest)),
  };
  for (const m of media) entries[base(m.path)] = m.bytes;
  writeFileSync(out, zipSync(entries, { level: 0 }));
  return `file://${out}`;
}

/** The library as the app opens it on this device (`@/db/client` opens it on import): fresh modules. */
function appLibrary(withUndo = false) {
  let mods!: {
    client: typeof import('./client');
    drafts: typeof import('./drafts');
    host: typeof import('./host-context');
    settings: typeof import('./local-settings');
    gate: typeof import('./migrate');
    undo?: typeof import('@/features/editor/persistent-editor-history');
    flushUndo?: () => Promise<void>;
    exportDrafts?: (typeof import('@/features/draft-transfer/pack'))['exportDrafts'];
    backup?: (typeof import('@/features/draft-transfer/library-backup'))['createLibraryBackup'];
    video?: typeof import('@/utils/video');
    dropHeld?: (typeof import('@/db/held-files'))['dropHeldFiles'];
  };
  jest.isolateModules(() => {
    mods = {
      gate: jest.requireActual<typeof import('./migrate')>('./migrate'),
      client: jest.requireActual<typeof import('./client')>('./client'),
      drafts: jest.requireActual<typeof import('./drafts')>('./drafts'),
      host: jest.requireActual<typeof import('./host-context')>('./host-context'),
      settings: jest.requireActual<typeof import('./local-settings')>('./local-settings'),
    };
    if (withUndo) {
      mods.undo = jest.requireActual<typeof import('@/features/editor/persistent-editor-history')>(
        '@/features/editor/persistent-editor-history',
      );
      mods.flushUndo = jest.requireActual<typeof import('@/core/undo-write-barrier')>(
        '@/core/undo-write-barrier',
      ).waitForUndoHistory;
      mods.exportDrafts = jest.requireActual<typeof import('@/features/draft-transfer/pack')>(
        '@/features/draft-transfer/pack',
      ).exportDrafts;
      mods.backup = jest.requireActual<typeof import('@/features/draft-transfer/library-backup')>(
        '@/features/draft-transfer/library-backup',
      ).createLibraryBackup;
      mods.video = jest.requireMock<typeof import('@/utils/video')>('@/utils/video');
      mods.dropHeld =
        jest.requireActual<typeof import('@/db/held-files')>('@/db/held-files').dropHeldFiles;
    }
  });
  return mods;
}

describe('a library a newer Pulse migrated (downgrade guard)', () => {
  /** This device's library, seeded, with one migration this build doesn't ship applied after ours. */
  async function newerLibrary() {
    const conn = await openMigrated();
    seedFixture(conn);
    conn.execSync(
      `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('', ${APP_SCHEMA_VERSION + 1})`,
    );
    const rows = dump(conn);
    conn.closeSync();
    return rows;
  }
  const clip = { id: 'seg-new', originalFilename: 'drafts/x/segments/seg-new.mp4', durationMs: 1 };

  it('embedded: still lists, sends and deletes, and refuses an edit with storage.newer_schema', async () => {
    const before = await newerLibrary();
    const { client, drafts, host, settings } = appLibrary();
    try {
      expect(isNewerSchema(client.expoDb)).toBe(true);
      expect(client.guardNewerSchema('embedded')).toBe(true);
      expect(host.libraryNewerSchema()).toBe(true);

      // List.
      expect((await drafts.draftListQuery).map((r) => r.id).sort()).toEqual([D, D2]);

      // Edit: refused, nothing written.
      await expect(drafts.addSegment(D, clip)).rejects.toMatchObject({
        code: 'storage.newer_schema',
      });
      await expect(drafts.renameDraft(D, 'Renamed')).rejects.toMatchObject({
        code: 'storage.newer_schema',
      });
      // The captions switch too, before it takes the fixture's Send out.
      await expect(drafts.setDraftCaptionsOff(D, true)).rejects.toMatchObject({
        code: 'storage.newer_schema',
      });
      await expect(
        drafts.setDraftContext(D2, { key: 'ticket:t-7', label: 'Other ticket' }),
      ).rejects.toMatchObject({ code: 'storage.newer_schema' });
      await expect(drafts.createDraft({ createdVia: 'host' })).rejects.toMatchObject({
        code: 'storage.newer_schema',
      });
      expect(dump(client.expoDb)).toEqual(before);

      // Send: the export is recorded, this install's id is made and the job is queued.
      await drafts.setMergedExport(D2, { signature: 'sig-b', durationMs: 900 });
      const install = settings.installationId();
      client.db
        .insert(schema.uploadJobs)
        .values({
          draftId: D2,
          state: 'queued',
          clientKey: `${install}:${D2}:sig-b`,
          draftKey: `${install}:${D2}`,
          mergedSignature: 'sig-b',
          sentAt: 5,
        })
        .run();
      const jobs = () =>
        client.expoDb.getAllSync('SELECT draft_id FROM upload_jobs ORDER BY draft_id');
      expect(jobs()).toEqual([{ draft_id: D }, { draft_id: D2 }]); // the fixture's job, and this one

      // Delete: the draft goes, and its job with it.
      await drafts.deleteDraft(D2);
      expect((await drafts.draftListQuery).map((r) => r.id)).toEqual([D]);
      expect(jobs()).toEqual([{ draft_id: D }]);

      // No migration ran: the newer one is still the library's last.
      expect(dump(client.expoDb, ['__drizzle_migrations'])).toEqual({
        __drizzle_migrations: before.__drizzle_migrations,
      });
    } finally {
      client.expoDb.closeSync();
    }
  });

  it('embedded: the migration gate runs no migration or housekeeping on it', async () => {
    const before = await newerLibrary();
    const { client, gate, host } = appLibrary();
    const afterMigrations = jest.fn();
    try {
      await gate.runMigrations('embedded', afterMigrations);
      expect(host.libraryNewerSchema()).toBe(true);
      expect(afterMigrations).not.toHaveBeenCalled(); // no housekeeping either
      expect(dump(client.expoDb)).toEqual(before);
    } finally {
      client.expoDb.closeSync();
    }
  });

  it('standalone: the Pulse app keeps today’s behaviour (editable)', async () => {
    await newerLibrary();
    const { client, drafts, host } = appLibrary();
    try {
      expect(client.guardNewerSchema('standalone')).toBe(false);
      expect(host.libraryNewerSchema()).toBe(false);
      await drafts.renameDraft(D2, 'Renamed');
      expect(
        client.expoDb.getFirstSync<{ name: string }>(`SELECT name FROM drafts WHERE id = '${D2}'`),
      ).toEqual({ name: 'Renamed' });
    } finally {
      client.expoDb.closeSync();
    }
  });

  it('embedded, a library this build migrated: editable', async () => {
    (await openMigrated()).closeSync();
    const { client, host } = appLibrary();
    try {
      expect(isNewerSchema(client.expoDb)).toBe(false);
      expect(client.guardNewerSchema('embedded')).toBe(false);
      expect(host.libraryNewerSchema()).toBe(false);
    } finally {
      client.expoDb.closeSync();
    }
  });
});

describe('findOpenHostDraft', () => {
  it('is the newest unsent draft with a clip, for that place and upload type', async () => {
    (await openMigrated()).closeSync();
    const { client, drafts } = appLibrary();
    const ticket = { key: CONTEXT_KEY, kind: 'ticket', id: 'T-42', label: 'Fix login' };
    const video = { id: 'ticket.video', version: 1 };
    const make = async (
      lastModified: number,
      opts: { context?: typeof ticket; type?: typeof video; clip?: boolean } = {},
    ) => {
      const id = await drafts.createDraft({
        hostContext: opts.context ?? ticket,
        uploadType: opts.type ?? video,
        createdVia: 'host',
      });
      if (opts.clip !== false) {
        await drafts.addSegment(id, {
          id: `${id}-1`,
          originalFilename: `drafts/${id}/segments/${id}-1.mp4`,
          durationMs: 1000,
        });
      }
      client.expoDb.runSync('UPDATE drafts SET last_modified = ? WHERE id = ?', lastModified, id);
      return id;
    };
    try {
      const open = await make(10);
      await make(5); // older
      const sent = await make(20);
      client.expoDb.runSync(
        `INSERT INTO upload_jobs (draft_id, state, client_key, draft_key, merged_signature, sent_at)
         VALUES (?, 'queued', 'k', 'dk', 's', 1)`,
        sent,
      );
      await make(30, { clip: false }); // empty: its recorder is about to drop it
      const post = await make(40, { type: { id: 'huddle.post', version: 1 } });
      await make(50, { context: { ...ticket, key: 'ticket:t-43' } });

      expect(await drafts.findOpenHostDraft(CONTEXT_KEY, 'ticket.video')).toBe(open);
      expect(await drafts.findOpenHostDraft(CONTEXT_KEY, 'huddle.post')).toBe(post);
      expect(await drafts.findOpenHostDraft('clock:ev-1', 'ticket.video')).toBeNull();
    } finally {
      client.expoDb.closeSync();
    }
  });
});
