import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { hasNonAsciiHost, hostOf } from '@/utils/format';

import { parseUploadDeepLink, readReturnUrl } from './deep-link';

/**
 * A link's parameters are decoded by the platform's `URLSearchParams`, and the URLs among them
 * (`server`, `return`) read by its `URL`. In the app both are `whatwg-url-minimum`'s, which Expo
 * installs as the globals (expo/src/winter/runtime.native.ts); under Jest they are Node's. Both
 * are WHATWG implementations; Node's also does IDNA, and is the oracle.
 *
 * Every check here runs under each of the two, over a corpus of hostile shapes, and compares
 * with the rule the released app applies (`mainAccepts`, main's check word for word): this
 * branch accepts nothing that rule refuses, and the host it shows is the host the parser reads.
 */
const NodeURL = globalThis.URL;
const NodeURLSearchParams = globalThis.URLSearchParams;
const { URL: AppURL, URLSearchParams: AppURLSearchParams } = jest.requireActual<{
  URL: typeof URL;
  URLSearchParams: typeof URLSearchParams;
}>('whatwg-url-minimum');
const PARSERS: [string, typeof URL, typeof URLSearchParams][] = [
  ['Node’s URL (the oracle)', NodeURL, NodeURLSearchParams],
  ['whatwg-url-minimum (the app’s URL)', AppURL, AppURLSearchParams],
];

const cp = String.fromCodePoint;

/** `server` values: ordinary, hostile, and every printable ASCII character in a host. */
function corpus(): string[] {
  const urls = [
    'https://good.org',
    'https://good.org/',
    'HTTPS://Good.ORG/Path',
    'https://good.org:443/pv',
    'https://good.org:8443',
    'https://good.org:',
    'https://good.org:abc/',
    'https://good.org:80:90/',
    // An `@` in every position.
    'https://evil.example/x@good.org',
    'https://evil.example/@good.org',
    'https://good.org@evil.example/',
    'https://good.org:pw@evil.example/',
    'https://a@b@c/',
    'https://good.org%40evil.example/',
    'https://evil.example?@good.org',
    'https://evil.example#@good.org',
    'https://evil.example?x=1/@good.org/',
    'https://evil.example;@good.org',
    'http://evil.example/a@192.168.1.1',
    'http://evil.example/a@localhost',
    'http://evil.example?x@10.0.0.1',
    'http://evil.example#@127.0.0.1',
    'http://127.0.0.1@evil.example',
    'http://evil.example@127.0.0.1',
    // Backslashes, whitespace and control characters.
    `https://evil.example${cp(0x5c)}@good.org/`,
    `https://good.org${cp(0x5c)}.evil.example/`,
    `https:${cp(0x5c, 0x5c)}good.org`,
    `https://evil.example${cp(0x09)}@good.org/`,
    `https://good.org${cp(0x0a)}.evil.example`,
    ' https://good.org',
    'https://good.org ',
    `https://go${cp(0x09)}od.org/`,
    `https://good.org${cp(0)}.evil.example/`,
    `https://good.org${cp(0x2028)}`,
    `https://good.org${cp(0xa0)}.evil.example`,
    // Schemes and slashes.
    'https:/good.org',
    'https:good.org',
    'https:///good.org',
    'https:////good.org',
    'ftp://good.org',
    'javascript://good.org/%0aalert(1)',
    'http://good.org',
    'httpss://good.org',
    'https+x://good.org',
    'pulsecam://x',
    '//good.org',
    'good.org',
    // Plain http: localhost and addresses, in every spelling.
    'http://localhost',
    'http://LOCALHOST:3000/',
    'http://localhost.',
    'http://localhost.evil.example',
    'http://127.0.0.1',
    'http://127.0.0.1.',
    'http://10.0.0.1',
    'http://10.0.0.1:8080/pv',
    'http://10.0.0.1.evil.example',
    'http://10.0.0.1.',
    'http://192.168.1.1',
    'http://172.15.0.1',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://172.32.0.1',
    'http://100.63.0.1',
    'http://100.64.0.1',
    'http://100.127.0.1',
    'http://100.128.0.1',
    'http://169.254.169.254',
    'http://[::1]',
    'http://[::1]:8080',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:10.0.0.1]',
    'http://[fe80::1%25eth0]',
    'https://[::1]:8080/x',
    'https://[::1',
    'https://[evil.example]good.org/',
    'https://good.org]',
    'https://127.0.0.1',
    'https://0x7f000001',
    'https://1.1',
    // Empty and odd hosts.
    'https://',
    'https:///',
    'https://@/',
    'https://:80/',
    'https://user@:80',
    'https://.',
    'https://good.org.',
    'https://good.org../',
    'https://-good.org',
    'https://good_org',
    'https://GOOD.org:0443',
    'https://good.org:65536',
    // Look-alikes: IDN, punycode, characters that fold to ASCII or can't be seen.
    'https://xn--mieweb-9ve.org',
    `https://mi${cp(0x435)}web.org`,
    `https://good.org${cp(0x3002)}evil.example/`,
    `https://evil.example${cp(0xff0f)}good.org/`,
    `https://evil.example${cp(0xff03)}.good.org/`,
    `https://evil.example${cp(0xff1f)}.good.org/`,
    `https://good.org${cp(0xff20)}evil.example/`,
    `https://good${cp(0x200b)}.org/`,
    `https://g${cp(0xad)}ood.org`,
    `https://${cp(0x2460, 0x2461)}.example`,
    `https://good.org${cp(0x202e)}gro.live`,
    'https://%65vil.example/',
    'https://good.org%2Eevil.example',
    'https://good.org;.evil.example/',
    'https://good.org,evil.example/',
    'https://good.org&evil.example',
  ];
  // Every printable ASCII character, and the escapes of the ones that delimit, in four places.
  const pieces = Array.from({ length: 0x7f - 0x21 }, (_, i) => cp(0x21 + i)).concat(
    ['%00', '%09', '%0a', '%20', '%23', '%2e', '%2f', '%3a', '%3f', '%40', '%5b', '%5c', '%5d'],
    ['%25', '%7f', '%80', '%e3%80%82', '%ZZ', '%', cp(0x7f), cp(0x85), cp(0x200b), cp(0x3000)],
  );
  for (const piece of pieces) {
    urls.push(
      `https://evil.example${piece}.good.org/pv`,
      `https://good.org${piece}evil.example/pv`,
      `https://${piece}good.org/pv`,
      `https://good.org${piece}/pv`,
    );
  }
  for (const port of ['', '0', '80', '443', '65535', '65536', '99999999999', '-1', '+80'].concat([
    '0x50',
    '8 0',
    '80a',
    'a',
    '80:81',
    cp(0x668, 0x660),
  ])) {
    urls.push(`https://good.org:${port}/pv`, `http://10.0.0.1:${port}/pv`);
  }
  // Addresses in decimal, octal, hex and short forms, in and out of the private ranges.
  for (const address of [
    ...['10.0.0.256', '10.0.0.0400', '10.1.1.999', '10.00.00.01', '10.0.0.1.2', '10.0.0.-1'],
    ...['10.0.0.08', '10.4294967296.0.1', '192.168.1.300', '172.16.0.256', '100.64.0.256'],
    ...[
      '169.254.0.999',
      '127.0.0.01',
      '127.000.000.001',
      '10.0.0.1e1',
      `${cp(0x661, 0x660)}.0.0.1`,
    ],
    ...['0xa.0.0.1', '012.0.0.1', '167772161', '10.1', '192.168.257', '0300.0250.1.1'],
    ...['0xc0.0xa8.1.1', '3232235777', '0x7f.1', '0177.1', '127.1', '2130706433', '010.0.0.1'],
    ...['10.010.0.1', '192.168.1', '172.16.1', '192.168.0x1.1', '172.016.0.1', '8.8.8.8'],
    ...['11.0.0.1', '192.169.0.1', '172.15.255.255', '100.63.255.255', '169.253.0.1'],
    ...['126.0.0.1', '128.0.0.1'],
  ]) {
    urls.push(`http://${address}/pv`);
  }
  return urls;
}

const CORPUS = corpus();

/** The characters this branch refuses in a link's URL, raw or decoded into its host. */
const REFUSED_CHARACTERS = /[\s\\\p{Cc}]/u;

/** main's `isPrivateDevOrigin`, word for word. */
function mainIsPrivateDevOrigin(url: URL): boolean {
  if (url.protocol !== 'http:') return false;
  const host = url.hostname;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    /^10\.\d+\.\d+\.\d+$/.test(host) ||
    /^192\.168\.\d+\.\d+$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host) ||
    /^169\.254\.\d+\.\d+$/.test(host)
  );
}

/** main's check of a `server`: the URL when the released app pairs with it, else `null`. */
function mainAccepts(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === 'https:' || mainIsPrivateDevOrigin(url) ? url : null;
}

/** The `server` this branch pairs with for a link that names `raw`, else `null`. */
function accepted(raw: string): string | null {
  const result = parseUploadDeepLink(
    `pulsecam://?v=1&artifactId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&server=${encodeURIComponent(raw)}`,
  );
  return result.ok ? result.link.server : null;
}

describe.each(PARSERS)('a link’s URLs, read by %s', (_name, Parser, Params) => {
  beforeAll(() => {
    globalThis.URL = Parser;
    globalThis.URLSearchParams = Params;
  });
  afterAll(() => {
    globalThis.URL = NodeURL;
    globalThis.URLSearchParams = NodeURLSearchParams;
  });

  it('decodes a link’s parameters as form-urlencoded, without ever failing', () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const parse = (params: string) =>
      parseUploadDeepLink(`pulsecam://?v=1&artifactId=${id}&${params}`);
    // A value keeps its `=` signs and a stray `%`; a `+` is a space; the first value counts.
    expect(parse('server=https://vault.example.org/pv?a=b&token=abc=def%zz')).toEqual({
      ok: true,
      link: { artifactId: id, server: 'https://vault.example.org/pv?a=b', token: 'abc=def%zz' },
    });
    expect(
      parse('server=https%3A%2F%2Fvault.example.org&server=https://other.example.org'),
    ).toEqual({
      ok: true,
      link: { artifactId: id, server: 'https://vault.example.org', token: null },
    });
    expect(parse('server=+https://vault.example.org')).toEqual({
      ok: false,
      reason: 'invalid-link',
    });
    expect(parse('server=%ZZ&server=https://other.example.org')).toEqual({
      ok: false,
      reason: 'invalid-link',
    });
    expect(parse('server=https://vault.example.org&token=a+b')).toEqual({
      ok: false,
      reason: 'invalid-link',
    });
  });

  it('has a corpus worth the name', () => {
    expect(CORPUS.length).toBeGreaterThan(600);
    const pairs = CORPUS.filter((raw) => accepted(raw) !== null).length;
    expect(pairs).toBeGreaterThan(100);
    expect(CORPUS.length - pairs).toBeGreaterThan(100);
  });

  it('pairs with no server the released app refuses', () => {
    expect(CORPUS.filter((raw) => accepted(raw) !== null && !mainAccepts(raw))).toEqual([]);
  });

  it('refuses, of what the released app pairs with, only what it can say why', () => {
    const refusedHere = CORPUS.filter((raw) => mainAccepts(raw) && accepted(raw) === null);
    expect(refusedHere.length).toBeGreaterThan(0);
    const unexplained = refusedHere.filter(
      (raw) =>
        // Whitespace, a control character or a backslash, in the URL or decoded into its host.
        !REFUSED_CHARACTERS.test(raw) && !REFUSED_CHARACTERS.test(new URL(raw).host),
    );
    // What is left is a name that only resembles a private address, which the app's parser
    // doesn't refuse by itself (Node's does).
    expect(unexplained).toEqual(Parser === AppURL ? ['http://10.0.0.08/pv'] : []);
  });

  it('shows the host the parser reads, for every server it pairs with', () => {
    for (const raw of CORPUS) {
      const server = accepted(raw);
      if (server !== null) expect([raw, hostOf(server)]).toEqual([raw, new URL(raw).host]);
    }
  });

  it('shows a host with nothing in it that can’t be seen', () => {
    for (const raw of CORPUS) {
      const server = accepted(raw);
      if (server !== null)
        expect([raw, REFUSED_CHARACTERS.test(hostOf(server))]).toEqual([raw, false]);
    }
  });

  it('holds a return URL to the same rule, without a username or password', () => {
    for (const raw of CORPUS) {
      const back = readReturnUrl(raw);
      if (!back) continue;
      const url = mainAccepts(raw);
      expect([raw, url?.host, url?.username, url?.password]).toEqual([raw, back.host, '', '']);
      expect(back.url).toBe(raw);
    }
  });

  it('reads a trusted host as the released app stored it', () => {
    // Lowercased, without a default port: what `new URL(server).host` has always given.
    expect(hostOf('https://Vault.Example.ORG:443/pulsevault')).toBe('vault.example.org');
    expect(hostOf('http://192.168.1.20:3000/pulsevault')).toBe('192.168.1.20:3000');
    expect(hostOf('https://vault.example.org:8443')).toBe('vault.example.org:8443');
    expect(hostOf('not a url')).toBe('not a url');
  });
});

describe('the app’s URL parser against the oracle', () => {
  it('reads the same host wherever it pairs with an ASCII one', () => {
    globalThis.URL = AppURL;
    const paired = CORPUS.filter((raw) => accepted(raw) !== null);
    globalThis.URL = NodeURL;
    // The app's parser does no IDNA: a host with letters outside ASCII is shown as written, and
    // the pairing sheet flags it (as it does punycode). Every other host reads the same.
    const plain = paired.filter((raw) => {
      const host = new AppURL(raw).host;
      return !hasNonAsciiHost(host) && !/(^|\.)xn--/.test(host);
    });
    expect(plain.length).toBeGreaterThan(100);
    for (const raw of plain) {
      expect([raw, new AppURL(raw).host]).toEqual([raw, new NodeURL(raw).host]);
    }
  });
});
