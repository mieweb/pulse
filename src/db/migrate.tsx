import { useMigrations } from 'drizzle-orm/expo-sqlite/migrator';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { cleanFiles } from 'react-native-video-trim';

import { ThemedText } from '@/components/themed-text';
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

  // Sweep RNVT's output cache once on launch — merge outputs are moved into
  // `drafts/{id}/export.mp4` (persistMergedExport) and the editor no longer writes files (edits
  // are settings), so nothing in use is live at startup. Reclaims the copies RNVT leaves behind.
  const swept = useRef(false);
  useEffect(() => {
    if (!success || swept.current) return;
    swept.current = true;
    void cleanFiles()
      .then((n) => {
        if (__DEV__ && n > 0) console.log(`[cleanup] removed ${n} stale RNVT output file(s)`);
      })
      .catch(() => {});
  }, [success]);

  if (error) {
    return (
      <ThemedView style={centered}>
        <ThemedText>Could not open database</ThemedText>
        <ThemedText themeColor="textSecondary">{error.message}</ThemedText>
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
