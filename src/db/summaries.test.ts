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

// Summary selection and atomic collection on the real migrations and real temp-folder files.
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

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { env, File } from '@/test-support/expo-fs-node';
import { renderKey } from '@/utils/segment-window';
import { expoDb, db } from './client';
import {
  addSegment,
  createDraft,
  duplicateDraft,
  renameDraft,
  segmentsForDraft,
  splitSegment,
} from './drafts';
import { buildProject, commitCopy, planCopy } from './project';
import {
  createSummary,
  latestSummaryQuery,
  selectSummaryBeats,
  summaryBeatsQuery,
  type SummaryBeat,
} from './summaries';
/* eslint-enable import/first */

const conn = expoDb as unknown as {
  getAllSync: <T>(sql: string, ...params: unknown[]) => T[];
  runSync: (sql: string, ...params: unknown[]) => unknown;
};
const ROOT = mkdtempSync(join(tmpdir(), 'pulse-summaries-'));
let runs = 0;
let clock = 10_000;
beforeEach(() => {
  conn.runSync('DELETE FROM drafts');
  clock = 10_000;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  env.docDir = join(ROOT, `run-${++runs}`);
  env.cacheDir = join(env.docDir, 'Caches');
  mkdirSync(env.docDir, { recursive: true });
});
afterEach(() => {
  jest.restoreAllMocks();
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const put = (rel: string) => {
  const path = join(env.docDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rel);
};
const projectFolders = () => readdirSync(join(env.docDir, 'drafts')).sort();
async function addBeat(draftId: string, addedAt: number) {
  const id = `${draftId}-${addedAt}`;
  const file = `drafts/${draftId}/segments/${id}.mp4`;
  clock = addedAt;
  put(file);
  await addSegment(draftId, { id, originalFilename: file, durationMs: 2000 });
  return id;
}
async function project(name: string, dates = [1000]) {
  const id = await createDraft({ name });
  for (const date of dates) await addBeat(id, date);
  return id;
}
const at = (time: number) => {
  clock = time;
};
const summaries = () =>
  conn.getAllSync<{ id: string; is_summary: number; summary_cutoff_at: number }>(
    'SELECT id, is_summary, summary_cutoff_at FROM drafts WHERE is_summary = 1',
  );

describe('selectSummaryBeats', () => {
  const beat = (segmentId: string, projectId: string, addedAt: number): SummaryBeat => ({
    segmentId,
    projectId,
    addedAt,
    projectName: projectId,
    contextServer: null,
    contextRef: null,
    order: 0,
    durationMs: 1000,
  });
  const beats = [
    beat('old', 'a', 50),
    beat('boundary', 'a', 100),
    beat('next', 'b', 150),
    beat('later', 'b', 200),
  ];
  const window = { cutoffAt: 200, lastSummaryCutoffAt: 100 };
  it('collects across projects with half-open boundaries, retaining same-ms arrivals for next time', () => {
    expect(
      selectSummaryBeats(beats, { mode: 'since-last' }, window).map((b) => b.segmentId),
    ).toEqual(['boundary', 'next']);
    expect(
      selectSummaryBeats(
        beats,
        { mode: 'since-last' },
        { cutoffAt: 201, lastSummaryCutoffAt: 200 },
      ).map((b) => b.segmentId),
    ).toEqual(['later']);
  });
  it('uses beat dates and selected projects, preserving project/timeline order', () => {
    expect(
      selectSummaryBeats(beats, { mode: 'range', startAt: 100, endAt: 150 }, window).map(
        (b) => b.segmentId,
      ),
    ).toEqual(['boundary']);
    expect(
      selectSummaryBeats(beats, { mode: 'projects', projectIds: ['b', 'b'] }, window).map(
        (b) => b.segmentId,
      ),
    ).toEqual(['next']);
  });
  it('rejects missing checkpoints and invalid ranges', () => {
    expect(
      selectSummaryBeats(beats, { mode: 'since-last' }, { ...window, lastSummaryCutoffAt: null }),
    ).toEqual([]);
    expect(selectSummaryBeats(beats, { mode: 'range', startAt: 150, endAt: 100 }, window)).toEqual(
      [],
    );
    expect(selectSummaryBeats(beats, { mode: 'range', startAt: NaN, endAt: 100 }, window)).toEqual(
      [],
    );
  });
});

describe('createSummary', () => {
  it('copies multiple projects as one editable project, preserving edits, captions and transcripts', async () => {
    const a = await project('First PR', [1000, 1500]);
    const b = await project('Second PR', [2000]);
    const editedId = `${a}-1500`;
    const file = `drafts/${a}/segments/${editedId}.mp4`;
    const edit = JSON.stringify({
      startMs: 200,
      endMs: 1800,
      speed: 2,
      rotation: 1,
      flipped: true,
      crop: null,
      muted: false,
    });
    conn.runSync(
      'UPDATE segments SET edit_state = ?, edited_duration_ms = 800, caption_edit = ? WHERE id = ?',
      edit,
      JSON.stringify({ file, words: [{ text: 'done', t0: 30, t1: 60 }] }),
      editedId,
    );
    conn.runSync(
      "INSERT INTO clip_transcripts (segment_id, model, file, status, words) VALUES (?, 'base', ?, 'done', '[]')",
      editedId,
      file,
    );
    const originals = await summaryBeatsQuery;
    at(3000);
    const result = await createSummary({
      name: 'Daily update',
      selection: { mode: 'projects', projectIds: [a, b] },
    });
    expect(result.beatCount).toBe(3);
    const copies = await segmentsForDraft(result.draftId);
    expect(copies.map((s) => s.label)).toEqual(['1', '2', '3']);
    expect(summaries()).toEqual([{ id: result.draftId, is_summary: 1, summary_cutoff_at: 3000 }]);
    const copy = copies.find((s) => s.editState === edit)!;
    expect(copy.editedDurationMs).toBe(800);
    expect(copy.captionEdit).toContain('done');
    expect(JSON.parse(copy.captionEdit!).file).toBe(copy.originalFilename);
    expect(
      conn.getAllSync<{ file: string }>(
        'SELECT file FROM clip_transcripts WHERE segment_id = ?',
        copy.id,
      ),
    ).toEqual([{ file: copy.originalFilename }]);
    expect(await summaryBeatsQuery).toEqual(originals);
    for (const clip of copies)
      expect(existsSync(join(env.docDir, clip.originalFilename))).toBe(true);
    expect(readFileSync(join(env.docDir, file), 'utf8')).toBe(file);
    // A source's deletion cannot remove the summary's independent media.
    rmSync(join(env.docDir, 'drafts', a), { recursive: true });
    expect(readFileSync(join(env.docDir, copy.originalFilename), 'utf8')).toBe(file);
  });

  it('gets new beats in old projects since the cutoff, and ignores edits/renames', async () => {
    const a = await project('Old PR');
    at(2000);
    await createSummary({ name: 'One', selection: { mode: 'projects', projectIds: [a] } });
    await renameDraft(a, 'Renamed PR');
    await addBeat(a, 2000); // Same millisecond as the last cutoff: not in the first collection.
    await addBeat(a, 2500);
    at(3000);
    const second = await createSummary({ name: 'Two', selection: { mode: 'since-last' } });
    expect(second.beatCount).toBe(2);
    expect((await latestSummaryQuery)[0]).toMatchObject({
      id: second.draftId,
      summaryCutoffAt: 3000,
    });
    at(4000);
    await expect(
      createSummary({ name: 'No new work', selection: { mode: 'since-last' } }),
    ).rejects.toThrow(/at least one beat/);
    expect(summaries()).toHaveLength(2);
  });

  it('freezes the cutoff before copies so beats added during collection are picked up next time', async () => {
    const a = await project('PR');
    const realCopy = File.prototype.copy;
    let added = false;
    jest.spyOn(File.prototype, 'copy').mockImplementation(async function (this: File, dest: File) {
      await realCopy.call(this, dest);
      if (!added) {
        added = true;
        await addBeat(a, 3000);
      }
    });
    at(2000);
    const first = await createSummary({
      name: 'One',
      selection: { mode: 'projects', projectIds: [a] },
    });
    expect(first.beatCount).toBe(1);
    expect((await latestSummaryQuery)[0].summaryCutoffAt).toBe(2000);
    at(4000);
    const second = await createSummary({ name: 'Two', selection: { mode: 'since-last' } });
    expect(second.beatCount).toBe(1);
  });

  it('excludes summaries and their duplicates without advancing the checkpoint for duplication', async () => {
    const a = await project('PR');
    at(2000);
    const first = await createSummary({
      name: 'Daily',
      selection: { mode: 'projects', projectIds: [a] },
    });
    at(3000);
    const duplicate = await duplicateDraft(first.draftId);
    expect(summaries().find((s) => s.id === duplicate)).toMatchObject({
      is_summary: 1,
      summary_cutoff_at: null,
    });
    expect((await latestSummaryQuery)[0].id).toBe(first.draftId);
    expect((await summaryBeatsQuery).map((s) => s.projectId)).toEqual([a]);
  });

  it('leaves no partial draft or files and no advanced cutoff if any selected video is missing', async () => {
    const a = await project('A');
    const b = await project('B');
    const before = projectFolders();
    rmSync(join(env.docDir, `drafts/${a}/segments/${a}-1000.mp4`));
    at(3000);
    await expect(
      createSummary({ name: 'Broken', selection: { mode: 'projects', projectIds: [a, b] } }),
    ).rejects.toThrow(/missing its video/);
    expect(summaries()).toEqual([]);
    expect(projectFolders()).toEqual(before);
  });

  it('cleans all stages if the disk fills during another project or the final transaction fails', async () => {
    const a = await project('A');
    const b = await project('B');
    const before = projectFolders();
    const realCopy = File.prototype.copy;
    let copied = 0;
    const copy = jest.spyOn(File.prototype, 'copy').mockImplementation(async function (
      this: File,
      dest: File,
    ) {
      if (++copied === 2) {
        writeFileSync(dest.path, 'partial');
        throw new Error('Disk full');
      }
      return realCopy.call(this, dest);
    });
    at(3000);
    await expect(
      createSummary({ name: 'Broken', selection: { mode: 'projects', projectIds: [a, b] } }),
    ).rejects.toThrow(/Disk full/);
    expect(projectFolders()).toEqual(before);
    expect(summaries()).toEqual([]);
    copy.mockRestore();
    jest.spyOn(db, 'transaction').mockImplementation(() => {
      throw new Error('Commit failed');
    });
    await expect(
      createSummary({ name: 'Broken', selection: { mode: 'projects', projectIds: [a, b] } }),
    ).rejects.toThrow(/Commit failed/);
    expect(projectFolders()).toEqual(before);
    expect(summaries()).toEqual([]);
  });

  it('timestamps copied plain-project beats as additions but preserves the date of split halves', async () => {
    const a = await project('A');
    at(2000);
    const copied = await duplicateDraft(a);
    expect((await segmentsForDraft(copied))[0].addedAt).toBe(2000);
    const [original] = await segmentsForDraft(a);
    at(3000);
    await splitSegment(a, {
      before: original.id,
      split: {
        rightId: 'right-half',
        sourceMs: 1000,
        offsetMs: 1000,
        sourceKey: renderKey(original),
      },
    });
    expect((await segmentsForDraft(a)).map((beat) => beat.addedAt)).toEqual([1000, 1000]);
  });

  it('carries summary identity, cutoff and beat dates through project export/import', async () => {
    const a = await project('A');
    at(3000);
    const first = await createSummary({
      name: 'Daily',
      selection: { mode: 'projects', projectIds: [a] },
    });
    const doc = buildProject(expoDb, {
      draftIds: [a, first.draftId],
      now: clock,
      byteLength: () => 10,
    });
    expect(doc.tables.drafts.find((d) => d.id === first.draftId)).toMatchObject({
      isSummary: true,
      summaryCutoffAt: 3000,
    });
    expect(doc.tables.segments.find((s) => s.draftId === a)).toMatchObject({ addedAt: 1000 });
    let ids = 0;
    const plan = planCopy(doc, () => `import${++ids}`);
    commitCopy(expoDb, plan);
    expect(summaries()).toHaveLength(2);
    expect(
      (await summaryBeatsQuery).filter((s) => plan.draftIds.includes(s.projectId)),
    ).toHaveLength(1);
  });
});
