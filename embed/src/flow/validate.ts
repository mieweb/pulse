import { CONTEXT_KEY_MAX } from '@mieweb/pulse-embed';
import type {
  Json,
  OpenRequest,
  PulseContext,
  ThemeBridge,
  UploadTypeSpec,
} from '@mieweb/pulse-embed';

/**
 * Pulse's own check of an `open` request, before any screen shows (B2). The facade already
 * checked the envelope (entry, requestId, draftId); this checks what Pulse uses, the context
 * above all: `record` needs one (Q3: no global camera), and Pulse stores it whole, so its size is
 * capped.
 *
 * Contract rule 3: a field Pulse doesn't know is ignored (dropped from the request; a context is
 * kept whole, since it's handed back unchanged). A missing required field or a wrong type is
 * `invalid_options`. A JSON `null` for an optional field counts as absent, as in the facade.
 */

/** A context's largest size, as UTF-8 JSON (PulseContext). */
export const CONTEXT_MAX_BYTES = 8 * 1024;
/** A context label's longest length, in characters. */
export const LABEL_MAX = 120;
/** The facade's own requestId rule (pulseIsPlainName): it names files under results/. */
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
const CONTEXT_KEY = /^[a-z0-9._:-]+$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export type UploadMode = 'pulse' | 'file';

export type OpenCheck =
  | { ok: true; request: OpenRequest }
  | { ok: false; code: 'invalid_options' | 'unsupported'; message: string };

/**
 * Check `raw` (the request from the initial props) against the host's configured upload mode
 * (`configure({uploadMode})`, default 'pulse'). In PR1 only 'file' runs: Export has no Send yet,
 * so 'pulse' is `unsupported` (B2) once the request itself is valid.
 */
export function checkOpenRequest(raw: unknown, uploadMode: unknown = 'pulse'): OpenCheck {
  let request: OpenRequest;
  try {
    request = openRequest(raw);
    const mode = uploadModeOf(uploadMode);
    if (mode === 'pulse') {
      return {
        ok: false,
        code: 'unsupported',
        message: "uploadMode 'pulse' isn't supported by this version of Pulse; use 'file'.",
      };
    }
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, code: 'invalid_options', message: e.message };
    throw e;
  }
  return { ok: true, request };
}

/** Why a context can't be used, or null when it can. For `record` and later for Move to… (PR2). */
export function contextProblem(raw: unknown): string | null {
  try {
    context(raw, 'context');
    return null;
  } catch (e) {
    if (e instanceof Invalid) return e.message;
    throw e;
  }
}

class Invalid extends Error {}

function invalid(message: string): never {
  throw new Invalid(message);
}

function openRequest(raw: unknown): OpenRequest {
  const r = object(raw, 'the request');
  const requestId = optional(r.requestId, (v) => {
    if (typeof v !== 'string' || !REQUEST_ID.test(v) || v === '.' || v === '..') {
      invalid('requestId must be 1–64 letters, digits, dots, dashes or underscores.');
    }
    return v;
  });
  const theme = optional(r.theme, (v) => themeBridge(v));
  const base = {
    ...(requestId !== undefined ? { requestId } : null),
    ...(theme !== undefined ? { theme } : null),
  };

  switch (r.entry) {
    case 'record': {
      if (r.context === undefined || r.context === null) invalid('record needs a context.');
      const draft = optional(r.draft, (v) => {
        if (v === 'new') return 'new' as const;
        const d = typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null;
        const id = d ? (d as { continue?: unknown }).continue : undefined;
        if (typeof id !== 'string' || id.length === 0) {
          invalid("draft must be 'new' or { continue: draftId }.");
        }
        return { continue: id };
      });
      return {
        ...base,
        entry: 'record',
        context: context(r.context, 'context'),
        ...(draft !== undefined ? { draft } : null),
      };
    }
    case 'edit': {
      const clipId = optional(r.clipId, (v) => nonEmpty(v, 'clipId'));
      return {
        ...base,
        entry: 'edit',
        draftId: nonEmpty(r.draftId, 'draftId'),
        ...(clipId !== undefined ? { clipId } : null),
      };
    }
    case 'export':
      return {
        ...base,
        entry: 'export',
        draftId: nonEmpty(r.draftId, 'draftId'),
      };
    default:
      return invalid(
        typeof r.entry === 'string'
          ? `Pulse has no entry named ${JSON.stringify(r.entry)}.`
          : 'open needs an entry.',
      );
  }
}

function uploadModeOf(v: unknown): UploadMode {
  if (v === undefined || v === null) return 'pulse';
  if (v === 'pulse' || v === 'file') return v;
  return invalid("uploadMode must be 'pulse' or 'file'.");
}

function context(raw: unknown, name: string): PulseContext {
  const c = object(raw, name);
  const key = nonEmpty(c.key, `${name}.key`);
  if (key.length > CONTEXT_KEY_MAX || !CONTEXT_KEY.test(key)) {
    invalid(`${name}.key must be 1–${CONTEXT_KEY_MAX} chars of [a-z0-9._:-].`);
  }
  nonEmpty(c.kind, `${name}.kind`);
  nonEmpty(c.id, `${name}.id`);
  const label = nonEmpty(c.label, `${name}.label`);
  if (label.trim().length === 0) invalid(`${name}.label must not be blank.`);
  if (Array.from(label).length > LABEL_MAX) {
    invalid(`${name}.label must be at most ${LABEL_MAX} characters.`);
  }
  optional(c.uploadType, (v) => uploadType(v, `${name}.uploadType`));
  const bytes = utf8Length(JSON.stringify(c));
  if (bytes > CONTEXT_MAX_BYTES) {
    invalid(`${name} is ${bytes} bytes as JSON, over ${CONTEXT_MAX_BYTES}.`);
  }
  // Kept whole: Pulse hands the host's context back unchanged (DraftSummary, FlowResult).
  return c as unknown as PulseContext;
}

function uploadType(raw: unknown, name: string): UploadTypeSpec {
  const t = object(raw, name);
  nonEmpty(t.id, `${name}.id`);
  if (typeof t.version !== 'number' || !Number.isFinite(t.version)) {
    invalid(`${name}.version must be a number.`);
  }
  for (const field of ['title', 'sendLabel', 'prompt'] as const) {
    optional(t[field], (v) => typeof v === 'string' || invalid(`${name}.${field} must be text.`));
  }
  for (const field of ['requireName', 'requireOnline', 'confirmSend'] as const) {
    optional(
      t[field],
      (v) => typeof v === 'boolean' || invalid(`${name}.${field} must be true or false.`),
    );
  }
  optional(t.maxBytes, (v) => count(v, `${name}.maxBytes`));
  optional(t.limits, (v) => {
    const l = object(v, `${name}.limits`);
    optional(l.maxDurationMs, (n) => count(n, `${name}.limits.maxDurationMs`));
    optional(l.minClips, (n) => count(n, `${name}.limits.minClips`));
    return l;
  });
  return t as unknown as UploadTypeSpec;
}

function themeBridge(raw: unknown): ThemeBridge {
  const t = object(raw, 'theme');
  const appearance = optional(t.appearance, (v) =>
    v === 'light' || v === 'dark' || v === 'system'
      ? v
      : invalid("theme.appearance must be 'light', 'dark' or 'system'."),
  );
  const color = (v: unknown, field: string) =>
    typeof v === 'string' && HEX_COLOR.test(v) ? v : invalid(`theme.${field} must be '#rrggbb'.`);
  const accent = optional(t.accent, (v) => color(v, 'accent'));
  const destructive = optional(t.destructive, (v) => color(v, 'destructive'));
  const buttonRadius = optional(t.buttonRadius, (v) => count(v, 'theme.buttonRadius'));
  return {
    ...(appearance !== undefined ? { appearance } : null),
    ...(accent !== undefined ? { accent } : null),
    ...(destructive !== undefined ? { destructive } : null),
    ...(buttonRadius !== undefined ? { buttonRadius } : null),
  };
}

function object(v: unknown, name: string): Record<string, Json | undefined> {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    invalid(`${name} must be an object.`);
  return v as Record<string, Json | undefined>;
}

function nonEmpty(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) invalid(`${name} must be non-empty text.`);
  return v;
}

/** A finite number ≥ 0. */
function count(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    invalid(`${name} must be a number ≥ 0.`);
  }
  return v;
}

function optional<T>(v: unknown, check: (v: unknown) => T): T | undefined {
  return v === undefined || v === null ? undefined : check(v);
}

/** UTF-8 byte length without TextEncoder (not in every Hermes build). */
function utf8Length(s: string): number {
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
