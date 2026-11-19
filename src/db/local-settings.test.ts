import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// The real migrations on a node:sqlite stand-in for expo-sqlite, behind the drizzle expo driver the
// app uses (its sync `.get()` / `.run()` included).
jest.mock(
  'expo-sqlite',
  () =>
    jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
      '@/test-support/expo-sqlite-node',
    ).mockModule,
);
jest.mock('./client', () => {
  const { readdirSync, readFileSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
  const { join } = jest.requireActual<typeof import('node:path')>('node:path');
  const { SQLiteDatabase } = jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
    '@/test-support/expo-sqlite-node',
  );
  const { drizzle } =
    jest.requireActual<typeof import('drizzle-orm/expo-sqlite')>('drizzle-orm/expo-sqlite');
  const conn = new SQLiteDatabase(':memory:');
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
let mockUuids = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mockUuids}` }));

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { expoDb } from './client';
import { installationId, setWifiOnlyUploads, wifiOnlyUploads } from './local-settings';
/* eslint-enable import/first */

const conn = expoDb as unknown as {
  getAllSync: (sql: string) => unknown[];
  execSync: (sql: string) => void;
};
const rows = () => conn.getAllSync('SELECT key, value FROM local_settings ORDER BY key');

beforeEach(() => {
  conn.execSync('DELETE FROM local_settings');
  conn.execSync('DELETE FROM settings');
});

describe('installationId', () => {
  it('is made once, on first use, and the same from then on', () => {
    expect(rows()).toEqual([]);
    const first = installationId();
    expect(first).toMatch(/^uuid-\d+$/);
    expect(installationId()).toBe(first);
    expect(installationId()).toBe(first);
    expect(rows()).toEqual([{ key: 'installationId', value: first }]);
  });

  it('keeps one already stored, and lives in local_settings, never in settings', () => {
    conn.execSync("INSERT INTO local_settings (key, value) VALUES ('installationId', 'kept')");
    expect(installationId()).toBe('kept');
    expect(conn.getAllSync('SELECT * FROM settings')).toEqual([]);
  });

  it('still makes one in a library a newer Pulse migrated: Send needs it (AD34)', () => {
    jest.isolateModules(() => {
      const h = jest.requireActual<typeof import('./host-context')>('./host-context');
      const ls = jest.requireActual<typeof import('./local-settings')>('./local-settings');
      // This registry's own in-memory library (the client mock runs again in it).
      const own = jest.requireMock<typeof import('./client')>('./client')
        .expoDb as unknown as typeof conn;
      h.markNewerSchema();
      const id = ls.installationId();
      expect(own.getAllSync('SELECT key, value FROM local_settings')).toEqual([
        { key: 'installationId', value: id },
      ]);
      ls.setWifiOnlyUploads(true);
      expect(ls.wifiOnlyUploads()).toBe(true);
    });
  });
});

describe('wifiOnlyUploads', () => {
  it('is off until set, and stores the latest choice as 1 / 0', () => {
    expect(wifiOnlyUploads()).toBe(false);
    setWifiOnlyUploads(true);
    expect(wifiOnlyUploads()).toBe(true);
    expect(rows()).toEqual([{ key: 'wifiOnlyUploads', value: '1' }]);
    setWifiOnlyUploads(false);
    expect(wifiOnlyUploads()).toBe(false);
    expect(rows()).toEqual([{ key: 'wifiOnlyUploads', value: '0' }]);
  });
});
