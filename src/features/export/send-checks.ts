/**
 * What a host's upload type asks of Export before Send (C7, PLAN-final §5.3, §8 `UploadTypeSpec`):
 *
 * - `requireName`: the primary action is disabled until the draft has a name of its own.
 * - `requireOnline`: disabled offline, with "Needs a connection" (AD23: a clock action can't run
 *   offline), and checked again at the tap, since the network can drop between render and tap.
 * - `maxBytes`: the host server's size cap (O15). Not a recording limit and not a block: Export
 *   warns "Too large to send (max 500 MB) · Trim" before Send, and the server refuses the upload.
 *
 * Pure: the screen passes the draft's stored upload type, its name, the network and the merged
 * file's size. A draft without a host context (the Pulse app) has no rules, and nothing changes.
 * Sending itself is PR2-I's (send-flow).
 */

/** The fields of a stored `UploadTypeSpec` that Pulse reads (`id` is opaque). */
export type UploadRules = {
  id: string | null;
  /** The banner's kind label: "Ticket", "Clock session". */
  title: string | null;
  /** The recorder banner's second line. */
  prompt: string | null;
  /** Export's primary action label (PR2-I's Send). */
  sendLabel: string | null;
  requireName: boolean;
  requireOnline: boolean;
  /** The host's upload size cap in bytes, or null for none. */
  maxBytes: number | null;
};

const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

/**
 * The rules in a stored upload type (`drafts.upload_type_json`, parsed), or null when there's
 * none. Lenient: a field of the wrong type reads as unset, so a newer host's spec never breaks
 * Export (the embed validates what it stores; this reads what's there).
 */
export function uploadRulesOf(raw: unknown): UploadRules | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  const maxBytes =
    typeof t.maxBytes === 'number' && Number.isFinite(t.maxBytes) && t.maxBytes > 0
      ? t.maxBytes
      : null;
  return {
    id: text(t.id),
    title: text(t.title),
    prompt: text(t.prompt),
    sendLabel: text(t.sendLabel),
    requireName: t.requireName === true,
    requireOnline: t.requireOnline === true,
    maxBytes,
  };
}

/** Why the primary action is disabled. */
export type SendBlock = 'name' | 'offline';

export const NEEDS_NAME = 'Name this video to send it';
export const NEEDS_CONNECTION = 'Needs a connection';
export const TRIM_LABEL = 'Trim';

export type SendCheck = {
  /** The first reason the primary action is disabled (a name, then the network), or null. */
  block: SendBlock | null;
  /** The line shown with the disabled action. */
  blockText: string | null;
  /** Over the host's cap: the warning shown before Send, with its Trim action. */
  tooLarge: { maxBytes: number; text: string } | null;
};

export type SendCheckInput = {
  rules: UploadRules | null;
  /** The draft's own name (not a place label standing in for it). */
  name: string | null;
  online: boolean;
  /** The merged file's size, or null while unknown (still merging). */
  exportBytes: number | null;
};

const OK: SendCheck = { block: null, blockText: null, tooLarge: null };

/**
 * The checks for one render, or for the tap (call it again with the network as it is then: a
 * blocked result at the tap means the action doesn't run).
 */
export function checkSend({ rules, name, online, exportBytes }: SendCheckInput): SendCheck {
  if (!rules) return OK;
  let block: SendBlock | null = null;
  if (rules.requireName && !text(name)) block = 'name';
  else if (rules.requireOnline && !online) block = 'offline';
  const tooLarge =
    rules.maxBytes != null && exportBytes != null && exportBytes > rules.maxBytes
      ? { maxBytes: rules.maxBytes, text: tooLargeText(rules.maxBytes) }
      : null;
  return {
    block,
    blockText: block === 'name' ? NEEDS_NAME : block === 'offline' ? NEEDS_CONNECTION : null,
    tooLarge,
  };
}

/** "Too large to send (max 500 MB)": the warning's text; Trim is its action. */
export function tooLargeText(maxBytes: number): string {
  return `Too large to send (max ${formatCap(maxBytes)})`;
}

/** A cap as people read it: "500 MB", "1.5 GB" (binary units, as the phone shows storage). */
export function formatCap(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
