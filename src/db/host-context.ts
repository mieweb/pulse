// The library's rules for a host app that embeds Pulse: the coded errors its writes refuse with,
// whether the library is read-only, and the host place a draft is for (its `PulseContext`), as the
// library stores it in four `drafts` columns. No database here, so every writer (and every test
// that stands in for the client) gets the same rules.

/**
 * Why a library call refused, with the code the embed's host sees (`PulseErrorInfo.code`, and
 * `reason` inside it, e.g. `clock_bound` on `draft.locked`). The message is for logs.
 */
export type LibraryErrorCode =
  'invalid_options' | 'not_found' | 'draft.locked' | 'storage.newer_schema';

export class LibraryError extends Error {
  readonly code: LibraryErrorCode;
  readonly reason?: string;
  constructor(code: LibraryErrorCode, message: string, reason?: string) {
    super(message);
    this.name = 'LibraryError';
    this.code = code;
    if (reason !== undefined) this.reason = reason;
  }
}

let readOnly = false;

/**
 * Make the library read-only for the rest of this runtime: a newer Pulse migrated it (the
 * downgrade guard, `openReadOnlyIfNewer` in client.ts, which also stops SQLite writing).
 */
export function markLibraryReadOnly(): void {
  readOnly = true;
}

/** Whether this runtime's library is read-only. */
export function libraryReadOnly(): boolean {
  return readOnly;
}

/** Throw `storage.newer_schema` when the library is read-only: the start of every library write. */
export function assertWritable(): void {
  if (readOnly) {
    throw new LibraryError(
      'storage.newer_schema',
      'The library was written by a newer version of Pulse; update Pulse to change it.',
    );
  }
}

/** A context key's longest length, in characters. */
export const CONTEXT_KEY_MAX = 128;
/** A context label's longest length, in characters. */
export const CONTEXT_LABEL_MAX = 120;
/** Each JSON column's largest size, in UTF-8 bytes. */
export const CONTEXT_JSON_MAX_BYTES = 8 * 1024;
/** `${kind}:${id}`, lower case, as the host's place module builds it. */
const CONTEXT_KEY = /^[a-z0-9._-]+:[a-z0-9._:-]+$/;

/** The host's context as it hands it over: the key and label, and whatever else it carries. */
export type HostContext = {
  key: string;
  label: string;
  kind?: string;
  id?: string;
  data?: unknown;
  uploadType?: unknown;
  [field: string]: unknown;
};

/** The `drafts` columns a context is stored in. */
export type HostContextColumns = {
  contextKey: string;
  contextLabel: string;
  contextJson: string;
  uploadTypeJson: string | null;
};

const invalid = (message: string): never => {
  throw new LibraryError('invalid_options', message);
};

/** UTF-8 byte length without TextEncoder (not in every Hermes build). */
export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next < 0xe000) {
        bytes += 4; // a surrogate pair: one code point
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function json(value: unknown, name: string): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return invalid(`${name} must be JSON.`);
  }
  if (text === undefined) return invalid(`${name} must be JSON.`);
  const bytes = utf8Length(text);
  if (bytes > CONTEXT_JSON_MAX_BYTES) {
    invalid(`${name} is ${bytes} bytes as JSON, over ${CONTEXT_JSON_MAX_BYTES}.`);
  }
  return text;
}

/**
 * The columns for `context`, checked: the key is `kind:id` in [a-z0-9._:-] and at most 128
 * characters, the label is not blank and at most 120 characters, and the context (without its key
 * and upload type) and the upload type are each at most 8 KB as JSON. `uploadType` defaults to
 * the context's own. Anything else rejects with `invalid_options`.
 */
export function hostContextColumns(
  context: HostContext,
  uploadType: unknown = context?.uploadType,
): HostContextColumns {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) {
    invalid('The context must be an object.');
  }
  const { key, label, uploadType: _ownType, ...rest } = context;
  if (typeof key !== 'string' || key.length > CONTEXT_KEY_MAX || !CONTEXT_KEY.test(key)) {
    invalid(`The context key must be kind:id, 1–${CONTEXT_KEY_MAX} chars of [a-z0-9._:-].`);
  }
  if (typeof label !== 'string' || label.trim().length === 0) {
    invalid('The context label must not be blank.');
  }
  if (Array.from(label).length > CONTEXT_LABEL_MAX) {
    invalid(`The context label must be at most ${CONTEXT_LABEL_MAX} characters.`);
  }
  return {
    contextKey: key,
    contextLabel: label,
    contextJson: json({ ...rest, label }, 'The context'),
    uploadTypeJson: uploadType == null ? null : json(uploadType, 'The upload type'),
  };
}

/**
 * The context the columns hold, as the host handed it over (with its upload type), or null for a
 * draft without one. Columns that don't parse give null rather than a context missing its parts.
 */
export function hostContextOf(row: {
  contextKey: string | null;
  contextLabel: string | null;
  contextJson: string | null;
  uploadTypeJson: string | null;
}): HostContext | null {
  if (row.contextKey == null || row.contextLabel == null || row.contextJson == null) return null;
  try {
    const rest = JSON.parse(row.contextJson) as Record<string, unknown>;
    const uploadType = row.uploadTypeJson == null ? undefined : JSON.parse(row.uploadTypeJson);
    return {
      ...rest,
      key: row.contextKey,
      label: row.contextLabel,
      ...(uploadType !== undefined ? { uploadType } : null),
    };
  } catch {
    return null;
  }
}
