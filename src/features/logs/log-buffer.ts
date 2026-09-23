/**
 * The pure half of the debug log (#155): turning console arguments into one redacted line, and
 * keeping the most recent lines. `logger.ts` wires it to the console and a file on disk.
 */

/** How many log entries are kept, in memory and on disk. */
export const MAX_ENTRIES = 2000;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Blank out capability tokens — they're live upload credentials, and logs get shared. Covers a
 * `token=` query param (URLs, `pulsecam://` pairing links), a `Bearer` header, and a `"token"`
 * JSON field.
 */
export function redact(text: string): string {
  return text
    .replace(/([?&]token=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[^\s"',]+/gi, '$1[redacted]')
    .replace(/("token"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"');
}

function describe(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (arg === undefined) return 'undefined';
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg); // circular or otherwise unserializable
  }
}

/**
 * One entry: `2026-09-24T14:05:00.000Z WARN message`. Every entry starts with its timestamp,
 * which is how `splitEntries` tells entries apart when a message spans several lines (a stack).
 */
export function formatEntry(level: LogLevel, args: unknown[], now: Date): string {
  return `${now.toISOString()} ${level.toUpperCase()} ${redact(args.map(describe).join(' '))}`;
}

const ENTRY_START = /\n(?=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z )/;

/** Split a saved log file back into entries (a multi-line stack stays one entry). */
export function splitEntries(text: string): string[] {
  return text
    .split(ENTRY_START)
    .map((e) => e.replace(/\n+$/, ''))
    .filter((e) => e.length > 0);
}

/** The most recent `max` entries, oldest first. */
export class LogBuffer {
  private entries: string[] = [];

  constructor(private readonly max: number = MAX_ENTRIES) {}

  push(entry: string): void {
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
  }

  load(entries: string[]): void {
    this.entries = entries.slice(-this.max);
  }

  all(): string[] {
    return [...this.entries];
  }

  get size(): number {
    return this.entries.length;
  }
}
