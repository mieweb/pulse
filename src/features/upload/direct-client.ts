import type { File } from 'expo-file-system';

import type { ArtifactKind, TusUploadProgress } from './tus-client';
import {
  artifactUrl,
  authHeaders,
  isAbortError,
  rejectRedirect,
  statusError,
  TusUploadError,
  withRetry,
} from './tus-client';

/**
 * Client for pulsevault's PROTOCOL §9 direct-upload profile: ask the server
 * for a presigned PUT grant, upload the bytes straight to object storage (the
 * data plane never touches the app server), then confirm with `complete`.
 *
 * Trade vs TUS, honestly: the PUT is one shot — retryable from zero, not
 * resumable mid-file. The upload manager picks this transport when the
 * pairing advertised `directUpload`; TUS is the default everywhere else.
 *
 * Within one run, trouble is absorbed by grant cycles: a rejected/failed PUT
 * gets a FRESH grant (§9.1 re-grant) and tries again. Anything terminal
 * escapes to the manager, which burns the single-shot pairing — a grant 409
 * (artifactId already used) is exactly that.
 */

/** Performs the byte-carrying PUT to the presigned URL. Injected (native upload task in production, a fake in tests) for the same reasons as `UploadChunk` in tus-client. */
export type UploadFile = (params: {
  uploadUrl: string;
  headers: Record<string, string>;
  file: File;
  signal?: AbortSignal;
  onProgress?: (bytesSent: number) => void;
}) => Promise<{ status: number }>;

export type DirectUploadOptions = {
  /** Full base URL including the operator's path prefix — e.g. `https://vault.example.org/pulsevault`. */
  server: string;
  token: string | null;
  artifactId: string;
  filename: string;
  kind: ArtifactKind;
  relatedTo?: string;
  checksum?: string;
  name?: string;
  file: File;
  /** Awaited before any byte moves — receives the durable artifact URL used for cancel/invalidate. */
  onResourceCreated?: (resourceUrl: string) => void | Promise<void>;
  signal?: AbortSignal;
  onProgress?: (progress: TusUploadProgress) => void;
  fetchImpl?: typeof fetch;
  uploadFile: UploadFile;
};

export type DirectUploadResult = { resourceUrl: string };

type Grant = { uploadUrl: string; headers: Record<string, string> };

/** How many grant→PUT→complete cycles to attempt before giving up (each inner step already retries transients). */
const MAX_GRANT_CYCLES = 2;

async function requestGrant(opts: DirectUploadOptions, fetchImpl: typeof fetch): Promise<Grant> {
  const res = await fetchImpl(`${opts.server}/direct-uploads`, {
    method: 'POST',
    redirect: 'manual',
    signal: opts.signal,
    headers: { 'content-type': 'application/json', ...authHeaders(opts.token) },
    body: JSON.stringify({
      artifactId: opts.artifactId,
      filename: opts.filename,
      kind: opts.kind,
      relatedTo: opts.relatedTo,
      checksum: opts.checksum,
      name: opts.name,
      size: opts.file.size ?? 0,
    }),
  });
  rejectRedirect(res);
  // 201 = fresh reservation, 200 = re-grant for our own incomplete upload —
  // both carry a usable grant.
  if (res.status !== 201 && res.status !== 200) {
    throw await statusError(res, `Could not start the upload (${res.status})`);
  }
  const body = (await res.json()) as Partial<Grant>;
  if (typeof body.uploadUrl !== 'string' || !body.uploadUrl) {
    throw new TusUploadError('Server did not return an upload URL', { retryable: false });
  }
  return { uploadUrl: body.uploadUrl, headers: body.headers ?? {} };
}

async function requestComplete(
  opts: DirectUploadOptions,
  fetchImpl: typeof fetch,
): Promise<'done' | 'object-missing'> {
  const res = await fetchImpl(`${opts.server}/direct-uploads/${opts.artifactId}/complete`, {
    method: 'POST',
    redirect: 'manual',
    signal: opts.signal,
    headers: authHeaders(opts.token),
  });
  rejectRedirect(res);
  if (res.ok) return 'done';
  // 409 = the PUT never landed (or the object vanished) — the caller runs
  // another grant→PUT cycle rather than surfacing an error.
  if (res.status === 409) return 'object-missing';
  throw await statusError(res, `Could not finish the upload (${res.status})`);
}

/**
 * Upload one artifact via the direct-upload profile. Progress ticks come from
 * the native PUT task; there is no server-acknowledged offset in this profile,
 * so the bar is display-only until `complete` returns.
 */
export async function uploadViaDirect(opts: DirectUploadOptions): Promise<DirectUploadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const totalBytes = opts.file.size ?? 0;
  const resourceUrl = artifactUrl(opts.server, opts.artifactId);

  // The cancel handle, reported before any byte moves — same discipline as
  // the tus path's resource URL (in-memory only; identities are single-shot).
  await opts.onResourceCreated?.(resourceUrl);

  // Why the last cycle gave up — one exit below reports it.
  let failure: { message: string; statusCode?: number } = { message: 'Upload failed' };

  for (let cycle = 1; cycle <= MAX_GRANT_CYCLES; cycle += 1) {
    const grant = await withRetry(() => requestGrant(opts, fetchImpl), opts.signal);

    // One PUT per grant cycle: a transient PUT failure gets a FRESH grant on
    // the next cycle (the old URL may have expired mid-transfer), so the
    // retry loop here only guards the request itself, not stale grants. That
    // covers REJECTIONS too — the native task rejects on transport failures
    // (network drop, TLS reset), which are exactly what the next cycle's
    // fresh grant exists for; only the caller's abort escapes unchanged.
    let status: number;
    try {
      ({ status } = await opts.uploadFile({
        uploadUrl: grant.uploadUrl,
        headers: grant.headers,
        file: opts.file,
        signal: opts.signal,
        onProgress: (bytesSent) =>
          opts.onProgress?.({ bytesSent: Math.min(bytesSent, totalBytes), totalBytes }),
      }));
    } catch (err) {
      if (isAbortError(err) || opts.signal?.aborted) throw err;
      const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
      failure = { message: `Upload failed${detail}` };
      continue;
    }
    if (status < 200 || status >= 300) {
      failure = { message: `Upload failed (${status})`, statusCode: status };
      continue;
    }

    opts.onProgress?.({ bytesSent: totalBytes, totalBytes });
    const completion = await withRetry(() => requestComplete(opts, fetchImpl), opts.signal);
    if (completion === 'done') return { resourceUrl };
    // Object missing server-side — grant again and re-PUT.
    failure = { message: 'Upload could not be confirmed by the server', statusCode: status };
  }

  // Every cycle is re-runnable from scratch — nothing about the request itself
  // is proven wrong — so the exhaustion surfaces as retryable.
  throw new TusUploadError(failure.message, { retryable: true, statusCode: failure.statusCode });
}
