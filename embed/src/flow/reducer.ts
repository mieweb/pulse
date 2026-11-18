import type {
  EntryName,
  FileRef,
  FlowScreen,
  FlowStage,
  OpenRequest,
  PulseContext,
  PulseErrorInfo,
} from '@mieweb/pulse-embed';

/**
 * The embed's flow as a pure reducer (B2): one presentation, one stack of screens
 * (recorder ⇄ editor → export), one result. The shell (FlowStack) renders the stack, feeds the
 * screens' callbacks in as events, and once `end` is set writes the result (result.ts) and
 * carries out `deleteDraft`. Nothing here touches the library, the clock or the bridge.
 *
 * Exits (PLAN §5.1 Back navigation): X, the editor's close, Android back at the root and the
 * VoiceOver escape all mean `close`.
 *   - Nothing recorded: `canceled`, and no draft is left behind.
 *   - A draft this flow made, with a clip: the keep/discard sheet. Keep → `closed{draftId}`;
 *     Discard → `canceled` and the draft is deleted.
 *   - A draft the flow opened (edit, export, record continue): it was there before and edits
 *     save as they happen, so there's nothing to discard: `closed{draftId}` if this flow changed
 *     it, else `canceled{draftId}`.
 * The host's `close` never shows the sheet: the take is kept (`closed{reason:'host'}`) unless it
 * asks to discard (a shared phone), which deletes a draft this flow made and ends `canceled`. A
 * draft the flow opened is never deleted by the host's close: discard means the take, and that
 * draft (with its earlier clips) was the person's before the flow began; it ends as X would.
 *
 * A take in progress: the host's close and a failure wait for it. The recorder stops the take
 * (the shell asks it to, as the recorder's own close does), and the `stop` that follows settles
 * the end with the draft the take landed in, so a first take can't leave a draft the result says
 * doesn't exist. If the take can't report (its recorder is gone), the shell dispatches a bare
 * `stop`, which settles the end with what's known.
 */

/** How the flow ended; result.ts adds the common fields. */
export type FlowEnd =
  | {
      status: 'completed';
      mode: 'file';
      draftId: string;
      export: FileRef;
      durationMs: number;
      project?: FileRef;
    }
  | {
      status: 'completed';
      mode: 'pulse';
      draftId: string;
      sentAt: number;
      clientKey: string;
      draftKey: string;
      confirmedAt?: number;
    }
  | { status: 'closed'; reason: CloseReason; draftId: string }
  | { status: 'canceled'; reason: CloseReason; draftId?: string }
  | { status: 'failed'; error: PulseErrorInfo; draftId?: string };

export type CloseReason = 'user' | 'host' | 'interrupted';

/** An end waiting for the running take to stop. */
export type PendingEnd =
  { type: 'hostClose'; discard: boolean } | { type: 'error'; error: PulseErrorInfo };

export interface FlowState {
  requestId: string;
  entry: EntryName;
  /** The context the flow runs for: the request's (record), else the draft's. */
  context: PulseContext | null;
  /** Bottom first; the top is the screen on show. Never empty. */
  stack: FlowScreen[];
  /** The first screen has drawn (an end before it reports `endedOn: null`). */
  mounted: boolean;
  /** A take is being recorded: navigation and X wait for it to stop. */
  recording: boolean;
  /** The flow's draft; null on a new recording until its first clip lands. */
  draftId: string | null;
  /** The draft was made by this flow (record, draft 'new'), so X can discard it. */
  newDraft: boolean;
  clipCount: number;
  /** This flow changed the draft (a clip, an edit). */
  changed: boolean;
  stage: FlowStage;
  /** The keep/discard sheet is up. */
  sheet: 'exit' | null;
  /** The host's close or a failure came during a take; the take's `stop` settles it. */
  pending: PendingEnd | null;
  end: FlowEnd | null;
  /** A draft the shell must delete as the flow ends (discarded, or left with no clip). */
  deleteDraft: string | null;
}

export type FlowEvent =
  /** The first screen drew. */
  | { type: 'mounted' }
  /** The recorder started a take. */
  | { type: 'record' }
  /**
   * The take ended. With `draftId` it landed as a clip and `clipCount` is the draft's count now;
   * without, it was dropped (too short, failed to save).
   */
  | { type: 'stop'; draftId?: string; clipCount?: number }
  /** The editor changed the draft; `clipCount` after the change (clips can be deleted). */
  | { type: 'edited'; clipCount: number }
  /** Export's merge is current. */
  | { type: 'merged' }
  /** Recorder → editor (its Done/Edit). */
  | { type: 'edit' }
  /** Editor → recorder, to add clips to this draft (M3). */
  | { type: 'addClips' }
  /** Editor → Export. */
  | { type: 'export' }
  /** Back (the back arrow, Android back): pops a screen, or at the root means X. */
  | { type: 'back' }
  /** X. */
  | { type: 'close' }
  /** The keep/discard sheet's three answers. */
  | { type: 'keep' }
  | { type: 'discard' }
  | { type: 'dismissSheet' }
  /** "Use this video" (uploadMode 'file'), once the export was copied for the host. */
  | { type: 'useVideo'; export: FileRef; durationMs: number; project?: FileRef }
  /** Send (uploadMode 'pulse', PR2), once the job is persisted. */
  | { type: 'send'; sentAt: number; clientKey: string; draftKey: string; confirmedAt?: number }
  /** The host's `close` (`pulse.cmd close`). */
  | { type: 'hostClose'; discard?: boolean }
  /** A failure the flow can't go on from (permission, storage, a JS error). */
  | { type: 'error'; error: PulseErrorInfo };

/** What the shell knows about the draft an edit, export or record-continue opens. */
export interface OpenedDraft {
  context: PulseContext | null;
  clipCount: number;
}

/** The first screen of each entry (no Drafts screen anywhere). */
export const FIRST_SCREEN: Record<EntryName, FlowScreen> = {
  record: 'recorder',
  edit: 'editor',
  export: 'export',
};

/**
 * The state a request opens with. `requestId` is the one the facade settled on (the request's,
 * or one it made). `draft` describes the existing draft for edit, export and record continue.
 */
export function initFlow(requestId: string, request: OpenRequest, draft?: OpenedDraft): FlowState {
  const base = {
    requestId,
    entry: request.entry,
    stack: [FIRST_SCREEN[request.entry]],
    mounted: false,
    recording: false,
    changed: false,
    stage: 'none' as FlowStage,
    sheet: null,
    pending: null,
    end: null,
    deleteDraft: null,
  };
  if (request.entry === 'record') {
    const continued = typeof request.draft === 'object' ? request.draft.continue : null;
    return {
      ...base,
      context: request.context,
      draftId: continued,
      newDraft: continued === null,
      clipCount: continued === null ? 0 : (draft?.clipCount ?? 0),
    };
  }
  return {
    ...base,
    context: draft?.context ?? null,
    draftId: request.draftId,
    newDraft: false,
    clipCount: draft?.clipCount ?? 0,
  };
}

/** The screen on show. */
export function topScreen(state: FlowState): FlowScreen {
  return state.stack[state.stack.length - 1];
}

const STAGE_RANK: Record<FlowStage, number> = { none: 0, recorded: 1, edited: 2, exported: 3 };

export function flowReducer(state: FlowState, event: FlowEvent): FlowState {
  if (state.end) return state; // one result per flow: nothing after it counts

  if (event.type === 'mounted') return state.mounted ? state : { ...state, mounted: true };

  // The host and failures end the flow from anywhere, the sheet included. During a take they wait
  // for its stop, so the draft it lands in is known.
  if (event.type === 'hostClose' || event.type === 'error') {
    const end: PendingEnd =
      event.type === 'hostClose'
        ? { type: 'hostClose', discard: event.discard === true }
        : { type: 'error', error: event.error };
    if (state.recording) return { ...state, pending: mergePending(state.pending, end) };
    return settle(state, end);
  }

  if (state.sheet) {
    switch (event.type) {
      case 'keep':
        return state.draftId
          ? finish(state, { status: 'closed', reason: 'user', draftId: state.draftId })
          : state;
      case 'discard':
        return finish(state, { status: 'canceled', reason: 'user' }, state.draftId);
      case 'dismissSheet':
      case 'back': // Android back closes the sheet, like Cancel
        return { ...state, sheet: null };
      default:
        return state;
    }
  }

  if (state.recording) {
    // Only the take's end counts while it runs: the recorder stops it before anything else.
    if (event.type !== 'stop') return state;
    const after = stopped(state, event);
    return state.pending ? settle({ ...after, pending: null }, state.pending) : after;
  }

  const top = topScreen(state);
  switch (event.type) {
    case 'record':
      return top === 'recorder' ? { ...state, recording: true } : state;
    case 'stop':
      return state; // no take running
    case 'edited':
      return {
        ...state,
        changed: true,
        clipCount: event.clipCount,
        // Every clip deleted: no clip, so no stage (the contract's 'none').
        stage: event.clipCount > 0 ? 'edited' : 'none',
      };
    case 'merged':
      return state.clipCount > 0 ? { ...state, stage: 'exported' } : state;
    case 'edit':
      return top === 'recorder' && state.clipCount > 0 ? go(state, 'editor') : state;
    case 'addClips':
      return top === 'editor' ? go(state, 'recorder') : state;
    case 'export':
      return top === 'editor' && state.clipCount > 0 ? go(state, 'export') : state;
    case 'back':
      return state.stack.length > 1 ? { ...state, stack: state.stack.slice(0, -1) } : close(state);
    case 'close':
      return close(state);
    case 'useVideo':
      if (top !== 'export' || !state.draftId) return state;
      return finish(
        { ...state, stage: 'exported' },
        {
          status: 'completed',
          mode: 'file',
          draftId: state.draftId,
          export: event.export,
          durationMs: event.durationMs,
          ...(event.project ? { project: event.project } : null),
        },
      );
    case 'send':
      if (top !== 'export' || !state.draftId) return state;
      return finish(
        { ...state, stage: 'exported' },
        {
          status: 'completed',
          mode: 'pulse',
          draftId: state.draftId,
          sentAt: event.sentAt,
          clientKey: event.clientKey,
          draftKey: event.draftKey,
          ...(event.confirmedAt !== undefined ? { confirmedAt: event.confirmedAt } : null),
        },
      );
    default:
      return state; // the sheet's answers with no sheet up
  }
}

/** Show `screen`: back to it when it's just below (recorder ⇄ editor), else on top. */
function go(state: FlowState, screen: FlowScreen): FlowState {
  const { stack } = state;
  return stack[stack.length - 2] === screen
    ? { ...state, stack: stack.slice(0, -1) }
    : { ...state, stack: [...stack, screen] };
}

function stopped(state: FlowState, event: Extract<FlowEvent, { type: 'stop' }>): FlowState {
  if (!event.draftId) return { ...state, recording: false };
  return {
    ...state,
    recording: false,
    draftId: event.draftId,
    clipCount: event.clipCount ?? state.clipCount + 1,
    changed: true,
    // A new clip after a merge makes the export stale again.
    stage: STAGE_RANK[state.stage] >= STAGE_RANK.edited ? 'edited' : 'recorded',
  };
}

function hasTake(state: FlowState): boolean {
  return state.draftId !== null && state.clipCount > 0;
}

/** X (and back at the root). */
function close(state: FlowState): FlowState {
  if (state.newDraft) {
    if (!hasTake(state))
      return finish(state, { status: 'canceled', reason: 'user' }, state.draftId);
    return { ...state, sheet: 'exit' };
  }
  return leaveExisting(state, 'user');
}

/**
 * A second end while the take still runs: the first stays, except that the host asking to
 * discard is never lost (a shared phone's expiry after an ordinary close).
 */
function mergePending(pending: PendingEnd | null, next: PendingEnd): PendingEnd {
  if (!pending) return next;
  if (pending.type === 'hostClose' && next.type === 'hostClose') {
    return { type: 'hostClose', discard: pending.discard || next.discard };
  }
  return pending;
}

function settle(state: FlowState, end: PendingEnd): FlowState {
  return end.type === 'hostClose' ? hostClose(state, end.discard) : fail(state, end.error);
}

function hostClose(state: FlowState, discard: boolean): FlowState {
  // An opened draft was the person's before this flow: the host's close leaves it as X would.
  if (!state.newDraft) return leaveExisting(state, 'host');
  // A draft this flow made: kept with a clip unless the host discards; with none, it goes.
  if (!hasTake(state) || discard) {
    return finish(state, { status: 'canceled', reason: 'host' }, state.draftId);
  }
  return finish(state, { status: 'closed', reason: 'host', draftId: state.draftId as string });
}

/** Leaving a draft the flow opened: kept if this flow changed it, else untouched. */
function leaveExisting(state: FlowState, reason: CloseReason): FlowState {
  const draftId = state.draftId as string;
  return state.changed
    ? finish(state, { status: 'closed', reason, draftId })
    : finish(state, { status: 'canceled', reason, draftId });
}

function fail(state: FlowState, error: PulseErrorInfo): FlowState {
  // The draft survives a failure whenever it had a clip (and an opened draft always does). A draft
  // this flow made with no clip goes.
  const survives = state.draftId !== null && (hasTake(state) || !state.newDraft);
  return finish(
    state,
    survives
      ? { status: 'failed', error, draftId: state.draftId as string }
      : { status: 'failed', error },
    survives ? null : state.draftId,
  );
}

function finish(state: FlowState, end: FlowEnd, deleteDraft: string | null = null): FlowState {
  return { ...state, sheet: null, recording: false, pending: null, end, deleteDraft };
}
