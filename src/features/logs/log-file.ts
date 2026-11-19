import { Directory, File } from 'expo-file-system';

import { documentDir } from '@/utils/storage-root';

/**
 * The debug log on disk: `logs/pulse.log` in the documents folder, which in the embed is the
 * account's namespace (`setStorageRoots`), so each account's log stays with its library and goes
 * when the namespace is purged. It rolls: the file is started over from the entries kept in memory
 * once it holds twice the kept count or passes `MAX_LOG_FILE_BYTES`, so it can't grow without
 * bound. What reaches it has already been through `redact()` (logger.ts).
 */

/** The log file's path inside the documents folder (the namespace's, when embedded). */
export const LOG_FILE_REL = 'logs/pulse.log';
/** The largest the file grows before it rolls. */
export const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024;

const logDir = () => new Directory(documentDir(), 'logs');

/** The log file (it may not exist yet). */
export function logFile(): File {
  return new File(documentDir(), ...LOG_FILE_REL.split('/'));
}

/**
 * Whether the next write starts the file over (from the kept entries) instead of appending: the
 * file would pass twice the kept count, or it's already past the byte cap.
 */
export function shouldRoll(opts: {
  entriesInFile: number;
  adding: number;
  maxEntries: number;
  fileBytes: number;
  maxBytes?: number;
}): boolean {
  const { entriesInFile, adding, maxEntries, fileBytes, maxBytes = MAX_LOG_FILE_BYTES } = opts;
  return entriesInFile + adding > maxEntries * 2 || fileBytes > maxBytes;
}

/**
 * Write `batch` to the file: appended, or the file started over with `kept()` (which includes the
 * batch) when it rolls. Returns how many entries the file holds now. Throws when the disk can't
 * be written; the caller keeps the entries in memory.
 */
export function writeLogBatch(
  batch: readonly string[],
  kept: () => string[],
  entriesInFile: number,
  maxEntries: number,
): number {
  logDir().create({ intermediates: true, idempotent: true });
  const file = logFile();
  const fileBytes = file.exists ? (file.size ?? 0) : 0;
  if (shouldRoll({ entriesInFile, adding: batch.length, maxEntries, fileBytes })) {
    const all = kept();
    file.write(all.length > 0 ? `${all.join('\n')}\n` : '');
    return all.length;
  }
  file.write(`${batch.join('\n')}\n`, { append: true });
  return entriesInFile + batch.length;
}

/** The file's text, or null when there's none or it can't be read. */
export function readLogFile(): string | null {
  try {
    const file = logFile();
    return file.exists ? file.textSync() : null;
  } catch {
    return null;
  }
}

/** Start the file over with `entries` (at launch, so it can't grow across launches). */
export function rewriteLogFile(entries: readonly string[]): void {
  logDir().create({ intermediates: true, idempotent: true });
  logFile().write(entries.length > 0 ? `${entries.join('\n')}\n` : '');
}
