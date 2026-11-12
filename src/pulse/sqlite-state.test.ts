import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  emptyPulseState,
  parsePulseYaml,
  stringifyPulseYaml,
  type PulseDocument,
  type PulseState,
} from './document';
import {
  assertPulseSchemaCoverage,
  readPulseDocumentFromDatabase,
  readPulseState,
  replacePulseDocument,
  replacePulseState,
  writePulseDocumentHeader,
  type PulseSqliteDatabase,
} from './sqlite-state';

const migrationsDir = join(__dirname, '../../drizzle');
const migrationFiles = readdirSync(migrationsDir)
  .filter((file) => /^\d{4}_.*\.sql$/.test(file))
  .sort();

function adapter(db: DatabaseSync): PulseSqliteDatabase {
  return {
    getAllSync<T>(sql: string, ...params: (string | number | null)[]): T[] {
      return db.prepare(sql).all(...params) as T[];
    },
    runSync(sql, params = []) {
      return db.prepare(sql).run(...params);
    },
    execSync(sql) {
      db.exec(sql);
    },
  };
}

/** Every current field is explicit, including nullable fields and opaque legacy text. */
function completeState(): PulseState {
  return {
    drafts: [
      {
        id: 'draft-a',
        name: '日本語 🫀 / "quoted"',
        uploadServer: 'https://vault.example',
        uploadArtifactId: 'external-artifact',
        uploadStatus: 'uploaded',
        contextServer: 'https://host.example',
        contextRef: 'opaque:place/β',
        mergedSignature: 'old|signature|preserved',
        mergedDurationMs: 9876.5,
        captionY: 0.637,
        lastClipNumber: 12,
        createdAt: 1700000000123,
        lastModified: 1700000999456,
      },
      {
        id: 'draft-b',
        name: null,
        uploadServer: null,
        uploadArtifactId: null,
        uploadStatus: null,
        contextServer: null,
        contextRef: null,
        mergedSignature: null,
        mergedDurationMs: null,
        captionY: null,
        lastClipNumber: 7,
        createdAt: 123,
        lastModified: 456,
      },
    ],
    segments: [
      {
        id: 'segment-a',
        draftId: 'draft-a',
        order: 4,
        label: '12 → 特別',
        originalFilename: 'drafts/shared/原始.mp4',
        durationMs: 10001.25,
        editedFilename: 'drafts/draft-a/baked.mp4',
        editedDurationMs: 4321.75,
        editState: '{invalid historical edit settings',
        thumbnail: 'drafts/draft-a/cover.jpg',
        captionEdit: '{"file":"drafts/shared/原始.mp4","words":[]}',
      },
      {
        id: 'segment-b',
        draftId: 'draft-b',
        order: 0,
        label: null,
        originalFilename: 'drafts/shared/原始.mp4',
        durationMs: 10001.25,
        editedFilename: null,
        editedDurationMs: null,
        editState: null,
        thumbnail: null,
        captionEdit: null,
      },
    ],
    draftTranscripts: [
      {
        draftId: 'draft-a',
        signature: 'legacy merged signature',
        model: 'historical/model',
        status: 'done',
        lines: '[{"text":"元の文","t0":1,"t1":9}]',
        editedLines: '[{"text":"修正 🫀","t0":2,"t1":8,"words":[]}]',
        durationMs: 9876.5,
        createdAt: 1700000200123,
      },
      {
        draftId: 'draft-b',
        signature: '',
        model: null,
        status: 'processing',
        lines: null,
        editedLines: null,
        durationMs: null,
        createdAt: 777,
      },
    ],
    clipTranscripts: [
      {
        segmentId: 'segment-a',
        model: 'model-a',
        file: 'stale/source/no-longer-present.mp4',
        status: 'done',
        words: '[{"text":"word","t0":1.25,"t1":9.75,"start":true}]',
        createdAt: 1700000300123,
      },
      {
        segmentId: 'segment-a',
        model: 'model-b',
        file: 'drafts/draft-a/baked.mp4',
        status: 'done',
        words: '[]',
        createdAt: 1700000300456,
      },
      {
        segmentId: 'segment-b',
        model: 'model-a',
        file: 'drafts/shared/原始.mp4',
        status: 'error',
        words: null,
        createdAt: 888,
      },
    ],
    settings: [
      { key: 'appearance.theme', value: 'dark' },
      { key: 'historical.unknown/設定', value: "'); DELETE FROM drafts; --\n🫀" },
      { key: 'nullable.unknown', value: null },
    ],
    uploadDestinations: [
      {
        id: 'destination-a',
        server: 'https://vault.example',
        artifactId: 'server-artifact-a',
        ref: 'opaque:place/β',
        label: 'Team "A" — 日本語',
        app: 'Host application',
        returnUrl: 'https://host.example/place?ref=%CE%B2&next=1',
        createdAt: 1700000400123,
      },
      {
        id: 'destination-b',
        server: 'https://vault.example',
        artifactId: 'server-artifact-b',
        ref: null,
        label: null,
        app: null,
        returnUrl: null,
        createdAt: 1700000400456,
      },
    ],
  };
}

function completeDocument(): PulseDocument {
  return {
    format: 'pulse-document',
    version: 2,
    scope: 'library',
    revision: 73,
    state: completeState(),
    assets: [
      {
        path: 'drafts/shared/原始.mp4',
        archivePath: 'assets/original',
        byteLength: 99,
        sha256: 'a'.repeat(64),
      },
      {
        path: 'drafts/draft-a/baked.mp4',
        archivePath: 'assets/baked',
        byteLength: 123,
        sha256: 'b'.repeat(64),
      },
    ],
  };
}

describe('complete Pulse SQLite state projection', () => {
  let db: DatabaseSync;
  let raw: PulseSqliteDatabase;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const file of migrationFiles) {
      for (const statement of readFileSync(join(migrationsDir, file), 'utf8').split(
        '--> statement-breakpoint',
      )) {
        if (statement.trim()) db.exec(statement);
      }
    }
    raw = adapter(db);
  });

  afterEach(() => db.close());

  it('covers the real migrated six-table, 48-column application schema', () => {
    expect(migrationFiles).toHaveLength(20);
    expect(() => assertPulseSchemaCoverage(raw)).not.toThrow();
    const tables = raw.getAllSync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    expect(tables).toHaveLength(6);
    expect(
      tables.reduce(
        (count, table) => count + raw.getAllSync(`PRAGMA table_info("${table.name}")`).length,
        0,
      ),
    ).toBe(48);
    expect(readPulseState(raw)).toEqual(emptyPulseState());
  });

  it('restores and rereads all fields exactly, preserving nulls, JSON and Unicode', () => {
    const state = completeState();
    const original = JSON.stringify(state);
    replacePulseState(raw, state);
    expect(readPulseState(raw)).toEqual(state);
    expect(raw.getAllSync('PRAGMA foreign_key_check')).toEqual([]);
    expect(JSON.stringify(state)).toBe(original);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  it('reads rows in stable key/order order without changing labels or counters', () => {
    const state = completeState();
    const reversed = Object.fromEntries(
      Object.entries(state).map(([key, rows]) => [key, [...rows].reverse()]),
    ) as PulseState;
    replacePulseState(raw, reversed);
    expect(readPulseState(raw)).toEqual(state);
  });

  it('replaces previous projection rows with foreign keys enabled', () => {
    replacePulseState(raw, completeState());
    const next = completeState();
    next.drafts[0].name = 'Changed';
    next.segments[0].order = 99;
    next.settings = [{ key: 'new-only', value: 'true' }];
    next.clipTranscripts = [];
    next.uploadDestinations = [];
    replacePulseState(raw, next);
    expect(readPulseState(raw)).toEqual(next);
    replacePulseState(raw, emptyPulseState());
    expect(readPulseState(raw)).toEqual(emptyPulseState());
  });

  it('rolls back all deletions and partial inserts when a database write fails', () => {
    const previous = completeState();
    replacePulseState(raw, previous);
    let writes = 0;
    const failing: PulseSqliteDatabase = {
      ...raw,
      runSync(sql, params) {
        if (++writes === 2) throw new Error('injected disk-full write failure');
        return raw.runSync(sql, params);
      },
    };
    const next = completeState();
    next.drafts[0].name = 'Must not survive';
    expect(() => replacePulseState(failing, next)).toThrow('injected disk-full');
    expect(readPulseState(raw)).toEqual(previous);
  });

  it('does not commit or roll back an outer transaction owned by the caller', () => {
    const previous = completeState();
    replacePulseState(raw, previous);
    db.exec('BEGIN');
    const next = completeState();
    next.drafts[0].name = 'Inside outer transaction';
    replacePulseState(raw, next);
    expect(readPulseState(raw)).toEqual(next);
    db.exec('ROLLBACK');
    expect(readPulseState(raw)).toEqual(previous);
  });

  it('rejects invalid foreign references before deleting any old rows', () => {
    const previous = completeState();
    replacePulseState(raw, previous);
    const invalid = completeState();
    invalid.segments[0].draftId = 'missing';
    expect(() => replacePulseState(raw, invalid)).toThrow(/missing draft/);
    expect(readPulseState(raw)).toEqual(previous);
  });

  it('ignores only the migration journal and SQLite internal tables', () => {
    db.exec(
      'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT, created_at INTEGER)',
    );
    expect(() => assertPulseSchemaCoverage(raw)).not.toThrow();
    replacePulseState(raw, completeState());
    expect(readPulseState(raw)).toEqual(completeState());
  });

  it('rejects an unmapped table before reading or replacing state', () => {
    replacePulseState(raw, completeState());
    db.exec('CREATE TABLE future_durable_data (id TEXT, value TEXT)');
    expect(() => assertPulseSchemaCoverage(raw)).toThrow(/unmapped table future_durable_data/);
    expect(() => readPulseState(raw)).toThrow(/unmapped table/);
    expect(() => replacePulseState(raw, emptyPulseState())).toThrow(/unmapped table/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM drafts').get()).toEqual({ count: 2 });
  });

  it('rejects an unmapped column instead of silently dropping it', () => {
    db.exec('ALTER TABLE drafts ADD COLUMN future_caption_style TEXT');
    expect(() => assertPulseSchemaCoverage(raw)).toThrow(
      /unmapped column drafts.future_caption_style/,
    );
    expect(() => readPulseState(raw)).toThrow(/unmapped column/);
    expect(() => replacePulseState(raw, emptyPulseState())).toThrow(/unmapped column/);
  });

  it('also detects generated columns hidden from ordinary table_info', () => {
    db.exec('ALTER TABLE settings ADD COLUMN value_length INTEGER AS (length(value)) VIRTUAL');
    expect(() => assertPulseSchemaCoverage(raw)).toThrow(/unmapped column settings.value_length/);
  });

  it('rejects a missing column with an explicit schema error', () => {
    db.exec('ALTER TABLE drafts DROP COLUMN name');
    expect(() => assertPulseSchemaCoverage(raw)).toThrow(/missing column drafts.name/);
  });

  it('rejects a missing table with an explicit schema error', () => {
    db.exec('DROP TABLE clip_transcripts');
    expect(() => assertPulseSchemaCoverage(raw)).toThrow(/missing table clip_transcripts/);
  });

  it('round-trips complete YAML through SQLite into the identical document object', () => {
    const document = parsePulseYaml(stringifyPulseYaml(completeDocument()));
    // File array ordering is accepted even when different from the projection's query order.
    for (const rows of Object.values(document.state)) rows.reverse();
    document.assets.reverse();
    const fromFile = parsePulseYaml(stringifyPulseYaml(document));
    replacePulseDocument(raw, fromFile);
    expect(readPulseDocumentFromDatabase(raw)).toEqual(fromFile);
    expect(() => assertPulseSchemaCoverage(raw)).not.toThrow();
    expect(raw.getAllSync('PRAGMA foreign_key_check')).toEqual([]);
    expect(db.prepare('SELECT id FROM __pulse_document').all()).toEqual([{ id: 1 }]);
  });

  it('can stage a new header inside an existing SQL transaction without committing it', () => {
    const document = completeDocument();
    replacePulseDocument(raw, document);
    db.exec('BEGIN');
    writePulseDocumentHeader(raw, { ...document, revision: 74 });
    expect(readPulseDocumentFromDatabase(raw).revision).toBe(74);
    db.exec('ROLLBACK');
    expect(readPulseDocumentFromDatabase(raw)).toEqual(document);
  });

  it('rolls back state and metadata together when header insertion fails', () => {
    const previous = completeDocument();
    replacePulseDocument(raw, previous);
    const next = completeDocument();
    next.revision = 74;
    next.state.drafts[0].name = 'Must roll back';
    const failing: PulseSqliteDatabase = {
      ...raw,
      runSync(sql, params) {
        if (sql.includes('INSERT INTO __pulse_document')) throw new Error('header write failed');
        return raw.runSync(sql, params);
      },
    };
    expect(() => replacePulseDocument(failing, next)).toThrow('header write failed');
    expect(readPulseDocumentFromDatabase(raw)).toEqual(previous);
  });

  it('requires a header to reconstruct a document instead of inventing its revision/assets', () => {
    replacePulseState(raw, completeState());
    expect(() => readPulseDocumentFromDatabase(raw)).toThrow(/no document header/);
  });

  it('rejects missing or malformed projected metadata and order keys', () => {
    replacePulseDocument(raw, completeDocument());
    const header = JSON.parse(
      db.prepare('SELECT header_json FROM __pulse_document').get()!.header_json as string,
    );
    header.collectionOrder.settings = ['unknown'];
    db.prepare('UPDATE __pulse_document SET header_json = ?').run(JSON.stringify(header));
    expect(() => readPulseDocumentFromDatabase(raw)).toThrow(/collection order does not match/);
    db.exec('DELETE FROM __pulse_document');
    expect(() => readPulseDocumentFromDatabase(raw)).toThrow(/header is missing or invalid/);
  });

  it('does not exempt an arbitrary table from coverage merely because it uses the header name', () => {
    db.exec('CREATE TABLE __pulse_document (id INTEGER PRIMARY KEY, header_json TEXT)');
    expect(() => assertPulseSchemaCoverage(raw)).toThrow(
      /invalid __pulse_document projection schema/,
    );
    expect(() => writePulseDocumentHeader(raw, completeDocument())).toThrow(/projection schema/);
  });
});
