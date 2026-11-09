import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// The real queries against the real schema: an in-memory SQLite with every migration applied,
// behind drizzle's proxy driver. Only secure-store (the passes) is a stand-in.
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
const mockTokens = new Map<string, string | null>();
jest.mock('./secure-token', () => ({
  getDestinationToken: async (id: string) => mockTokens.get(id) ?? null,
  setDestinationToken: async (id: string, token: string | null) => {
    mockTokens.set(id, token);
  },
  deleteDestinationToken: async (id: string) => {
    mockTokens.delete(id);
  },
}));
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id-${++mockUuid}` }));

/* eslint-disable import/first -- the mocks above must be registered before these load */
import type { DatabaseSync } from 'node:sqlite';

import * as client from './client';
import {
  addDestination,
  deleteDestination,
  deleteDestinationIfExpired,
  destinationsQuery,
  getDestination,
} from './destinations';
/* eslint-enable import/first */

const sqlite = (client as unknown as { sqlite: DatabaseSync }).sqlite;
const SERVER = 'https://vault.example.test/pulsevault';

const upload = (artifactId: string, over: Record<string, unknown> = {}) => ({
  server: SERVER,
  token: `token-${artifactId}`,
  artifactId,
  ...over,
});
const place = (ref: string, over: Record<string, unknown> = {}) => ({
  ref,
  label: `Label ${ref}`,
  app: 'TimeHuddle',
  returnUrl: `https://host.test/${ref}`,
  ...over,
});

/** The pool's ids in its own order (newest first). */
const order = async () => (await destinationsQuery).map((row) => row.id);
const setCreatedAt = (id: string, createdAt: number) =>
  sqlite.prepare('UPDATE upload_destinations SET created_at = ? WHERE id = ?').run(createdAt, id);
/** A draft recorded for `ref` on SERVER, uploading or uploaded under `artifactId` if given. */
const insertDraft = (id: string, ref: string, status: string | null, artifactId?: string) =>
  sqlite
    .prepare(
      `INSERT INTO drafts (id, context_server, context_ref, upload_status, upload_artifact_id) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, SERVER, ref, status, artifactId ?? null);

beforeEach(() => {
  sqlite.exec('DELETE FROM upload_destinations; DELETE FROM drafts;');
  mockTokens.clear();
});

describe('a plain link’s destination', () => {
  it('is stored with no place', async () => {
    const id = await addDestination(upload('art-1'));

    expect(await destinationsQuery).toMatchObject([
      {
        id,
        server: SERVER,
        artifactId: 'art-1',
        ref: null,
        label: null,
        app: null,
        returnUrl: null,
      },
    ]);
    expect(await getDestination(id)).toEqual(upload('art-1'));
  });

  it('the same link again refreshes its row’s token instead of adding one', async () => {
    const id = await addDestination(upload('art-1', { token: 'first' }));
    const again = await addDestination(upload('art-1', { token: 'second' }));

    expect(again).toBe(id);
    expect(await order()).toEqual([id]);
    expect(mockTokens.get(id)).toBe('second');
  });

  it('deleting says whether this call removed it, and drops its token', async () => {
    const id = await addDestination(upload('art-1'));

    expect(await deleteDestination(id)).toBe(true);
    expect(await deleteDestination(id)).toBe(false);
    expect(mockTokens.has(id)).toBe(false);
  });

  it('the expiry sweep removes it only if its stored token still reads as expired', async () => {
    const id = await addDestination(upload('art-1', { token: 'fresh' }));

    expect(await deleteDestinationIfExpired(id, (token) => token === 'stale')).toBe(false);
    expect(await order()).toEqual([id]);
    expect(await deleteDestinationIfExpired(id, (token) => token === 'fresh')).toBe(true);
    expect(await order()).toEqual([]);
    expect(mockTokens.has(id)).toBe(false);
  });
});

describe('a place’s destination', () => {
  it('is stored with the link’s upload and hints', async () => {
    const id = await addDestination(upload('art-1'), place('r1'));

    expect(await destinationsQuery).toMatchObject([
      {
        id,
        server: SERVER,
        artifactId: 'art-1',
        ref: 'r1',
        label: 'Label r1',
        app: 'TimeHuddle',
        returnUrl: 'https://host.test/r1',
      },
    ]);
    expect(mockTokens.get(id)).toBe('token-art-1');
  });

  it('a newer link for the place replaces the older one’s upload, token and hints in its row', async () => {
    const id = await addDestination(upload('art-1'), place('r1'));
    const again = await addDestination(
      upload('art-2'),
      place('r1', { label: 'Renamed', returnUrl: null }),
    );

    expect(again).toBe(id);
    expect(await destinationsQuery).toMatchObject([
      { id, artifactId: 'art-2', label: 'Renamed', returnUrl: null },
    ]);
    expect(await getDestination(id)).toEqual(upload('art-2'));
  });

  it('is one row per ref, and per server', async () => {
    const a = await addDestination(upload('art-1'), place('r1'));
    const b = await addDestination(upload('art-2'), place('r2'));
    const c = await addDestination(upload('art-3', { server: 'https://other.test' }), place('r1'));

    expect(new Set([a, b, c]).size).toBe(3);
    expect((await order()).length).toBe(3);
  });

  it('moves to the front of the pool when its place gets a newer link', async () => {
    const old = await addDestination(upload('art-1'), place('old'));
    const plain = await addDestination(upload('art-2'));
    setCreatedAt(old, 100);
    setCreatedAt(plain, 200);
    expect(await order()).toEqual([plain, old]);

    await addDestination(upload('art-3'), place('old'));
    expect(await order()).toEqual([old, plain]);
  });

  it('is left alone by a newer link while an upload is running on the one it holds', async () => {
    const id = await addDestination(upload('art-1'), place('r1'));
    insertDraft('d1', 'r1', 'uploading', 'art-1');

    expect(await addDestination(upload('art-2'), place('r1', { label: 'Newer' }))).toBe(id);

    expect(await destinationsQuery).toMatchObject([{ id, artifactId: 'art-1', label: 'Label r1' }]);
    expect(mockTokens.get(id)).toBe('token-art-1');
  });

  it('after its upload, is removed only while it still holds that upload’s link', async () => {
    const id = await addDestination(upload('art-1'), place('r1'));
    await addDestination(upload('art-2'), place('r1'));

    // The finished upload was art-1's; the row has a newer link now, which stays.
    expect(await deleteDestination(id, 'art-1')).toBe(false);
    expect(mockTokens.get(id)).toBe('token-art-2');
    expect(await deleteDestination(id, 'art-2')).toBe(true);
    expect(await order()).toEqual([]);
    expect(mockTokens.has(id)).toBe(false);
  });

  it('expired, stays while a draft recorded for it is unsent, keeping its token', async () => {
    const id = await addDestination(upload('art-1'), place('r1'));
    const expired = () => true;

    insertDraft('unsent', 'r1', null);
    expect(await deleteDestinationIfExpired(id, expired)).toBe(false);
    expect(await order()).toEqual([id]);
    expect(mockTokens.get(id)).toBe('token-art-1');

    // Once that draft is uploaded (or deleted), nothing needs the row.
    sqlite.exec(`UPDATE drafts SET upload_status = 'uploaded'`);
    expect(await deleteDestinationIfExpired(id, expired)).toBe(true);
    expect(await order()).toEqual([]);
  });

  it('expired, with a draft for another place only, is swept', async () => {
    const id = await addDestination(upload('art-1'), place('r1'));
    insertDraft('other', 'r2', null);

    expect(await deleteDestinationIfExpired(id, () => true)).toBe(true);
  });
});
