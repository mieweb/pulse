import { useMigrations } from 'drizzle-orm/expo-sqlite/migrator';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';

import { StateMessage } from '@/components/state-message';
import { ThemedView } from '@/components/themed-view';
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

/** Prefix of every file react-native-video-trim, the editor older versions used, wrote (its
 * editor, trims, merges, frames). */
const RNVT_FILE_PREFIX = 'trimmedVideo';

/**
 * Delete the files react-native-video-trim left at the top of the documents and caches folders
 * in older versions, the two places it wrote to. Returns how many were removed.
 */
function sweepRnvtOutputs(): number {
  let removed = 0;
  for (const dir of [Paths.document, Paths.cache]) {
    try {
      for (const entry of new Directory(dir).list()) {
        if (entry instanceof File && entry.name.startsWith(RNVT_FILE_PREFIX)) {
          try {
            entry.delete();
            removed++;
          } catch {}
        }
      }
    } catch {}
  }
  return removed;
}

export function MigrationGate({ children }: { children: React.ReactNode }) {
  const { success, error } = useMigrations(db, migrations);

  // One-shot data migrations (file moves, transforms — e.g. the legacy Pulse ≤1.2.x draft
  // import) run after the schema migrations and before the library renders, so an updating
  // user's first frame already shows their drafts. Completed tasks are skipped instantly.
  const [dataDone, setDataDone] = useState(false);
  useEffect(() => {
    if (!success) return;
    void runDataMigrations(DATA_MIGRATIONS).finally(() => setDataDone(true));
  }, [success]);

  // Sweep the files react-native-video-trim left in older versions once on launch: nothing of
  // this version writes RNVT-named files, so none is live at startup.
  const swept = useRef(false);
  useEffect(() => {
    if (!success || swept.current) return;
    swept.current = true;
    const n = sweepRnvtOutputs();
    if (__DEV__ && n > 0) console.log(`[cleanup] removed ${n} stale RNVT output file(s)`);
  }, [success]);

  // The raw error goes to the log, not the screen: a SQLite message means nothing to the person,
  // and what they can do about it is the same whatever it says.
  useEffect(() => {
    if (error) console.error('[db] migrations failed', error);
  }, [error]);

  if (error) {
    return (
      <ThemedView style={centered}>
        <StateMessage
          icon="exclamationmark.triangle.fill"
          tone="accent"
          title="Couldn’t open your drafts"
          message="Close Pulse and open it again. Your drafts are still on this phone."
        />
      </ThemedView>
    );
  }

  if (!success || !dataDone) {
    return (
      <ThemedView style={centered}>
        <ActivityIndicator />
      </ThemedView>
    );
  }

  return <>{children}</>;
}
