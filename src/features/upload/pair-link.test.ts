import { describe, expect, it } from '@jest/globals';

import type { CapabilitiesResult } from './capabilities';
import type { UploadDeepLink } from './deep-link';
import { createLinkGate, type PairDeps, pairLink, screenLink } from './pair-link';
import type { TokenCheck } from './token-check';

const NOW = 1_700_000_000_000;
const token = (expMs: number, ref?: string) =>
  `${Buffer.from(
    JSON.stringify({
      artifactId: 'a',
      iat: 1,
      exp: Math.floor(expMs / 1000),
      kid: 'k',
      issuer: 'i',
      ...(ref ? { ref } : {}),
    }),
    'utf8',
  ).toString('base64url')}.sig`;

const SERVER = 'https://vault.example.org/pulsevault';
const plain = (over: Partial<UploadDeepLink> = {}): UploadDeepLink => ({
  artifactId: 'art-plain',
  server: SERVER,
  token: token(NOW + 600_000),
  ...over,
});
const forPlace = (over: Partial<UploadDeepLink> = {}): UploadDeepLink => ({
  artifactId: 'art-place',
  server: SERVER,
  token: token(NOW + 600_000, 'r1'),
  place: { ref: 'r1', label: 'Team · Huddle', name: null, app: null, returnUrl: null },
  ...over,
});

describe('createLinkGate', () => {
  const PLACE = 'pulsecam://?v=1&place';
  const PLAIN = 'pulsecam://?v=1&plain';

  it('drops the same link reported twice within two seconds, of either kind', () => {
    let now = 0;
    const gate = createLinkGate(() => now);
    expect(gate.admit(PLACE, true)).toBe(true);
    now = 1999;
    expect(gate.admit(PLACE, true)).toBe(false);
    now = 0;
    const second = createLinkGate(() => now);
    expect(second.admit(PLAIN, false)).toBe(true);
    now = 500;
    expect(second.admit(PLAIN, false)).toBe(false);
  });

  it('acts on a link for a place every time it is opened again', () => {
    let now = 0;
    const gate = createLinkGate(() => now);
    expect(gate.admit(PLACE, true)).toBe(true);
    now = 2000;
    expect(gate.admit(PLACE, true)).toBe(true);
    now = 60_000;
    expect(gate.admit(PLACE, true)).toBe(true);
  });

  it('ignores a plain link opened again in the session, until another link comes between', () => {
    let now = 0;
    const gate = createLinkGate(() => now);
    expect(gate.admit(PLAIN, false)).toBe(true);
    now = 60_000;
    expect(gate.admit(PLAIN, false)).toBe(false);
    now = 120_000;
    expect(gate.admit('pulsecam://', false)).toBe(true);
    now = 180_000;
    expect(gate.admit(PLAIN, false)).toBe(true);
  });

  it('once released, takes the same link again at once', () => {
    const gate = createLinkGate(() => 0);
    expect(gate.admit(PLAIN, false)).toBe(true);
    // “Couldn’t connect”, or Cancel on the sheet: a re-tap straight away is a new try.
    gate.release();
    expect(gate.admit(PLAIN, false)).toBe(true);
    expect(gate.admit(PLACE, true)).toBe(true);
    gate.release();
    expect(gate.admit(PLACE, true)).toBe(true);
  });
});

describe('screenLink', () => {
  const never = async () => false;
  const always = async () => true;

  it('refuses a link for a place whose token has expired on this device', async () => {
    const expired = forPlace({ token: token(NOW - 1000, 'r1') });
    expect(await screenLink(expired, { launch: false, nowMs: NOW, wasHandled: never })).toBe(
      'expired',
    );
    expect(await screenLink(forPlace(), { launch: false, nowMs: NOW, wasHandled: never })).toBe(
      'ok',
    );
  });

  it('drops a launch link that was already dealt with, before anything else', async () => {
    const opts = { launch: true, nowMs: NOW, wasHandled: always };
    expect(await screenLink(forPlace(), opts)).toBe('replayed');
    // Silent even when it has since expired: no “expired” toast at every relaunch.
    expect(await screenLink(forPlace({ token: token(NOW - 1000, 'r1') }), opts)).toBe('replayed');
  });

  it('acts on an already-handled link opened while the app runs: that is the person, not the system', async () => {
    expect(await screenLink(forPlace(), { launch: false, nowMs: NOW, wasHandled: always })).toBe(
      'ok',
    );
  });

  it('takes a launch link when the handled list can’t be read', async () => {
    const broken = async () => {
      throw new Error('db closed');
    };
    expect(await screenLink(forPlace(), { launch: true, nowMs: NOW, wasHandled: broken })).toBe(
      'ok',
    );
  });

  it('leaves a plain link exactly as it was: never screened', async () => {
    const expired = plain({ token: token(NOW - 1000) });
    expect(await screenLink(expired, { launch: true, nowMs: NOW, wasHandled: always })).toBe('ok');
  });
});

describe('pairLink', () => {
  const COMPATIBLE: CapabilitiesResult = {
    ok: true,
    protocol: 2,
    capabilities: { protocolVersion: 2, minSupportedVersion: 1, maxSupportedVersion: 2 },
  };
  function deps(over: Partial<PairDeps> & { check?: TokenCheck } = {}) {
    const calls: string[] = [];
    const all: PairDeps = {
      checkCapabilities: async () => {
        calls.push('capabilities');
        return COMPATIBLE;
      },
      checkToken: async (link) => {
        calls.push(`token:${link.token === forPlace().token ? 'unchanged' : 'changed'}`);
        return over.check ?? 'accepted';
      },
      save: async (link) => {
        calls.push(`save:${link.artifactId}`);
      },
      remember: async (artifactId) => {
        calls.push(`remember:${artifactId}`);
      },
      ...over,
    };
    return { all, calls };
  }

  it('pairs a plain link as before: the server check, then the pool, and nothing else', async () => {
    const { all, calls } = deps();
    expect(await pairLink(plain(), all)).toEqual({ ok: true });
    expect(calls).toEqual(['capabilities', 'save:art-plain']);
  });

  it('asks the server to accept a place link’s token before the place takes the link', async () => {
    const { all, calls } = deps();
    expect(await pairLink(forPlace(), all)).toEqual({ ok: true });
    expect(calls).toEqual([
      'capabilities',
      'token:unchanged',
      'save:art-place',
      'remember:art-place',
    ]);
  });

  it('a link the server refuses never touches the place’s row, and is not asked about again', async () => {
    const { all, calls } = deps({ check: 'refused' });
    expect(await pairLink(forPlace(), all)).toEqual({ ok: false, reason: 'refused' });
    expect(calls).toEqual(['capabilities', 'token:unchanged', 'remember:art-place']);
  });

  it('a server that can’t say (no status route) doesn’t block the pairing', async () => {
    const { all, calls } = deps({ check: 'unknown' });
    expect(await pairLink(forPlace(), all)).toEqual({ ok: true });
    expect(calls).toContain('save:art-place');
  });

  it('stores nothing when the server can’t be reached, for either request', async () => {
    const down = deps({ checkCapabilities: async () => ({ ok: false, reason: 'unreachable' }) });
    expect(await pairLink(forPlace(), down.all)).toEqual({ ok: false, reason: 'unreachable' });
    expect(down.calls).toEqual([]);

    const dropped = deps({
      checkToken: async () => {
        throw new Error('network');
      },
    });
    expect(await pairLink(forPlace(), dropped.all)).toEqual({ ok: false, reason: 'unreachable' });
    // Not remembered: the person can open it again.
    expect(dropped.calls).toEqual(['capabilities']);
  });

  it('says so when the server and the app don’t speak a common protocol', async () => {
    const { all } = deps({
      checkCapabilities: async () => ({ ok: false, reason: 'version-too-old' }),
    });
    expect(await pairLink(plain(), all)).toEqual({ ok: false, reason: 'version-too-old' });
  });

  it('a destination that couldn’t be stored is not remembered as dealt with', async () => {
    const { all, calls } = deps({
      save: async () => {
        throw new Error('disk full');
      },
    });
    expect(await pairLink(forPlace(), all)).toEqual({ ok: false, reason: 'not-saved' });
    expect(calls).toEqual(['capabilities', 'token:unchanged']);
  });
});
