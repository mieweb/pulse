import { describe, expect, it } from '@jest/globals';

import {
  type DestinationRow,
  destinationOptions,
  destinationSpokenName,
  isSpentLink,
  placeLabelLookup,
  tokensKey,
} from './destination-options';

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

describe('tokensKey', () => {
  const stored = (id: string, artifactId: string, createdAt: number) => ({
    ...row(id, { artifactId }),
    createdAt,
  });

  it('changes when a place’s row takes a newer link in place, so its token is read again', () => {
    const before = tokensKey([stored('a', 'art-1', 100), stored('b', 'art-2', 50)]);

    // The same rows, read again: the cached tokens stand.
    expect(tokensKey([stored('a', 'art-1', 100), stored('b', 'art-2', 50)])).toBe(before);
    // Row `a` took a newer link: a new upload id, or the same one with a new token (a new time).
    expect(tokensKey([stored('a', 'art-3', 200), stored('b', 'art-2', 50)])).not.toBe(before);
    expect(tokensKey([stored('a', 'art-1', 200), stored('b', 'art-2', 50)])).not.toBe(before);
    // A row added or removed.
    expect(tokensKey([stored('a', 'art-1', 100)])).not.toBe(before);
  });
});

describe('placeLabelLookup', () => {
  const SERVER = 'https://vault.example.org/pulsevault';

  it('finds a place’s label by server and key, exactly', () => {
    const labels = placeLabelLookup([
      row('a', { ref: 'ticket%3A12', label: 'Ticket 12' }),
      row('b', { ref: 'huddle', label: 'Team · Huddle' }),
    ]);
    expect(labels(SERVER, 'ticket%3A12')).toBe('Ticket 12');
    expect(labels(SERVER, 'huddle')).toBe('Team · Huddle');
    expect(labels(SERVER, 'ticket:12')).toBeNull();
    expect(labels('https://other.example.org', 'huddle')).toBeNull();
  });

  it('has none for a draft with no place, a place with no row, or a row with no label', () => {
    const labels = placeLabelLookup([row('a', { ref: 'r1', label: null }), row('plain')]);
    expect(labels(null, null)).toBeNull();
    expect(labels(SERVER, null)).toBeNull();
    expect(labels(SERVER, 'r1')).toBeNull();
    expect(labels(SERVER, 'claimed-and-gone')).toBeNull();
  });

  it('follows the rows it is given: added, relabelled, removed', () => {
    const before = placeLabelLookup([]);
    const added = placeLabelLookup([row('a', { ref: 'r1', label: 'Huddle' })]);
    const relabelled = placeLabelLookup([row('a', { ref: 'r1', label: 'Team · Huddle' })]);
    const removed = placeLabelLookup([]);
    expect([before, added, relabelled, removed].map((labels) => labels(SERVER, 'r1'))).toEqual([
      null,
      'Huddle',
      'Team · Huddle',
      null,
    ]);
  });

  it('cleans a label before it titles a draft', () => {
    const cp = String.fromCodePoint;
    const labels = placeLabelLookup([row('a', { ref: 'r1', label: `Hud${cp(0x202e)}dle\n` })]);
    expect(labels(SERVER, 'r1')).toBe('Huddle');
  });
});

describe('destinationSpokenName', () => {
  it('always says the host, with the place’s label when it has one', () => {
    const server = 'https://vault.example.org/pulsevault';
    expect(destinationSpokenName({ server, label: null })).toBe('vault.example.org');
    expect(destinationSpokenName({ server, label: 'Team · Huddle' })).toBe(
      'Team · Huddle on vault.example.org',
    );
  });
});
