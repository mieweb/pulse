/**
 * The fake's real upload path (server mode): a TUS create + one PATCH to a PulseVault `endpoint`
 * and the status route poll (PulseVault PROTOCOL.md §4, §6.5), over `fetch` only. No tus-js-client:
 * the fake uploads a small fixture in one PATCH, so resumption, chunking and retries are left to the
 * real runner (PR2-H). Every request carries the capability token as `Authorization: Bearer`.
 */

/** The parts of a fetch Response this file reads; the global `fetch` satisfies it. */
export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export interface FetchInitLike {
  method: string;
  headers: Record<string, string>;
  body?: Blob | ArrayBuffer;
  signal?: AbortSignal;
  redirect?: 'manual';
}

export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;

export const TUS_VERSION = '1.0.0';

export type ArtifactKind = 'video' | 'project' | 'captions' | 'thumbnail';

export class TusError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'TusError';
    this.status = status;
  }
}

/** Bytes in a fixture. */
export function sizeOf(body: Blob | ArrayBuffer): number {
  return body instanceof ArrayBuffer ? body.byteLength : body.size;
}

/** base64 of a string's UTF-8 bytes (Upload-Metadata values, PROTOCOL.md §4.1). */
export function base64Utf8(value: string): string {
  let binary = '';
  for (const b of new TextEncoder().encode(value)) binary += String.fromCharCode(b);
  return btoa(binary);
}

export interface ArtifactUpload {
  endpoint: string;
  token: string;
  artifactId: string;
  filename: string;
  kind: ArtifactKind;
  /** The video this artifact belongs to (captions, beats, thumbnail). */
  relatedTo?: string;
  /** Display title, sent on the video only. */
  name?: string;
  body: Blob | ArrayBuffer;
  fetch: FetchLike;
  signal?: AbortSignal;
}

/** `Upload-Metadata`: comma-separated `key base64(value)` pairs. */
export function uploadMetadata(u: Omit<ArtifactUpload, 'endpoint' | 'token' | 'body' | 'fetch'>) {
  const pairs: [string, string | undefined][] = [
    ['artifactId', u.artifactId],
    ['filename', u.filename],
    ['kind', u.kind],
    ['relatedTo', u.relatedTo],
    ['name', u.name],
  ];
  return pairs
    .filter((p): p is [string, string] => typeof p[1] === 'string' && p[1] !== '')
    .map(([k, v]) => `${k} ${base64Utf8(v)}`)
    .join(',');
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * The server's `Location`, resolved against the endpoint and kept on its origin: a Location on
 * another host would receive the token with every PATCH (PROTOCOL.md §4.3).
 */
function resolveLocation(location: string, endpoint: string): string {
  const url = new URL(location, endpoint);
  if (url.origin !== new URL(endpoint).origin) {
    throw new TusError('The upload location is on another origin.');
  }
  return url.toString();
}

/** Creates the upload and sends the whole body in one PATCH. Resolves with the upload's URL. */
export async function uploadArtifact(u: ArtifactUpload): Promise<string> {
  const length = sizeOf(u.body);
  const created = await u.fetch(`${u.endpoint}/upload`, {
    method: 'POST',
    redirect: 'manual',
    signal: u.signal,
    headers: {
      'Tus-Resumable': TUS_VERSION,
      'Upload-Length': String(length),
      'Upload-Metadata': uploadMetadata(u),
      ...auth(u.token),
    },
  });
  if (created.status !== 201) {
    throw new TusError(`Could not start the upload (${created.status}).`, created.status);
  }
  const location = created.headers.get('location');
  if (!location) throw new TusError('The server gave no upload location.', created.status);
  const url = resolveLocation(location, u.endpoint);
  const patched = await u.fetch(url, {
    method: 'PATCH',
    redirect: 'manual',
    signal: u.signal,
    body: u.body,
    headers: {
      'Tus-Resumable': TUS_VERSION,
      'Upload-Offset': '0',
      'Content-Type': 'application/offset+octet-stream',
      ...auth(u.token),
    },
  });
  if (patched.status !== 204) {
    throw new TusError(`The upload failed (${patched.status}).`, patched.status);
  }
  const offset = patched.headers.get('upload-offset');
  if (offset !== String(length)) {
    throw new TusError(`The server holds ${String(offset)} of ${length} bytes.`, patched.status);
  }
  return url;
}

/** What the host recorded for the video (huddle-server.md §7): `{state:'done', note}` or `{state:'kept', reason}`. */
export interface StatusOutcome {
  state: 'done' | 'kept';
  note?: string;
  reason?: string;
  uploadId?: string;
}

export function readOutcome(body: unknown): StatusOutcome | null {
  if (typeof body !== 'object' || body === null) return null;
  const outcome = (body as { outcome?: unknown }).outcome;
  if (typeof outcome !== 'object' || outcome === null) return null;
  const o = outcome as Record<string, unknown>;
  if (o.state !== 'done' && o.state !== 'kept') return null;
  return {
    state: o.state,
    ...(typeof o.note === 'string' ? { note: o.note } : {}),
    ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
    ...(typeof o.uploadId === 'string' ? { uploadId: o.uploadId } : {}),
  };
}

export interface StatusPoll {
  endpoint: string;
  artifactId: string;
  /** Read before every request, so a refreshed token is used from the next one. */
  token: () => string;
  fetch: FetchLike;
  pollMs: number;
  /** Asked on a 401: the host's refreshUploadToken. A rejection stops the poll. */
  refresh: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** False stops the poll (the job was canceled or the fake disposed). */
  live: () => boolean;
}

/**
 * Polls `GET <endpoint>/artifacts/<id>/status` until the host has recorded an outcome. Resolves
 * null when `live()` turns false first. Any other answer (processing, a 5xx, no outcome yet) waits
 * `pollMs` and asks again.
 */
export async function pollOutcome(p: StatusPoll): Promise<StatusOutcome | null> {
  while (p.live()) {
    const res = await p.fetch(
      `${p.endpoint}/artifacts/${encodeURIComponent(p.artifactId)}/status`,
      {
        method: 'GET',
        redirect: 'manual',
        headers: { 'Cache-Control': 'no-cache', ...auth(p.token()) },
      },
    );
    if (!p.live()) return null;
    if (res.status === 200) {
      const outcome = readOutcome(await res.json());
      if (outcome) return outcome;
    } else if (res.status === 401) {
      await p.refresh();
      continue;
    }
    await p.sleep(p.pollMs);
  }
  return null;
}
