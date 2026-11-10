import { describe, expect, it } from '@jest/globals';

import {
  decodeCapabilityClaims,
  EXPIRY_BUFFER_MS,
  expiresLater,
  formatExpiry,
  isClaimsExpired,
  isTokenExpired,
} from './capability-token';

// Mirrors `issueCapabilityToken` in pulsevault-mieweb/src/lib/capability-token.ts without
// pulling in the submodule (no signature needed — decode never verifies it).
function fakeToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.fake-signature`;
}

const VALID_CLAIMS = {
  artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  iat: 1_700_000_000,
  exp: 1_700_001_800,
  kid: '2026-06',
  issuer: 'https://vault.example.org',
};

describe('decodeCapabilityClaims', () => {
  it('reads the expiry of a well-formed token, and nothing else', () => {
    expect(decodeCapabilityClaims(fakeToken(VALID_CLAIMS))).toEqual({ exp: VALID_CLAIMS.exp });
    // Whatever else the server put in it is the server's (PROTOCOL.md §5.6).
    expect(
      decodeCapabilityClaims(fakeToken({ ...VALID_CLAIMS, ctx: { userId: 'u1' }, use: 'view' })),
    ).toEqual({ exp: VALID_CLAIMS.exp });
  });

  it('reads the place the upload is for from a `ref` claim, non-ASCII included', () => {
    for (const ref of ['u1:huddle:t1', 'équipe:☕', 'r'.repeat(200), '😀'.repeat(200)]) {
      expect(decodeCapabilityClaims(fakeToken({ ...VALID_CLAIMS, ref }))).toEqual({
        exp: VALID_CLAIMS.exp,
        ref,
      });
    }
  });

  it('reads no place from a `ref` that isn’t a string of 1 to 200 characters', () => {
    for (const ref of ['', 'r'.repeat(201), '😀'.repeat(201), 7, null, { id: 'r1' }, ['r1']]) {
      const claims = decodeCapabilityClaims(fakeToken({ ...VALID_CLAIMS, ref }));
      // Still the token it was, for its expiry: only the place is unread.
      expect(claims).toEqual({ exp: VALID_CLAIMS.exp });
    }
  });

  it('reads the claims from the part before the first dot only', () => {
    const [payload] = fakeToken({ ...VALID_CLAIMS, ref: 'real' }).split('.');
    const [forged] = fakeToken({ ...VALID_CLAIMS, ref: 'forged' }).split('.');
    expect(decodeCapabilityClaims(`${payload}.${forged}.sig`)?.ref).toBe('real');
  });

  it('reads nothing from claims that are not base64url without padding', () => {
    const json = JSON.stringify({ ...VALID_CLAIMS, ref: 'r1??>>' });
    const plain = Buffer.from(json, 'utf8').toString('base64');
    // The test is only a test if plain base64 differs here: `+`, `/` or `=`.
    expect(plain).toMatch(/[+/=]/);
    expect(decodeCapabilityClaims(`${plain}.sig`)).toBeNull();
    const [payload] = fakeToken(VALID_CLAIMS).split('.');
    expect(decodeCapabilityClaims(`${payload}=.sig`)).toBeNull();
    // A length no base64 encoding produces.
    expect(decodeCapabilityClaims('abcde.sig')).toBeNull();
  });

  it('reads nothing from claims that are not the UTF-8 text of one JSON object', () => {
    const encoded = (bytes: Buffer | string) => `${Buffer.from(bytes).toString('base64url')}.sig`;
    for (const text of ['null', '[]', '"exp"', '7', 'true', '']) {
      expect(decodeCapabilityClaims(encoded(text))).toBeNull();
    }
    // Latin-1 bytes: valid JSON to a byte-for-byte reader, but not UTF-8.
    const latin1 = Buffer.from(JSON.stringify({ ...VALID_CLAIMS, ref: 'équipe' }), 'latin1');
    expect(decodeCapabilityClaims(encoded(latin1))).toBeNull();
  });

  it('returns null for a token with no dot separator', () => {
    expect(decodeCapabilityClaims('not-a-token')).toBeNull();
  });

  it('returns null for a payload that is not valid base64url', () => {
    expect(decodeCapabilityClaims('!!!.sig')).toBeNull();
  });

  it('returns null for a payload that is not valid JSON', () => {
    const payload = Buffer.from('not json', 'utf8').toString('base64url');
    expect(decodeCapabilityClaims(`${payload}.sig`)).toBeNull();
  });

  it('returns null when required claims are missing', () => {
    expect(decodeCapabilityClaims(fakeToken({ artifactId: VALID_CLAIMS.artifactId }))).toBeNull();
  });

  it('returns null for an opaque token from a different server implementation', () => {
    expect(decodeCapabilityClaims('sk_live_abcdef1234567890')).toBeNull();
  });
});

describe('isClaimsExpired', () => {
  it('is false well before expiry', () => {
    expect(
      isClaimsExpired({ exp: VALID_CLAIMS.exp }, 10_000, VALID_CLAIMS.exp * 1000 - 60_000),
    ).toBe(false);
  });

  it('is true once past expiry', () => {
    expect(isClaimsExpired({ exp: VALID_CLAIMS.exp }, 10_000, VALID_CLAIMS.exp * 1000 + 1)).toBe(
      true,
    );
  });

  it('is true inside the safety buffer even though exp has not technically passed', () => {
    expect(
      isClaimsExpired({ exp: VALID_CLAIMS.exp }, 10_000, VALID_CLAIMS.exp * 1000 - 5_000),
    ).toBe(true);
  });
});

describe('isTokenExpired', () => {
  const expMs = VALID_CLAIMS.exp * 1000;

  it('treats a null token as not-expired (validity unknown)', () => {
    expect(isTokenExpired(null, expMs + 60_000)).toBe(false);
  });

  it('treats an opaque, undecodable token as not-expired', () => {
    expect(isTokenExpired('sk_live_abcdef1234567890', expMs + 60_000)).toBe(false);
  });

  it('is false well before expiry and true past it (with buffer)', () => {
    const token = fakeToken(VALID_CLAIMS);
    expect(isTokenExpired(token, expMs - 60_000)).toBe(false);
    expect(isTokenExpired(token, expMs - EXPIRY_BUFFER_MS + 1)).toBe(true);
  });
});

describe('formatExpiry', () => {
  const expMs = VALID_CLAIMS.exp * 1000;

  it('is "No expiry" for a tokenless or opaque destination', () => {
    expect(formatExpiry(null, expMs)).toBe('No expiry');
    expect(formatExpiry('sk_live_opaque', expMs)).toBe('No expiry');
  });

  it('is "Expired" once past exp (accounting for the buffer)', () => {
    expect(formatExpiry(fakeToken(VALID_CLAIMS), expMs)).toBe('Expired');
  });

  it('counts down in minutes then seconds', () => {
    const token = fakeToken(VALID_CLAIMS);
    // 5 min out, minus the 10s buffer → "Expires in 4m".
    expect(formatExpiry(token, expMs - 5 * 60_000)).toBe('Expires in 4m');
    // 20s out, minus the 10s buffer → "Expires in 10s".
    expect(formatExpiry(token, expMs - 20_000)).toBe('Expires in 10s');
  });
});

describe('expiresLater', () => {
  const expiring = (exp: number) => fakeToken({ ...VALID_CLAIMS, exp });

  it('is a newer link: one that stops working later than the stored one', () => {
    expect(expiresLater(expiring(2000), expiring(1000))).toBe(true);
    expect(expiresLater(expiring(1000), expiring(2000))).toBe(false);
    // The same link again is not newer.
    expect(expiresLater(expiring(1000), expiring(1000))).toBe(false);
  });

  it('always replaces a stored token that is gone or can’t be read', () => {
    expect(expiresLater(expiring(1000), null)).toBe(true);
    expect(expiresLater(expiring(1000), 'opaque')).toBe(true);
    expect(expiresLater(null, null)).toBe(true);
  });

  it('never lets a link that can’t be read replace one that can', () => {
    expect(expiresLater('opaque', expiring(1000))).toBe(false);
    expect(expiresLater(null, expiring(1000))).toBe(false);
  });

  it('reads the order from exp alone, whatever iat says', () => {
    const issuedLaterExpiresSooner = fakeToken({ ...VALID_CLAIMS, iat: 9000, exp: 1000 });
    const issuedSoonerExpiresLater = fakeToken({ ...VALID_CLAIMS, iat: 1, exp: 2000 });
    expect(expiresLater(issuedLaterExpiresSooner, issuedSoonerExpiresLater)).toBe(false);
  });
});
