import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A batch of images into a draft (#308), on the real migrations (node:sqlite behind the drizzle
// expo driver) and real files (expo-file-system over node:fs), with pulse-editor's `imageClip`
// standing in: it writes its "clip" into the caches folder as the native one does.
jest.mock(
  'expo-sqlite',
  () =>
    jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
      '@/test-support/expo-sqlite-node',
    ).mockModule,
);
jest.mock('@/db/client', () => {
  const { readdirSync, readFileSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
  const { join: joinPath } = jest.requireActual<typeof import('node:path')>('node:path');
  const { SQLiteDatabase } = jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
    '@/test-support/expo-sqlite-node',
  );
  const { drizzle } =
    jest.requireActual<typeof import('drizzle-orm/expo-sqlite')>('drizzle-orm/expo-sqlite');
  const conn = new SQLiteDatabase(':memory:');
  conn.execSync('PRAGMA foreign_keys = ON');
  const dir = joinPath(__dirname, '../../../drizzle');
  for (const file of readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()) {
    for (const statement of readFileSync(joinPath(dir, file), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      if (statement.trim()) conn.execSync(statement);
    }
  }
  return { expoDb: conn, db: drizzle(conn as never) };
});
jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
type ImageClip = (
  uri: string,
  options: Record<string, unknown>,
  controls: { signal?: AbortSignal; onProgress?: (f: number) => void },
) => Promise<{ uri: string; durationMs: number; encoded: boolean; bitrate: number }>;
const mockImageClip = jest.fn<ImageClip>();
jest.mock(
  '@mieweb/pulse-editor',
  () => ({ imageClip: (...args: Parameters<ImageClip>) => mockImageClip(...args) }),
  { virtual: true },
);
jest.mock('@/utils/video', () => ({
  getDurationMs: async () => 3000,
  generateThumbnailFile: async () => false,
  coverFailed: () => {},
  markCoverInFlight: () => {},
}));
jest.mock('@/db/secure-token', () => ({ deleteSavedLink: async () => {} }));
jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: () => `draft${++n}` };
});

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { type ClipAnchor, onClipsAdded } from '@/core/clip-anchor';
import { expoDb } from '@/db/client';
import { addSegment, createDraft } from '@/db/drafts';
import { env } from '@/test-support/expo-fs-node';
import { imageBatchNotice } from '@/utils/import-copy';
import { addImageClips } from './add-image-clips';
import { cursorAfterAdd } from './insert-point';
/* eslint-enable import/first */

const ROOT = mkdtempSync(join(tmpdir(), 'pulse-image-clips-'));
beforeAll(() => {
  Object.assign(env, { docDir: join(ROOT, 'Documents'), cacheDir: join(ROOT, 'Caches') });
  for (const dir of [env.docDir, env.cacheDir]) mkdirSync(dir, { recursive: true });
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** The clips each `imageClip` call wrote into the caches folder, by call. */
let outputs: string[] = [];
const UNREADABLE = "This image can't be read on this device.";
/** imageClip as the native one behaves: a file in the caches folder, or a rejection. */
function makeClip(uri: string): ReturnType<ImageClip> {
  if (uri.includes('unreadable')) return Promise.reject(new Error(UNREADABLE));
  const out = join(env.cacheDir, `image-${outputs.length}.mp4`);
  writeFileSync(out, `clip of ${uri}`);
  outputs.push(out);
  return Promise.resolve({ uri: `file://${out}`, durationMs: 3000, encoded: true, bitrate: 1 });
}
beforeEach(() => {
  outputs = [];
  mockImageClip.mockReset();
  mockImageClip.mockImplementation((uri) => makeClip(uri));
});

const conn = expoDb as unknown as {
  getAllSync: <T>(sql: string, ...params: unknown[]) => T[];
  runSync: (sql: string, ...params: unknown[]) => unknown;
};
const ids = (draftId: string) =>
  conn
    .getAllSync<{ id: string }>(
      'SELECT id FROM segments WHERE draft_id = ? ORDER BY sort_order',
      draftId,
    )
    .map((r) => r.id);
/** A draft with clips a, b, c. */
async function abc(): Promise<string> {
  const draftId = await createDraft();
  for (const id of ['a', 'b', 'c']) {
    await addSegment(draftId, {
      id: `${draftId}${id}`,
      originalFilename: `drafts/${draftId}/segments/${id}.mp4`,
      durationMs: 1000,
    });
  }
  return draftId;
}
const s = (draftId: string, id: string) => `${draftId}${id}`;
const images = (...names: string[]) => names.map((n) => `file:///picked/${n}.heic`);
const signal = () => new AbortController().signal;

describe('addImageClips', () => {
  it('makes each image in the recorder’s format and lands them in order at the anchor', async () => {
    const d = await abc();
    const result = await addImageClips(images('one', 'two', 'three'), d, {
      signal: signal(),
      anchor: () => ({ before: s(d, 'b') }),
    });
    expect(result.cancelled).toBe(false);
    expect(result.skipped).toEqual([]);
    expect(ids(d)).toEqual([s(d, 'a'), ...result.added, s(d, 'b'), s(d, 'c')]);
    expect(mockImageClip.mock.calls.map(([uri]) => uri)).toEqual(images('one', 'two', 'three'));
    // The recorder's format before the first recording (iOS): the portrait canvas coded sideways
    // under a 90° tag, 30 fps, 5 Mbps, mono 48 kHz; 3 s on black.
    expect(mockImageClip.mock.calls[0][1]).toEqual({
      width: 1080,
      height: 1920,
      rotation: 90,
      fps: 30,
      bitrate: 5_000_000,
      audio: { sampleRate: 48000, channels: 1 },
      durationMs: 3000,
      background: '#000000',
    });
    // Each clip is in the draft's folder, and imageClip's output in the caches folder is gone.
    for (const id of result.added) {
      expect(existsSync(join(env.docDir, `drafts/${d}/segments/${id}.mp4`))).toBe(true);
    }
    expect(outputs.filter(existsSync)).toEqual([]);
  });

  it('keeps the picked order after a clip (each one goes after the one before)', async () => {
    const d = await abc();
    const result = await addImageClips(images('one', 'two', 'three'), d, {
      signal: signal(),
      anchor: () => ({ after: s(d, 'a') }),
    });
    expect(ids(d)).toEqual([s(d, 'a'), ...result.added, s(d, 'b'), s(d, 'c')]);
  });

  it('keeps its place when its latest clip is deleted mid-batch', async () => {
    const d = await abc();
    const added: string[] = [];
    mockImageClip.mockImplementation(async (uri) => {
      // The first image's clip is deleted (the editor's trash) while the second is being made.
      if (uri.includes('two')) conn.runSync('DELETE FROM segments WHERE id = ?', added[0]);
      return makeClip(uri);
    });
    const result = await addImageClips(images('one', 'two', 'three'), d, {
      signal: signal(),
      anchor: () => ({ after: s(d, 'a') }),
      onAdded: (id) => added.push(id),
    });
    // Two and three still between a and b, not at the end.
    expect(ids(d)).toEqual([s(d, 'a'), ...result.added.slice(1), s(d, 'b'), s(d, 'c')]);
  });

  it('tells each clip’s id before its row is written, then once it is', async () => {
    const d = await abc();
    const events: string[] = [];
    const stop = onClipsAdded((added) => events.push(`inserted ${added.segmentIds.join()}`));
    try {
      await addImageClips(images('one'), d, {
        signal: signal(),
        onWriting: (id) => events.push(`writing ${id}`),
        onAdded: (id) => events.push(`added ${id}`),
      });
    } finally {
      stop();
    }
    const id = events[0].slice('writing '.length);
    expect(events).toEqual([`writing ${id}`, `inserted ${id}`, `added ${id}`]);
  });

  it('reports progress in whole percents of the batch', async () => {
    const d = await abc();
    mockImageClip.mockImplementation(async (uri, _options, { onProgress }) => {
      for (let i = 1; i <= 1000; i++) onProgress?.(i / 1000);
      return makeClip(uri);
    });
    const steps: { index: number; fraction: number }[] = [];
    await addImageClips(images('one', 'two'), d, {
      signal: signal(),
      onProgress: ({ index, fraction }) => steps.push({ index, fraction }),
    });
    // Each image's start, each whole percent of the batch (50 per image), and each image's end.
    expect(steps.length).toBeLessThanOrEqual(2 * 52);
    expect(steps.filter((p) => p.fraction === 0).map((p) => p.index)).toEqual([0, 1]);
    expect(steps.filter((p) => p.fraction === 1).map((p) => p.index)).toEqual([0, 1]);
  });

  it('moves the recorder’s cursor past the batch, one insert per image', async () => {
    const d = await abc();
    let cursor: ClipAnchor = { after: s(d, 'a') };
    let inserts = 0;
    const stop = onClipsAdded((added) => {
      if (added.draftId !== d) return;
      inserts++;
      cursor = cursorAfterAdd(cursor, added);
    });
    try {
      await addImageClips(images('one', 'two'), d, { signal: signal(), anchor: () => cursor });
    } finally {
      stop();
    }
    expect(inserts).toBe(2);
    expect(cursor).toEqual({ before: s(d, 'b') });
  });

  it('skips an image it can’t read and adds the rest', async () => {
    const d = await abc();
    const added: string[] = [];
    const result = await addImageClips(images('one', 'unreadable', 'three'), d, {
      signal: signal(),
      onAdded: (id) => added.push(id),
    });
    // The reason as the debug log keeps it (describeError: one line, no closing period).
    expect(result.skipped).toEqual([{ index: 1, why: UNREADABLE.replace(/\.$/, '') }]);
    expect(result.added).toEqual(added);
    expect(ids(d)).toEqual([s(d, 'a'), s(d, 'b'), s(d, 'c'), ...added]);
    expect(added).toHaveLength(2);
    expect(imageBatchNotice({ total: 3, skipped: result.skipped })).toEqual({
      kind: 'warning',
      title: '1 of 3 images wasn’t added',
      message: 'This image can’t be read on this device.',
    });
  });

  it('makes no draft when no image can be read', async () => {
    const make = jest.fn(async () => createDraft());
    const result = await addImageClips(images('unreadable-1', 'unreadable-2'), make, {
      signal: signal(),
    });
    expect(make).not.toHaveBeenCalled();
    expect(result).toMatchObject({ draftId: null, added: [], cancelled: false });
    expect(imageBatchNotice({ total: 2, skipped: result.skipped })).toMatchObject({
      kind: 'error',
      title: 'Couldn’t add the images',
    });
  });

  it('makes the draft once, with the first clip', async () => {
    const make = jest.fn(async () => createDraft());
    const result = await addImageClips(images('unreadable', 'two', 'three'), make, {
      signal: signal(),
    });
    expect(make).toHaveBeenCalledTimes(1);
    expect(ids(result.draftId!)).toEqual(result.added);
    expect(result.added).toHaveLength(2);
  });

  it('stops on a cancel: the clips added stay, the one being made is dropped', async () => {
    const d = await abc();
    const abort = new AbortController();
    mockImageClip.mockImplementation(async (uri, _options, { signal: jobSignal }) => {
      if (!uri.includes('two')) return makeClip(uri);
      // Pulse leaves while the second is being made: the native job stops and rejects.
      const made = await makeClip(uri);
      abort.abort();
      expect(jobSignal?.aborted).toBe(true);
      return made; // finished just as the abort landed
    });
    const steps: number[] = [];
    const result = await addImageClips(images('one', 'two', 'three'), d, {
      signal: abort.signal,
      onProgress: ({ index }) => steps.push(index),
    });
    expect(result.cancelled).toBe(true);
    expect(result.added).toHaveLength(1);
    expect(ids(d)).toEqual([s(d, 'a'), s(d, 'b'), s(d, 'c'), result.added[0]]);
    expect(mockImageClip).toHaveBeenCalledTimes(2);
    expect(steps).toEqual([0, 1]);
    // The second image's output, made as the cancel landed, isn't left in the caches folder.
    expect(outputs.filter(existsSync)).toEqual([]);
  });

  it('is not cancelled when the abort comes after the last image', async () => {
    const d = await abc();
    const abort = new AbortController();
    const result = await addImageClips(images('one'), d, {
      signal: abort.signal,
      onAdded: () => abort.abort(),
    });
    expect(result).toMatchObject({ cancelled: false, skipped: [] });
    expect(result.added).toHaveLength(1);
  });
});
