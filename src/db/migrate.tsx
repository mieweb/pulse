import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator } from 'react-native';
import { Directory, File } from 'expo-file-system';

import { PrimaryButton } from '@/components/primary-button';
import { StateMessage } from '@/components/state-message';
import { libraryProblem } from '@/core/recovery/problem';
import { RecoveryScreen } from '@/core/recovery/screen';
import type { LibraryProblem, PulseMode } from '@/core/recovery/types';
import { formatDateTime } from '@/utils/relative-date';
import migrations from '../../drizzle/migrations';
import { db, expoDb, library, guardNewerSchema } from './client';
import { dropHeldFiles } from './held-files';
import { referencedMediaPaths } from './media-refs';
import { runDataMigrations, type DataMigration } from './data-migrations';
import { dropBakedEdits } from './baked-edits-migration';
import { dropDraftTokens } from './draft-token-migration';
import { legacyDraftsImport } from './legacy-migration';
import { cacheDir, documentDir } from '@/utils/storage-root';

/**
 * All one-shot data migrations, in execution order. APPEND new tasks at the end — never
 * remove, rename, or reorder shipped entries (see data-migrations.ts for the task rules).
 */
const DATA_MIGRATIONS: readonly DataMigration[] = [
  legacyDraftsImport,
  dropBakedEdits,
  dropDraftTokens,
];

/**
 * The tasks a mode runs. The embed skips the legacy import: it reads the Pulse ≤1.2.x app's
 * async-storage, which an embedded library never had (B6). Skipped, it isn't marked done.
 */
function dataMigrationsFor(mode: PulseMode): readonly DataMigration[] {
  return mode === 'embedded'
    ? DATA_MIGRATIONS.filter((m) => m !== legacyDraftsImport)
    : DATA_MIGRATIONS;
}

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
  for (const dir of [documentDir(), cacheDir()]) {
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

/**
 * Once per runtime, not per mount. The Pulse app mounts one gate per launch, but each embedded
 * presentation mounts its own on the runtime the last one used: the migrations ran there already,
 * and the library's launch notice was already seen. A failed run isn't kept, so the next mount
 * tries again (space freed, say).
 */
let migration: Promise<void> | null = null;
let migrated = false;
let noticeSeen = false;

/** The gate's once-per-runtime run (exported for tests). */
export function runMigrations(mode: PulseMode, afterMigrations?: () => void): Promise<void> {
  // An embedded library a newer PulseKit migrated has nothing run on it: no migrations, data
  // migrations or housekeeping (written for this build's schema, not the newer one). It still
  // lists, sends and deletes; editing is refused (`guardNewerSchema`).
  if (!migration && guardNewerSchema(mode)) {
    migrated = true;
    migration = Promise.resolve();
  }
  migration ??= migrate(db, migrations)
    .then(async () => {
      await runDataMigrations(dataMigrationsFor(mode));
      try {
        afterMigrations?.();
      } catch (e) {
        console.warn('[cleanup] after-migrations housekeeping failed', e);
      }
      // Clips undone out of a draft when Pulse last closed, their redo gone with it. A library
      // recovered or restored this launch only forgets the list: its rows may not be the ones
      // the list was written against.
      try {
        const fresh = library.recoveredFrom == null && !library.restored;
        const held = dropHeldFiles(fresh ? referencedMediaPaths(expoDb) : null);
        if (held > 0) console.log(`[cleanup] removed ${held} undone clip file(s)`);
      } catch (e) {
        console.warn('[cleanup] undone clips sweep failed', e); // costs space, not data
      }
      // react-native-video-trim leftovers: nothing of this version is writing them. Only the
      // Pulse app ever ran RNVT, so the embed has none to sweep (B6).
      if (mode === 'standalone') {
        try {
          const rnvt = sweepRnvtOutputs(referencedMediaPaths(expoDb));
          if (rnvt > 0) console.log(`[cleanup] removed ${rnvt} RNVT file(s)`);
        } catch (e) {
          console.warn('[cleanup] RNVT sweep failed', e); // a leftover file costs space, not data
        }
      }
      migrated = true;
    })
    .catch((e: unknown) => {
      migration = null;
      throw e;
    });
  return migration;
}

type MigrationGateProps = {
  mode: PulseMode;
  /**
   * Shown instead of the library when it failed its check and couldn't be recovered, or a
   * migration failed: the shell's recovery screen (src/core/recovery), told which it was.
   */
  recovery: (problem: LibraryProblem) => ReactNode;
  /**
   * Housekeeping the shell adds after the migrations, before the library shows (the Pulse app
   * removes unzipped restores a crash left behind). A throw is logged, never fatal.
   */
  afterMigrations?: () => void;
  children: ReactNode;
};

export function MigrationGate({ mode, recovery, afterMigrations, children }: MigrationGateProps) {
  // Schema migrations (drizzle's expo-sqlite migrator), then the one-shot data migrations (file
  // moves, transforms — e.g. the legacy Pulse ≤1.2.x draft import), then the shell's housekeeping
  // and the leftover sweeps (undone clips, RNVT), all before the library renders. Nothing runs on
  // a library that failed its check and couldn't be recovered: the recovery screen shows instead.
  // No media is ever deleted for lacking a row.
  const [ready, setReady] = useState(migrated);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState(() => (noticeSeen ? null : launchNotice()));

  useEffect(() => {
    if (migrated || library.failed || library.restoreIncomplete) return;
    runMigrations(mode, afterMigrations).then(() => setReady(true), setError);
    // Once per mount: the mode and the shell's housekeeping are fixed for a shell's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The raw error goes to the log, not the screen: a SQLite message means nothing to the person,
  // and what they can do about it is the same whatever it says.
  useEffect(() => {
    if (error) console.error('[db] migrations failed', error);
  }, [error]);

  if (library.restoreIncomplete) {
    // The restored rows are live but some of their files aren't in place yet: showing the library
    // now would show drafts without their videos. The next launch retries the move.
    return (
      <RecoveryScreen>
        <StateMessage
          icon="exclamationmark.triangle.fill"
          tone="accent"
          title="Couldn’t finish restoring the backup"
          message="Some of its videos aren’t in place yet. Free up some space, then close Pulse and open it again to finish."
        />
      </RecoveryScreen>
    );
  }

  if (library.failed || error) return <>{recovery(libraryProblem(library.failed, error))}</>;

  if (notice) {
    return (
      <RecoveryScreen>
        <StateMessage
          icon={notice.icon}
          tone="accent"
          title={notice.title}
          message={notice.message}>
          <PrimaryButton
            label="Continue"
            onPress={() => {
              noticeSeen = true;
              setNotice(null);
            }}
          />
        </StateMessage>
      </RecoveryScreen>
    );
  }

  if (!ready) {
    return (
      <RecoveryScreen>
        <ActivityIndicator />
      </RecoveryScreen>
    );
  }

  return <>{children}</>;
}
