import * as Crypto from 'expo-crypto';

import { uploadLog } from './upload-log';

// Pulse JS's side of the host requests (native-bridge.md §5, E2). Inside a host app, Pulse asks
// the host for an upload target and its tokens: a request leaves as the `hostRequest` event
// (`pulse.event`), and the host's `respondHostRequest` comes back as `pulse.respond`. Each request
// has 20 s: past that it fails `host.unavailable`, unanswered (the facade drops it at the same
// deadline and may say so first, `pulse.cmd hostTimeout`). The embed shell wires both directions
// (`setHostRequestSink`, `respondToHostRequest`, `hostRequestTimedOut`); the Pulse app sets no sink,
// so every request fails at once as unanswered.
//
// Tokens cross this channel and stay in memory (AD7): never in the database, the catalog or a log.
// The outbox keeps only their expiry (`upload_jobs.token_exp`).
//
// The request and result shapes mirror @mieweb/pulse-embed's HostRequestMap (shared code can't
// import the host package, lint zone `embed/`).

/** How long the host has to answer a request. */
export const HOST_REQUEST_TIMEOUT_MS = 20_000;

/** The host's place for a draft, as stored with it (`PulseContext`). */
export type HostPlace = {
  key: string;
  kind?: string;
  id?: string;
  label: string;
  data?: unknown;
  uploadType?: unknown;
  [field: string]: unknown;
};

export type UploadTargetRequest = {
  draftId: string;
  clientKey: string;
  draftKey: string;
  context: HostPlace;
  name: string;
  durationMs: number;
  bytes: number;
  sentAt: number;
  attempt: number;
  renewArtifact: boolean;
};

/** The host's PulseVault target for one upload (not the pool claim `target-provider`'s `UploadTarget`). */
export type HostUploadTarget = {
  uploadId: string;
  endpoint: string;
  artifactId: string;
  token: string;
  expiresAt: number;
  clientKey: string;
  state?: 'reserved' | 'uploading' | 'processing' | 'delivered' | 'kept';
};

export type TokenRequest = { uploadId: string; clientKey: string; draftId: string };
export type TokenResult = { token: string; expiresAt: number };
export type ReleaseRequest = {
  uploadId: string;
  clientKey: string;
  reason: 'canceled' | 'edited' | 'deleted';
};
export type ConfirmSendRequest = {
  draftId: string;
  draftKey: string;
  context: HostPlace;
  uploadType: unknown;
  sentAt: number;
  bytes: number;
};
export type ConfirmSendResult = { confirmedAt: number };

export type HostRequestMap = {
  getUploadTarget: { args: UploadTargetRequest; result: HostUploadTarget };
  refreshUploadToken: { args: TokenRequest; result: TokenResult };
  releaseUploadTarget: { args: ReleaseRequest; result: null };
  confirmSend: { args: ConfirmSendRequest; result: ConfirmSendResult };
};
export type HostRequestMethod = keyof HostRequestMap;

/** The `hostRequest` event's payload. */
export type HostRequestPayload = {
  [M in HostRequestMethod]: {
    hostCallId: string;
    method: M;
    args: HostRequestMap[M]['args'];
    /** Epoch ms after which the facade drops the request. */
    deadline: number;
  };
}[HostRequestMethod];

/** The codes a host may reject with (HostServiceError), plus a reply Pulse can't use. */
export type HostErrorCode =
  | 'destination.gone'
  | 'upload.refused'
  | 'upload.too_large'
  | 'no_account'
  | 'host.unavailable'
  | 'host_misconfigured';

const HOST_CODES: readonly HostErrorCode[] = [
  'destination.gone',
  'upload.refused',
  'upload.too_large',
  'no_account',
  'host.unavailable',
];

/**
 * A host request that failed. `unanswered`: nobody answered in time (or there's no host to ask),
 * which pauses a job (`needs_credentials`); a host that answered `host.unavailable` itself is
 * retried with backoff instead.
 */
export class HostRequestError extends Error {
  readonly code: HostErrorCode;
  readonly unanswered: boolean;
  constructor(code: HostErrorCode, message: string, unanswered = false) {
    super(message);
    this.name = 'HostRequestError';
    this.code = code;
    this.unanswered = unanswered;
  }
}

type Pending = {
  method: HostRequestMethod;
  resolve: (result: unknown) => void;
  reject: (error: HostRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();
let sink: ((payload: HostRequestPayload) => void) | null = null;

/**
 * Where host requests go (the embed: `channel.event('hostRequest', payload)`), or null for none.
 * Clearing it fails what's waiting, unanswered.
 */
export function setHostRequestSink(next: ((payload: HostRequestPayload) => void) | null): void {
  sink = next;
  if (!next) failPending('Pulse stopped talking to the host.');
}

function failPending(message: string): void {
  for (const [hostCallId, p] of [...pending]) {
    settle(hostCallId, p);
    p.reject(new HostRequestError('host.unavailable', message, true));
  }
}

function settle(hostCallId: string, p: Pending): void {
  clearTimeout(p.timer);
  pending.delete(hostCallId);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const TARGET_STATES = new Set(['reserved', 'uploading', 'processing', 'delivered', 'kept']);

/** Whether `result` is what `method` promises; anything else is the host's mistake. */
function validResult(method: HostRequestMethod, result: unknown): boolean {
  switch (method) {
    case 'getUploadTarget':
      return (
        isObject(result) &&
        isText(result.uploadId) &&
        isText(result.endpoint) &&
        isText(result.artifactId) &&
        isText(result.token) &&
        isTime(result.expiresAt) &&
        isText(result.clientKey) &&
        (result.state === undefined || TARGET_STATES.has(result.state as string))
      );
    case 'refreshUploadToken':
      return isObject(result) && isText(result.token) && isTime(result.expiresAt);
    case 'confirmSend':
      return isObject(result) && isTime(result.confirmedAt);
    case 'releaseUploadTarget':
      return true;
  }
}

/** The error a host's rejection becomes: its own code when it's one of the contract's. */
function hostError(error: unknown): HostRequestError {
  const code = isObject(error) ? error.code : undefined;
  const message =
    isObject(error) && typeof error.message === 'string' ? error.message : 'The host refused.';
  return HOST_CODES.includes(code as HostErrorCode)
    ? new HostRequestError(code as HostErrorCode, message)
    : new HostRequestError('host.unavailable', `The host answered ${String(code)}: ${message}`);
}

/**
 * The host's answer to a request (`pulse.respond {hostCallId, result | error}`). An answer to a
 * request that's no longer waiting (timed out, or answered already) is dropped.
 */
export function respondToHostRequest(message: {
  hostCallId?: unknown;
  result?: unknown;
  error?: unknown;
}): void {
  const hostCallId = message.hostCallId;
  if (typeof hostCallId !== 'string') return;
  const p = pending.get(hostCallId);
  if (!p) {
    uploadLog.info(`host: a late answer to ${hostCallId}, dropped`);
    return;
  }
  settle(hostCallId, p);
  if (message.error !== undefined && message.error !== null) {
    const error = hostError(message.error);
    uploadLog.warn(`host: ${p.method} ${hostCallId} refused: ${error.code}`);
    p.reject(error);
    return;
  }
  const result = message.result ?? null;
  if (!validResult(p.method, result)) {
    uploadLog.warn(`host: ${p.method} ${hostCallId} answered something Pulse can't use`);
    p.reject(
      new HostRequestError('host_misconfigured', `The host's ${p.method} answer is incomplete.`),
    );
    return;
  }
  p.resolve(result);
}

/** The facade dropped the request at its deadline (`pulse.cmd hostTimeout`). */
export function hostRequestTimedOut(hostCallId: string): void {
  const p = pending.get(hostCallId);
  if (!p) return;
  settle(hostCallId, p);
  p.reject(timedOut(p.method));
}

const timedOut = (method: HostRequestMethod) =>
  new HostRequestError(
    'host.unavailable',
    `The host didn't answer ${method} in ${HOST_REQUEST_TIMEOUT_MS / 1000} s.`,
    true,
  );

/** Ask the host; resolves with its answer, or rejects with a `HostRequestError`. */
export function hostRequest<M extends HostRequestMethod>(
  method: M,
  args: HostRequestMap[M]['args'],
): Promise<HostRequestMap[M]['result']> {
  const send = sink;
  if (!send) {
    return Promise.reject(
      new HostRequestError('host.unavailable', 'There is no host to ask.', true),
    );
  }
  const hostCallId = `h-${Crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const p = pending.get(hostCallId);
      if (!p) return;
      settle(hostCallId, p);
      uploadLog.warn(`host: ${method} ${hostCallId} timed out`);
      reject(timedOut(method));
    }, HOST_REQUEST_TIMEOUT_MS);
    pending.set(hostCallId, {
      method,
      resolve: resolve as (result: unknown) => void,
      reject,
      timer,
    });
    uploadLog.info(`host: ${method} ${hostCallId}`);
    try {
      send({
        hostCallId,
        method,
        args,
        deadline: Date.now() + HOST_REQUEST_TIMEOUT_MS,
      } as HostRequestPayload);
    } catch (e) {
      const p = pending.get(hostCallId);
      if (p) settle(hostCallId, p);
      reject(
        new HostRequestError(
          'host.unavailable',
          `Couldn't reach the host: ${e instanceof Error ? e.message : String(e)}`,
          true,
        ),
      );
    }
  });
}

// Tokens (memory only) ---------------------------------------------------------------------------

const tokens = new Map<string, TokenResult>();

/** The token the host last handed out for `uploadId`, or null (never stored on disk). */
export function uploadToken(uploadId: string): TokenResult | null {
  return tokens.get(uploadId) ?? null;
}

/** Forget every token (the library is released, or the account changed). */
export function forgetUploadTokens(): void {
  tokens.clear();
}

/** `getUploadTarget`, keeping the target's token in memory for its upload. */
export async function getUploadTarget(r: UploadTargetRequest): Promise<HostUploadTarget> {
  const target = await hostRequest('getUploadTarget', r);
  tokens.set(target.uploadId, { token: target.token, expiresAt: target.expiresAt });
  return target;
}

/** `refreshUploadToken`, replacing the upload's token in memory. */
export async function refreshUploadToken(r: TokenRequest): Promise<TokenResult> {
  const fresh = await hostRequest('refreshUploadToken', r);
  tokens.set(r.uploadId, { token: fresh.token, expiresAt: fresh.expiresAt });
  return fresh;
}

/**
 * `releaseUploadTarget`, fire and forget: the host's server sweeps an abandoned upload after
 * 24 h anyway, so a host that doesn't answer (or has no handler) changes nothing. The upload's
 * token is forgotten either way.
 */
export async function releaseUploadTarget(r: ReleaseRequest): Promise<void> {
  tokens.delete(r.uploadId);
  try {
    await hostRequest('releaseUploadTarget', r);
  } catch (e) {
    const code = e instanceof HostRequestError ? e.code : String(e);
    uploadLog.info(
      `host: releaseUploadTarget not confirmed (${code}); the server's sweep covers it`,
    );
  }
}

/** `confirmSend` (AD23): the host's clock action for a Send, before Pulse queues it. */
export function confirmSend(r: ConfirmSendRequest): Promise<ConfirmSendResult> {
  return hostRequest('confirmSend', r);
}
