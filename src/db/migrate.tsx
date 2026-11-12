import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator } from 'react-native';

import { StateMessage } from '@/components/state-message';
import { ThemedView } from '@/components/themed-view';
import { runPulseBootstrap } from '@/pulse/bootstrap';
import { sweepRnvtOutputs } from '@/pulse/cleanup';
import {
  commitPulseState,
  getPulseDocument,
  getPulsePersistenceStatus,
  initializePulsePersistence,
  recordPulsePersistenceFailure,
  subscribePulsePersistence,
} from '@/pulse/runtime';
import migrations from '../../drizzle/migrations';
import { db } from './client';
import { runDataMigrations, type DataMigration } from './data-migrations';
import { dropBakedEdits } from './baked-edits-migration';
import { dropDraftTokens } from './draft-token-migration';
import { legacyDraftsImport } from './legacy-migration';

/**
 * All one-shot data migrations, in execution order. APPEND new tasks at the end — never
 * remove, rename, or reorder shipped entries (see data-migrations.ts for the task rules).
 */
const DATA_MIGRATIONS: readonly DataMigration[] = [
  legacyDraftsImport,
  dropBakedEdits,
  dropDraftTokens,
];

const centered = { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 } as const;

export function MigrationGate({ children }: { children: React.ReactNode }) {
  const persistence = useSyncExternalStore(subscribePulsePersistence, getPulsePersistenceStatus);
  const started = useRef(false);

  // One-shot data migrations (file moves, transforms — e.g. the legacy Pulse ≤1.2.x draft
  // import) run after the schema migrations and before the library renders, so an updating
  // user's first frame already shows their drafts. Completed tasks are skipped instantly.
  const [dataDone, setDataDone] = useState(false);
  useEffect(() => {
    if (started.current || persistence.error) return;
    started.current = true;
    void (async () => {
      try {
        await runPulseBootstrap({
          getStatus: getPulsePersistenceStatus,
          migrateSchema: () => migrate(db, migrations),
          // Hydration/first-upgrade capture precedes destructive migrations and cleanup.
          initializePersistence: initializePulsePersistence,
          getDocument: getPulseDocument,
          commitState: commitPulseState,
          legacyMigrationIds: DATA_MIGRATIONS.map((migration) => migration.id),
          runDataMigrations: () => runDataMigrations(DATA_MIGRATIONS),
          cleanup: () => {
            const n = sweepRnvtOutputs(getPulseDocument());
            if (__DEV__ && n > 0) console.log(`[cleanup] removed ${n} stale RNVT output file(s)`);
          },
        });
        setDataDone(true);
      } catch (error) {
        recordPulsePersistenceFailure(error);
      }
    })();
  }, [persistence.error]);

  // The raw error goes to the log, not the screen: a SQLite message means nothing to the person,
  // and what they can do about it is the same whatever it says.
  useEffect(() => {
    if (persistence.error) console.error('[pulse] recovery failed', persistence.error);
  }, [persistence.error]);

  if (persistence.error) {
    return (
      <ThemedView style={centered}>
        <StateMessage
          icon="exclamationmark.triangle.fill"
          tone="accent"
          title="Couldn’t open your drafts"
          message="Your saved Pulse files were left intact. Free storage if needed, then close Pulse and open it again to retry recovery."
        />
      </ThemedView>
    );
  }

  if (!persistence.ready || !dataDone) {
    return (
      <ThemedView style={centered}>
        <ActivityIndicator />
      </ThemedView>
    );
  }

  return <>{children}</>;
}
