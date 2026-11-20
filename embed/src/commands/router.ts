import { hostContextColumns, type HostContext } from '@/db/host-context';
import { isLockedJobState, type JobState } from '@/db/upload-jobs';

import type { Channel, CommandArgs, CommandHandler } from '../shell/messaging';

/**
 * The host's writes (native-bridge.md §3, "Answered by JS"), as Pulse JS answers them: each
 * `pulse.cmd` is checked here against the lock matrix (PLAN §6.1, AD33, O13), then carried out by
 * the library's own functions (the deps), and answered with one `pulse.reply`. Every check a
 * refusal depends on runs before anything changes, so a refused write leaves the draft, and its
 * Send, as they were.
 *
 * | method          | not_found      | storage.newer_schema | draft.locked                                          |
 * |-----------------|----------------|----------------------|-------------------------------------------------------|
 * | renameDraft     | no draft       | yes                  | held by the open flow; job preparing/uploading/delivering |
 * | deleteDraft     | no draft       | no (AD34)            | held; job preparing/uploading/delivering              |
 * | setDraftContext | no draft       | yes                  | held; job preparing/uploading/delivering; clock_bound |
 * | upload          | no draft       | no (AD34)            | held                                                  |
 * | cancelUpload    | no draft       | no                   | held; job preparing/delivering                        |
 * | retireDraft     | no draft, no receipt | no             | held; 'file' mode: job preparing/uploading/delivering |
 * | dismissReceipt  | no receipt     | no                   | —                                                     |
 * | resumeOutbox    | —              | no                   | —                                                     |
 *
 * A queued, paused (needs_credentials) or failed job is taken out of the outbox before an edit,
 * a move or a delete changes its draft (`cancelJob` with 'edited' or 'deleted'), so it can never
 * send the cut from before; the next Send makes a new clientKey with the same draftKey (AD32).
 * Deleting a clock-bound draft still deletes it: the host's server marks the clock intent
 * `abandoned` when the host cancels it (O13).
 */

/** The host writes Pulse JS answers, in the order native-bridge.md §3 lists them. */
export const WRITE_METHODS = [
  'renameDraft',
  'deleteDraft',
  'setDraftContext',
  'upload',
  'cancelUpload',
  'retireDraft',
  'dismissReceipt',
  'resumeOutbox',
] as const;
export type WriteMethod = (typeof WRITE_METHODS)[number];

export type CommandErrorCode =
  | 'invalid_options'
  | 'not_found'
  | 'draft.locked'
  | 'storage.newer_schema'
  | 'host_misconfigured'
  | 'upload.too_large';

/** A refused command; the channel replies with its code, reason and draftId. */
export class CommandError extends Error {
  readonly code: CommandErrorCode;
  readonly reason?: string;
  readonly draftId?: string;
  constructor(
    code: CommandErrorCode,
    message: string,
    extra: { reason?: string; draftId?: string } = {},
  ) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    if (extra.reason !== undefined) this.reason = extra.reason;
    if (extra.draftId !== undefined) this.draftId = extra.draftId;
  }
}

/** What the lock matrix reads about a draft. */
export type DraftLock = {
  /** The draft's outbox job state, or null without a job. */
  jobState: JobState | null;
  /** The host confirmed its Send (`drafts.host_confirmed_at`, O13). */
  clockBound: boolean;
};

export type SendKeys = { clientKey: string; draftKey: string; sentAt: number };
export type CancelReason = 'canceled' | 'edited' | 'deleted';

/** How the commands reach the library and the outbox (the runtime's, or fakes in tests). */
export type CommandDeps = {
  /** The draft's lock state, or null when there is no such draft. */
  draft(id: string): DraftLock | null;
  /** Whether a receipt (a retired draft) has this id. */
  hasReceipt(id: string): boolean;
  /** A newer Pulse migrated the library: writes that edit a draft refuse (AD34). */
  newerSchema(): boolean;
  /** The draft the open flow holds, if any (§3 busy matrix). */
  heldDraft(): string | null;
  /** The host's `configure.uploadMode`. */
  uploadMode(): 'pulse' | 'file';
  /** outbox.cancelJob: refuses `draft.locked` itself when the job locked meanwhile. */
  cancelJob(id: string, reason: CancelReason): void;
  rename(id: string, name: string | null): Promise<void>;
  remove(id: string): Promise<void>;
  setContext(id: string, context: HostContext): Promise<void>;
  /** Send from the host's list: merge when stale, then queue (outbox.sendDraft). */
  send(id: string): Promise<SendKeys>;
  /** 'file' mode's retire: now, with outcome done. */
  retireFile(id: string): void;
  /** 'pulse' mode's retire: a hint; the job loop asks the status route again. */
  recheck(id: string): void;
  dismissReceipt(id: string): boolean;
  resumeOutbox(): Promise<void>;
  /** After a write: catalog.json rewritten, then `draftsChanged` for these ids. */
  changed(ids: readonly string[]): Promise<void>;
};

const locked = (id: string, message: string, reason?: string) =>
  new CommandError('draft.locked', `Draft ${id} ${message}`, { draftId: id, reason });

function needId(args: CommandArgs): string {
  const id = args.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new CommandError('invalid_options', 'The command needs a draft id.');
  }
  return id;
}

type Edit = {
  /** `storage.newer_schema` applies (an edit, not a send or a delete). */
  edits?: boolean;
  /** The job states that lock the draft for this command (default: §6.1's three). */
  lockedStates?: (state: JobState) => boolean;
};

/**
 * The checks every draft command shares, in order: the draft exists, the library isn't a newer
 * Pulse's (edits only), the open flow doesn't hold it, and its job doesn't lock it.
 */
function checkDraft(deps: CommandDeps, id: string, edit: Edit = {}): DraftLock {
  const lock = deps.draft(id);
  if (!lock) throw new CommandError('not_found', `Pulse has no draft ${id}.`, { draftId: id });
  if (edit.edits && deps.newerSchema()) {
    throw new CommandError(
      'storage.newer_schema',
      'The library was written by a newer version of Pulse; update Pulse to edit it.',
      { draftId: id },
    );
  }
  if (deps.heldDraft() === id) throw locked(id, 'is open in Pulse.');
  const isLocked = edit.lockedStates ?? isLockedJobState;
  if (lock.jobState && isLocked(lock.jobState)) throw locked(id, `is ${lock.jobState}.`);
  return lock;
}

/** Take a queued, paused or failed job out before its draft changes (§6.1 lock rule). */
function takeOut(deps: CommandDeps, id: string, lock: DraftLock, reason: CancelReason): void {
  if (lock.jobState) deps.cancelJob(id, reason);
}

/** The commands, keyed by method; register each with the channel. */
export function commandHandlers(deps: CommandDeps): Record<WriteMethod, CommandHandler> {
  return {
    async renameDraft(args) {
      const id = needId(args);
      if (typeof args.name !== 'string') {
        throw new CommandError('invalid_options', 'renameDraft needs a name.');
      }
      const name = args.name.trim();
      const lock = checkDraft(deps, id, { edits: true });
      // The name rides the upload as the video's title: a queued Send goes back to a draft.
      takeOut(deps, id, lock, 'edited');
      await deps.rename(id, name.length > 0 ? name : null);
      await deps.changed([id]);
      return null;
    },

    async deleteDraft(args) {
      const id = needId(args);
      const lock = checkDraft(deps, id);
      // A clock-bound draft goes too: the host cancels its intent (O13).
      takeOut(deps, id, lock, 'deleted');
      await deps.remove(id);
      await deps.changed([id]);
      return null;
    },

    async setDraftContext(args) {
      const id = needId(args);
      const context = args.context as unknown as HostContext;
      // Checked first: a context Pulse would refuse never cancels a Send.
      hostContextColumns(context);
      const lock = checkDraft(deps, id, { edits: true });
      if (lock.clockBound) {
        throw locked(id, 'belongs to the clock action its Send confirmed.', 'clock_bound');
      }
      takeOut(deps, id, lock, 'edited');
      await deps.setContext(id, context);
      await deps.changed([id]);
      return null;
    },

    async upload(args) {
      const id = needId(args);
      if (deps.uploadMode() !== 'pulse') {
        throw new CommandError(
          'host_misconfigured',
          "upload sends through the host's services, which uploadMode 'file' has none of.",
          { draftId: id },
        );
      }
      // A job already under way answers with its keys (outbox.sendDraft): no state locks Send.
      checkDraft(deps, id, { lockedStates: () => false });
      const keys = await deps.send(id);
      await deps.changed([id]);
      return keys;
    },

    async cancelUpload(args) {
      const id = needId(args);
      const lock = checkDraft(deps, id, {
        // An upload can be cancelled while its bytes go up; not while it prepares or delivers.
        lockedStates: (s) => s === 'preparing' || s === 'delivering',
      });
      if (!lock.jobState) return null;
      deps.cancelJob(id, 'canceled');
      await deps.changed([id]);
      return null;
    },

    async retireDraft(args) {
      const id = needId(args);
      if (!deps.draft(id)) {
        if (deps.hasReceipt(id)) return null; // retired already
        throw new CommandError('not_found', `Pulse has no draft ${id}.`, { draftId: id });
      }
      if (deps.uploadMode() === 'file') {
        checkDraft(deps, id);
        deps.retireFile(id);
        await deps.changed([id]);
        return null;
      }
      // 'pulse' mode: only the status route retires a draft; this asks it again now.
      checkDraft(deps, id, { lockedStates: () => false });
      deps.recheck(id);
      return null;
    },

    async dismissReceipt(args) {
      const id = needId(args);
      if (!deps.dismissReceipt(id)) {
        throw new CommandError('not_found', `Pulse has no receipt ${id}.`, { draftId: id });
      }
      await deps.changed([id]);
      return null;
    },

    async resumeOutbox() {
      await deps.resumeOutbox();
      return null;
    },
  };
}

/**
 * `pulse.cmd` → handler → `pulse.reply`: register `handlers` with the channel, each run through
 * `around` (the runtime waits there for its library gate and counts the call as work in flight).
 * A method nothing registers is `method.unsupported` (messaging.ts). Returns the unregister.
 */
export function routeCommands(
  channel: Pick<Channel, 'handle'>,
  handlers: Partial<Record<string, CommandHandler>>,
  around: (method: string, run: () => Promise<unknown>) => Promise<unknown> = (_, run) => run(),
): () => void {
  const stops = Object.entries(handlers).map(([method, handler]) =>
    channel.handle(method, (args, callId) =>
      around(method, async () => (handler as CommandHandler)(args, callId)),
    ),
  );
  return () => stops.forEach((stop) => stop());
}
