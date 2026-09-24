import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { checkCapabilities } from './capabilities';
import { APP_PROTOCOL } from './client-identity';

const respond = (body: unknown) =>
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

const range = (min: number, max: number, extra: Record<string, unknown> = {}) => ({
  protocolVersion: max,
  minSupportedVersion: min,
  maxSupportedVersion: max,
  ...extra,
});

describe('checkCapabilities', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('speaks protocols 1–2 (package.json pulseProtocol)', () => {
    expect(APP_PROTOCOL).toEqual({ min: 1, max: 2 });
  });

  it('pairs with a protocol 1 server, ignoring the uploadUnit it still sends', async () => {
    respond(range(1, 1, { uploadUnit: 'segment' }));
    await expect(checkCapabilities('https://vault.example.org')).resolves.toEqual({
      ok: true,
      capabilities: { protocolVersion: 1, minSupportedVersion: 1, maxSupportedVersion: 1 },
      protocol: 1,
    });
  });

  it('pairs with a protocol 2 server and keeps its revision', async () => {
    respond(range(2, 2, { protocolRevision: '2.1' }));
    await expect(checkCapabilities('https://vault.example.org')).resolves.toEqual({
      ok: true,
      capabilities: {
        protocolVersion: 2,
        minSupportedVersion: 2,
        maxSupportedVersion: 2,
        protocolRevision: '2.1',
      },
      protocol: 2,
    });
  });

  it('speaks the highest protocol both sides support', async () => {
    respond(range(1, 3));
    const result = await checkCapabilities('https://vault.example.org');
    expect(result.ok && result.protocol).toBe(2);
  });

  it('refuses a server that only speaks newer protocols (the app is too old)', async () => {
    respond(range(3, 3));
    await expect(checkCapabilities('https://vault.example.org')).resolves.toEqual({
      ok: false,
      reason: 'version-too-old',
    });
  });

  it('refuses a server older than anything the app speaks (the server is too old)', async () => {
    respond(range(0, 0));
    await expect(checkCapabilities('https://vault.example.org')).resolves.toEqual({
      ok: false,
      reason: 'version-too-new',
    });
  });

  it('treats a body without a version range as unreachable', async () => {
    respond({ protocolVersion: 1 });
    await expect(checkCapabilities('https://vault.example.org')).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('sends the Pulse-Client header', async () => {
    const fetchSpy = respond(range(2, 2));
    await checkCapabilities('https://vault.example.org');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Pulse-Client']).toMatch(/; protocol=1-2$/);
  });

  describe('with a cancel signal', () => {
    /** A fetch that hangs until its signal aborts, like a slow server. */
    const hang = () =>
      jest.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          }),
      );

    it('stops waiting as soon as the signal aborts, with an AbortError', async () => {
      hang();
      const controller = new AbortController();
      const check = checkCapabilities('https://vault.example.org', controller.signal);
      controller.abort();
      await expect(check).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('still reports a failed request as unreachable when the signal is live', async () => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network request failed'));
      await expect(
        checkCapabilities('https://vault.example.org', new AbortController().signal),
      ).resolves.toEqual({ ok: false, reason: 'unreachable' });
    });
  });
});
