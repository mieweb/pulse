import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// The real queries against the real schema: an in-memory SQLite with every migration applied,
// behind drizzle's proxy driver (as destinations.test.ts does). Files and secure-store are
// stand-ins: none of these queries touches them.
jest.mock('./client', () => {
  const { readdirSync, readFileSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
  const { join } = jest.requireActual<typeof import('node:path')>('node:path');
  const { DatabaseSync } = jest.requireActual<typeof import('node:sqlite')>('node:sqlite');
  const { drizzle } = jest.requireActual<typeof import('drizzle-orm/sqlite-proxy')>(
    'drizzle-orm/sqlite-proxy',
  );
  const sqlite = new DatabaseSync(':memory:');
  const dir = join(__dirname, '../../drizzle');
  for (const file of readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()) {
    for (const statement of readFileSync(join(dir, file), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  const db = drizzle(async (sql, params, method) => {
    const statement = sqlite.prepare(sql);
    if (method === 'run') {
      statement.run(...params);
      return { rows: [] };
    }
    const rows = statement.all(...params).map((row) => Object.values(row));
    return { rows: method === 'get' ? rows[0] : rows };
  });
  return { db, sqlite };
});
jest.mock('@/utils/file-store', () => ({
  absolutize: (p: string) => `file:///docs/${p}`,
  copyRelFile: jest.fn(),
  deleteDraftDir: jest.fn(),
  deleteSegmentFile: jest.fn(),
  editCoverRelPath: jest.fn(),
  editedThumbRelPath: jest.fn(),
  thumbRelPath: jest.fn(),
}));
jest.mock('@/utils/video', () => ({
  coverFailed: jest.fn(),
  generateThumbnailFile: jest.fn(async () => true),
  markCoverInFlight: jest.fn(),
}));
jest.mock('./secure-token', () => ({ deleteSavedLink: jest.fn(async () => {}) }));
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `draft-${++mockUuid}` }));

/* eslint-disable import/first -- the mocks above must be registered before these load */
import type { DatabaseSync } from 'node:sqlite';

import * as client from './client';
import {
  burnUploadPairing,
  createDraft,
  draftListQuery,
  draftPlaceQuery,
  findOpenDraftForContext,
  getUploadingDraftIds,
  markUploaded,
  setUploadDestination,
} from './drafts';
/* eslint-enable import/first */

const sqlite = (client as unknown as { sqlite: DatabaseSync }).sqlite;
const SERVER = 'https://vault.example.test/pulsevault';
// A key with the characters a route would have mangled: it is only ever compared, as it is.
const REF = 'ticket%3A12:a/b';
const HUDDLE = { server: SERVER, ref: REF };

/** Give a draft a clip, so it isn't an empty one about to be dropped. */
const addClip = (draftId: string) =>
  sqlite
    .prepare(
      `INSERT INTO segments (id, draft_id, sort_order, original_filename, duration_ms) VALUES (?, ?, 0, ?, 1000)`,
    )
    .run(`${draftId}-clip`, draftId, `drafts/${draftId}/segments/clip.mp4`);
const touch = (draftId: string, at: number) =>
  sqlite.prepare('UPDATE drafts SET last_modified = ? WHERE id = ?').run(at, draftId);
/** A draft recorded for `context` (or for no place), with a clip. */
async function recorded(context: typeof HUDDLE | null, name: string | null = null) {
  const id = await createDraft({ name, context });
  addClip(id);
  return id;
}

beforeEach(() => {
  sqlite.exec('DELETE FROM segments; DELETE FROM drafts; DELETE FROM upload_destinations;');
});

describe('findOpenDraftForContext', () => {
  it('finds the unsent draft recorded for the place, by its key exactly as it was read', async () => {
    const draft = await recorded(HUDDLE);
    expect(await findOpenDraftForContext(HUDDLE)).toBe(draft);
    // A key that only looks the same once decoded is another place.
    expect(await findOpenDraftForContext({ server: SERVER, ref: 'ticket:12:a/b' })).toBeNull();
    expect(await findOpenDraftForContext({ server: 'https://other.test', ref: REF })).toBeNull();
  });

  it('never finds a draft recorded for no place', async () => {
    await recorded(null);
    expect(await findOpenDraftForContext(HUDDLE)).toBeNull();
  });

  it('is the newest of the place’s unsent drafts', async () => {
    const older = await recorded(HUDDLE);
    const newer = await recorded(HUDDLE);
    touch(older, 1000);
    touch(newer, 2000);
    expect(await findOpenDraftForContext(HUDDLE)).toBe(newer);
    touch(older, 3000);
    expect(await findOpenDraftForContext(HUDDLE)).toBe(older);
  });

  it('passes over an empty draft, which the recorder that made it is about to drop', async () => {
    await createDraft({ context: HUDDLE });
    expect(await findOpenDraftForContext(HUDDLE)).toBeNull();
  });

  it('passes over a draft while it uploads and once it is uploaded', async () => {
    const draft = await recorded(HUDDLE);
    await setUploadDestination(draft, { server: SERVER, artifactId: 'art-1' });
    expect(await findOpenDraftForContext(HUDDLE)).toBeNull();

    expect(await markUploaded(draft, 'art-1')).toBe(true);
    expect(await findOpenDraftForContext(HUDDLE)).toBeNull();
  });

  it('comes back to the same draft after its upload failed or was cancelled', async () => {
    const draft = await recorded(HUDDLE, 'Huddle update');
    await setUploadDestination(draft, { server: SERVER, artifactId: 'art-1' });
    // The upload fails: the draft is unpaired, and keeps its place and its name.
    expect(await burnUploadPairing(draft, 'art-1')).toBe(true);

    expect(await findOpenDraftForContext(HUDDLE)).toBe(draft);
    expect(await draftPlaceQuery(draft)).toEqual([
      { server: SERVER, ref: REF, name: 'Huddle update', uploadStatus: null },
    ]);
  });
});

describe('draftPlaceQuery', () => {
  it('says the draft’s place, name and upload state', async () => {
    const draft = await recorded(HUDDLE, 'Huddle update');
    expect(await draftPlaceQuery(draft)).toEqual([
      { server: SERVER, ref: REF, name: 'Huddle update', uploadStatus: null },
    ]);
    await setUploadDestination(draft, { server: SERVER, artifactId: 'art-1' });
    expect((await draftPlaceQuery(draft))[0].uploadStatus).toBe('uploading');
  });

  it('has no place for a draft recorded for none, and no row for a draft that is gone', async () => {
    const plain = await recorded(null);
    expect(await draftPlaceQuery(plain)).toEqual([
      { server: null, ref: null, name: null, uploadStatus: null },
    ]);
    expect(await draftPlaceQuery('no-such-draft')).toEqual([]);
  });
});

describe('draftListQuery', () => {
  it('lists each draft with the place it was recorded for', async () => {
    const forPlace = await recorded(HUDDLE);
    const plain = await recorded(null, 'My video');
    touch(forPlace, 2000);
    touch(plain, 1000);

    expect(await draftListQuery).toMatchObject([
      { id: forPlace, name: null, contextServer: SERVER, contextRef: REF, segmentCount: 1 },
      { id: plain, name: 'My video', contextServer: null, contextRef: null, segmentCount: 1 },
    ]);
  });
});

describe('getUploadingDraftIds', () => {
  it('is the drafts a killed app left uploading, whatever they were recorded for', async () => {
    const forPlace = await recorded(HUDDLE);
    const plain = await recorded(null);
    const idle = await recorded(HUDDLE);
    await setUploadDestination(forPlace, { server: SERVER, artifactId: 'art-1' });
    await setUploadDestination(plain, { server: SERVER, artifactId: 'art-2' });

    expect((await getUploadingDraftIds()).sort()).toEqual([forPlace, plain].sort());
    expect(await getUploadingDraftIds()).not.toContain(idle);
  });
});
