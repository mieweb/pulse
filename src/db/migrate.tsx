import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';

import { PrimaryButton } from '@/components/primary-button';
import { StateMessage } from '@/components/state-message';
import { ThemedView } from '@/components/themed-view';
import { removeLeftoverRestores } from '@/features/draft-transfer/library-backup';
import { formatDateTime } from '@/utils/relative-date';
import migrations from '../../drizzle/migrations';
import { db, expoDb, library } from './client';
import { referencedMediaPaths } from './media-refs';
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

type Notice = {
  icon: 'exclamationmark.triangle.fill' | 'checkmark.circle.fill';
  title: string;
  message: string;
};

/** What this launch's library open needs to tell the person, before the library shows. */
function launchNotice(): Notice | null {
  if (library.recoveredFrom != null) {
    return {
      icon: 'exclamationmark.triangle.fill',
      title: 'Pulse repaired your library',
      message: `Its database was damaged, so Pulse went back to its copy from ${formatDateTime(library.recoveredFrom)}. Changes after that are gone; your videos are still on this phone.`,
    };
  }
  if (library.restoreFailed) {
    return {
      icon: 'exclamationmark.triangle.fill',
      title: 'Couldn’t finish restoring the backup',
      message:
        'Your library is as it was before. Free up some space, then restore the backup again.',
    };
  }
  if (library.restored) {
    return {
      icon: 'checkmark.circle.fill',
      title: 'Library backup restored',
      message: 'Your drafts are now the ones in the backup.',
    };
  }
  return null;
}

export function MigrationGate({ children }: { children: React.ReactNode }) {
  // Schema migrations (drizzle's expo-sqlite migrator), then the one-shot data migrations (file
  // moves, transforms — e.g. the legacy Pulse ≤1.2.x draft import), then the RNVT leftover sweep,
  // all before the library renders. Nothing runs on a library that failed its check and couldn't
  // be recovered: the recovery screen shows instead. No media is ever deleted for lacking a row.
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState(launchNotice);
  useEffect(() => {
    if (library.failed) return;
    migrate(db, migrations)
      .then(async () => {
        await runDataMigrations(DATA_MIGRATIONS);
        // react-native-video-trim leftovers, and unzipped restores a crash left behind: nothing
        // of this version is writing either yet.
        try {
          removeLeftoverRestores();
          const rnvt = sweepRnvtOutputs(referencedMediaPaths(expoDb));
          if (rnvt > 0) console.log(`[cleanup] removed ${rnvt} RNVT file(s)`);
        } catch (e) {
          console.warn('[cleanup] RNVT sweep failed', e); // a leftover file costs space, not data
        }
      })
      .then(() => setReady(true), setError);
  }, []);

  // The raw error goes to the log, not the screen: a SQLite message means nothing to the person,
  // and what they can do about it is the same whatever it says.
  useEffect(() => {
    if (error) console.error('[db] migrations failed', error);
  }, [error]);

  if (library.failed || error) {
    return (
      <ThemedView style={centered}>
        <StateMessage
          icon="exclamationmark.triangle.fill"
          tone="accent"
          title="Couldn’t open your drafts"
          message="Free up some space, then close Pulse and open it again. Your videos are still on this phone."
        />
      </ThemedView>
    );
  }

  if (notice) {
    return (
      <ThemedView style={centered}>
        <StateMessage
          icon={notice.icon}
          tone="accent"
          title={notice.title}
          message={notice.message}>
          <PrimaryButton label="Continue" onPress={() => setNotice(null)} />
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
