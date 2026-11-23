import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// The real migrations on a node:sqlite stand-in for expo-sqlite, behind the drizzle expo driver.
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

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { db, expoDb } from './client';
import {
  deleteExpiredReceipts,
  dismissReceipt,
  getReceipt,
  insertReceipt,
  listReceipts,
  markMediaDeleted,
  RECEIPT_TTL_MS,
  receiptsWithMedia,
  type NewReceipt,
} from './receipts';
/* eslint-enable import/first */

const conn = expoDb as unknown as { execSync: (sql: string) => void };
const NOW = 1_790_000_000_000;

function receipt(
  draftId: string,
  over: Partial<NewReceipt> = {},
): Omit<NewReceipt, 'mediaDeletedAt'> {
  return {
    draftId,
    name: 'Shift notes',
    contextKey: 'ticket:t1',
    contextLabel: 'Ticket 1',
    contextJson: '{"kind":"ticket","id":"t1","label":"Ticket 1"}',
    uploadTypeJson: null,
    outcome: 'done',
    note: 'Posted',
    reason: null,
    uploadId: 'up-1',
    artifactId: 'vid-1',
    clientKey: `i:${draftId}:aaaa`,
    clipCount: 2,
    durationMs: 4000,
    sentAt: NOW - 60_000,
    deliveredAt: NOW,
    expiresAt: NOW + RECEIPT_TTL_MS,
    ...over,
  };
}

const insert = (row: Omit<NewReceipt, 'mediaDeletedAt'>) =>
  db.transaction((tx) => insertReceipt(tx, row));

beforeEach(() => {
  conn.execSync('DELETE FROM upload_receipts');
});

describe('upload receipts', () => {
  it('stores a receipt with its media still to delete, and reads it back', () => {
    insert(receipt('d1'));
    expect(getReceipt('d1')).toEqual({ ...receipt('d1'), dismissedAt: null, mediaDeletedAt: null });
    expect(getReceipt('nope')).toBeNull();
  });

  it('lists receipts newest delivery first', () => {
    insert(receipt('old', { deliveredAt: NOW - 1000 }));
    insert(receipt('new', { deliveredAt: NOW + 1000 }));
    insert(receipt('mid'));
    expect(listReceipts().map((r) => r.draftId)).toEqual(['new', 'mid', 'old']);
  });

  it('lists the receipts whose folder is still to delete until that is recorded', () => {
    insert(receipt('a'));
    insert(receipt('b'));
    expect(
      receiptsWithMedia()
        .map((r) => r.draftId)
        .sort(),
    ).toEqual(['a', 'b']);
    markMediaDeleted('a', NOW + 5);
    expect(receiptsWithMedia().map((r) => r.draftId)).toEqual(['b']);
    expect(getReceipt('a')?.mediaDeletedAt).toBe(NOW + 5);
    // The first time stands.
    markMediaDeleted('a', NOW + 99);
    expect(getReceipt('a')?.mediaDeletedAt).toBe(NOW + 5);
  });

  it('deletes receipts only once they expired, and never one whose folder is still to delete', () => {
    insert(receipt('expired', { expiresAt: NOW - 1 }));
    insert(receipt('due-now', { expiresAt: NOW }));
    insert(receipt('fresh'));
    insert(receipt('expired-with-media', { expiresAt: NOW - 1 }));
    for (const id of ['expired', 'due-now', 'fresh']) markMediaDeleted(id, NOW - 10);

    expect(deleteExpiredReceipts(NOW)).toEqual(['expired']);
    expect(
      listReceipts()
        .map((r) => r.draftId)
        .sort(),
    ).toEqual(['due-now', 'expired-with-media', 'fresh']);
    // Once its folder is gone it expires like the others.
    markMediaDeleted('expired-with-media', NOW);
    expect(deleteExpiredReceipts(NOW + RECEIPT_TTL_MS + 1).sort()).toEqual([
      'due-now',
      'expired-with-media',
      'fresh',
    ]);
  });

  it('dismisses a receipt once, and says when there is none', () => {
    insert(receipt('k', { outcome: 'kept', note: null, reason: 'The ticket was closed' }));
    expect(dismissReceipt('k', NOW + 1)).toBe(true);
    expect(dismissReceipt('k', NOW + 2)).toBe(true);
    expect(getReceipt('k')?.dismissedAt).toBe(NOW + 1);
    expect(dismissReceipt('missing', NOW)).toBe(false);
  });

  it('keeps receipts 7 days', () => {
    expect(RECEIPT_TTL_MS).toBe(7 * 24 * 3600 * 1000);
  });
});
