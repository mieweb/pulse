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
