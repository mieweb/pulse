import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { checkCapabilities } from './capabilities';

const respond = (body: unknown) =>
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

describe('checkCapabilities', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('pairs with a server whose /capabilities has no uploadUnit', async () => {
    respond({ protocolVersion: 1, minSupportedVersion: 1, maxSupportedVersion: 1 });
    await expect(checkCapabilities('https://vault.example.org')).resolves.toEqual({
      ok: true,
      capabilities: { protocolVersion: 1, minSupportedVersion: 1, maxSupportedVersion: 1 },
    });
  });

  it('ignores an uploadUnit from an older server', async () => {
    respond({
      protocolVersion: 1,
      minSupportedVersion: 1,
      maxSupportedVersion: 1,
      uploadUnit: 'segment',
    });
    await expect(checkCapabilities('https://vault.example.org')).resolves.toEqual({
      ok: true,
      capabilities: { protocolVersion: 1, minSupportedVersion: 1, maxSupportedVersion: 1 },
    });
  });

  it('treats a body without a version range as unreachable', async () => {
    respond({ protocolVersion: 1 });
    await expect(checkCapabilities('https://vault.example.org')).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });
});
