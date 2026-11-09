import { describe, expect, it } from '@jest/globals';

import { parseUploadDeepLink } from './deep-link';

const ARTIFACT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('parseUploadDeepLink', () => {
  it('accepts a well-formed https link', () => {
    const result = parseUploadDeepLink(
      `pulsecam://?v=1&artifactId=${ARTIFACT_ID}&server=https%3A%2F%2Fvault.example.org&token=secret`,
    );
    expect(result).toEqual({
      ok: true,
      link: {
        artifactId: ARTIFACT_ID,
        server: 'https://vault.example.org',
        token: 'secret',
      },
    });
  });

  it('accepts a link with no token', () => {
    const result = parseUploadDeepLink(
      `pulsecam://?v=1&artifactId=${ARTIFACT_ID}&server=https%3A%2F%2Fvault.example.org`,
    );
    expect(result).toEqual({
      ok: true,
      link: { artifactId: ARTIFACT_ID, server: 'https://vault.example.org', token: null },
    });
  });

  it('rejects a link with the wrong scheme', () => {
    expect(parseUploadDeepLink('https://vault.example.org?v=1')).toEqual({
      ok: false,
      reason: 'invalid-link',
    });
  });

  it('rejects an unrecognized version', () => {
    const result = parseUploadDeepLink(
      `pulsecam://?v=99&artifactId=${ARTIFACT_ID}&server=https%3A%2F%2Fvault.example.org`,
    );
    expect(result).toEqual({ ok: false, reason: 'unsupported-version' });
  });

  it('rejects a missing or malformed artifactId', () => {
    expect(parseUploadDeepLink('pulsecam://?v=1&server=https%3A%2F%2Fvault.example.org')).toEqual({
      ok: false,
      reason: 'invalid-link',
    });
    expect(
      parseUploadDeepLink(
        'pulsecam://?v=1&artifactId=not-a-uuid&server=https%3A%2F%2Fvault.example.org',
      ),
    ).toEqual({ ok: false, reason: 'invalid-link' });
  });

  it('rejects a plain-http origin that is not localhost or a private IP', () => {
    const result = parseUploadDeepLink(
      `pulsecam://?v=1&artifactId=${ARTIFACT_ID}&server=http%3A%2F%2Fvault.example.org`,
    );
    expect(result).toEqual({ ok: false, reason: 'invalid-link' });
  });

  it('accepts the http localhost/private-IP dev allowance', () => {
    for (const origin of [
      'http://localhost:3030',
      'http://127.0.0.1:3030',
      'http://192.168.1.50:3030',
      'http://10.0.0.5:3030',
      'http://172.20.0.5:3030',
      'http://100.70.33.184:3030', // RFC 6598 carrier-grade-NAT space — some mesh routers/ISPs use this for the LAN
      'http://169.254.1.1:3030',
    ]) {
      const result = parseUploadDeepLink(
        `pulsecam://?v=1&artifactId=${ARTIFACT_ID}&server=${encodeURIComponent(origin)}`,
      );
      expect(result.ok).toBe(true);
    }
  });

  it('preserves the server path prefix (not just the bare origin)', () => {
    const result = parseUploadDeepLink(
      `pulsecam://?v=1&artifactId=${ARTIFACT_ID}&server=${encodeURIComponent('https://vault.example.org/pulsevault/')}`,
    );
    expect(result).toEqual({
      ok: true,
      link: {
        artifactId: ARTIFACT_ID,
        server: 'https://vault.example.org/pulsevault',
        token: null,
      },
    });
  });

  it('rejects an unparseable server value', () => {
    const result = parseUploadDeepLink(
      `pulsecam://?v=1&artifactId=${ARTIFACT_ID}&server=not-a-url`,
    );
    expect(result).toEqual({ ok: false, reason: 'invalid-link' });
  });

  it('ignores an uploadUnit param from an older server, whatever its value', () => {
    for (const uploadUnit of ['segment', 'merged', 'bogus']) {
      const result = parseUploadDeepLink(
        `pulsecam://?v=1&artifactId=${ARTIFACT_ID}&server=https%3A%2F%2Fvault.example.org&uploadUnit=${uploadUnit}`,
      );
      expect(result).toEqual({
        ok: true,
        link: { artifactId: ARTIFACT_ID, server: 'https://vault.example.org', token: null },
      });
    }
  });
});

/** An upload token as PulseVault shapes one (unsigned here: the app never verifies). */
function uploadToken(claims: Record<string, unknown> = {}): string {
  const payload = Buffer.from(
    JSON.stringify({
      artifactId: ARTIFACT_ID,
      iat: 1,
      exp: 4_000_000_000,
      kid: 'k',
      issuer: 'i',
      ...claims,
    }),
    'utf8',
  ).toString('base64url');
  return `${payload}.sig`;
}

describe('parseUploadDeepLink: a link for a place', () => {
  const SERVER = encodeURIComponent('https://vault.example.org/pulsevault/');
  const RETURN = encodeURIComponent('https://timehuddle.example.org/app/huddle?team=t1');
  const FOR_HUDDLE = uploadToken({ ref: 'u1:huddle:t1' });
  const link = (token: string, extra = '') =>
    `pulsecam://?v=1&artifactId=${ARTIFACT_ID}&server=${SERVER}&token=${token}${extra}`;
  const placeOf = (url: string) => {
    const result = parseUploadDeepLink(url);
    return result.ok ? result.link.place : 'refused';
  };

  it('reads the place from the token’s ref claim, with the link’s hints', () => {
    const result = parseUploadDeepLink(
      link(
        FOR_HUDDLE,
        `&label=${encodeURIComponent('Team · Huddle')}&name=Huddle%20update&app=TimeHuddle&return=${RETURN}`,
      ),
    );
    expect(result).toEqual({
      ok: true,
      link: {
        artifactId: ARTIFACT_ID,
        server: 'https://vault.example.org/pulsevault',
        token: FOR_HUDDLE,
        place: {
          ref: 'u1:huddle:t1',
          label: 'Team · Huddle',
          name: 'Huddle update',
          app: 'TimeHuddle',
          returnUrl: 'https://timehuddle.example.org/app/huddle?team=t1',
        },
      },
    });
  });

  it('a QR link carries only a label and a name; one with no hints still has its place', () => {
    expect(placeOf(link(FOR_HUDDLE, '&label=Huddle&name=Update'))).toEqual({
      ref: 'u1:huddle:t1',
      label: 'Huddle',
      name: 'Update',
      app: null,
      returnUrl: null,
    });
    expect(placeOf(link(FOR_HUDDLE))).toEqual({
      ref: 'u1:huddle:t1',
      label: null,
      name: null,
      app: null,
      returnUrl: null,
    });
  });

  it('never reads the place from the URL: a `ref` param is ignored', () => {
    expect(placeOf(link(FOR_HUDDLE, '&ref=someone-else'))).toMatchObject({ ref: 'u1:huddle:t1' });
    expect(placeOf(link(uploadToken(), '&ref=u1%3Ahuddle%3At1&label=Huddle'))).toBeUndefined();
  });

  it('is a plain link, hints ignored, without a readable ref claim', () => {
    const hints = '&label=Huddle&name=Update&app=TimeHuddle';
    for (const token of [uploadToken(), uploadToken({ ref: '' }), 'opaque-token']) {
      expect(parseUploadDeepLink(link(token, hints))).toEqual({
        ok: true,
        link: { artifactId: ARTIFACT_ID, server: 'https://vault.example.org/pulsevault', token },
      });
    }
    // And with no token at all.
    expect(
      placeOf(`pulsecam://?v=1&artifactId=${ARTIFACT_ID}&server=${SERVER}&label=Huddle`),
    ).toBeUndefined();
  });

  it('trims and caps the names, and drops a blank one', () => {
    expect(
      placeOf(
        link(FOR_HUDDLE, `&label=${'L'.repeat(80)}&name=${'N'.repeat(100)}&app=${'A'.repeat(40)}`),
      ),
    ).toMatchObject({ label: 'L'.repeat(60), name: 'N'.repeat(80), app: 'A'.repeat(30) });
    expect(
      placeOf(link(FOR_HUDDLE, `&label=%20%20&name=${encodeURIComponent('  Huddle update ')}`)),
    ).toMatchObject({ label: null, name: 'Huddle update' });
  });

  it('keeps an https return URL (or http on a private origin) and drops any other', () => {
    const returning = (url: string) => {
      const place = placeOf(link(FOR_HUDDLE, `&return=${encodeURIComponent(url)}`));
      return typeof place === 'object' ? place.returnUrl : place;
    };
    expect(returning('https://host.example.org/page')).toBe('https://host.example.org/page');
    expect(returning('http://localhost:3000/app')).toBe('http://localhost:3000/app');
    expect(returning('http://host.example.org/page')).toBeNull();
    expect(returning('javascript:alert(1)')).toBeNull();
  });

  it('reads the same from the https link form', () => {
    const result = parseUploadDeepLink(
      `https://links.example.org/pulse/open#v=1&artifactId=${ARTIFACT_ID}&server=${SERVER}&token=${FOR_HUDDLE}&label=Huddle`,
      'links.example.org',
    );
    expect(result.ok && result.link.place).toMatchObject({ ref: 'u1:huddle:t1', label: 'Huddle' });
  });
});
