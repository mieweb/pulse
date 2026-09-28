import { Directory, File, Paths } from 'expo-file-system';
import { AppState } from 'react-native';

import { formatEntry, LogBuffer, type LogLevel, MAX_ENTRIES, splitEntries } from './log-buffer';

/**
 * The debug log behind the About page's Share logs (#155). `installLogCapture` (called once at
 * startup) copies every console message and uncaught error into it, so existing `console.*`
 * calls need no changes. Entries are redacted as they're recorded, kept in memory, and appended
 * to a file so they survive a crash or relaunch.
 */

const buffer = new LogBuffer(MAX_ENTRIES);
const FLUSH_DELAY_MS = 1000;
let pending: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Entries currently in the file; once it passes 2× the cap, the file is rewritten from memory. */
let entriesInFile = 0;
let installed = false;

const logDir = () => new Directory(Paths.document, 'logs');
const logFile = () => new File(Paths.document, 'logs', 'pulse.log');

/** Write pending entries now. Never throws — logging must not break the app. */
export function flushLogs(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  try {
    logDir().create({ intermediates: true, idempotent: true });
    if (entriesInFile + batch.length > MAX_ENTRIES * 2) {
      const all = buffer.all();
      logFile().write(`${all.join('\n')}\n`);
      entriesInFile = all.length;
    } else {
      logFile().write(`${batch.join('\n')}\n`, { append: true });
      entriesInFile += batch.length;
    }
  } catch {
    // Disk full or unavailable: the entries are still in memory for this session.
  }
}

export function log(level: LogLevel, ...args: unknown[]): void {
  const entry = formatEntry(level, args, new Date());
  buffer.push(entry);
  pending.push(entry);
  if (!flushTimer) flushTimer = setTimeout(flushLogs, FLUSH_DELAY_MS);
}

/** The kept entries, oldest first. */
export function logEntries(): string[] {
  return buffer.all();
}

type ErrorHandler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsLike = { getGlobalHandler(): ErrorHandler; setGlobalHandler(h: ErrorHandler): void };

export function installLogCapture(): void {
  if (installed) return;
  installed = true;

  try {
    const file = logFile();
    if (file.exists) {
      buffer.load(splitEntries(file.textSync()));
      // Start the file over with just the kept entries, so it can't grow across launches.
      file.write(buffer.size > 0 ? `${buffer.all().join('\n')}\n` : '');
      entriesInFile = buffer.size;
    }
  } catch {
    // Unreadable file: start fresh.
  }

  const levels = {
    debug: 'debug',
    log: 'info',
    info: 'info',
    warn: 'warn',
    error: 'error',
  } as const;
  for (const method of Object.keys(levels) as (keyof typeof levels)[]) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      log(levels[method], ...args);
    };
  }

  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (errorUtils) {
    const previous = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, isFatal) => {
      log(isFatal ? 'fatal' : 'error', 'Uncaught', error);
      flushLogs(); // write it before a fatal error takes the app down
      previous(error, isFatal);
    });
  }

  // When the app leaves and returns to the screen, so an upload stall can be told apart from
  // the app being in the background.
  AppState.addEventListener('change', (state) => log('info', `[app] ${state}`));

  log('info', '--- app started ---');
}

/** A text file with `header` (the About details) followed by the log, ready to share. */
export function writeLogExport(header: string): File {
  flushLogs();
  const file = new File(Paths.cache, 'pulse-logs.txt');
  if (file.exists) file.delete();
  file.write(
    `${header}\n\n--- Log (${buffer.size} entries, oldest first) ---\n${buffer.all().join('\n')}\n`,
  );
  return file;
}
