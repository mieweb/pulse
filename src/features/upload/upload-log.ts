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
 * What iOS reports about one PATCH: the `metrics` event from patched expo-file-system
 * (`patches/expo-file-system+57.0.7.patch`). One attempt per network transaction — iOS
 * makes a second one when it retries the request on a new connection.
 */
export type UploadMetrics = {
  durationMs: number;
  attempts: {
    /** ALPN name: `h3`, `h2` or `http/1.1`. */
    protocol: string;
    reusedConnection: boolean;
    bodyBytesSent: number;
    durationMs?: number;
  }[];
};

/**
 * Which HTTP version carried a PATCH: `over h3`, or `over h3 → h2 (…)` with each attempt's
 * bytes and time when iOS retried it on another connection. Android uploads go through OkHttp,
 * which has no HTTP/3, and report nothing.
 */
export function describeTransport(platform: string, metrics: UploadMetrics | null): string {
  if (platform === 'android') return 'over OkHttp (no HTTP/3 on Android)';
  if (!metrics || metrics.attempts.length === 0) return 'over an unknown protocol';
  const { attempts } = metrics;
  if (attempts.length === 1) {
    const [only] = attempts;
    return `over ${only.protocol}${only.reusedConnection ? ' (reused connection)' : ''}`;
  }
  const detail = attempts
    .map((a) => {
      const time = a.durationMs === undefined ? '' : ` in ${formatSeconds(a.durationMs)}`;
      return `${a.protocol}: ${formatBytes(a.bodyBytesSent)}${time}`;
    })
    .join(', ');
  return `over ${attempts.map((a) => a.protocol).join(' → ')} (${detail})`;
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
