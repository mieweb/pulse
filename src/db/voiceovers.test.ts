import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
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

// Narration persistence uses the real SQLite migrations and files in an isolated sandbox.
jest.mock(
  'expo-sqlite',
  () =>
    jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
      '@/test-support/expo-sqlite-node',
    ).mockModule,
);
jest.mock('@/db/client', () => {
  const { readdirSync, readFileSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
  const { join } = jest.requireActual<typeof import('node:path')>('node:path');
  const { SQLiteDatabase } = jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
    '@/test-support/expo-sqlite-node',
  );
  const { drizzle } =
    jest.requireActual<typeof import('drizzle-orm/expo-sqlite')>('drizzle-orm/expo-sqlite');
  const { mkdtempSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
  const { tmpdir } = jest.requireActual<typeof import('node:os')>('node:os');
  const conn = new SQLiteDatabase(
    join(mkdtempSync(join(tmpdir(), 'pulse-voiceover-db-')), 'pulse.db'),
  );
  conn.execSync('PRAGMA foreign_keys = ON');
  const dir = join(__dirname, '../../drizzle');
  for (const file of readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()) {
    for (const statement of readFileSync(join(dir, file), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      if (statement.trim()) conn.execSync(statement);
    }
  }
  return { expoDb: conn, db: drizzle(conn as never) };
});
jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));
jest.mock('@/utils/video', () => ({}));
jest.mock('./secure-token', () => ({ deleteSavedLink: async () => {} }));
jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: () => `id${++n}` };
});

/* eslint-disable import/first -- register native stand-ins before the library loads */
import { env } from '@/test-support/expo-fs-node';
import { SQLiteDatabase } from '@/test-support/expo-sqlite-node';
import { db, expoDb } from './client';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import migrations from '../../drizzle/migrations';
import { historyCheckpoint } from './undo-history';
import { parsePersistedHistory } from './persisted-history';
import { dropHeldFiles } from './held-files';
import { holdMediaPaths } from '@/core/media-holds';
import { createDraft, deleteDraft, duplicateDraft } from './drafts';
import { referencedMediaPaths } from './media-refs';
import { buildProject, checkProject, commitCopy, planCopy } from './project';
import {
  getVoiceover,
  addVoiceoverTake,
  setAudioTrackMuted,
  undoVoiceoverTake,
} from './voiceovers';
/* eslint-enable import/first */

const conn = expoDb as unknown as SQLiteDatabase;
const ROOT = mkdtempSync(join(tmpdir(), 'pulse-voiceover-media-'));
afterAll(() => {
  conn.closeSync();
  rmSync(dirname(conn.databasePath), { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});
let devices = 0;
beforeEach(() => {
  conn.execSync('DELETE FROM drafts');
  env.docDir = join(ROOT, `device-${++devices}`);
  env.cacheDir = join(env.docDir, 'Caches');
  mkdirSync(env.cacheDir, { recursive: true });
});
const exists = (relative: string) => existsSync(join(env.docDir, relative));
const read = (relative: string) => readFileSync(join(env.docDir, relative), 'utf8');
let recordings = 0;
const cache = () => {
  const uri = join(env.cacheDir, `${++recordings}.caf`);
  writeFileSync(uri, `audio ${recordings}`);
  return uri;
};
const take = (draftId: string, startMs: number) =>
  addVoiceoverTake({
    draftId,
    cacheUri: cache(),
    startMs,
    durationMs: 1000,
    trimStartMs: 100,
    trimEndMs: 900,
  });
const videoRows = (draftId: string) =>
  conn.getAllSync('SELECT * FROM segments WHERE draft_id = ?', draftId);
async function draftWithVideo() {
  const id = await createDraft();
  const file = `drafts/${id}/segments/video.mp4`;
  mkdirSync(dirname(join(env.docDir, file)), { recursive: true });
  writeFileSync(join(env.docDir, file), 'video');
  conn.runSync(
    'INSERT INTO segments (id,draft_id,sort_order,original_filename,duration_ms) VALUES (?,?,0,?,60000)',
    `video-${id}`,
    id,
    file,
  );
  return id;
}

describe('voiceover take storage', () => {
  it('reopens five independent, trimmed sources and the saved mix without changing video', async () => {
    const draft = await draftWithVideo();
    const before = videoRows(draft);
    const saved = [];
    for (let i = 0; i < 5; i++) saved.push(await take(draft, 5000 + i * 800));
    await setAudioTrackMuted(draft, 'source', true);
    await setAudioTrackMuted(draft, 'voiceover', true);
    const state = await getVoiceover(draft);
    expect(state).toEqual({ takes: saved, sourceMuted: true, voiceoverMuted: true });
    expect(saved.map((t) => t.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(saved.every((t) => t.filename.endsWith('.caf') && exists(t.filename))).toBe(true);
    expect(videoRows(draft)).toEqual(before);
    const reopened = new SQLiteDatabase(conn.databasePath);
    try {
      expect(
        reopened.getAllSync(
          'SELECT start_ms, trim_start_ms, trim_end_ms FROM voiceover_takes WHERE draft_id = ? ORDER BY sequence',
          draft,
        ),
      ).toEqual(saved.map((t) => ({ start_ms: t.startMs, trim_start_ms: 100, trim_end_ms: 900 })));
      expect(
        reopened.getFirstSync(
          'SELECT source_audio_muted,voiceover_muted FROM drafts WHERE id = ?',
          draft,
        ),
      ).toEqual({ source_audio_muted: 1, voiceover_muted: 1 });
    } finally {
      reopened.closeSync();
    }
  });

  it('immediately undoes whole takes in addition order, including one recorded after seeking backwards', async () => {
    const draft = await draftWithVideo();
    const before = videoRows(draft);
    const saved = [];
    for (const start of [5000, 5800, 6600, 7400, 2000]) saved.push(await take(draft, start));
    for (const cursor of [8200, 7400, 6600, 5800, 5000]) {
      const removed = saved.pop()!;
      expect(await undoVoiceoverTake(draft)).toEqual({ removed, playheadMs: cursor });
      expect(exists(removed.filename)).toBe(false);
      expect((await getVoiceover(draft)).takes).toEqual(saved);
      expect(videoRows(draft)).toEqual(before);
    }
    expect(await undoVoiceoverTake(draft)).toBeNull();
    expect((await take(draft, 5000)).sequence).toBe(1);
  });

  it('retains an undone take while an archive or native operation holds its media', async () => {
    const draft = await draftWithVideo();
    const first = await take(draft, 0);
    const release = holdMediaPaths([first.filename]);
    try {
      await undoVoiceoverTake(draft);
      expect((await getVoiceover(draft)).takes).toEqual([]);
      expect(exists(first.filename)).toBe(true);
    } finally {
      release();
    }
    expect(dropHeldFiles(referencedMediaPaths(expoDb))).toBe(1);
    expect(exists(first.filename)).toBe(false);
  });

  it('preserves earlier takes on invalid timing, capture loss or failed commit', async () => {
    const draft = await draftWithVideo();
    const first = await take(draft, 0);
    const waiting = cache();
    await expect(
      addVoiceoverTake({
        draftId: draft,
        cacheUri: waiting,
        startMs: 0,
        durationMs: 100,
        trimEndMs: 200,
      }),
    ).rejects.toMatchObject({ code: 'invalid_options' });
    expect(existsSync(waiting)).toBe(true);
    await expect(
      addVoiceoverTake({
        draftId: draft,
        cacheUri: join(env.cacheDir, 'missing.caf'),
        startMs: 800,
        durationMs: 1000,
      }),
    ).rejects.toThrow();
    conn.execSync(
      "CREATE TEMP TRIGGER fail_narration BEFORE INSERT ON voiceover_takes BEGIN SELECT RAISE(ABORT,'full disk'); END",
    );
    const failedCapture = cache();
    try {
      await expect(
        addVoiceoverTake({
          draftId: draft,
          cacheUri: failedCapture,
          startMs: 800,
          durationMs: 1000,
        }),
      ).rejects.toThrow();
    } finally {
      conn.execSync('DROP TRIGGER fail_narration');
    }
    expect(existsSync(failedCapture)).toBe(true);
    expect((await getVoiceover(draft)).takes).toEqual([first]);
    expect(readdirSync(join(env.docDir, `drafts/${draft}/voiceovers`))).toEqual([
      first.filename.split('/').pop(),
    ]);
    await addVoiceoverTake({
      draftId: draft,
      cacheUri: failedCapture,
      startMs: 800,
      durationMs: 1000,
    });
    expect(existsSync(failedCapture)).toBe(false);
    expect((await getVoiceover(draft)).takes).toHaveLength(2);
  });

  it('refuses recording and Undo during upload, retaining the capture and saved takes', async () => {
    const draft = await draftWithVideo();
    const first = await take(draft, 0);
    conn.runSync("UPDATE drafts SET upload_status='uploading' WHERE id=?", draft);
    const waiting = cache();
    await expect(
      addVoiceoverTake({ draftId: draft, cacheUri: waiting, startMs: 800, durationMs: 1000 }),
    ).rejects.toThrow('uploading');
    await expect(undoVoiceoverTake(draft)).rejects.toThrow('uploading');
    await expect(setAudioTrackMuted(draft, 'source', true)).rejects.toThrow('uploading');
    expect(existsSync(waiting)).toBe(true);
    expect((await getVoiceover(draft)).takes).toEqual([first]);
  });

  it('duplicates independent narration files, trims and mute choices; deleting the source keeps the copy', async () => {
    const draft = await draftWithVideo();
    const first = await take(draft, 8000);
    await setAudioTrackMuted(draft, 'source', true);
    const copy = await duplicateDraft(draft);
    const state = await getVoiceover(copy);
    expect(state.sourceMuted).toBe(true);
    expect(state.voiceoverMuted).toBe(false);
    expect(state.takes).toEqual([
      expect.objectContaining({
        draftId: copy,
        startMs: 8000,
        trimStartMs: 100,
        trimEndMs: 900,
        sequence: 1,
      }),
    ]);
    expect(state.takes[0].id).not.toBe(first.id);
    expect(state.takes[0].filename).not.toBe(first.filename);
    expect(read(state.takes[0].filename)).toBe(read(first.filename));
    await deleteDraft(draft);
    expect((await getVoiceover(draft)).takes).toEqual([]);
    expect(exists(state.takes[0].filename)).toBe(true);
    await undoVoiceoverTake(copy);
    expect(exists(state.takes[0].filename)).toBe(false);
  });

  it('carries narration through project export and copy import with fresh ids and media paths', async () => {
    const draft = await draftWithVideo();
    const first = await take(draft, 12000);
    await setAudioTrackMuted(draft, 'voiceover', true);
    const document = checkProject(
      buildProject(expoDb, {
        draftIds: [draft],
        now: 1,
        byteLength: (relative) =>
          exists(relative) ? readFileSync(join(env.docDir, relative)).length : null,
      }),
    );
    expect(document.tables.voiceover_takes).toEqual([first]);
    expect([...referencedMediaPaths(expoDb, [draft])]).toContain(first.filename);
    let next = 0;
    const plan = planCopy(document, () => `import-${++next}`);
    const copied = plan.rows.voiceover_takes[0];
    expect(copied).toMatchObject({
      draftId: plan.draftIds[0],
      startMs: 12000,
      trimStartMs: 100,
      trimEndMs: 900,
    });
    expect(copied.id).not.toBe(first.id);
    expect(copied.filename).toContain('/voiceovers/');
    for (const [to, from] of plan.files) {
      mkdirSync(dirname(join(env.docDir, to)), { recursive: true });
      writeFileSync(join(env.docDir, to), readFileSync(join(env.docDir, from)));
    }
    commitCopy(expoDb, plan);
    expect(await getVoiceover(plan.draftIds[0])).toEqual({
      takes: [copied],
      sourceMuted: false,
      voiceoverMuted: true,
    });
    expect(read(copied.filename as string)).toBe(read(first.filename));
    expect(() =>
      checkProject({
        ...document,
        tables: { ...document.tables, voiceover_takes: [{ ...first, draftId: 'missing' }] },
      }),
    ).toThrow('damaged');
  });
});

describe('phone persistent-Undo library upgrade', () => {
  it('appends voiceover after shipped0022 without altering Undo, retained media or active video', async () => {
    const path = join(env.docDir, 'phone-library.db');
    const phone = new SQLiteDatabase(path);
    const original = { node: conn.node, path: conn.databasePath };
    conn.node = phone.node;
    conn.databasePath = path;
    const prior = migrations.journal.entries.filter((entry) => entry.idx <= 22);
    const phoneMigration = prior.at(-1)!;
    expect(phoneMigration.tag).toBe('0022_persistent_undo');
    try {
      conn.execSync('PRAGMA foreign_keys=ON');
      await migrate(db, { ...migrations, journal: { ...migrations.journal, entries: prior } });
      const columns = conn.getAllSync('PRAGMA table_info(drafts)').map((row) => row.name);
      expect(columns).toContain('undo_history');
      expect(columns).not.toContain('source_audio_muted');
      conn.runSync(
        'INSERT INTO drafts(id,name,last_clip_number,caption_y) VALUES(?,?,?,?)',
        'phone-draft',
        'Existing phone project',
        2,
        0.3,
      );
      const live = 'drafts/phone-draft/segments/active.mp4';
      const retained = 'drafts/phone-draft/segments/retained.mp4';
      const obsolete = 'drafts/phone-draft/segments/obsolete.mp4';
      for (const relative of [live, retained, obsolete]) {
        mkdirSync(dirname(join(env.docDir, relative)), { recursive: true });
        writeFileSync(join(env.docDir, relative), relative);
      }
      conn.runSync(
        'INSERT INTO segments(id,draft_id,sort_order,original_filename,duration_ms,label,added_at) VALUES(?,?,0,?,1000,?,1234)',
        'active',
        'phone-draft',
        live,
        '1',
      );
      const retainedRow = {
        id: 'retained',
        draftId: 'phone-draft',
        order: 1,
        addedAt: 1234,
        label: '2',
        originalFilename: retained,
        durationMs: 1000,
        editedFilename: null,
        editedDurationMs: null,
        editState: null,
        thumbnail: null,
        captionEdit: null,
      };
      const history = JSON.stringify({
        version: 1,
        checkpoint: historyCheckpoint(expoDb, 'phone-draft'),
        past: [
          {
            kind: 'state',
            snapshot: {
              order: ['active'],
              edits: { active: null },
              captions: { active: null },
              captionY: 0.3,
            },
          },
        ],
        future: [
          {
            kind: 'added',
            ids: ['retained'],
            taken: {
              draftId: 'phone-draft',
              order: ['active', 'retained'],
              rows: [retainedRow],
              transcripts: [],
            },
          },
        ],
      });
      expect(parsePersistedHistory(history, 'phone-draft')).not.toBeNull();
      conn.runSync('UPDATE drafts SET undo_history=? WHERE id=?', history, 'phone-draft');
      conn.runSync(
        'INSERT INTO settings(key,value) VALUES(?,?)',
        'drafts.heldForRedo',
        JSON.stringify([retained, obsolete]),
      );
      const beforeVideo = videoRows('phone-draft');
      // Reopen the on-disk phone0022 database, then run the same migrator as app launch.
      conn.node.close();
      conn.node = new SQLiteDatabase(path).node;
      conn.execSync('PRAGMA foreign_keys=ON');
      await migrate(db, migrations);
      expect(migrations.journal.entries.at(-1)).toMatchObject({
        idx: 23,
        tag: '0023_voiceover_takes',
      });
      expect(migrations.journal.entries.at(-1)!.when).toBeGreaterThan(phoneMigration.when);
      expect(
        conn.getFirstSync('SELECT max(created_at) AS "when" FROM __drizzle_migrations')?.when,
      ).toBe(migrations.journal.entries.at(-1)!.when);
      const savedHistory = () =>
        conn.getFirstSync('SELECT undo_history AS undo FROM drafts WHERE id=?', 'phone-draft')
          ?.undo;
      expect(savedHistory()).toBe(history);
      expect(videoRows('phone-draft')).toEqual(beforeVideo);
      expect(await getVoiceover('phone-draft')).toEqual({
        takes: [],
        sourceMuted: false,
        voiceoverMuted: false,
      });
      const needed = referencedMediaPaths(expoDb);
      expect(needed.has(live)).toBe(true);
      expect(needed.has(retained)).toBe(true);
      expect(dropHeldFiles(needed)).toBe(1);
      expect(exists(retained)).toBe(true);
      expect(exists(obsolete)).toBe(false);
      const first = await take('phone-draft', 400);
      const second = await take('phone-draft', 1200);
      expect(await undoVoiceoverTake('phone-draft')).toEqual({ removed: second, playheadMs: 1200 });
      await setAudioTrackMuted('phone-draft', 'voiceover', true);
      conn.node.close();
      conn.node = new SQLiteDatabase(path).node;
      conn.execSync('PRAGMA foreign_keys=ON');
      expect(await getVoiceover('phone-draft')).toEqual({
        takes: [first],
        sourceMuted: false,
        voiceoverMuted: true,
      });
      expect(savedHistory()).toBe(history);
      expect(videoRows('phone-draft')).toEqual(beforeVideo);
      expect(exists(live)).toBe(true);
      expect(exists(retained)).toBe(true);
      expect(exists(first.filename)).toBe(true);
      expect(exists(second.filename)).toBe(false);
      const doc = checkProject(
        buildProject(expoDb, {
          draftIds: ['phone-draft'],
          now: 1,
          byteLength: (relative) =>
            exists(relative) ? readFileSync(join(env.docDir, relative)).length : null,
        }),
      );
      expect(new Set(doc.media.map((file) => file.path))).toEqual(
        new Set([live, retained, first.filename]),
      );
      expect(doc.tables.drafts[0].undoHistory).toBe(history);
      expect(doc.tables.voiceover_takes).toEqual([first]);
    } finally {
      conn.node.close();
      conn.node = original.node;
      conn.databasePath = original.path;
    }
  });
});
