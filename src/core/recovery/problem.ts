import type { LibraryProblem } from './types';

/** What a full disk says, from SQLite (SQLITE_FULL), the file system or the OS. */
const FULL =
  /SQLITE_FULL|database or disk is full|ENOSPC|no space left|out of space|not enough (free )?space|disk is full/i;

function isFull(error: unknown, depth = 0): boolean {
  if (error == null || depth > 3) return false;
  if (typeof error === 'string') return FULL.test(error);
  if (typeof error !== 'object') return false;
  const { message, code, cause } = error as { message?: unknown; code?: unknown; cause?: unknown };
  return (
    (typeof message === 'string' && FULL.test(message)) ||
    (typeof code === 'string' && FULL.test(code)) ||
    code === 13 || // SQLITE_FULL's result code
    isFull(cause, depth + 1)
  );
}

/**
 * Why the library can't be shown. `failed` (it failed its check and couldn't be recovered) wins;
 * else a migration error is `full` when the disk is, which freeing space fixes, or `migration`.
 */
export function libraryProblem(failed: boolean, error: unknown): LibraryProblem {
  if (failed) return 'damaged';
  return isFull(error) ? 'full' : 'migration';
}
