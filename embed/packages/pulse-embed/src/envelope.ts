import { isRecoverableCode, normalizeErrorInfo } from './errors';
import type { BridgeEvent, BridgeReply, ContractVersion, Json, PulseErrorInfo } from './types';

/**
 * The bridge envelopes (native-bridge.md §2) as the JS side builds and reads them, plus the
 * facade's request routing (§2.1, §3) so the shared vectors in embed/native/ios/vectors/envelope.json
 * pin both sides, and a JS facade (the fake in ./testing) can route exactly like the Swift one.
 */

/** The contract this client speaks (AD18): major 1; minor 0 is PR1, minor 1 adds PR2's data API. */
export const CONTRACT: ContractVersion = Object.freeze({ major: 1, minor: 0 });

/**
 * The package version, sent as `client.version` for logs. Kept equal to package.json's `version`
 * by envelope-vectors.test.ts, so the release stamp (PR1-M) has to change both.
 */
export const CLIENT_VERSION = '0.0.0-dev';

/** The envelope version, always 1 in contract major 1. */
export const ENVELOPE_VERSION = 1;

/** Methods a minor-0 facade answers itself (PR1); the same list as PulseContract.nativeMethods. */
export const MINOR0_METHODS: readonly string[] = Object.freeze([
  'info',
  'configure',
  'prewarm',
  'open',
  'close',
  'isOpen',
  'pendingResults',
  'acknowledge',
  'logFile',
]);

export interface RequestEnvelope {
  v: 1;
  callId: string;
  method: string;
  args: Json;
  client: { contract: { major: number; minor: number }; version: string };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function randomHex(n: number): string {
  const bytes = new Uint8Array(Math.ceil(n / 2));
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s.slice(0, n);
}

/** `c-` + 12 random hex chars: unique enough per call, and short in log lines (§2.1). */
export function newCallId(): string {
  return `c-${randomHex(12)}`;
}

/** A UUID-shaped requestId (OpenBase.requestId's default). Plain-name safe: hex and dashes. */
export function newRequestId(): string {
  const h = randomHex(32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The request envelope a plugin passes through as one JSON string. */
export function buildRequest(method: string, args: Json, callId: string): RequestEnvelope {
  return {
    v: ENVELOPE_VERSION,
    callId,
    method,
    args: args ?? {},
    client: { contract: { major: CONTRACT.major, minor: CONTRACT.minor }, version: CLIENT_VERSION },
  };
}

/** JSON with object keys sorted, so the same value always prints the same text (Swift's `.sortedKeys`). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!isObject(v)) return v;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = v[k];
    return out;
  });
}

function parseText(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

/**
 * Reads a reply envelope (text or an already-parsed object). Unknown top-level fields are dropped;
 * `result` passes through untouched, unknown fields included (AD18 rule 3); an error is normalised
 * (callId, recoverable, unknown codes). Returns null when the input isn't a reply envelope at all,
 * which the client treats as a transport failure.
 */
export function parseReply(input: unknown, expectedCallId = ''): BridgeReply | null {
  const top = parseText(input);
  if (!isObject(top) || top.v !== ENVELOPE_VERSION || typeof top.ok !== 'boolean') return null;
  const callId = typeof top.callId === 'string' ? top.callId : expectedCallId;
  if (top.ok) {
    return { v: 1, callId, ok: true, result: (top.result ?? null) as Json };
  }
  return { v: 1, callId, ok: false, error: normalizeErrorInfo(top.error, callId) };
}

/** The reply envelope a facade sends (the fake's side; the vectors pin it against Swift's). */
export function buildReply(
  r:
    | { ok: true; callId: string; result?: Json }
    | {
        ok: false;
        callId: string;
        error: Omit<Partial<PulseErrorInfo>, 'code'> & { code: string };
      },
): BridgeReply {
  if (r.ok) return { v: 1, callId: r.callId, ok: true, result: r.result ?? null };
  const error = {
    ...r.error,
    message: r.error.message ?? r.error.code,
    recoverable: r.error.recoverable ?? isRecoverableCode(r.error.code),
    callId: r.callId,
  } as PulseErrorInfo;
  return { v: 1, callId: r.callId, ok: false, error };
}

/** Reads an event envelope; null for anything that isn't one (v 1, a string name). */
export function parseEvent(input: unknown): BridgeEvent | null {
  const top = parseText(input);
  if (!isObject(top) || top.v !== ENVELOPE_VERSION || typeof top.name !== 'string') return null;
  return { v: 1, name: top.name, payload: (top.payload ?? null) as Json };
}

// ─── The facade's routing (native-bridge.md §2.1, §3) ───────────────────────────────────────────

export type RouteResult =
  | { route: 'native'; callId: string; method: string; args: Record<string, Json> }
  | { route: 'reply'; reply: BridgeReply & { ok: false } };

export interface RouteOptions {
  /** `info().supported`: when false, every method except `info` is `unsupported`. */
  supported?: boolean;
  /** The methods the facade answers (its `info().methods`). Default: minor 0's. */
  methods?: readonly string[];
}

/**
 * What a facade does with one request envelope, in the Swift facade's order: not an object or no
 * callId → invalid_options with callId ""; then envelope `v`, then the client's contract major
 * (contract.unsupported wins over everything after the callId), then method, args, the method list
 * and `supported`. Unknown fields anywhere are ignored and `args` reaches the method whole.
 */
export function routeRequest(input: unknown, o: RouteOptions = {}): RouteResult {
  const methods = o.methods ?? MINOR0_METHODS;
  const fail = (code: string, message: string, callId: string): RouteResult => ({
    route: 'reply',
    reply: buildReply({ ok: false, callId, error: { code, message } }) as BridgeReply & {
      ok: false;
    },
  });
  const top = parseText(input);
  if (!isObject(top)) return fail('invalid_options', "The request isn't a JSON object.", '');
  const callId = top.callId;
  if (typeof callId !== 'string' || callId === '') {
    return fail('invalid_options', 'The request has no callId.', '');
  }
  if (typeof top.v !== 'number' || !Number.isInteger(top.v)) {
    return fail('invalid_options', 'The request has no envelope version (v).', callId);
  }
  if (top.v !== ENVELOPE_VERSION) {
    return fail('contract.unsupported', `Envelope version ${top.v} isn't supported.`, callId);
  }
  if (top.client !== undefined) {
    if (!isObject(top.client)) return fail('invalid_options', 'client must be an object.', callId);
    const contract = top.client.contract;
    if (contract !== undefined) {
      const major = isObject(contract) ? contract.major : undefined;
      if (typeof major !== 'number' || !Number.isInteger(major)) {
        return fail('invalid_options', 'client.contract.major must be a number.', callId);
      }
      if (major !== CONTRACT.major) {
        return fail(
          'contract.unsupported',
          `The client speaks contract major ${major}; this facade speaks ${CONTRACT.major}.`,
          callId,
        );
      }
    }
  }
  const method = top.method;
  if (typeof method !== 'string' || method === '') {
    return fail('invalid_options', 'The request has no method.', callId);
  }
  let args: Record<string, Json> = {};
  if (top.args !== undefined && top.args !== null) {
    if (!isObject(top.args)) return fail('invalid_options', 'args must be an object.', callId);
    args = top.args as Record<string, Json>;
  }
  if (!methods.includes(method)) {
    return fail('method.unsupported', `This PulseKit doesn't answer ${method}.`, callId);
  }
  if (o.supported === false && method !== 'info') {
    return fail('unsupported', "Pulse doesn't run on this device.", callId);
  }
  return { route: 'native', callId, method, args };
}
