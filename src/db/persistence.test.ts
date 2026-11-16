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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createHash, randomBytes } from 'node:crypto';

import migrations from '../../drizzle/migrations';
import { env, File, md5Calls } from '@/test-support/expo-fs-node';
import { mockModule as sqlite } from '@/test-support/expo-sqlite-node';
import {
  createLibraryBackup,
  restoreLibraryBackup,
} from '@/features/draft-transfer/library-backup';
import { exportDrafts } from '@/features/draft-transfer/pack';
import { importProjectFile, pulseFileKind } from '@/features/draft-transfer/unpack-project';
import { applyDurability, readDurability } from './durability';
import { referencedMediaPaths, sweepUnreferencedMedia, unreferencedFiles } from './media-refs';
import {
  APP_SCHEMA_VERSION,
  assertSchemaCoverage,
  buildProject,
  restoreProject,
  schemaVersion,
  type ProjectDocument,
} from './project';
import * as schema from './schema';
import { openLibrary, takeSnapshot } from './snapshots';

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
      },
      { id: D2, name: 'Other', lastClipNumber: 1, createdAt: 1, lastModified: 2 },
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
  // The files: everything referenced, stored or derived.
  for (const rel of FIXTURE_MEDIA) media(rel);
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
    expect(Object.keys(doc.tables).sort()).toEqual(tableNames().sort());
    for (const t of TABLES) {
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

  it('exact restore into a fresh migrated database reproduces every row', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    const doc: ProjectDocument = JSON.parse(
      JSON.stringify(buildProject(src, { now: 1, byteLength })),
    );
    const before = dump(src);

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    drizzle(dst).insert(schema.drafts).values({ id: 'local', lastClipNumber: 0 }).run(); // replaced
    for (const m of doc.media) media(m.path, readFileSync(join(source.docDir, m.path), 'utf8'));
    restoreProject(dst, doc);
    expect(dump(dst)).toEqual(before);
  });

  it('copy import (.pulse v2 file) gives identical rows except remapped ids and paths', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    const uri = exportDrafts(src, [D], 1234);
    const srcRows = buildProject(src, { draftIds: [D], now: 0, byteLength }).tables;

    const target = newDevice();
    use(target);
    const dst = await openMigrated();
    seedFixture(dst); // the same ids already here: a copy must not clobber them
    const ids = ['new-D', 'new-1', 'new-2', 'new-3'];
    const fresh = () => ids.shift()!;
    expect(await pulseFileKind(uri)).toBe('project');
    const [newDraft] = importProjectFile(dst, uri, fresh);
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
});

describe('referencedMediaPaths and the sweep', () => {
  it('covers every stored and derived path', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    expect([...referencedMediaPaths(conn)].sort()).toEqual(FIXTURE_MEDIA);
  });

  it('deletes only unreferenced files, and a deleted draft frees its media', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    const orphans = [
      P(S2, '.cover.100.jpg'), // an earlier edit's cover
      P(S1, '.upload.mp4'), // a legacy upload copy
      P('seg-crash', '.mp4'), // a recording whose row never landed
      `drafts/gone-draft/segments/x.mp4`, // a draft folder without a row
    ];
    for (const rel of orphans) media(rel);
    expect(sweepUnreferencedMedia(conn, 0)).toBe(orphans.length);
    for (const rel of FIXTURE_MEDIA) expect(existsSync(join(env.docDir, rel))).toBe(true);
    for (const rel of orphans) expect(existsSync(join(env.docDir, rel))).toBe(false);
    expect(existsSync(join(env.docDir, 'drafts/gone-draft'))).toBe(false);

    drizzle(conn, { schema }).delete(schema.drafts).run(); // all drafts, rows cascade
    expect(sweepUnreferencedMedia(conn, 0)).toBe(FIXTURE_MEDIA.length);
  });

  it('sweeps nothing when a referenced path is not a plain relative one, or while held', async () => {
    expect(
      unreferencedFiles(['drafts/a/x.mp4'], new Set(['file:///abs/drafts/a/x.mp4'])),
    ).toBeNull();
    const conn = await openMigrated();
    seedFixture(conn);
    media(P(S2, '.cover.100.jpg'));
    mkdirSync(join(env.docDir, 'backups'), { recursive: true });
    writeFileSync(join(env.docDir, 'backups/sweep-hold'), '100');
    expect(sweepUnreferencedMedia(conn, 50)).toBe(0);
    expect(sweepUnreferencedMedia(conn, 150)).toBe(1);
  });
});

describe('snapshots and launch recovery', () => {
  it('a snapshot restores to the same rows after the database is damaged', async () => {
    const conn = await openMigrated();
    seedFixture(conn);
    takeSnapshot(conn, 1000);
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
    expect(existsSync(join(env.docDir, 'backups/sweep-hold'))).toBe(true);
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
});

describe('library backup', () => {
  it('round-trips the whole library, media included', async () => {
    const source = newDevice();
    use(source);
    const src = await openMigrated();
    seedFixture(src);
    const uri = await createLibraryBackup(src, 42);
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
    for (const rel of FIXTURE_MEDIA) expect(readMedia(rel)).toBe(`bytes of ${rel}`);
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
    // The native layout: pulse.db and manifest.json at the root, drafts/ contents beside them.
    const entry = (path: string) => path.replace(/^drafts\//, '');
    expect(Object.keys(archive).sort()).toEqual(
      ['manifest.json', ...manifest.files.map((f: { path: string }) => entry(f.path))].sort(),
    );
    for (const f of manifest.files) {
      expect(f.md5).toBe(createHash('md5').update(archive[entry(f.path)]).digest('hex'));
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
    for (const rel of FIXTURE_MEDIA) expect(readMedia(rel)).toBe(`bytes of ${rel}`);
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
      expect(readdirSync(join(env.cacheDir, 'pulse-exports'))).toEqual([]); // no archive, no db copy
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
});

/** A backup as an older Pulse wrote it: same format and layout, its own (older) database. */
function oldBackup(conn: SQLiteDatabase, files: string[]): string {
  const copy = sqlite.openDatabaseSync('old-copy.db', {}, env.cacheDir);
  sqlite.backupDatabaseSync({ sourceDatabase: conn as never, destDatabase: copy });
  copy.execSync('PRAGMA journal_mode = DELETE;');
  copy.closeSync();
  const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');
  const db = readFileSync(join(env.cacheDir, 'old-copy.db'));
  const media = files.map((p) => ({ path: p, bytes: readFileSync(join(env.docDir, p)) }));
  const manifest = {
    format: 'pulse-library-backup',
    version: 2,
    schemaVersion: schemaVersion(conn),
    createdAt: 1,
    files: [
      { path: 'pulse.db', size: db.length, md5: md5(db) },
      ...media.map((m) => ({ path: m.path, size: m.bytes.length, md5: md5(m.bytes) })),
    ],
  };
  const out = join(env.cacheDir, 'old.pulse');
  const entries: Record<string, Uint8Array> = {
    'pulse.db': db,
    'manifest.json': strToU8(JSON.stringify(manifest)),
  };
  for (const m of media) entries[m.path.replace(/^drafts\//, '')] = m.bytes;
  writeFileSync(out, zipSync(entries, { level: 0 }));
  return `file://${out}`;
}
