import { beforeEach, describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Runs the real drizzle SQL files against an in-memory SQLite, the same statements expo-sqlite
// applies on device (split on drizzle's statement breakpoints).
const DRIZZLE_DIR = join(__dirname, '../../drizzle');
const migrationFiles = readdirSync(DRIZZLE_DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

function applyMigrations(db: DatabaseSync, filter: (file: string) => boolean): void {
  for (const file of migrationFiles.filter(filter)) {
    for (const statement of readFileSync(join(DRIZZLE_DIR, file), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      if (statement.trim()) db.exec(statement);
    }
  }
}

describe('0014_drop_upload_unit', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    applyMigrations(db, (f) => f < '0014');
  });

  const insertDraft = (id: string, uploadUnit: string | null, uploadStatus: string | null) =>
    db
      .prepare(
        `INSERT INTO drafts (id, upload_server, upload_artifact_id, upload_unit, upload_resource_url, upload_status, captions_upload_status)
         VALUES (?, 'https://vault.example.org', ?, ?, 'https://vault.example.org/upload/x', ?, 'uploaded')`,
      )
      .run(id, `${id}-artifact`, uploadUnit, uploadStatus);
  const insertArtifact = (draftId: string, localKey: string) =>
    db
      .prepare(
        `INSERT INTO upload_artifacts (id, draft_id, local_key, artifact_id) VALUES (?, ?, ?, 'a')`,
      )
      .run(`${draftId}:${localKey}`, draftId, localKey);
  const draft = (id: string) => db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
  const artifactKeys = () =>
    db
      .prepare('SELECT id FROM upload_artifacts ORDER BY id')
      .all()
      .map((r) => r.id);

  it('unpairs a segment draft that never finished uploading, whatever its status', () => {
    insertDraft('uploading', 'segment', 'uploading');
    insertDraft('failed', 'segment', 'failed');
    insertDraft('idle', 'segment', 'idle');
    insertDraft('null-status', 'segment', null);
    insertArtifact('uploading', 'seg1:video');
    insertArtifact('uploading', 'captions');

    applyMigrations(db, (f) => f.startsWith('0014'));

    for (const id of ['uploading', 'failed', 'idle', 'null-status']) {
      expect(draft(id)).toMatchObject({
        upload_server: null,
        upload_artifact_id: null,
        upload_resource_url: null,
        upload_status: null,
        captions_upload_status: null,
      });
    }
    expect(artifactKeys()).toEqual([]);
  });

  it('leaves merged drafts and finished segment uploads paired', () => {
    insertDraft('merged', 'merged', 'uploading');
    insertDraft('segment-done', 'segment', 'uploaded');
    insertArtifact('merged', 'captions');
    insertArtifact('merged', 'manifest');

    applyMigrations(db, (f) => f.startsWith('0014'));

    expect(draft('merged')).toMatchObject({
      upload_artifact_id: 'merged-artifact',
      upload_status: 'uploading',
      upload_resource_url: 'https://vault.example.org/upload/x',
    });
    expect(draft('segment-done')).toMatchObject({
      upload_artifact_id: 'segment-done-artifact',
      upload_status: 'uploaded',
    });
    expect(artifactKeys()).toEqual(['merged:captions', 'merged:manifest']);
  });

  it('sweeps leftover per-clip `:video` rows from a finished segment upload', () => {
    insertDraft('segment-done', 'segment', 'uploaded');
    insertArtifact('segment-done', 'seg1:video');

    applyMigrations(db, (f) => f.startsWith('0014'));

    expect(artifactKeys()).toEqual([]);
  });

  it('drops upload_unit from drafts and upload_destinations', () => {
    applyMigrations(db, (f) => f.startsWith('0014'));
    const columns = (table: string) =>
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
    expect(columns('drafts')).not.toContain('upload_unit');
    expect(columns('upload_destinations')).not.toContain('upload_unit');
  });
});

describe('0015_segment_edit_state', () => {
  it('adds a nullable edit_state that existing edited clips start without', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, (f) => f < '0015');
    db.prepare(`INSERT INTO drafts (id) VALUES ('d1')`).run();
    db.prepare(
      `INSERT INTO segments (id, draft_id, sort_order, original_filename, duration_ms, edited_filename, edited_duration_ms)
       VALUES ('s1', 'd1', 0, 'o.mp4', 1000, 'e.mp4', 500)`,
    ).run();

    applyMigrations(db, (f) => f.startsWith('0015'));

    expect(db.prepare('SELECT edited_filename, edit_state FROM segments').get()).toEqual({
      edited_filename: 'e.mp4',
      edit_state: null,
    });
  });
});

describe('0016_single_shot_uploads', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    applyMigrations(db, (f) => f < '0016');
  });

  const insertDraft = (id: string, uploadStatus: string | null) =>
    db
      .prepare(
        `INSERT INTO drafts (id, upload_server, upload_artifact_id, upload_resource_url, upload_status, captions_upload_status)
         VALUES (?, 'https://vault.example.org', ?, 'https://vault.example.org/upload/x', ?, 'uploaded')`,
      )
      .run(id, `${id}-artifact`, uploadStatus);
  const draft = (id: string) =>
    db
      .prepare('SELECT upload_server, upload_artifact_id, upload_status FROM drafts WHERE id = ?')
      .get(id);

  it('unpairs failed and cancelled (idle) drafts, and ones a clip edit left paired', () => {
    insertDraft('failed', 'failed');
    insertDraft('idle', 'idle');
    insertDraft('edited', null);

    applyMigrations(db, (f) => f.startsWith('0016'));

    for (const id of ['failed', 'idle', 'edited']) {
      expect(draft(id)).toEqual({
        upload_server: null,
        upload_artifact_id: null,
        upload_status: null,
      });
    }
  });

  it('leaves uploading and uploaded drafts paired', () => {
    insertDraft('uploading', 'uploading');
    insertDraft('uploaded', 'uploaded');

    applyMigrations(db, (f) => f.startsWith('0016'));

    expect(draft('uploading')).toEqual({
      upload_server: 'https://vault.example.org',
      upload_artifact_id: 'uploading-artifact',
      upload_status: 'uploading',
    });
    expect(draft('uploaded')).toMatchObject({ upload_status: 'uploaded' });
  });

  it('removes every link a draft has used from the pool, and keeps the rest', () => {
    const insertLink = (artifactId: string) =>
      db
        .prepare(
          `INSERT INTO upload_destinations (id, server, artifact_id) VALUES (?, 'https://vault.example.org', ?)`,
        )
        .run(`link-${artifactId}`, artifactId);
    for (const status of ['failed', 'idle', 'uploading', 'uploaded']) {
      insertDraft(status, status);
      insertLink(`${status}-artifact`);
    }
    insertDraft('edited', null);
    insertLink('edited-artifact');
    insertLink('unused-artifact');

    applyMigrations(db, (f) => f.startsWith('0016'));

    expect(
      db
        .prepare('SELECT artifact_id FROM upload_destinations ORDER BY artifact_id')
        .all()
        .map((r) => r.artifact_id),
    ).toEqual(['unused-artifact']);
  });

  it('drops the resume state: upload_artifacts, upload_resource_url, captions_upload_status', () => {
    db.prepare(`INSERT INTO drafts (id) VALUES ('d1')`).run();
    db.prepare(
      `INSERT INTO upload_artifacts (id, draft_id, local_key, artifact_id) VALUES ('d1:captions', 'd1', 'captions', 'a')`,
    ).run();

    applyMigrations(db, (f) => f.startsWith('0016'));

    const columns = db
      .prepare('PRAGMA table_info(drafts)')
      .all()
      .map((c) => c.name);
    expect(columns).not.toContain('upload_resource_url');
    expect(columns).not.toContain('captions_upload_status');
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'upload_artifacts'`,
        )
        .get(),
    ).toBeUndefined();
  });
});

describe('0019_link_places', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    applyMigrations(db, (f) => f < '0019');
  });

  it('leaves every existing destination and draft as it was, with no place', () => {
    db.prepare(
      `INSERT INTO upload_destinations (id, server, artifact_id, created_at) VALUES ('a', 'https://a.test', 'art-a', 111)`,
    ).run();
    db.prepare(`INSERT INTO drafts (id, name) VALUES ('d1', 'Old')`).run();

    applyMigrations(db, (f) => f.startsWith('0019'));

    expect(db.prepare('SELECT * FROM upload_destinations').all()).toEqual([
      {
        id: 'a',
        server: 'https://a.test',
        artifact_id: 'art-a',
        ref: null,
        label: null,
        app: null,
        return_url: null,
        created_at: 111,
      },
    ]);
    expect(db.prepare('SELECT name, context_server, context_ref FROM drafts').get()).toEqual({
      name: 'Old',
      context_server: null,
      context_ref: null,
    });
  });

  it('allows one destination per (server, ref), and any number without a ref', () => {
    applyMigrations(db, (f) => f.startsWith('0019'));
    const insert = db.prepare(
      `INSERT INTO upload_destinations (id, server, artifact_id, ref) VALUES (?, ?, ?, ?)`,
    );
    insert.run('p1', 'https://a.test', 'art-1', 'r1');
    insert.run('p2', 'https://a.test', 'art-2', 'r2');
    insert.run('p3', 'https://b.test', 'art-3', 'r1');
    expect(() => insert.run('p4', 'https://a.test', 'art-4', 'r1')).toThrow(/UNIQUE/);
    // Plain links (ref NULL) never collide on the index.
    insert.run('d1', 'https://a.test', 'art-5', null);
    insert.run('d2', 'https://a.test', 'art-6', null);
  });
});

describe('0020_host_context_outbox', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON'); // as the app opens its library (durability.ts)
    applyMigrations(db, (f) => f < '0020');
  });

  const insertJob = (draftId: string, clientKey: string) =>
    db
      .prepare(
        `INSERT INTO upload_jobs (draft_id, state, client_key, draft_key, merged_signature, sent_at)
         VALUES (?, 'queued', ?, ?, 'sig', 1)`,
      )
      .run(draftId, clientKey, `install:${draftId}`);

  it('gives every older draft created_via "app" and no host context, keeping its rows', () => {
    db.prepare(
      `INSERT INTO drafts (id, name, context_server, context_ref) VALUES ('d1', 'Old', 'https://a.test', 'r1')`,
    ).run();
    db.prepare(
      `INSERT INTO segments (id, draft_id, sort_order, original_filename, duration_ms) VALUES ('s1', 'd1', 0, 'o.mp4', 1000)`,
    ).run();

    applyMigrations(db, (f) => f.startsWith('0020'));

    expect(
      db
        .prepare(
          `SELECT name, context_server, context_ref, context_key, context_label, context_json,
                  upload_type_json, created_via, host_confirmed_at, sent_at FROM drafts`,
        )
        .get(),
    ).toEqual({
      name: 'Old',
      context_server: 'https://a.test',
      context_ref: 'r1',
      context_key: null,
      context_label: null,
      context_json: null,
      upload_type_json: null,
      created_via: 'app',
      host_confirmed_at: null,
      sent_at: null,
    });
    expect(db.prepare('SELECT id FROM segments').all()).toEqual([{ id: 's1' }]);
    // A row written later without it gets the default too.
    db.prepare(`INSERT INTO drafts (id) VALUES ('d2')`).run();
    expect(db.prepare(`SELECT created_via FROM drafts WHERE id = 'd2'`).get()).toEqual({
      created_via: 'app',
    });
  });

  it('adds the outbox, receipts and local settings, empty, and the context indexes', () => {
    applyMigrations(db, (f) => f.startsWith('0020'));
    for (const table of ['upload_jobs', 'upload_receipts', 'local_settings']) {
      expect([table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get()]).toEqual([
        table,
        { n: 0 },
      ]);
    }
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`)
      .all()
      .map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'drafts_context_key_idx',
        'upload_jobs_client_key_unique',
        'upload_receipts_context_key_idx',
      ]),
    );
  });

  it('keeps one job per client key, only for a draft that exists, gone with its draft', () => {
    applyMigrations(db, (f) => f.startsWith('0020'));
    db.prepare(`INSERT INTO drafts (id) VALUES ('d1'), ('d2')`).run();
    insertJob('d1', 'install:d1:aaaa');
    expect(() => insertJob('d2', 'install:d1:aaaa')).toThrow(/UNIQUE/);
    expect(() => insertJob('missing', 'install:missing:bbbb')).toThrow(/FOREIGN KEY/);
    expect(db.prepare('SELECT attempts, created_at > 0 AS stamped FROM upload_jobs').get()).toEqual(
      { attempts: 0, stamped: 1 },
    );

    db.prepare(`DELETE FROM drafts WHERE id = 'd1'`).run();
    expect(db.prepare('SELECT count(*) AS n FROM upload_jobs').get()).toEqual({ n: 0 });
  });

  it('keeps a receipt after its draft is gone (no foreign key)', () => {
    applyMigrations(db, (f) => f.startsWith('0020'));
    db.prepare(
      `INSERT INTO upload_receipts (draft_id, name, outcome, upload_id, artifact_id, client_key,
         clip_count, duration_ms, sent_at, delivered_at, expires_at)
       VALUES ('retired', 'Fix login', 'done', 'u1', 'a1', 'install:retired:cccc', 2, 3000, 1, 2, 3)`,
    ).run();
    expect(db.prepare('SELECT draft_id, media_deleted_at FROM upload_receipts').all()).toEqual([
      { draft_id: 'retired', media_deleted_at: null },
    ]);
  });
});

describe('0021_summary_projects', () => {
  it('backfills legacy beats once from the project modification time and preserves their children', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, (f) => f < '0021');
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare("INSERT INTO drafts (id, created_at, last_modified) VALUES ('old', 100, 900)").run();
    db.prepare(
      "INSERT INTO segments (id, draft_id, sort_order, original_filename, duration_ms) VALUES ('beat', 'old', 0, 'drafts/old/segments/beat.mp4', 1000)",
    ).run();
    db.prepare(
      "INSERT INTO clip_transcripts (segment_id, model, file, status) VALUES ('beat', 'base', 'drafts/old/segments/beat.mp4', 'done')",
    ).run();
    applyMigrations(db, (f) => f.startsWith('0021'));
    expect(db.prepare('SELECT added_at FROM segments').get()).toEqual({ added_at: 900 });
    expect(db.prepare('SELECT is_summary, summary_cutoff_at FROM drafts').get()).toEqual({
      is_summary: 0,
      summary_cutoff_at: null,
    });
    db.prepare("UPDATE drafts SET last_modified = 1200 WHERE id = 'old'").run();
    expect(db.prepare('SELECT added_at FROM segments').get()).toEqual({ added_at: 900 });
    expect(db.prepare('SELECT count(*) AS n FROM clip_transcripts').get()).toEqual({ n: 1 });
    db.close();
  });
});
