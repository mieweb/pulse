import { describe, expect, it } from '@jest/globals';

import { type DestinationRow, destinationOptions, isSpentLink } from './destination-options';

const NOW = 1_700_000_000_000;

function token(expMs: number): string {
  const claims = { artifactId: 'a', iat: 1, exp: Math.floor(expMs / 1000), kid: 'k', issuer: 'i' };
  return `${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.sig`;
}
const LIVE = token(NOW + 600_000);
const EXPIRED = token(NOW - 1000);

const row = (id: string, over: Partial<DestinationRow> = {}): DestinationRow => ({
  id,
  server: 'https://vault.example.org/pulsevault',
  artifactId: `art-${id}`,
  ref: null,
  label: null,
  app: null,
  returnUrl: null,
  ...over,
});

describe('isSpentLink', () => {
  it('is an expired link, of either kind', () => {
    expect(isSpentLink(null, EXPIRED, NOW)).toBe(true);
    expect(isSpentLink('r1', EXPIRED, NOW)).toBe(true);
    expect(isSpentLink(null, LIVE, NOW)).toBe(false);
    expect(isSpentLink('r1', LIVE, NOW)).toBe(false);
  });

  it('is a place’s row without its token, but not a plain link without one', () => {
    expect(isSpentLink('r1', null, NOW)).toBe(true);
    // A server without tokens pairs plain links that never have one.
    expect(isSpentLink(null, null, NOW)).toBe(false);
    expect(isSpentLink(null, 'opaque-token', NOW)).toBe(false);
  });
});

describe('destinationOptions', () => {
  it('offers the rows whose token has loaded and whose link still works, in order', () => {
    const rows = [row('new'), row('loading'), row('old'), row('dead')];
    const options = destinationOptions(rows, { new: LIVE, old: null, dead: EXPIRED }, NOW);
    expect(options.map((o) => o.id)).toEqual(['new', 'old']);
    expect(options[0]).toMatchObject({ token: LIVE, expiresAtMs: NOW + 600_000 });
    expect(options[1]).toMatchObject({ token: null, expiresAtMs: null, expiryLabel: 'No expiry' });
  });

  it('never offers a place’s row that has lost its token', () => {
    const rows = [row('place', { ref: 'r1' }), row('plain')];
    expect(destinationOptions(rows, { place: null, plain: null }, NOW).map((o) => o.id)).toEqual([
      'plain',
    ]);
  });

  it('cleans a stored row’s names and return URL again before they are shown', () => {
    const cp = String.fromCodePoint;
    const [option] = destinationOptions(
      [
        row('p', {
          ref: 'r1',
          label: `Team${cp(0x202e)}\nHuddle`,
          app: ' '.repeat(3),
          returnUrl: 'https://timehuddle.example.org@evil.example/',
        }),
      ],
      { p: LIVE },
      NOW,
    );
    expect(option).toMatchObject({ label: 'Team Huddle', app: null, returnUrl: null });
  });
});
