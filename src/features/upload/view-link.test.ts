import { describe, expect, it, jest } from '@jest/globals';

import { requestViewLink } from './view-link';

const SERVER = 'https://vault.example.test/pulsevault';
const ARTIFACT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** A fetch that answers every request with `response`, recording what was asked. */
function fetchAnswering(response: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return response();
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('requestViewLink', () => {
  it('asks with the pairing token and builds a watch link from the view token', async () => {
    const { fetchImpl, calls } = fetchAnswering(() =>
      json({ token: 'read/only+token', expiresAt: 2_000_000_000 }),
    );
    const link = await requestViewLink({
      server: SERVER,
      artifactId: ARTIFACT_ID,
      token: 'pairing',
      fetchImpl,
    });

    expect(link).toEqual({
      url: `${SERVER}/artifacts/${ARTIFACT_ID}?token=read%2Fonly%2Btoken`,
      expiresAt: 2_000_000_000_000,
    });
    expect(calls[0].url).toBe(`${SERVER}/artifacts/${ARTIFACT_ID}/view-link`);
    expect(calls[0].init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer pairing');
  });

  it.each([
    ['a server without view links (404)', () => json({ ok: false, error: 'Not enabled' }, 404)],
    ['a refusal (403)', () => json({ ok: false, error: 'No view link' }, 403)],
    ['a redirect, never followed with the token', () => new Response(null, { status: 302 })],
    ['a body without a token', () => json({ expiresAt: 2_000_000_000 })],
    ['a body without an expiry', () => json({ token: 't' })],
    ['a body that is not JSON', () => new Response('nope', { status: 200 })],
  ])('resolves null for %s', async (_, response) => {
    const { fetchImpl } = fetchAnswering(response);
    await expect(
      requestViewLink({ server: SERVER, artifactId: ARTIFACT_ID, token: 'pairing', fetchImpl }),
    ).resolves.toBeNull();
  });

  it('resolves null when the network fails', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    await expect(
      requestViewLink({ server: SERVER, artifactId: ARTIFACT_ID, token: 'pairing', fetchImpl }),
    ).resolves.toBeNull();
  });
});
