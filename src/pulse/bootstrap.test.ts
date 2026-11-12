import { describe, expect, it, jest } from '@jest/globals';

import {
  LEGACY_UPGRADE_PENDING_KEY,
  runPulseBootstrap,
  type PulseBootstrapOptions,
  type PulseBootstrapStatus,
} from './bootstrap';
import { emptyPulseState, type PulseDocument } from './document';

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const events: string[] = [];
  const status: PulseBootstrapStatus = { ready: false, error: null };
  const legacyMigrationIds = ['legacy-import', 'baked-edits'];
  let document: PulseDocument = {
    format: 'pulse-document',
    version: 2,
    scope: 'library',
    revision: 1,
    state: { ...emptyPulseState(), settings: [{ key: LEGACY_UPGRADE_PENDING_KEY, value: 'true' }] },
    assets: [],
  };
  const completeMigrations = () => {
    for (const id of legacyMigrationIds) {
      const key = `dataMigration.${id}`;
      document.state.settings = document.state.settings.filter((row) => row.key !== key);
      document.state.settings.push({ key, value: 'true' });
    }
  };
  const options = {
    getStatus: () => status,
    migrateSchema: jest.fn<PulseBootstrapOptions['migrateSchema']>(() => {
      events.push('schema');
    }),
    initializePersistence: jest.fn<PulseBootstrapOptions['initializePersistence']>(() => {
      events.push('canonical initialization');
      status.ready = true;
    }),
    getDocument: () => document,
    commitState: jest.fn<PulseBootstrapOptions['commitState']>((state) => {
      document = { ...document, state, revision: document.revision + 1 };
      events.push('complete legacy upgrade');
      return document;
    }),
    legacyMigrationIds,
    runDataMigrations: jest.fn<PulseBootstrapOptions['runDataMigrations']>(() => {
      events.push('data migrations');
      completeMigrations();
    }),
    cleanup: jest.fn<PulseBootstrapOptions['cleanup']>(() => {
      events.push('cleanup');
    }),
  };
  return {
    options,
    status,
    events,
    completeMigrations,
    startJobs: jest.fn(),
    setDocument(next: PulseDocument) {
      document = next;
    },
  };
}

describe('Pulse bootstrap sequencing', () => {
  it('awaits asynchronous schema completion before canonical initialization, then awaits data migrations before cleanup and jobs', async () => {
    const f = fixture();
    const schema = deferred();
    const data = deferred();
    f.options.migrateSchema.mockImplementation(async () => {
      f.events.push('schema started');
      await schema.promise;
      f.events.push('schema complete');
    });
    f.options.initializePersistence.mockImplementation(() => {
      expect(f.events).toContain('schema complete');
      f.events.push('canonical initialization');
      f.status.ready = true;
    });
    f.options.runDataMigrations.mockImplementation(async () => {
      f.events.push('data migrations started');
      await data.promise;
      f.events.push('data migrations complete');
      f.completeMigrations();
    });
    const bootstrap = runPulseBootstrap(f.options).then(f.startJobs);
    await Promise.resolve();
    expect(f.events).toEqual(['schema started']);
    expect(f.options.initializePersistence).not.toHaveBeenCalled();
    expect(f.options.runDataMigrations).not.toHaveBeenCalled();
    expect(f.options.cleanup).not.toHaveBeenCalled();
    expect(f.startJobs).not.toHaveBeenCalled();
    schema.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.options.initializePersistence).toHaveBeenCalledTimes(1);
    expect(f.options.runDataMigrations).toHaveBeenCalledTimes(1);
    expect(f.options.cleanup).not.toHaveBeenCalled();
    expect(f.startJobs).not.toHaveBeenCalled();
    data.resolve();
    await bootstrap;
    expect(f.events).toEqual([
      'schema started',
      'schema complete',
      'canonical initialization',
      'data migrations started',
      'data migrations complete',
      'complete legacy upgrade',
      'cleanup',
    ]);
    expect(f.startJobs).toHaveBeenCalledTimes(1);
  });

  it('does not begin schema migration or any later stage after a canonical load error', async () => {
    const f = fixture();
    const cause = new Error('corrupt canonical YAML/media');
    f.status.error = cause;
    await expect(runPulseBootstrap(f.options).then(f.startJobs)).rejects.toBe(cause);
    expect(f.events).toEqual([]);
    expect(f.options.initializePersistence).not.toHaveBeenCalled();
    expect(f.startJobs).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject'] as const)(
    'stops after a schema migration %s without initializing canonical storage or running cleanup/jobs',
    async (failure) => {
      const f = fixture();
      const cause = new Error('schema migration failed');
      f.options.migrateSchema.mockImplementation(() => {
        if (failure === 'throw') throw cause;
        return Promise.reject(cause);
      });
      await expect(runPulseBootstrap(f.options).then(f.startJobs)).rejects.toBe(cause);
      expect(f.options.initializePersistence).not.toHaveBeenCalled();
      expect(f.options.runDataMigrations).not.toHaveBeenCalled();
      expect(f.options.cleanup).not.toHaveBeenCalled();
      expect(f.startJobs).not.toHaveBeenCalled();
    },
  );

  it('rechecks canonical failure after an asynchronous schema migration resolves', async () => {
    const f = fixture();
    const schema = deferred();
    const cause = new Error('canonical failure while schema migration was pending');
    f.options.migrateSchema.mockReturnValue(schema.promise);
    const result = runPulseBootstrap(f.options).then(f.startJobs);
    f.status.error = cause;
    schema.resolve();
    await expect(result).rejects.toBe(cause);
    expect(f.options.initializePersistence).not.toHaveBeenCalled();
    expect(f.options.runDataMigrations).not.toHaveBeenCalled();
    expect(f.options.cleanup).not.toHaveBeenCalled();
    expect(f.startJobs).not.toHaveBeenCalled();
  });

  it('never advances after canonical initialization throws', async () => {
    const f = fixture();
    const cause = new Error('source media cannot be verified');
    f.options.initializePersistence.mockImplementation(() => {
      throw cause;
    });
    await expect(runPulseBootstrap(f.options).then(f.startJobs)).rejects.toBe(cause);
    expect(f.options.migrateSchema).toHaveBeenCalledTimes(1);
    expect(f.options.runDataMigrations).not.toHaveBeenCalled();
    expect(f.options.cleanup).not.toHaveBeenCalled();
    expect(f.startJobs).not.toHaveBeenCalled();
  });

  it('requires canonical initialization to establish readiness before data migrations', async () => {
    const f = fixture();
    f.options.initializePersistence.mockImplementation(() => {});
    await expect(runPulseBootstrap(f.options).then(f.startJobs)).rejects.toThrow('not ready');
    expect(f.options.runDataMigrations).not.toHaveBeenCalled();
    expect(f.options.cleanup).not.toHaveBeenCalled();
    expect(f.startJobs).not.toHaveBeenCalled();
  });

  it('stops if initialization records a canonical failure without throwing', async () => {
    const f = fixture();
    const cause = new Error('recorded index rebuild failure');
    f.options.initializePersistence.mockImplementation(() => {
      f.status.error = cause;
    });
    await expect(runPulseBootstrap(f.options).then(f.startJobs)).rejects.toBe(cause);
    expect(f.options.runDataMigrations).not.toHaveBeenCalled();
    expect(f.options.cleanup).not.toHaveBeenCalled();
    expect(f.startJobs).not.toHaveBeenCalled();
  });

  it('does not clean up or start jobs after a data migration rejects', async () => {
    const f = fixture();
    const cause = new Error('canonical commit failed');
    f.options.runDataMigrations.mockImplementation(() => Promise.reject(cause));
    await expect(runPulseBootstrap(f.options).then(f.startJobs)).rejects.toBe(cause);
    expect(f.options.cleanup).not.toHaveBeenCalled();
    expect(f.startJobs).not.toHaveBeenCalled();
  });

  it('blocks cleanup/jobs when the data migration runner swallowed a poisoned-cache failure', async () => {
    const f = fixture();
    const cause = new Error('SQLite commit and rollback failed');
    f.options.runDataMigrations.mockImplementation(async () => {
      await Promise.resolve();
      // Mirrors runtime.onProjectionFailure, even though runDataMigrations returns normally.
      f.status.ready = false;
      f.status.error = cause;
    });
    await expect(runPulseBootstrap(f.options).then(f.startJobs)).rejects.toBe(cause);
    expect(f.options.cleanup).not.toHaveBeenCalled();
    expect(f.startJobs).not.toHaveBeenCalled();
  });

  it('blocks cleanup/jobs if data migrations lose readiness without providing an error', async () => {
    const f = fixture();
    f.options.runDataMigrations.mockImplementation(() => {
      f.status.ready = false;
    });
    await expect(runPulseBootstrap(f.options).then(f.startJobs)).rejects.toThrow('not ready');
    expect(f.options.cleanup).not.toHaveBeenCalled();
    expect(f.startJobs).not.toHaveBeenCalled();
  });

  it('awaits cleanup and rechecks persistence before allowing application jobs to start', async () => {
    const f = fixture();
    const cleanup = deferred();
    const cause = new Error('persistence failed during cleanup');
    f.options.cleanup.mockReturnValue(cleanup.promise);
    const result = runPulseBootstrap(f.options).then(f.startJobs);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.options.cleanup).toHaveBeenCalledTimes(1);
    expect(f.startJobs).not.toHaveBeenCalled();
    f.status.error = cause;
    cleanup.resolve();
    await expect(result).rejects.toBe(cause);
    expect(f.startJobs).not.toHaveBeenCalled();
  });

  it('does not transform a restored canonical document or add migration markers when no initial-upgrade marker exists', async () => {
    const f = fixture();
    const document = f.options.getDocument();
    document.state.settings = [{ key: 'appearance.theme', value: 'dark' }];
    const before = JSON.stringify(document);
    f.setDocument(document);
    f.options.runDataMigrations.mockImplementation(() => {
      throw new Error('historical transformations must not run');
    });
    await runPulseBootstrap(f.options).then(f.startJobs);
    expect(f.options.runDataMigrations).not.toHaveBeenCalled();
    expect(f.options.commitState).not.toHaveBeenCalled();
    expect(JSON.stringify(f.options.getDocument())).toBe(before);
    expect(f.options.cleanup).toHaveBeenCalledTimes(1);
    expect(f.startJobs).toHaveBeenCalledTimes(1);
  });

  it('retains the durable pending marker and gates cleanup/jobs when an initial-upgrade task error was swallowed', async () => {
    const f = fixture();
    f.options.runDataMigrations.mockImplementation(() => {
      f.options
        .getDocument()
        .state.settings.push({ key: 'dataMigration.legacy-import', value: 'true' });
      // The second task failed and the legacy runner returned normally without its marker.
    });
    await expect(runPulseBootstrap(f.options).then(f.startJobs)).rejects.toThrow(
      'upgrade is incomplete',
    );
    expect(f.options.getDocument().state.settings).toContainEqual({
      key: LEGACY_UPGRADE_PENDING_KEY,
      value: 'true',
    });
    expect(f.options.commitState).not.toHaveBeenCalled();
    expect(f.options.cleanup).not.toHaveBeenCalled();
    expect(f.startJobs).not.toHaveBeenCalled();
    f.options.runDataMigrations.mockImplementation(() => {
      f.completeMigrations();
    });
    // A subsequent launch reads the same durable marker and resumes the runner.
    await runPulseBootstrap(f.options).then(f.startJobs);
    expect(f.options.runDataMigrations).toHaveBeenCalledTimes(2);
    expect(
      f.options.getDocument().state.settings.some((row) => row.key === LEGACY_UPGRADE_PENDING_KEY),
    ).toBe(false);
    expect(f.options.cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not clear pending or start cleanup/jobs when its final canonical publication fails', async () => {
    const f = fixture();
    const cause = new Error('pending completion publication failed');
    f.options.commitState.mockImplementation(() => {
      throw cause;
    });
    await expect(runPulseBootstrap(f.options).then(f.startJobs)).rejects.toBe(cause);
    expect(f.options.getDocument().state.settings).toContainEqual({
      key: LEGACY_UPGRADE_PENDING_KEY,
      value: 'true',
    });
    expect(f.options.cleanup).not.toHaveBeenCalled();
    expect(f.startJobs).not.toHaveBeenCalled();
  });
});
