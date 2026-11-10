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
  type Options = Parameters<typeof screenLink>[1];
  const screen = (link: UploadDeepLink, over: Partial<Options> = {}) =>
    screenLink(link, {
      launch: false,
      nowMs: NOW,
      holds: async () => false,
      outcome: async () => null,
      ...over,
    });
  const expired = forPlace({ token: token(NOW - 1000, 'r1') });
  const held = { holds: async () => true };
  const paired = { outcome: async () => 'paired' as const };
  const refused = { outcome: async () => 'refused' as const };

  it('refuses a link for a place whose token has expired on this device', async () => {
    expect(await screen(expired)).toBe('expired');
    expect(await screen(forPlace())).toBe('ok');
  });

  it('opens a link the place already holds without pairing it again, launch or not', async () => {
    expect(await screen(forPlace(), held)).toBe('held');
    expect(await screen(forPlace(), { ...held, ...paired, launch: true })).toBe('held');
    // Not one that has expired, even if its row is still there.
    expect(await screen(expired, held)).toBe('expired');
  });

  it('never pairs a launch link a second time: one whose upload was used is dropped silently', async () => {
    expect(await screen(forPlace(), { ...paired, launch: true })).toBe('replayed');
  });

  it('says what a launch link came to, when it has something to say', async () => {
    // A tap on the same link while the app isn't running looks the same as the system handing
    // the launch link back: both are told it expired, or that its server refused it.
    expect(await screen(expired, { ...paired, launch: true })).toBe('expired');
    expect(await screen(forPlace(), { ...refused, launch: true })).toBe('refused');
  });

  it('pairs an already-handled link opened while the app runs: that is the person, not the system', async () => {
    expect(await screen(forPlace(), paired)).toBe('ok');
    expect(await screen(forPlace(), refused)).toBe('ok');
  });

  it('takes a launch link when the row or the handled list can’t be read', async () => {
    const broken = async () => {
      throw new Error('db closed');
    };
    expect(await screen(forPlace(), { launch: true, holds: broken, outcome: broken })).toBe('ok');
  });

  it('leaves a plain link exactly as it was: never screened', async () => {
    const stale = plain({ token: token(NOW - 1000) });
    expect(await screen(stale, { ...held, ...paired, launch: true })).toBe('ok');
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
      save: async (link, accepted) => {
        calls.push(`save:${link.artifactId}:${accepted ? 'accepted' : 'unconfirmed'}`);
      },
      remember: async (artifactId, outcome) => {
        calls.push(`remember:${artifactId}:${outcome}`);
      },
      ...over,
    };
    return { all, calls };
  }

  it('pairs a plain link as before: the server check, then the pool, and nothing else', async () => {
    const { all, calls } = deps();
    expect(await pairLink(plain(), all)).toEqual({ ok: true });
    expect(calls).toEqual(['capabilities', 'save:art-plain:unconfirmed']);
  });

  it('accepted: asks the server about a place link’s token, unchanged, and stores it as accepted', async () => {
    const { all, calls } = deps();
    expect(await pairLink(forPlace(), all)).toEqual({ ok: true });
    expect(calls).toEqual([
      'capabilities',
      'token:unchanged',
      'save:art-place:accepted',
      'remember:art-place:paired',
    ]);
  });

  it('asks both questions at once: the recorder waits for the slower, not for their sum', async () => {
    const order: string[] = [];
    let answerCapabilities: (result: CapabilitiesResult) => void = () => {};
    const { all } = deps({
      checkCapabilities: () => {
        order.push('capabilities asked');
        return new Promise((resolve) => (answerCapabilities = resolve));
      },
      checkToken: async () => {
        order.push('token asked');
        return 'accepted';
      },
    });
    const pairing = pairLink(forPlace(), all);
    await Promise.resolve();
    expect(order).toEqual(['capabilities asked', 'token asked']);
    answerCapabilities(COMPATIBLE);
    expect(await pairing).toEqual({ ok: true });
  });

  it('refused: the link is dropped, the place’s row untouched, and the refusal remembered', async () => {
    const { all, calls } = deps({ check: 'refused' });
    expect(await pairLink(forPlace(), all)).toEqual({ ok: false, reason: 'refused' });
    expect(calls).toEqual(['capabilities', 'token:unchanged', 'remember:art-place:refused']);
  });

  it('unknown: never stored as accepted, whether the server can’t say or gives no answer', async () => {
    const noRoute = deps({ check: 'unknown' });
    expect(await pairLink(forPlace(), noRoute.all)).toEqual({ ok: true });
    expect(noRoute.calls).toContain('save:art-place:unconfirmed');

    const noAnswer = deps({
      checkToken: async () => {
        throw new Error('network');
      },
    });
    expect(await pairLink(forPlace(), noAnswer.all)).toEqual({ ok: true });
    expect(noAnswer.calls).toEqual([
      'capabilities',
      'save:art-place:unconfirmed',
      'remember:art-place:paired',
    ]);
  });

  it('stores nothing when the server can’t be reached, whatever it made of the token', async () => {
    for (const check of ['accepted', 'refused', 'unknown'] as const) {
      const down = deps({
        check,
        checkCapabilities: async () => ({ ok: false, reason: 'unreachable' }),
      });
      expect(await pairLink(forPlace(), down.all)).toEqual({ ok: false, reason: 'unreachable' });
      // Not remembered either: the person can open it again.
      expect(down.calls).toEqual(['token:unchanged']);
    }
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
