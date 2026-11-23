import { clientHeaders } from './client-identity';

const TOKEN_CHECK_TIMEOUT_MS = 8000;

/**
 * What the server made of a link's token (PROTOCOL.md §5.6): it `accepted` it (200), it `refused`
 * it (401/403: forged, changed, or expired by the server's clock), or it didn't say (`unknown`: a
 * 404 from a server without the status route, a 5xx, a redirect). Unknown is never accepted.
 */
export type TokenCheck = 'accepted' | 'refused' | 'unknown';

/**
 * Asks the server whether it accepts a link's token, with the status request for the link's
 * upload (PROTOCOL.md §6.5), which changes nothing. A client can't verify the `ref` it read from
 * a token — it has no key — so the `ref` is unconfirmed until the server has accepted that token,
 * and an unconfirmed `ref` never replaces the link a place holds (§5.6). The token is sent
 * exactly as the link carried it, in the `Authorization` header only: a request's URL is what
 * servers and proxies log.
 *
 * Rejects when the server gives no answer (or `signal` aborts): that is `unknown` too, for the
 * caller to say. A redirect is never followed with the token.
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
  const res = await fetchImpl(`${server}/artifacts/${encodeURIComponent(artifactId)}/status`, {
    method: 'GET',
    redirect: 'manual',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { ...clientHeaders(), Authorization: `Bearer ${token}` },
  });
  if (res.status === 200) return 'accepted';
  if (res.status === 401 || res.status === 403) return 'refused';
  return 'unknown';
}
