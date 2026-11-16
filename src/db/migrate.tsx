import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';

import { PrimaryButton } from '@/components/primary-button';
import { StateMessage } from '@/components/state-message';
import { ThemedView } from '@/components/themed-view';
import { formatDateTime } from '@/utils/relative-date';
import migrations from '../../drizzle/migrations';
import { db, expoDb, library } from './client';
import { referencedMediaPaths, sweepUnreferencedMedia } from './media-refs';
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
 * in older versions, the two places it wrote to — never one a row still references. Returns how
 * many were removed.
 */
function sweepRnvtOutputs(referenced: Set<string>): number {
  let removed = 0;
  for (const dir of [Paths.document, Paths.cache]) {
    try {
      for (const entry of new Directory(dir).list()) {
        if (
          entry instanceof File &&
          entry.name.startsWith(RNVT_FILE_PREFIX) &&
          !referenced.has(entry.name)
        ) {
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
  // Schema migrations (drizzle's expo-sqlite migrator), then the one-shot data migrations (file
  // moves, transforms — e.g. the legacy Pulse ≤1.2.x draft import), then the media sweeps, all
  // before the library renders. Nothing runs on a library that failed its check and couldn't be
  // recovered: the recovery screen shows instead, and media is left alone.
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(
    library.failed ? new Error('Unusable database') : null,
  );
  const [recovered, setRecovered] = useState(library.recoveredFrom);
  useEffect(() => {
    if (library.failed) return;
    migrate(db, migrations)
      .then(async () => {
        await runDataMigrations(DATA_MIGRATIONS);
        // Media nothing references (and react-native-video-trim leftovers): nothing of this version
        // is recording or rendering yet, so no file is mid-write.
        try {
          const swept = sweepUnreferencedMedia(expoDb, Date.now());
          const rnvt = sweepRnvtOutputs(referencedMediaPaths(expoDb));
          console.log(`[cleanup] removed ${swept} unreferenced and ${rnvt} RNVT file(s)`);
        } catch (e) {
          console.warn('[cleanup] media sweep failed', e); // a leftover file costs space, not data
        }
      })
      .then(() => setReady(true), setError);
  }, []);

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

  if (recovered != null) {
    return (
      <ThemedView style={centered}>
        <StateMessage
          icon="exclamationmark.triangle.fill"
          tone="accent"
          title="Your drafts were restored"
          message={`Pulse’s database was damaged, so it went back to its copy from ${formatDateTime(recovered)}. Changes after that are gone; your videos are kept.`}>
          <PrimaryButton label="Continue" onPress={() => setRecovered(null)} />
        </StateMessage>
      </ThemedView>
    );
  }

  if (!ready) {
    return (
      <ThemedView style={centered}>
        <ActivityIndicator />
      </ThemedView>
    );
  }

  return <>{children}</>;
}
