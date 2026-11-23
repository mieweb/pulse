import type {
  ConfigureOptions,
  EntryName,
  FlowScreen,
  OpenRequest,
  PulseErrorInfo,
} from '@mieweb/pulse-embed';

import { FIRST_SCREEN } from '../flow/reducer';
import { checkOpenRequest } from '../flow/validate';

/**
 * The embed's entries (B2): what a host can open, and the screen each one starts on. There is no
 * Drafts screen and no home: every entry is one task, recorder ⇄ editor → export, and the flow
 * ends with one result. A host never names a screen, only an entry.
 */
export type EntrySpec = {
  /** The screen the entry shows first (the reducer's stack starts with it). */
  firstScreen: FlowScreen;
  /** The existing draft the entry opens, or null when it records a new one. */
  draftOf(request: OpenRequest): string | null;
};

export const ENTRIES: Readonly<Record<EntryName, EntrySpec>> = {
  record: {
    firstScreen: FIRST_SCREEN.record,
    draftOf: (r) => (r.entry === 'record' && typeof r.draft === 'object' ? r.draft.continue : null),
  },
  edit: {
    firstScreen: FIRST_SCREEN.edit,
    draftOf: (r) => (r.entry === 'edit' ? r.draftId : null),
  },
  export: {
    firstScreen: FIRST_SCREEN.export,
    draftOf: (r) => (r.entry === 'export' ? r.draftId : null),
  },
};

export function isEntryName(v: unknown): v is EntryName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ENTRIES, v);
}

/** What the facade passes as the root component's initial props (native-bridge.md §8.1). */
export type EmbedProps = {
  requestId?: string;
  request?: unknown;
  documentsDir?: string;
  cachesDir?: string;
  modelsDir?: string;
  namespace?: string;
  config?: unknown;
  headless?: boolean;
};

/** The request, checked and ready to run. */
export type OpenPlan = {
  ok: true;
  requestId: string;
  request: OpenRequest;
  /** The draft the entry opens (edit, export, record continue), checked for existence later. */
  draftId: string | null;
  config: ConfigureOptions;
};

/** Why the request can't run. `entry` is null when even the entry is unknown. */
export type OpenRefusal = {
  ok: false;
  entry: EntryName | null;
  error: PulseErrorInfo;
};

/**
 * Check the request from the initial props: Pulse's own rules (validate.ts) against the host's
 * configured upload mode. An entry Pulse doesn't have, a `record` without a context or a malformed
 * field (an upload mode other than 'pulse' or 'file' among them) is `invalid_options`.
 */
export function planOpen(props: EmbedProps): OpenPlan | OpenRefusal {
  const requestId = props.requestId ?? '';
  const config: ConfigureOptions = isObject(props.config) ? (props.config as ConfigureOptions) : {};
  const raw = isObject(props.request) ? { ...props.request, requestId } : props.request;
  const check = checkOpenRequest(raw, config.uploadMode);
  if (!check.ok) {
    const entry = isObject(props.request) ? props.request.entry : undefined;
    return {
      ok: false,
      entry: isEntryName(entry) ? entry : null,
      error: {
        code: check.code,
        message: check.message,
        recoverable: false,
        callId: '',
        requestId,
      },
    };
  }
  const { request } = check;
  return { ok: true, requestId, request, draftId: ENTRIES[request.entry].draftOf(request), config };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
