import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// The real migrations on node:sqlite (installationId lives in local_settings), and expo-crypto's
// digest done by Node's SHA-256, as the native one does it.
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
jest.mock('expo-crypto', () => {
  const { createHash } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex' },
    randomUUID: () => 'install-1',
    digestStringAsync: jest.fn(async (algorithm: string, data: string) => {
      if (algorithm !== 'SHA-256') throw new Error(`unexpected ${algorithm}`);
      // Upper case, as some platforms hand it back: the key is lower case either way.
      return createHash('sha256').update(data, 'utf8').digest('hex').toUpperCase();
    }),
  };
});

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { expoDb } from '@/db/client';
import { clientKeyOf, draftKeyOf, jobKeys, sig16 } from './client-key';
/* eslint-enable import/first */

const conn = expoDb as unknown as { execSync: (sql: string) => void };

beforeEach(() => conn.execSync('DELETE FROM local_settings'));

describe('client keys', () => {
  it('sig16 is the first 16 lower-case hex digits of SHA-256 over the signature', async () => {
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(await sig16('abc')).toBe('ba7816bf8f01cfea');
  });

  it('formats draftKey and clientKey', () => {
    expect(draftKeyOf('inst', 'd1')).toBe('inst:d1');
    expect(clientKeyOf('inst', 'd1', '0123456789abcdef')).toBe('inst:d1:0123456789abcdef');
  });

  it('keys a draft by this install: an edit changes the clientKey, never the draftKey', async () => {
    const first = await jobKeys('d1', '3|a.mp4|b.mp4');
    expect(first.draftKey).toBe('install-1:d1');
    expect(first.clientKey).toMatch(/^install-1:d1:[0-9a-f]{16}$/);
    // The same cut again: the same clientKey (the server answers with the same upload).
    expect(await jobKeys('d1', '3|a.mp4|b.mp4')).toEqual(first);
    const edited = await jobKeys('d1', '3|b.mp4|a.mp4');
    expect(edited.draftKey).toBe(first.draftKey);
    expect(edited.clientKey).not.toBe(first.clientKey);
  });
});
