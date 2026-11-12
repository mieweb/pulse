import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { SQLiteDatabase } from 'expo-sqlite';

import {
  CanonicalProjectionCommitError,
  CanonicalProjectionRollbackError,
  installCanonicalCommitGuard,
  type CanonicalProjectionFailure,
} from './sqlite-guard';

// The real Drizzle Expo entry also exports useLiveQuery. Only its unused native listener
// module is stubbed; the database, session, prepared statements and transactions stay real.
jest.mock('expo-sqlite', () => ({}));

const items = sqliteTable('items', {
  id: text('id').primaryKey(),
  value: text('value').notNull(),
  position: integer('position').notNull().default(0),
});
const connections: DatabaseSync[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});

/** Real Expo Drizzle driver/session, with only the Expo native statement calls substituted. */
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  connections.push(sqlite);
  sqlite.exec(
    'CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0)',
  );
  const events: string[] = [];
  const snapshots: unknown[] = [];
  const faults: CanonicalProjectionFailure[] = [];
  const state = {
    ready: true,
    failSave: false,
    failCommit: false,
    failRollback: false,
    failNotification: false,
  };
  let onSave: (() => void) | undefined;
  const adapter = {
    prepareSync(source: string) {
      const statement = sqlite.prepare(source);
      const execute = (params: unknown[], raw: boolean) => {
        const command = source.trim().toLowerCase();
        events.push(command);
        if (command === 'commit' && state.failCommit) {
          state.failCommit = false;
          throw new Error('projection disk failure');
        }
        if (command.startsWith('rollback') && state.failRollback) {
          state.failRollback = false;
          throw new Error('projection rollback failure');
        }
        const objects = statement.all(...(params as (string | number | null)[]));
        const rows = raw ? objects.map((row) => Object.values(row)) : objects;
        const meta = sqlite
          .prepare('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowId')
          .get()!;
        return {
          changes: Number(meta.changes),
          lastInsertRowId: Number(meta.lastInsertRowId),
          getAllSync: () => rows,
          getFirstSync: () => rows[0] ?? null,
        };
      };
      return {
        executeSync: (params: unknown[]) => execute(params, false),
        executeForRawResultSync: (params: unknown[]) => execute(params, true),
      };
    },
  } as unknown as SQLiteDatabase;
  const db = drizzle(adapter, { schema: { items } });
  const rows = () => sqlite.prepare('SELECT * FROM items ORDER BY id').all();
  const guard = installCanonicalCommitGuard(db, {
    isReady: () => state.ready,
    beforeCommit: () => {
      events.push('canonical');
      if (state.failSave) throw new Error('canonical disk full');
      if (onSave) return onSave();
      // The coordinator can read pending rows through Drizzle while persistence is in progress.
      snapshots.push(db.select().from(items).orderBy(items.id).all());
    },
    onProjectionFailure: (error) => {
      faults.push(error);
      state.ready = false;
      if (state.failNotification) throw new Error('notification failed');
    },
  });
  return {
    db,
    sqlite,
    rows,
    guard,
    events,
    snapshots,
    faults,
    state,
    setBeforeCommit(callback: () => void) {
      onSave = callback;
    },
  };
}

describe('canonical SQLite commit guard', () => {
  it('keeps reads read-only, including CTEs, pragmas and all result methods', () => {
    const f = fixture();
    expect(f.db.select().from(items).all()).toEqual([]);
    expect(f.db.select().from(items).get()).toBeUndefined();
    expect(f.db.select().from(items).values()).toEqual([]);
    expect(f.db.all(sql`WITH numbers AS (SELECT 7 AS n) SELECT n FROM numbers`)).toEqual([
      { n: 7 },
    ]);
    expect(f.db.all(sql.raw('/* read */ SELECT 3 AS n'))).toEqual([{ n: 3 }]);
    expect(f.db.all(sql.raw('PRAGMA table_info(items)'))).toHaveLength(3);
    expect(f.snapshots).toEqual([]);
    expect(f.events).not.toContain('begin');
  });

  it('persists awaited insert, update and delete before their individual commits', async () => {
    const f = fixture();
    await f.db.insert(items).values({ id: 'a', value: 'first' });
    await f.db.update(items).set({ value: 'second' }).where(eq(items.id, 'a'));
    await f.db.delete(items).where(eq(items.id, 'a'));
    expect(f.snapshots).toEqual([
      [{ id: 'a', value: 'first', position: 0 }],
      [{ id: 'a', value: 'second', position: 0 }],
      [],
    ]);
    const boundaries = f.events.filter((e) => ['begin', 'canonical', 'commit'].includes(e));
    expect(boundaries).toEqual([
      'begin',
      'canonical',
      'commit',
      'begin',
      'canonical',
      'commit',
      'begin',
      'canonical',
      'commit',
    ]);
  });

  it('guards RETURNING all/get/values and preserves each result shape', () => {
    const f = fixture();
    expect(f.db.insert(items).values({ id: 'a', value: 'one' }).returning().all()).toEqual([
      { id: 'a', value: 'one', position: 0 },
    ]);
    expect(f.db.update(items).set({ value: 'two' }).returning().get()).toEqual({
      id: 'a',
      value: 'two',
      position: 0,
    });
    expect(f.db.delete(items).returning().values()).toEqual([['a', 'two', 0]]);
    expect(f.snapshots).toHaveLength(3);
    expect(f.rows()).toEqual([]);
  });

  it('guards raw SQL writes and CTE writes, including a CTE named like a read verb', () => {
    const f = fixture();
    expect(f.db.run(sql`INSERT INTO items (id, value) VALUES ('a', 'one')`).changes).toBe(1);
    f.db.run(
      sql.raw("WITH \"select\" AS (SELECT 1) INSERT INTO items (id, value) VALUES ('b', 'two')"),
    );
    expect(
      f.db.all(
        sql`WITH next AS (SELECT 'changed' AS v) UPDATE items SET value = (SELECT v FROM next) WHERE id = 'a' RETURNING id, value`,
      ),
    ).toEqual([{ id: 'a', value: 'changed' }]);
    expect(f.snapshots).toHaveLength(3);
    expect(f.rows()).toHaveLength(2);
  });

  it('persists explicit transactions once with their final state and return value', () => {
    const f = fixture();
    const result = f.db.transaction((tx) => {
      tx.insert(items).values({ id: 'a', value: 'one' }).run();
      tx.insert(items).values({ id: 'b', value: 'two' }).run();
      return tx.select().from(items).all().length;
    });
    expect(result).toBe(2);
    expect(f.snapshots).toEqual([
      [
        { id: 'a', value: 'one', position: 0 },
        { id: 'b', value: 'two', position: 0 },
      ],
    ]);
    expect(f.events.filter((e) => e === 'canonical' || e === 'commit')).toEqual([
      'canonical',
      'commit',
    ]);
  });

  it('does not persist a read-only transaction', () => {
    const f = fixture();
    expect(f.db.transaction((tx) => tx.select().from(items).all())).toEqual([]);
    expect(f.snapshots).toEqual([]);
  });

  it('honors nested commit and rollback savepoints without publishing intermediate rows', () => {
    const f = fixture();
    f.db.transaction((tx) => {
      tx.insert(items).values({ id: 'a', value: 'keep' }).run();
      try {
        tx.transaction((nested) => {
          nested.insert(items).values({ id: 'b', value: 'discard' }).run();
          throw new Error('abort nested');
        });
      } catch {}
      tx.transaction((nested) =>
        nested.insert(items).values({ id: 'c', value: 'also keep' }).run(),
      );
    });
    expect(f.snapshots).toEqual([
      [
        { id: 'a', value: 'keep', position: 0 },
        { id: 'c', value: 'also keep', position: 0 },
      ],
    ]);
    expect(f.rows()).toHaveLength(2);
  });

  it('does not save changes that all rolled back to a quoted outer savepoint', () => {
    const f = fixture();
    f.db.run(sql.raw('SAVEPOINT "one"'));
    f.db.insert(items).values({ id: 'a', value: 'discard' }).run();
    f.db.run(sql.raw('ROLLBACK TO SAVEPOINT "one"'));
    f.db.run(sql.raw('RELEASE SAVEPOINT "one"'));
    expect(f.rows()).toEqual([]);
    expect(f.snapshots).toEqual([]);
    f.db.run(sql.raw('SAVEPOINT "one"'));
    f.db.insert(items).values({ id: 'a', value: 'keep' }).run();
    f.db.run(sql.raw('RELEASE SAVEPOINT "one"'));
    expect(f.snapshots).toHaveLength(1);
  });

  it('rolls back a standalone mutation when the canonical save fails', () => {
    const f = fixture();
    f.state.failSave = true;
    expect(() => f.db.insert(items).values({ id: 'a', value: 'one' }).returning().get()).toThrow(
      'canonical disk full',
    );
    expect(f.rows()).toEqual([]);
    expect(f.events).not.toContain('commit');
    expect(f.events).toContain('rollback');
    expect(f.guard.poisoned).toBe(false);
    f.state.failSave = false;
    f.db.insert(items).values({ id: 'b', value: 'works' }).run();
    expect(f.rows()).toHaveLength(1);
  });

  it('rolls back every explicit-transaction mutation when canonical persistence fails', () => {
    const f = fixture();
    f.state.failSave = true;
    expect(() =>
      f.db.transaction((tx) => {
        tx.insert(items).values({ id: 'a', value: 'one' }).run();
        tx.insert(items).values({ id: 'b', value: 'two' }).run();
      }),
    ).toThrow("Failed to run the query 'commit'");
    expect(f.rows()).toEqual([]);
    expect(f.events.filter((e) => e === 'rollback')).toHaveLength(1);
    expect(f.faults).toEqual([]);
  });

  it('does not persist a failed standalone SQL statement or an aborted transaction', () => {
    const f = fixture();
    expect(() =>
      f.db
        .insert(items)
        .values({ id: 'a', value: null as unknown as string })
        .run(),
    ).toThrow();
    expect(() =>
      f.db.transaction((tx) => {
        tx.insert(items).values({ id: 'a', value: 'discard' }).run();
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(f.snapshots).toEqual([]);
    expect(f.rows()).toEqual([]);
  });

  it('rolls back a failed raw COMMIT without depending on a transaction callback', () => {
    const f = fixture();
    f.db.run(sql.raw('BEGIN'));
    f.db.insert(items).values({ id: 'a', value: 'discard' }).run();
    f.state.failSave = true;
    expect(() => f.db.run(sql.raw('COMMIT'))).toThrow();
    expect(f.rows()).toEqual([]);
    f.guard.setEnabled(false);
  });

  it('can roll back even when readiness becomes false inside a transaction', () => {
    const f = fixture();
    expect(() =>
      f.db.transaction((tx) => {
        tx.insert(items).values({ id: 'a', value: 'discard' }).run();
        f.state.ready = false;
        throw new Error('abort after readiness loss');
      }),
    ).toThrow('abort after readiness loss');
    expect(f.rows()).toEqual([]);
    expect(f.snapshots).toEqual([]);
    f.guard.setEnabled(false);
  });

  it('rejects a write from inside a canonical callback and rolls back pending rows', () => {
    const f = fixture();
    f.setBeforeCommit(() => f.db.insert(items).values({ id: 'b', value: 'illegal' }).run());
    expect(() => f.db.insert(items).values({ id: 'a', value: 'discard' }).run()).toThrow(
      'must not mutate',
    );
    expect(f.rows()).toEqual([]);
    expect(f.guard.poisoned).toBe(false);
  });

  it('rejects asynchronous canonical callbacks and rolls back pending rows', async () => {
    const f = fixture();
    f.setBeforeCommit(async () => {
      await Promise.resolve();
    });
    expect(() => f.db.insert(items).values({ id: 'a', value: 'discard' }).run()).toThrow(
      'must be synchronous',
    );
    await Promise.resolve();
    expect(f.rows()).toEqual([]);
    expect(f.guard.poisoned).toBe(false);
  });

  it('retains durable success and poisons the cache when an implicit commit fails', () => {
    const f = fixture();
    f.state.failCommit = true;
    const result = f.db.insert(items).values({ id: 'a', value: 'saved' }).returning().all();
    expect(result).toEqual([{ id: 'a', value: 'saved', position: 0 }]);
    expect(f.snapshots).toEqual([result]);
    expect(f.rows()).toEqual([]);
    expect(f.guard.poisoned).toBe(true);
    expect(f.guard.failure).toBeInstanceOf(CanonicalProjectionCommitError);
    expect(f.faults[0].canonicalCommitted).toBe(true);
    expect(() => f.db.select().from(items).all()).toThrow('requires rehydration');
    expect(() => f.db.insert(items).values({ id: 'b', value: 'blocked' }).run()).toThrow(
      'requires rehydration',
    );
  });

  it('does not make a durable explicit transaction look failed to media-cleanup callers', () => {
    const f = fixture();
    f.state.failCommit = true;
    f.state.failNotification = true;
    let deletedCanonicalMedia = false;
    let result: string | undefined;
    try {
      result = f.db.transaction((tx) => {
        tx.insert(items).values({ id: 'a', value: 'saved' }).run();
        return 'saved';
      });
    } catch {
      deletedCanonicalMedia = true;
    }
    expect(result).toBe('saved');
    expect(deletedCanonicalMedia).toBe(false);
    expect(f.guard.poisoned).toBe(true);
    expect(f.snapshots).toHaveLength(1);
  });

  it('throws the failed save and poisons pending SQLite rows when rollback also fails', () => {
    const f = fixture();
    f.state.failSave = true;
    f.state.failRollback = true;
    expect(() => f.db.insert(items).values({ id: 'a', value: 'never saved' }).run()).toThrow(
      'canonical disk full',
    );
    expect(f.snapshots).toEqual([]);
    // The injected failed ROLLBACK deliberately leaves unsafe pending rows in the native DB.
    expect(f.rows()).toHaveLength(1);
    expect(f.guard.failure).toBeInstanceOf(CanonicalProjectionRollbackError);
    expect(f.faults[0].canonicalCommitted).toBe(false);
    expect(f.state.ready).toBe(false);
    expect(() => f.db.select().from(items).all()).toThrow('requires rehydration');
    expect(() => f.db.insert(items).values({ id: 'b', value: 'blocked' }).run()).toThrow(
      'requires rehydration',
    );
    f.guard.setEnabled(false);
    f.sqlite.exec('ROLLBACK');
    f.guard.clearPoison();
    f.guard.setEnabled(true);
    expect(f.rows()).toEqual([]);
  });

  it('preserves the failed transaction outcome when both canonical save and rollback fail', () => {
    const f = fixture();
    f.state.failSave = true;
    f.state.failRollback = true;
    expect(() =>
      f.db.transaction((tx) => {
        tx.insert(items).values({ id: 'a', value: 'never saved' }).run();
      }),
    ).toThrow();
    expect(f.snapshots).toEqual([]);
    expect(f.guard.poisoned).toBe(true);
    expect(f.faults).toHaveLength(1);
    expect(f.faults[0].canonicalCommitted).toBe(false);
    expect(f.events.filter((event) => event === 'rollback')).toHaveLength(1);
    expect(() => f.db.select().from(items).all()).toThrow('requires rehydration');
  });

  it('keeps canonical success when both projection commit and rollback fail', () => {
    const f = fixture();
    f.state.failCommit = true;
    f.state.failRollback = true;
    expect(f.db.insert(items).values({ id: 'a', value: 'saved' }).returning().get()?.value).toBe(
      'saved',
    );
    expect(f.snapshots).toHaveLength(1);
    expect(f.guard.failure).toBeInstanceOf(CanonicalProjectionCommitError);
    expect(f.faults[0].canonicalCommitted).toBe(true);
    expect(f.state.ready).toBe(false);
    expect(() => f.db.select().from(items).all()).toThrow('requires rehydration');
  });

  it('requires disabled rehydration before poison can be cleared', () => {
    const f = fixture();
    f.state.failCommit = true;
    f.db.insert(items).values({ id: 'a', value: 'saved' }).run();
    expect(() => f.guard.clearPoison()).toThrow('Rehydrate while disabled');
    f.guard.setEnabled(false);
    f.db.insert(items).values({ id: 'a', value: 'saved' }).run();
    f.guard.clearPoison();
    f.guard.setEnabled(true);
    expect(f.guard.failure).toBeNull();
    expect(f.db.select().from(items).all()).toHaveLength(1);
    expect(f.snapshots).toHaveLength(1);
  });

  it('gates writes on readiness while allowing reads and controlled disabled bootstrap', () => {
    const f = fixture();
    f.state.ready = false;
    expect(f.db.select().from(items).all()).toEqual([]);
    expect(() => f.db.insert(items).values({ id: 'a', value: 'blocked' }).run()).toThrow(
      'not ready',
    );
    f.guard.setEnabled(false);
    f.db.insert(items).values({ id: 'a', value: 'bootstrap' }).run();
    expect(f.snapshots).toEqual([]);
    f.guard.setEnabled(true);
    f.state.ready = true;
    f.db.update(items).set({ value: 'saved' }).run();
    expect(f.snapshots).toHaveLength(1);
  });

  it('rejects async callbacks and blocks their transaction handles after rollback', async () => {
    const f = fixture();
    expect(() =>
      f.db.transaction(async (tx) => {
        tx.insert(items).values({ id: 'a', value: 'before await' }).run();
        await Promise.resolve();
        tx.insert(items).values({ id: 'b', value: 'after await' }).run();
      }),
    ).toThrow('must be synchronous');
    await Promise.resolve();
    await Promise.resolve();
    expect(f.rows()).toEqual([]);
    expect(f.snapshots).toEqual([]);
  });

  it('invalidates query builders captured by rejected async callbacks', async () => {
    const f = fixture();
    expect(() =>
      f.db.transaction(async (tx) => {
        const query = tx.insert(items).values({ id: 'a', value: 'late' });
        await Promise.resolve();
        await query;
      }),
    ).toThrow('must be synchronous');
    await Promise.resolve();
    await Promise.resolve();
    expect(f.rows()).toEqual([]);
    expect(f.snapshots).toEqual([]);
  });

  it('rejects async nested callbacks without leaking them into the outer transaction', async () => {
    const f = fixture();
    f.db.transaction((tx) => {
      try {
        tx.transaction(async (nested) => {
          await Promise.resolve();
          nested.insert(items).values({ id: 'b', value: 'late' }).run();
        });
      } catch {}
      tx.insert(items).values({ id: 'a', value: 'keep' }).run();
    });
    await Promise.resolve();
    expect(f.rows()).toEqual([{ id: 'a', value: 'keep', position: 0 }]);
    expect(f.snapshots).toHaveLength(1);
  });

  it('prevents switching guard mode mid-transaction and duplicate installation', () => {
    const f = fixture();
    expect(() => f.db.transaction(() => f.guard.setEnabled(false))).toThrow('during a transaction');
    expect(() => installCanonicalCommitGuard(f.db, { beforeCommit: () => {} })).toThrow(
      'already installed',
    );
    expect(f.guard.enabled).toBe(true);
  });
});
