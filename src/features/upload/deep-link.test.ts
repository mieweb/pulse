import { describe, expect, it } from '@jest/globals';

import { parseUploadDeepLink, readReturnUrl } from './deep-link';

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

describe('parseUploadDeepLink: the server a link names', () => {
  const linkTo = (server: string) =>
    parseUploadDeepLink(
      `pulsecam://?v=1&artifactId=${ARTIFACT_ID}&server=${encodeURIComponent(server)}`,
    );

  it('holds the plain-http rule to the host, wherever else an address appears in the URL', () => {
    // Plain http to a public host, with a private address or localhost in its path or query.
    for (const server of [
      'http://evil.example/a@192.168.1.1',
      'http://evil.example/a@localhost',
      'http://evil.example?x@10.0.0.1',
      'http://evil.example#@127.0.0.1',
      'http://192.168.1.1@evil.example/',
    ]) {
      expect(linkTo(server)).toEqual({ ok: false, reason: 'invalid-link' });
    }
    // The real thing still pairs.
    expect(linkTo('http://192.168.1.1:3000/pulsevault').ok).toBe(true);
    expect(linkTo('http://localhost:3000').ok).toBe(true);
  });

  it('takes an address only as the parser writes one: a name that resembles one is no address', () => {
    for (const server of ['http://10.0.0.256', 'http://10.1.1.999', 'http://192.168.1.300']) {
      expect(linkTo(server)).toEqual({ ok: false, reason: 'invalid-link' });
    }
  });

  it('refuses a server URL with whitespace, a control character or a backslash', () => {
    const cp = String.fromCodePoint;
    for (const server of [
      // The parser reads a backslash as a slash; the string requests are built from keeps it.
      `https://good.example.org${cp(0x5c)}@evil.example/`,
      // It drops tabs and line breaks, and spaces at the ends.
      `https://good.example.org${cp(0x09)}.evil.example/`,
      `https://good.example.org/pulsevault${cp(0x0a)}`,
      ' https://good.example.org',
      'https://good.example.org /pulsevault',
      // Escaped, a control character is decoded into the host, where it can't be seen.
      'https://%7fgood.example.org/',
      'https://good.example.org%20/',
    ]) {
      expect(linkTo(server)).toEqual({ ok: false, reason: 'invalid-link' });
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
    ).toMatchObject({ label: 'L'.repeat(60), name: 'N'.repeat(40), app: 'A'.repeat(30) });
    expect(
      placeOf(link(FOR_HUDDLE, `&label=%20%20&name=${encodeURIComponent('  Huddle update ')}`)),
    ).toMatchObject({ label: null, name: 'Huddle update' });
  });

  it('counts a hint in code points, and cuts it at a whole character', () => {
    const hint = (key: string, value: string) => {
      const place = placeOf(link(FOR_HUDDLE, `&${key}=${encodeURIComponent(value)}`));
      return typeof place === 'object' ? place[key as 'label' | 'name' | 'app'] : place;
    };
    // Sixty emoji are sixty characters, though 120 UTF-16 units.
    expect(hint('label', '😀'.repeat(61))).toBe('😀'.repeat(60));
    expect(hint('app', '😀'.repeat(31))).toBe('😀'.repeat(30));
    // A family is one character to a person and seven code points: it stays whole or goes.
    const family = ['👨', '👩', '👧', '👦'].join(String.fromCodePoint(0x200d));
    expect(hint('label', 'L'.repeat(55) + family)).toBe('L'.repeat(55));
    expect(hint('label', 'L'.repeat(53) + family)).toBe('L'.repeat(53) + family);
    // So does a flag, a skin tone and a letter with its accent.
    expect(hint('app', 'A'.repeat(29) + '🇫🇷')).toBe('A'.repeat(29));
    expect(hint('app', 'A'.repeat(29) + '👍🏽')).toBe('A'.repeat(29));
    expect(hint('app', 'A'.repeat(29) + 'e' + String.fromCodePoint(0x301))).toBe('A'.repeat(29));
    // A draft's name takes 40 UTF-16 units: the link's name is cut to that, whole characters too.
    expect(hint('name', 'N'.repeat(39) + '😀')).toBe('N'.repeat(39));
    expect(hint('name', '😀'.repeat(50))).toBe('😀'.repeat(20));
  });

  it('shows a hint as one clean line: no control or text-direction characters', () => {
    const cp = String.fromCodePoint;
    const hint = (value: string) => {
      const place = placeOf(link(FOR_HUDDLE, `&label=${encodeURIComponent(value)}`));
      return typeof place === 'object' ? place.label : place;
    };
    // Control characters and line breaks, the Unicode line separators included, become one space.
    expect(hint(`Team\r\n\tHuddle${cp(0x2028)}${cp(0x2029)}today${cp(0x85)}x`)).toBe(
      'Team Huddle today x',
    );
    // Text-direction characters, which can reorder what is shown after them, are dropped.
    for (const bidi of [0x202e, 0x202d, 0x2066, 0x2067, 0x2069, 0x200e, 0x200f, 0x61c]) {
      expect(hint(`Team${cp(bidi)} Huddle`)).toBe('Team Huddle');
    }
    // Nothing a person can see is no label at all.
    for (const blank of [' ', '\n\n', cp(0x202e), cp(0x200b) + cp(0xfeff), `\t${cp(0x2066)} `]) {
      expect(hint(blank)).toBeNull();
    }
  });

  it('keeps an https return URL (or http on a private origin) and ignores any other', () => {
    const returning = (url: string) => {
      const place = placeOf(link(FOR_HUDDLE, `&return=${encodeURIComponent(url)}`));
      return typeof place === 'object' ? place.returnUrl : place;
    };
    expect(returning('https://host.example.org/page')).toBe('https://host.example.org/page');
    expect(returning('http://localhost:3000/app')).toBe('http://localhost:3000/app');
    expect(returning('http://host.example.org/page')).toBeNull();
    expect(returning('javascript:alert(1)')).toBeNull();
    expect(returning('pulsecam://?v=1')).toBeNull();
  });

  it('ignores a return URL with a username or password, or longer than 512 characters', () => {
    const returning = (url: string) => {
      const place = placeOf(link(FOR_HUDDLE, `&return=${encodeURIComponent(url)}`));
      return typeof place === 'object' ? place.returnUrl : place;
    };
    // Reads as the first host, opens the second.
    expect(returning('https://timehuddle.example.org@evil.example/')).toBeNull();
    expect(returning('https://user:secret@host.example.org/page')).toBeNull();
    expect(returning('https://:secret@host.example.org/page')).toBeNull();
    const base = 'https://host.example.org/';
    expect(returning(base + 'p'.repeat(512 - base.length))).toHaveLength(512);
    expect(returning(base + 'p'.repeat(513 - base.length))).toBeNull();
    // 512 characters are code points: an emoji in the path is one.
    expect(returning(base + '😀'.repeat(512 - base.length))).not.toBeNull();
  });

  it('ignores a return URL with whitespace, a control character or a backslash, like a server', () => {
    const cp = String.fromCodePoint;
    for (const url of [
      `https://good.example.org${cp(0x5c)}@evil.example/`,
      'https://good.example.org%2f@evil.example/',
      'https://good.example.org /page',
      `https://good.example.org/${cp(0x0a)}page`,
      'https://%7fgood.example.org/page',
      'https://',
    ]) {
      expect(readReturnUrl(url)).toBeNull();
    }
  });

  it('says which host a return URL opens', () => {
    expect(readReturnUrl('https://TimeHuddle.Example.org:8443/app?x=1#top')).toEqual({
      url: 'https://TimeHuddle.Example.org:8443/app?x=1#top',
      host: 'timehuddle.example.org:8443',
    });
    expect(readReturnUrl(null)).toBeNull();
    expect(readReturnUrl('')).toBeNull();
  });

  it('reads a place’s key of 1 to 200 code points, whatever its characters', () => {
    for (const ref of ['a%2Fb:c/d', '😀'.repeat(200), 'é'.repeat(200)]) {
      expect(placeOf(link(uploadToken({ ref })))).toMatchObject({ ref });
    }
    expect(placeOf(link(uploadToken({ ref: '😀'.repeat(201) })))).toBeUndefined();
  });

  it('decodes parameters as form-urlencoded UTF-8: a plus is a space, a value keeps its equals signs', () => {
    const result = parseUploadDeepLink(
      link(
        FOR_HUDDLE,
        '&label=Team+%C2%B7+Huddle&name=a%2Bb+c&return=https://host.example.org/app?team=t1',
      ),
    );
    expect(result.ok && result.link.place).toMatchObject({
      label: 'Team · Huddle',
      name: 'a+b c',
      returnUrl: 'https://host.example.org/app?team=t1',
    });
  });

  it('keeps a stray percent sign as written: a malformed escape is no error', () => {
    const label = (raw: string) => {
      const place = placeOf(link(FOR_HUDDLE, `&label=${raw}&name=Update`));
      return typeof place === 'object' ? [place.label, place.name] : place;
    };
    expect(label('100%')).toEqual(['100%', 'Update']);
    expect(label('%ZZ')).toEqual(['%ZZ', 'Update']);
    expect(label('50%25+off')).toEqual(['50% off', 'Update']);
    // Bytes that aren't UTF-8 decode to the replacement character, as form decoding says.
    expect(label('a%FFb')).toEqual([`a${String.fromCodePoint(0xfffd)}b`, 'Update']);
    expect(parseUploadDeepLink('pulsecam://?%=1&v=%')).toEqual({
      ok: false,
      reason: 'unsupported-version',
    });
  });

  it('refuses a link whose token can’t be sent, rather than pairing it without one', () => {
    const withToken = (token: string) =>
      parseUploadDeepLink(
        `pulsecam://?v=1&artifactId=${ARTIFACT_ID}&server=${SERVER}&token=${token}`,
      );
    for (const token of [
      '',
      'abc+def',
      'abc%20def',
      'abc%0D%0AX-Other:%201',
      'abc%FF',
      'abc%C3%A9',
    ]) {
      expect(withToken(token)).toEqual({ ok: false, reason: 'invalid-link' });
    }
    // A token of another shape is still a token: kept exactly, stray percent sign and all.
    for (const token of ['opaque', 'abc=def==', 'abc%zz.def', 'a.b.c']) {
      expect(withToken(token)).toMatchObject({ ok: true, link: { token } });
    }
  });

  it('takes the first value of a parameter given twice, usable or not', () => {
    expect(placeOf(link(FOR_HUDDLE, '&label=First&label=Second'))).toMatchObject({
      label: 'First',
    });
    for (const first of ['%ZZ', '', 'http://public.example.org']) {
      expect(
        parseUploadDeepLink(
          `pulsecam://?v=1&artifactId=${ARTIFACT_ID}&server=${first}&server=https://other.example.org`,
        ),
      ).toEqual({ ok: false, reason: 'invalid-link' });
    }
    expect(
      parseUploadDeepLink(`pulsecam://?v=2&v=1&artifactId=${ARTIFACT_ID}&server=${SERVER}`),
    ).toEqual({
      ok: false,
      reason: 'unsupported-version',
    });
  });

  it('reads the same from the https link form', () => {
    const result = parseUploadDeepLink(
      `https://links.example.org/pulse/open#v=1&artifactId=${ARTIFACT_ID}&server=${SERVER}&token=${FOR_HUDDLE}&label=Huddle`,
      'links.example.org',
    );
    expect(result.ok && result.link.place).toMatchObject({ ref: 'u1:huddle:t1', label: 'Huddle' });
  });
});
