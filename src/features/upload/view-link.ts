import { clientHeaders } from './client-identity';
import type { ViewLinkResponse } from './protocol.gen';

/** A shareable, read-only link to an uploaded video (PROTOCOL.md §6.4). */
export type ViewLink = {
  url: string;
  /** When the link stops working, in ms since the epoch. */
  expiresAt: number;
};

/**
 * Asks the server for a read-only view link to a finished artifact (protocol 2.2), with the
 * pairing `token` — right after the upload, while that token is still valid. The link opens the
 * video and does nothing else, so unlike the pairing token it's safe to share.
 *
 * Resolves `null` on any failure (including a redirect, which is never followed with the token):
 * a link is a nicety, never a reason to fail an upload.
 */
export async function requestViewLink(opts: {
  server: string;
  artifactId: string;
  token: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ViewLink | null> {
  const { server, artifactId, token, signal } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${server}/artifacts/${encodeURIComponent(artifactId)}/view-link`, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: { ...clientHeaders(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (res.status !== 200) return null;
    const body = (await res.json()) as Partial<ViewLinkResponse>;
    if (typeof body.token !== 'string' || body.token === '') return null;
    if (typeof body.expiresAt !== 'number' || !Number.isSafeInteger(body.expiresAt)) return null;
    return {
      url: `${server}/artifacts/${encodeURIComponent(artifactId)}?token=${encodeURIComponent(body.token)}`,
      expiresAt: body.expiresAt * 1000,
    };
  } catch {
    return null;
  }
}
