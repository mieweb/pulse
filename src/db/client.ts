import { drizzle } from 'drizzle-orm/expo-sqlite';
import { deleteDatabaseSync, openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';

import {
  attachPulseProjection,
  getPulsePersistenceStatus,
  preparePulsePersistence,
  recordPulsePersistenceFailure,
} from '@/pulse/runtime';

import * as schema from './schema';

const hasCanonicalDocument = preparePulsePersistence();

function openProjection(): SQLiteDatabase {
  // Never delete the old authoritative database during first-upgrade migration. Once a
  // canonical package exists, use a separate explicitly disposable cache database.
  const name = hasCanonicalDocument ? 'pulse-cache.db' : 'pulse.db';
  let opened: SQLiteDatabase | undefined;
  try {
    if (hasCanonicalDocument && !getPulsePersistenceStatus().error) {
      // Always build a fresh index after canonical validation. A quick_check-valid but
      // structurally stale cache/journal must not prevent recovery on every relaunch.
      try {
        const previous = openDatabaseSync(name, { useNewConnection: true });
        previous.closeSync();
      } catch {
        // A malformed SQLite file can fail even to open; it is disposable here.
      }
      deleteDatabaseSync(name);
    }
    opened = openDatabaseSync(name, { enableChangeListener: true, useNewConnection: true });
    const rows = opened.getAllSync<{ quick_check: string }>('PRAGMA quick_check');
    if (rows.some((row) => row.quick_check !== 'ok'))
      throw new Error('The SQLite index is corrupt.');
    opened.execSync('PRAGMA foreign_keys = ON;');
    return opened;
  } catch (error) {
    try {
      opened?.closeSync();
    } catch {
      /* Preserve the original recovery error. */
    }
    recordPulsePersistenceFailure(error);
    // A temporary empty connection only lets the recovery screen render. It is never used
    // to seed/overwrite canonical files; readiness remains false and application UI is gated.
    try {
      return openDatabaseSync(':memory:', { enableChangeListener: true });
    } catch (memoryError) {
      const failure = new AggregateError([error, memoryError], 'SQLite is unavailable.');
      recordPulsePersistenceFailure(failure);
      const unavailable = () => {
        throw failure;
      };
      // Drizzle constructs query builders without executing them. This inert handle lets
      // MigrationGate render recovery even when the native SQLite module cannot open at all.
      // No provider or migration mounts while persistence.error is set.
      return {
        prepareSync: unavailable,
        getAllSync: unavailable,
        runSync: unavailable,
        execSync: unavailable,
      } as unknown as SQLiteDatabase;
    }
  }
}

const expoDb = openProjection();

export const db = drizzle(expoDb, { schema });
attachPulseProjection(db, expoDb);
