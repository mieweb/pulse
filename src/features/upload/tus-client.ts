import type { File } from 'expo-file-system';

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 500;
const TUS_VERSION = '1.0.0';

export type ArtifactKind = 'video' | 'project' | 'captions' | 'thumbnail';

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
  /** A previously-created upload's resource URL, to resume instead of creating a new one. */
  resourceUrl?: string | null;
  /**
   * Called as soon as the resource URL is known — immediately if resuming, or right after
   * the initial `POST` otherwise — so a caller can track "what's actually in flight right
   * now" (e.g. for `cancel()`) without waiting for the whole upload to finish. AWAITED
   * before any byte moves: callers persist the URL here, and an app kill between the POST
   * and that persist is exactly the window that used to strand a server-side reservation
   * with no local handle (the 409-on-retry trap).
   */
  onResourceCreated?: (resourceUrl: string) => void | Promise<void>;
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
};

export type TusUploadResult = { resourceUrl: string };

/**
 * Thrown by `uploadViaTus`. `retryable` distinguishes a transient failure
 * (network drop, 5xx — safe to retry) from a terminal one (403/422 — retrying
 * without changing anything won't help), so callers can show the right UI.
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

/** Whether an error is a fetch/native-task cancellation. Shared with the direct-upload client so both transports keep abort semantics distinct from failures. */
export function isAbortError(err: unknown): boolean {
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
  return parts.join(',');
}

/** Bearer header for a paired session's capability token. Shared with the direct-upload client. */
export function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
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

/** Retries `fn` with exponential backoff + jitter, but only for transient failures — a terminal `TusUploadError` is rethrown immediately. Exported for the direct-upload client, which shares the retry policy. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (err instanceof TusUploadError && !err.retryable) throw err;
      attempt += 1;
      if (attempt >= MAX_RETRY_ATTEMPTS) throw err;
      const backoff = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      const jitter = Math.random() * backoff * 0.5;
      await sleep(backoff + jitter, signal);
    }
  }
}

async function statusError(res: Response, fallbackMessage: string): Promise<TusUploadError> {
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

/** Exported alias of the response→error mapper for the direct-upload client — same body parsing, same retryability rules. */
export const responseError = statusError;

/**
 * Whether the artifact is already complete (ready) server-side. A 409 on
 * create can mean "this upload already FINISHED" — e.g. a retry after a run
 * that failed client-side mid-session — not just "someone else holds it".
 * Only ready artifacts serve on the artifacts URL, so a 200/206 (local
 * streaming) or a 3xx (presigned redirect, NOT followed) proves completion.
 * A probe failure just means "not adoptable as done" — never an exception —
 * EXCEPT cancellation: an abort is the caller's verdict, not the probe's,
 * and must propagate so callers keep their AbortError semantics instead of
 * surfacing whatever error the probe was trying to recover from.
 */
export async function probeArtifactReady(
  server: string,
  artifactId: string,
  token: string | null,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${server}/artifacts/${artifactId}`, {
      redirect: 'manual',
      signal,
      // Range keeps a local-storage hit to one byte; S3-backed serving 302s
      // before any body exists.
      // Residual risk, documented: runtimes without real `redirect: 'manual'`
      // support (React Native's fetch) may follow the 302 and forward the
      // Authorization header to the presigned URL's host. That host is the
      // vault operator's own bucket (the vault minted the URL), so the token
      // stays within the trust domain that issued it — unlike the arbitrary
      // Location targets rejectRedirect guards against elsewhere.
      headers: { Range: 'bytes=0-0', ...authHeaders(token) },
    });
    await (res.body as { cancel?: () => Promise<void> } | null)?.cancel?.().catch(() => {});
    if (res.type === 'opaqueredirect') return true;
    return res.status === 200 || res.status === 206 || (res.status >= 300 && res.status < 400);
  } catch (err) {
    if (isAbortError(err)) throw err;
    return false;
  }
}

function statusErrorFromChunk(result: ChunkUploadResult, fallbackMessage: string): TusUploadError {
  // A PATCH 409 is an offset conflict — this client's position went stale (a
  // “failed” chunk actually landed, or a parallel resume advanced the upload).
  // Unlike a create-409 it is NOT terminal: retryable hands control back to
  // withRetry, whose next attempt re-HEADs and re-anchors to the server's
  // offset before sending another byte (see “offset discipline” above).
  const retryable = result.status >= 500 || result.status === 429 || result.status === 409;
  return new TusUploadError(fallbackMessage, { retryable, statusCode: result.status });
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
 * ever being followed. Exported for the direct-upload client — same threat,
 * same rule.
 */
export function rejectRedirect(res: Response): void {
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
 * The resource URL a pulsevault server WOULD have handed out for this artifact:
 * the tus upload id is deterministic — `base64url("<kind>/<artifactId><ext>")`,
 * see `generateUrl`/`namingFunction` in pulsevault's `lib/pulsevaultTus.ts` — so
 * a client that lost the `Location` header (killed between the POST and the
 * resume-state persist) can re-derive it and resume the server-side reservation
 * instead of dead-ending on the 409 a re-create would produce. Returns `null`
 * when the filename has no extension (the id is unknowable without it — the
 * server would have rejected such a create anyway).
 *
 * Deliberately pulsevault-shaped: a non-pulsevault tus server may mint opaque
 * ids, in which case the derived URL simply HEADs to a 404 and the caller
 * falls back to surfacing the original 409.
 */
export function deriveUploadResourceUrl(
  server: string,
  kind: ArtifactKind,
  artifactId: string,
  filename: string,
): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return null;
  const ext = filename.slice(dot).toLowerCase();
  // btoa is safe here: kind/uuid/extension are all ASCII. base64url = base64
  // with the URL-hostile chars swapped and padding dropped (RFC 4648 §5).
  const base64url = btoa(`${kind}/${artifactId}${ext}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${server}/upload/${base64url}`;
}

/** Always re-`HEAD`s rather than trusting a cached offset — the server may have restarted, or the upload may not have completed as far as last assumed. */
async function fetchOffset(
  resourceUrl: string,
  token: string | null,
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
  // Check the raw header first: `Number(null)` is 0, so a 2xx HEAD *without*
  // Upload-Offset would otherwise look like a live zero-offset resource — and
  // the 409 adopt path would upload into a malformed resource instead of
  // failing closed.
  const rawOffset = res.headers.get('upload-offset');
  if (rawOffset === null) {
    throw new TusUploadError('Server did not return an Upload-Offset', { retryable: false });
  }
  const offset = Number(rawOffset);
  if (!Number.isSafeInteger(offset) || offset < 0) {
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

  const createFresh = () => withRetry(() => createUpload(opts, fetchImpl), opts.signal);

  // HEAD-then-send-chunks is retried as ONE unit, not as separately retried
  // steps — a retry after a transient failure MUST re-HEAD first to learn the
  // real offset before any further bytes move (see offset discipline above).
  const transfer = (resourceUrl: string) =>
    withRetry(async () => {
      let offset = await fetchOffset(resourceUrl, opts.token, opts.signal, fetchImpl);
      // Bound by the local file: a resource claiming MORE bytes than this file
      // holds is not this file's upload (a stale or foreign resource under the
      // same id) — letting it satisfy the loop condition would report success
      // without sending or validating a single local byte.
      if (offset > totalBytes) {
        throw new TusUploadError(
          `Server reports more bytes (${offset}) than the local file has (${totalBytes})`,
          { retryable: false },
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
        // withRetry, whose next attempt re-HEADs before sending anything. An
        // offset past the local file is the stale/foreign-resource case above,
        // just detected mid-transfer — fail closed, don't "complete".
        const responseOffset = Number(headerValue(result.headers, 'upload-offset'));
        if (!Number.isFinite(responseOffset) || responseOffset <= offset) {
          throw new TusUploadError('Server acknowledged a chunk without a usable Upload-Offset', {
            retryable: true,
          });
        }
        if (responseOffset > totalBytes) {
          throw new TusUploadError(
            `Server reports more bytes (${responseOffset}) than the local file has (${totalBytes})`,
            { retryable: false },
          );
        }
        offset = responseOffset;
        opts.onProgress?.({ bytesSent: offset, totalBytes });
      }
    }, opts.signal);

  let resourceUrl = opts.resourceUrl ?? null;
  // Whether the URL in hand was recovered from a 409 rather than created/persisted —
  // such a URL has the same "may be stale" standing as a persisted one, so the
  // gone-mid-transfer recreate below applies to it too.
  let adopted = false;
  if (!resourceUrl) {
    try {
      resourceUrl = await createFresh();
    } catch (err) {
      // 409 on create = the server already holds a reservation for this artifactId.
      // That's the signature of a kill in the POST→persist window (the reservation
      // exists server-side but this client lost the Location handle). The upload id
      // is deterministic on pulsevault, so instead of dead-ending — the old behavior
      // forced the user to re-pair — derive the resource URL and, if the server
      // confirms it's live (HEAD returns an offset), resume it. If the derived URL
      // isn't live (non-pulsevault server, or genuinely conflicting state), surface
      // the original 409 unchanged.
      const conflict = err instanceof TusUploadError && err.statusCode === 409;
      const derived = conflict
        ? deriveUploadResourceUrl(opts.server, opts.kind, opts.artifactId, opts.filename)
        : null;
      if (!derived) throw err;
      try {
        await fetchOffset(derived, opts.token, opts.signal, fetchImpl);
      } catch (offsetErr) {
        // Cancellation mid-probe is the caller's abort, not a "derived URL
        // isn't live" verdict — surface it instead of the original 409, or
        // the manager would record a terminal conflict for a user cancel.
        if (isAbortError(offsetErr)) throw offsetErr;
        // Not resumable — but a 409 whose upload is GONE often means the
        // upload already finished (finished tus uploads stop answering HEAD).
        // If the artifact serves, adopt it as complete instead of failing.
        const done = await probeArtifactReady(
          opts.server,
          opts.artifactId,
          opts.token,
          fetchImpl,
          opts.signal,
        );
        if (!done) throw err;
        const artifactsUrl = `${opts.server}/artifacts/${opts.artifactId}`;
        await opts.onResourceCreated?.(artifactsUrl);
        opts.onProgress?.({ bytesSent: totalBytes, totalBytes });
        return { resourceUrl: artifactsUrl };
      }
      resourceUrl = derived;
      adopted = true;
    }
  }
  // Awaited so the caller's resume-state persist is durable BEFORE any byte moves —
  // a kill after this point resumes via HEAD instead of re-creating (409).
  await opts.onResourceCreated?.(resourceUrl);

  try {
    await transfer(resourceUrl);
  } catch (err) {
    // A 404/410 on a PERSISTED (or 409-adopted) resource URL means the server no
    // longer knows this upload — retention cleanup, wiped storage, a rebuilt
    // datastore. Standard TUS client behavior is to start over with a fresh create
    // (the artifactId is unchanged, so the session's authorization still applies)
    // rather than surface a terminal "rejected". Only safe when we were resuming a
    // stored/derived URL: a 404 on a URL the server just handed us in this run is a
    // real error and still propagates.
    const uploadGone =
      err instanceof TusUploadError && (err.statusCode === 404 || err.statusCode === 410);
    if ((!opts.resourceUrl && !adopted) || !uploadGone) throw err;
    resourceUrl = await createFresh();
    await opts.onResourceCreated?.(resourceUrl);
    await transfer(resourceUrl);
  }

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
  // non-2xx means the reservation may still be live server-side — callers that plan to
  // re-create under the same artifactId must not proceed as if it were freed (409).
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new TusUploadError(`Cancel failed with HTTP ${res.status}`, {
      retryable: res.status >= 500 || res.status === 429,
      statusCode: res.status,
    });
  }
}
