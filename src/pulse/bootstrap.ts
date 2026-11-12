import type { PulseDocument, PulseState } from './document';

/** Written only when capturing the pre-canonical legacy library for its initial upgrade. */
export const LEGACY_UPGRADE_PENDING_KEY = 'pulse.legacyUpgrade.pending';

export type PulseBootstrapStatus = { ready: boolean; error: unknown | null };

export type PulseBootstrapOptions = {
  getStatus: () => PulseBootstrapStatus;
  migrateSchema: () => void | Promise<void>;
  initializePersistence: () => void | Promise<void>;
  getDocument: () => PulseDocument;
  commitState: (state: PulseState) => PulseDocument | Promise<PulseDocument>;
  legacyMigrationIds: readonly string[];
  runDataMigrations: () => void | Promise<void>;
  cleanup: () => void | Promise<void>;
};

/**
 * Keep providers/jobs unmounted until every stage resolves. The Expo Drizzle migrator is
 * asynchronous even with the synchronous SQLite driver: awaiting it is a data-safety boundary.
 */
export async function runPulseBootstrap(options: PulseBootstrapOptions): Promise<void> {
  const check = (requireReady: boolean) => {
    const status = options.getStatus();
    if (status.error !== null) throw status.error;
    if (requireReady && !status.ready) throw new Error('Canonical Pulse persistence is not ready.');
  };

  check(false);
  await options.migrateSchema();
  check(false);
  await options.initializePersistence();
  check(true);
  const pending = options
    .getDocument()
    .state.settings.some((row) => row.key === LEGACY_UPGRADE_PENDING_KEY && row.value === 'true');
  if (pending) {
    await options.runDataMigrations();
    // The legacy runner swallows task errors. Canonical markers, rather than its resolved
    // Promise or missing SQL rows, prove that every initial-upgrade task completed.
    check(true);
    const completed = options.getDocument();
    const settings = new Map(completed.state.settings.map((row) => [row.key, row.value]));
    if (options.legacyMigrationIds.some((id) => settings.get(`dataMigration.${id}`) !== 'true')) {
      throw new Error('The initial Pulse upgrade is incomplete. Restart Pulse to retry safely.');
    }
    await options.commitState({
      ...completed.state,
      settings: completed.state.settings.filter((row) => row.key !== LEGACY_UPGRADE_PENDING_KEY),
    });
    check(true);
  }
  await options.cleanup();
  check(true);
}
