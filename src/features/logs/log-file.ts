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
/**
 * The most a roll (or the launch rewrite) writes: half the cap, so the appends after it have
 * room. The kept entries can be far bigger (2,000 of up to 16 KB each); writing them all would
 * leave the file past the cap and make every later flush rewrite it again.
 */
export const ROLL_TARGET_BYTES = MAX_LOG_FILE_BYTES / 2;

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

/** UTF-8 byte length of `text` (what it takes in the file). */
function utf8Bytes(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      n += 4; // a surrogate pair is one 4-byte character
      i++;
    } else n += 3;
  }
  return n;
}

/** The newest `entries` whose lines (each with its newline) fit in `maxBytes`, oldest first. */
export function tailWithin(entries: readonly string[], maxBytes: number): string[] {
  let bytes = 0;
  let start = entries.length;
  while (start > 0) {
    const next = bytes + utf8Bytes(entries[start - 1]) + 1;
    if (next > maxBytes) break;
    bytes = next;
    start--;
  }
  return entries.slice(start);
}

/** Start the file over with the newest of `entries` that fit in `ROLL_TARGET_BYTES`; returns how many. */
function startOver(file: File, entries: readonly string[]): number {
  const tail = tailWithin(entries, ROLL_TARGET_BYTES);
  file.write(tail.length > 0 ? `${tail.join('\n')}\n` : '');
  return tail.length;
}

/**
 * Write `batch` to the file: appended, or the file started over with the newest of `kept()`
 * (which includes the batch) when it rolls. Returns how many entries the file holds now. Throws when the disk can't
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
    return startOver(file, kept());
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

/**
 * Start the file over with the newest of `entries` that fit in `ROLL_TARGET_BYTES` (at launch, so
 * it can't grow across launches); returns how many it wrote.
 */
export function rewriteLogFile(entries: readonly string[]): number {
  logDir().create({ intermediates: true, idempotent: true });
  return startOver(logFile(), entries);
}
