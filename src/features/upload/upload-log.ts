/**
 * Upload lines for the debug log (About → Share logs). They go through `console`, which the log
 * captures and redacts (tokens never reach it), tagged `[upload]` so they're easy to pick out.
 * One line per step or outcome, never per progress tick.
 */

export type UploadLog = {
  info(message: string): void;
  warn(message: string): void;
};

export const uploadLog: UploadLog = {
  info: (message) => console.info(`[upload] ${message}`),
  warn: (message) => console.warn(`[upload] ${message}`),
};

/** Bytes as `850 B`, `12.4 KB` or `98.1 MB` (1 MB = 1024 × 1024 bytes). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A duration as `0.4 s` or `83.2 s`. */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Throughput as `8.0 MB/s` or `19.7 KB/s`; `-` when no time passed. */
export function formatRate(bytes: number, ms: number): string {
  if (ms <= 0) return '-';
  return `${formatBytes(Math.round((bytes / ms) * 1000))}/s`;
}

/** The first 8 characters of an id — enough to follow one upload through the log. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Why a request failed, without a closing period (iOS messages end in one, and the log adds more
 * after it), plus the HTTP status when there was one and the message lacks it.
 */
export function describeError(err: unknown): string {
  const message = (err instanceof Error && err.message ? err.message : String(err)).replace(
    /\.$/,
    '',
  );
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status !== 'number' || message.includes(String(status))) return message;
  return `${message} (HTTP ${status})`;
}
