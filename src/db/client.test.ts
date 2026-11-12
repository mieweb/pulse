import { describe, expect, it, jest } from '@jest/globals';
import type { SQLiteDatabase } from 'expo-sqlite';

jest.mock('expo-sqlite', () => ({ openDatabaseSync: jest.fn(), deleteDatabaseSync: jest.fn() }));
jest.mock('drizzle-orm/expo-sqlite', () => ({ drizzle: jest.fn() }));
jest.mock('./schema', () => ({ __esModule: true }));
jest.mock('@/pulse/runtime', () => ({
  preparePulsePersistence: jest.fn(),
  getPulsePersistenceStatus: jest.fn(),
  recordPulsePersistenceFailure: jest.fn(),
  attachPulseProjection: jest.fn(),
}));

type Connection = {
  name: string;
  closeSync: jest.Mock<() => void>;
  getAllSync: jest.Mock<() => { quick_check: string }[]>;
  execSync: jest.Mock<(sql: string) => void>;
};

function harness(canonical: boolean, initialError: unknown = null) {
  jest.resetModules();
  const events: string[] = [];
  let error = initialError;
  const native = jest.requireMock('expo-sqlite') as {
    openDatabaseSync: jest.Mock<(name: string, options?: unknown) => Connection>;
    deleteDatabaseSync: jest.Mock<(name: string) => void>;
  };
  const driver = jest.requireMock('drizzle-orm/expo-sqlite') as {
    drizzle: jest.Mock<(connection: unknown, options?: unknown) => object>;
  };
  const runtime = jest.requireMock('@/pulse/runtime') as {
    preparePulsePersistence: jest.Mock<() => boolean>;
    getPulsePersistenceStatus: jest.Mock<() => { ready: boolean; error: unknown }>;
    recordPulsePersistenceFailure: jest.Mock<(cause: unknown) => void>;
    attachPulseProjection: jest.Mock<(db: object, connection: unknown) => void>;
  };
  runtime.preparePulsePersistence.mockImplementation(() => {
    events.push('validate canonical');
    return canonical;
  });
  runtime.getPulsePersistenceStatus.mockImplementation(() => ({ ready: false, error }));
  runtime.recordPulsePersistenceFailure.mockImplementation((cause) => {
    error = cause;
    events.push('record failure');
  });
  const connections: Connection[] = [];
  const connection = (name: string): Connection => ({
    name,
    closeSync: jest.fn(() => {
      events.push(`close ${name}`);
    }),
    getAllSync: jest.fn(() => [{ quick_check: 'ok' }]),
    execSync: jest.fn(),
  });
  native.openDatabaseSync.mockImplementation((name) => {
    events.push(`open ${name}`);
    const opened = connection(name);
    connections.push(opened);
    return opened;
  });
  native.deleteDatabaseSync.mockImplementation((name) => {
    events.push(`delete ${name}`);
  });
  driver.drizzle.mockImplementation(() => {
    events.push('construct drizzle');
    return {};
  });
  runtime.attachPulseProjection.mockImplementation(() => {
    events.push('attach guard');
  });
  return {
    native,
    driver,
    runtime,
    connections,
    connection,
    events,
    load() {
      let client: typeof import('./client') | undefined;
      jest.isolateModules(() => {
        client = jest.requireActual<typeof import('./client')>('./client');
      });
      return client!;
    },
  };
}

describe('Pulse index startup authority boundary', () => {
  it('retains the original database on first migration and validates canonical storage before opening SQL', () => {
    const f = harness(false);
    f.load();
    expect(f.native.openDatabaseSync).toHaveBeenCalledTimes(1);
    expect(f.native.openDatabaseSync).toHaveBeenCalledWith('pulse.db', {
      enableChangeListener: true,
      useNewConnection: true,
    });
    expect(f.native.deleteDatabaseSync).not.toHaveBeenCalled();
    expect(f.events).toEqual([
      'validate canonical',
      'open pulse.db',
      'construct drizzle',
      'attach guard',
    ]);
    expect(f.runtime.attachPulseProjection).toHaveBeenCalledWith(
      expect.any(Object),
      f.connections[0],
    );
  });

  it('closes and discards only the disposable cache after canonical validation, then attaches the fresh index', () => {
    const f = harness(true);
    f.load();
    expect(f.events).toEqual([
      'validate canonical',
      'open pulse-cache.db',
      'close pulse-cache.db',
      'delete pulse-cache.db',
      'open pulse-cache.db',
      'construct drizzle',
      'attach guard',
    ]);
    expect(f.native.deleteDatabaseSync).toHaveBeenCalledTimes(1);
    expect(f.native.deleteDatabaseSync).toHaveBeenCalledWith('pulse-cache.db');
    expect(f.driver.drizzle).toHaveBeenCalledWith(f.connections[1], { schema: expect.any(Object) });
    expect(f.connections[1].execSync).toHaveBeenCalledWith('PRAGMA foreign_keys = ON;');
  });

  it.each([false, true])(
    'does not delete any database after canonical validation has failed (canonical flag %s)',
    (canonical) => {
      const failure = new Error('damaged committed YAML or media');
      const f = harness(canonical, failure);
      f.load();
      expect(f.native.deleteDatabaseSync).not.toHaveBeenCalled();
      expect(f.runtime.getPulsePersistenceStatus().error).toBe(failure);
    },
  );

  it('recreates a cache that cannot even be opened, while retaining the legacy database', () => {
    const f = harness(true);
    f.native.openDatabaseSync.mockImplementationOnce(() => {
      throw new Error('corrupt cache');
    });
    expect(() => f.load()).not.toThrow();
    expect(f.native.deleteDatabaseSync).toHaveBeenCalledWith('pulse-cache.db');
    expect(f.native.deleteDatabaseSync).not.toHaveBeenCalledWith('pulse.db');
    expect(f.runtime.recordPulsePersistenceFailure).not.toHaveBeenCalled();
  });

  it('enters recovery without deleting a corrupt legacy authority', () => {
    const f = harness(false);
    const legacy = f.connection('pulse.db');
    legacy.getAllSync.mockReturnValue([{ quick_check: 'database damaged' }]);
    f.native.openDatabaseSync.mockReturnValueOnce(legacy);
    expect(() => f.load()).not.toThrow();
    expect(legacy.closeSync).toHaveBeenCalledTimes(1);
    expect(f.native.deleteDatabaseSync).not.toHaveBeenCalled();
    expect(f.runtime.recordPulsePersistenceFailure).toHaveBeenCalledTimes(1);
    expect(f.native.openDatabaseSync).toHaveBeenLastCalledWith(':memory:', {
      enableChangeListener: true,
    });
    expect(f.runtime.getPulsePersistenceStatus().error).toBeInstanceOf(Error);
  });

  it('enters recovery when a new cache cannot open after deletion', () => {
    const f = harness(true);
    f.native.openDatabaseSync.mockReturnValueOnce(f.connection('previous cache'));
    const failure = new Error('new cache open failed');
    f.native.openDatabaseSync.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => f.load()).not.toThrow();
    expect(f.runtime.recordPulsePersistenceFailure).toHaveBeenCalledWith(failure);
    expect(f.native.openDatabaseSync).toHaveBeenLastCalledWith(':memory:', {
      enableChangeListener: true,
    });
    expect(f.native.deleteDatabaseSync).toHaveBeenCalledWith('pulse-cache.db');
  });

  it('enters recovery if disposable cache deletion fails, without retrying or deleting legacy data', () => {
    const f = harness(true);
    const failure = new Error('cache file permission failure');
    f.native.deleteDatabaseSync.mockImplementation(() => {
      throw failure;
    });
    expect(() => f.load()).not.toThrow();
    expect(f.runtime.recordPulsePersistenceFailure).toHaveBeenCalledWith(failure);
    expect(f.native.openDatabaseSync).toHaveBeenLastCalledWith(':memory:', {
      enableChangeListener: true,
    });
    expect(f.native.deleteDatabaseSync.mock.calls).toEqual([['pulse-cache.db']]);
  });

  it('keeps module initialization inside the recovery gate even when both disk and memory SQLite opens fail', () => {
    const f = harness(false);
    const failure = new Error('native SQLite unavailable');
    f.native.openDatabaseSync.mockImplementation(() => {
      throw failure;
    });
    expect(() => f.load()).not.toThrow();
    expect(f.native.deleteDatabaseSync).not.toHaveBeenCalled();
    expect(f.runtime.recordPulsePersistenceFailure).toHaveBeenCalled();
    expect(f.runtime.getPulsePersistenceStatus().error).toBeTruthy();
    const unavailable = f.driver.drizzle.mock.calls[0][0] as {
      prepareSync: () => unknown;
      getAllSync: () => unknown;
      runSync: () => unknown;
      execSync: () => unknown;
    };
    for (const operation of ['prepareSync', 'getAllSync', 'runSync', 'execSync'] as const) {
      expect(() => unavailable[operation]()).toThrow('SQLite is unavailable.');
    }
  });

  it('can construct the real Drizzle driver and disabled canonical guard around an unavailable handle without pretending a query succeeded', () => {
    const f = harness(false);
    f.native.openDatabaseSync.mockImplementation(() => {
      throw new Error('native SQLite unavailable');
    });
    const actualDriver =
      jest.requireActual<typeof import('drizzle-orm/expo-sqlite')>('drizzle-orm/expo-sqlite');
    const { sql } = jest.requireActual<typeof import('drizzle-orm')>('drizzle-orm');
    const { installCanonicalCommitGuard } =
      jest.requireActual<typeof import('@/pulse/sqlite-guard')>('@/pulse/sqlite-guard');
    f.driver.drizzle.mockImplementation((connection) =>
      actualDriver.drizzle(connection as SQLiteDatabase),
    );
    f.runtime.attachPulseProjection.mockImplementation((database) => {
      const guard = installCanonicalCommitGuard(database, {
        isReady: () => false,
        beforeCommit: () => {
          throw new Error('canonical storage must remain untouched');
        },
      });
      guard.setEnabled(false);
      expect(guard.enabled).toBe(false);
    });
    let client: typeof import('./client') | undefined;
    expect(() => {
      client = f.load();
    }).not.toThrow();
    expect(f.runtime.attachPulseProjection).toHaveBeenCalledTimes(1);
    expect(() => client!.db.all(sql.raw('SELECT 1'))).toThrow('SQLite is unavailable.');
    expect(() => client!.db.run(sql.raw('DELETE FROM drafts'))).toThrow();
    expect(f.native.deleteDatabaseSync).not.toHaveBeenCalled();
  });
});
