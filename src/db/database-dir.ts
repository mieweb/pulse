import { defaultDatabaseDirectory } from 'expo-sqlite';

import { customDocumentsPath } from '@/utils/storage-root';

/**
 * The folder holding `pulse.db` and its backups, as the plain path expo-sqlite takes: the app's
 * default, or `SQLite/` in an embedding's documents folder (see `@/utils/storage-root`).
 */
export function databaseDir(): string {
  const custom = customDocumentsPath();
  return custom ? `${custom}/SQLite` : defaultDatabaseDirectory;
}
