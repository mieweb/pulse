import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The send files on a Node file system (expo-fs-node) and the real migrations on node:sqlite, with
// the real caption composition (getDraftCaptions → compose → linesToVtt). Only the cover frame,
// which needs the native decoder, is stubbed.
jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));
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
  const dir = join(__dirname, '../../../../drizzle');
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
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: () => `rel-${++n}` };
});
jest.mock('@/utils/video', () => ({
  generateCoverFile: jest.fn(async () => false),
}));

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { expoDb } from '@/db/client';
import { setCaptionsOff } from '@/db/settings';
import { env } from '@/test-support/expo-fs-node';
import { generateCoverFile } from '@/utils/video';
import { sendDirRelPath, writeSendFiles } from './send-files';
/* eslint-enable import/first */

const conn = expoDb as unknown as {
  execSync: (sql: string) => void;
  runSync: (sql: string, ...params: unknown[]) => void;
};

const ROOT = mkdtempSync(join(tmpdir(), 'pulse-send-files-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
let device = 0;

const docPath = (rel: string) => join(env.docDir, rel);
function writeDoc(rel: string, contents: string) {
  mkdirSync(dirname(docPath(rel)), { recursive: true });
  writeFileSync(docPath(rel), contents);
}

/** An edit as settings: the window `[startMs, endMs)` of the clip, at normal speed. */
const trim = (startMs: number, endMs: number) =>
  JSON.stringify({ v: 1, startMs, endMs, rotation: 0, flipped: false, crop: null, speed: 1 });

/**
 * Draft d1: three 4 s clips, each saying one word ("one", "two", "three") from 1.0 s to 1.5 s into
 * it, captions edited by hand so no model is needed.
 */
function addDraft() {
  conn.runSync('INSERT INTO drafts (id) VALUES (?)', 'd1');
  ['one', 'two', 'three'].forEach((word, i) => {
    const file = `drafts/d1/segments/s${i + 1}.mp4`;
    conn.runSync(
      `INSERT INTO segments (id, draft_id, sort_order, original_filename, duration_ms, caption_edit,
         thumbnail)
       VALUES (?, 'd1', ?, ?, 4000, ?, ?)`,
      `s${i + 1}`,
      i,
      file,
      JSON.stringify({ file, words: [{ text: word, t0: 100, t1: 150 }] }),
      i === 0 ? 'drafts/d1/segments/s1.thumb.jpg' : null,
    );
  });
  writeDoc('drafts/d1/export.mp4', 'v'.repeat(1234));
}

/** The cues of a WebVTT document: `[start, text]`. */

/** Cue text without its markup (`<v Name>`, `<c>`): drops every character from `<` to `>`. */
function stripTags(acc: { inTag: boolean; out: string }, ch: string) {
  if (ch === '<') return { inTag: true, out: acc.out };
  if (ch === '>') return { inTag: false, out: acc.out };
  return acc.inTag ? acc : { inTag: false, out: acc.out + ch };
}
function cues(vtt: string): [string, string][] {
  const blocks = vtt.split('\n\n').filter((b) => b.includes('-->'));
  return blocks.map((b) => {
    const [timing, ...text] = b.split('\n');
    return [
      timing.split(' --> ')[0],
      text.join(' ').split('').reduce(stripTags, { inTag: false, out: '' }).out.trim(),
    ];
  });
}

const vttOf = () => readFileSync(docPath(`${sendDirRelPath('d1')}/captions.vtt`), 'utf8');

beforeEach(() => {
  const base = join(ROOT, `device-${++device}`);
  env.docDir = join(base, 'Documents');
  env.cacheDir = join(base, 'Caches');
  env.dbDir = join(base, 'Documents', 'SQLite');
  mkdirSync(env.docDir, { recursive: true });
  conn.execSync('DELETE FROM drafts');
  jest.mocked(generateCoverFile).mockReset();
  jest.mocked(generateCoverFile).mockResolvedValue(false);
});

describe('writeSendFiles', () => {
  it('writes the captions, beat manifest and cover into send/, then lists the video last', async () => {
    addDraft();
    jest.mocked(generateCoverFile).mockImplementation(async (_video, out) => {
      writeFileSync(out.replace(/^file:\/\//, ''), 'jpeg!');
      return true;
    });
    const { parts, bytesTotal } = await writeSendFiles('d1', 12_000);
    expect(parts.map((p) => [p.role, p.file, p.artifactId])).toEqual([
      ['captions', 'drafts/d1/send/captions.vtt', 'rel-1'],
      ['manifest', 'drafts/d1/send/beats.pulse', 'rel-2'],
      ['thumbnail', 'drafts/d1/send/thumbnail.jpg', 'rel-3'],
      ['video', 'drafts/d1/export.mp4', null],
    ]);
    expect(bytesTotal).toBe(1234);
    expect(parts.every((p) => p.tusUrl === null && !p.done)).toBe(true);
    for (const p of parts) {
      expect(existsSync(docPath(p.file))).toBe(true);
      expect(p.bytes).toBe(readFileSync(docPath(p.file)).length);
    }
    const manifest = JSON.parse(readFileSync(docPath('drafts/d1/send/beats.pulse'), 'utf8'));
    expect(manifest).toMatchObject({ type: 'beat-manifest', durationMs: 12_000 });
    expect(manifest.beats.map((b: { segmentId: string }) => b.segmentId)).toEqual([
      's1',
      's2',
      's3',
    ]);
    expect(cues(vttOf())).toEqual([
      ['00:00:01.000', 'one'],
      ['00:00:05.000', 'two'],
      ['00:00:09.000', 'three'],
    ]);
  });

  it('captions follow the merged timeline: clip 2 trimmed by 1.5 s moves every later cue 1.5 s', async () => {
    addDraft();
    await writeSendFiles('d1', 12_000);
    const before = cues(vttOf());
    conn.runSync(
      `UPDATE segments SET edit_state = ?, edited_duration_ms = 2500 WHERE id = 's2'`,
      trim(0, 2500),
    );
    await writeSendFiles('d1', 10_500);
    const after = cues(vttOf());
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
    expect(after[2]).toEqual(['00:00:07.500', 'three']);
  });

  it('captions follow a reorder, and a trim at a clip’s start', async () => {
    addDraft();
    // Order: three, one, two; "one" trimmed 0.5 s at its start (its word 0.5 s earlier).
    conn.execSync(`UPDATE segments SET sort_order = sort_order + 10`);
    conn.execSync(`UPDATE segments SET sort_order = 0 WHERE id = 's3'`);
    conn.execSync(`UPDATE segments SET sort_order = 1 WHERE id = 's1'`);
    conn.execSync(`UPDATE segments SET sort_order = 2 WHERE id = 's2'`);
    conn.runSync(
      `UPDATE segments SET edit_state = ?, edited_duration_ms = 3500 WHERE id = 's1'`,
      trim(500, 4000),
    );
    await writeSendFiles('d1', 11_500);
    expect(cues(vttOf())).toEqual([
      ['00:00:01.000', 'three'],
      ['00:00:04.500', 'one'],
      ['00:00:08.500', 'two'],
    ]);
  });

  it('falls back to the first clip’s cover, and sends no captions part without captions', async () => {
    addDraft();
    await writeSendFiles('d1', 12_000);
    writeDoc('drafts/d1/segments/s1.thumb.jpg', 'small');
    conn.execSync(`UPDATE segments SET caption_edit = NULL`);
    const { parts } = await writeSendFiles('d1', 12_000);
    expect(parts.map((p) => p.role)).toEqual(['manifest', 'thumbnail', 'video']);
    expect(readFileSync(docPath('drafts/d1/send/thumbnail.jpg'), 'utf8')).toBe('small');
    // The earlier Send's captions are gone with it.
    expect(existsSync(docPath('drafts/d1/send/captions.vtt'))).toBe(false);
  });

  it('sends no captions part when the person turned the video’s captions off', async () => {
    addDraft();
    await setCaptionsOff('d1', true);
    try {
      const { parts } = await writeSendFiles('d1', 12_000);
      expect(parts.map((p) => p.role)).toEqual(['manifest', 'video']);
    } finally {
      await setCaptionsOff('d1', false);
    }
    const { parts } = await writeSendFiles('d1', 12_000);
    expect(parts.map((p) => p.role)).toEqual(['captions', 'manifest', 'video']);
  });

  it('sends no cover when there is none, and refuses without the export', async () => {
    addDraft();
    const { parts } = await writeSendFiles('d1', 12_000);
    expect(parts.map((p) => p.role)).toEqual(['captions', 'manifest', 'video']);
    rmSync(docPath('drafts/d1/export.mp4'));
    await expect(writeSendFiles('d1', 12_000)).rejects.toThrow('no export');
  });
});
