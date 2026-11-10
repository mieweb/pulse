import { clientHeaders } from './client-identity';

const TOKEN_CHECK_TIMEOUT_MS = 8000;

/**
 * What the server made of a link's token: it `accepted` it, it `refused` it (401/403: forged,
 * changed, or expired by the server's clock), or it didn't say (`unknown`: a server without the
 * status route, or an answer that is about something else).
 */
export type TokenCheck = 'accepted' | 'refused' | 'unknown';

/**
 * Asks the server whether it accepts a link's token, with the status request (PROTOCOL.md §6.5),
 * which changes nothing. A client can't verify the `ref` it read from a token — it has no key —
 * and must treat it as unconfirmed until the server has accepted that token on a request (§5.6):
 * so before a link for a place takes over that place's row, the server is asked. The token is
 * sent exactly as the link carried it.
 *
 * Rejects when the server can't be reached (or `signal` aborts). A redirect is never followed
 * with the token; it reads as `unknown`.
 */
export async function checkToken(opts: {
  server: string;
  artifactId: string;
  token: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<TokenCheck> {
  const { server, artifactId, token, signal } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(TOKEN_CHECK_TIMEOUT_MS);
  const res = await fetchImpl(
    // Both ways a server reads a token on a GET (§5.1).
    `${server}/artifacts/${encodeURIComponent(artifactId)}/status?token=${encodeURIComponent(token)}`,
    {
      method: 'GET',
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { ...clientHeaders(), Authorization: `Bearer ${token}` },
    },
  );
  if (res.status === 200) return 'accepted';
  if (res.status === 401 || res.status === 403) return 'refused';
  return 'unknown';
}
