import type { Json } from './types';

/**
 * Argument checks. Only what is required and the types of known fields are checked: unknown fields
 * pass (AD18 rule 3). `open` and `configure` follow the Swift facade's PulseArgs exactly (the shared
 * vectors pin both); the rest are the client's checks for the methods it forwards, so a bad call
 * fails with `invalid_options` before it crosses the bridge.
 */

/** The validation result: null when fine, else the `invalid_options` message. */
export type Problem = string | null;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

const PLAIN = /^[A-Za-z0-9._-]+$/;

/** 1–64 of [A-Za-z0-9._-], never "." or "..": ids that become file names (requestIds). */
export function isPlainName(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 64 && s !== '.' && s !== '..' && PLAIN.test(s);
}

/**
 * A requestId: a plain name that doesn't end in `.project`. Its result is `<id>.json` in the
 * inbox, and `<id>.project.json` is a project document there, never a result, so
 * `take.project`'s result would never reach `pendingResults`.
 */
export function isRequestId(s: unknown): s is string {
  return isPlainName(s) && !s.endsWith('.project');
}

const HOST_ID = /^[a-z0-9.-]{1,40}$/;

/** ConfigureOptions.hostId: 1–40 of [a-z0-9.-] with at least one letter or digit. */
export function isValidHostId(s: unknown): s is string {
  return typeof s === 'string' && HOST_ID.test(s) && /[a-z0-9]/.test(s);
}

const ENTRIES = ['record', 'edit', 'export'];

export type OpenCheck =
  { ok: true; entry: string; requestId: string | null } | { ok: false; message: string };

/** `open`'s checks before anything is presented (Swift PulseArgs.open). */
export function checkOpen(args: unknown): OpenCheck {
  const bad = (message: string): OpenCheck => ({ ok: false, message });
  if (!isObject(args)) return bad('open needs an object.');
  let requestId: string | null = null;
  if (args.requestId !== undefined && args.requestId !== null) {
    if (!isRequestId(args.requestId)) {
      return bad(
        'requestId must be 1–64 letters, digits, dots, dashes or underscores, not ending in .project.',
      );
    }
    requestId = args.requestId;
  }
  const entry = args.entry;
  if (typeof entry !== 'string') return bad('open needs an entry.');
  if (!ENTRIES.includes(entry)) return bad(`Pulse has no entry named ${entry}.`);
  if (args.theme !== undefined && args.theme !== null && !isObject(args.theme)) {
    return bad('theme must be an object.');
  }
  if (entry === 'record') {
    const context = args.context;
    if (!isObject(context) || !isNonEmptyString(context.key)) {
      return bad('record needs a context with a key.');
    }
    const draft = args.draft;
    if (draft !== undefined && draft !== null) {
      const continues = isObject(draft) && isNonEmptyString(draft.continue);
      if (draft !== 'new' && !continues)
        return bad("draft must be 'new' or { continue: draftId }.");
    }
  } else if (!isNonEmptyString(args.draftId)) {
    return bad(`${entry} needs a draftId.`);
  }
  return { ok: true, entry, requestId };
}

/** `configure`'s checks: only what the facade itself uses (Swift PulseArgs.configure). */
export function checkConfigure(args: unknown): Problem {
  if (!isObject(args)) return 'configure needs an object.';
  if (args.hostId !== undefined && args.hostId !== null && !isValidHostId(args.hostId)) {
    return 'hostId must be 1–40 of a-z, 0-9, dots and dashes.';
  }
  if (
    args.uploadMode !== undefined &&
    args.uploadMode !== null &&
    args.uploadMode !== 'pulse' &&
    args.uploadMode !== 'file'
  ) {
    return "uploadMode must be 'pulse' or 'file'.";
  }
  for (const key of ['policy', 'theme', 'models']) {
    const v = args[key];
    if (v !== undefined && v !== null && !isObject(v)) return `${key} must be an object.`;
  }
  return null;
}

function needsId(args: Record<string, unknown>): Problem {
  return isNonEmptyString(args.id) ? null : 'id must be a non-empty string.';
}

function optionalArray(args: Record<string, unknown>, key: string): Problem {
  const v = args[key];
  return v === undefined || Array.isArray(v) ? null : `${key} must be an array.`;
}

function optionalString(args: Record<string, unknown>, key: string): Problem {
  const v = args[key];
  return v === undefined || typeof v === 'string' ? null : `${key} must be a string.`;
}

// Per-method checks for what the client forwards. A method missing here takes any object.
const CHECKS: Record<string, (args: Record<string, unknown>) => Problem> = {
  open: (a) => {
    const r = checkOpen(a);
    return r.ok ? null : r.message;
  },
  configure: checkConfigure,
  close: (a) => {
    if (a.reason !== undefined && a.reason !== 'host') return "reason must be 'host'.";
    if (a.discard !== undefined && typeof a.discard !== 'boolean') {
      return 'discard must be a boolean.';
    }
    return null;
  },
  acknowledge: (a) =>
    isRequestId(a.requestId)
      ? null
      : 'requestId must be 1–64 of [A-Za-z0-9._-], not ending in .project.',
  setAccount: (a) => {
    // `{}` is the wire form of setAccount(null) (a null args becomes {} on the facade).
    if (Object.keys(a).length === 0) return null;
    if (!isNonEmptyString(a.serverOrigin)) return 'serverOrigin must be a non-empty string.';
    if (!isNonEmptyString(a.userId)) return 'userId must be a non-empty string.';
    return optionalString(a, 'label');
  },
  listDrafts: (a) =>
    optionalString(a, 'contextKey') ??
    optionalString(a, 'contextKeyPrefix') ??
    optionalString(a, 'contextKind') ??
    optionalArray(a, 'states'),
  getDraft: needsId,
  countDrafts: (a) =>
    a.by === 'contextKey' || a.by === 'contextKind'
      ? optionalArray(a, 'states')
      : "by must be 'contextKey' or 'contextKind'.",
  renameDraft: (a) => needsId(a) ?? (typeof a.name === 'string' ? null : 'name must be a string.'),
  setDraftContext: (a) =>
    needsId(a) ??
    (isObject(a.context) && isNonEmptyString(a.context.key)
      ? null
      : 'context must be an object with a key.'),
  deleteDraft: needsId,
  upload: needsId,
  cancelUpload: needsId,
  retireDraft: needsId,
  dismissReceipt: needsId,
  purge: (a) => optionalString(a, 'namespace'),
  respondHostRequest: (a) =>
    isNonEmptyString(a.hostCallId) ? null : 'hostCallId must be a non-empty string.',
};

/** The client's check for one call's args: null when it may cross the bridge. */
export function checkArgs(method: string, args: Json): Problem {
  if (!isObject(args)) return 'args must be an object.';
  const check = CHECKS[method];
  return check ? check(args) : null;
}
