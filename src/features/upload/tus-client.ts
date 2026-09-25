import type { File } from 'expo-file-system';
import { CAPABILITIES_REJECTION_MESSAGE } from './capabilities';
import { appVersionLabel, clientHeaders } from './client-identity';
import type { UploadMetadata } from './protocol.gen';
import { describeError, formatBytes, formatSeconds, shortId, type UploadLog } from './upload-log';

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 500;
const TUS_VERSION = '1.0.0';

/** The artifact kinds of the protocol (`Upload-Metadata.kind`), from the generated protocol types. */
export type ArtifactKind = NonNullable<UploadMetadata['kind']>;

export type TusUploadProgress = { bytesSent: number; totalBytes: number };

/** Result of one chunk's byte-carrying PATCH — status + response headers (any casing). */
export type ChunkUploadResult = { status: number; headers: Record<string, string> };

/**
 * Performs the byte-carrying PATCH for one bounded chunk of `file`: exactly
 * `chunkBytes` bytes starting at `offset`. This is a separate, injected
 * concern (not implemented inline in this module) because the real
 * implementation needs `expo-file-system`'s native upload task — see
 * `./native-chunk-upload.ts` for why and how. This module stays free of any
 * React Native-specific import so it's unit testable under this project's
 * pure-logic jest config.
 */
export type UploadChunk = (params: {
  resourceUrl: string;
  /** Which artifact this PATCH carries, for the log. */
  kind: ArtifactKind;
  offset: number;
  chunkBytes: number;
  totalBytes: number;
  file: File;
  headers: Record<string, string>;
  signal?: AbortSignal;
  /**
   * In-flight progress for THIS attempt: bytes handed to the network so far,
   * relative to `offset` (not an absolute file position). Bytes "sent" are not
   * bytes committed — behind a body-buffering proxy the server may still hold
   * everything — so callers treat this as display-only; durable position always
   * comes from `Upload-Offset` (the 204 header, or a re-HEAD after a failure).
   */
  onProgress?: (bytesSentThisAttempt: number) => void;
}) => Promise<ChunkUploadResult>;

export type TusUploadOptions = {
  /** Full base URL, including the operator's path prefix — e.g. `https://vault.example.org/pulsevault`. */
  server: string;
  token: string | null;
  artifactId: string;
  filename: string;
  kind: ArtifactKind;
  /** UUID of another artifact this one belongs to (e.g. a video's captions). */
  relatedTo?: string;
  /** `<algorithm>:<hex digest>` of the finished file, verified by the server if it supports checksums. */
  checksum?: string;
  /** Free-form display title for the artifact (the draft name). Sent only on the session anchor. */
  name?: string;
  file: File;
  /**
   * Called right after the initial `POST` creates the upload, so a caller can track what it
   * created (e.g. to `DELETE` it on cancel) without waiting for the whole upload to finish.
   */
  onResourceCreated?: (resourceUrl: string) => void;
  signal?: AbortSignal;
  onProgress?: (progress: TusUploadProgress) => void;
  /**
   * Size of each byte-carrying PATCH; must be a positive integer if provided.
   * UNSET by default — each PATCH then carries the whole remainder (offset →
   * EOF), i.e. a fresh upload is ONE PATCH. That is standard TUS practice
   * (`tus-js-client` defaults `chunkSize` to `Infinity`) and the fastest,
   * smoothest path on device: one native background transfer that survives
   * iOS lock/backgrounding, no per-chunk staging copy, no per-chunk dead time.
   *
   * Set a bound only for a deployment whose edge is known to spool entire
   * request bodies before forwarding them (e.g. a ModSecurity-fronted proxy —
   * mieweb/opensource-server#395): there, a bounded chunk caps how much an
   * interruption can lose, at the cost of the above. Measured against that
   * edge (64 MB file): single PATCH 20.4 MB/s; 32 MiB chunks kept-alive
   * 20.5 MB/s; 16 MiB 16.3 MB/s; 8 MiB 10.1 MB/s — don't go below 32 MiB.
   */
  chunkSizeBytes?: number;
  /** Dependency-injected for testing; defaults to the global `fetch`. Only used for the headers-only requests (create/HEAD/DELETE) — never for the byte-carrying PATCHes, see `uploadChunk`. */
  fetchImpl?: typeof fetch;
  /** Performs the actual byte-carrying PATCH for one chunk. Required — pass `uploadChunkNative` from `./native-chunk-upload` at the real call site; tests inject a fake. */
  uploadChunk: UploadChunk;
  /** Where to log what happens (creates, resumes, retries); nothing is logged without it. */
  log?: UploadLog;
};

export type TusUploadResult = { resourceUrl: string };

/**
 * Thrown by `uploadViaTus`. `retryable` distinguishes a transient failure
 * (network drop, 5xx, a PATCH offset conflict — safe to retry) from a terminal
 * one (403/422 — retrying without changing anything won't help); `withRetry`
 * only retries the former.
 */
export class TusUploadError extends Error {
  readonly retryable: boolean;
  readonly statusCode?: number;
  constructor(message: string, opts: { retryable: boolean; statusCode?: number }) {
    super(message);
    this.name = 'TusUploadError';
    this.retryable = opts.retryable;
    this.statusCode = opts.statusCode;
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function base64Encode(value: string): string {
  // btoa is available in Hermes for ASCII-safe strings (UUIDs, filenames, our
  // own fixed kind enum) — no need for a Buffer/Unicode-safe encoder here.
  return btoa(value);
}

/**
 * UTF-8-safe base64 for free-form values (the draft `name`, which can carry
 * accents or emoji). `btoa` alone is Latin-1 and corrupts any code point
 * > 0xFF, so first percent-escape to the value's UTF-8 bytes and collapse those
 * to a byte string `btoa` accepts. Uses only Hermes-guaranteed globals
 * (`encodeURIComponent`/`btoa`) — no Buffer or TextEncoder dependency.
 *
 * Returns `null` for a malformed title: a lone surrogate (e.g. a value pasted
 * truncated mid-emoji) makes `encodeURIComponent` throw. The caller then omits
 * the optional `name` rather than failing the whole upload over one field.
 */
function base64EncodeUtf8(value: string): string | null {
  let escaped: string;
  try {
    escaped = encodeURIComponent(value);
  } catch {
    return null;
  }
  const bytes = escaped.replace(/%([0-9A-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return btoa(bytes);
}

function buildUploadMetadata(opts: {
  artifactId: string;
  filename: string;
  kind: ArtifactKind;
  relatedTo?: string;
  checksum?: string;
  name?: string;
}): string {
  const parts = [
    `artifactId ${base64Encode(opts.artifactId)}`,
    `filename ${base64Encode(opts.filename)}`,
    `kind ${base64Encode(opts.kind)}`,
  ];
  if (opts.relatedTo) parts.push(`relatedTo ${base64Encode(opts.relatedTo)}`);
  if (opts.checksum) parts.push(`checksum ${base64Encode(opts.checksum)}`);
  // Free-form title → UTF-8-safe encoder. Sent only on the session anchor;
  // omitted if the title can't be encoded (a malformed surrogate).
  if (opts.name) {
    const encodedName = base64EncodeUtf8(opts.name);
    if (encodedName) parts.push(`name ${encodedName}`);
  }
  // Which app build made this upload (protocol 2.1); older servers ignore the key.
  const appVersion = appVersionLabel();
  if (appVersion) parts.push(`appVersion ${base64Encode(appVersion)}`);
  return parts.join(',');
}

/** Headers every request carries: `Pulse-Client` (PROTOCOL.md §7.2), plus the token if any. */
function authHeaders(token: string | null): Record<string, string> {
  return { ...clientHeaders(), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/**
 * `426 Upgrade Required`: the server needs a newer protocol than this app speaks (PROTOCOL.md
 * §7.2). Terminal, with the same message pairing shows, so the user knows to update the app.
 */
function upgradeRequiredError(): TusUploadError {
  return new TusUploadError(CAPABILITIES_REJECTION_MESSAGE['version-too-old'], {
    retryable: false,
    statusCode: 426,
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * Retries `fn` with exponential backoff + jitter, but only for transient failures — a terminal
 * `TusUploadError` is rethrown immediately. Each retry and a final give-up are logged under `label`.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal | undefined,
  log: UploadLog | undefined,
  label: string,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (err instanceof TusUploadError && !err.retryable) throw err;
      attempt += 1;
      if (attempt >= MAX_RETRY_ATTEMPTS) {
        log?.warn(`${label}: giving up after ${attempt} attempts: ${describeError(err)}`);
        throw err;
      }
      const backoff = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      const delay = backoff + Math.random() * backoff * 0.5;
      log?.warn(
        `${label}: attempt ${attempt} of ${MAX_RETRY_ATTEMPTS} failed: ${describeError(err)}; ` +
          `retrying in ${formatSeconds(delay)}`,
      );
      await sleep(delay, signal);
    }
  }
}

async function statusError(res: Response, fallbackMessage: string): Promise<TusUploadError> {
  if (res.status === 426) return upgradeRequiredError();
  let message = fallbackMessage;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // Non-JSON error body — keep the fallback message.
  }
  // 4xx (except a transient 429) is the server telling us this exact request
  // is wrong — retrying unchanged won't help. Everything else (5xx, network)
  // is worth retrying.
  const retryable = res.status >= 500 || res.status === 429;
  return new TusUploadError(message, { retryable, statusCode: res.status });
}

function statusErrorFromChunk(result: ChunkUploadResult, fallbackMessage: string): TusUploadError {
  if (result.status === 426) return upgradeRequiredError();
  // A PATCH 409 is an offset conflict — e.g. a PATCH that "failed" had actually landed. The next
  // attempt re-HEADs for the server's offset, so it's worth retrying.
  const retryable = result.status >= 500 || result.status === 429 || result.status === 409;
  return new TusUploadError(fallbackMessage, { retryable, statusCode: result.status });
}

/**
 * The `Upload-Offset` header as a byte position in `[0, totalBytes]`, or `null` for anything
 * else: missing, not a plain decimal integer, beyond `Number.MAX_SAFE_INTEGER`, or past the end
 * of the local file.
 */
function parseOffset(raw: string | null | undefined, totalBytes: number): number | null {
  if (raw == null || !/^\d+$/.test(raw.trim())) return null;
  const offset = Number(raw.trim());
  return Number.isSafeInteger(offset) && offset <= totalBytes ? offset : null;
}

/** Case-insensitive response-header lookup — `ChunkUploadResult.headers` casing is platform-dependent. */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

/**
 * Every headers-only request (`POST`/`HEAD`/`DELETE`) passes `redirect:
 * 'manual'` and then calls this immediately on the result. Without it, a
 * compromised or MITM'd paired server could 3xx any of those requests and
 * the platform's `fetch` would transparently resend it — Authorization
 * header included — to an attacker-controlled host, with tus-client never
 * seeing anything other than the final response to inspect. A manual
 * redirect surfaces as `response.type === 'opaqueredirect'` per the fetch
 * spec, or as a literal 3xx status on runtimes that don't implement that
 * type; both are treated as a hard, non-retryable failure here rather than
 * ever being followed.
 */
function rejectRedirect(res: Response): void {
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new TusUploadError('Server returned a redirect instead of a direct response', {
      retryable: false,
    });
  }
}

/**
 * Resolves the server's `Location` response header against the paired
 * server's base URL, then requires the result to stay on that same origin.
 * Without this check, a malicious or compromised paired server could return
 * an absolute `Location` pointing at a different host, and every subsequent
 * `HEAD`/`PATCH`/`DELETE` — each carrying `Authorization: Bearer <token>` —
 * would leak the capability token to that host instead of the paired server.
 */
function resolveLocation(location: string, base: string): string {
  const resolved = new URL(location, base);
  const baseOrigin = new URL(base).origin;
  if (resolved.origin !== baseOrigin) {
    throw new TusUploadError('Server returned an upload location on an unexpected origin', {
      retryable: false,
    });
  }
  return resolved.toString();
}

async function createUpload(opts: TusUploadOptions, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(`${opts.server}/upload`, {
    method: 'POST',
    redirect: 'manual',
    signal: opts.signal,
    headers: {
      'Tus-Resumable': TUS_VERSION,
      'Upload-Length': String(opts.file.size ?? 0),
      'Upload-Metadata': buildUploadMetadata(opts),
      ...authHeaders(opts.token),
    },
  });
  rejectRedirect(res);
  if (res.status !== 201)
    throw await statusError(res, `Could not start the upload (${res.status})`);
  const location = res.headers.get('location');
  if (!location)
    throw new TusUploadError('Server did not return an upload location', { retryable: false });
  return resolveLocation(location, opts.server);
}

/**
 * Always re-`HEAD`s rather than trusting a cached offset — the upload may not have completed as
 * far as last assumed. An offset this client can't use fails closed: nothing more is sent.
 */
async function fetchOffset(
  resourceUrl: string,
  token: string | null,
  totalBytes: number,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<number> {
  const res = await fetchImpl(resourceUrl, {
    method: 'HEAD',
    redirect: 'manual',
    signal,
    headers: { 'Tus-Resumable': TUS_VERSION, ...authHeaders(token) },
  });
  rejectRedirect(res);
  if (!res.ok) throw await statusError(res, `Could not resume the upload (${res.status})`);
  const offset = parseOffset(res.headers.get('upload-offset'), totalBytes);
  if (offset === null) {
    throw new TusUploadError('Server did not return a valid Upload-Offset', { retryable: false });
  }
  return offset;
}

/**
 * Upload a file to a pulsevault-compatible server over TUS. By default each
 * byte-carrying PATCH runs from the current offset to EOF — a fresh upload is
 * ONE PATCH, the standard TUS shape — while `chunkSizeBytes` bounds it into a
 * sequence of chunks for deployments behind a body-buffering edge (see its
 * doc). Either way the transfer loop, retry and offset discipline below are
 * identical; a bounded chunk size just adds boundaries at which progress is
 * durable through a proxy that spools whole request bodies.
 *
 * The byte-carrying PATCHes are delegated to `opts.uploadChunk` rather than
 * sent via `fetch` with a JS-constructed body: React Native's `fetch`
 * silently base64-encodes any `Uint8Array`/`ArrayBuffer` body, and even a
 * `Blob` from `expo-file-system`'s `File.slice()` doesn't avoid this —
 * `slice()` itself constructs that Blob from a `Uint8Array`, which React
 * Native's `Blob` implementation explicitly refuses ("Creating blobs from
 * 'ArrayBuffer' and 'ArrayBufferView' are not supported"). The real
 * implementation (`uploadChunkNative`) instead uses `expo-file-system`'s own
 * native upload task, which streams bytes via the platform's
 * URLSession/OkHttp APIs and never goes through that bridge at all.
 *
 * Progress: in-flight ticks from the native task are forwarded as they happen
 * (`offset + bytesSentThisAttempt`) so the bar moves smoothly, and each 204's
 * server-acknowledged `Upload-Offset` re-anchors it to durable truth. After a
 * failure the re-HEAD's offset is reported as-is — the bar may step back to
 * the last durable byte, which is honest.
 *
 * Offset discipline — the server's offset is the only source of truth:
 * - Each successful PATCH's 204 carries the new `Upload-Offset`; the loop
 *   advances on exactly that value, never on what was "sent".
 * - On ANY failure or retry, the next attempt re-`HEAD`s for the
 *   authoritative offset before sending more bytes — never trusting what the
 *   previous attempt assumed (it may have landed some bytes before failing;
 *   resending bytes the server already has is a TUS conflict).
 */
export async function uploadViaTus(opts: TusUploadOptions): Promise<TusUploadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const totalBytes = opts.file.size ?? 0;
  const chunkSizeBytes = opts.chunkSizeBytes;
  // Fail fast on a nonsensical explicit chunk size (0, negative, NaN, Infinity, fractional): it
  // would produce a 0-byte or invalid PATCH and a loop that retries forever without advancing.
  // (Unset means "whole remainder per PATCH" — the default.)
  if (
    chunkSizeBytes !== undefined &&
    (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0)
  ) {
    throw new TusUploadError(`chunkSizeBytes must be a positive integer (got ${chunkSizeBytes})`, {
      retryable: false,
    });
  }

  // HEAD-then-send-chunks is retried as ONE unit, not as separately retried
  // steps — a retry after a transient failure MUST re-HEAD first to learn the
  // real offset before any further bytes move (see offset discipline above).
  let attempt = 0;
  const transfer = (resourceUrl: string) =>
    withRetry(
      async () => {
        const { token, signal } = opts;
        let offset = await fetchOffset(resourceUrl, token, totalBytes, signal, fetchImpl);
        attempt += 1;
        if (attempt > 1) {
          opts.log?.info(
            `${opts.kind}: resuming, the server has ${formatBytes(offset)} of ${formatBytes(totalBytes)}`,
          );
        }
        opts.onProgress?.({ bytesSent: offset, totalBytes });

        while (offset < totalBytes) {
          const chunkBytes = Math.min(chunkSizeBytes ?? totalBytes - offset, totalBytes - offset);
          const headers = {
            'Tus-Resumable': TUS_VERSION,
            'Upload-Offset': String(offset),
            'Content-Type': 'application/offset+octet-stream',
            ...authHeaders(opts.token),
          };
          // In-flight ticks make the bar move smoothly while bytes flow; the
          // server-acknowledged Upload-Offset below re-anchors to durable
          // truth on completion (and the re-HEAD does after any failure).
          const patchStart = offset;
          const result = await opts.uploadChunk({
            resourceUrl,
            kind: opts.kind,
            offset,
            chunkBytes,
            totalBytes,
            file: opts.file,
            headers,
            signal: opts.signal,
            onProgress: (sentThisAttempt) =>
              opts.onProgress?.({
                bytesSent: Math.min(patchStart + sentThisAttempt, totalBytes),
                totalBytes,
              }),
          });
          if (result.status !== 204) {
            throw statusErrorFromChunk(result, `Upload failed (${result.status})`);
          }
          // Advance strictly on the server's word. A 204 without a usable
          // Upload-Offset, or one that claims no forward progress, means this
          // loop can no longer trust its position — hand control back to
          // withRetry, whose next attempt re-HEADs (and fails closed on an
          // unusable offset) before sending anything.
          const rawOffset = headerValue(result.headers, 'upload-offset');
          const responseOffset = parseOffset(rawOffset, totalBytes);
          if (responseOffset === null || responseOffset <= offset) {
            throw new TusUploadError(
              'Server acknowledged a chunk without a usable Upload-Offset',
              { retryable: true },
            );
          }
          offset = responseOffset;
          opts.onProgress?.({ bytesSent: offset, totalBytes });
        }
      },
      opts.signal,
      opts.log,
      opts.kind,
    );

  // Every call creates its own upload and only ever resumes within itself — there is no resume
  // input. (A create retried after its 201 was lost meets its own reservation as a terminal 409;
  // only an idempotent create on the server could tell the two apart.)
  const resourceUrl = await withRetry(
    () => createUpload(opts, fetchImpl),
    opts.signal,
    opts.log,
    `${opts.kind} create`,
  );
  opts.log?.info(
    `${opts.kind}: created upload for ${shortId(opts.artifactId)} (${formatBytes(totalBytes)})`,
  );
  opts.onResourceCreated?.(resourceUrl);
  await transfer(resourceUrl);
  return { resourceUrl };
}

/** Cancels an in-flight upload server-side (TUS `DELETE`), freeing its reserved bytes. Distinct from aborting the local request — call this when the user explicitly gives up, not on a transient network drop. */
export async function cancelTusUpload(
  resourceUrl: string,
  token: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(resourceUrl, {
    method: 'DELETE',
    redirect: 'manual',
    headers: { 'Tus-Resumable': TUS_VERSION, ...authHeaders(token) },
  });
  rejectRedirect(res);
  // 404/410 = the resource is already gone, which is the cancel's goal state. Any other
  // non-2xx means the reservation may still be live server-side.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new TusUploadError(`Cancel failed with HTTP ${res.status}`, {
      retryable: res.status >= 500 || res.status === 429,
      statusCode: res.status,
    });
  }
}
