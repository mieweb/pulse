import { describe, expect, it, jest } from '@jest/globals';

import { checkToken } from './token-check';

const SERVER = 'https://vault.example.org/pulsevault';
const ARTIFACT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN = 'claims+with/odd=chars.signature';

function answering(status: number) {
  return jest.fn<typeof fetch>(async () => ({ status }) as Response);
}

describe('checkToken', () => {
  it('asks the status route with the token unchanged, in the header and the query', async () => {
    const fetchImpl = answering(200);
    await checkToken({ server: SERVER, artifactId: ARTIFACT_ID, token: TOKEN, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      `${SERVER}/artifacts/${ARTIFACT_ID}/status?token=${encodeURIComponent(TOKEN)}`,
    );
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect((init?.headers as Record<string, string>)['Pulse-Client']).toMatch(/^Pulse\//);
  });

  it('reads the answer: accepted, refused, or nothing either way', async () => {
    const check = (status: number) =>
      checkToken({
        server: SERVER,
        artifactId: ARTIFACT_ID,
        token: TOKEN,
        fetchImpl: answering(status),
      });
    expect(await check(200)).toBe('accepted');
    expect(await check(401)).toBe('refused');
    expect(await check(403)).toBe('refused');
    // No status route, an outdated-client answer, a redirect, a server error: not a verdict.
    for (const status of [404, 405, 426, 302, 0, 500, 503])
      expect(await check(status)).toBe('unknown');
  });

  it('rejects when the server can’t be reached', async () => {
    const fetchImpl = jest.fn<typeof fetch>(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(
      checkToken({ server: SERVER, artifactId: ARTIFACT_ID, token: TOKEN, fetchImpl }),
    ).rejects.toThrow();
  });
});
