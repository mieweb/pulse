/**
 * One commit boundary for the synchronous Drizzle Expo driver. Application writes, including
 * RETURNING queries and nested transactions, must make their pending state canonical before
 * SQLite commits. The raw native client remains private to bootstrap/rebuild code.
 */
export type CanonicalCommitGuardOptions = {
  /** Must finish synchronously or throw. It may read pending rows through the guarded db. */
  beforeCommit: () => void;
  /** Report a broken index; canonicalCommitted distinguishes saved writes from failed saves. */
  onProjectionFailure?: (error: CanonicalProjectionFailure) => void;
  isReady?: () => boolean;
};

export class CanonicalProjectionCommitError extends Error {
  readonly canonicalCommitted = true;

  constructor(cause: unknown) {
    super('Canonical save succeeded, but the SQLite projection could not commit.', { cause });
    this.name = 'CanonicalProjectionCommitError';
  }
}

export class CanonicalProjectionRollbackError extends Error {
  readonly canonicalCommitted = false;

  constructor(cause: unknown) {
    super('The failed SQLite operation could not roll back its projection.', { cause });
    this.name = 'CanonicalProjectionRollbackError';
  }
}

export type CanonicalProjectionFailure =
  CanonicalProjectionCommitError | CanonicalProjectionRollbackError;

export type CanonicalCommitGuard = {
  readonly enabled: boolean;
  readonly poisoned: boolean;
  readonly failure: CanonicalProjectionFailure | null;
  /** Only change outside a transaction. Disabled mode is for controlled bootstrap/rehydration. */
  setEnabled: (enabled: boolean) => void;
  /** Call only after successful rehydration, while disabled and outside a transaction. */
  clearPoison: () => void;
};

const EXECUTE_METHODS = ['run', 'all', 'get', 'values'] as const;
type ExecuteMethod = (typeof EXECUTE_METHODS)[number];
type Execute = (...args: unknown[]) => unknown;
type Prepared = Record<ExecuteMethod, Execute>;
type Session = {
  prepareQuery: (...args: unknown[]) => Prepared;
  transaction: (callback: (tx: object) => unknown, ...args: unknown[]) => unknown;
};
type Frame = { name: string | null; dirty: boolean };

/** Tokens outside parentheses, ignoring SQL strings/comments but retaining quoted names. */
function rootTokens(sql: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  for (let i = 0; i < sql.length;) {
    if (/\s/.test(sql[i])) {
      i++;
    } else if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (['"', "'", '`', '['].includes(sql[i])) {
      const quote = sql[i++];
      const close = quote === '[' ? ']' : quote;
      let value = '';
      while (i < sql.length) {
        const c = sql[i++];
        if (c !== close) value += c;
        else if (sql[i] === close) {
          value += close;
          i++;
        } else break;
      }
      // Quoted identifiers/literals must never be mistaken for SQL verbs (a CTE can be
      // named "select" while its actual outer statement is INSERT).
      if (depth === 0) tokens.push('\0' + value.toLowerCase());
    } else if (sql[i] === '(') {
      depth++;
      i++;
    } else if (sql[i] === ')') {
      depth--;
      i++;
    } else {
      const word = /^[a-z_][a-z_0-9$]*/i.exec(sql.slice(i));
      if (word) {
        if (depth === 0) tokens.push(word[0].toLowerCase());
        i += word[0].length;
      } else {
        if (depth === 0 && sql[i] === '=') tokens.push('=');
        i++;
      }
    }
  }
  return tokens;
}

function isRead(tokens: string[]): boolean {
  let first = tokens[0];
  if (first === 'with') {
    first =
      tokens
        .slice(1)
        .find((t) => ['select', 'insert', 'update', 'delete', 'replace'].includes(t)) ?? '';
  }
  if (['select', 'explain', 'values'].includes(first)) return true;
  if (first !== 'pragma' || tokens.includes('=')) return false;
  const name = ['main', 'temp'].includes(tokens[1]) ? tokens[2] : tokens[1];
  return [
    'table_info',
    'table_xinfo',
    'table_list',
    'index_list',
    'index_info',
    'index_xinfo',
    'foreign_key_list',
    'foreign_key_check',
    'integrity_check',
    'quick_check',
    'data_version',
  ].includes(name);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

const savepointName = (token: string | undefined) => token?.replace(/^\0/, '') ?? '';

function rejectAsync(value: unknown): void {
  if (!isThenable(value)) return;
  // Async functions may resume after rejection. Their leased transaction handle is closed below;
  // absorb that rejected continuation, without executing arbitrary query-builder thenables.
  if (value instanceof Promise) void value.catch(() => {});
  throw new Error('Canonical SQLite transactions and commit callbacks must be synchronous.');
}

/** Keep a transaction/query handle from being used by a rejected async callback after rollback. */
function withTransactionLease(tx: object, callback: (tx: object) => unknown): unknown {
  let open = true;
  const assertOpen = () => {
    if (!open) throw new Error('This synchronous SQLite transaction has already finished.');
  };
  const session = Reflect.get(tx, 'session') as object;
  const leasedSession = new Proxy(session, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'prepareQuery') return value;
      return (...args: unknown[]) => {
        assertOpen();
        const prepared = Reflect.apply(value as Execute, target, args) as Prepared;
        return new Proxy(prepared, {
          get(query, key, queryReceiver) {
            const member = Reflect.get(query, key, queryReceiver);
            if (!EXECUTE_METHODS.includes(key as ExecuteMethod)) return member;
            return (...params: unknown[]) => {
              assertOpen();
              return Reflect.apply(member as Execute, query, params);
            };
          },
        });
      };
    },
  });
  const leased = new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'session') return leasedSession;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        assertOpen();
        if (prop === 'transaction') {
          const [nested, ...rest] = args;
          return Reflect.apply(value as Execute, receiver, [
            (child: object) => withTransactionLease(child, nested as (tx: object) => unknown),
            ...rest,
          ]);
        }
        return Reflect.apply(value as Execute, receiver, args);
      };
    },
  });
  try {
    const result = callback(leased);
    rejectAsync(result);
    return result;
  } finally {
    open = false;
  }
}

/**
 * Attach once, before application queries are prepared. No document/schema dependency: the
 * coordinator captures pending state in beforeCommit. Reads do not invoke canonical persistence.
 */
export function installCanonicalCommitGuard(
  db: object,
  options: CanonicalCommitGuardOptions,
): CanonicalCommitGuard {
  // Drizzle's emitted .d.ts hides this @internal property, though its synchronous driver uses
  // the same instance for every query builder and transaction. Keep that dependency here.
  const session = Reflect.get(db, 'session') as Session;
  if (
    !session ||
    typeof session.prepareQuery !== 'function' ||
    typeof session.transaction !== 'function'
  ) {
    throw new Error('Expected a synchronous Drizzle SQLite database session.');
  }
  if (installed.has(session)) throw new Error('A canonical commit guard is already installed.');
  installed.add(session);
  const prepare = session.prepareQuery.bind(session);
  const transact = session.transaction.bind(session);
  let enabled = true;
  let failure: CanonicalProjectionFailure | null = null;
  let frames: Frame[] = [];
  let persisting = false;

  const raw = (sql: string) => prepare({ sql, params: [] }, undefined, 'run', false).run();
  const invalidate = (error: CanonicalProjectionFailure) => {
    failure = error;
    try {
      options.onProjectionFailure?.(error);
    } catch {
      /* Remain poisoned even if the recovery/error notification fails. */
    }
  };
  const rollback = (cause: unknown, canonicalCommitted: boolean): AggregateError | null => {
    let rollbackFailure: AggregateError | null = null;
    try {
      raw('rollback');
    } catch (error) {
      // An uncommitted SQLite transaction may still contain the failed operation. Do not
      // expose that pending state as the old canonical head; require controlled recovery.
      rollbackFailure = new AggregateError([cause, error], 'SQLite operation and rollback failed');
    }
    frames = [];
    if (rollbackFailure && !canonicalCommitted) {
      invalidate(new CanonicalProjectionRollbackError(rollbackFailure));
    }
    return rollbackFailure;
  };
  const ready = () => {
    if (options.isReady && !options.isReady())
      throw new Error('Canonical persistence is not ready.');
  };
  const assertHealthy = () => {
    if (failure)
      throw new Error('SQLite projection requires rehydration after a persistence failure.', {
        cause: failure,
      });
  };
  const emptyResult = (method: ExecuteMethod) =>
    method === 'run' ? { changes: 0, lastInsertRowId: 0 } : method === 'get' ? undefined : [];
  const commit = (execute: () => unknown, method: ExecuteMethod): unknown => {
    const dirty = frames.some((f) => f.dirty);
    if (dirty) {
      try {
        ready();
        persisting = true;
        rejectAsync(options.beforeCommit());
      } catch (error) {
        // Also handle raw BEGIN/COMMIT callers, which do not have Drizzle's transaction catch.
        rollback(error, false);
        throw error;
      } finally {
        persisting = false;
      }
    }
    try {
      const result = execute();
      frames = [];
      return result;
    } catch (cause) {
      if (!dirty) throw cause;
      // The save is already durable. Returning the operation's result prevents callers from
      // treating canonical media as an uncommitted import and deleting it in a catch block.
      const rollbackFailure = rollback(cause, true);
      invalidate(new CanonicalProjectionCommitError(rollbackFailure ?? cause));
      return emptyResult(method);
    }
  };

  session.prepareQuery = (...args: unknown[]) => {
    const prepared = prepare(...args);
    // all()/get() delegate to values() on this same statement. Only suppress that inner
    // invocation; a result mapper issuing a different query must still pass the guard.
    let executing = 0;
    const tokens = rootTokens((args[0] as { sql: string }).sql);
    const command = tokens[0];
    for (const method of EXECUTE_METHODS) {
      const original = prepared[method];
      prepared[method] = (...params: unknown[]) => {
        const execute = () => {
          executing++;
          try {
            return original.apply(prepared, params);
          } finally {
            executing--;
          }
        };
        if (!enabled || executing > 0) return execute();
        if (persisting && !isRead(tokens)) {
          throw new Error('Canonical commit callbacks may read but must not mutate SQLite.');
        }
        // Rollback must remain possible after readiness changes or canonical persistence fails.
        // Drizzle will issue another ROLLBACK when unwinding a COMMIT that we already rolled
        // back; normalize that redundant full rollback to a no-op.
        if (command === 'rollback') {
          const to = tokens.indexOf('to');
          if (to < 0 && frames.length === 0) return emptyResult(method);
          assertHealthy();
          let result: unknown;
          try {
            result = execute();
          } catch (error) {
            frames = [];
            invalidate(new CanonicalProjectionRollbackError(error));
            throw error;
          }
          if (to < 0) frames = [];
          else {
            const name = savepointName(
              tokens[to + 1] === 'savepoint' ? tokens[to + 2] : tokens[to + 1],
            );
            const index = frames.map((f) => f.name).lastIndexOf(name);
            if (index >= 0) frames = [...frames.slice(0, index), { name, dirty: false }];
          }
          return result;
        }
        assertHealthy();
        if (isRead(tokens)) return execute();
        if (command === 'commit' || command === 'end') return commit(execute, method);
        ready();
        if (command === 'begin') {
          const result = execute();
          frames.push({ name: null, dirty: false });
          return result;
        }
        if (command === 'savepoint') {
          const result = execute();
          frames.push({ name: savepointName(tokens[1]), dirty: false });
          return result;
        }
        if (command === 'release') {
          const name = savepointName(tokens[1] === 'savepoint' ? tokens[2] : tokens[1]);
          const index = frames.map((f) => f.name).lastIndexOf(name);
          if (index === 0) return commit(execute, method);
          const result = execute();
          if (index > 0) {
            const dirty = frames.slice(index).some((f) => f.dirty);
            frames = frames.slice(0, index);
            frames[index - 1].dirty ||= dirty;
          }
          return result;
        }

        const implicit = frames.length === 0;
        if (implicit) {
          raw('begin');
          frames.push({ name: null, dirty: false });
        }
        // Mark before execution: a result-mapping exception caught inside a transaction must not
        // hide rows SQLite already changed. A failed/no-op statement may cause a harmless save.
        frames[frames.length - 1].dirty = true;
        try {
          const result = execute();
          if (implicit) commit(() => raw('commit'), 'run');
          return result;
        } catch (error) {
          if (implicit && frames.length) rollback(error, false);
          throw error;
        }
      };
    }
    return prepared;
  };
  session.transaction = (callback, ...args) =>
    transact((tx) => withTransactionLease(tx, callback), ...args);

  return {
    get enabled() {
      return enabled;
    },
    get poisoned() {
      return failure !== null;
    },
    get failure() {
      return failure;
    },
    setEnabled(value) {
      if (frames.length || persisting)
        throw new Error('Cannot change the canonical guard during a transaction.');
      enabled = value;
    },
    clearPoison() {
      if (enabled || frames.length || persisting)
        throw new Error('Rehydrate while disabled before clearing projection failure.');
      failure = null;
    },
  };
}

const installed = new WeakSet<object>();
