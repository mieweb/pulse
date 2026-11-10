import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// The real queries against the real schema: an in-memory SQLite with every migration applied,
// behind drizzle's proxy driver. Only secure-store (the links' tokens) is a stand-in.
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
      if (/^(insert into|update) "upload_destinations"/i.test(sql)) mockWrites.push('row');
      return { rows: [] };
    }
    const rows = statement.all(...params).map((row) => Object.values(row));
    return { rows: method === 'get' ? rows[0] : rows };
  });
  return { db, sqlite };
});
const mockTokens = new Map<string, string>();
/** Every token write and row write, in order, to check which lands first. */
const mockWrites: string[] = [];
/** Set to make the next write of a token (not a clear) fail, as a full or locked keychain would. */
const mockFailure = { nextTokenWrite: false };
jest.mock('./secure-token', () => ({
  getDestinationToken: async (id: string) => mockTokens.get(id) ?? null,
  setDestinationToken: async (id: string, token: string | null) => {
    if (token === null) {
      mockWrites.push('token:clear');
      mockTokens.delete(id);
      return;
    }
    if (mockFailure.nextTokenWrite) {
      mockFailure.nextTokenWrite = false;
      throw new Error('secure-store write failed');
    }
    mockWrites.push(`token:${token}`);
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
  placeHoldsLink,
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
  mockWrites.length = 0;
  mockFailure.nextTokenWrite = false;
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

  it('is the same place only when ref and server are equal exactly (PROTOCOL.md §5.6)', async () => {
    const cp = String.fromCodePoint;
    const rows = [
      await addDestination(upload('art-1'), place('Ticket:42')),
      // No case folding, and no Unicode normalization: "é" in one code point or in two.
      await addDestination(upload('art-2'), place('ticket:42')),
      await addDestination(upload('art-3'), place(cp(0xe9))),
      await addDestination(upload('art-4'), place(`e${cp(0x301)}`)),
      // Nor of the server: its case, its port and its path are compared as written.
      await addDestination(upload('art-5', { server: SERVER.toUpperCase() }), place('Ticket:42')),
      await addDestination(
        upload('art-6', { server: SERVER.replace('.test', '.test:443') }),
        place('Ticket:42'),
      ),
    ];
    expect(new Set(rows).size).toBe(6);
    // The same ref on the same server is the one row.
    expect(await addDestination(upload('art-7'), place('Ticket:42'))).toBe(rows[0]);
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

  it('is left alone by a link that doesn’t take over from the one it holds', async () => {
    const id = await addDestination(upload('art-2'), place('r1', { label: 'Newer' }));
    const asked: (string | null)[] = [];
    const older = (stored: string | null) => {
      asked.push(stored);
      return false;
    };

    // An older link for the place opened late, or one its server hasn't accepted: the place
    // keeps the link it holds, whole.
    expect(await addDestination(upload('art-1'), place('r1', { label: 'Older' }), older)).toBe(id);

    expect(asked).toEqual(['token-art-2']);
    expect(await destinationsQuery).toMatchObject([{ id, artifactId: 'art-2', label: 'Newer' }]);
    expect(mockTokens.get(id)).toBe('token-art-2');
  });

  it('takes any link when it holds no token to compare with, and a first link always', async () => {
    const asked: (string | null)[] = [];
    const never = (stored: string | null) => {
      asked.push(stored);
      return stored === null;
    };
    const id = await addDestination(upload('art-1'), place('r1'), never);
    expect(asked).toEqual([]);

    mockTokens.delete(id);
    await addDestination(upload('art-2'), place('r1'), never);
    expect(asked).toEqual([null]);
    expect(await getDestination(id)).toEqual(upload('art-2'));
  });

  it('clears the old token before the row takes the new upload, and writes the new token last', async () => {
    const id = await addDestination(upload('art-1'), place('r1'));
    expect(mockWrites).toEqual(['row', 'token:token-art-1']);
    mockWrites.length = 0;

    await addDestination(upload('art-2'), place('r1'));
    expect(mockWrites).toEqual(['token:clear', 'row', 'token:token-art-2']);
    expect(await getDestination(id)).toEqual(upload('art-2'));
  });

  it('stopped before its token is written, never holds a new upload with the old token', async () => {
    const id = await addDestination(upload('art-1'), place('r1'));

    mockFailure.nextTokenWrite = true;
    await expect(addDestination(upload('art-2'), place('r1'))).rejects.toThrow();

    // The row has the new upload and no token: it isn't offered until the link is opened again.
    expect(await getDestination(id)).toEqual({ ...upload('art-2'), token: null });

    // Opening the link again completes it, whatever `takesOver` would say of a stored token.
    await addDestination(upload('art-2'), place('r1'), (stored) => stored === null);
    expect(await getDestination(id)).toEqual(upload('art-2'));

    // The same for a place's first link: a row, then its token.
    mockFailure.nextTokenWrite = true;
    await expect(addDestination(upload('art-9'), place('r9'))).rejects.toThrow();
    const [first] = (await destinationsQuery).filter((row) => row.ref === 'r9');
    expect(await getDestination(first.id)).toEqual({ ...upload('art-9'), token: null });
  });

  it('takes the place of the same upload paired as a plain link before an upgrade', async () => {
    // What the released app stored for this link: no place.
    const before = await addDestination(upload('art-1'));
    const other = await addDestination(upload('art-other'));

    const id = await addDestination(upload('art-1'), place('r1'));

    expect((await order()).sort()).toEqual([id, other].sort());
    expect(mockTokens.has(before)).toBe(false);
    expect(mockTokens.get(id)).toBe('token-art-1');
  });

  it('holds a link only as that very link: the same upload and the same token', async () => {
    const id = await addDestination(upload('art-1'), place('r1'));
    expect(await placeHoldsLink(upload('art-1'), 'r1')).toBe(true);
    // Another upload, another token, another place or another server is another link.
    expect(await placeHoldsLink(upload('art-2'), 'r1')).toBe(false);
    expect(await placeHoldsLink(upload('art-1', { token: 'changed' }), 'r1')).toBe(false);
    expect(await placeHoldsLink(upload('art-1'), 'r2')).toBe(false);
    expect(await placeHoldsLink(upload('art-1', { server: `${SERVER}/` }), 'r1')).toBe(false);
    // A row cut short between its two writes holds nothing; nor does a place once claimed.
    mockTokens.delete(id);
    expect(await placeHoldsLink(upload('art-1'), 'r1')).toBe(false);
    expect(await placeHoldsLink(upload('art-1', { token: null }), 'r1')).toBe(false);
    await deleteDestination(id);
    expect(await placeHoldsLink(upload('art-1'), 'r1')).toBe(false);
  });

  it('is used up by a claim like any other, and the place’s next link makes a new row', async () => {
    const id = await addDestination(upload('art-1'), place('r1'));
    // A draft claims it: the upload is running under art-1, and the row is gone.
    insertDraft('d1', 'r1', 'uploading', 'art-1');
    expect(await deleteDestination(id)).toBe(true);
    expect(mockTokens.has(id)).toBe(false);

    // A link for the same place while that upload runs is a fresh row, for the next draft.
    const next = await addDestination(upload('art-2'), place('r1'));
    expect(next).not.toBe(id);
    expect(await destinationsQuery).toMatchObject([{ id: next, artifactId: 'art-2', ref: 'r1' }]);
    expect(await getDestination(next)).toEqual(upload('art-2'));
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
