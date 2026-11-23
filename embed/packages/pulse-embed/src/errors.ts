import type { HostServiceError, PulseError, PulseErrorCode, PulseErrorInfo } from './types';

// Every PulseErrorCode, as a value. A Record over the union makes tsc fail when types.ts gains a
// code that isn't listed here (AD18 rule 4: codes are append-only, and a client maps the ones it
// doesn't know to `unknown`).
const ERROR_CODES: Record<PulseErrorCode, true> = {
  unavailable: true,
  unsupported: true,
  'contract.unsupported': true,
  'method.unsupported': true,
  busy: true,
  invalid_options: true,
  not_found: true,
  'draft.locked': true,
  'host.unavailable': true,
  restart_required: true,
  host_misconfigured: true,
  no_account: true,
  timeout: true,
  'storage.full': true,
  'storage.newer_schema': true,
  'storage.damaged': true,
  unknown: true,
  'runtime.paused': true,
  'permission.camera': true,
  'permission.microphone': true,
  'export.failed': true,
  'upload.failed': true,
  'upload.refused': true,
  'destination.gone': true,
  'credentials.expired': true,
  'runtime.error': true,
  'upload.too_large': true,
};

export function isKnownErrorCode(code: unknown): code is PulseErrorCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
}

// The same set as the Swift facade's PulseErrorInfo.isRecoverable, so a reply built on either side
// says the same thing when it doesn't say anything itself.
const RECOVERABLE = new Set<string>([
  'busy',
  'timeout',
  'host.unavailable',
  'runtime.error',
  'upload.failed',
]);

/** True when a call that failed with `code` may succeed later without a change by the person. */
export function isRecoverableCode(code: string): boolean {
  return RECOVERABLE.has(code);
}

type Extra = Partial<Omit<PulseErrorInfo, 'code' | 'message' | 'callId'>>;

/** A PulseError (an Error carrying PulseErrorInfo) for a call the client fails itself. */
export function pulseError(
  code: PulseErrorCode,
  message: string,
  callId: string,
  extra: Extra = {},
): PulseError {
  const info: PulseErrorInfo = {
    code,
    message,
    recoverable: isRecoverableCode(code),
    callId,
    ...extra,
  };
  return Object.assign(new Error(message), info, { name: 'PulseError' as const });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * PulseErrorInfo from whatever a reply carried. Unknown fields are kept; a code this client doesn't
 * know becomes `unknown` with the facade's code in `reason` (AD18 rule 4); a missing callId is the
 * call's; a missing `recoverable` is the code's default.
 */
export function normalizeErrorInfo(raw: unknown, callId: string): PulseErrorInfo {
  const src = isObject(raw) ? raw : {};
  const known = isKnownErrorCode(src.code);
  const code: PulseErrorCode = known ? (src.code as PulseErrorCode) : 'unknown';
  const info: PulseErrorInfo = {
    ...(src as Partial<PulseErrorInfo>),
    code,
    message: typeof src.message === 'string' ? src.message : `Pulse failed (${String(src.code)})`,
    recoverable: typeof src.recoverable === 'boolean' ? src.recoverable : isRecoverableCode(code),
    callId: typeof src.callId === 'string' && src.callId !== '' ? src.callId : callId,
  };
  if (!known && typeof src.code === 'string' && info.reason === undefined) {
    info.reason = src.code;
  }
  return info;
}

/** The PulseError a call rejects with for an `ok: false` reply. */
export function errorFromReply(raw: unknown, callId: string): PulseError {
  const info = normalizeErrorInfo(raw, callId);
  return Object.assign(new Error(info.message), info, { name: 'PulseError' as const });
}

/** Plain PulseErrorInfo (no stack, JSON-safe) from anything a promise rejected with. */
export function toErrorInfo(e: unknown, callId = 'local'): PulseErrorInfo {
  if (isObject(e) && e.name === 'PulseError') {
    const { name: _name, stack: _stack, ...rest } = e as unknown as PulseError;
    return normalizeErrorInfo({ ...rest, message: (e as unknown as Error).message }, callId);
  }
  const message = e instanceof Error ? e.message : String(e);
  return normalizeErrorInfo({ code: 'unknown', message }, callId);
}

const HOST_SERVICE_CODES: Record<HostServiceError['code'], true> = {
  'destination.gone': true,
  'upload.refused': true,
  no_account: true,
  'host.unavailable': true,
  'upload.too_large': true,
};

/**
 * What a HostServices handler's rejection becomes on the wire. A handler rejects with
 * `{ code, message }` using one of HostServiceError's codes; anything else (a thrown TypeError, a
 * network error, an unknown code) counts as `host.unavailable`, which Pulse retries.
 */
export function toHostServiceError(e: unknown): HostServiceError {
  const message =
    isObject(e) && typeof e.message === 'string'
      ? e.message
      : e instanceof Error
        ? e.message
        : String(e);
  if (
    isObject(e) &&
    typeof e.code === 'string' &&
    Object.prototype.hasOwnProperty.call(HOST_SERVICE_CODES, e.code)
  ) {
    return { code: e.code as HostServiceError['code'], message };
  }
  return { code: 'host.unavailable', message };
}
