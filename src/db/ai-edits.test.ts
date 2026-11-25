import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
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
  const conn = new SQLiteDatabase(':memory:');
  conn.execSync('PRAGMA foreign_keys = ON');
  const dir = join(__dirname, '../../drizzle');
  for (const file of readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()) {
    for (const statement of readFileSync(join(dir, file), 'utf8').split('--> statement-breakpoint'))
      if (statement.trim()) conn.execSync(statement);
  }
  return { expoDb: conn, db: drizzle(conn as never) };
});
jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));
jest.mock('@/utils/video', () => ({}));
jest.mock('./secure-token', () => ({ deleteSavedLink: async () => {} }));
jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: () => `ai${++n}` };
});

/* eslint-disable import/first -- native mocks precede the persistence imports */
import { env, File } from '@/test-support/expo-fs-node';
import { clipRender, parseEdit, renderKey } from '@/utils/segment-window';
import {
  aiEditSourceSignature,
  assertAiEditAudioSupported,
  createAiEdit,
  type AiEditInterval,
} from './ai-edits';
import { expoDb } from './client';
import { addSegment, createDraft, getDraftForExport } from './drafts';
/* eslint-enable import/first */

const conn = expoDb as unknown as {
  getAllSync: <T>(sql: string, ...params: unknown[]) => T[];
  runSync: (sql: string, ...params: unknown[]) => unknown;
  execSync: (sql: string) => void;
};
const ROOT = mkdtempSync(join(tmpdir(), 'pulse-ai-edits-'));
let runs = 0;
let addedSourceMute = false;
let addedVoiceoverTable = false;
beforeEach(() => {
  conn.runSync('DELETE FROM drafts');
  env.docDir = join(ROOT, `run-${++runs}`);
  env.cacheDir = join(env.docDir, 'Caches');
  mkdirSync(env.docDir, { recursive: true });
});
afterEach(() => {
  conn.execSync('DROP TRIGGER IF EXISTS reject_ai_clip');
  if (addedVoiceoverTable) conn.execSync('DROP TABLE voiceover_takes');
  if (addedSourceMute) conn.execSync('ALTER TABLE drafts DROP COLUMN source_audio_muted');
  addedSourceMute = false;
  addedVoiceoverTable = false;
  jest.restoreAllMocks();
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const put = (rel: string, data = 'original video') => {
  const path = join(env.docDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
};

function newerAudioSchema() {
  if (
    !conn
      .getAllSync<{ name: string }>('PRAGMA table_info(drafts)')
      .some((c) => c.name === 'source_audio_muted')
  ) {
    conn.execSync('ALTER TABLE drafts ADD COLUMN source_audio_muted INTEGER NOT NULL DEFAULT 0');
    addedSourceMute = true;
  }
  if (
    !conn.getAllSync(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'voiceover_takes'",
    ).length
  ) {
    conn.execSync(`CREATE TABLE voiceover_takes (
      id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, start_ms REAL NOT NULL, duration_ms REAL NOT NULL,
      trim_start_ms REAL NOT NULL, trim_end_ms REAL NOT NULL, sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    )`);
    addedVoiceoverTable = true;
  }
}

const addNarration = (draftId: string) =>
  conn.runSync(
    'INSERT INTO voiceover_takes (id, draft_id, filename, start_ms, duration_ms, trim_start_ms, trim_end_ms, sequence) VALUES (?, ?, ?, 0, 1000, 0, 1000, 1)',
    `${draftId}-narration`,
    draftId,
    `drafts/${draftId}/narration.m4a`,
  );

async function fixture() {
  const draftId = await createDraft({ name: 'Original' });
  const id = `${draftId}-clip`;
  const file = `drafts/${draftId}/segments/${id}.mp4`;
  put(file);
  await addSegment(draftId, { id, originalFilename: file, durationMs: 600_000 });
  const words = JSON.stringify([{ text: 'Retain the meaning.', t0: 1200, t1: 1800 }]);
  conn.runSync(
    'INSERT INTO clip_transcripts (segment_id, model, file, status, words) VALUES (?, ?, ?, ?, ?)',
    id,
    'parakeet',
    file,
    'done',
    words,
  );
  return { draftId, id, file, words };
}

async function interval(
  draftId: string,
  startMs = 12_000,
  endMs = 18_000,
): Promise<AiEditInterval> {
  const source = (await getDraftForExport(draftId))!.segments[0];
  return {
    segmentId: source.id,
    file: clipRender(source).file,
    sourceKey: renderKey(source),
    startMs,
    endMs,
  };
}

describe('atomic independent AI excerpt projects', () => {
  it('accepts legacy audio schemas and refuses newer muted-source or separate-narration projects', async () => {
    const { draftId } = await fixture();
    expect(() => assertAiEditAudioSupported(draftId)).not.toThrow();
    newerAudioSchema();
    expect(() => assertAiEditAudioSupported(draftId)).not.toThrow();
    conn.runSync('UPDATE drafts SET source_audio_muted = 1 WHERE id = ?', draftId);
    expect(() => assertAiEditAudioSupported(draftId)).toThrow('source audio unmuted');
    conn.runSync('UPDATE drafts SET source_audio_muted = 0 WHERE id = ?', draftId);
    addNarration(draftId);
    expect(() => assertAiEditAudioSupported(draftId)).toThrow('without voiceover');
    const copy = jest.spyOn(File.prototype, 'copy');
    await expect(
      createAiEdit({
        sourceDraftId: draftId,
        name: 'AI cut',
        intervals: [await interval(draftId)],
      }),
    ).rejects.toThrow('without voiceover');
    expect(copy).not.toHaveBeenCalled();
    expect(conn.getAllSync('SELECT id FROM drafts')).toHaveLength(1);
  });

  it('checks narration again atomically when a take arrives while staging media', async () => {
    const { draftId } = await fixture();
    newerAudioSchema();
    const part = await interval(draftId);
    const actualCopy = File.prototype.copy;
    jest.spyOn(File.prototype, 'copy').mockImplementation(async function (this: File, dest: File) {
      await actualCopy.call(this, dest);
      addNarration(draftId);
    });
    await expect(
      createAiEdit({ sourceDraftId: draftId, name: 'AI cut', intervals: [part] }),
    ).rejects.toThrow('without voiceover');
    expect(conn.getAllSync('SELECT id FROM drafts')).toHaveLength(1);
    expect(readdirSync(join(env.docDir, 'drafts'))).toEqual([draftId]);
  });

  it('preserves source media/rows and carries source-time captions, transforms and speed into excerpts', async () => {
    const { draftId, id, file, words } = await fixture();
    conn.runSync(
      'UPDATE segments SET edit_state = ?, edited_duration_ms = ?, caption_edit = ? WHERE id = ?',
      JSON.stringify({
        v: 1,
        startMs: 10_000,
        endMs: 90_000,
        speed: 2,
        rotation: 1,
        flipped: true,
        crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
        muted: false,
      }),
      40_000,
      JSON.stringify({ file, words: JSON.parse(words) }),
      id,
    );
    const before = await getDraftForExport(draftId);
    const first = await interval(draftId);
    const second = { ...first, startMs: 30_000, endMs: 40_000 };
    const result = await createAiEdit({
      sourceDraftId: draftId,
      name: 'AI cut',
      intervals: [first, second],
    });
    expect(result).toMatchObject({ clipCount: 2, durationMs: 8000 });
    const output = (await getDraftForExport(result.draftId))!;
    expect(await getDraftForExport(draftId)).toEqual(before);
    expect(readFileSync(join(env.docDir, file), 'utf8')).toBe('original video');
    expect(output.segments[0].originalFilename).not.toBe(file);
    expect(output.segments[0].originalFilename).toBe(output.segments[1].originalFilename);
    expect(readFileSync(join(env.docDir, output.segments[0].originalFilename), 'utf8')).toBe(
      'original video',
    );
    expect(parseEdit(output.segments[0].editState)).toMatchObject({
      startMs: 12_000,
      endMs: 18_000,
      speed: 2,
      rotation: 1,
      flipped: true,
      crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      baseWindow: { startMs: 12_000, endMs: 18_000 },
    });
    const captions = JSON.parse(output.segments[0].captionEdit!);
    expect(captions.file).toBe(output.segments[0].originalFilename);
    expect(captions.words).toEqual(JSON.parse(words));
    const transcripts = conn.getAllSync<{ segment_id: string; file: string; words: string }>(
      'SELECT segment_id, file, words FROM clip_transcripts WHERE segment_id IN (?, ?)',
      ...output.segments.map((segment) => segment.id),
    );
    expect(transcripts).toHaveLength(2);
    expect(
      transcripts.every((t) => t.file === output.segments[0].originalFilename && t.words === words),
    ).toBe(true);
    expect(output.draft.uploadServer).toBeNull();
    expect(output.draft.summaryCutoffAt).toBeNull();
    // A source project deletion cannot take the separately copied excerpt media with it.
    conn.runSync('DELETE FROM drafts WHERE id = ?', draftId);
    rmSync(join(env.docDir, 'drafts', draftId), { recursive: true });
    expect(existsSync(join(env.docDir, output.segments[0].originalFilename))).toBe(true);
  });

  it('uses a legacy baked file as the new source without applying the old edit twice', async () => {
    const { draftId, id } = await fixture();
    const baked = `drafts/${draftId}/segments/${id}.edited.1.mp4`;
    put(baked, 'legacy baked video');
    conn.runSync(
      'UPDATE segments SET edited_filename = ?, edited_duration_ms = ? WHERE id = ?',
      baked,
      60_000,
      id,
    );
    conn.runSync('UPDATE clip_transcripts SET file = ? WHERE segment_id = ?', baked, id);
    const result = await createAiEdit({
      sourceDraftId: draftId,
      name: 'Legacy cut',
      intervals: [await interval(draftId)],
    });
    const output = (await getDraftForExport(result.draftId))!;
    const clip = output.segments[0];
    expect(clip.durationMs).toBe(60_000);
    expect(clip.editedFilename).toBeNull();
    expect(clipRender(clip)).toMatchObject({ inMs: 12_000, outMs: 18_000, speed: 1, rotation: 0 });
    expect(readFileSync(join(env.docDir, clip.originalFilename), 'utf8')).toBe(
      'legacy baked video',
    );
    expect(readdirSync(join(env.docDir, 'drafts', result.draftId, 'segments'))).toHaveLength(1);
    expect(conn.getAllSync('SELECT segment_id FROM clip_transcripts')).toHaveLength(2);
    expect(existsSync(join(env.docDir, baked))).toBe(true);
  });

  it('rejects stale source keys, overlapping or reversed intervals and over-budget cuts before any copy', async () => {
    const { draftId } = await fixture();
    const part = await interval(draftId);
    const copy = jest.spyOn(File.prototype, 'copy');
    for (const intervals of [
      [{ ...part, sourceKey: 'stale' }],
      [part, { ...part, startMs: 17_000, endMs: 20_000 }],
      [part, { ...part, startMs: 1000, endMs: 2000 }],
      [{ ...part, startMs: 0, endMs: 116_000 }],
      [{ ...part, startMs: Number.NaN }],
    ])
      await expect(createAiEdit({ sourceDraftId: draftId, name: '', intervals })).rejects.toThrow();
    expect(copy).not.toHaveBeenCalled();
    expect(conn.getAllSync('SELECT id FROM drafts')).toHaveLength(1);
  });

  it('rejects a changed analysis context even when the selected source excerpt is unchanged', async () => {
    const { draftId } = await fixture();
    const part = await interval(draftId);
    const otherFile = `drafts/${draftId}/segments/other.mp4`;
    put(otherFile);
    await addSegment(draftId, { id: 'other', originalFilename: otherFile, durationMs: 10_000 });
    const source = (await getDraftForExport(draftId))!;
    const expectedSourceSignature = aiEditSourceSignature(source.segments);
    // This unselected clip supplied context to the model; silently losing it can change meaning.
    conn.runSync('DELETE FROM segments WHERE id = ?', 'other');
    const copy = jest.spyOn(File.prototype, 'copy');
    await expect(
      createAiEdit({
        sourceDraftId: draftId,
        name: 'AI cut',
        intervals: [part],
        expectedSourceSignature,
      }),
    ).rejects.toThrow('during analysis');
    expect(copy).not.toHaveBeenCalled();
    expect(conn.getAllSync('SELECT id FROM drafts')).toHaveLength(1);
  });

  it('rolls back a failed excerpt insert and removes its staged copies', async () => {
    const { draftId, file } = await fixture();
    const part = await interval(draftId);
    const before = await getDraftForExport(draftId);
    conn.execSync(
      "CREATE TRIGGER reject_ai_clip BEFORE INSERT ON segments BEGIN SELECT RAISE(ABORT, 'disk write failed'); END",
    );
    await expect(
      createAiEdit({ sourceDraftId: draftId, name: 'AI cut', intervals: [part] }),
    ).rejects.toThrow();
    expect(await getDraftForExport(draftId)).toEqual(before);
    expect(conn.getAllSync('SELECT id FROM drafts')).toHaveLength(1);
    expect(conn.getAllSync('SELECT segment_id FROM clip_transcripts')).toHaveLength(1);
    expect(readdirSync(join(env.docDir, 'drafts'))).toEqual([draftId]);
    expect(existsSync(join(env.docDir, file))).toBe(true);
  });

  it('rejects reversed source clips and missing media without publishing a partial project', async () => {
    const { draftId, file } = await fixture();
    const first = await interval(draftId);
    const otherFile = `drafts/${draftId}/segments/other.mp4`;
    put(otherFile);
    await addSegment(draftId, { id: 'other', originalFilename: otherFile, durationMs: 10_000 });
    const secondSource = (await getDraftForExport(draftId))!.segments[1];
    const second = {
      segmentId: secondSource.id,
      file: otherFile,
      sourceKey: renderKey(secondSource),
      startMs: 0,
      endMs: 2000,
    };
    await expect(
      createAiEdit({ sourceDraftId: draftId, name: 'AI cut', intervals: [second, first] }),
    ).rejects.toThrow('timing changed');
    rmSync(join(env.docDir, otherFile));
    await expect(
      createAiEdit({ sourceDraftId: draftId, name: 'AI cut', intervals: [first, second] }),
    ).rejects.toThrow('missing');
    expect(conn.getAllSync('SELECT id FROM drafts')).toHaveLength(1);
    expect(readdirSync(join(env.docDir, 'drafts'))).toEqual([draftId]);
    expect(existsSync(join(env.docDir, file))).toBe(true);
  });

  it('cleans partial copies when the source changes during staging', async () => {
    const { draftId, id, file } = await fixture();
    const part = await interval(draftId);
    const actualCopy = File.prototype.copy;
    jest.spyOn(File.prototype, 'copy').mockImplementation(async function (this: File, dest: File) {
      await actualCopy.call(this, dest);
      conn.runSync('UPDATE segments SET duration_ms = duration_ms + 1 WHERE id = ?', id);
    });
    await expect(
      createAiEdit({ sourceDraftId: draftId, name: 'AI cut', intervals: [part] }),
    ).rejects.toThrow('changed');
    expect(conn.getAllSync('SELECT id FROM drafts')).toHaveLength(1);
    expect(readdirSync(join(env.docDir, 'drafts'))).toEqual([draftId]);
    expect(existsSync(join(env.docDir, file))).toBe(true);
  });

  it('preserves original media when canceled during a file copy', async () => {
    const { draftId, file } = await fixture();
    const part = await interval(draftId);
    const abort = new AbortController();
    const actualCopy = File.prototype.copy;
    jest.spyOn(File.prototype, 'copy').mockImplementation(async function (this: File, dest: File) {
      await actualCopy.call(this, dest);
      abort.abort();
    });
    await expect(
      createAiEdit({
        sourceDraftId: draftId,
        name: 'AI cut',
        intervals: [part],
        signal: abort.signal,
      }),
    ).rejects.toThrow('cancelled');
    expect(conn.getAllSync('SELECT id FROM drafts')).toHaveLength(1);
    expect(readdirSync(join(env.docDir, 'drafts'))).toEqual([draftId]);
    expect(existsSync(join(env.docDir, file))).toBe(true);
  });
});
