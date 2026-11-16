// A `node:sqlite` stand-in for the parts of expo-sqlite Pulse uses — enough for drizzle's
// expo-sqlite driver and migrator to run on it — for Jest:
// `jest.mock('expo-sqlite', () => require('@/test-support/expo-sqlite-node'))`.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

import { env } from './expo-fs-node';

const params = (list: unknown[]): SQLInputValue[] => {
  const flat = list.length === 1 && Array.isArray(list[0]) ? list[0] : list;
  return flat.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
};

class Statement {
  constructor(private s: StatementSync) {}
  executeSync(values: unknown[] = []) {
    if (this.s.columns().length > 0) {
      const rows = this.s.all(...params([values]));
      return {
        changes: 0,
        lastInsertRowId: 0,
        getAllSync: () => rows,
        getFirstSync: () => rows[0],
      };
    }
    const r = this.s.run(...params([values]));
    const result = { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    return { ...result, getAllSync: () => [], getFirstSync: () => null };
  }
  executeForRawResultSync(values: unknown[] = []) {
    this.s.setReturnArrays(true);
    try {
      const rows = this.s.all(...params([values]));
      return { getAllSync: () => rows };
    } finally {
      this.s.setReturnArrays(false);
    }
  }
  finalizeSync() {}
}

export class SQLiteDatabase {
  node: DatabaseSync;
  constructor(public databasePath: string) {
    this.node = new DatabaseSync(databasePath);
  }
  prepareSync(sql: string) {
    return new Statement(this.node.prepare(sql));
  }
  execSync(sql: string) {
    this.node.exec(sql);
  }
  getAllSync(sql: string, ...values: unknown[]) {
    return this.node.prepare(sql).all(...params(values));
  }
  getFirstSync(sql: string, ...values: unknown[]) {
    return this.node.prepare(sql).get(...params(values)) ?? null;
  }
  runSync(sql: string, ...values: unknown[]) {
    const r = this.node.prepare(sql).run(...params(values));
    return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
  }
  withTransactionSync(task: () => void) {
    this.node.exec('BEGIN');
    try {
      task();
      this.node.exec('COMMIT');
    } catch (e) {
      this.node.exec('ROLLBACK');
      throw e;
    }
  }
  closeSync() {
    this.node.close();
  }
}

export function openDatabaseSync(name: string, _options?: object, directory?: string) {
  const dir = directory ?? env.dbDir;
  mkdirSync(dir, { recursive: true });
  return new SQLiteDatabase(name === ':memory:' ? name : join(dir, name));
}

/**
 * expo-sqlite's backupDatabaseSync is SQLite's online backup API (sqlite3_backup_step(-1)).
 * node:sqlite only offers it async, so it runs to completion in a child process here.
 */
export function backupDatabaseSync(opts: {
  sourceDatabase: SQLiteDatabase;
  destDatabase: SQLiteDatabase;
}) {
  const script =
    "const s=require('node:sqlite');s.backup(new s.DatabaseSync(process.argv[1]),process.argv[2])" +
    '.catch((e)=>{console.error(e.message);process.exit(1)})';
  execFileSync(
    process.execPath,
    ['-e', script, opts.sourceDatabase.databasePath, opts.destDatabase.databasePath],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
}

/** What `jest.mock('expo-sqlite', …)` returns: `defaultDatabaseDirectory` follows `env.dbDir`. */
export const mockModule = {
  SQLiteDatabase,
  openDatabaseSync,
  backupDatabaseSync,
  get defaultDatabaseDirectory() {
    return env.dbDir;
  },
};
