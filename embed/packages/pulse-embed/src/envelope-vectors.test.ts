/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import type { MethodName } from '@mieweb/pulse-embed';

import {
  buildReply,
  CLIENT_VERSION,
  CONTRACT,
  MINOR0_METHODS,
  parseReply,
  routeRequest,
  stableStringify,
} from './envelope';
import { checkConfigure, checkOpen } from './validate';

// The facade's shared vectors (PR1-G): the Swift facade runs the same file through
// PulseKitEnvelope.swift, so both sides agree on routing, replies and argument checks.
const VECTORS = join(__dirname, '../../../native/ios/vectors/envelope.json');

interface Vectors {
  contract: { major: number; minor: number };
  methods: { native: string[]; minor1: string[] };
  requests: {
    name: string;
    request?: unknown;
    requestText?: string;
    supported?: boolean;
    expect: {
      route: 'native' | 'reply';
      method?: string;
      args?: unknown;
      callId?: string;
      error?: { code: string; recoverable: boolean };
    };
  }[];
  replies: {
    name: string;
    build?: { ok: boolean; callId: string; result?: unknown; error?: { code: string } };
    expectText?: string;
    parse?: string;
    expect?: unknown;
  }[];
  open: {
    name: string;
    args: unknown;
    expect: { ok: boolean; entry?: string; requestId?: string | null; code?: string };
  }[];
  configure: { args: unknown; expect: 'ok' | 'invalid_options' }[];
}

const vectors = JSON.parse(readFileSync(VECTORS, 'utf8')) as Vectors;

describe('envelope vectors: versions and methods', () => {
  it('were written for the contract this client speaks', () => {
    expect(vectors.contract).toEqual({ major: CONTRACT.major, minor: CONTRACT.minor });
  });

  it("list minor 0's methods as the client's MINOR0_METHODS", () => {
    expect([...MINOR0_METHODS]).toEqual(vectors.methods.native);
  });

  it('name only methods the contract knows (MethodName)', () => {
    // A compile-time list of every MethodName; tsc fails if one is missing or misspelled.
    const all: Record<MethodName, true> = {
      info: true,
      configure: true,
      prewarm: true,
      open: true,
      close: true,
      isOpen: true,
      pendingResults: true,
      acknowledge: true,
      logFile: true,
      setAccount: true,
      listDrafts: true,
      getDraft: true,
      countDrafts: true,
      renameDraft: true,
      deleteDraft: true,
      setDraftContext: true,
      upload: true,
      cancelUpload: true,
      retireDraft: true,
      dismissReceipt: true,
      resumeOutbox: true,
      usage: true,
      listNamespaces: true,
      purge: true,
      respondHostRequest: true,
    };
    expect([...vectors.methods.native, ...vectors.methods.minor1].sort()).toEqual(
      Object.keys(all).sort(),
    );
  });

  it("keeps CLIENT_VERSION equal to package.json's version", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as {
      version: string;
    };
    expect(CLIENT_VERSION).toBe(pkg.version);
  });
});

describe('envelope vectors: requests', () => {
  it.each(vectors.requests.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const input = v.requestText ?? v.request;
    const routed = routeRequest(input, { supported: v.supported, methods: vectors.methods.native });
    if (v.expect.route === 'native') {
      expect(routed).toEqual({
        route: 'native',
        callId: (v.request as { callId: string }).callId,
        method: v.expect.method,
        args: v.expect.args,
      });
    } else {
      expect(routed.route).toBe('reply');
      if (routed.route !== 'reply') return;
      expect(routed.reply.callId).toBe(v.expect.callId);
      expect(routed.reply.error).toMatchObject({ ...v.expect.error, callId: v.expect.callId });
    }
  });

  it('a minor-1 facade (PR2) routes the data API natively', () => {
    const routed = routeRequest(
      { v: 1, callId: 'c-1', method: 'listDrafts', args: {} },
      { methods: [...vectors.methods.native, ...vectors.methods.minor1] },
    );
    expect(routed).toMatchObject({ route: 'native', method: 'listDrafts' });
  });
});

describe('envelope vectors: replies', () => {
  it.each(vectors.replies.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    if (v.build) {
      const built = buildReply(v.build as Parameters<typeof buildReply>[0]);
      expect(stableStringify(built)).toBe(v.expectText);
      // And the client reads its own build back unchanged.
      expect(parseReply(v.expectText)).toEqual(built);
    } else {
      expect(parseReply(v.parse)).toEqual({ v: 1, ...(v.expect as object) });
    }
  });
});

describe('envelope vectors: open and configure arguments', () => {
  it.each(vectors.open.map((v) => [v.name, v] as const))('open: %s', (_name, v) => {
    const r = checkOpen(v.args);
    if (v.expect.ok) {
      expect(r).toEqual({ ok: true, entry: v.expect.entry, requestId: v.expect.requestId });
    } else {
      expect(r.ok).toBe(false);
      expect(v.expect.code).toBe('invalid_options');
    }
  });

  it.each(vectors.configure.map((v) => [JSON.stringify(v.args), v] as const))(
    'configure: %s',
    (_name, v) => {
      expect(checkConfigure(v.args) === null ? 'ok' : 'invalid_options').toBe(v.expect);
    },
  );
});
